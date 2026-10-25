// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakPair} from "../src/CloakPair.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";

contract CloakAuctionTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    CloakConfig config;
    CloakFactory factory;
    CloakAuction auction;
    CloakToken token;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address keeper = makeAddr("keeper");

    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LP_RESERVE = 1_000_000e18;
    uint256 constant MIN_PRICE = 0.0001 ether; // per whole token
    uint256 constant TICK = 0.0001 ether;

    function setUp() public {
        config = new CloakConfig(address(1), address(0));
        factory = new CloakFactory(config, new CloakVestingDeployer());
        for (uint256 i; i < 3; ++i) {
            vm.deal([alice, bob, carol][i], 10_000 ether);
        }
        _launch(5_000, 0, 1_000);
    }

    function _launch(uint16 lpBps, uint64 lpLockUntil, uint16 penaltyBps) internal {
        CloakAuction.Params memory p = CloakAuction.Params({
            creator: creator,
            saleSupply: SUPPLY,
            lpReserve: LP_RESERVE,
            minPrice: MIN_PRICE,
            tickSize: TICK,
            numTicks: 100,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: lpBps,
            noRevealPenaltyBps: penaltyBps,
            lpLockUntil: lpLockUntil,
            tlockRound: 0
        });
        (address a, address t) = factory.createLaunch("Cloak Test", "CLK", 100_000e18, 30 days, p, "ipfs://meta");
        auction = CloakAuction(payable(a));
        token = CloakToken(t);
    }

    function _commit(address who, uint16 tick, uint128 qty, uint256 deposit) internal returns (uint256 id, bytes32 salt) {
        salt = keccak256(abi.encode(who, tick, qty, deposit));
        bytes32 h = auction.commitmentOf(who, tick, qty, salt);
        vm.prank(who);
        id = auction.commit{value: deposit}(h, hex"c0ffee");
    }

    function _toReveal() internal {
        vm.warp(block.timestamp + 1 hours);
    }

    function _toSettle() internal {
        vm.warp(block.timestamp + 1 hours);
    }

    function test_factoryMintsSupply() public view {
        assertEq(token.balanceOf(address(auction)), SUPPLY + LP_RESERVE);
        assertEq(token.balanceOf(creator), 0); // the creator share vests
        (,,,,, address vesting) = factory.launches(0);
        assertEq(token.balanceOf(vesting), 100_000e18);
        assertEq(token.totalSupply(), SUPPLY + LP_RESERVE + 100_000e18);
        assertEq(factory.launchesCount(), 1);
    }

    function test_oversubscribed_uniformPrice_andProRata() public {
        // alice bids high, bob at the margin, carol at the margin; demand at tick 9 > remaining supply
        (uint256 a,) = _commit(alice, 19, 600_000e18, 2_000 ether); // price 0.002
        (uint256 b,) = _commit(bob, 9, 400_000e18, 1_000 ether); // price 0.001
        (uint256 c,) = _commit(carol, 9, 400_000e18, 1_000 ether);
        (uint256 d,) = _commit(carol, 2, 500_000e18, 1_000 ether); // below clearing, refunded

        _toReveal();
        CloakAuction.Reveal[] memory rs = new CloakAuction.Reveal[](4);
        rs[0] = CloakAuction.Reveal(a, 19, 600_000e18, keccak256(abi.encode(alice, uint16(19), uint128(600_000e18), uint256(2_000 ether))));
        rs[1] = CloakAuction.Reveal(b, 9, 400_000e18, keccak256(abi.encode(bob, uint16(9), uint128(400_000e18), uint256(1_000 ether))));
        rs[2] = CloakAuction.Reveal(c, 9, 400_000e18, keccak256(abi.encode(carol, uint16(9), uint128(400_000e18), uint256(1_000 ether))));
        rs[3] = CloakAuction.Reveal(d, 2, 500_000e18, keccak256(abi.encode(carol, uint16(2), uint128(500_000e18), uint256(1_000 ether))));
        vm.prank(keeper); // anyone can reveal
        assertEq(auction.revealBatch(rs), 4);

        _toSettle();
        auction.settle();
        assertEq(auction.clearingTick(), 9);
        uint256 price = auction.priceAt(9);
        assertEq(auction.clearingPrice(), price);
        assertEq(auction.sold(), SUPPLY);

        // alice: full fill, pays the clearing price — not her bid
        (uint256 ta, uint256 ra,) = auction.allocationOf(a);
        assertEq(ta, 600_000e18);
        assertEq(ra, 2_000 ether - (600_000 * price));
        // bob & carol split the remaining 400k pro rata
        (uint256 tb,,) = auction.allocationOf(b);
        (uint256 tc,,) = auction.allocationOf(c);
        assertEq(tb, 200_000e18);
        assertEq(tc, 200_000e18);
        // below clearing: full refund
        (uint256 td, uint256 rd,) = auction.allocationOf(d);
        assertEq(td, 0);
        assertEq(rd, 1_000 ether);

        uint256 aliceBefore = alice.balance;
        auction.claim(a);
        assertEq(token.balanceOf(alice), 600_000e18);
        assertEq(alice.balance - aliceBefore, ra);
    }

    function test_lpSeededAtClearingPrice_andBurned() public {
        (uint256 a, bytes32 s) = _commit(alice, 49, 1_000_000e18, 10_000 ether);
        _toReveal();
        auction.reveal(a, 49, 1_000_000e18, s);
        _toSettle();
        uint256 creatorBefore = creator.balance;
        auction.settle();

        CloakPair pair = auction.pair();
        assertTrue(address(pair) != address(0));
        uint256 price = auction.clearingPrice();
        // pool opens at the discovered price (to within rounding)
        assertApproxEqRel(pair.price(), price, 1e12);
        // lpLockUntil == 0 → LP shares burned
        assertEq(pair.sharesOf(address(auction)), 0);
        assertEq(pair.sharesOf(DEAD), pair.totalShares());
        // creator got the raise minus the LP half
        uint256 raised = auction.raised();
        auction.withdrawProceeds(); // pull payment
        assertApproxEqAbs(creator.balance - creatorBefore, raised - pair.reserveHype(), 1);
        assertApproxEqRel(pair.reserveHype(), raised / 2, 1e12);
    }

    function test_lpLockedThenReleased() public {
        _launch(5_000, uint64(block.timestamp + 30 days), 1_000);
        (uint256 a, bytes32 s) = _commit(alice, 10, 1_000_000e18, 10_000 ether);
        _toReveal();
        auction.reveal(a, 10, 1_000_000e18, s);
        _toSettle();
        auction.settle();
        CloakPair pair = auction.pair();
        uint256 shares = auction.lpShares();
        assertEq(pair.sharesOf(address(auction)), shares);

        vm.expectRevert("locked");
        auction.releaseLP();
        vm.warp(block.timestamp + 30 days);
        auction.releaseLP();
        assertEq(pair.sharesOf(creator), shares);
    }

    function test_undersubscribed_lowestRevealedTickSetsPrice_unsoldBurned() public {
        (uint256 a, bytes32 sa) = _commit(alice, 30, 100_000e18, 1_000 ether);
        (uint256 b, bytes32 sb) = _commit(bob, 5, 50_000e18, 1_000 ether);
        _toReveal();
        auction.reveal(a, 30, 100_000e18, sa);
        auction.reveal(b, 5, 50_000e18, sb);
        _toSettle();
        uint256 deadBefore = token.balanceOf(DEAD);
        auction.settle();
        assertEq(auction.clearingTick(), 5);
        assertEq(auction.sold(), 150_000e18);
        (uint256 ta,,) = auction.allocationOf(a);
        (uint256 tb,,) = auction.allocationOf(b);
        assertEq(ta, 100_000e18);
        assertEq(tb, 50_000e18);
        // unsold sale tokens + unused LP reserve are burned
        uint256 lpTokens = token.balanceOf(address(auction.pair()));
        assertEq(token.balanceOf(DEAD) - deadBefore, (SUPPLY - 150_000e18) + (LP_RESERVE - lpTokens));
    }

    function test_revealRejectsWrongPreimage_andOverBudget() public {
        (uint256 a, bytes32 s) = _commit(alice, 10, 1_000e18, 2 ether);
        // over budget: price(99)=0.01 * 1e6 tokens = 10_000 ether > 1 ether deposit
        bytes32 s2 = keccak256("x");
        vm.prank(bob);
        uint256 b = auction.commit{value: 1 ether}(auction.commitmentOf(bob, 99, 1_000_000e18, s2), "");
        _toReveal();
        vm.expectRevert("invalid reveal");
        auction.reveal(a, 11, 1_000e18, s); // wrong tick
        vm.expectRevert("invalid reveal");
        auction.reveal(b, 99, 1_000_000e18, s2); // can't afford it
        auction.reveal(a, 10, 1_000e18, s);
        vm.expectRevert("invalid reveal");
        auction.reveal(a, 10, 1_000e18, s); // double reveal
    }

    function test_phases() public {
        assertEq(auction.phase(), 0);
        vm.expectRevert("not reveal phase");
        auction.reveal(0, 0, 1, bytes32(0));
        vm.expectRevert("reveal open");
        auction.settle();
        _toReveal();
        assertEq(auction.phase(), 1);
        vm.prank(alice);
        vm.expectRevert("commit closed");
        auction.commit{value: 1 ether}(bytes32(0), "");
        _toSettle();
        assertEq(auction.phase(), 2);
    }

    function test_unrevealedBidPenalised() public {
        (uint256 a, bytes32 s) = _commit(alice, 10, 100_000e18, 200 ether);
        (uint256 b,) = _commit(bob, 10, 100_000e18, 200 ether); // never revealed
        _toReveal();
        auction.reveal(a, 10, 100_000e18, s);
        _toSettle();
        auction.settle();
        uint256 bobBefore = bob.balance;
        auction.claim(b);
        assertEq(bob.balance - bobBefore, 180 ether);
        assertEq(DEAD.balance, 20 ether);
    }

    function test_noDemand_fails_tokensReturned() public {
        _commit(alice, 10, 100_000e18, 100 ether); // never revealed
        _toReveal();
        _toSettle();
        auction.settle();
        assertTrue(auction.failed());
        assertEq(token.balanceOf(creator), SUPPLY + LP_RESERVE);
        uint256 before = alice.balance;
        auction.claim(0);
        assertEq(alice.balance - before, 100 ether); // no penalty when the launch fails
    }

    function test_orderingIrrelevant_everyonePaysSamePrice() public {
        // a "sniper" commits first with a huge priority fee; a human commits last. Same price either way.
        vm.txGasPrice(1000 gwei);
        (uint256 sniper, bytes32 s1) = _commit(alice, 20, 500_000e18, 5_000 ether);
        vm.txGasPrice(1 gwei);
        (uint256 human, bytes32 s2) = _commit(bob, 20, 500_000e18, 5_000 ether);
        _toReveal();
        auction.reveal(human, 20, 500_000e18, s2);
        auction.reveal(sniper, 20, 500_000e18, s1);
        _toSettle();
        auction.settle();
        (uint256 t1, uint256 r1,) = auction.allocationOf(sniper);
        (uint256 t2, uint256 r2,) = auction.allocationOf(human);
        assertEq(t1, t2);
        assertEq(r1, r2);
    }

    function test_solvency_allClaimsSucceed(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 25));
        uint256[] memory ids = new uint256[](n);
        uint16[] memory ticks = new uint16[](n);
        uint128[] memory qtys = new uint128[](n);
        bytes32[] memory salts = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            address who = address(uint160(uint256(keccak256(abi.encode(seed, i)))));
            ticks[i] = uint16(uint256(keccak256(abi.encode(seed, i, 1))) % 100);
            qtys[i] = uint128(uint256(keccak256(abi.encode(seed, i, 2))) % 200_000e18 + 1);
            uint256 cost = auction.costOf(ticks[i], qtys[i]);
            vm.deal(who, cost + 1);
            (ids[i], salts[i]) = _commit(who, ticks[i], qtys[i], cost + 1);
        }
        _toReveal();
        for (uint256 i; i < n; ++i) {
            auction.reveal(ids[i], ticks[i], qtys[i], salts[i]);
        }
        _toSettle();
        auction.settle();
        auction.claimBatch(ids);
        uint256 claimed;
        for (uint256 i; i < n; ++i) {
            claimed += token.balanceOf(auction.getBid(ids[i]).bidder);
        }
        assertLe(claimed, auction.sold());
    }

    function test_pairSwaps() public {
        (uint256 a, bytes32 s) = _commit(alice, 10, 1_000_000e18, 10_000 ether);
        _toReveal();
        auction.reveal(a, 10, 1_000_000e18, s);
        _toSettle();
        auction.settle();
        auction.claim(a);
        CloakPair pair = auction.pair();

        vm.prank(bob);
        uint256 out = pair.swapExactHypeForTokens{value: 1 ether}(0, bob);
        assertGt(out, 0);
        vm.startPrank(alice);
        token.approve(address(pair), 1_000e18);
        uint256 hypeOut = pair.swapExactTokensForHype(1_000e18, 0, alice);
        vm.stopPrank();
        assertGt(hypeOut, 0);
    }
}
