// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakAuctionTest} from "./CloakAuction.t.sol";
import {CloakAuction} from "../src/CloakAuction.sol";

/// A bidder contract that can't take native HYPE (no receive/fallback), but can still make calls.
contract RejectingBidder {
    function commit(CloakAuction a, bytes32 h) external payable returns (uint256) {
        return a.commit{value: msg.value}(h, hex"c0ffee");
    }

    function pull(CloakAuction a, address to) external {
        a.withdrawRefund(to);
    }
}

/// A bidder whose receive burns all the gas it's given.
contract GasBurner {
    function commit(CloakAuction a, bytes32 h) external payable returns (uint256) {
        return a.commit{value: msg.value}(h, hex"c0ffee");
    }

    receive() external payable {
        while (true) {}
    }
}

/// Reported before mainnet: a winning bidder that can't receive HYPE used to make claim() revert, which rolled back
/// its token transfer too (tokens stuck), made claimBatch revert for everyone in the batch, and blocked sweepDust.
contract ClaimRefundTest is CloakAuctionTest {
    function _commitFrom(address bidder, uint16 tick, uint128 qty, uint256 deposit)
        internal
        returns (uint256 id, bytes32 salt)
    {
        salt = keccak256(abi.encode(bidder, tick, qty, deposit));
        bytes32 h = auction.commitmentOf(bidder, tick, qty, salt);
        vm.deal(address(this), deposit);
        id = RejectingBidder(payable(bidder)).commit{value: deposit}(auction, h); // same selector on both bidder types
    }

    function _settleWith(uint256[] memory ids, uint16[] memory ticks, uint128[] memory qtys, bytes32[] memory salts)
        internal
    {
        _toReveal();
        for (uint256 i; i < ids.length; ++i) {
            auction.reveal(ids[i], ticks[i], qtys[i], salts[i]);
        }
        _toSettle();
        auction.settle();
    }

    function test_winnerThatCantTakeHype_stillGetsTokens_andCanPullRefundElsewhere() public {
        RejectingBidder r = new RejectingBidder();
        (uint256 id, bytes32 s) = _commitFrom(address(r), 19, 500_000e18, 2_000 ether);
        (uint256 id2, bytes32 s2) = _commit(alice, 9, 400_000e18, 1_000 ether);
        uint256[] memory ids = new uint256[](2);
        uint16[] memory ticks = new uint16[](2);
        uint128[] memory qtys = new uint128[](2);
        bytes32[] memory salts = new bytes32[](2);
        (ids[0], ticks[0], qtys[0], salts[0]) = (id, 19, 500_000e18, s);
        (ids[1], ticks[1], qtys[1], salts[1]) = (id2, 9, 400_000e18, s2);
        _settleWith(ids, ticks, qtys, salts);

        (uint256 tokens, uint256 refund,) = auction.allocationOf(id);
        assertGt(refund, 0); // over-collateralised winning bid: the normal case
        auction.claimBatch(ids); // used to revert for the whole batch
        assertEq(token.balanceOf(address(r)), tokens, "won tokens delivered");
        assertTrue(auction.getBid(id).claimed && auction.getBid(id2).claimed, "the rest of the batch claimed too");
        assertEq(auction.refundOwed(address(r)), refund, "refund held for the bidder");

        auction.sweepDust(); // used to be blocked forever
        assertEq(auction.refundOwed(address(r)), refund, "sweeping never touches held refunds");

        address to = makeAddr("r-new-home");
        r.pull(auction, to);
        assertEq(to.balance, refund);
        assertEq(auction.refundOwed(address(r)), 0);
        vm.expectRevert(bytes("nothing"));
        r.pull(auction, to);
        assertGe(address(auction).balance, auction.creatorOwed() + auction.feesOwed(), "still solvent");
    }

    function test_gasBurningBidder_cantBlockABatch() public {
        GasBurner g = new GasBurner();
        (uint256 id, bytes32 s) = _commitFrom(address(g), 19, 500_000e18, 2_000 ether);
        (uint256 id2, bytes32 s2) = _commit(bob, 19, 100_000e18, 1_000 ether);
        uint256[] memory ids = new uint256[](2);
        uint16[] memory ticks = new uint16[](2);
        uint128[] memory qtys = new uint128[](2);
        bytes32[] memory salts = new bytes32[](2);
        (ids[0], ticks[0], qtys[0], salts[0]) = (id, 19, 500_000e18, s);
        (ids[1], ticks[1], qtys[1], salts[1]) = (id2, 19, 100_000e18, s2);
        _settleWith(ids, ticks, qtys, salts);
        (, uint256 refund,) = auction.allocationOf(id);
        uint256 bobBefore = bob.balance;
        (, uint256 bobRefund,) = auction.allocationOf(id2);
        auction.claimBatch{gas: 2_000_000}(ids);
        assertEq(auction.refundOwed(address(g)), refund, "the burner's refund is held, not lost");
        assertEq(bob.balance - bobBefore, bobRefund, "bob paid normally in the same batch");
    }

    function test_onlyTheBidderCanPullItsRefund() public {
        vm.expectRevert(bytes("nothing"));
        vm.prank(alice);
        auction.withdrawRefund(alice);
    }
}
