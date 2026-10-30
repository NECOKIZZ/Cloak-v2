// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICloakFactoryRead {
    function launchesCount() external view returns (uint256);

    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc);
}

/// @notice Earlier Cloak factories read as one list, so a new PrivateRouter (which takes one `legacyFactory`) can open
///         private vaults for launches from every earlier deployment. Index i walks the factories in order: the first
///         factory's launches, then the next one's. Read only, no owner, and the list is fixed at deployment, so it
///         can only ever point at the factories it was built with.
contract CloakFactoryList {
    ICloakFactoryRead[] private _factories;

    constructor(ICloakFactoryRead[] memory factories_) {
        require(factories_.length > 0, "none");
        for (uint256 i; i < factories_.length; ++i) {
            require(address(factories_[i]) != address(0), "zero");
            _factories.push(factories_[i]);
        }
    }

    function factories() external view returns (ICloakFactoryRead[] memory) {
        return _factories;
    }

    function launchesCount() external view returns (uint256 n) {
        for (uint256 i; i < _factories.length; ++i) {
            n += _factories[i].launchesCount();
        }
    }

    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc)
    {
        for (uint256 f; f < _factories.length; ++f) {
            uint256 n = _factories[f].launchesCount();
            if (i < n) return _factories[f].launches(i);
            i -= n;
        }
        revert("index");
    }
}
