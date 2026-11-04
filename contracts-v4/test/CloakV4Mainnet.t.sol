// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {CloakConfig} from "cloak/CloakConfig.sol";
import {CloakFactory} from "cloak/CloakFactory.sol";
import {CloakAuction, IMarketSeeder, IFeeLocker} from "cloak/CloakAuction.sol";
import {CloakToken} from "cloak/CloakToken.sol";
import {CloakVestingDeployer} from "cloak/CloakVesting.sol";
import {CloakV4Hook, ICloakLaunchFactory} from "../src/CloakV4Hook.sol";
import {CloakV4Market} from "../src/CloakV4Market.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params) external returns (uint256 amountOut, uint256 gasEstimate);
}

interface IStateView {
    function getSlot0(PoolId poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(PoolId poolId) external view returns (uint128);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

/// A Cloak v4 launch against the REAL Uniswap v4 contracts on Elysium mainnet (chain 99901), on a fork:
/// the official PoolManager, Universal Router, V4 Quoter, StateView, PositionManager and Permit2. Proves the hook works
/// on Uniswap's own deployment, that Uniswap's router and quoter trade and price a Cloak pool (so wallets and aggregators
/// can), and that Uniswap's PositionManager can't add liquidity to it.
///   MAINNET_RPC=https://rpc-live.elysp.com forge test --match-contract CloakV4Mainnet -vv
/// Skipped when MAINNET_RPC isn't set.
contract CloakV4MainnetTest is Test {
    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    IUniversalRouter constant ROUTER = IUniversalRouter(0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a);
    IV4Quoter constant QUOTER = IV4Quoter(0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5);
    IStateView constant STATE = IStateView(0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE);
    IPositionManager constant POSM = IPositionManager(0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518);
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint160 constant FLAGS = (1 << 13) | (1 << 11) | (1 << 9) | (1 << 7);

    // Universal Router command and v4 router actions (v4-periphery Actions.sol, universal-router Commands.sol)
    uint8 constant V4_SWAP = 0x10;
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    bool live;
    CloakConfig config;
    CloakV4Hook hook;
    CloakFactory factory;
    CloakAuction auction;
    CloakToken token;
    CloakV4Market market;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address trader = makeAddr("trader");

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 99901, "not Elysium mainnet");
        live = true;
        config = new CloakConfig(address(1), address(0));
        bytes memory init = abi.encodePacked(type(CloakV4Hook).creationCode, abi.encode(address(PM), address(this), uint24(3_000), uint24(100_000), uint32(300)));
        bytes32 ih = keccak256(init);
        for (uint256 s; s < 500_000; ++s) {
            address a = vm.computeCreate2Address(bytes32(s), ih, address(this));
            if (uint160(a) & ((1 << 14) - 1) == FLAGS) {
                hook = new CloakV4Hook{salt: bytes32(s)}(PM, address(this), 3_000, 100_000, 300);
                break;
            }
        }
        factory = new CloakFactory(config, new CloakVestingDeployer(), IMarketSeeder(address(hook)), IFeeLocker(address(0)));
        hook.setFactory(ICloakLaunchFactory(address(factory)));
        vm.deal(alice, 10_000 ether);
        vm.deal(trader, 10_000 ether);

        CloakAuction.Params memory p = CloakAuction.Params({
            creator: creator,
            saleSupply: 1_000_000e18,
            lpReserve: 1_000_000e18,
            minPrice: 0.0001 ether,
            tickSize: 0.0001 ether,
            numTicks: 100,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: 5_000,
            noRevealPenaltyBps: 1_000,
            lpLockUntil: type(uint64).max,
            tlockRound: 0
        });
        (address a2, address t) = factory.createLaunch("Mainnet Fork", "MFORK", 100_000e18, 30 days, p, "");
        auction = CloakAuction(payable(a2));
        token = CloakToken(t);
        bytes32 salt = keccak256("s");
        bytes32 h = auction.commitmentOf(alice, 19, uint128(1_000_000e18), salt);
        vm.prank(alice);
        uint256 id = auction.commit{value: 3_000 ether}(h, "");
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,) = auction.params();
        vm.warp(commitEnd);
        auction.reveal(id, 19, uint128(1_000_000e18), salt);
        vm.warp(revealEnd);
        auction.settle();
        market = CloakV4Market(payable(address(auction.pair())));
        vm.warp(uint256(revealEnd) + 600); // past the anti-snipe window: the base 0.3% fee
    }

    function _swap(bool hypeIn, uint128 amountIn, uint128 minOut) internal {
        PoolKey memory key = hook.keyFor(address(token));
        Currency cin = hypeIn ? key.currency0 : key.currency1;
        Currency cout = hypeIn ? key.currency1 : key.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, hypeIn, amountIn, minOut, ""));
        params[1] = abi.encode(cin, uint256(amountIn));
        params[2] = abi.encode(cout, uint256(minOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        ROUTER.execute{value: hypeIn ? amountIn : 0}(abi.encodePacked(V4_SWAP), inputs, type(uint256).max);
    }

    function test_cloakPoolLivesOnUniswapsPoolManager() public {
        if (!live) return;
        assertEq(address(hook.poolManager()), address(PM));
        PoolId id = hook.poolIdOf(address(token));
        (uint160 sp,,, ) = STATE.getSlot0(id);
        assertEq(sp, hook.sqrtPriceFor(auction.clearingPrice()), "Uniswap's StateView sees the pool at the clearing price");
        assertGt(STATE.getLiquidity(id), 0, "and its liquidity");
    }

    function test_uniswapsQuoterPricesTheCloakPoolLikeTheMarket() public {
        if (!live) return;
        (uint256 q,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(hook.keyFor(address(token)), true, 1 ether, ""));
        (uint256 rH, uint256 rT,) = market.reserves();
        uint256 m = market.getAmountOut(1 ether, rH, rT);
        assertApproxEqRel(q, m, 1e14, "Uniswap's quote matches Cloak's (within 0.01%)");
    }

    function test_uniswapsUniversalRouterBuysAndSells() public {
        if (!live) return;
        (uint256 q,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(hook.keyFor(address(token)), true, 1 ether, ""));
        vm.startPrank(trader);
        _swap(true, 1 ether, uint128(q));
        uint256 got = token.balanceOf(trader);
        assertEq(got, q, "the router's buy pays exactly the quote");
        token.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(token), address(ROUTER), uint160(got), type(uint48).max);
        uint256 before = trader.balance;
        _swap(false, uint128(got), 0);
        vm.stopPrank();
        assertEq(token.balanceOf(trader), 0);
        assertGt(trader.balance - before, 0.99 ether * 994 / 1000, "the sell returns the HYPE less two 0.3% fees");
        (uint256 fh, uint256 ft) = hook.collectFees(address(token));
        assertGt(fh + ft, 0, "router trades pay the creator fee");
        assertGt(creator.balance + token.balanceOf(creator), 0);
    }

    function test_uniswapsPositionManagerCantAddLiquidity() public {
        if (!live) return;
        PoolKey memory key = hook.keyFor(address(token));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, int24(-887220), int24(887220), uint256(1e18), uint128(10 ether), uint128(10_000e18), trader, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        vm.prank(trader);
        vm.expectRevert();
        POSM.modifyLiquidities{value: 10 ether}(abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), type(uint256).max);
    }

    function test_cloakMarketStillTradesOnMainnet() public {
        if (!live) return;
        vm.prank(trader);
        uint256 out = market.swapExactHypeForTokens{value: 1 ether}(0, trader);
        assertGt(out, 0);
        vm.startPrank(trader);
        token.approve(address(market), out);
        uint256 back = market.swapExactTokensForHype(out, 0, trader);
        vm.stopPrank();
        assertGt(back, 0.99 ether * 994 / 1000);
    }
}
