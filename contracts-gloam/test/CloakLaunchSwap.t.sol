// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakLaunchVault} from "../src/CloakLaunchVault.sol";
import {CloakLaunchSwap} from "../src/CloakLaunchSwap.sol";
import {TestToken} from "../src/TestToken.sol";
import {YesVerifier, ToVerifier, FakeAuction, FakeFactory} from "./CloakLaunchVault.t.sol";
import {V2Factory, V2Pair, WETH9} from "./CloakV2PairSwap.t.sol";

contract CloakLaunchSwapTest is Test {
    using stdJson for string;

    CloakLaunchVault vault;
    CloakLaunchSwap router;
    V2Factory pairs;
    WETH9 weth;
    TestToken launch;
    address alice = address(0xA11CE);
    address relayer = address(0x5E1A);
    address mallory = address(0xBAD);
    uint256 ownerPk = 0x0A11CE;
    address ownerKey;
    uint256 constant NOTE = 10e18; // HYPE
    uint256 constant ARRIVES = 9.95e18; // less the vault's 0.5%

    function setUp() public {
        vm.warp(1_900_000_000);
        ownerKey = vm.addr(ownerPk);
        FakeFactory factory = new FakeFactory();
        FakeAuction auction = new FakeAuction();
        launch = new TestToken("Launch", "LNCH", 18);
        uint256 idx = factory.add(address(auction), address(launch));
        auction.settle();

        vault = new CloakLaunchVault(_poseidon(), address(new ToVerifier()), address(factory), 1_000_000e18, 50_000_000e18);
        vault.setShieldVerifier(address(new YesVerifier()));
        vault.setWithdrawFee(50, address(0xFEE));
        vault.turnOnDepositLimits();
        vault.setDepositLimit(address(0), 1_000e18, 100_000e18); // HYPE, listed in setup
        vault.endSetup();
        vault.admitLaunch(idx);

        weth = new WETH9();
        pairs = new V2Factory();
        router = new CloakLaunchSwap(address(vault), address(pairs), address(weth));

        // WHYPE/launch pool, 1 HYPE = 1000 launch
        V2Pair p = pairs.create(address(weth), address(launch));
        vm.deal(address(this), 1_000e18);
        weth.deposit{value: 100e18}();
        weth.transfer(address(p), 100e18);
        launch.mint(address(p), 100_000e18);
        p.sync();

        vm.deal(alice, 100e18);
        launch.mint(alice, 100_000e18);
        vm.startPrank(alice);
        for (uint256 i = 0; i < 3; i++) vault.shieldBound{value: NOTE}(address(0), NOTE, bytes32(uint256(0xE0 + i)), hex"00");
        launch.approve(address(vault), type(uint256).max);
        vault.shieldBound(address(launch), 5_000e18, bytes32(uint256(0x1A)), hex"00");
        vm.stopPrank();
    }

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    function _path(address a, address b) internal pure returns (bytes memory) {
        address[] memory p = new address[](2);
        p[0] = a;
        p[1] = b;
        return abi.encode(p);
    }

    struct Call {
        CloakLaunchSwap.Spend s;
        CloakLaunchSwap.Deposit d;
        bytes route;
        uint256 deadline;
    }

    /// A HYPE note into exactly `out` launch tokens; the stand-in unshield proof names the swap's escrow.
    function _buy(uint256 n, uint256 out) internal view returns (Call memory c) {
        c.s = CloakLaunchSwap.Spend(hex"", vault.currentRoot(), bytes32(n), address(0), NOTE);
        c.d = CloakLaunchSwap.Deposit(hex"00", bytes32(n + 0x1000), address(launch), out);
        c.route = _path(address(weth), address(launch));
        c.deadline = block.timestamp + 1 hours;
        c.s.proof = abi.encode(router.escrowFor(router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline)));
    }

    function _send(Call memory c) internal returns (bytes32 id, uint256 left) {
        vm.prank(relayer);
        return router.swap(c.s, c.d, c.route, ownerKey, c.deadline);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_swapOwesTheLeftoverToTheTrader() public {
        Call memory c = _buy(1, 9_000e18);
        uint256 before = vault.deposited(address(launch));
        (bytes32 id, uint256 left) = _send(c);
        assertEq(vault.deposited(address(launch)), before + 9_000e18);
        assertTrue(vault.commitmentSeen(c.d.commitment));
        assertGt(left, 0);
        (address asset, address key, uint256 amount) = router.owed(id);
        assertEq(asset, address(0));
        assertEq(key, ownerKey);
        assertEq(amount, left);
        assertEq(address(router).balance, left);
        // input used plus leftover is what arrived
        assertLt(left, ARRIVES);
    }

    function test_claimLeftoverAsANote() public {
        (bytes32 id, uint256 left) = _send(_buy(1, 9_000e18));
        bytes32 commitment = bytes32(uint256(0x1E57));
        bytes memory sig = _sign(router.claimDigest(id, commitment));
        uint256 before = vault.deposited(address(0));
        vm.expectRevert(abi.encodeWithSelector(CloakLaunchSwap.WrongAmount.selector, left));
        router.claim(id, CloakLaunchSwap.Deposit(hex"00", commitment, address(0), left - 1), sig);
        vm.expectRevert(CloakLaunchSwap.BadSignature.selector);
        router.claim(id, CloakLaunchSwap.Deposit(hex"00", bytes32(uint256(0xBAD)), address(0), left), sig);
        vm.prank(relayer);
        router.claim(id, CloakLaunchSwap.Deposit(hex"00", commitment, address(0), left), sig);
        assertEq(vault.deposited(address(0)), before + left);
        assertEq(address(router).balance, 0);
        vm.expectRevert(CloakLaunchSwap.NothingOwed.selector);
        router.claim(id, CloakLaunchSwap.Deposit(hex"00", commitment, address(0), left), sig);
    }

    function test_exitLeftoverInTheClear() public {
        (bytes32 id, uint256 left) = _send(_buy(1, 9_000e18));
        address to = address(0x7070);
        bytes memory sig = _sign(router.exitDigest(id, to));
        vm.expectRevert(CloakLaunchSwap.BadSignature.selector);
        router.exit(id, mallory, sig);
        vm.expectRevert(CloakLaunchSwap.BadExit.selector);
        router.exit(id, address(vault), sig);
        router.exit(id, to, sig);
        assertEq(to.balance, left);
    }

    function test_sellLaunchForHype() public {
        Call memory c;
        c.s = CloakLaunchSwap.Spend(hex"", vault.currentRoot(), bytes32(uint256(0x1A)), address(launch), 5_000e18);
        c.d = CloakLaunchSwap.Deposit(hex"00", bytes32(uint256(0x2A)), address(0), 4e18);
        c.route = _path(address(launch), address(weth));
        c.deadline = block.timestamp + 1 hours;
        c.s.proof = abi.encode(router.escrowFor(router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline)));
        (bytes32 id, uint256 left) = _send(c);
        assertTrue(vault.commitmentSeen(c.d.commitment));
        (address asset,, uint256 amount) = router.owed(id);
        assertEq(asset, address(launch));
        assertEq(amount, left);
        assertEq(launch.balanceOf(address(router)), left);
    }

    function test_booksBalance() public {
        // ask for close to all the input can buy, then check the books balance
        Call memory c = _buy(1, 9_000e18);
        (bytes32 id, uint256 left) = _send(c);
        if (left == 0) {
            (,, uint256 amount) = router.owed(id);
            assertEq(amount, 0);
        }
        assertEq(address(router).balance, left);
    }

    function test_tooGreedyReverts() public {
        Call memory c = _buy(1, 9_500e18); // needs more than 9.95 HYPE
        vm.expectRevert();
        _send(c);
        assertFalse(vault.isSpent(c.s.nullifier));
    }

    function test_copierCantChangeTheSwap() public {
        Call memory c = _buy(1, 9_000e18);
        vm.prank(mallory);
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        router.swap(c.s, c.d, c.route, mallory, c.deadline);
        c.d.commitment = bytes32(uint256(0xBAD));
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        router.swap(c.s, c.d, c.route, ownerKey, c.deadline);
    }

    function test_deadline() public {
        Call memory c = _buy(1, 9_000e18);
        vm.warp(c.deadline + 1);
        vm.expectRevert(CloakLaunchSwap.Expired.selector);
        _send(c);
    }

    function test_spendSentAloneThenSwapped() public {
        Call memory c = _buy(1, 9_000e18);
        CloakLaunchSwap.SwapKey memory k = router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline);
        vault.unshield(c.s.proof, c.s.root, c.s.nullifier, address(0), router.escrowFor(k), NOTE);
        (, uint256 left) = _send(c);
        assertTrue(vault.commitmentSeen(c.d.commitment));
        assertGt(left, 0);
        vm.expectRevert(CloakLaunchSwap.Used.selector);
        _send(c);
    }

    function test_spendSentAloneThenRescued() public {
        Call memory c = _buy(1, 9_000e18);
        CloakLaunchSwap.SwapKey memory k = router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline);
        vault.unshield(c.s.proof, c.s.root, c.s.nullifier, address(0), router.escrowFor(k), NOTE);
        vm.expectRevert(CloakLaunchSwap.NotYet.selector);
        router.rescue(k);
        vm.warp(c.deadline + 1);
        vm.prank(mallory);
        assertEq(router.rescue(k), ARRIVES);
        bytes32 id = router.idOf(k);
        (address asset, address key, uint256 amount) = router.owed(id);
        assertEq(asset, address(0));
        assertEq(key, ownerKey);
        assertEq(amount, ARRIVES);
        vm.expectRevert(CloakLaunchSwap.Used.selector);
        router.rescue(k);
        bytes32 commitment = bytes32(uint256(0xBAC));
        bytes memory sig = _sign(router.claimDigest(id, commitment));
        router.claim(id, CloakLaunchSwap.Deposit(hex"00", commitment, address(0), ARRIVES), sig);
        assertTrue(vault.commitmentSeen(commitment));
    }

    function test_rescueNeedsTheSpend() public {
        Call memory c = _buy(1, 9_000e18);
        CloakLaunchSwap.SwapKey memory k = router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline);
        vm.warp(c.deadline + 1);
        vm.expectRevert(CloakLaunchSwap.Used.selector);
        router.rescue(k);
    }

    function test_routeChecks() public {
        Call memory c = _buy(1, 9_000e18);
        bytes memory wrong = _path(address(launch), address(weth));
        c.route = wrong;
        c.s.proof = abi.encode(router.escrowFor(router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline)));
        vm.expectRevert(CloakLaunchSwap.BadRoute.selector);
        _send(c);
        TestToken other = new TestToken("O", "O", 18);
        c.route = _path(address(weth), address(other));
        c.d.asset = address(other);
        c.s.proof = abi.encode(router.escrowFor(router.keyOf(c.s, c.d, c.route, ownerKey, c.deadline)));
        vm.expectRevert(abi.encodeWithSelector(CloakLaunchSwap.NoPair.selector, address(weth), address(other)));
        _send(c);
    }

    function test_strayHypeRefused() public {
        vm.deal(mallory, 1e18);
        vm.prank(mallory);
        (bool ok,) = address(router).call{value: 1e18}("");
        assertFalse(ok);
    }

    function test_basicChecks() public {
        Call memory c = _buy(1, 9_000e18);
        vm.expectRevert(CloakLaunchSwap.BadKey.selector);
        router.swap(c.s, c.d, c.route, address(0), c.deadline);
        c.d.asset = address(0);
        vm.expectRevert(CloakLaunchSwap.SameAsset.selector);
        router.swap(c.s, c.d, c.route, ownerKey, c.deadline);
    }
}
