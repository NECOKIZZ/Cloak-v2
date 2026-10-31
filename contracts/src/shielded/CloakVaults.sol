// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {IPoseidon2, IPoseidon3} from "./interfaces/IHasher.sol";
import {CloakPair} from "../CloakPair.sol";
import {CloakConfig} from "../CloakConfig.sol";

interface ILaunchFactory {
    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc);
}

interface ILaunchAuction {
    function pair() external view returns (CloakPair);
    function settled() external view returns (bool);
}

/// @title CloakVaults — the permanent private vaults, one per asset, and the list of them.
/// @notice Deployed once and never replaced. Each asset gets one ShieldedPool, made here and kept for good:
///           - a launch token, by anyone, once its launch (from a factory registered in CloakConfig) settled with a pool,
///           - any other token (WHYPE, USDC), by anyone, once CloakConfig approved it.
///         Routers, batchers and migrators come and go around these vaults; balances never have to move. A vault's
///         rules (verifier, fees, limits) come from CloakConfig, behind its timelock.
/// @dev No owner and no function that moves funds. A vault is never removed, so nothing can be trapped.
contract CloakVaults {
    CloakConfig public immutable config;
    IPoseidon2 public immutable hasher2;
    IPoseidon3 public immutable hasher3;

    mapping(address => ShieldedPool) public poolOf; // asset → its vault
    mapping(address => CloakPair) public pairOf; // launch token → its launch pair (0 for other assets)
    mapping(address => bool) public isPool;
    address[] public tokens; // every asset with a vault, in creation order

    event PoolCreated(address indexed token, address pool, address pair);

    error NotLaunched();
    error UnknownFactory();
    error NotApproved();
    error PoolExists();

    constructor(CloakConfig config_, IPoseidon2 hasher2_, IPoseidon3 hasher3_) {
        config = config_;
        hasher2 = hasher2_;
        hasher3 = hasher3_;
    }

    function tokensCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @notice Open the private vault for a settled launch.
    function createPool(ILaunchFactory factory, uint256 launchIndex) external returns (ShieldedPool pool) {
        if (!config.isLaunchFactory(address(factory))) revert UnknownFactory();
        (address auction, address token,,,) = factory.launches(launchIndex);
        if (!ILaunchAuction(auction).settled()) revert NotLaunched();
        CloakPair pair = ILaunchAuction(auction).pair();
        if (address(pair) == address(0)) revert NotLaunched();
        pool = _create(token);
        pairOf[token] = pair;
        emit PoolCreated(token, address(pool), address(pair));
    }

    /// @notice Open the private vault for a token CloakConfig approved (WHYPE, USDC, …).
    function createAssetPool(address token) external returns (ShieldedPool pool) {
        if (!config.approvedAsset(token)) revert NotApproved();
        pool = _create(token);
        emit PoolCreated(token, address(pool), address(0));
    }

    function _create(address token) internal returns (ShieldedPool pool) {
        if (address(poolOf[token]) != address(0)) revert PoolExists();
        pool = new ShieldedPool(config, hasher2, hasher3, IERC20(token));
        poolOf[token] = pool;
        isPool[address(pool)] = true;
        tokens.push(token);
    }
}
