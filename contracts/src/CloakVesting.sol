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

/// @notice Makes the door's one token (GloakMaker): mints `amounts` to `to`, exactly as CloakToken would.
interface IDoorMaker {
    function make(string calldata name, string calldata symbol, address[] calldata to, uint256[] calldata amounts)
        external
        returns (address token);
}

/// @notice Deploys launch tokens and vesting contracts for CloakFactory (kept separate so the factory stays under the
/// contract size limit). A token has no owner and mints its whole supply in its constructor, so which contract deploys
/// it changes nothing; only launches registered in CloakFactory count as Cloak launches.
///
/// The one-time door (the GLOAK experiment, docs/GLOAK-EXPERIMENT.md). `doorAdmin` may, once ever, run one launch whose
/// token comes from a maker it names instead of CloakToken. `useDoor` arms the door, creates that launch in the same
/// call, and checks the door was consumed by it, so no other launch can ever get the maker's token. After that call the
/// door is closed for good (`doorUsed`), and every launch gets a plain CloakToken as before. `doorToken` records the
/// one token it made; the v4 hook reads it to know which pool is private-only.
contract CloakVestingDeployer {
    /// @notice Who may use the door, once (Cloak's owner wallet), or address(0) for a deployer with no door.
    address public immutable doorAdmin;
    /// @notice True once the door has been used. It never reopens.
    bool public doorUsed;
    /// @notice The one token the door made, or address(0).
    address public doorToken;
    /// @dev Set only for the length of useDoor.
    address private _armedMaker;
    address private _armedFactory;

    event DoorUsed(address indexed factory, address indexed maker, address indexed token);

    constructor(address doorAdmin_) {
        doorAdmin = doorAdmin_;
    }

    function deployToken(
        string calldata name,
        string calldata symbol,
        address[] calldata to,
        uint256[] calldata amounts
    ) external returns (CloakToken) {
        address maker = _armedMaker;
        if (maker != address(0)) {
            require(msg.sender == _armedFactory, "door");
            _armedMaker = address(0);
            address t = IDoorMaker(maker).make(name, symbol, to, amounts);
            require(t.code.length != 0, "door token");
            doorToken = t;
            emit DoorUsed(msg.sender, maker, t);
            return CloakToken(t);
        }
        return new CloakToken(name, symbol, to, amounts);
    }

    /**
     * @notice The one-time door: create one launch on `factory` (whose deployer must be this contract) with
     *         `createLaunchCall` (abi-encoded CloakFactory.createLaunch), its token made by `maker`. Only the door
     *         admin, only once ever. Reverts whole unless that launch took the door's token.
     */
    function useDoor(address maker, address factory, bytes calldata createLaunchCall) external returns (bytes memory ret) {
        require(doorAdmin != address(0) && msg.sender == doorAdmin, "door admin");
        require(!doorUsed, "door used");
        require(maker != address(0) && factory != address(0), "zero");
        doorUsed = true;
        _armedMaker = maker;
        _armedFactory = factory;
        bool ok;
        (ok, ret) = factory.call(createLaunchCall);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        require(_armedMaker == address(0) && doorToken != address(0), "door not taken");
        _armedFactory = address(0);
    }

    function deploy(IERC20Min token, address beneficiary, uint64 start, uint64 end, uint256 total)
        external
        returns (CloakVesting)
    {
        return new CloakVesting(token, beneficiary, start, end, total);
    }
}
