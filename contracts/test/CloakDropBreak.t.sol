// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakDrop, CloakDropFactory} from "../src/CloakDrop.sol";

/// A bidder that refuses HYPE, so its refund must be held for it.
contract Refuser {
    function bid(CloakDrop d, bytes32 h) external payable returns (uint256) {
        return d.commit{value: msg.value}(h, hex"00", false, new bytes32[](0));
    }

    function withdraw(CloakDrop d, address to) external {
        d.withdrawRefund(to);
    }

    receive() external payable {
        revert("no thanks");
    }
}

/// A bidder that tries to claim again from inside its refund.
contract Reenterer {
    CloakDrop d;
    uint256 id;
    uint256 public tries;

    function bid(CloakDrop d_, bytes32 h) external payable returns (uint256) {
        d = d_;
        id = d_.commit{value: msg.value}(h, hex"00", false, new bytes32[](0));
        return id;
    }

    receive() external payable {
        ++tries;
        d.claim(id); // must revert ("claimed"), so the refund is held instead of paid twice
    }
}

/// Break attempts on drops: timing (keeper delays), spam, reentrancy, held refunds, ties in steps, and a fuzzed
/// money-conservation check over random public/WL bids, unopened bids and refusing bidders.
contract CloakDropBreakTest is Test {
    CloakConfig config;
    CloakDropFactory factory;
    CloakDrop drop;
    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");
    uint128 constant FLOOR = 0.5 ether;
    uint128 constant TICK = 0.1 ether;
    address[] wls;

    function setUp() public {
        config = new CloakConfig(address(1), treasury);
        factory = new CloakDropFactory(config, "https://cloak.example/api/nft/");
    }

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// WL of exactly two wallets, so each proof is the other leaf.
    function _make(uint32 supply, uint16 boost, uint16 ticks, uint64 revealSecs) internal {
        wls = new address[](2);
        wls[0] = makeAddr("wlA");
        wls[1] = makeAddr("wlB");
        CloakDrop.Params memory p;
        p.supply = supply;
        p.maxPerBid = 3;
        p.numTicks = ticks;
        p.wlBoostBps = boost;
        p.gtdEnd = uint64(block.timestamp);
        p.commitEnd = uint64(block.timestamp + 1 hours);
        p.revealEnd = uint64(p.commitEnd + revealSecs);
        p.floor = FLOOR;
        p.tickSize = TICK;
        if (boost > 0) p.wlRoot = _pair(_leaf(wls[0]), _leaf(wls[1]));
        vm.prank(creator);
        drop = factory.createDrop(p, "Break", "BRK", "", "{}");
    }

    struct B {
        uint256 id;
        address who;
        uint16 tick;
        uint128 qty;
        bytes32 salt;
        bool wl;
    }

    function _bid(address who, uint16 tick, uint128 qty, bool wl) internal returns (B memory b) {
        b = B(0, who, tick, qty, keccak256(abi.encode(who, tick, qty, wl, gasleft())), wl);
        bytes32[] memory proof = new bytes32[](wl ? 1 : 0);
        if (wl) proof[0] = who == wls[0] ? _leaf(wls[1]) : _leaf(wls[0]);
        uint256 cost = drop.costOf(tick, qty);
        bytes32 h = drop.commitmentOf(who, tick, qty, b.salt);
        vm.deal(who, cost);
        vm.prank(who);
        b.id = drop.commit{value: cost}(h, hex"5ea1", wl, proof);
    }

    function _open(B memory b) internal {
        drop.reveal(b.id, b.tick, b.qty, b.salt);
    }

    // ───────────── timing: keeper delays and early settlement ─────────────

    function test_settlesEarlyOnceEveryBidIsOpen() public {
        _make(3, 0, 10, 1 hours);
        B memory a = _bid(makeAddr("a"), 2, 1, false);
        B memory b = _bid(makeAddr("b"), 0, 1, false);
        vm.warp(drop.params().commitEnd);
        _open(a);
        vm.expectRevert(bytes("reveal open"));
        drop.settle(); // one bid still sealed: the window stays open for it
        assertEq(drop.phase(), 2);
        _open(b);
        assertEq(drop.phase(), 3, "every bid open: ready to settle without waiting out the hour");
        drop.settle();
        assertEq(drop.sold(), 2);
    }

    function test_noBidsStillWaitsForTheWindow() public {
        _make(3, 0, 10, 1 hours);
        vm.warp(drop.params().commitEnd);
        assertEq(drop.phase(), 2, "no bids: nothing to open, but the window still runs");
        vm.expectRevert(bytes("reveal open"));
        drop.settle();
        vm.warp(drop.params().revealEnd);
        drop.settle();
        assertTrue(drop.failed());
    }

    function test_noRevealAfterSettling() public {
        _make(3, 0, 10, 1 hours);
        B memory a = _bid(makeAddr("a"), 1, 1, false);
        vm.warp(drop.params().commitEnd);
        _open(a);
        drop.settle();
        vm.expectRevert(bytes("not reveal phase"));
        drop.reveal(a.id, a.tick, a.qty, a.salt);
    }

    function test_aLongKeeperOutageOnlyCostsTheUnopened() public {
        // the keeper opens one bid, then goes down past the window: only the sealed bid pays the 10%
        _make(3, 0, 10, 30 minutes);
        B memory a = _bid(makeAddr("a"), 1, 1, false);
        B memory b = _bid(makeAddr("b"), 1, 1, false);
        vm.warp(drop.params().commitEnd);
        _open(a);
        vm.warp(drop.params().revealEnd);
        drop.settle();
        (,,, uint256 penA) = drop.allocationOf(a.id);
        (uint32 nB,, uint256 refB, uint256 penB) = drop.allocationOf(b.id);
        assertEq(penA, 0);
        assertEq(nB, 0);
        assertEq(penB, drop.costOf(1, 1) / 10);
        assertEq(refB + penB, drop.costOf(1, 1));
    }

    // ───────────── spam, reentrancy, refusing bidders ─────────────

    function test_spamBidsUnderTheFloorAreRefused() public {
        _make(3, 0, 10, 1 hours);
        address s = makeAddr("spam");
        vm.deal(s, 1 ether);
        vm.startPrank(s);
        vm.expectRevert(bytes("deposit"));
        drop.commit{value: 1}(bytes32(uint256(1)), "", false, new bytes32[](0));
        vm.expectRevert(bytes("deposit"));
        drop.commit{value: FLOOR - 1}(bytes32(uint256(1)), "", false, new bytes32[](0));
        drop.commit{value: FLOOR}(bytes32(uint256(1)), "", false, new bytes32[](0));
        vm.stopPrank();
    }

    function test_refusingBidderGetsItsRefundHeldAndWithdrawsIt() public {
        _make(1, 0, 10, 1 hours);
        Refuser r = new Refuser();
        B memory win = _bid(makeAddr("w"), 5, 1, false);
        bytes32 salt = keccak256("r");
        uint256 cost = drop.costOf(1, 1);
        vm.deal(address(this), cost);
        uint256 id = r.bid{value: cost}(drop, drop.commitmentOf(address(r), 1, 1, salt));
        vm.warp(drop.params().commitEnd);
        _open(win);
        drop.reveal(id, 1, 1, salt);
        drop.settle();
        drop.claim(id); // the refund can't be sent, so it is held, and the claim still completes
        assertEq(drop.refundOwed(address(r)), cost);
        address to = makeAddr("to");
        r.withdraw(drop, to);
        assertEq(to.balance, cost);
        vm.expectRevert(bytes("nothing"));
        r.withdraw(drop, to);
    }

    function test_reentrantClaimCantPayTwice() public {
        _make(1, 0, 10, 1 hours);
        Reenterer r = new Reenterer();
        B memory win = _bid(makeAddr("w"), 5, 1, false);
        bytes32 salt = keccak256("x");
        uint256 cost = drop.costOf(1, 1);
        vm.deal(address(this), cost);
        uint256 id = r.bid{value: cost}(drop, drop.commitmentOf(address(r), 1, 1, salt));
        vm.warp(drop.params().commitEnd);
        _open(win);
        drop.reveal(id, 1, 1, salt);
        drop.settle();
        uint256 before = address(drop).balance;
        drop.claim(id);
        assertEq(address(r).balance, 0, "the re-entry reverted, so nothing was sent");
        assertEq(drop.refundOwed(address(r)), cost, "the refund is held once");
        assertEq(address(drop).balance, before, "nothing left the drop");
        vm.expectRevert(bytes("claimed"));
        drop.claim(id);
    }

    function test_claimToZeroOrByOthersRefused() public {
        _make(1, 0, 10, 1 hours);
        B memory a = _bid(makeAddr("a"), 1, 1, false);
        vm.warp(drop.params().commitEnd);
        _open(a);
        drop.settle();
        vm.expectRevert(bytes("bidder"));
        drop.claimTo(a.id, makeAddr("thief"));
        vm.prank(a.who);
        vm.expectRevert(bytes("to"));
        drop.claimTo(a.id, address(0));
    }

    // ───────────── ties in steps, GTD edge ─────────────

    function test_tieNumberingInSmallStepsMatchesOneGo() public {
        // the same settled drop, numbered in one go and then (from the same state) one bid per call
        _make(3, 0, 5, 1 hours);
        B[] memory bs = new B[](8);
        for (uint256 k; k < 8; ++k) bs[k] = _bid(address(uint160(0x5000 + k)), 0, uint128(1 + (k % 2)), false);
        vm.warp(drop.params().commitEnd);
        for (uint256 k; k < 8; ++k) _open(bs[k]);
        drop.settle();
        vm.expectRevert(bytes("ties not numbered"));
        drop.claim(bs[0].id);
        uint256 snap = vm.snapshotState();
        drop.numberTies(1000);
        uint32[] memory one = new uint32[](8);
        uint32 total;
        for (uint256 k; k < 8; ++k) {
            (one[k],,,) = drop.allocationOf(bs[k].id);
            total += one[k];
        }
        assertEq(total, 3, "exactly the supply");
        vm.revertToState(snap);
        uint256 calls;
        while (drop.phase() == 4) {
            drop.numberTies(1);
            ++calls;
        }
        assertEq(calls, 8);
        for (uint256 k; k < 8; ++k) {
            (uint32 n,,,) = drop.allocationOf(bs[k].id);
            assertEq(n, one[k], "numbering in steps changes nothing");
        }
    }

    function test_gtdTakesEverything_bidsFullyRefunded() public {
        CloakDrop.Params memory p;
        address g = makeAddr("g");
        p.supply = 2;
        p.maxPerBid = 2;
        p.numTicks = 5;
        p.gtdEnd = uint64(block.timestamp + 1 hours);
        p.commitEnd = uint64(p.gtdEnd + 1 hours);
        p.revealEnd = uint64(p.commitEnd + 1 hours);
        p.floor = FLOOR;
        p.tickSize = TICK;
        p.gtdPrice = 0;
        p.gtdRoot = keccak256(bytes.concat(keccak256(abi.encode(g, uint32(2)))));
        vm.prank(creator);
        drop = factory.createDrop(p, "G", "G", "", "{}");
        vm.prank(g);
        drop.gtdMint(2, new bytes32[](0), 2); // free GTD
        vm.warp(p.gtdEnd);
        B memory a = _bid(makeAddr("a"), 1, 1, false);
        vm.warp(p.commitEnd);
        _open(a);
        drop.settle();
        assertTrue(drop.failed());
        (uint32 n, uint256 paid, uint256 refund, uint256 pen) = drop.allocationOf(a.id);
        assertEq(n + paid + pen, 0);
        assertEq(refund, drop.costOf(1, 1));
        vm.prank(creator);
        vm.expectRevert(bytes("none left"));
        drop.mintUnsold(creator, 1);
    }

    function _check(B memory b, bool opened) internal view returns (uint32 nfts, uint256 paid, uint256 out, uint256 dep) {
        uint256 refund;
        uint256 pen;
        (nfts, paid, refund, pen) = drop.allocationOf(b.id);
        dep = drop.costOf(b.tick, b.qty);
        assertEq(paid + refund + pen, dep, "each deposit is paid, refunded or penalised, exactly");
        assertLe(nfts, b.qty);
        if (nfts > 0) {
            uint256 unit = paid / nfts;
            assertEq(unit, drop.unitPrice(b.wl), "one price per side");
            assertLe(unit, drop.priceAt(b.tick), "nobody pays more than they bid");
            assertGe(unit, FLOOR, "nobody pays under the floor");
        }
        if (!opened) assertEq(nfts, 0);
        out = refund + pen;
    }

    // ───────────── fuzz: every wei accounted for, one price, never past the supply ─────────────

    function testFuzz_moneyIsConservedAndPricesAreFair(uint256 seed, uint8 nBids, uint8 supplyRaw, uint16 boostRaw) public {
        uint32 supply = uint32(bound(supplyRaw, 1, 12));
        uint16 boost = uint16(bound(boostRaw, 0, 3000));
        uint256 n = bound(nBids, 1, 24);
        _make(supply, boost, 12, 1 hours);
        B[] memory bs = new B[](n);
        bool[] memory opened = new bool[](n);
        for (uint256 k; k < n; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            bool wl = boost > 0 && r % 3 == 0;
            address who = wl ? wls[(r >> 8) % 2] : address(uint160(0x9000 + k));
            bs[k] = _bid(who, uint16((r >> 16) % 12), uint128(1 + ((r >> 32) % 3)), wl);
            opened[k] = (r >> 48) % 5 != 0; // about 1 in 5 never opens
        }
        vm.warp(drop.params().commitEnd);
        for (uint256 k; k < n; ++k) if (opened[k]) _open(bs[k]);
        vm.warp(drop.params().revealEnd);
        drop.settle();
        while (drop.phase() == 4) drop.numberTies(7);

        uint256 deposits;
        uint256 paidSum;
        uint256 outSum;
        uint32 won;
        for (uint256 k; k < n; ++k) {
            (uint32 nfts, uint256 paid, uint256 out, uint256 dep) = _check(bs[k], opened[k]);
            deposits += dep;
            won += nfts;
            paidSum += paid;
            outSum += out;
        }
        assertLe(won, supply, "never past the supply");
        assertEq(won, drop.failed() ? 0 : drop.sold(), "what's won is what was sold");

        for (uint256 k; k < n; ++k) drop.claim(bs[k].id);
        assertEq(drop.totalSupply(), won);
        assertEq(address(drop).balance, drop.creatorOwed() + drop.feesOwed(), "after every claim the drop holds only what it owes");
        assertEq(drop.creatorOwed() + drop.feesOwed(), paidSum);
        assertEq(paidSum + outSum, deposits);
        if (drop.creatorOwed() > 0) drop.withdrawProceeds();
        if (drop.feesOwed() > 0) drop.collectFees();
        assertEq(address(drop).balance, 0, "nothing stuck");
    }
}
