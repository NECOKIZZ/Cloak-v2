// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CloakGloamBatcherBase} from "cloak-gloam/CloakGloamBatcher.sol";
import {CloakGloamBatcherV4} from "cloak-gloam/CloakGloamBatcherV4.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {CloakLaunchSwapV4Test, ToV, YesV} from "./CloakLaunchSwapV4.t.sol";

/**
 * Batch rounds on a real Cloak v4 launch, on the real PoolManager: the round's market is the launch's CloakV4Market
 * (registered from the factory), orders are notes of Cloak's launch vault, the net trades through the hooked pool, and
 * payouts come back into the vault as notes. Inherits the launch and vault setup (and its tests).
 */
contract CloakGloamBatcherV4Test is CloakLaunchSwapV4Test {
    CloakGloamBatcherV4 batcher;
    uint256 constant ROUND = 60;

    function _setUpBatcher() internal {
        _setUpVault();
        batcher = new CloakGloamBatcherV4(address(lv), address(0), address(factory), ROUND, 200, 600);
    }

    function _key(bytes32 n, bool buy, uint128 size) internal view returns (CloakGloamBatcherBase.OrderKey memory) {
        address key = vm.addr(ownerPk); // the address of the key that signs the claim
        return CloakGloamBatcherBase.OrderKey(n, address(token), buy, size, key, key);
    }

    function _place(bytes32 n, bool buy, uint128 size) internal returns (CloakGloamBatcherBase.OrderKey memory k, bytes32 id) {
        k = _key(n, buy, size);
        CloakGloamBatcherBase.Spend memory s = CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), lv.currentRoot(), n, buy ? address(0) : address(token), size);
        id = batcher.place(s, k);
    }

    function test_registerOnlySettledLaunchesWithAMarket() public {
        _setUpBatcher();
        assertEq(batcher.register(0), address(token));
        (, address m) = (0, address(batcher.marketOf(address(token))));
        assertEq(m, address(market), "the launch's own CloakV4Market");
        batcher.register(0); // a second call changes nothing
        assertEq(address(batcher.marketOf(address(token))), address(market));
    }

    function test_unregisteredTokenHasNoMarket() public {
        _setUpBatcher();
        CloakGloamBatcherBase.OrderKey memory k = _key(bytes32(uint256(0xE0)), true, 1 ether);
        CloakGloamBatcherBase.Spend memory s = CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), lv.currentRoot(), k.nullifier, address(0), 1 ether);
        vm.expectRevert(CloakGloamBatcherBase.NoPair.selector);
        batcher.place(s, k);
    }

    function test_aRoundSettlesThroughTheV4Market() public {
        _setUpBatcher();
        batcher.register(0);
        (CloakGloamBatcherBase.OrderKey memory kb, bytes32 buyId) = _place(bytes32(uint256(0xE0)), true, 1 ether);
        (, bytes32 sellId) = _place(bytes32(uint256(0x70)), false, 2_000e18);
        uint64 round = batcher.currentRound();
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.settle(address(token), round);
        vm.warp(batcher.settleOpens(address(token), round)); // the round has ended and its average covers a whole round
        // right after listing, Cloak's hook charges a 10% anti-snipe fee falling to the base over 300 s: a round that
        // settled inside it would lose more than the batcher's 5% impact cap, so it waits (the keeper tries each tick)
        uint256 listed = block.timestamp;
        try batcher.settle(address(token), round) {} catch (bytes memory err) {
            assertEq(bytes4(err), CloakGloamBatcherBase.Impact.selector, "only the anti-snipe fee holds it back");
            vm.warp(listed + 301);
            batcher.settle(address(token), round);
        }
        (address a1, uint256 tokensOwed) = batcher.owed(buyId);
        (address a2, uint256 hypeOwed) = batcher.owed(sellId);
        assertEq(a1, address(token));
        assertEq(a2, address(0));
        assertGt(tokensOwed, 0, "the buyer is owed tokens");
        assertGt(hypeOwed, 0, "the seller is owed HYPE");
        // the buyer takes its tokens back into the vault as one note
        bytes32 c = bytes32(uint256(0xB0B));
        (uint8 v, bytes32 r, bytes32 s2) = vm.sign(ownerPk, batcher.claimDigest(buyId, c));
        uint256 before = lv.deposited(address(token));
        batcher.claim(kb, CloakGloamBatcherBase.Deposit(hex"00", c, address(token), tokensOwed), abi.encodePacked(r, s2, v));
        assertEq(lv.deposited(address(token)) - before, tokensOwed, "the payout is a note in the launch vault");
    }

    // ── HYPE in Gloam's vault, launch tokens in the launch vault ──────────

    ShieldPoolPayments gv;

    function _setUpTwoVaults() internal {
        _setUpVault();
        gv = new ShieldPoolPayments(_poseidon(), address(new ToV()));
        gv.setShieldVerifier(address(new YesV()));
        gv.setWithdrawFee(50, address(0x6A0A));
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        gv.endSetup();
        gv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xA0)), hex"00");
        batcher = new CloakGloamBatcherV4(address(lv), address(gv), address(factory), ROUND, 200, 600);
        batcher.register(0);
    }

    function _placeIn(bytes32 n, bool buy, uint128 size) internal returns (CloakGloamBatcherBase.OrderKey memory k, bytes32 id) {
        k = _key(n, buy, size);
        bytes32 root = buy ? gv.currentRoot() : lv.currentRoot();
        CloakGloamBatcherBase.Spend memory s = CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), root, n, buy ? address(0) : address(token), size);
        id = batcher.place(s, k);
    }

    function _settleRound(uint64 round) internal {
        vm.warp(batcher.settleOpens(address(token), round));
        uint256 listed = block.timestamp;
        try batcher.settle(address(token), round) {} catch {
            vm.warp(listed + 301); // past the hook's anti-snipe window, as above
            batcher.settle(address(token), round);
        }
    }

    function test_twoVaults_eachAssetUsesItsVault() public {
        _setUpTwoVaults();
        assertEq(address(batcher.vaultFor(address(0))), address(gv), "HYPE: Gloam's vault");
        assertEq(address(batcher.vaultFor(address(token))), address(lv), "launch tokens: the launch vault");
        assertEq(address(batcher.hypeVault()), address(gv));
    }

    function test_twoVaults_aRoundSpendsAndPaysEachSideInItsVault() public {
        _setUpTwoVaults();
        uint256 g0 = gv.deposited(address(0));
        uint256 lh0 = lv.deposited(address(0));
        (CloakGloamBatcherBase.OrderKey memory kb, bytes32 buyId) = _placeIn(bytes32(uint256(0xA0)), true, 1 ether);
        (CloakGloamBatcherBase.OrderKey memory ks, bytes32 sellId) = _placeIn(bytes32(uint256(0x70)), false, 2_000e18);
        assertEq(g0 - gv.deposited(address(0)), 1 ether, "the buy order's HYPE note left Gloam's vault");
        assertEq(gv.feesOwed(address(0)), 0.005 ether, "Gloam's vault kept its fee on it");
        assertEq(lv.deposited(address(0)), lh0, "the launch vault's HYPE wasn't touched");
        _settleRound(batcher.currentRound());
        (, uint256 tokensOwed) = batcher.owed(buyId);
        (, uint256 hypeOwed) = batcher.owed(sellId);
        // the buyer's tokens go into the launch vault, the seller's HYPE into Gloam's vault
        bytes32 c1 = bytes32(uint256(0xB0B));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerPk, batcher.claimDigest(buyId, c1));
        uint256 t0 = lv.deposited(address(token));
        batcher.claim(kb, CloakGloamBatcherBase.Deposit(hex"00", c1, address(token), tokensOwed), abi.encodePacked(r1, s1, v1));
        assertEq(lv.deposited(address(token)) - t0, tokensOwed, "the buyer's tokens are a note in the launch vault");
        bytes32 c2 = bytes32(uint256(0xB0C));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(ownerPk, batcher.claimDigest(sellId, c2));
        uint256 g1 = gv.deposited(address(0));
        batcher.claim(ks, CloakGloamBatcherBase.Deposit(hex"00", c2, address(0), hypeOwed), abi.encodePacked(r2, s2, v2));
        assertEq(gv.deposited(address(0)) - g1, hypeOwed, "the seller's HYPE is a note in Gloam's vault");
        assertEq(lv.deposited(address(0)), lh0, "and none of it in the launch vault");
    }

    function test_twoVaults_aHypeNoteInTheLaunchVaultCantBuy() public {
        _setUpTwoVaults();
        CloakGloamBatcherBase.OrderKey memory k = _key(bytes32(uint256(0xE0)), true, 1 ether);
        CloakGloamBatcherBase.Spend memory s = CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), lv.currentRoot(), k.nullifier, address(0), 1 ether);
        vm.expectRevert();
        batcher.place(s, k);
        assertFalse(lv.isSpent(k.nullifier), "the launch vault's HYPE note stays put");
    }

    function test_twoVaults_noExitIntoEitherVault() public {
        _setUpTwoVaults();
        (CloakGloamBatcherBase.OrderKey memory kb, bytes32 buyId) = _placeIn(bytes32(uint256(0xA0)), true, 1 ether);
        _settleRound(batcher.currentRound());
        (uint8 v, bytes32 r, bytes32 s2) = vm.sign(ownerPk, batcher.exitDigest(buyId, address(gv)));
        vm.expectRevert(CloakGloamBatcherBase.BadSignature.selector);
        batcher.exit(kb, address(gv), abi.encodePacked(r, s2, v));
        (v, r, s2) = vm.sign(ownerPk, batcher.exitDigest(buyId, address(lv)));
        vm.expectRevert(CloakGloamBatcherBase.BadSignature.selector);
        batcher.exit(kb, address(lv), abi.encodePacked(r, s2, v));
    }
}
