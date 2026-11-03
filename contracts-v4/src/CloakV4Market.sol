// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IHookView {
    function keyFor(address token) external view returns (PoolKey memory);
    function currentFee(address token) external view returns (uint24);
    function cumulativeNow(address token) external view returns (uint256 cum, uint64 at);
    function lastSwapAt(address token) external view returns (uint64);
}

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title CloakV4Market — a launch's Uniswap v4 pool, seen the way Cloak's contracts see a market.
/// @notice The same interface as CloakPair and CloakV2Market (native HYPE in and out, reserves, a time-weighted price),
///         so the private router, the sealed batcher, the SDK and the app trade a v4 launch exactly like the others.
///         The pool's only liquidity is the launch's full-range position (the hook allows no other), so the reserves
///         read here are the pool's real depth. Holds nothing between calls; anyone may use it. The token also trades
///         directly on the PoolManager (Universal Router, aggregators) like any v4 pool.
contract CloakV4Market is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 1 << 96;

    IPoolManager public immutable poolManager;
    IHookView public immutable hook;
    address public immutable token;
    PoolId public immutable poolId;

    uint256 private _lock = 1;

    event Swap(address indexed trader, bool hypeIn, uint256 amountIn, uint256 amountOut, address indexed to);

    modifier lock() {
        require(_lock == 1, "locked");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IPoolManager poolManager_, IHookView hook_, address token_) {
        poolManager = poolManager_;
        hook = hook_;
        token = token_;
        poolId = hook_.keyFor(token_).toId();
    }

    function key() public view returns (PoolKey memory) {
        return hook.keyFor(token);
    }

    // ───────────────────────────── reads (CloakPair's interface) ─────────────────────────────

    /// @notice The pool's depth as constant-product reserves (exact: its only liquidity is one full-range position).
    function reserves() public view returns (uint256 rHype, uint256 rToken, uint32 last) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolId);
        uint128 l = poolManager.getLiquidity(poolId);
        if (sqrtP != 0) {
            rHype = FullMath.mulDiv(l, Q96, sqrtP);
            rToken = FullMath.mulDiv(l, sqrtP, Q96);
        }
        last = uint32(hook.lastSwapAt(token));
    }

    function reserveHype() external view returns (uint256 r) {
        (r,,) = reserves();
    }

    function reserveToken() external view returns (uint256 r) {
        (, r,) = reserves();
    }

    /// @notice Spot price: wei of HYPE per 1e18 token units.
    function price() external view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolId);
        if (sqrtP == 0) return 0;
        return FullMath.mulDiv(FullMath.mulDiv(1e18, Q96, sqrtP), Q96, sqrtP);
    }

    function lastUpdate() external view returns (uint64) {
        return hook.lastSwapAt(token);
    }

    /// @notice Σ (wei of HYPE per 1e18 tokens) × seconds, as of now. Two readings' difference over their time gap is a
    ///         price one transaction cannot move.
    function cumulativeNow() external view returns (uint256 cum, uint64 at) {
        return hook.cumulativeNow(token);
    }

    /// @notice The fee a swap pays now, in pips (1e6 = 100%); it starts high at listing and settles at the base fee.
    function feePips() public view returns (uint24) {
        return hook.currentFee(token);
    }

    /// @notice The fee as CloakPair states it: numerator out of 1000 the pool keeps of the input (rounded in the pool's favour).
    function feeNum() external view returns (uint256) {
        return 1000 - (uint256(feePips()) + 999) / 1000;
    }

    /// @notice Output for `amountIn` against reserves (rIn, rOut) at the current fee.
    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public view returns (uint256) {
        uint256 inWithFee = amountIn * (1e6 - uint256(feePips()));
        return (inWithFee * rOut) / (rIn * 1e6 + inWithFee);
    }

    /// @notice Liquidity `a` owns: all of it belongs to the hook, forever.
    function sharesOf(address a) external view returns (uint256) {
        return a == address(hook) ? poolManager.getLiquidity(poolId) : 0;
    }

    function totalShares() external view returns (uint256) {
        return poolManager.getLiquidity(poolId);
    }

    // ───────────────────────────── swaps ─────────────────────────────

    /// @notice Native HYPE in, tokens out to `to`.
    function swapExactHypeForTokens(uint256 minOut, address to) external payable lock returns (uint256 out) {
        require(msg.value > 0, "zero");
        out = abi.decode(poolManager.unlock(abi.encode(true, msg.value, msg.sender, to)), (uint256));
        require(out >= minOut && out > 0, "slippage");
        emit Swap(msg.sender, true, msg.value, out, to);
    }

    /// @notice Tokens in (pulled from the caller), native HYPE out to `to`.
    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external lock returns (uint256 out) {
        require(amountIn > 0, "zero");
        out = abi.decode(poolManager.unlock(abi.encode(false, amountIn, msg.sender, to)), (uint256));
        require(out >= minOut && out > 0, "slippage");
        emit Swap(msg.sender, false, amountIn, out, to);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager) && _lock == 2, "pool manager");
        (bool hypeIn, uint256 amountIn, address payer, address to) = abi.decode(data, (bool, uint256, address, address));
        PoolKey memory k = key();
        BalanceDelta d = poolManager.swap(
            k,
            SwapParams({zeroForOne: hypeIn, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: hypeIn ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}),
            ""
        );
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        uint256 out;
        if (hypeIn) {
            uint256 paid = uint256(uint128(-a0));
            out = uint256(uint128(a1));
            poolManager.settle{value: paid}();
            poolManager.take(k.currency1, to, out);
            if (paid < amountIn) {
                (bool ok,) = payer.call{value: amountIn - paid}(""); // only if the price limit stopped the swap early
                require(ok, "refund");
            }
        } else {
            uint256 paid = uint256(uint128(-a1));
            out = uint256(uint128(a0));
            poolManager.sync(k.currency1);
            require(IERC20Pull(token).transferFrom(payer, address(poolManager), paid), "tf");
            poolManager.settle();
            poolManager.take(k.currency0, to, out);
        }
        return abi.encode(out);
    }

    /// @notice v4 liquidity is a position, not a token: it stays with the hook forever.
    function transferShares(address, uint256) external pure {
        revert("v4 liquidity is locked forever");
    }
}
