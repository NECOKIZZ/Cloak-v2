// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakRouterV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {CloakTradeFee} from "cloak-gloam/CloakTradeFee.sol";
import {CloakLaunchSwapV4Test, ToV, YesV} from "./CloakLaunchSwapV4.t.sol";

/**
 * CloakRouterV4: Cloak launch tokens in Cloak's launch vault, HYPE in Gloam's vault (Gloam's own ShieldPoolPayments
 * here). A buy spends a HYPE note in Gloam's vault and lands the token as a note in the launch vault; a sell does the
 * reverse. The router picks each vault from the asset; the caller can't.
 */
contract CloakRouterV4Test is CloakLaunchSwapV4Test {
    ShieldPoolPayments gv; // Gloam's vault
    CloakRouterV4 rv;

    function _setUpBoth() internal {
        _setUpVault();
        owner = vm.addr(ownerPk); // the owner key signs claims and exits here
        gv = new ShieldPoolPayments(_poseidon(), address(new ToV()));
        gv.setShieldVerifier(address(new YesV()));
        gv.setWithdrawFee(50, address(0x6A0A));
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        gv.endSetup();
        rv = new CloakRouterV4(address(lv), address(gv), address(0), address(pm), address(whype), address(hook), address(0));
        for (uint256 i = 0; i < 3; i++) gv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(0xA0 + i), hex"00");
    }

    struct Call {
        CloakLaunchSwapBase.Spend s;
        CloakLaunchSwapBase.Deposit d;
        bytes route;
        uint256 deadline;
    }

    /// Everything a swap needs, read before the call (so vm.expectRevert sees only the swap).
    function _prep(bytes32 n, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut) internal view returns (Call memory c) {
        c.route = _route(_key());
        c.deadline = block.timestamp + 600;
        c.s = CloakLaunchSwapBase.Spend(hex"", address(rv.vaultFor(assetIn)) == address(gv) ? gv.currentRoot() : lv.currentRoot(), n, assetIn, amountIn);
        c.d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        c.s.proof = abi.encode(rv.escrowFor(rv.keyOf(c.s, c.d, c.route, owner, c.deadline)));
    }

    function _go(Call memory c) internal returns (bytes32 id, uint256 left) {
        return rv.swap(c.s, c.d, c.route, owner, c.deadline);
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_router_eachAssetHasOneVault() public {
        _setUpBoth();
        assertEq(address(rv.vaultFor(address(token))), address(lv), "a Cloak launch token lives in the launch vault");
        assertEq(address(rv.vaultFor(address(0))), address(gv), "HYPE lives in Gloam's vault");
        assertEq(address(rv.vaultFor(address(0xC0FFEE))), address(gv), "anything else (USDC) lives in Gloam's vault");
    }

    function test_router_buySpendsHypeInGloamsVaultIntoTheLaunchVault() public {
        _setUpBoth();
        uint256 g0 = gv.deposited(address(0));
        uint256 t0 = lv.deposited(address(token));
        uint256 lh0 = lv.deposited(address(0));
        (bytes32 id, uint256 left) = _go(_prep(bytes32(uint256(0xA0)), address(0), 1 ether, address(token), 300e18));
        assertEq(g0 - gv.deposited(address(0)), 1 ether, "the HYPE note left Gloam's vault");
        assertEq(gv.feesOwed(address(0)), 0.005 ether, "Gloam's vault kept its fee on the HYPE spent");
        assertEq(lv.deposited(address(token)) - t0, 300e18, "exactly 300 tokens landed as a note in the launch vault");
        assertEq(lv.deposited(address(0)), lh0, "the launch vault's HYPE wasn't touched");
        assertGt(left, 0, "a buffer is left");

        // the buffer is HYPE, so it goes back into Gloam's vault
        CloakLaunchSwapBase.Deposit memory back = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xB0)), address(0), left);
        bytes memory sig = _sig(rv.claimDigest(id, back.commitment));
        uint256 g1 = gv.deposited(address(0));
        rv.claim(id, back, sig);
        assertEq(gv.deposited(address(0)) - g1, left, "the claim landed in Gloam's vault");
        assertEq(lv.deposited(address(0)), lh0, "not in the launch vault");
        assertEq(address(rv).balance, 0, "the router holds nothing afterwards");
    }

    function test_router_sellSpendsTokensInTheLaunchVaultIntoGloamsVault() public {
        _setUpBoth();
        uint256 g0 = gv.deposited(address(0));
        uint256 fees0 = lv.feesOwed(address(token));
        (bytes32 id, uint256 left) = _go(_prep(bytes32(uint256(0x70)), address(token), 2_000e18, address(0), 1 ether));
        assertEq(gv.deposited(address(0)) - g0, 1 ether, "exactly 1 HYPE landed as a note in Gloam's vault");
        assertEq(lv.feesOwed(address(token)) - fees0, 10e18, "the launch vault kept its fee on the tokens spent");
        assertEq(gv.feesOwed(address(0)), 0, "Gloam's vault charged nothing: deposits are free");
        (address asset,, uint256 amount) = rv.owed(id);
        assertEq(asset, address(token));
        assertEq(amount, left, "the token buffer is owed back into the launch vault");
    }

    /// Cloak's fee: the vaults charge nothing, and a sale out of the launch vault pays 0.5% of what it brings, in HYPE.
    function _withFee() internal returns (CloakTradeFee fees, address treasury) {
        treasury = address(0x7EA5);
        fees = new CloakTradeFee(address(this), treasury, 50);
        rv = new CloakRouterV4(address(lv), address(gv), address(0), address(pm), address(whype), address(hook), address(fees));
        lv.lowerWithdrawFee(0); // Cloak's launch vault charges nothing: the router takes Cloak's fee in HYPE
    }

    function test_router_saleOutOfTheLaunchVaultPaysCloaksFeeInHype() public {
        _setUpBoth();
        (CloakTradeFee fees, address treasury) = _withFee();
        uint256 g0 = gv.deposited(address(0));
        (uint256 fee, address to) = rv.tradeFee(address(token), address(0), 1 ether);
        assertEq(to, treasury);
        assertEq(fee, fees.feeOn(1 ether));
        assertApproxEqAbs(fee * 10_000, (1 ether + fee) * 50, 10_000, "0.5% of the whole sale");
        (bytes32 id, uint256 left) = _go(_prep(bytes32(uint256(0x70)), address(token), 2_000e18, address(0), 1 ether));
        assertEq(gv.deposited(address(0)) - g0, 1 ether, "the trader's note is exactly what they asked for");
        assertEq(treasury.balance, fee, "Cloak's fee went to the treasury, in HYPE");
        assertEq(lv.feesOwed(address(token)), 0, "the launch vault kept no tokens");
        (,, uint256 owedBack) = rv.owed(id);
        assertEq(owedBack, left, "the token buffer is still owed back");
        assertEq(address(rv).balance, 0, "the router holds no HYPE afterwards");
    }

    function test_router_buysPayNoCloakFee() public {
        _setUpBoth();
        (, address treasury) = _withFee();
        (uint256 fee,) = rv.tradeFee(address(0), address(token), 300e18);
        assertEq(fee, 0, "a buy (into Cloak's vault) pays no Cloak fee");
        _go(_prep(bytes32(uint256(0xA0)), address(0), 1 ether, address(token), 300e18));
        assertEq(treasury.balance, 0);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_router_feeChangesFollowTheRules() public {
        _setUpBoth();
        (CloakTradeFee fees,) = _withFee();
        fees.lower(25);
        (uint256 fee,) = rv.tradeFee(address(token), address(0), 1 ether);
        assertEq(fee, fees.feeOn(1 ether), "a lower fee applies at once");
        fees.lower(0);
        (fee,) = rv.tradeFee(address(token), address(0), 1 ether);
        assertEq(fee, 0, "and zero means none");
        fees.queue(100, address(0xBEEF));
        (fee,) = rv.tradeFee(address(token), address(0), 1 ether);
        assertEq(fee, 0, "a raise waits");
        vm.warp(block.timestamp + 3 days);
        fees.applyQueued();
        (uint256 fee2, address to2) = rv.tradeFee(address(token), address(0), 1 ether);
        assertEq(to2, address(0xBEEF));
        assertApproxEqAbs(fee2 * 10_000, (1 ether + fee2) * 100, 10_000, "1% after the wait");
    }

    function test_router_aHypeNoteInTheLaunchVaultCantBeSpentHere() public {
        _setUpBoth();
        // the launch vault's HYPE notes (from _setUpVault) are 0xE0..: the router spends HYPE only from Gloam's vault
        Call memory c = _prep(bytes32(uint256(0xE0)), address(0), 1 ether, address(token), 300e18);
        c.s.root = lv.currentRoot();
        vm.expectRevert();
        _go(c);
        assertFalse(lv.isSpent(bytes32(uint256(0xE0))));
    }

    function test_router_greedyBuyRevertsWhole() public {
        _setUpBoth();
        Call memory c = _prep(bytes32(uint256(0xA0)), address(0), 1 ether, address(token), 900e18);
        vm.expectRevert();
        _go(c);
        assertFalse(gv.isSpent(bytes32(uint256(0xA0))), "the note stays in Gloam's vault");
    }

    function test_router_spendSentAloneIsRescuedBackIntoGloamsVault() public {
        _setUpBoth();
        Call memory c = _prep(bytes32(uint256(0xA0)), address(0), 1 ether, address(token), 300e18);
        CloakLaunchSwapBase.SwapKey memory k = rv.keyOf(c.s, c.d, c.route, owner, c.deadline);
        address escrow = rv.escrowFor(k);
        // someone copies the spend out of the call and sends it alone: the money waits at the escrow
        gv.unshield(c.s.proof, c.s.root, c.s.nullifier, address(0), escrow, 1 ether);
        vm.expectRevert(CloakLaunchSwapBase.NotYet.selector);
        rv.rescue(k);
        vm.warp(c.deadline + 1);
        uint256 amount = rv.rescue(k);
        assertEq(amount, 0.995 ether, "after the deadline anyone rescues it: the whole input is owed");
        bytes32 id = rv.idOf(k);
        CloakLaunchSwapBase.Deposit memory back = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xB1)), address(0), amount);
        bytes memory sig = _sig(rv.claimDigest(id, back.commitment));
        uint256 g1 = gv.deposited(address(0));
        rv.claim(id, back, sig);
        assertEq(gv.deposited(address(0)) - g1, amount, "and the owner's claim puts it back into Gloam's vault");
    }

    function test_router_noExitToEitherVault() public {
        _setUpBoth();
        (bytes32 id,) = _go(_prep(bytes32(uint256(0xA0)), address(0), 1 ether, address(token), 300e18));
        bytes memory sg = _sig(rv.exitDigest(id, address(gv)));
        bytes memory sl = _sig(rv.exitDigest(id, address(lv)));
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        rv.exit(id, address(gv), sg);
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        rv.exit(id, address(lv), sl);
        address to = address(0xE717);
        bytes memory st = _sig(rv.exitDigest(id, to));
        rv.exit(id, to, st);
        assertGt(to.balance, 0, "an exit to a plain address works");
    }

    function test_router_vaultsAreFixedAndDistinct() public {
        _setUpBoth();
        vm.expectRevert(CloakLaunchSwapBase.ZeroAddress.selector);
        new CloakRouterV4(address(lv), address(0), address(0), address(pm), address(whype), address(hook), address(0));
        vm.expectRevert(CloakLaunchSwapBase.ZeroAddress.selector);
        new CloakRouterV4(address(lv), address(lv), address(0), address(pm), address(whype), address(hook), address(0));
        assertEq(address(rv.gloamVault()), address(gv));
        assertEq(address(rv.vault()), address(lv));
    }
}
