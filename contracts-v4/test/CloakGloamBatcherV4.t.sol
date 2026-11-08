// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CloakGloamBatcherBase} from "cloak-gloam/CloakGloamBatcher.sol";
import {CloakGloamBatcherV4} from "cloak-gloam/CloakGloamBatcherV4.sol";
import {CloakLaunchSwapV4Test} from "./CloakLaunchSwapV4.t.sol";

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
        batcher = new CloakGloamBatcherV4(address(lv), address(factory), ROUND, 200, 600);
    }

    function _key(bytes32 n, bool buy, uint128 size) internal view returns (CloakGloamBatcherBase.OrderKey memory) {
        return CloakGloamBatcherBase.OrderKey(n, address(token), buy, size, owner, owner);
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
        vm.warp((uint256(round) + 1) * ROUND);
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
}
