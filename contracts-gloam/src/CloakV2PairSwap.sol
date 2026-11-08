// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GloamVaultSwap2} from "gloam/GloamVaultSwap2.sol";

interface IUniV2Factory {
    function getPair(address a, address b) external view returns (address);
}

interface IUniV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/**
 * @title CloakV2PairSwap
 * @notice Private swaps between Gloam vault notes through Uniswap V2 pairs (Cloak's earlier launch markets), on
 *         Gloam's own escrow base, GloamVaultSwap2, unchanged: the one-time CREATE2 escrow bound to the note, the
 *         refund note, the exit key, the deadline, leftovers to the treasury and the reentrancy latch are all theirs.
 *         This contract is only the venue: `_swapExactOut` through one or more V2 pairs.
 *
 * Pools. No owner and no allowlist: a hop may use only the pair the immutable V2 factory reports for its two tokens,
 * so a route can't name a look-alike pair. A launch pair is usable the block it exists, which is what lets a Cloak
 * launch trade privately at settlement on this venue (if the vault lists the token).
 *
 * Native HYPE. A HYPE note is wrapped to WHYPE exactly as the first pair asks; a route that ends in WHYPE for a HYPE
 * note is unwrapped in full. Both follow from the route alone, which the escrow key's route hash fixes.
 *
 * What a bad pair or token can do: at most take the swap's leftover (the price buffer). The new note is exactly
 * `d.amount` (its shield proof binds it, and the base checks the router holds it), and the router pays at most what
 * the note brought in, else the whole swap reverts and the note stays in the vault (or, if its spend was sent alone,
 * waits at its escrow for the refund or the exit). No approval is ever given: pairs are paid by transfer.
 *
 * route = abi.encode(address[] path), path[0] the input token (WHYPE for a HYPE note), path[n] the output token.
 */
contract CloakV2PairSwap is GloamVaultSwap2 {
    IUniV2Factory public immutable factory;
    IWETH9 public immutable weth;
    uint256 public constant MAX_HOPS = 3;

    error BadRoute();
    error NoPair(address a, address b);

    constructor(address vault_, address treasury_, address factory_, address weth_) GloamVaultSwap2(vault_, treasury_) {
        if (factory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        if (factory_.code.length == 0 || weth_.code.length == 0) revert NotAContract();
        factory = IUniV2Factory(factory_);
        weth = IWETH9(weth_);
    }

    /// @notice HYPE comes in from an escrow as it opens, or from WHYPE during a swap (an unwrap).
    receive() external payable override {
        if (_opening()) return;
        if (!_inSwap() || msg.sender != address(weth)) revert NativeRefused();
    }

    function _stopsHere(address to) internal view override returns (bool) {
        return to == address(weth) || to == address(factory);
    }

    function _swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxIn, bytes calldata route)
        internal
        override
        returns (uint256 amountIn)
    {
        address[] memory path = abi.decode(route, (address[]));
        uint256 hops = path.length - 1;
        if (path.length < 2 || hops > MAX_HOPS) revert BadRoute();
        if (path[0] != (assetIn == NATIVE ? address(weth) : assetIn)) revert BadRoute();
        if (path[hops] != (assetOut == NATIVE ? address(weth) : assetOut)) revert BadRoute();

        // amounts backwards from the exact output (Uniswap V2's getAmountIn, 0.3% fee)
        address[] memory pairs = new address[](hops);
        uint256[] memory amounts = new uint256[](path.length);
        amounts[hops] = amountOut;
        for (uint256 i = hops; i > 0; i--) {
            address pair = factory.getPair(path[i - 1], path[i]);
            if (pair == address(0)) revert NoPair(path[i - 1], path[i]);
            pairs[i - 1] = pair;
            (uint256 rIn, uint256 rOut) = _reserves(pair, path[i - 1]);
            if (amounts[i] >= rOut) revert ShortOutput(0, amounts[i]);
            amounts[i - 1] = (rIn * amounts[i] * 1000) / ((rOut - amounts[i]) * 997) + 1;
        }
        amountIn = amounts[0];
        if (amountIn > maxIn) revert OverInput(amountIn, maxIn);

        if (assetIn == NATIVE) weth.deposit{value: amountIn}();
        _transfer(path[0], pairs[0], amountIn);
        for (uint256 i = 0; i < hops; i++) {
            address to = i + 1 < hops ? pairs[i + 1] : address(this);
            bool zeroIn = IUniV2Pair(pairs[i]).token0() == path[i];
            IUniV2Pair(pairs[i]).swap(zeroIn ? 0 : amounts[i + 1], zeroIn ? amounts[i + 1] : 0, to, "");
        }
        if (assetOut == NATIVE) weth.withdraw(amountOut);
    }

    function _reserves(address pair, address tokenIn) private view returns (uint256 rIn, uint256 rOut) {
        (uint112 r0, uint112 r1, ) = IUniV2Pair(pair).getReserves();
        (rIn, rOut) = IUniV2Pair(pair).token0() == tokenIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
