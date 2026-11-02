// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakPair} from "../src/CloakPair.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer, CloakVesting} from "../src/CloakVesting.sol";
import {CloakSeeder} from "../src/CloakSeeder.sol";
import {CloakV2Market} from "../src/CloakV2Market.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "../src/uniswap/IUniswapV2.sol";

/// Launches that open a real Uniswap V2 pool: run against a fork of Elysium testnet, with the Uniswap V2 factory and
/// the WHYPE its pools use. `forge test --match-contract UniswapLaunch` (needs the testnet RPC).
contract UniswapLaunchTest is Test {
    IUniswapV2Factory constant UNI = IUniswapV2Factory(0xb2F8ad730e9D05d333C7861184AAD0bFF1785dd0);
    IWETH constant WHYPE = IWETH(0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    CloakConfig config;
    CloakSeeder seeder;
    CloakFactory factory;
    CloakAuction auction;
    CloakToken token;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address trader = makeAddr("trader");

    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LP_RESERVE = 1_000_000e18;
    uint256 constant MIN_PRICE = 0.0001 ether;
    uint256 constant TICK = 0.0001 ether;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RPC_URL", string("https://testnet-rpc.elysium.kinetiq.xyz")));
        config = new CloakConfig(address(1), address(0));
        seeder = new CloakSeeder(UNI, WHYPE, 997);
        factory = new CloakFactory(config, new CloakVestingDeployer(), seeder);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(trader, 10_000 ether);
    }

    function _launch(uint64 lpLockUntil) internal {
        CloakAuction.Params memory p = CloakAuction.Params({
            creator: creator,
            saleSupply: SUPPLY,
            lpReserve: LP_RESERVE,
            minPrice: MIN_PRICE,
            tickSize: TICK,
            numTicks: 100,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: 5_000,
            noRevealPenaltyBps: 1_000,
            lpLockUntil: lpLockUntil,
            tlockRound: 0
        });
        (address a, address t) = factory.createLaunch("Uni Test", "UNIT", 100_000e18, 30 days, p, "");
        auction = CloakAuction(payable(a));
        token = CloakToken(t);
    }

    /// alice takes the whole sale at tick 19 (0.002 HYPE): clearing price 0.002.
    function _bidAndClose() internal {
        bytes32 salt = keccak256("s");
        bytes32 h = auction.commitmentOf(alice, 19, uint128(SUPPLY), salt);
        vm.prank(alice);
        uint256 id = auction.commit{value: 3_000 ether}(h, "");
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,) = auction.params();
        vm.warp(commitEnd);
        auction.reveal(id, 19, uint128(SUPPLY), salt);
        vm.warp(revealEnd); // absolute times: with via-ir, block.timestamp can be cached within a function
    }

    function _pool() internal view returns (IUniswapV2Pair) {
        return IUniswapV2Pair(UNI.getPair(address(token), address(WHYPE)));
    }

    function _poolPrice(IUniswapV2Pair p) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = p.getReserves();
        return p.token0() == address(token) ? (uint256(r1) * 1e18) / r0 : (uint256(r0) * 1e18) / r1;
    }

    function _assertOpensAtClearing() internal view {
        IUniswapV2Pair p = _pool();
        assertEq(auction.uniPair(), address(p), "uniPair");
        assertTrue(address(p) != address(0));
        uint256 price = auction.clearingPrice();
        assertApproxEqRel(_poolPrice(p), price, 1e12, "opens at clearing price"); // 0.0001%
        CloakV2Market m = CloakV2Market(payable(address(auction.pair())));
        assertEq(address(m.uniPair()), address(p));
        assertEq(m.token(), address(token));
        assertApproxEqRel(m.price(), price, 1e12);
    }

    // ───────────────────────────── the normal path ─────────────────────────────

    function test_settleOpensUniswapPool_LPBurned() public {
        _launch(0);
        _bidAndClose();
        uint256 g = gasleft();
        auction.settle();
        emit log_named_uint("settle gas", g - gasleft());
        _assertOpensAtClearing();
        IUniswapV2Pair p = _pool();
        // LP burned: all of it at 0x…dEaD except Uniswap's own 1000 at address(0)
        assertEq(p.balanceOf(DEAD), auction.lpShares());
        assertEq(p.totalSupply(), auction.lpShares() + 1000);
        // budget accounting: the pool got (lpHype, lpTokens); the rest of the raise is the creator's
        (uint112 r0, uint112 r1,) = p.getReserves();
        (uint256 rH, uint256 rT) = p.token0() == address(token) ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 net = auction.raised() - auction.feesOwed();
        assertEq(auction.creatorOwed() + rH, net, "HYPE accounted");
        assertLe(rT, LP_RESERVE);
        assertEq(token.balanceOf(address(seeder)), 0, "seeder holds nothing");
        assertEq(address(seeder).balance, 0);
        // everything owed can still be paid
        auction.claim(0);
        auction.withdrawProceeds();
        assertEq(token.balanceOf(alice), SUPPLY);
    }

    function test_lockedLP_releasesUniswapLP() public {
        _launch(uint64(block.timestamp + 10 days));
        _bidAndClose();
        auction.settle();
        IUniswapV2Pair p = _pool();
        assertEq(p.balanceOf(address(auction)), auction.lpShares());
        vm.expectRevert("locked");
        auction.releaseLP();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        auction.releaseLP();
        assertEq(p.balanceOf(creator), auction.lpShares());
        assertEq(p.balanceOf(address(auction)), 0);
    }

    // ───────────────────────────── trading through the adapter ─────────────────────────────

    function test_adapterSwapsBothWays_matchQuotes() public {
        _launch(0);
        _bidAndClose();
        auction.settle();
        CloakV2Market m = CloakV2Market(payable(address(auction.pair())));
        // buy
        uint256 quote = m.getAmountOut(1 ether, m.reserveHype(), m.reserveToken());
        vm.prank(trader);
        uint256 out = m.swapExactHypeForTokens{value: 1 ether}(quote, trader);
        assertEq(out, quote);
        assertEq(token.balanceOf(trader), quote);
        // the fee (997) matches this factory's pools: straight on the pool, the quote passes its K check, one wei more fails
        IUniswapV2Pair p = _pool();
        bool t0 = p.token0() == address(token);
        uint256 q = m.getAmountOut(1 ether, m.reserveHype(), m.reserveToken());
        vm.startPrank(trader);
        WHYPE.deposit{value: 2 ether}();
        WHYPE.transfer(address(p), 1 ether);
        vm.expectRevert();
        p.swap(t0 ? q + 1 : 0, t0 ? 0 : q + 1, trader, "");
        p.swap(t0 ? q : 0, t0 ? 0 : q, trader, "");
        vm.stopPrank();
        out += q;
        // sell
        uint256 sell = out / 2;
        uint256 q2 = m.getAmountOut(sell, m.reserveToken(), m.reserveHype());
        uint256 before = trader.balance;
        vm.startPrank(trader);
        token.approve(address(m), sell);
        m.swapExactTokensForHype(sell, q2, trader);
        vm.stopPrank();
        assertEq(trader.balance - before, q2);
        assertEq(address(m).balance, 0);
        assertEq(token.balanceOf(address(m)), 0);
        assertEq(WHYPE.balanceOf(address(m)), 0, "adapter holds nothing");
    }

    function test_quotesMatchDirectPoolMath() public {
        // the adapter's quote equals Uniswap's own formula on the pool's reserves (what wallets and aggregators quote)
        _launch(0);
        _bidAndClose();
        auction.settle();
        CloakV2Market m = CloakV2Market(payable(address(auction.pair())));
        uint256 amt = 0.37 ether;
        uint256 rIn = m.reserveHype();
        uint256 rOut = m.reserveToken();
        uint256 expect = (amt * 997 * rOut) / (rIn * 1000 + amt * 997);
        assertEq(m.getAmountOut(amt, rIn, rOut), expect);
    }

    function test_twapFollowsPrice() public {
        _launch(0);
        _bidAndClose();
        auction.settle();
        CloakV2Market m = CloakV2Market(payable(address(auction.pair())));
        (uint256 c0, uint64 t0) = m.cumulativeNow();
        uint256 p0 = m.price();
        vm.warp(vm.getBlockTimestamp() + 100);
        (uint256 c1, uint64 t1) = m.cumulativeNow();
        assertApproxEqRel((c1 - c0) / (t1 - t0), p0, 1e12, "flat price over time");
        // a buy moves spot; the average over the window only moves by its share of the time
        vm.prank(trader);
        m.swapExactHypeForTokens{value: 50 ether}(0, trader);
        uint256 p1 = m.price();
        assertGt(p1, p0);
        vm.warp(vm.getBlockTimestamp() + 100);
        (uint256 c2, uint64 t2) = m.cumulativeNow();
        uint256 avg = (c2 - c0) / (t2 - t0);
        assertGt(avg, p0);
        assertLt(avg, p1);
        assertApproxEqRel(avg, (p0 + p1) / 2, 1e15);
    }

    // ───────────────────────────── opening at the right price, whatever was sent first ─────────────────────────────

    function test_preCreatedPoolWithWhypeSynced_stillOpensAtClearing() public {
        _launch(0);
        // someone creates the pool early, sends it WHYPE and syncs, to make the launch open at a silly price
        address p = UNI.createPair(address(token), address(WHYPE));
        vm.startPrank(trader);
        WHYPE.deposit{value: 5 ether}();
        WHYPE.transfer(p, 5 ether);
        vm.stopPrank();
        (bool ok,) = p.call(abi.encodeWithSignature("sync()"));
        assertTrue(ok);
        _bidAndClose();
        auction.settle();
        _assertOpensAtClearing(); // the donation is part of the pool now; the launch tops up tokens to match
    }

    function test_donationsToPoolAddressBeforeItExists_skimmed() public {
        _launch(0);
        _bidAndClose();
        // the creator's first vested tokens and some WHYPE, sent to where the pool will be (CREATE2 address)
        (,,,,, address vest) = factory.launches(0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(creator);
        CloakVesting(vest).release();
        uint256 vested = token.balanceOf(creator);
        assertGt(vested, 0);
        address p = UNI.createPair(address(token), address(WHYPE)); // created by anyone, unsynced donations below
        vm.prank(creator);
        token.transfer(p, vested);
        vm.startPrank(trader);
        WHYPE.deposit{value: 1 ether}();
        WHYPE.transfer(p, 1 ether);
        vm.stopPrank();
        auction.settle();
        _assertOpensAtClearing();
        assertEq(token.balanceOf(DEAD) > 0, true);
    }

    function test_vestedTokensSyncedLow_cantOpenCheap() public {
        // the creator dumps vested tokens into the pool and syncs, hoping the launch opens below the clearing price so
        // they can buy the pool's HYPE cheap: the launch adds HYPE to match instead
        _launch(0);
        _bidAndClose();
        (,,,,, address vest) = factory.launches(0);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(creator);
        CloakVesting(vest).release();
        address p = UNI.createPair(address(token), address(WHYPE));
        uint256 vested = token.balanceOf(creator);
        vm.prank(creator);
        token.transfer(p, vested);
        (bool ok,) = p.call(abi.encodeWithSignature("sync()"));
        assertTrue(ok);
        auction.settle();
        _assertOpensAtClearing();
    }

    function test_poolWithSomeoneElsesLP_fallsBackToCloakPair() public {
        // a pool someone already minted LP in (needs launch tokens before settlement) is never used: its price is theirs
        _launch(0);
        _bidAndClose();
        (,,,,, address vest) = factory.launches(0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(creator);
        CloakVesting(vest).release();
        address p = UNI.createPair(address(token), address(WHYPE));
        vm.startPrank(creator);
        token.transfer(p, token.balanceOf(creator));
        vm.deal(creator, 1 ether);
        WHYPE.deposit{value: 1 ether}();
        WHYPE.transfer(p, 1 ether);
        IUniswapV2Pair(p).mint(creator);
        vm.stopPrank();
        auction.settle();
        assertEq(auction.uniPair(), address(0));
        CloakPair cp = auction.pair();
        assertEq(cp.token(), address(token));
        assertApproxEqRel(cp.price(), auction.clearingPrice(), 1e12);
        assertEq(cp.sharesOf(DEAD), auction.lpShares() + cp.MIN_LIQUIDITY());
    }

    function test_tooLittleGas_revertsInsteadOfFallingBack() public {
        _launch(0);
        _bidAndClose();
        // a settler can't force the CloakPair fallback by starving the Uniswap attempt
        (bool ok,) = address(auction).call{gas: 5_000_000}(abi.encodeWithSelector(CloakAuction.settle.selector));
        assertFalse(ok);
        assertFalse(auction.settled());
        auction.settle();
        assertTrue(auction.uniPair() != address(0));
    }

    function test_seederOnlyTakesSelfCalls() public {
        vm.expectRevert(bytes("self"));
        seeder.seedV2(address(1), 1, 1, address(this));
    }
}
