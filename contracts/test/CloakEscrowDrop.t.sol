// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakDrop} from "../src/CloakDrop.sol";
import {CloakEscrowDrop, CloakEscrowDropFactory, IERC721Min} from "../src/CloakEscrowDrop.sol";

/// A plain ERC-721, the kind an existing collection is.
contract Nft {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public getApproved;
    bool public refuse; // a collection that starts refusing transfers
    bool public burnGas; // or burns all the gas it's given
    bool public lie; // or claims the transfer worked when it didn't
    address public reenter; // or calls back into the drop

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function approve(address op, uint256 id) external {
        getApproved[id] = op;
    }

    function set(bool refuse_, bool burnGas_, bool lie_, address reenter_) external {
        (refuse, burnGas, lie, reenter) = (refuse_, burnGas_, lie_, reenter_);
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(!refuse, "refused");
        if (burnGas) while (true) {}
        if (reenter != address(0)) {
            (bool ok,) = reenter.call(abi.encodeWithSignature("claim(uint256)", uint256(1)));
            require(!ok, "re-entered");
        }
        if (lie) return;
        require(ownerOf[id] == from, "from");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || getApproved[id] == msg.sender, "not allowed");
        ownerOf[id] = to;
        delete getApproved[id];
    }
}

contract CloakEscrowDropTest is Test {
    CloakConfig config;
    CloakEscrowDropFactory factory;
    CloakEscrowDrop drop;
    Nft nft;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address wl1 = makeAddr("wl1");
    uint128 constant FLOOR = 0.5 ether;
    uint128 constant TICK = 0.1 ether;
    uint256 t0;

    function setUp() public {
        t0 = block.timestamp;
        config = new CloakConfig(address(1), treasury);
        factory = new CloakEscrowDropFactory(config);
        nft = new Nft();
        for (uint256 i = 1; i <= 30; ++i) nft.mint(owner, i * 7); // ids 7, 14, …, 210
        vm.prank(owner);
        nft.setApprovalForAll(address(factory), true);
    }

    function _params(uint16 boost, bool withWl) internal view returns (CloakDrop.Params memory p) {
        p.maxPerBid = 3;
        p.numTicks = 20;
        p.wlBoostBps = boost;
        p.gtdEnd = uint64(t0);
        p.commitEnd = uint64(t0 + 1 days);
        p.revealEnd = uint64(t0 + 1 days + 1 hours);
        p.floor = FLOOR;
        p.tickSize = TICK;
        if (withWl) p.wlRoot = keccak256(bytes.concat(keccak256(abi.encode(wl1))));
    }

    function _ids(uint256 n) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = (i + 1) * 7;
    }

    function _make(uint256 n) internal {
        uint256[] memory ids = _ids(n);
        CloakDrop.Params memory p = _params(0, false);
        vm.prank(owner);
        drop = factory.createDrop(p, IERC721Min(address(nft)), ids, "Treasury auction", "TRES", "{}");
    }

    function _bid(address who, uint256 price, uint128 qty, bool wl) internal returns (uint256 id, bytes32 salt) {
        uint16 tick = uint16((price - FLOOR) / TICK);
        salt = keccak256(abi.encode(who, price, qty, wl));
        bytes32[] memory proof = new bytes32[](0);
        vm.deal(who, 100 ether);
        uint256 cost = drop.costOf(tick, qty);
        bytes32 h = drop.commitmentOf(who, tick, qty, salt);
        vm.prank(who);
        id = drop.commit{value: cost}(h, hex"5ea1", wl, proof);
    }

    function _open(uint256 id, uint256 price, uint128 qty, bytes32 salt) internal {
        drop.reveal(id, uint16((price - FLOOR) / TICK), qty, salt);
    }

    function _bidder(uint256 i) internal pure returns (address) {
        return address(uint160(0x5000 + i));
    }

    function _settleAndNumber() internal {
        drop.settle();
        vm.roll(block.number + 2); // the tie draw is seeded by the block after settlement
        if (!drop.failed()) drop.numberTies(1000);
    }

    // ───────────── escrow ─────────────

    function test_creationMovesEveryTokenIn() public {
        _make(5);
        assertTrue(drop.funded());
        assertEq(drop.held(), 5);
        for (uint256 i = 1; i <= 5; ++i) assertEq(nft.ownerOf(i * 7), address(drop));
        assertEq(nft.ownerOf(42), owner, "tokens not listed stay with the owner");
        assertEq(drop.params().supply, 5);
        assertEq(drop.params().creator, owner);
        assertEq(address(drop.collection()), address(nft));
    }

    function test_cantListTokensYouDontOwn() public {
        nft.mint(wl1, 999);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 999;
        CloakDrop.Params memory p = _params(0, false);
        vm.prank(owner);
        vm.expectRevert(bytes("not your token"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
    }

    function test_cantListWithoutApproval() public {
        vm.prank(owner);
        nft.setApprovalForAll(address(factory), false);
        uint256[] memory ids = _ids(2);
        CloakDrop.Params memory p = _params(0, false);
        vm.prank(owner);
        vm.expectRevert(bytes("not allowed"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
    }

    function test_cantListATokenTwiceOrOutOfOrder() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 14;
        ids[1] = 7;
        CloakDrop.Params memory p = _params(0, false);
        vm.prank(owner);
        vm.expectRevert(bytes("token order"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
        ids[1] = 14;
        vm.prank(owner);
        vm.expectRevert(bytes("token order"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
    }

    function test_noGtdNoRoyaltyAndAContractCollection() public {
        uint256[] memory ids = _ids(2);
        CloakDrop.Params memory p = _params(0, false);
        p.gtdRoot = bytes32(uint256(1));
        vm.prank(owner);
        vm.expectRevert(bytes("no gtd"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
        p = _params(0, false);
        p.royaltyBps = 500;
        vm.prank(owner);
        vm.expectRevert(bytes("royalty"));
        factory.createDrop(p, IERC721Min(address(nft)), ids, "X", "X", "{}");
        p = _params(0, false);
        vm.prank(owner);
        vm.expectRevert(bytes("collection"));
        factory.createDrop(p, IERC721Min(makeAddr("eoa")), ids, "X", "X", "{}");
    }

    function test_nobodyButTheFactoryActivates() public {
        uint256[] memory ids = _ids(1);
        CloakDrop.Params memory p = _params(0, false);
        p.creator = owner;
        p.supply = 1;
        CloakEscrowDrop d = new CloakEscrowDrop(p, IERC721Min(address(nft)), ids, "X", "X", config);
        // this test contract is its factory, but it holds nothing yet: bidding stays shut
        vm.expectRevert(bytes("not escrowed"));
        d.activate();
        vm.deal(wl1, 1 ether);
        vm.prank(wl1);
        vm.expectRevert(bytes("not escrowed"));
        d.commit{value: 1 ether}(bytes32(0), "", false, new bytes32[](0));
        vm.prank(wl1);
        vm.expectRevert(bytes("factory"));
        d.activate();
    }

    // ───────────── auction ─────────────

    function test_winnersGetTheEscrowedTokensAndPayOnePrice() public {
        _make(4);
        (uint256 a, bytes32 sa) = _bid(_bidder(1), 1.0 ether, 2, false);
        (uint256 b, bytes32 sb) = _bid(_bidder(2), 0.8 ether, 2, false);
        (uint256 c, bytes32 sc) = _bid(_bidder(3), 0.6 ether, 2, false);
        vm.warp(t0 + 1 days);
        _open(a, 1.0 ether, 2, sa);
        _open(b, 0.8 ether, 2, sb);
        _open(c, 0.6 ether, 2, sc);
        assertEq(drop.phase(), 3, "every bid open: settles early");
        drop.settle();
        vm.roll(block.number + 2); // the tie draw is seeded by the block after settlement
        assertEq(drop.phase(), 4, "slots get numbered before claims");
        vm.expectRevert(bytes("ties not numbered"));
        drop.claim(a);
        drop.numberTies(1000);
        assertEq(drop.phase(), 5);
        assertEq(drop.unitPrice(false), 0.8 ether, "clearing price: the lowest winning bid");
        uint256 before3 = _bidder(3).balance;
        drop.claimBatch(_three(a, b, c));
        uint256[] memory ta = drop.tokensOf(a);
        uint256[] memory tb = drop.tokensOf(b);
        assertEq(ta.length, 2);
        assertEq(tb.length, 2);
        for (uint256 i; i < 2; ++i) {
            assertEq(nft.ownerOf(ta[i]), _bidder(1));
            assertEq(nft.ownerOf(tb[i]), _bidder(2));
        }
        assertEq(drop.tokensOf(c).length, 0);
        assertEq(_bidder(3).balance - before3, 1.2 ether, "the loser gets its whole deposit back");
        assertEq(drop.delivered(), 4);
        assertEq(drop.held(), 0);
        assertEq(_bidder(1).balance, 100 ether - 1.6 ether, "the top bidder pays the clearing price, not its bid");
        // creator and fee
        uint256 fee = (3.2 ether * config.launchFeeBps()) / 10_000;
        assertEq(drop.creatorOwed(), 3.2 ether - fee);
        assertEq(drop.feesOwed(), fee);
        drop.withdrawProceeds();
        assertEq(owner.balance, 3.2 ether - fee);
    }

    function _three(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function test_whoGetsWhichTokenDoesntDependOnClaimOrder() public {
        _make(6);
        uint256[] memory ids = new uint256[](3);
        bytes32[] memory salts = new bytes32[](3);
        for (uint256 i; i < 3; ++i) (ids[i], salts[i]) = _bid(_bidder(i), 0.5 ether + i * 0.1 ether, 2, false);
        vm.warp(t0 + 1 days);
        for (uint256 i; i < 3; ++i) _open(ids[i], 0.5 ether + i * 0.1 ether, 2, salts[i]);
        _settleAndNumber();
        uint256[][] memory planned = new uint256[][](3);
        for (uint256 i; i < 3; ++i) planned[i] = drop.tokensOf(ids[i]);
        uint256 snap = vm.snapshotState();
        drop.claim(ids[0]);
        drop.claim(ids[1]);
        drop.claim(ids[2]);
        address[3] memory forward;
        for (uint256 i; i < 3; ++i) forward[i] = nft.ownerOf(planned[i][0]);
        vm.revertToState(snap);
        drop.claim(ids[2]);
        drop.claim(ids[0]);
        drop.claim(ids[1]);
        for (uint256 i; i < 3; ++i) {
            assertEq(nft.ownerOf(planned[i][0]), forward[i], "same tokens whatever the claim order");
            assertEq(nft.ownerOf(planned[i][1]), _bidder(i));
        }
        // and every listed token went to exactly one winner
        uint256 seen;
        for (uint256 i; i < 3; ++i) for (uint256 k; k < 2; ++k) seen |= 1 << (planned[i][k] / 7);
        assertEq(seen, 0x7e, "tokens 7..42, each once");
    }

    function test_unsoldTokensGoBackToTheOwner() public {
        _make(5);
        (uint256 a, bytes32 sa) = _bid(_bidder(1), 0.7 ether, 2, false);
        vm.warp(t0 + 1 days);
        _open(a, 0.7 ether, 2, sa);
        _settleAndNumber();
        assertEq(drop.sold(), 2);
        vm.expectRevert(bytes("creator"));
        drop.mintUnsold(owner, 3);
        vm.prank(owner);
        vm.expectRevert(bytes("none left"));
        drop.mintUnsold(owner, 4);
        vm.prank(owner);
        drop.mintUnsold(owner, 3);
        drop.claim(a);
        uint256 mine;
        for (uint256 i = 1; i <= 5; ++i) if (nft.ownerOf(i * 7) == owner) ++mine;
        assertEq(mine, 3, "the three unsold came back");
        assertEq(drop.held(), 0);
        assertEq(drop.unitPrice(false), 0.5 ether, "undersubscribed: everyone pays the floor");
    }

    function test_noBidsReturnsEverything() public {
        _make(3);
        vm.warp(t0 + 1 days + 1 hours);
        drop.settle();
        vm.roll(block.number + 2); // the tie draw is seeded by the block after settlement
        assertTrue(drop.failed());
        assertEq(drop.phase(), 5);
        vm.prank(owner);
        drop.mintUnsold(owner, 3);
        for (uint256 i = 1; i <= 3; ++i) assertEq(nft.ownerOf(i * 7), owner);
    }

    function test_tiesAreDrawnAndStillGetDistinctTokens() public {
        _make(3);
        uint256[] memory ids = new uint256[](4);
        bytes32[] memory salts = new bytes32[](4);
        for (uint256 i; i < 4; ++i) (ids[i], salts[i]) = _bid(_bidder(i), 0.6 ether, 1, false);
        vm.warp(t0 + 1 days);
        for (uint256 i; i < 4; ++i) _open(ids[i], 0.6 ether, 1, salts[i]);
        _settleAndNumber();
        assertEq(drop.tieSupply(), 3);
        assertEq(drop.tieDemand(), 4);
        uint256 won;
        for (uint256 i; i < 4; ++i) {
            drop.claim(ids[i]);
            uint256[] memory t = drop.tokensOf(ids[i]);
            if (t.length == 1) {
                ++won;
                assertEq(nft.ownerOf(t[0]), _bidder(i));
            }
        }
        assertEq(won, 3);
        assertEq(drop.held(), 0);
    }

    function test_wlBoostWorksOnEscrowDrops() public {
        uint256[] memory ids = _ids(1);
        CloakDrop.Params memory p = _params(2_000, true);
        vm.prank(owner);
        drop = factory.createDrop(p, IERC721Min(address(nft)), ids, "One", "ONE", "{}");
        (uint256 a, bytes32 sa) = _bid(_bidder(1), 0.9 ether, 1, false);
        (uint256 w, bytes32 sw) = _bid(wl1, 0.8 ether, 1, true); // ranks as 0.96
        vm.warp(t0 + 1 days);
        _open(a, 0.9 ether, 1, sa);
        _open(w, 0.8 ether, 1, sw);
        _settleAndNumber();
        drop.claim(w);
        drop.claim(a);
        assertEq(nft.ownerOf(7), wl1, "the boosted WL bid wins the 1/1");
    }

    // ───────────── a collection that misbehaves can't trap bidders ─────────────

    function _soldTwo() internal returns (uint256 a, uint256 b) {
        _make(2);
        bytes32 sa;
        bytes32 sb;
        (a, sa) = _bid(_bidder(1), 0.7 ether, 1, false);
        (b, sb) = _bid(_bidder(2), 0.7 ether, 1, false);
        vm.warp(t0 + 1 days);
        _open(a, 0.7 ether, 1, sa);
        _open(b, 0.7 ether, 1, sb);
        _settleAndNumber();
    }

    function test_aRefusedTransferRefundsTheWinner() public {
        (uint256 a,) = _soldTwo();
        nft.set(true, false, false, address(0));
        uint256 before = _bidder(1).balance;
        drop.claim(a);
        assertEq(_bidder(1).balance - before, 0.7 ether, "the whole deposit back: it paid for nothing");
        assertEq(drop.creatorOwed(), 0);
        assertEq(drop.delivered(), 0);
        // the owner gets the token back once the collection works again
        uint256 idx = (drop.slotStart(a) + drop.rotation()) % 2;
        assertTrue(drop.undelivered(idx));
        nft.set(false, false, false, address(0));
        vm.prank(owner);
        drop.recoverUndelivered(idx, owner);
        assertEq(nft.ownerOf(drop.tokenIds()[idx]), owner);
        vm.prank(owner);
        vm.expectRevert(bytes("nothing"));
        drop.recoverUndelivered(idx, owner);
    }

    function test_aGasBurningCollectionCantBlockClaims() public {
        (uint256 a,) = _soldTwo();
        nft.set(false, true, false, address(0));
        uint256 before = _bidder(1).balance;
        drop.claim{gas: 2_000_000}(a);
        assertEq(_bidder(1).balance - before, 0.7 ether);
    }

    function test_aLyingCollectionIsCaught() public {
        (uint256 a,) = _soldTwo();
        nft.set(false, false, true, address(0)); // says ok, moves nothing
        uint256 before = _bidder(1).balance;
        drop.claim(a);
        assertEq(_bidder(1).balance - before, 0.7 ether, "it didn't arrive, so it isn't paid for");
    }

    /// A-2 (external review, Nov 2026): a collection whose ownerOf returns dirty upper bits made abi.decode revert, so
    /// every claim failed and deposits were stuck. The whole word is compared now: the token reads as not delivered and
    /// the winner is refunded instead.
    function test_aDirtyOwnerOfCantBrickClaims() public {
        (uint256 a,) = _soldTwo();
        uint256 id = drop.tokensOf(a)[0];
        vm.mockCall(address(nft), abi.encodeWithSignature("ownerOf(uint256)", id), abi.encode(uint256(uint160(_bidder(1))) | (uint256(1) << 200)));
        uint256 before = _bidder(1).balance;
        drop.claim(a);
        assertEq(_bidder(1).balance - before, 0.7 ether, "refunded, not stuck");
    }

    function test_aCollectionCantReenter() public {
        (uint256 a,) = _soldTwo();
        nft.set(false, false, false, address(drop));
        drop.claim(a); // Nft asserts the re-entry failed
        assertEq(nft.ownerOf(drop.tokensOf(a)[0]), _bidder(1));
    }

    function test_theLargestEscrowFitsInABlock() public {
        for (uint256 i = 31; i <= 500; ++i) nft.mint(owner, i * 7);
        uint256[] memory ids = _ids(500);
        CloakDrop.Params memory p = _params(0, false);
        vm.prank(owner);
        uint256 g = gasleft();
        drop = factory.createDrop(p, IERC721Min(address(nft)), ids, "Big", "BIG", "{}");
        g -= gasleft();
        assertLt(g, 30_000_000, "500 tokens move in under 30M gas");
        assertEq(drop.held(), 500);
        emit log_named_uint("gas to escrow 500 tokens", g);
        uint256[] memory over = new uint256[](501);
        for (uint256 i; i < 501; ++i) over[i] = 100_000 + i;
        vm.expectRevert(bytes("supply"));
        factory.createDrop(p, IERC721Min(address(nft)), over, "Big", "BIG", "{}");
    }

    // ───────────── nothing leaks ─────────────

    function testFuzz_moneyAndTokensAddUp(uint8 nTokens, uint8 nBids, uint256 seed) public {
        uint256 n = bound(nTokens, 1, 12);
        uint256 m = bound(nBids, 0, 10);
        _make(n);
        uint256[] memory ids = new uint256[](m);
        uint256 deposits;
        for (uint256 i; i < m; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 price = FLOOR + (r % 6) * TICK;
            uint128 q = uint128(1 + (r >> 8) % 3);
            bytes32 salt;
            (ids[i], salt) = _bid(_bidder(i), price, q, false);
            deposits += drop.costOf(uint16((price - FLOOR) / TICK), q);
            if ((r >> 16) % 5 != 0) {
                vm.warp(t0 + 1 days);
                _open(ids[i], price, q, salt);
                vm.warp(t0);
            }
        }
        vm.warp(t0 + 1 days + 1 hours);
        _settleAndNumber();
        for (uint256 i; i < m; ++i) drop.claim(ids[i]);
        uint256 left = n - (drop.failed() ? 0 : drop.sold());
        if (left > 0) {
            vm.prank(owner);
            drop.mintUnsold(owner, uint32(left));
        }
        assertEq(drop.held(), 0, "every token left the escrow");
        uint256 toWinners;
        for (uint256 i; i < m; ++i) toWinners += drop.tokensOf(ids[i]).length;
        assertEq(toWinners + left, n, "each token went to exactly one place");
        assertEq(address(drop).balance, drop.creatorOwed() + drop.feesOwed(), "the drop keeps only what it owes");
        deposits;
    }
}
