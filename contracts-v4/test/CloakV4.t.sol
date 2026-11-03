// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {CloakConfig} from "cloak/CloakConfig.sol";
import {CloakFactory} from "cloak/CloakFactory.sol";
import {CloakAuction, IMarketSeeder, IFeeLocker} from "cloak/CloakAuction.sol";
import {CloakToken} from "cloak/CloakToken.sol";
import {CloakVestingDeployer} from "cloak/CloakVesting.sol";
import {CloakV4Hook, ICloakLaunchFactory} from "../src/CloakV4Hook.sol";
import {CloakV4Market} from "../src/CloakV4Market.sol";

/// Swaps or adds liquidity on the PoolManager directly, the way the Universal Router or any other contract would.
contract Direct is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swapHypeIn(PoolKey memory key, uint256 amount) external payable returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(uint8(0), key, amount)), (uint256));
    }

    function addLiquidity(PoolKey memory key) external {
        pm.unlock(abi.encode(uint8(1), key, uint256(1e18)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 what, PoolKey memory key, uint256 amount) = abi.decode(data, (uint8, PoolKey, uint256));
        if (what == 1) {
            pm.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, int256(amount), 0), "");
            return "";
        }
        BalanceDelta d = pm.swap(key, SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "");
        pm.settle{value: uint256(uint128(-d.amount0()))}();
        uint256 out = uint256(uint128(d.amount1()));
        pm.take(key.currency1, address(this), out);
        return abi.encode(out);
    }

    receive() external payable {}
}

