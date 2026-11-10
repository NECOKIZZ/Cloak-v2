// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakGloamBatcherBase} from "./CloakGloamBatcher.sol";
import {IGloamVault} from "gloam/GloamVaultSwap.sol";

interface ILaunchFactoryB {
    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting);
}

interface ILaunchAuctionB {
    function settled() external view returns (bool);
    function pair() external view returns (address);
}

/// @notice Cloak's market for a v4 launch: its own pool, quoted and traded with native HYPE.
interface ICloakV4Market {
    function reserves() external view returns (uint256 rHype, uint256 rToken, uint32 last);
    /// @notice Σ price × seconds (wei of HYPE per 1e18 token units), from CloakV4Hook: only a price held counts.
    function cumulativeNow() external view returns (uint256 cum, uint64 at);
    function swapExactHypeForTokens(uint256 minOut, address to) external payable returns (uint256 out);
    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
}

interface IERC20Bv {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title CloakGloamBatcherV4
 * @notice The Uniswap v4 venue for CloakGloamBatcherBase: batch rounds on Cloak's v4 launches. A token's market is its
 *         launch's CloakV4Market (auction.pair()), which prices the round and trades the net with native HYPE.
 *
 *         The markets come from Cloak's launch factory (the one the launch vault admits from) and are recorded by
 *         register(), which anyone may call for a settled launch (the keeper loop does), the way admitLaunch does for
 *         the vault. So no owner chooses a market, and a market can't be swapped once recorded.
 */
contract CloakGloamBatcherV4 is CloakGloamBatcherBase {
    ILaunchFactoryB public immutable launchFactory;
    /// @notice A launch token's market (its auction's CloakV4Market). 0 until registered.
    mapping(address => ICloakV4Market) public marketOf;

    event MarketRegistered(uint256 indexed launchIndex, address indexed token, address market);

    error NotSettled();

    /// @notice The vault HYPE orders are spent from and HYPE payouts go into: Gloam's vault, or `vault` when built
    ///         with none. Launch tokens always use `vault` (Cloak's launch vault).
    IGloamVault public immutable hypeVault;

    constructor(address vault_, address hypeVault_, address launchFactory_, uint256 roundSecs_, uint256 maxSlippageBps_, uint256 refundAfter_)
        CloakGloamBatcherBase(vault_, roundSecs_, maxSlippageBps_, refundAfter_)
    {
        require(launchFactory_ != address(0), "factory");
        launchFactory = ILaunchFactoryB(launchFactory_);
        hypeVault = IGloamVault(hypeVault_ == address(0) ? vault_ : hypeVault_);
    }

    function vaultFor(address asset) public view override returns (IGloamVault) {
        return asset == NATIVE ? hypeVault : vault;
    }

    /// @notice Record a settled launch's market. Anyone may call it; a second call changes nothing.
    function register(uint256 launchIndex) external returns (address token) {
        address auction;
        (auction, token,,,,) = launchFactory.launches(launchIndex);
        if (address(marketOf[token]) != address(0)) return token;
        if (!ILaunchAuctionB(auction).settled()) revert NotSettled();
        address market = ILaunchAuctionB(auction).pair();
        if (market == address(0)) revert NoPair();
        marketOf[token] = ICloakV4Market(market);
        _checkpoint(token); // the token's price history starts here, not at its first order
        emit MarketRegistered(launchIndex, token, market);
    }

    function _hasMarket(address token) internal view override returns (bool) {
        return address(marketOf[token]) != address(0);
    }

    /// @dev While settling, the market pays HYPE out through the PoolManager (a take), so it comes from there.
    function _venueMayPay(address) internal view override returns (bool) {
        return _inSettle();
    }

    function _cumulative(address token) internal view override returns (uint256 c) {
        (c,) = marketOf[token].cumulativeNow();
    }

    function _averagePrice(uint256 dCum, uint256 dt) internal pure override returns (uint256) {
        return dt == 0 ? 0 : dCum / dt;
    }

    function _reserves(address token) internal view override returns (uint256 rH, uint256 rT) {
        (rH, rT,) = marketOf[token].reserves();
    }

    function _swapHypeForTokens(address token, uint256 hypeIn) internal override returns (uint256 out) {
        uint256 before = IERC20Bv(token).balanceOf(address(this));
        marketOf[token].swapExactHypeForTokens{value: hypeIn}(1, address(this));
        out = IERC20Bv(token).balanceOf(address(this)) - before;
    }

    function _swapTokensForHype(address token, uint256 tokensIn) internal override returns (uint256 out) {
        ICloakV4Market m = marketOf[token];
        uint256 before = address(this).balance;
        require(IERC20Bv(token).approve(address(m), tokensIn), "approve");
        m.swapExactTokensForHype(tokensIn, 1, address(this));
        require(IERC20Bv(token).approve(address(m), 0), "approve");
        out = address(this).balance - before;
    }
}
