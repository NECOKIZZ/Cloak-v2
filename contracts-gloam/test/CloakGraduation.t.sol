// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakLaunchVault} from "../src/CloakLaunchVault.sol";
import {CloakGraduation} from "../src/CloakGraduation.sol";
import {TestToken} from "../src/TestToken.sol";
import {YesVerifier, ToVerifier, FakeAuction, FakeFactory} from "./CloakLaunchVault.t.sol";

contract CloakGraduationTest is Test {
    using stdJson for string;

    CloakLaunchVault lv;
    ShieldPoolPayments gv;
    CloakGraduation grad;
    TestToken launch;
    address cloakFees = address(0xFEE);
    address alice = address(0xA11CE);
    address relayer = address(0x5E1A);
    address mallory = address(0xBAD);
    uint256 ownerPk = 0x0A11CE;
    uint256 constant ROUND = 1 hours;
    uint128 constant SIZE = 1_000e18;
    uint256 constant NET = 995e18; // less the launch vault's 0.5%

    function setUp() public {
        vm.warp(1_900_000_000);
        FakeFactory factory = new FakeFactory();
        FakeAuction auction = new FakeAuction();
        launch = new TestToken("Launch", "LNCH", 18);
        uint256 idx = factory.add(address(auction), address(launch));
        auction.settle();

        lv = new CloakLaunchVault(_poseidon(), address(new ToVerifier()), address(factory), 1_000_000e18, 50_000_000e18);
        lv.setShieldVerifier(address(new YesVerifier()));
        lv.setWithdrawFee(50, cloakFees);
        lv.turnOnDepositLimits();
        lv.endSetup();
        lv.admitLaunch(idx);

        // Gloam's vault, with the launch token listed (in Gloam's real vault that is Gloam's call and its 3-day wait)
        gv = new ShieldPoolPayments(_poseidon(), address(new ToVerifier()));
        gv.setShieldVerifier(address(new YesVerifier()));
        gv.setWithdrawFee(50, address(0x6104));
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(launch), 2_000e18, 1_000_000e18);
        gv.endSetup();

        grad = new CloakGraduation(address(lv), address(gv), ROUND);

        launch.mint(alice, 100_000e18);
        vm.startPrank(alice);
        launch.approve(address(lv), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) lv.shieldBound(address(launch), SIZE, bytes32(uint256(0xC0FFEE + i)), hex"00");
        vm.stopPrank();
    }

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    function _key(uint256 n) internal view returns (CloakGraduation.EntryKey memory) {
        return CloakGraduation.EntryKey(bytes32(n), address(launch), SIZE, vm.addr(ownerPk), address(0xFA11));
    }

    /// The stand-in unshield proof names the escrow it was made for, as a real proof binds `to`.
    function _spend(CloakGraduation.EntryKey memory k) internal view returns (CloakGraduation.Spend memory) {
        return CloakGraduation.Spend(abi.encode(grad.escrowFor(k)), lv.currentRoot(), k.nullifier, k.size);
    }

    function _sig(bytes32 id, address toVault, bytes32 c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, grad.claimDigest(id, toVault, c));
        return abi.encodePacked(r, s, v);
    }

    function _enter(uint256 n) internal returns (CloakGraduation.EntryKey memory k, bytes32 id) {
        k = _key(n);
        vm.prank(relayer);
        id = grad.enter(_spend(k), k);
    }

    function test_graduateIntoGloamsVault() public {
        (CloakGraduation.EntryKey memory k, bytes32 id) = _enter(1);
        (address token, uint64 round, bool paid, uint128 net) = grad.entries(id);
        assertEq(token, address(launch));
        assertEq(round, grad.currentRound());
        assertFalse(paid);
        assertEq(net, NET);
        assertEq(grad.roundEntries(address(launch), round), 1);
        assertEq(lv.feesOwed(address(launch)), 5e18);

        bytes32 c = bytes32(uint256(0x6E60));
        bytes memory sig = _sig(id, address(gv), c);
        vm.expectRevert(CloakGraduation.NotYet.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);

        vm.warp(block.timestamp + ROUND);
        vm.prank(relayer);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);
        assertEq(gv.deposited(address(launch)), NET);
        assertTrue(gv.commitmentSeen(c));
        assertEq(launch.balanceOf(address(grad)), 0);

        vm.expectRevert(CloakGraduation.Done.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);
    }

    function test_manyEntriesOneRound() public {
        (, bytes32 a) = _enter(1);
        (, bytes32 b) = _enter(2);
        (, bytes32 c) = _enter(3);
        assertTrue(a != b && b != c);
        assertEq(grad.roundEntries(address(launch), grad.currentRound()), 3);
        assertEq(launch.balanceOf(address(grad)), 3 * NET);
    }

    function test_backIntoTheLaunchVault() public {
        (CloakGraduation.EntryKey memory k, bytes32 id) = _enter(1);
        vm.warp(block.timestamp + ROUND);
        uint256 before = lv.deposited(address(launch));
        bytes32 c = bytes32(uint256(0xBAC));
        grad.leave(k, address(lv), CloakGraduation.Deposit(hex"00", c), _sig(id, address(lv), c));
        assertEq(lv.deposited(address(launch)), before + NET);
    }

    /// Gloam's cap is full (or Gloam hasn't listed the token): the entry can still go back.
    function test_gloamFullThenBack() public {
        gv.lowerDepositLimit(address(launch), 0, 0);
        (CloakGraduation.EntryKey memory k, bytes32 id) = _enter(1);
        vm.warp(block.timestamp + ROUND);
        bytes32 c = bytes32(uint256(0x6E60));
        bytes memory sig = _sig(id, address(gv), c);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);
        (,, bool paid,) = grad.entries(id);
        assertFalse(paid);
        grad.leave(k, address(lv), CloakGraduation.Deposit(hex"00", c), _sig(id, address(lv), c));
    }

    function test_signatureNamesTheVault() public {
        (CloakGraduation.EntryKey memory k, bytes32 id) = _enter(1);
        vm.warp(block.timestamp + ROUND);
        bytes32 c = bytes32(uint256(0x6E60));
        bytes memory sigGloam = _sig(id, address(gv), c);
        vm.expectRevert(CloakGraduation.BadSignature.selector);
        grad.leave(k, address(lv), CloakGraduation.Deposit(hex"00", c), sigGloam);
        vm.expectRevert(CloakGraduation.BadSignature.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", bytes32(uint256(0xBAD))), sigGloam);
        vm.expectRevert(CloakGraduation.BadVault.selector);
        grad.leave(k, mallory, CloakGraduation.Deposit(hex"00", c), sigGloam);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, grad.claimDigest(id, address(gv), c));
        vm.expectRevert(CloakGraduation.BadSignature.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), abi.encodePacked(r, s, v));
    }

    /// A copier who swaps in their own key gets another escrow, so the proof fails.
    function test_copierCantTakeTheSpend() public {
        CloakGraduation.EntryKey memory k = _key(1);
        CloakGraduation.Spend memory s = _spend(k);
        CloakGraduation.EntryKey memory evil = _key(1);
        evil.ownerKey = mallory;
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        grad.enter(s, evil);
        evil = _key(1);
        evil.fallbackTo = mallory;
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        grad.enter(s, evil);
        grad.enter(s, k);
    }

    function test_spendSentAloneIsPickedUp() public {
        CloakGraduation.EntryKey memory k = _key(1);
        CloakGraduation.Spend memory s = _spend(k);
        lv.unshield(s.proof, s.root, s.nullifier, address(launch), grad.escrowFor(k), SIZE);
        bytes32 id = grad.enter(s, k);
        (,,, uint128 net) = grad.entries(id);
        assertEq(net, NET);
        vm.expectRevert(CloakGraduation.Used.selector);
        grad.enter(s, k);
    }

    function test_keyChecks() public {
        CloakGraduation.EntryKey memory k = _key(1);
        CloakGraduation.Spend memory s = _spend(k);
        s.amount = SIZE - 1;
        vm.expectRevert(CloakGraduation.BadKey.selector);
        grad.enter(s, k);
        s = _spend(k);
        s.nullifier = bytes32(uint256(2));
        vm.expectRevert(CloakGraduation.BadKey.selector);
        grad.enter(s, k);
        k.ownerKey = address(0);
        s = _spend(k);
        vm.expectRevert(CloakGraduation.BadKey.selector);
        grad.enter(s, k);
        k = _key(1);
        k.fallbackTo = address(0);
        s = _spend(k);
        vm.expectRevert(CloakGraduation.BadKey.selector);
        grad.enter(s, k);
        k = _key(1);
        k.size = 300e18;
        s = _spend(k);
        vm.expectRevert(CloakGraduation.NotStandard.selector);
        grad.enter(s, k);
    }

    function test_isStandard() public view {
        assertTrue(grad.isStandard(1));
        assertTrue(grad.isStandard(2e18));
        assertTrue(grad.isStandard(5_000));
        assertFalse(grad.isStandard(0));
        assertFalse(grad.isStandard(3));
        assertFalse(grad.isStandard(1_500));
    }

    function test_timeoutExitToFallback() public {
        (CloakGraduation.EntryKey memory k, bytes32 id) = _enter(1);
        vm.warp(block.timestamp + ROUND);
        vm.expectRevert(CloakGraduation.NotYet.selector);
        grad.exitAfterTimeout(k);
        vm.warp(block.timestamp + 30 days);
        vm.prank(mallory);
        grad.exitAfterTimeout(k);
        assertEq(launch.balanceOf(address(0xFA11)), NET);
        vm.expectRevert(CloakGraduation.Done.selector);
        grad.exitAfterTimeout(k);
        bytes32 c = bytes32(uint256(1));
        bytes memory sig = _sig(id, address(gv), c);
        vm.expectRevert(CloakGraduation.Done.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);
    }

    function test_unknownEntry() public {
        CloakGraduation.EntryKey memory k = _key(9);
        vm.expectRevert(CloakGraduation.NotYet.selector);
        grad.exitAfterTimeout(k);
        bytes32 c = bytes32(uint256(1));
        bytes memory sig = _sig(grad.idOf(k), address(gv), c);
        vm.expectRevert(CloakGraduation.NotYet.selector);
        grad.leave(k, address(gv), CloakGraduation.Deposit(hex"00", c), sig);
    }

    function test_constructorChecks() public {
        vm.expectRevert("vaults");
        new CloakGraduation(address(lv), address(lv), ROUND);
        vm.expectRevert("vaults");
        new CloakGraduation(address(0), address(gv), ROUND);
        vm.expectRevert("round");
        new CloakGraduation(address(lv), address(gv), 0);
    }
}