contract CloakV4Test is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 constant FLAGS = (1 << 13) | (1 << 11) | (1 << 9) | (1 << 7); // beforeInitialize, beforeAdd/RemoveLiquidity, beforeSwap

    PoolManager pm;
    CloakConfig config;
    CloakV4Hook hook;
    CloakFactory factory;
    CloakAuction auction;
    CloakToken token;
    CloakV4Market market;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address trader = makeAddr("trader");
    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant LP_RESERVE = 1_000_000e18;
    uint256 constant MIN_PRICE = 0.0001 ether;
    uint256 constant TICK = 0.0001 ether;

    function setUp() public {
        pm = new PoolManager(address(this));
        config = new CloakConfig(address(1), address(0));
        hook = _deployHook(3_000, 100_000, 300);
        factory = new CloakFactory(config, new CloakVestingDeployer(), IMarketSeeder(address(hook)), IFeeLocker(address(0)));
        hook.setFactory(ICloakLaunchFactory(address(factory)));
        vm.deal(alice, 10_000 ether);
        vm.deal(trader, 10_000 ether);
    }

    /// The hook must live at an address whose low 14 bits are exactly its permissions: mine a CREATE2 salt.
    function _deployHook(uint24 base, uint24 start, uint32 decay) internal returns (CloakV4Hook h) {
        bytes memory init = abi.encodePacked(type(CloakV4Hook).creationCode, abi.encode(address(pm), address(this), base, start, decay));
        bytes32 ih = keccak256(init);
        for (uint256 s; s < 500_000; ++s) {
            address a = vm.computeCreate2Address(bytes32(s), ih, address(this));
            if (uint160(a) & ((1 << 14) - 1) == FLAGS) {
                h = new CloakV4Hook{salt: bytes32(s)}(IPoolManager(address(pm)), address(this), base, start, decay);
                require(address(h) == a, "create2");
                return h;
            }
        }
        revert("no salt");
    }

    function _launch(uint64 lock) internal {
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
            lpLockUntil: lock,
            tlockRound: 0
        });
        (address a, address t) = factory.createLaunch("V4 Test", "VFOUR", 100_000e18, 30 days, p, "");
        auction = CloakAuction(payable(a));
        token = CloakToken(t);
    }

    /// alice takes the whole sale at tick 19: clearing price 0.002 HYPE.
    function _bidAndSettle() internal {
        bytes32 salt = keccak256("s");
        bytes32 h = auction.commitmentOf(alice, 19, uint128(SUPPLY), salt);
        vm.prank(alice);
        uint256 id = auction.commit{value: 3_000 ether}(h, "");
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,) = auction.params();
        vm.warp(commitEnd);
        auction.reveal(id, 19, uint128(SUPPLY), salt);
        vm.warp(revealEnd);
        auction.settle();
        market = CloakV4Market(payable(address(auction.pair())));
    }

    function _relErr(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return (d * 1e18) / b;
    }

    // ───────────── listing ─────────────

    function test_settlementOpensTheV4PoolAtTheClearingPrice() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        assertEq(auction.clearingPrice(), 0.002 ether);
        assertEq(auction.uniPair(), address(market), "the market stands in as the Uniswap pool");
        assertLt(_relErr(market.price(), 0.002 ether), 1e12, "the pool opens at the clearing price (within 1e-6)");
        (uint256 rH, uint256 rT,) = market.reserves();
        assertLt(_relErr((rH * 1e18) / rT, 0.002 ether), 1e12, "reserves match the price");
        assertGt(rH, 0);
        assertEq(market.sharesOf(address(hook)), market.totalShares(), "the hook owns all the liquidity");
        assertEq(hook.launchOf(address(token)).feeTo, creator, "fees go to the creator");
        assertEq(address(hook).balance, 0, "the hook keeps no HYPE");
        assertEq(token.balanceOf(address(hook)), 0, "or tokens");
    }

    function test_burnedLaunchSendsFeesToDead() public {
        _launch(0);
        _bidAndSettle();
        assertEq(hook.launchOf(address(token)).feeTo, DEAD);
    }

    function test_timedLocksAreRefused() public {
        vm.expectRevert(bytes("lock"));
        this.launchExt(uint64(block.timestamp + 30 days));
        assertFalse(factory.timedLocks());
    }

    function launchExt(uint64 lock) external {
        _launch(lock);
    }

    // ───────────── nobody else touches the pool ─────────────

    function test_onlyTheFactorysAuctionsCanSeed() public {
        _launch(type(uint64).max);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(bytes("not a launch"));
        hook.seed{value: 1 ether}(address(token), 1e18, 0.002 ether, DEAD);
    }

    function test_nobodyElseCanInitializeOrAddLiquidity() public {
        _launch(type(uint64).max);
        PoolKey memory key = hook.keyFor(address(token));
        uint160 sp = hook.sqrtPriceFor(0.001 ether);
        vm.expectRevert(); // the hook refuses anyone but itself
        pm.initialize(key, sp);
        _bidAndSettle();
        Direct d = new Direct(IPoolManager(address(pm)));
        vm.expectRevert();
        d.addLiquidity(key);
    }

    function test_adminIsWhoTheDeployerNames() public {
        // deployed through a CREATE2 factory, the admin must still be the named one, not the factory
        assertEq(hook.deployer(), address(this));
    }

    function test_hookCanOnlyBeSetUpOnce() public {
        vm.expectRevert(bytes("factory"));
        hook.setFactory(ICloakLaunchFactory(address(1)));
        vm.prank(alice);
        vm.expectRevert(bytes("factory"));
        hook.setFactory(ICloakLaunchFactory(address(1)));
    }

    // ───────────── fees ─────────────

    function test_antiSnipeFeeFallsToTheBase() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        uint256 t0 = hook.launchOf(address(token)).listedAt;
        assertEq(market.feePips(), 100_000, "10% at listing");
        vm.warp(t0 + 150);
        assertEq(market.feePips(), 51_500, "halfway");
        vm.warp(t0 + 300);
        assertEq(market.feePips(), 3_000, "0.3% after five minutes");
        vm.warp(t0 + 365 days);
        assertEq(market.feePips(), 3_000);
    }

    function test_snipingAtListingCostsTheSniper() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        uint256 snap = vm.snapshotState();
        vm.prank(trader);
        uint256 early = market.swapExactHypeForTokens{value: 1 ether}(0, trader);
        vm.revertToState(snap);
        vm.warp(block.timestamp + 300);
        vm.prank(trader);
        uint256 later = market.swapExactHypeForTokens{value: 1 ether}(0, trader);
        assertLt(early * 100, later * 91, "buying at listing gives over 9% less");
    }

    function test_creatorCollectsTradingFees() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        vm.warp(block.timestamp + 300);
        vm.startPrank(trader);
        uint256 got = market.swapExactHypeForTokens{value: 10 ether}(0, trader);
        token.approve(address(market), got);
        market.swapExactTokensForHype(got, 0, trader);
        vm.stopPrank();
        uint256 h0 = creator.balance;
        uint256 t0 = token.balanceOf(creator);
        (uint256 fh, uint256 ft) = hook.collectFees(address(token));
        assertApproxEqRel(fh, 0.03 ether, 0.01e18, "0.3% of the 10 HYPE buy");
        assertGt(ft, 0, "and of the sell, in tokens");
        assertEq(creator.balance - h0, fh);
        assertEq(token.balanceOf(creator) - t0, ft);
        (fh, ft) = hook.collectFees(address(token));
        assertEq(fh + ft, 0, "nothing twice");
    }

    // ───────────── trading through the adapter ─────────────

    function test_swapsMatchTheQuotes() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        vm.warp(block.timestamp + 300);
        (uint256 rH, uint256 rT,) = market.reserves();
        uint256 q = market.getAmountOut(5 ether, rH, rT);
        vm.prank(trader);
        uint256 out = market.swapExactHypeForTokens{value: 5 ether}(q * 9_999 / 10_000, trader);
        assertLt(_relErr(out, q), 1e14, "buy within 0.01% of the quote");
        (rH, rT,) = market.reserves();
        uint256 qs = market.getAmountOut(out, rT, rH);
        uint256 before = trader.balance;
        vm.startPrank(trader);
        token.approve(address(market), out);
        uint256 back = market.swapExactTokensForHype(out, qs * 9_999 / 10_000, trader);
        vm.stopPrank();
        assertLt(_relErr(back, qs), 1e14, "sell within 0.01% of the quote");
        assertEq(trader.balance - before, back, "HYPE arrives natively");
        assertLt(back, 5 ether, "a round trip costs the fees");
    }

    function test_slippageIsEnforced() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        vm.warp(block.timestamp + 300);
        (uint256 rH, uint256 rT,) = market.reserves();
        uint256 q = market.getAmountOut(1 ether, rH, rT);
        vm.prank(trader);
        vm.expectRevert(bytes("slippage"));
        market.swapExactHypeForTokens{value: 1 ether}(q * 2, trader);
    }

    function test_directSwapsOnThePoolManagerWorkAndPayTheFee() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        vm.warp(block.timestamp + 300);
        Direct d = new Direct(IPoolManager(address(pm)));
        vm.deal(address(d), 2 ether);
        uint256 out = d.swapHypeIn(hook.keyFor(address(token)), 1 ether);
        assertGt(out, 0, "the Universal Router path (a direct PoolManager swap) works");
        (uint256 fh,) = hook.collectFees(address(token));
        assertApproxEqRel(fh, 0.003 ether, 0.01e18, "and pays the creator's fee");
    }

    // ───────────── time-weighted price ─────────────

    function test_twapFollowsThePriceAndOneSwapCantMoveIt() public {
        _launch(type(uint64).max);
        _bidAndSettle();
        (uint256 c0, uint64 t0) = market.cumulativeNow();
        vm.warp(block.timestamp + 600);
        (uint256 c1, uint64 t1) = market.cumulativeNow();
        uint256 twap = (c1 - c0) / (t1 - t0);
        assertLt(_relErr(twap, 0.002 ether), 1e12, "flat price: the TWAP is the price");
        // a big buy moves the spot price, but not the TWAP of the time before it
        vm.prank(trader);
        market.swapExactHypeForTokens{value: 500 ether}(0, trader);
        (uint256 c2, uint64 t2) = market.cumulativeNow();
        assertEq(t2, t1);
        assertEq(c2, c1, "the accumulator only counts time");
        assertGt(market.price(), 0.0025 ether, "the spot moved");
    }

    // ───────────── fuzz: any clearing price lists at that price ─────────────

    function testFuzz_listsAtAnyClearingPrice(uint8 tick, uint96 lpPct) public {
        uint256 t = bound(tick, 0, 99);
        uint16 lpBps = uint16(bound(lpPct, 500, 10_000));
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
            noRevealPenaltyBps: 1_000,
            lpLockUntil: type(uint64).max,
            tlockRound: 0
        });
        (address a, address tk) = factory.createLaunch("Fuzz", "FZ", 0, 30 days, p, "");
        auction = CloakAuction(payable(a));
        token = CloakToken(tk);
        bytes32 salt = keccak256(abi.encode(t, lpBps));
        uint256 cost = ((MIN_PRICE + t * TICK) * SUPPLY) / 1e18 + 1 ether;
        bytes32 h = auction.commitmentOf(alice, uint16(t), uint128(SUPPLY), salt);
        vm.deal(alice, cost);
        vm.prank(alice);
        uint256 id = auction.commit{value: cost}(h, "");
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,) = auction.params();
        vm.warp(commitEnd);
        auction.reveal(id, uint16(t), uint128(SUPPLY), salt);
        vm.warp(revealEnd);
        auction.settle();
        market = CloakV4Market(payable(address(auction.pair())));
        assertLt(_relErr(market.price(), MIN_PRICE + t * TICK), 1e12, "lists at the clearing price");
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }
}
