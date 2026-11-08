// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {CloakGloamBatcherBase} from "cloak-gloam/CloakGloamBatcher.sol";
import {CloakGloamBatcherV4Test} from "../CloakGloamBatcherV4.t.sol";

/**
 * Stress tests for the v4 batcher on a real Cloak launch and the real PoolManager (the launch's own CloakV4Market,
 * behind CloakV4Hook): the opening-band grief (C-01) and the settle sandwich (C-02) work here too.
 * Pool after the test launch: about 1,000 HYPE against 500,000 tokens (0.002 HYPE a token), base fee 0.3%.
 */
contract BatcherV4StressTest is CloakGloamBatcherV4Test {
    bytes32 constant SPENT = bytes32(uint256(0x5BE7));
    address attacker = address(0xA77AC);

    function _stressSetUp() internal {
        _setUpBatcher();
        batcher.register(0);
        vm.warp(block.timestamp + 301); // past the hook's anti-snipe fee
        // one public withdrawal from the launch vault: SPENT is now a spent nullifier anyone can read
        lv.unshield(abi.encode(address(0xCAFE)), lv.currentRoot(), SPENT, address(0), address(0xCAFE), 1 ether);
        vm.deal(attacker, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
        // more HYPE in the launch vault for honest orders (the stand-in proofs don't track notes)
        lv.shieldBound{value: 40 ether}(address(0), 40 ether, bytes32(uint256(0x1234)), hex"00");
    }

    function _startOfNextRound() internal {
        vm.warp((block.timestamp / ROUND + 1) * ROUND);
    }

    /// 1 wei of HYPE paid straight to an order's escrow, placed with a nullifier someone else spent.
    function _outsideBuy(uint256 salt) internal {
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(SPENT, address(token), true, 1, vm.addr(0x1000 + salt), attacker);
        address escrow = batcher.escrowFor(k);
        vm.startPrank(attacker);
        (bool ok, ) = escrow.call{value: 1}("");
        require(ok);
        batcher.place(CloakGloamBatcherBase.Spend(hex"", bytes32(0), SPENT, address(0), 1), k);
        vm.stopPrank();
    }

    function _attackerBuy(uint256 hype) internal returns (uint256 tokens) {
        vm.prank(attacker);
        tokens = market.swapExactHypeForTokens{value: hype}(1, attacker);
    }

    function _attackerSell(uint256 tokens) internal returns (uint256 hype) {
        vm.startPrank(attacker);
        token.approve(address(market), tokens);
        hype = market.swapExactTokensForHype(tokens, 1, attacker);
        vm.stopPrank();
    }

    function _claimAmount(CloakGloamBatcherBase.OrderKey memory k, uint256 c) internal returns (uint256 amount) {
        bytes32 id = batcher.idOf(k);
        address asset;
        (asset, amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(c)));
        batcher.claim(k, CloakGloamBatcherBase.Deposit(hex"00", bytes32(c), asset, amount), abi.encodePacked(r, s, v));
    }

    function test_batcherV4_openingBandGrief_oneWeiFirstOrderForcesRefund() public {
        _stressSetUp();
        _startOfNextRound();
        uint64 round = batcher.currentRound();
        uint256 start = attacker.balance;
        // -- one attacker transaction: push ~3%, 1-wei first order, push back --
        uint256 tokens = _attackerBuy(15 ether);
        _outsideBuy(1);
        _attackerSell(tokens);
        uint256 cost = start - attacker.balance;
        console2.log("attacker cost (wei HYPE) to void a round on a ~1,000 HYPE pool:", cost);
        // -- honest orders at the normal price --
        vm.warp(block.timestamp + 5);
        (CloakGloamBatcherBase.OrderKey memory kb, ) = _place(bytes32(uint256(0xB1)), true, 1 ether);
        (CloakGloamBatcherBase.OrderKey memory ks, ) = _place(bytes32(uint256(0xB2)), false, 2_000e18);
        vm.warp(batcher.settleOpens(address(token), round));
        vm.expectRevert(CloakGloamBatcherBase.Slipped.selector);
        batcher.settle(address(token), round);
        vm.warp(block.timestamp + 599);
        vm.expectRevert(CloakGloamBatcherBase.Slipped.selector);
        batcher.settle(address(token), round);
        vm.warp(block.timestamp + 1);
        batcher.cancel(address(token), round);
        assertEq(_claimAmount(kb, 0xC1), 0.995 ether, "refunded, less the vault's 0.5%");
        assertEq(_claimAmount(ks, 0xC2), 1_990e18, "refunded, less the vault's 0.5%");
        assertLt(cost, 0.1 ether, "under 0.1 HYPE (two 0.3% pool fees on 15 HYPE)");
    }

    function test_batcherV4_settleSandwich_atomicExtractionFromBuyers() public {
        _stressSetUp();
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory k1, ) = _place(bytes32(uint256(0xD1)), true, 10 ether);
        (CloakGloamBatcherBase.OrderKey memory k2, ) = _place(bytes32(uint256(0xD2)), true, 10 ether);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(token), round));

        uint256 snap = vm.snapshotState();
        batcher.settle(address(token), round);
        uint256 fair = _claimAmount(k1, 0xF1) + _claimAmount(k2, 0xF2);
        vm.revertToState(snap);

        uint256 start = attacker.balance;
        // -- one attacker transaction --
        uint256 tokens = _attackerBuy(9 ether); // ~1.8% push, inside the 2% band
        batcher.settle(address(token), round);
        _attackerSell(tokens);
        // --
        uint256 sandwiched = _claimAmount(k1, 0xF1) + _claimAmount(k2, 0xF2);
        console2.log("buyers' tokens, fair      :", fair);
        console2.log("buyers' tokens, sandwiched:", sandwiched);
        console2.log("attacker profit (wei HYPE):", attacker.balance - start);
        assertGt(attacker.balance, start, "the sandwich pays");
        assertLt(sandwiched * 1000, fair * 985, "buyers lose more than 1.5%");
    }
}
