// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakDrop, CloakDropFactory} from "../src/CloakDrop.sol";
import {CloakSpotBook} from "../src/CloakSpotBook.sol";

contract CloakSpotBookTest is Test {
    CloakConfig config;
    CloakDropFactory factory;
    CloakSpotBook book;
    CloakDrop drop;
    uint256 dropIndex;

    address creator = makeAddr("creator");
    uint128 constant FLOOR = 0.5 ether;
    uint128 constant TICK = 0.1 ether;

    function setUp() public {
        config = new CloakConfig(address(1), makeAddr("treasury"));
        factory = new CloakDropFactory(config, "https://cloak.example/api/nft/");
        book = new CloakSpotBook(factory);
        drop = _make(5, 2);
    }

    function _make(uint32 spots, uint32 maxPerBid) internal returns (CloakDrop d) {
        CloakDrop.Params memory p;
        p.supply = spots;
        p.maxPerBid = maxPerBid;
        p.numTicks = 20;
        p.gtdEnd = uint64(block.timestamp);
        p.commitEnd = uint64(block.timestamp + 1 days);
        p.revealEnd = uint64(p.commitEnd + 1 hours);
        p.floor = FLOOR;
        p.tickSize = TICK;
        vm.prank(creator);
        d = factory.createDrop(p, "Moonfoxes WL", "MWL", "", "{}");
        dropIndex = factory.dropsCount() - 1;
    }

    function _open() internal {
        uint64 dl = drop.params().revealEnd + 3 days;
        vm.prank(creator);
        book.open(dropIndex, "Moonfoxes", dl);
    }

    struct B {
        uint256 id;
        address who;
        uint16 tick;
        uint128 qty;
        bytes32 salt;
    }

    function _bid(uint256 i, uint256 price, uint128 qty) internal returns (B memory b) {
        b.who = address(uint160(0x1000 + i));
        b.tick = uint16((price - FLOOR) / TICK);
        b.qty = qty;
        b.salt = keccak256(abi.encode(i, price, qty));
        vm.deal(b.who, 100 ether);
        uint256 cost = drop.costOf(b.tick, qty);
        bytes32 h = drop.commitmentOf(b.who, b.tick, qty, b.salt);
        vm.prank(b.who);
        b.id = drop.commit{value: cost}(h, hex"5ea1", false, new bytes32[](0));
    }

    /// 5 spots: a (2 at 0.9), b (1 at 0.7), c (2 at 0.6) win; d (1 at 0.5) loses.
    function _auction() internal returns (B[] memory bs) {
        bs = new B[](4);
        bs[0] = _bid(1, 0.9 ether, 2);
        bs[1] = _bid(2, 0.7 ether, 1);
        bs[2] = _bid(3, 0.6 ether, 2);
        bs[3] = _bid(4, 0.5 ether, 1);
        vm.warp(drop.params().commitEnd);
        for (uint256 k; k < bs.length; ++k) drop.reveal(bs[k].id, bs[k].tick, bs[k].qty, bs[k].salt);
        vm.warp(drop.params().revealEnd);
        drop.settle();
        if (drop.tieSupply() != 0) drop.numberTies(10_000);
    }

    function _one(address w) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = w;
    }

    function _two(address w1, address w2) internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = w1;
        a[1] = w2;
    }

    function test_open_onlyCreatorOnceBeforeSettling() public {
        uint64 dl = drop.params().revealEnd + 1 days;
        vm.expectRevert(bytes("creator"));
        book.open(dropIndex, "Moonfoxes", dl);
        uint64 re = drop.params().revealEnd;
        vm.startPrank(creator);
        vm.expectRevert(bytes("partner"));
        book.open(dropIndex, "", dl);
        vm.expectRevert(bytes("deadline"));
        book.open(dropIndex, "Moonfoxes", re);
        vm.expectRevert(bytes("deadline"));
        book.open(dropIndex, "Moonfoxes", re + 91 days);
        address d = book.open(dropIndex, "Moonfoxes", dl);
        assertEq(d, address(drop));
        vm.expectRevert(bytes("already a sale"));
        book.open(dropIndex, "Moonfoxes", dl);
        vm.stopPrank();
        CloakSpotBook.Sale memory s = book.sale(address(drop));
        assertTrue(s.open);
        assertEq(s.partner, "Moonfoxes");
        assertEq(s.deadline, dl);
        assertEq(book.salesCount(), 1);
        assertEq(book.sales(0), address(drop));
    }

    function test_open_notAfterSettling() public {
        _auction();
        uint64 dl = drop.params().revealEnd + 1 days;
        vm.prank(creator);
        vm.expectRevert(bytes("settled"));
        book.open(dropIndex, "Moonfoxes", dl);
    }

    function test_winnersNameWalletsAndTheListIsExact() public {
        _open();
        B[] memory bs = _auction();
        address w1 = makeAddr("w1");
        address w2 = makeAddr("w2");
        address w3 = makeAddr("w3");
        address w4 = makeAddr("w4");
        address w5 = makeAddr("w5");
        vm.prank(bs[0].who);
        book.setWallets(address(drop), bs[0].id, _two(w1, w2));
        vm.prank(bs[1].who);
        book.setWallets(address(drop), bs[1].id, _one(w3));
        vm.prank(bs[2].who);
        book.setWallets(address(drop), bs[2].id, _two(w4, w5));
        (uint256[] memory ids, address[] memory ws) = book.list(address(drop));
        assertEq(ws.length, 5, "five spots, five wallets");
        assertEq(ws[0], w1);
        assertEq(ws[4], w5);
        assertEq(ids[2], bs[1].id);
        assertEq(book.spotOf(address(drop), w3), bs[1].id + 1);
        assertEq(book.walletsOf(address(drop), bs[2].id).length, 2);
    }

    function test_setWallets_guards() public {
        B[] memory bs = _auction();
        address w = makeAddr("w");
        vm.prank(bs[1].who);
        vm.expectRevert(bytes("not a sale"));
        book.setWallets(address(drop), bs[1].id, _one(w));

        // a fresh drop, marked as a sale, before it settles
        drop = _make(5, 2);
        _open();
        vm.prank(bs[1].who);
        vm.expectRevert(); // no such bid yet on the new drop
        book.setWallets(address(drop), 0, _one(w));
        bs = _auctionBefore();
        vm.prank(bs[1].who);
        vm.expectRevert(bytes("not settled"));
        book.setWallets(address(drop), bs[1].id, _one(w));
        _finish(bs);

        vm.prank(bs[0].who);
        vm.expectRevert(bytes("not your bid"));
        book.setWallets(address(drop), bs[1].id, _one(w));
        vm.prank(bs[3].who);
        vm.expectRevert(bytes("bid won no spots"));
        book.setWallets(address(drop), bs[3].id, _one(w));
        vm.prank(bs[0].who);
        vm.expectRevert(bytes("one wallet per spot"));
        book.setWallets(address(drop), bs[0].id, _one(w));
        vm.prank(bs[0].who);
        vm.expectRevert(bytes("wallet already has a spot"));
        book.setWallets(address(drop), bs[0].id, _two(w, w));
        vm.prank(bs[1].who);
        vm.expectRevert(bytes("zero wallet"));
        book.setWallets(address(drop), bs[1].id, _one(address(0)));

        vm.prank(bs[1].who);
        book.setWallets(address(drop), bs[1].id, _one(w));
        vm.prank(bs[2].who);
        vm.expectRevert(bytes("wallet already has a spot"));
        book.setWallets(address(drop), bs[2].id, _two(w, makeAddr("x")));

        uint64 dl = book.sale(address(drop)).deadline;
        vm.warp(dl);
        vm.prank(bs[2].who);
        vm.expectRevert(bytes("deadline passed"));
        book.setWallets(address(drop), bs[2].id, _two(makeAddr("y"), makeAddr("x")));
    }

    function test_changingWalletsFreesTheOldOnes() public {
        _open();
        B[] memory bs = _auction();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.startPrank(bs[1].who);
        book.setWallets(address(drop), bs[1].id, _one(a));
        book.setWallets(address(drop), bs[1].id, _one(b));
        vm.stopPrank();
        assertEq(book.spotOf(address(drop), a), 0, "the old wallet is freed");
        assertEq(book.spotOf(address(drop), b), bs[1].id + 1);
        (, address[] memory ws) = book.list(address(drop));
        assertEq(ws.length, 1, "a change replaces, it doesn't add");
        assertEq(ws[0], b);
        // the freed wallet can go to another winner
        vm.prank(bs[0].who);
        book.setWallets(address(drop), bs[0].id, _two(a, makeAddr("c")));
        (, ws) = book.list(address(drop));
        assertEq(ws.length, 3);
    }

    function test_tiedBidsOnlyNameWhatTheyWon() public {
        _open();
        // 5 spots: 4 at 0.9, then two bids of 2 tie at 0.5 for the last spot
        B[] memory bs = new B[](4);
        bs[0] = _bid(1, 0.9 ether, 2);
        bs[1] = _bid(2, 0.9 ether, 2);
        bs[2] = _bid(3, 0.5 ether, 2);
        bs[3] = _bid(4, 0.5 ether, 2);
        _finish(bs);
        (uint32 n2,,,) = drop.allocationOf(bs[2].id);
        (uint32 n3,,,) = drop.allocationOf(bs[3].id);
        assertEq(n2 + n3, 1);
        B memory winner = n2 == 1 ? bs[2] : bs[3];
        vm.prank(winner.who);
        vm.expectRevert(bytes("one wallet per spot"));
        book.setWallets(address(drop), winner.id, _two(makeAddr("p"), makeAddr("q")));
        vm.prank(winner.who);
        book.setWallets(address(drop), winner.id, _one(makeAddr("p")));
    }

    function test_onlyFactoryDropsCanBeSales() public {
        vm.prank(creator);
        vm.expectRevert(); // index out of range: there is no such drop
        book.open(99, "Moonfoxes", uint64(block.timestamp + 10 days));
    }

    // helpers that split _auction for the guards test
    function _auctionBefore() internal returns (B[] memory bs) {
        bs = new B[](4);
        bs[0] = _bid(1, 0.9 ether, 2);
        bs[1] = _bid(2, 0.7 ether, 1);
        bs[2] = _bid(3, 0.6 ether, 2);
        bs[3] = _bid(4, 0.5 ether, 1);
        vm.warp(drop.params().commitEnd);
        for (uint256 k; k < bs.length; ++k) drop.reveal(bs[k].id, bs[k].tick, bs[k].qty, bs[k].salt);
    }

    function _finish(B[] memory bs) internal {
        if (block.timestamp < drop.params().commitEnd) {
            vm.warp(drop.params().commitEnd);
            for (uint256 k; k < bs.length; ++k) drop.reveal(bs[k].id, bs[k].tick, bs[k].qty, bs[k].salt);
        }
        vm.warp(drop.params().revealEnd);
        drop.settle();
        if (drop.tieSupply() != 0) drop.numberTies(10_000);
    }
}
