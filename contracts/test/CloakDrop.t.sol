// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakDrop, CloakDropFactory} from "../src/CloakDrop.sol";

contract CloakDropTest is Test {
    CloakConfig config;
    CloakDropFactory factory;
    CloakDrop drop;

    address creator = makeAddr("creator");
    address treasury = makeAddr("treasury");
    address wl1 = makeAddr("wl1");
    address wl2 = makeAddr("wl2");
    address gtd1 = makeAddr("gtd1");
    address gtd2 = makeAddr("gtd2");

    uint128 constant FLOOR = 0.5 ether;
    uint128 constant TICK = 0.1 ether;

    function setUp() public {
        config = new CloakConfig(address(1), treasury);
        factory = new CloakDropFactory(config);
    }

    // ───────────── helpers ─────────────

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _wlLeaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _gtdLeaf(address a, uint32 spots) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, spots))));
    }

    function _make(uint32 supply, uint16 boost, bool withWl, bool withGtd) internal {
        CloakDrop.Params memory p;
        p.supply = supply;
        p.maxPerBid = 2;
        p.numTicks = 20;
        p.wlBoostBps = boost;
        p.royaltyBps = 500;
        p.gtdEnd = uint64(block.timestamp + (withGtd ? 1 days : 0));
        p.commitEnd = uint64(p.gtdEnd + 1 days);
        p.revealEnd = uint64(p.commitEnd + 1 hours);
        p.floor = FLOOR;
        p.tickSize = TICK;
        p.gtdPrice = 0.4 ether;
        if (withWl) p.wlRoot = _pair(_wlLeaf(wl1), _wlLeaf(wl2));
        if (withGtd) p.gtdRoot = _pair(_gtdLeaf(gtd1, 2), _gtdLeaf(gtd2, 1));
        vm.prank(creator);
        drop = factory.createDrop(p, "Moonfoxes", "MOON", "ipfs://moon/", "{}");
    }

    function _bidder(uint256 i) internal returns (address a) {
        a = address(uint160(0x1000 + i));
        vm.deal(a, 100 ether);
    }

    /// Commits a bid at `price` (a multiple of the tick above the floor) and returns its id and salt.
    function _bid(address who, uint256 price, uint128 qty, bool wl) internal returns (uint256 id, bytes32 salt) {
        uint16 tick = uint16((price - FLOOR) / TICK);
        salt = keccak256(abi.encode(who, price, qty, wl, block.timestamp));
        bytes32[] memory proof = new bytes32[](wl ? 1 : 0);
        if (wl) proof[0] = who == wl1 ? _wlLeaf(wl2) : _wlLeaf(wl1);
        vm.deal(who, 100 ether);
        uint256 cost = drop.costOf(tick, qty);
        bytes32 h = drop.commitmentOf(who, tick, qty, salt);
        vm.prank(who);
        id = drop.commit{value: cost}(h, hex"5ea1", wl, proof);
    }

    function _open(uint256 id, address who, uint256 price, uint128 qty, bytes32 salt) internal {
        who;
        drop.reveal(id, uint16((price - FLOOR) / TICK), qty, salt);
    }

    function _toBidding() internal {
        vm.warp(drop.params().gtdEnd);
    }

    function _toReveal() internal {
        vm.warp(drop.params().commitEnd);
    }

    function _settle() internal {
        vm.warp(drop.params().revealEnd);
        drop.settle();
        if (drop.tieSupply() != 0) drop.numberTies(10_000);
    }

    struct B {
        uint256 id;
        address who;
        uint256 price;
        uint128 qty;
        bytes32 salt;
    }

    function _place(address who, uint256 price, uint128 qty, bool wl) internal returns (B memory b) {
        (uint256 id, bytes32 salt) = _bid(who, price, qty, wl);
        b = B(id, who, price, qty, salt);
    }

    function _openAll(B[] memory bs) internal {
        for (uint256 k; k < bs.length; ++k) _open(bs[k].id, bs[k].who, bs[k].price, bs[k].qty, bs[k].salt);
    }

    // ───────────── the spec's three cases (floor 0.5, boost 20%) ─────────────

    function test_quiet_everyoneFillsAtTheFloor() public {
        _make(10, 2_000, true, false);
        _toBidding();
        B[] memory bs = new B[](3);
        bs[0] = _place(_bidder(1), 0.5 ether, 2, false);
        bs[1] = _place(_bidder(2), 0.9 ether, 1, false);
        bs[2] = _place(wl1, 0.5 ether, 2, true);
        _toReveal();
        _openAll(bs);
        _settle();
        assertEq(drop.sold(), 5);
        assertEq(drop.unitPrice(false), 0.5 ether, "public pays the floor");
        assertEq(drop.unitPrice(true), 0.5 ether, "WL never pays under the floor");
        uint256 before = bs[1].who.balance;
        drop.claim(bs[1].id);
        assertEq(drop.balanceOf(bs[1].who), 1);
        assertEq(bs[1].who.balance - before, 0.9 ether - 0.5 ether, "the 0.9 bidder pays only the floor");
    }

    function test_busyAtFloor_wlOutranksPublicAndTiesSellExactly() public {
        _make(5, 2_000, true, false);
        _toBidding();
        B[] memory bs = new B[](8);
        bs[0] = _place(wl1, 0.5 ether, 2, true);
        for (uint256 k = 1; k < 8; ++k) bs[k] = _place(_bidder(k), 0.5 ether, 1, false);
        _toReveal();
        _openAll(bs);
        _settle();
        assertEq(drop.sold(), 5);
        assertEq(drop.clearingScore(), uint256(0.5 ether) * 10_000, "clears at the public floor level");
        assertEq(drop.tieSupply(), 3, "3 left for the 7 public bids tied at the floor");
        assertEq(drop.tieDemand(), 7);
        (uint32 wlNfts,,,) = drop.allocationOf(bs[0].id);
        assertEq(wlNfts, 2, "the boosted WL bid fills in full ahead of every public bid");
        uint256 total;
        for (uint256 k; k < 8; ++k) {
            (uint32 n, uint256 paid,,) = drop.allocationOf(bs[k].id);
            assertEq(paid, uint256(n) * 0.5 ether);
            total += n;
            drop.claim(bs[k].id);
        }
        assertEq(total, 5, "ties never oversell or undersell");
        assertEq(drop.totalSupply(), 5);
    }

    function test_hot_wlBidOf08BeatsPublic09AndPays075() public {
        _make(3, 2_000, true, false);
        _toBidding();
        B[] memory bs = new B[](4);
        bs[0] = _place(_bidder(1), 1.0 ether, 1, false);
        bs[1] = _place(wl1, 0.8 ether, 1, true); // ranks as 0.96
        bs[2] = _place(_bidder(2), 0.9 ether, 1, false);
        bs[3] = _place(_bidder(3), 0.7 ether, 1, false);
        _toReveal();
        _openAll(bs);
        _settle();
        assertEq(drop.clearingScore(), uint256(0.9 ether) * 10_000, "the 0.9 public bid is the last that fits");
        assertEq(drop.unitPrice(false), 0.9 ether);
        assertEq(drop.unitPrice(true), 0.75 ether, "WL pays 0.9 / 1.2");
        (uint32 n1,,,) = drop.allocationOf(bs[1].id);
        (uint32 n3, uint256 p3, uint256 r3,) = drop.allocationOf(bs[3].id);
        assertEq(n1, 1, "WL 0.8 wins");
        assertEq(n3, 0, "public 0.7 loses");
        assertEq(p3, 0);
        assertEq(r3, 0.7 ether, "and is refunded in full");
        uint256 before = wl1.balance;
        drop.claim(bs[1].id);
        assertEq(wl1.balance - before, 0.8 ether - 0.75 ether);
    }

    // ───────────── GTD ─────────────

    function test_gtd_mintsSpotsAndUnusedRollIntoTheAuction() public {
        _make(10, 0, false, true);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _gtdLeaf(gtd2, 1);
        vm.deal(gtd1, 10 ether);
        vm.prank(gtd1);
        drop.gtdMint{value: 0.8 ether}(2, proof, 2);
        assertEq(drop.balanceOf(gtd1), 2);
        vm.prank(gtd1);
        vm.expectRevert("spots");
        drop.gtdMint{value: 0.4 ether}(2, proof, 1);
        // a wrong allowance doesn't match the list
        proof[0] = _gtdLeaf(gtd1, 2);
        vm.deal(gtd2, 10 ether);
        vm.prank(gtd2);
        vm.expectRevert("not on gtd");
        drop.gtdMint{value: 0.8 ether}(2, proof, 2);
        // gtd2 never mints: its spot rolls into the auction
        _toBidding();
        assertEq(drop.auctionSupply(), 8);
        vm.prank(gtd2);
        vm.expectRevert("gtd closed");
        drop.gtdMint{value: 0.4 ether}(1, proof, 1);
    }

    function test_gtd_biddingWaitsForTheGtdWindow() public {
        _make(10, 0, false, true);
        address a = _bidder(1);
        bytes32[] memory none;
        vm.prank(a);
        vm.expectRevert("gtd window");
        drop.commit{value: 1 ether}(bytes32(0), "", false, none);
    }

    // ───────────── WL proofs ─────────────

    function test_wl_onlyListedWalletsBidAsWl() public {
        _make(10, 2_000, true, false);
        _toBidding();
        address stranger = _bidder(9);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _wlLeaf(wl2);
        vm.prank(stranger);
        vm.expectRevert("not on wl");
        drop.commit{value: 1 ether}(bytes32(0), "", true, proof);
    }

    function test_boostNeedsAWl() public {
        CloakDrop.Params memory p;
        p.supply = 1;
        p.maxPerBid = 1;
        p.numTicks = 1;
        p.wlBoostBps = 1_000;
        p.gtdEnd = uint64(block.timestamp);
        p.commitEnd = uint64(block.timestamp + 1);
        p.revealEnd = uint64(block.timestamp + 2);
        p.floor = 1;
        vm.expectRevert("boost");
        factory.createDrop(p, "X", "X", "", "");
        p.wlBoostBps = 3_001;
        p.wlRoot = bytes32(uint256(1));
        vm.expectRevert("boost");
        factory.createDrop(p, "X", "X", "", "");
    }

    // ───────────── failures, penalties, refunds, money ─────────────

    function test_noBids_failsAndCreatorMintsTheSupply() public {
        _make(4, 0, false, false);
        vm.warp(drop.params().revealEnd);
        drop.settle();
        assertTrue(drop.failed());
        vm.prank(creator);
        drop.mintUnsold(creator, 4);
        assertEq(drop.balanceOf(creator), 4);
        vm.prank(creator);
        vm.expectRevert("none left");
        drop.mintUnsold(creator, 1);
    }

    function test_unrevealedBidLoses10Percent() public {
        _make(4, 0, false, false);
        _toBidding();
        B memory a = _place(_bidder(1), 0.5 ether, 1, false);
        B memory b = _place(_bidder(2), 0.6 ether, 1, false);
        _toReveal();
        _open(a.id, a.who, a.price, a.qty, a.salt);
        _settle();
        (, , uint256 refund, uint256 penalty) = drop.allocationOf(b.id);
        assertEq(penalty, 0.06 ether);
        assertEq(refund, 0.54 ether);
    }

    function test_invalidReveals_areRefused() public {
        _make(4, 0, false, false);
        _toBidding();
        address who = _bidder(1);
        bytes32 salt = bytes32(uint256(7));
        bytes32[] memory none;
        bytes32 h1 = drop.commitmentOf(who, 1, 1, salt);
        bytes32 h2 = drop.commitmentOf(who, 0, 3, salt);
        vm.prank(who);
        uint256 id = drop.commit{value: 0.5 ether}(h1, "", false, none); // 0.6 costs more
        vm.prank(who);
        uint256 id2 = drop.commit{value: 5 ether}(h2, "", false, none); // over max per bid
        _toReveal();
        vm.expectRevert("invalid reveal");
        drop.reveal(id, 1, 1, salt);
        vm.expectRevert("invalid reveal");
        drop.reveal(id2, 0, 3, salt);
    }

    function test_proceedsFeesAndUnsold() public {
        vm.prank(address(this));
        config.setFees(0, 200, treasury); // 2% launch fee
        _make(10, 0, false, false);
        _toBidding();
        B memory a = _place(_bidder(1), 0.5 ether, 2, false);
        _toReveal();
        _open(a.id, a.who, a.price, a.qty, a.salt);
        _settle();
        drop.claim(a.id);
        assertEq(drop.feesOwed(), 0.02 ether);
        assertEq(drop.creatorOwed(), 0.98 ether);
        drop.withdrawProceeds();
        drop.collectFees();
        assertEq(creator.balance, 0.98 ether);
        assertEq(treasury.balance, 0.02 ether);
        vm.prank(creator);
        drop.mintUnsold(creator, 8);
        assertEq(drop.totalSupply(), 10);
    }

    function test_claimTo_freshWallet_andNftBasics() public {
        _make(2, 0, false, false);
        _toBidding();
        B memory a = _place(_bidder(1), 0.5 ether, 1, false);
        _toReveal();
        _open(a.id, a.who, a.price, a.qty, a.salt);
        _settle();
        address fresh = makeAddr("fresh");
        vm.prank(_bidder(2));
        vm.expectRevert("bidder");
        drop.claimTo(a.id, fresh);
        vm.prank(a.who);
        drop.claimTo(a.id, fresh);
        assertEq(drop.ownerOf(1), fresh);
        assertEq(drop.tokenURI(1), "ipfs://moon/1");
        (address r, uint256 amt) = drop.royaltyInfo(1, 10 ether);
        assertEq(r, creator);
        assertEq(amt, 0.5 ether);
        assertTrue(drop.supportsInterface(0x80ac58cd) && drop.supportsInterface(0x2a55205a));
        vm.prank(fresh);
        drop.transferFrom(fresh, creator, 1);
        assertEq(drop.ownerOf(1), creator);
        vm.expectRevert("claimed");
        drop.claim(a.id);
    }

    function test_claimsWaitForTiesToBeNumbered() public {
        _make(1, 0, false, false);
        _toBidding();
        B memory a = _place(_bidder(1), 0.5 ether, 1, false);
        B memory b = _place(_bidder(2), 0.5 ether, 1, false);
        _toReveal();
        _open(a.id, a.who, a.price, a.qty, a.salt);
        _open(b.id, b.who, b.price, b.qty, b.salt);
        vm.warp(drop.params().revealEnd);
        drop.settle();
        assertEq(drop.phase(), 4);
        vm.expectRevert("ties not numbered");
        drop.claim(a.id);
        drop.numberTies(1);
        assertFalse(drop.tiesReady());
        drop.numberTies(5);
        assertEq(drop.phase(), 5);
        drop.claim(a.id);
        drop.claim(b.id);
        assertEq(drop.totalSupply(), 1);
    }

    /// However bids pile up at the clearing score, exactly the supply is sold and nobody pays more than they bid.
    function testFuzz_tiesSellExactlyTheSupply(uint8 nBids, uint8 supply, uint256 seed) public {
        nBids = uint8(bound(nBids, 1, 40));
        supply = uint8(bound(supply, 1, 30));
        _make(supply, 1_500, true, false);
        _toBidding();
        B[] memory bs = new B[](nBids);
        uint256 asked;
        for (uint256 k; k < nBids; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            uint128 q = uint128(1 + (r % 2));
            uint256 price = FLOOR + TICK * ((r >> 8) % 3);
            bool wl = (r >> 16) % 5 == 0;
            address who = wl ? ((r >> 24) % 2 == 0 ? wl1 : wl2) : _bidder(k);
            bs[k] = _place(who, price, q, wl);
            asked += q;
        }
        _toReveal();
        _openAll(bs);
        _settle();
        uint256 total;
        for (uint256 k; k < nBids; ++k) {
            (uint32 n, uint256 paid, uint256 refund,) = drop.allocationOf(bs[k].id);
            assertLe(n, bs[k].qty);
            assertLe(paid, bs[k].price * bs[k].qty, "never pays more than the bid");
            assertEq(paid + refund, bs[k].price * bs[k].qty, "deposit is paid or refunded, never kept");
            total += n;
        }
        assertEq(total, asked < supply ? asked : supply);
        for (uint256 k; k < nBids; ++k) drop.claim(bs[k].id);
        assertEq(drop.totalSupply(), total);
        assertEq(address(drop).balance, drop.creatorOwed() + drop.feesOwed(), "nothing stuck in the drop");
    }

    /// The tie draw must not depend on the order bids were opened in.
    function test_tieRandomIgnoresRevealOrder() public {
        uint256[2] memory rs;
        uint256 snap = vm.snapshotState();
        for (uint256 run; run < 2; ++run) {
            vm.revertToState(snap);
            _make(2, 0, false, false);
            _toBidding();
            B[] memory bs = new B[](4);
            for (uint256 k; k < 4; ++k) bs[k] = _place(_bidder(k), 0.5 ether, 1, false);
            _toReveal();
            if (run == 0) _openAll(bs);
            else for (uint256 k = 4; k > 0; --k) _open(bs[k - 1].id, bs[k - 1].who, bs[k - 1].price, bs[k - 1].qty, bs[k - 1].salt);
            vm.warp(drop.params().revealEnd);
            drop.settle();
            rs[run] = drop.tieRandom();
        }
        assertEq(rs[0], rs[1]);
    }
}
