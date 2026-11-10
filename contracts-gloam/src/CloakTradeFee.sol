// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CloakTradeFee
 * @notice Cloak's fee on private trades out of its own vaults, read by CloakRouterV4 and CloakGloamBatcherV4. When a
 *         Cloak launch token or an ecosystem token is sold privately into Gloam's vault, the router (or a batch round)
 *         takes `feeBps` of what the sale brings, in HYPE (or USDC), and sends it to `treasury`. Cloak's own vaults then
 *         charge no withdrawal fee, so Cloak never holds launch or outside tokens as revenue.
 *
 *         The rules are public and slow to loosen:
 *         - at most MAX_BPS (1%), whoever holds the owner key;
 *         - the owner lowers the fee at once;
 *         - raising it, or moving the treasury, is queued and waits DELAY (3 days) in public before anyone can apply it;
 *         - ownership moves in two steps.
 */
contract CloakTradeFee {
    uint16 public constant MAX_BPS = 100;
    uint64 public constant DELAY = 3 days;

    address public owner;
    address public pendingOwner;
    address public treasury;
    uint16 public feeBps;

    struct Change {
        uint16 feeBps;
        address treasury;
        uint64 eta;
    }

    /// @notice A queued raise or treasury move (eta 0: none).
    Change public queued;

    event FeeSet(uint16 feeBps, address treasury);
    event ChangeQueued(uint16 feeBps, address treasury, uint64 eta);
    event ChangeCancelled();
    event OwnershipOffered(address to);
    event OwnershipTaken(address owner);

    error NotOwner();
    error TooHigh();
    error ZeroAddress();
    error NotLower();
    error NotQueued();
    error NotYet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address treasury_, uint16 feeBps_) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_BPS) revert TooHigh();
        owner = owner_;
        treasury = treasury_;
        feeBps = feeBps_;
        emit FeeSet(feeBps_, treasury_);
    }

    /// @notice The fee now: its rate and where it goes.
    function current() external view returns (uint16, address) {
        return (feeBps, treasury);
    }

    /// @notice The fee on a sale that must leave `net` for the trader: feeBps of the whole (net + fee), rounded up.
    function feeOn(uint256 net) public view returns (uint256) {
        uint256 bps = feeBps;
        if (bps == 0) return 0;
        return (net * bps + (10_000 - bps) - 1) / (10_000 - bps);
    }

    /// @notice Lower the fee at once. The owner.
    function lower(uint16 feeBps_) external onlyOwner {
        if (feeBps_ >= feeBps) revert NotLower();
        feeBps = feeBps_;
        emit FeeSet(feeBps_, treasury);
    }

    /// @notice Queue a new fee and treasury, applied after DELAY. The owner. Replaces anything queued.
    function queue(uint16 feeBps_, address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_BPS) revert TooHigh();
        uint64 eta = uint64(block.timestamp) + DELAY;
        queued = Change(feeBps_, treasury_, eta);
        emit ChangeQueued(feeBps_, treasury_, eta);
    }

    /// @notice Apply the queued change once its wait is over. Anyone.
    function applyQueued() external {
        Change memory c = queued;
        if (c.eta == 0) revert NotQueued();
        if (block.timestamp < c.eta) revert NotYet();
        delete queued;
        feeBps = c.feeBps;
        treasury = c.treasury;
        emit FeeSet(c.feeBps, c.treasury);
    }

    function cancel() external onlyOwner {
        if (queued.eta == 0) revert NotQueued();
        delete queued;
        emit ChangeCancelled();
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTaken(msg.sender);
    }
}
