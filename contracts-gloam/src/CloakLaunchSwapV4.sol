// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakLaunchSwapBase} from "./CloakLaunchSwap.sol";
import {PoolKey, SwapParams, IPoolManagerSwap} from "gloam/GloamVaultSwapV4.sol";
import {IWETH} from "gloam/GloamVaultSwapV4b.sol";
import {IGloamVault} from "gloam/GloamVaultSwap.sol";

/**
 * @title CloakLaunchSwapV4
 * @notice The Uniswap v4 venue for CloakLaunchSwapBase: private swaps on Cloak's launch vault through v4 pools, the
 *         price buffer back to the trader (the base owes it to the swap). Cloak's launches open on v4 pools, so this is
 *         how a launch token trades privately the moment it settles.
 *
 * The swap logic is Gloam's GloamVaultSwapV4c's (route walk, exact-out from the last hop, middle currencies netting
 * to zero, native and wrapped HYPE both, paying by sync/transfer/settle with no approval), with one difference: no
 * allowlist with a 3-day wait. Instead a pool is usable at once if its hook is none or Cloak's own reviewed hook
 * (CloakV4Hook, immutable here). So a hostile hook can't be on any route, and what a pool priced against the swap can
 * take is bounded as in V4c: the new note is exactly d.amount (its proof binds it, the base checks it arrived), the
 * swap pays at most what the note brought in, and every route is fixed in the swap's escrow key.
 *
 * route = abi.encode(PoolKey[]), pools in order from the input to the output, at most 3.
 */
contract CloakLaunchSwapV4 is CloakLaunchSwapBase {
    IPoolManagerSwap public immutable poolManager;
    /// @notice The chain's wrapped HYPE, a separate vault asset from native HYPE.
    address public immutable weth;
    /// @notice The one hook a pool may have besides none: Cloak's launch hook.
    address public immutable allowedHook;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @dev What a swap hands itself through the PoolManager's unlock().
    struct Unlock {
        PoolKey[] hops;
        bool[] zeroForOne;
        address assetIn;
        address assetOut;
        address payIn;
        address takeOut;
        uint256 amountOut;
        uint256 maxIn;
    }

    error BadPool();
    error HookNotAllowed(address hook);
    error NotPoolManager();
    error MiddleNotSettled();
    error InvalidAmount();

    constructor(address vault_, address poolManager_, address weth_, address allowedHook_) CloakLaunchSwapBase(vault_) {
        if (poolManager_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        poolManager = IPoolManagerSwap(poolManager_);
        weth = weth_;
        allowedHook = allowedHook_;
    }

    /// @notice HYPE comes in from an escrow as it opens, or during a swap from WHYPE (an unwrap) or the PoolManager (a take).
    receive() external payable override {
        if (_opening()) return;
        if (!_inSwap() || (msg.sender != weth && msg.sender != address(poolManager))) revert NativeRefused();
    }

    /// @dev The PoolManager and WHYPE hold nothing for an exit's recipient.
    function _stopsHere(address to) internal view virtual override returns (bool) {
        return to == address(poolManager) || to == weth;
    }

    /// @notice Whether a route may use this pool: sorted currencies, and no hook or Cloak's own.
    function poolAllowed(PoolKey memory k) public view returns (bool) {
        return k.currency0 < k.currency1 && (k.hooks == address(0) || (allowedHook != address(0) && k.hooks == allowedHook));
    }

    function _swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxIn, bytes calldata route)
        internal
        override
        returns (uint256 amountIn)
    {
        PoolKey[] memory hops = abi.decode(route, (PoolKey[]));
        if (amountOut > uint256(int256(type(int128).max))) revert InvalidAmount();
        (bool[] memory zeroForOne, address payIn, address takeOut) = _walk(hops, assetIn, assetOut);
        bytes memory res = poolManager.unlock(abi.encode(Unlock(hops, zeroForOne, assetIn, assetOut, payIn, takeOut, amountOut, maxIn)));
        amountIn = abi.decode(res, (uint256));
    }

    /**
     * @dev Checks a route and works out each hop's direction, the currency paid in (the note's asset, or its other form
     *      of HYPE when the first pool holds only that one) and the one taken (the new note's asset, or its other form
     *      when the route ends there). As GloamVaultSwapV4c._walk, with the hook rule in place of the allowlist.
     */
    function _walk(PoolKey[] memory hops, address assetIn, address assetOut)
        private
        view
        returns (bool[] memory zeroForOne, address payIn, address takeOut)
    {
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS) revert BadRoute();
        address[] memory path = new address[](n + 1);
        zeroForOne = new bool[](n);
        address cur = assetIn;
        if (_isEth(assetIn) && !_holds(hops[0], assetIn) && _holds(hops[0], _otherEth(assetIn))) cur = _otherEth(assetIn);
        path[0] = cur;
        for (uint256 i = 0; i < n; i++) {
            PoolKey memory k = hops[i];
            if (k.currency0 >= k.currency1) revert BadPool();
            if (!poolAllowed(k)) revert HookNotAllowed(k.hooks);
            if (k.currency0 == cur) {
                zeroForOne[i] = true;
                cur = k.currency1;
            } else if (k.currency1 == cur) {
                zeroForOne[i] = false;
                cur = k.currency0;
            } else {
                revert BadRoute();
            }
            path[i + 1] = cur;
        }
        if (cur != assetOut && !(_isEth(assetOut) && cur == _otherEth(assetOut))) revert BadRoute();
        // each currency once, and a converted end nowhere inside the route in the form the note holds
        for (uint256 i = 0; i <= n; i++) {
            if (path[0] != assetIn && path[i] == assetIn) revert BadRoute();
            if (path[n] != assetOut && path[i] == assetOut) revert BadRoute();
            for (uint256 j = i + 1; j <= n; j++) {
                if (path[i] == path[j]) revert BadRoute();
            }
        }
        payIn = path[0];
        takeOut = path[n];
    }

    /// @notice Called back by the PoolManager inside unlock(), only during a swap.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_inSwap()) revert NotPoolManager();
        Unlock memory u = abi.decode(data, (Unlock));

        // from the last hop back: buy exactly `want`, then `want` becomes what that hop cost
        uint256 want = u.amountOut;
        uint256 finalOut;
        for (uint256 i = u.hops.length; i > 0; i--) {
            bool z = u.zeroForOne[i - 1];
            int256 delta = poolManager.swap(
                u.hops[i - 1],
                SwapParams({zeroForOne: z, amountSpecified: int256(want), sqrtPriceLimitX96: z ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1}),
                ""
            );
            int128 a0 = int128(delta >> 128);
            int128 a1 = int128(delta);
            int128 outD = z ? a1 : a0;
            int128 inD = z ? a0 : a1;
            if (outD < 0 || uint256(uint128(outD)) < want) revert ShortOutput(outD < 0 ? 0 : uint256(uint128(outD)), want);
            // a middle currency must net to exactly zero: no more out than the next hop paid in
            if (i < u.hops.length && uint256(uint128(outD)) != want) revert MiddleNotSettled();
            if (i == u.hops.length) finalOut = uint256(uint128(outD));
            if (inD >= 0) revert BadRoute();
            want = uint256(uint128(-inD));
        }
        if (want > u.maxIn) revert OverInput(want, u.maxIn);

        // pay the input: the note's own form, or exactly that much of the other
        if (u.payIn == NATIVE) {
            if (u.assetIn != NATIVE) IWETH(weth).withdraw(want);
            poolManager.sync(NATIVE);
            poolManager.settle{value: want}();
        } else {
            if (u.assetIn == NATIVE) IWETH(weth).deposit{value: want}();
            poolManager.sync(u.payIn);
            _call(u.payIn, abi.encodeWithSelector(0xa9059cbb, address(poolManager), want));
            poolManager.settle();
        }
        // take the whole output, converted to the new note's form, all of it
        poolManager.take(u.takeOut, address(this), finalOut);
        if (u.takeOut != u.assetOut) {
            if (u.takeOut == NATIVE) IWETH(weth).deposit{value: finalOut}();
            else IWETH(weth).withdraw(finalOut);
        }
        return abi.encode(want);
    }

    function _isEth(address a) private view returns (bool) {
        return a == NATIVE || a == weth;
    }

    function _otherEth(address a) private view returns (address) {
        return a == NATIVE ? weth : NATIVE;
    }

    function _holds(PoolKey memory k, address c) private pure returns (bool) {
        return k.currency0 == c || k.currency1 == c;
    }
}

