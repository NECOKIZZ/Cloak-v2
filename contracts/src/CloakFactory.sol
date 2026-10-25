// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakAuction} from "./CloakAuction.sol";
import {CloakToken} from "./CloakToken.sol";
import {CloakVesting, CloakVestingDeployer} from "./CloakVesting.sol";
import {CloakConfig} from "./CloakConfig.sol";
import {IERC20Min} from "./CloakPair.sol";

/// @notice One call to launch a token through a sealed-bid auction. Launchpads integrate by calling `createLaunch`
/// from their own contracts (pass `params.creator` = the project) or through the Cloak SDK.
/// @dev A creator allocation is capped at 20% of the supply and always vests linearly (at least 30 days) from the end of
///      the auction, so a launch can't be dumped on its own buyers.
contract CloakFactory {
    uint256 public constant MAX_CREATOR_BPS = 2_000;
    uint64 public constant MIN_VEST_SECS = 30 days;

    CloakConfig public immutable config;
    CloakVestingDeployer public immutable vestingDeployer;

    struct Launch {
        address auction;
        address token;
        address creator;
        address launchpad;
        uint256 creatorAlloc;
        address vesting;
    }

    Launch[] public launches;

    event LaunchCreated(
        uint256 indexed index,
        address indexed auction,
        address indexed token,
        address creator,
        address launchpad,
        string name,
        string symbol,
        uint256 creatorAlloc,
        string metadataURI,
        address vesting,
        uint64 vestEnd
    );

    constructor(CloakConfig config_, CloakVestingDeployer vestingDeployer_) {
        config = config_;
        vestingDeployer = vestingDeployer_;
    }

    function createLaunch(
        string calldata name,
        string calldata symbol,
        uint256 creatorAlloc,
        uint64 vestSecs,
        CloakAuction.Params memory params,
        string calldata metadataURI
    ) external returns (address auction, address token) {
        if (params.creator == address(0)) params.creator = msg.sender;
        uint256 sale = params.saleSupply + params.lpReserve;
        require(creatorAlloc * 10_000 <= (sale + creatorAlloc) * MAX_CREATOR_BPS, "creator share");
        CloakAuction a = new CloakAuction(params, config);

        CloakVesting v;
        uint64 vestEnd;
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = address(a);
        amounts[0] = sale;
        if (creatorAlloc > 0) {
            require(vestSecs >= MIN_VEST_SECS, "vesting");
            vestEnd = params.revealEnd + vestSecs;
            to[1] = address(this); // minted here, then locked in the vesting contract below
            amounts[1] = creatorAlloc;
        }
        CloakToken t = new CloakToken(name, symbol, to, amounts);
        if (creatorAlloc > 0) {
            v = vestingDeployer.deploy(IERC20Min(address(t)), params.creator, params.revealEnd, vestEnd, creatorAlloc);
            require(t.transfer(address(v), creatorAlloc), "vest");
        }
        a.init(address(t));

        auction = address(a);
        token = address(t);
        launches.push(Launch(auction, token, params.creator, msg.sender, creatorAlloc, address(v)));
        emit LaunchCreated(
            launches.length - 1,
            auction,
            token,
            params.creator,
            msg.sender,
            name,
            symbol,
            creatorAlloc,
            metadataURI,
            address(v),
            vestEnd
        );
    }


    function launchesCount() external view returns (uint256) {
        return launches.length;
    }
}
