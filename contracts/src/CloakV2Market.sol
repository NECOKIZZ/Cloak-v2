// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Pair, IWETH} from "./uniswap/IUniswapV2.sol";

interface IERC20Market {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title CloakV2Market — a launch's Uniswap V2 pool, seen the way Cloak's contracts see a market.
/// @notice A launch from the Uniswap factory seeds a standard Uniswap V2 pool (token / WHYPE), so the token trades on
///         Uniswap, aggregators and trackers like any other. This adapter gives that pool the same interface as
///         CloakPair (native HYPE in and out, reserves, a time-weighted price), so the private router, the sealed
///         batcher, the SDK and the app trade it exactly as they trade a CloakPair. The liquidity sits in the
///         Uniswap pool; this contract holds nothing between calls and anyone may use it.
/// @dev The time-weighted price comes from the pool's own price accumulator (UQ112x112), converted to CloakPair's units
///      (wei of HYPE per 1e18 token units, × seconds).
contract CloakV2Market {
    IUniswapV2Pair public immutable uniPair;
    address public immutable token;
    IWETH public immutable weth;
    /// @notice Fee numerator out of 1000 the pool charges on input (997 = Uniswap V2's 0.3%).
    uint256 public immutable feeNum;
    bool internal immutable tokenIs0;

    uint256 private _lock = 1;

    event Swap(address indexed trader, bool hypeIn, uint256 amountIn, uint256 amountOut, address indexed to);

    modifier lock() {
        require(_lock == 1, "locked");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IUniswapV2Pair pair_, address token_, IWETH weth_, uint256 feeNum_) {
        require(pair_.token0() == token_ || pair_.token1() == token_, "pair");
        require(feeNum_ > 0 && feeNum_ <= 1000, "fee");
        uniPair = pair_;
        token = token_;
        weth = weth_;
        feeNum = feeNum_;
        tokenIs0 = pair_.token0() == token_;
    }

    receive() external payable {
        require(msg.sender == address(weth), "direct HYPE");
    }

    // ───────────────────────────── reads (CloakPair's interface) ─────────────────────────────

    function reserves() public view returns (uint256 rHype, uint256 rToken, uint32 last) {
        (uint112 r0, uint112 r1, uint32 t) = uniPair.getReserves();
        (rHype, rToken, last) = tokenIs0 ? (uint256(r1), uint256(r0), t) : (uint256(r0), uint256(r1), t);
    }

    function reserveHype() external view returns (uint256 r) {
        (r,,) = reserves();
    }

    function reserveToken() external view returns (uint256 r) {
        (, r,) = reserves();
    }

    /// @notice Spot price: wei of HYPE per 1e18 token units.
    function price() external view returns (uint256) {
        (uint256 rH, uint256 rT,) = reserves();
        return rT == 0 ? 0 : (rH * 1e18) / rT;
    }

    /// @notice When the pool's reserves last changed (its accumulator's timestamp).
    function lastUpdate() external view returns (uint64) {
        (,, uint32 t) = reserves();
        return t;
    }

    /// @notice The pool's cumulative price as of now, in CloakPair's units: Σ (wei of HYPE per 1e18 tokens) × seconds.
    ///         The difference between two readings over their time gap is a price one transaction cannot move.
    function cumulativeNow() public view returns (uint256 cum, uint64 at) {
        uint256 uq = tokenIs0 ? uniPair.price0CumulativeLast() : uniPair.price1CumulativeLast();
        (uint256 rH, uint256 rT, uint32 last) = reserves();
        uint32 nowTs = uint32(block.timestamp);
        if (rH != 0 && rT != 0 && nowTs != last) {
            unchecked {
                // what the pool will add at its next update (the accumulator wraps by design)
                uq += ((rH << 112) / rT) * uint32(nowTs - last);
            }
        }
        cum = mulDiv(uq, 1e18, 1 << 112);
        at = uint64(block.timestamp);
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public view returns (uint256) {
        uint256 inWithFee = amountIn * feeNum;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    /// @notice LP tokens of the Uniswap pool `a` holds (0x…dEaD's are burned for good).
    function sharesOf(address a) external view returns (uint256) {
        return uniPair.balanceOf(a);
    }

    function totalShares() external view returns (uint256) {
        return uniPair.totalSupply();
    }

    // ───────────────────────────── swaps ─────────────────────────────

    /// @notice Native HYPE in, tokens out to `to`.
    function swapExactHypeForTokens(uint256 minOut, address to) external payable lock returns (uint256 out) {
        require(msg.value > 0, "zero");
        (uint256 rH, uint256 rT,) = reserves();
        out = getAmountOut(msg.value, rH, rT);
        require(out >= minOut && out > 0, "slippage");
        weth.deposit{value: msg.value}();
        require(weth.transfer(address(uniPair), msg.value), "weth");
        uniPair.swap(tokenIs0 ? out : 0, tokenIs0 ? 0 : out, to, "");
        emit Swap(msg.sender, true, msg.value, out, to);
    }

    /// @notice Tokens in (pulled from the caller), native HYPE out to `to`.
    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external lock returns (uint256 out) {
        require(amountIn > 0, "zero");
        (uint256 rH, uint256 rT,) = reserves();
        out = getAmountOut(amountIn, rT, rH);
        require(out >= minOut && out > 0, "slippage");
        require(IERC20Market(token).transferFrom(msg.sender, address(uniPair), amountIn), "tf");
        uniPair.swap(tokenIs0 ? 0 : out, tokenIs0 ? out : 0, address(this), "");
        weth.withdraw(out);
        (bool ok,) = to.call{value: out}("");
        require(ok, "send");
        emit Swap(msg.sender, false, amountIn, out, to);
    }
}

/// @dev a × b / d with a 512-bit intermediate (Uniswap's FullMath, MIT), rounding down.
function mulDiv(uint256 a, uint256 b, uint256 d) pure returns (uint256 result) {
    unchecked {
        uint256 prod0;
        uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) return prod0 / d;
        require(d > prod1, "mulDiv");
        uint256 remainder;
        assembly {
            remainder := mulmod(a, b, d)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = d & (~d + 1);
        assembly {
            d := div(d, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        prod0 |= prod1 * twos;
        uint256 inv = (3 * d) ^ 2;
        inv *= 2 - d * inv;
        inv *= 2 - d * inv;
        inv *= 2 - d * inv;
        inv *= 2 - d * inv;
        inv *= 2 - d * inv;
        inv *= 2 - d * inv;
        result = prod0 * inv;
    }
}