interface ILaunchTokens {
    function isLaunchToken(address token) external view returns (bool);
}

/**
 * @title CloakRouterV4
 * @notice Private swaps between two fixed vaults: Cloak launch tokens live in Cloak's launch vault, HYPE and USDC in
 *         Gloam's vault. A buy spends a HYPE note in Gloam's vault and deposits the launch token as a note in the
 *         launch vault; a sell does the reverse. Same calls, escrows, refunds and exits as CloakLaunchSwapV4.
 *
 *         Which vault an asset uses is decided here, not by the caller: a token the launch vault admitted
 *         (isLaunchToken) uses the launch vault, anything else Gloam's vault. Both are fixed at deploy, with no owner, so
 *         nobody can point a swap at another vault. A vault only pays out a note with its owner's proof, to the escrow
 *         that proof names, so a bug here can cost at most a swap in flight, never what the vaults hold.
 */
contract CloakRouterV4 is CloakLaunchSwapV4 {
    /// @notice Gloam's vault: HYPE, USDC and every asset that isn't a Cloak launch token.
    IGloamVault public immutable gloamVault;

    /// @param launchVault_ Cloak's launch vault (CloakLaunchVault): Cloak launch tokens
    constructor(address launchVault_, address gloamVault_, address poolManager_, address weth_, address allowedHook_)
        CloakLaunchSwapV4(launchVault_, poolManager_, weth_, allowedHook_)
    {
        if (gloamVault_ == address(0) || gloamVault_ == launchVault_) revert ZeroAddress();
        gloamVault = IGloamVault(gloamVault_);
    }

    function vaultFor(address asset) public view override returns (IGloamVault) {
        return asset != NATIVE && ILaunchTokens(address(vault)).isLaunchToken(asset) ? vault : gloamVault;
    }

    /// @dev Neither vault holds anything for an exit's recipient.
    function _stopsHere(address to) internal view override returns (bool) {
        return super._stopsHere(to) || to == address(gloamVault);
    }
}
