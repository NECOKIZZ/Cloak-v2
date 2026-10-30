// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakToken} from "./CloakToken.sol";
import {IERC20Min} from "./CloakPair.sol";

/// @notice Holds a creator's allocation and releases it linearly from `start` to `end`. No owner; anyone can call
///         `release()`, which always pays the beneficiary.
contract CloakVesting {
    IERC20Min public immutable token;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable end;
    uint256 public immutable total;
    uint256 public released;

    event Released(uint256 amount);

    constructor(IERC20Min token_, address beneficiary_, uint64 start_, uint64 end_, uint256 total_) {
        require(end_ > start_, "schedule");
        token = token_;
        beneficiary = beneficiary_;
        start = start_;
        end = end_;
        total = total_;
    }

    function vestedAt(uint256 t) public view returns (uint256) {
        if (t <= start) return 0;
        if (t >= end) return total;
        return (total * (t - start)) / (end - start);
    }

    function releasable() public view returns (uint256) {
        return vestedAt(block.timestamp) - released;
    }

    function release() external returns (uint256 amount) {
        amount = releasable();
        require(amount > 0, "nothing");
        released += amount;
        require(token.transfer(beneficiary, amount), "t");
        emit Released(amount);
    }
}

/// @notice Deploys launch tokens and vesting contracts for CloakFactory (kept separate so the factory stays under the
/// contract size limit). A token has no owner and mints its whole supply in its constructor, so which contract deploys
/// it changes nothing; only launches registered in CloakFactory count as Cloak launches.
contract CloakVestingDeployer {
    function deployToken(
        string calldata name,
        string calldata symbol,
        address[] calldata to,
        uint256[] calldata amounts
    ) external returns (CloakToken) {
        return new CloakToken(name, symbol, to, amounts);
    }

    function deploy(IERC20Min token, address beneficiary, uint64 start, uint64 end, uint256 total)
        external
        returns (CloakVesting)
    {
        return new CloakVesting(token, beneficiary, start, end, total);
    }
}
