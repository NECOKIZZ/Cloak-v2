// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakRouterV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {CloakLaunchSwapV4Test, ToV, YesV} from "./CloakLaunchSwapV4.t.sol";

/**
 * CloakRouterV4: private swaps and moves across vaults, on the real v4 PoolManager and a real Cloak launch. Gloam's
 * vault here is Gloam's own ShieldPoolPayments holding HYPE (as it will once Gloam lists HYPE); Cloak's launch vault
 * holds the launch token. A note spent from one lands as a note in the other, in one call.
 */
contract CloakRouterV4Test is CloakLaunchSwapV4Test {
    ShieldPoolPayments gv; // Gloam's vault
    CloakRouterV4 rv;
    address constant GLOAM_FEE = address(0x6A0A);

    function _setUpBoth() internal {
        _setUpVault();
        owner = vm.addr(ownerPk); // the owner key signs claims and exits here
        gv = new ShieldPoolPayments(_poseidon(), address(new ToV()));
        gv.setShieldVerifier(address(new YesV()));
        gv.setWithdrawFee(50, GLOAM_FEE);
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        gv.endSetup();
        address[] memory others = new address[](1);
        others[0] = address(gv);
        rv = new CloakRouterV4(address(lv), others, address(pm), address(whype), address(hook));
        // HYPE notes in Gloam's vault
        for (uint256 i = 0; i < 3; i++) gv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(0xA0 + i), hex"00");
    }

    function _ends(address vin, address vout) internal view returns (CloakLaunchSwapBase.Ends memory) {
        return CloakLaunchSwapBase.Ends(vin, vout, owner, block.timestamp + 600);
    }

    struct Call {
        CloakLaunchSwapBase.Spend s;
        CloakLaunchSwapBase.Deposit d;
        bytes route;
        CloakLaunchSwapBase.Ends e;
    }

    /// Everything a swapAcross call needs, read before the call (so vm.expectRevert sees only the call itself).
    function _prep(
        bytes32 n,
        address vin,
        address assetIn,
        uint256 amountIn,
        address vout,
        address assetOut,
        uint256 amountOut,
        bytes memory route
    ) internal view returns (Call memory c) {
        c.e = _ends(vin, vout);
        c.route = route;
        c.s = CloakLaunchSwapBase.Spend(hex"", bytes32(0), n, assetIn, amountIn);
        c.s.root = vin == address(gv) ? gv.currentRoot() : lv.currentRoot();
        c.d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        if (rv.isVault(vin) && rv.isVault(vout)) c.s.proof = abi.encode(rv.escrowAcross(rv.keyOf(c.s, c.d, route, owner, c.e.deadline), vin, vout));
        else c.s.proof = abi.encode(address(0));
    }

    function _across(
        bytes32 n,
        address vin,
        address assetIn,
        uint256 amountIn,
        address vout,
        address assetOut,
        uint256 amountOut,
        bytes memory route
    ) internal returns (bytes32 id, uint256 left) {
        Call memory c = _prep(n, vin, assetIn, amountIn, vout, assetOut, amountOut, route);
        return rv.swapAcross(c.s, c.d, c.route, c.e);
    }

    function _expectFail(bytes memory err, Call memory c) internal {
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        rv.swapAcross(c.s, c.d, c.route, c.e);
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_router_buyFromGloamsVaultIntoTheLaunchVault() public {
        _setUpBoth();
        uint256 gBefore = gv.deposited(address(0));
        uint256 tBefore = lv.deposited(address(token));
        (bytes32 id, uint256 left) = _across(bytes32(uint256(0xA0)), address(gv), address(0), 1 ether, address(lv), address(token), 300e18, _route(_key()));
        assertEq(gBefore - gv.deposited(address(0)), 1 ether, "the HYPE note left Gloam's vault");
        assertEq(gv.feesOwed(address(0)), 0.005 ether, "Gloam's vault kept its own fee (0.5%) on the HYPE spent");
        assertEq(lv.deposited(address(token)) - tBefore, 300e18, "exactly 300 tokens landed as a note in the launch vault");
        assertGt(left, 0, "a buffer is left");
        (address asset,, uint256 amount) = rv.owed(id);
        assertEq(asset, address(0));
        assertEq(amount, left);
        assertEq(rv.owedVault(id), address(gv), "the buffer is owed back into Gloam's vault, where it came from");

        // the owner claims it: it goes back into Gloam's vault as a note of exactly that amount
        CloakLaunchSwapBase.Deposit memory back = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xB0)), address(0), left);
        uint256 g1 = gv.deposited(address(0));
        uint256 l1 = lv.deposited(address(0));
        bytes memory sig = _sig(rv.claimDigest(id, back.commitment));
        rv.claim(id, back, sig);
        assertEq(gv.deposited(address(0)) - g1, left, "the claim landed in Gloam's vault");
        assertEq(lv.deposited(address(0)), l1, "and not in the launch vault");
        assertEq(rv.owedVault(id), address(0));
        assertEq(address(rv).balance, 0, "the router holds nothing afterwards");
    }

    function test_router_sellFromTheLaunchVaultIntoGloamsVault() public {
        _setUpBoth();
        uint256 gBefore = gv.deposited(address(0));
        uint256 lvFees = lv.feesOwed(address(token));
        (bytes32 id, uint256 left) = _across(bytes32(uint256(0x70)), address(lv), address(token), 2_000e18, address(gv), address(0), 1 ether, _route(_key()));
        assertEq(gv.deposited(address(0)) - gBefore, 1 ether, "exactly 1 HYPE landed as a note in Gloam's vault");
        assertEq(lv.feesOwed(address(token)) - lvFees, 10e18, "the launch vault kept its fee on the tokens spent");
        assertEq(gv.feesOwed(address(0)), 0, "Gloam's vault charged nothing: deposits are free");
        assertEq(rv.owedVault(id), address(0), "a leftover in the launch vault (the home vault) is stored as zero");
        (address asset,, uint256 amount) = rv.owed(id);
        assertEq(asset, address(token));
        assertEq(amount, left);
    }

    function test_router_moveOneAssetBetweenVaults() public {
        _setUpBoth();
        uint256 lBefore = lv.deposited(address(0));
        // 1 HYPE note out of Gloam's vault (0.995 arrives after its fee), 0.99 into the launch vault
        (bytes32 id, uint256 left) = _across(bytes32(uint256(0xA1)), address(gv), address(0), 1 ether, address(lv), address(0), 0.99 ether, "");
        assertEq(lv.deposited(address(0)) - lBefore, 0.99 ether, "the HYPE moved into the launch vault as a new note");
        assertEq(left, 0.005 ether, "what arrived beyond the new note is owed back");
        assertEq(rv.owedVault(id), address(gv));
    }

    function test_router_moveTakesNoRoute() public {
        _setUpBoth();
        _expectFail(abi.encodeWithSelector(CloakLaunchSwapBase.BadRoute.selector), _prep(bytes32(uint256(0xA1)), address(gv), address(0), 1 ether, address(lv), address(0), 0.99 ether, _route(_key())));
    }

    function test_router_moveCantTakeMoreThanArrived() public {
        _setUpBoth();
        _expectFail(abi.encodeWithSelector(CloakLaunchSwapBase.OverInput.selector, 1 ether, 0.995 ether), _prep(bytes32(uint256(0xA1)), address(gv), address(0), 1 ether, address(lv), address(0), 1 ether, ""));
        assertFalse(gv.isSpent(bytes32(uint256(0xA1))), "the note stays unspent");
    }

    function test_router_sameAssetSameVaultRefused() public {
        _setUpBoth();
        _expectFail(abi.encodeWithSelector(CloakLaunchSwapBase.SameVault.selector), _prep(bytes32(uint256(0xA1)), address(gv), address(0), 1 ether, address(gv), address(0), 0.99 ether, ""));
    }

    function test_router_unknownVaultsRefused() public {
        _setUpBoth();
        address fake = address(0xFA4E);
        _expectFail(abi.encodeWithSelector(CloakLaunchSwapBase.UnknownVault.selector, fake), _prep(bytes32(uint256(0xA0)), address(gv), address(0), 1 ether, fake, address(token), 300e18, _route(_key())));
        _expectFail(abi.encodeWithSelector(CloakLaunchSwapBase.UnknownVault.selector, fake), _prep(bytes32(uint256(0xA0)), fake, address(0), 1 ether, address(lv), address(token), 300e18, _route(_key())));
        assertTrue(rv.isVault(address(lv)) && rv.isVault(address(gv)) && !rv.isVault(fake) && !rv.isVault(address(0)));
    }

    function test_router_aRelayCantRedirectTheOutputVault() public {
        _setUpBoth();
        // the owner's proof names the escrow for gv -> lv; a relay sends it as gv -> gv: another escrow, the proof fails
        bytes memory route = _route(_key());
        CloakLaunchSwapBase.Ends memory e = _ends(address(gv), address(lv));
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", gv.currentRoot(), bytes32(uint256(0xA2)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xD9)), address(token), 300e18);
        s.proof = abi.encode(rv.escrowAcross(rv.keyOf(s, d, route, owner, e.deadline), address(gv), address(lv)));
        e.vaultOut = address(gv);
        vm.expectRevert();
        rv.swapAcross(s, d, route, e);
        assertFalse(gv.isSpent(bytes32(uint256(0xA2))), "the note stays unspent");
        // and the same-vault path can't reuse the cross-vault proof either
        vm.expectRevert();
        rv.swap(s, d, route, owner, e.deadline);
    }

    function test_router_greedyBuyRevertsWhole() public {
        _setUpBoth();
        _expectFail("", _prep(bytes32(uint256(0xA0)), address(gv), address(0), 1 ether, address(lv), address(token), 900e18, _route(_key())));
        assertFalse(gv.isSpent(bytes32(uint256(0xA0))), "the note stays in Gloam's vault");
    }

    function test_router_spendSentAloneIsRescuedBackIntoItsVault() public {
        _setUpBoth();
        bytes memory route = _route(_key());
        CloakLaunchSwapBase.Ends memory e = _ends(address(gv), address(lv));
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", gv.currentRoot(), bytes32(uint256(0xA0)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xDA)), address(token), 300e18);
        CloakLaunchSwapBase.SwapKey memory k = rv.keyOf(s, d, route, owner, e.deadline);
        address escrow = rv.escrowAcross(k, address(gv), address(lv));
        s.proof = abi.encode(escrow);
        // someone copies the spend out of the call and sends it alone: the money waits at the escrow
        gv.unshield(s.proof, s.root, s.nullifier, address(0), escrow, 1 ether);
        assertEq(escrow.balance, 0.995 ether);
        vm.expectRevert(CloakLaunchSwapBase.NotYet.selector);
        rv.rescueAcross(k, address(gv), address(lv));
        vm.warp(e.deadline + 1);
        uint256 amount = rv.rescueAcross(k, address(gv), address(lv));
        assertEq(amount, 0.995 ether, "after the deadline anyone rescues it: the whole input is owed");
        bytes32 id = rv.idAcross(k, address(gv), address(lv));
        assertEq(rv.owedVault(id), address(gv));
        CloakLaunchSwapBase.Deposit memory back = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xB1)), address(0), amount);
        uint256 g1 = gv.deposited(address(0));
        bytes memory sig = _sig(rv.claimDigest(id, back.commitment));
        rv.claim(id, back, sig);
        assertEq(gv.deposited(address(0)) - g1, amount, "and the owner's claim puts it back into Gloam's vault");
    }

    function test_router_spendSentAloneCanStillBeFinishedBeforeTheDeadline() public {
        _setUpBoth();
        bytes memory route = _route(_key());
        CloakLaunchSwapBase.Ends memory e = _ends(address(gv), address(lv));
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", gv.currentRoot(), bytes32(uint256(0xA0)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xDB)), address(token), 300e18);
        address escrow = rv.escrowAcross(rv.keyOf(s, d, route, owner, e.deadline), address(gv), address(lv));
        s.proof = abi.encode(escrow);
        gv.unshield(s.proof, s.root, s.nullifier, address(0), escrow, 1 ether);
        uint256 tBefore = lv.deposited(address(token));
        rv.swapAcross(s, d, route, e);
        assertEq(lv.deposited(address(token)) - tBefore, 300e18, "the original call still completes the swap");
    }

    function test_router_noExitToAListedVault() public {
        _setUpBoth();
        (bytes32 id,) = _across(bytes32(uint256(0xA0)), address(gv), address(0), 1 ether, address(lv), address(token), 300e18, _route(_key()));
        bytes memory sg = _sig(rv.exitDigest(id, address(gv)));
        bytes memory sl = _sig(rv.exitDigest(id, address(lv)));
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        rv.exit(id, address(gv), sg);
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        rv.exit(id, address(lv), sl);
        // an exit to a plain address works, and clears where it was owed
        address to = address(0xE717);
        bytes memory st = _sig(rv.exitDigest(id, to));
        rv.exit(id, to, st);
        assertGt(to.balance, 0);
        assertEq(rv.owedVault(id), address(0));
    }

    function test_router_sameVaultSwapStillWorks() public {
        _setUpBoth();
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), bytes32(uint256(1)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xDC)), address(token), 300e18);
        bytes memory route = _route(_key());
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(rv.escrowFor(rv.keyOf(s, d, route, owner, deadline)));
        uint256 tBefore = lv.deposited(address(token));
        rv.swap(s, d, route, owner, deadline);
        assertEq(lv.deposited(address(token)) - tBefore, 300e18, "a swap inside the launch vault works as in CloakLaunchSwapV4");
    }

    function test_router_vaultListIsFixedAndClean() public {
        _setUpBoth();
        address[] memory bad = new address[](1);
        bad[0] = address(lv);
        vm.expectRevert(CloakLaunchSwapBase.ZeroAddress.selector);
        new CloakRouterV4(address(lv), bad, address(pm), address(whype), address(hook));
        bad[0] = address(0);
        vm.expectRevert(CloakLaunchSwapBase.ZeroAddress.selector);
        new CloakRouterV4(address(lv), bad, address(pm), address(whype), address(hook));
        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (address(gv), address(gv));
        vm.expectRevert(CloakLaunchSwapBase.ZeroAddress.selector);
        new CloakRouterV4(address(lv), dup, address(pm), address(whype), address(hook));
        address[] memory four = new address[](4);
        for (uint256 i = 0; i < 4; i++) four[i] = address(uint160(0x1000 + i));
        vm.expectRevert(CloakLaunchSwapBase.BadRoute.selector);
        new CloakRouterV4(address(lv), four, address(pm), address(whype), address(hook));
        assertEq(rv.vault1(), address(gv));
        assertEq(rv.vault2(), address(0));
    }
}
