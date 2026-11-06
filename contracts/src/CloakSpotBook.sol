// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakDrop, CloakDropFactory} from "./CloakDrop.sol";

/// @title CloakSpotBook
/// @notice Whitelist spot sales on top of Cloak drops. One book serves every sale.
///
///  A partner collection gives out WL spots. Their creator sells them as a Cloak drop: the drop's supply is the number
///  of spots and its sealed auction decides who gets them. The creator marks the drop as a spot sale here, naming the
///  partner and a deadline. Once the drop settles, each winning bid names the wallets to whitelist, one per spot it won,
///  and may change them until the deadline. The book then holds the list the partner whitelists.
///
///  Only the wallet that placed a winning bid can name its wallets, a wallet takes at most one spot per sale, and only
///  drops made by the Cloak drop factory can be sales, so the list can't be spammed or faked.
contract CloakSpotBook {
    uint256 public constant MAX_PARTNER = 200;
    uint256 public constant MAX_WALLET_WINDOW = 90 days;
    /// Winners always get at least this long after bidding closes to name their wallets.
    uint256 public constant MIN_WALLET_WINDOW = 1 days;

    CloakDropFactory public immutable factory;

    struct Sale {
        bool open;
        uint64 deadline; // wallets can be named and changed until then
        string partner; // the partner collection, as the creator names it
    }

    mapping(address => Sale) internal _sales;
    mapping(address => mapping(uint256 => address[])) internal _wallets; // drop => bid id => wallets
    mapping(address => mapping(address => uint256)) public spotOf; // drop => wallet => bid id + 1 (0 = none)
    mapping(address => uint256[]) internal _entries; // drop => bid ids that named wallets, in order
    mapping(address => mapping(uint256 => bool)) internal _entered;
    address[] public sales;

    event SaleOpened(address indexed drop, address indexed creator, string partner, uint64 deadline);
    event WalletsSet(address indexed drop, uint256 indexed bidId, address indexed bidder, address[] wallets);

    constructor(CloakDropFactory factory_) {
        factory = factory_;
    }

    /// @notice Mark drop number `dropIndex` of the factory as a WL spot sale. Only its creator, and only before it
    /// settles. `deadline` is when winners stop naming wallets: after the reveal window, within 90 days of it.
    function open(uint256 dropIndex, string calldata partner, uint64 deadline) external returns (address drop) {
        drop = factory.drops(dropIndex);
        CloakDrop d = CloakDrop(drop);
        CloakDrop.Params memory p = d.params();
        require(msg.sender == p.creator, "creator");
        require(!_sales[drop].open, "already a sale");
        require(!d.settled(), "settled");
        require(bytes(partner).length > 0 && bytes(partner).length <= MAX_PARTNER, "partner");
        require(deadline >= p.revealEnd + MIN_WALLET_WINDOW && deadline <= p.revealEnd + MAX_WALLET_WINDOW, "deadline");
        _sales[drop] = Sale(true, deadline, partner);
        sales.push(drop);
        emit SaleOpened(drop, msg.sender, partner, deadline);
    }

    /// @notice Name the wallets to whitelist for winning bid `bidId`: one per spot it won. Calling again replaces them.
    function setWallets(address drop, uint256 bidId, address[] calldata wallets) external {
        Sale storage s = _sales[drop];
        require(s.open, "not a sale");
        require(block.timestamp < s.deadline, "deadline passed");
        CloakDrop d = CloakDrop(drop);
        require(d.phase() == 5, "not settled");
        require(d.getBid(bidId).bidder == msg.sender, "not your bid");
        (uint32 won,,,) = d.allocationOf(bidId);
        require(won > 0, "bid won no spots");
        require(wallets.length == won, "one wallet per spot");

        address[] storage old = _wallets[drop][bidId];
        for (uint256 i; i < old.length; ++i) delete spotOf[drop][old[i]];
        delete _wallets[drop][bidId];
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            require(w != address(0), "zero wallet");
            require(spotOf[drop][w] == 0, "wallet already has a spot");
            spotOf[drop][w] = bidId + 1;
            _wallets[drop][bidId].push(w);
        }
        if (!_entered[drop][bidId]) {
            _entered[drop][bidId] = true;
            _entries[drop].push(bidId);
        }
        emit WalletsSet(drop, bidId, msg.sender, wallets);
    }

    function sale(address drop) external view returns (Sale memory) {
        return _sales[drop];
    }

    function salesCount() external view returns (uint256) {
        return sales.length;
    }

    function walletsOf(address drop, uint256 bidId) external view returns (address[] memory) {
        return _wallets[drop][bidId];
    }

    /// @notice Every wallet named for a sale, with the bid it came from, in the order the bids first named them.
    function list(address drop) external view returns (uint256[] memory bidIds, address[] memory wallets) {
        uint256[] storage e = _entries[drop];
        uint256 n;
        for (uint256 i; i < e.length; ++i) n += _wallets[drop][e[i]].length;
        bidIds = new uint256[](n);
        wallets = new address[](n);
        uint256 k;
        for (uint256 i; i < e.length; ++i) {
            address[] storage ws = _wallets[drop][e[i]];
            for (uint256 j; j < ws.length; ++j) {
                bidIds[k] = e[i];
                wallets[k++] = ws[j];
            }
        }
    }
}
