// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CloakConfig — the protocol's rules: proof verifier, fees and deposit caps. Every Cloak contract reads them here.
/// @notice It is also the registry (v4): which launch factories' tokens the vault may list, which other assets it may
///         list, and every vault, router, batcher, migrator and factory Cloak has used, with the block each started,
///         so apps find all of them from this one address.
/// @notice Governance is "setup, then timelock":
///   - During setup the owner sets rules directly, so one deploy script can wire everything.
///   - `endSetup()` is one-way. After it, a rule can only be TIGHTENED at once (lower a fee, lower a cap, close
///     deposits). Anything that loosens a rule (raise a fee or a cap, change the verifier or the fee recipient) must be
///     queued on-chain with `queueChange` and waits a public `CHANGE_DELAY` before `executeChange` can run it, so
///     everyone sees it coming and can leave first.
///   - Fees have hard ceilings in this contract. The owner can never move user funds: there is no such function in
///     any Cloak contract.
contract CloakConfig {
    uint256 public constant CHANGE_DELAY = 3 days;
    uint256 public constant CHANGE_GRACE = 14 days;

    uint16 public constant MAX_WITHDRAW_FEE_BPS = 100; // 1%: kept by a shielded pool on every withdrawal (cash out, swap)
    uint16 public constant MAX_LAUNCH_FEE_BPS = 300; // 3%: of a successful raise, taken at settlement

    struct Limit {
        uint128 perDeposit;
        uint128 total;
    }

    address public owner;
    address public pendingOwner;
    bool public setupMode = true;
    mapping(bytes32 => uint256) public changeEta;

    address public verifier; // Groth16 verifier every shielded pool uses
    address public feeRecipient; // treasury; collected fees always go here
    uint16 public withdrawFeeBps;
    uint16 public launchFeeBps;

    bool public depositLimitsOn;
    mapping(address => Limit) internal _limit; // per asset, in its own units
    mapping(address => bool) public hasLimit; // false: the asset uses defaultLimitBps
    /// @notice Limit for an asset with no explicit one (each new launch token), in bps of its total supply.
    Limit public defaultLimitBps;
    /// @notice Limits for new sealed-bid auctions, in wei of HYPE: per bid deposit and total deposits.
    Limit public auctionLimit;
    /// @notice Cloak's own contracts (router, batcher, migrator) move money that is already inside Cloak, so caps don't
    ///         apply to them.
    mapping(address => bool) public capExempt;

    /// @notice Launch factories whose settled launches the vault may list (every Cloak factory, old ones included).
    mapping(address => bool) public isLaunchFactory;
    address[] public launchFactories; // every factory ever added, each once
    mapping(address => bool) internal _inList;
    /// @notice Tokens other than launch tokens that the vault may list (WHYPE, USDC, …).
    mapping(address => bool) public approvedAsset;

    struct Entry {
        bytes32 kind; // "vaults", "router", "batcher", "migrator", "factory"
        address addr;
        uint16 version; // Cloak deployment it belongs to (1, 2, 3, 4, …): tells apps which key scheme its notes use
        uint64 startBlock; // its first block: apps read its events from here
    }

    /// @notice Every Cloak contract ever registered, oldest first. The newest entry of a kind is the current one.
    Entry[] public registry;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event SetupEnded();
    event ChangeQueued(bytes32 indexed id, bytes call, uint256 eta);
    event ChangeExecuted(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);
    event VerifierSet(address verifier);
    event FeesSet(uint16 withdrawFeeBps, uint16 launchFeeBps, address feeRecipient);
    event DepositLimitsOn();
    event LimitSet(address indexed asset, uint128 perDeposit, uint128 total);
    event DefaultLimitSet(uint128 perDepositBps, uint128 totalBps);
    event AuctionLimitSet(uint128 perBid, uint128 total);
    event CapExemptSet(address indexed account, bool exempt);
    event LaunchFactoryAdded(address indexed factory);
    event LaunchFactoryRemoved(address indexed factory);
    event AssetApproved(address indexed token);
    event Registered(bytes32 indexed kind, address indexed addr, uint256 index);

    error NotOwner();
    error NotPendingOwner();
    error TimelockRequired();
    error SetupActive();
    error AlreadyEnded();
    error UnknownChange();
    error AlreadyQueued();
    error NotQueued();
    error NotReady();
    error Expired();
    error FeeTooHigh();
    error ZeroAddress();
    error NotLower();
    error BadBps();
    error AlreadyAdded();
    error NotAdded();
    error BadBlock();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySetup() {
        if (!setupMode) revert TimelockRequired();
        _;
    }

    constructor(address verifier_, address feeRecipient_) {
        if (verifier_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        verifier = verifier_;
        feeRecipient = feeRecipient_;
        emit VerifierSet(verifier_);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Deposit limit for `asset` (explicit, else the default share of its supply). `on` = false: no limit.
    function limitOf(address asset) external view returns (bool on, uint256 perDeposit, uint256 total) {
        if (!depositLimitsOn) return (false, 0, 0);
        (perDeposit, total) = _effective(asset);
        on = true;
    }

    function _effective(address asset) internal view returns (uint256 perDeposit, uint256 total) {
        if (hasLimit[asset]) {
            Limit memory l = _limit[asset];
            return (l.perDeposit, l.total);
        }
        Limit memory d = defaultLimitBps;
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature("totalSupply()"));
        uint256 supply = ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        return ((supply * d.perDeposit) / 10_000, (supply * d.total) / 10_000);
    }

    function launchFactoriesCount() external view returns (uint256) {
        return launchFactories.length;
    }

    function registryCount() external view returns (uint256) {
        return registry.length;
    }

    /// @notice The newest registered contract of `kind` (address(0) if none). Register older deployments first.
    function current(bytes32 kind) external view returns (address) {
        for (uint256 i = registry.length; i > 0; --i) {
            if (registry[i - 1].kind == kind) return registry[i - 1].addr;
        }
        return address(0);
    }

    /// @notice floor(amount × withdrawFeeBps / 10_000); 0 while fees are off.
    function withdrawFee(uint256 amount) external view returns (uint256) {
        if (withdrawFeeBps == 0 || feeRecipient == address(0)) return 0;
        return (amount / 10_000) * withdrawFeeBps + ((amount % 10_000) * withdrawFeeBps) / 10_000;
    }

    // ───────────────────────────── setters (setup: direct · after: timelocked) ─────────────────────────────

    function setVerifier(address v) external onlyOwner onlySetup {
        _setVerifier(v);
    }

    function setFees(uint16 withdrawBps, uint16 launchBps, address recipient) external onlyOwner onlySetup {
        _setFees(withdrawBps, launchBps, recipient);
    }

    function turnOnDepositLimits() external onlyOwner onlySetup {
        depositLimitsOn = true;
        emit DepositLimitsOn();
    }

    function setLimit(address asset, uint128 perDeposit, uint128 total) external onlyOwner onlySetup {
        _setLimit(asset, perDeposit, total);
    }

    function setDefaultLimit(uint128 perDepositBps, uint128 totalBps) external onlyOwner onlySetup {
        _setDefaultLimit(perDepositBps, totalBps);
    }

    function setAuctionLimit(uint128 perBid, uint128 total) external onlyOwner onlySetup {
        _setAuctionLimit(perBid, total);
    }

    function setCapExempt(address account, bool exempt) external onlyOwner onlySetup {
        _setCapExempt(account, exempt);
    }

    /// @notice Let the vault list this factory's settled launches.
    function addLaunchFactory(address factory) external onlyOwner onlySetup {
        _addLaunchFactory(factory);
    }

    /// @notice Let the vault list a token that isn't a launch token.
    function approveAsset(address token) external onlyOwner onlySetup {
        _approveAsset(token);
    }

    /// @notice Record a Cloak contract (earlier deployments' contracts too, with their own start blocks). Apps build
    ///         users' proofs for the current router, batcher and migrator, so after setup this waits the full timelock
    ///         like any other loosening change.
    function register(bytes32 kind, address addr, uint16 version, uint64 startBlock) external onlyOwner onlySetup {
        _register(kind, addr, version, startBlock);
    }

    // ───────────────────────────── tighten at once (always allowed) ─────────────────────────────

    /// @notice Stop new listings from a factory. Assets already listed stay listed, so no balance is ever trapped.
    function removeLaunchFactory(address factory) external onlyOwner {
        if (!isLaunchFactory[factory]) revert NotAdded();
        isLaunchFactory[factory] = false;
        emit LaunchFactoryRemoved(factory);
    }

    function lowerFees(uint16 withdrawBps, uint16 launchBps) external onlyOwner {
        if (withdrawBps > withdrawFeeBps || launchBps > launchFeeBps) revert NotLower();
        _setFees(withdrawBps, launchBps, feeRecipient);
    }

    /// @notice Lower an asset's limit, e.g. (0, 0) closes deposits during an incident. Withdrawals are never limited.
    function lowerLimit(address asset, uint128 perDeposit, uint128 total) external onlyOwner {
        (uint256 p, uint256 t) = _effective(asset);
        if (perDeposit > p || total > t) revert NotLower();
        _setLimit(asset, perDeposit, total);
    }

    function lowerDefaultLimit(uint128 perDepositBps, uint128 totalBps) external onlyOwner {
        Limit memory d = defaultLimitBps;
        if (perDepositBps > d.perDeposit || totalBps > d.total) revert NotLower();
        _setDefaultLimit(perDepositBps, totalBps);
    }

    function lowerAuctionLimit(uint128 perBid, uint128 total) external onlyOwner {
        Limit memory a = auctionLimit;
        if (perBid > a.perDeposit || total > a.total) revert NotLower();
        _setAuctionLimit(perBid, total);
    }

    // ───────────────────────────── timelock ─────────────────────────────

    function endSetup() external onlyOwner {
        if (!setupMode) revert AlreadyEnded();
        setupMode = false;
        emit SetupEnded();
    }

    /// @notice Announce a setter call (exact ABI encoding). It can run between eta and eta + CHANGE_GRACE.
    function queueChange(bytes calldata call) external onlyOwner returns (bytes32 id, uint256 eta) {
        if (setupMode) revert SetupActive();
        _validate(call);
        id = keccak256(call);
        uint256 cur = changeEta[id];
        if (cur != 0 && block.timestamp <= cur + CHANGE_GRACE) revert AlreadyQueued();
        eta = block.timestamp + CHANGE_DELAY;
        changeEta[id] = eta;
        emit ChangeQueued(id, call, eta);
    }

    function executeChange(bytes calldata call) external onlyOwner {
        bytes32 id = keccak256(call);
        uint256 eta = changeEta[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert NotReady();
        if (block.timestamp > eta + CHANGE_GRACE) revert Expired();
        delete changeEta[id];
        _apply(bytes4(call[:4]), call[4:]);
        emit ChangeExecuted(id);
    }

    function cancelChange(bytes calldata call) external onlyOwner {
        bytes32 id = keccak256(call);
        if (changeEta[id] == 0) revert NotQueued();
        delete changeEta[id];
        emit ChangeCancelled(id);
    }

    function _words(bytes4 s) internal pure returns (uint256) {
        if (s == this.setVerifier.selector) return 1;
        if (s == this.setFees.selector) return 3;
        if (s == this.setLimit.selector) return 3;
        if (s == this.setDefaultLimit.selector) return 2;
        if (s == this.setAuctionLimit.selector) return 2;
        if (s == this.setCapExempt.selector) return 2;
        if (s == this.addLaunchFactory.selector) return 1;
        if (s == this.approveAsset.selector) return 1;
        if (s == this.register.selector) return 4;
        return 0;
    }

    function _validate(bytes calldata call) internal pure {
        if (call.length < 4) revert UnknownChange();
        uint256 w = _words(bytes4(call[:4]));
        if (w == 0 || call.length != 4 + 32 * w) revert UnknownChange();
    }

    function _apply(bytes4 s, bytes calldata a) internal {
        if (s == this.setVerifier.selector) {
            _setVerifier(abi.decode(a, (address)));
        } else if (s == this.setFees.selector) {
            (uint16 w, uint16 l, address r) = abi.decode(a, (uint16, uint16, address));
            _setFees(w, l, r);
        } else if (s == this.setLimit.selector) {
            (address asset, uint128 p, uint128 t) = abi.decode(a, (address, uint128, uint128));
            _setLimit(asset, p, t);
        } else if (s == this.setDefaultLimit.selector) {
            (uint128 p, uint128 t) = abi.decode(a, (uint128, uint128));
            _setDefaultLimit(p, t);
        } else if (s == this.setAuctionLimit.selector) {
            (uint128 p, uint128 t) = abi.decode(a, (uint128, uint128));
            _setAuctionLimit(p, t);
        } else if (s == this.setCapExempt.selector) {
            (address account, bool exempt) = abi.decode(a, (address, bool));
            _setCapExempt(account, exempt);
        } else if (s == this.addLaunchFactory.selector) {
            _addLaunchFactory(abi.decode(a, (address)));
        } else if (s == this.approveAsset.selector) {
            _approveAsset(abi.decode(a, (address)));
        } else {
            (bytes32 kind, address addr, uint16 version, uint64 startBlock) =
                abi.decode(a, (bytes32, address, uint16, uint64));
            _register(kind, addr, version, startBlock);
        }
    }

    // ───────────────────────────── ownership (two-step) ─────────────────────────────

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _setVerifier(address v) internal {
        if (v == address(0)) revert ZeroAddress();
        verifier = v;
        emit VerifierSet(v);
    }

    function _setFees(uint16 w, uint16 l, address r) internal {
        if (w > MAX_WITHDRAW_FEE_BPS || l > MAX_LAUNCH_FEE_BPS) revert FeeTooHigh();
        if ((w != 0 || l != 0) && r == address(0)) revert ZeroAddress();
        withdrawFeeBps = w;
        launchFeeBps = l;
        feeRecipient = r;
        emit FeesSet(w, l, r);
    }

    function _setLimit(address asset, uint128 p, uint128 t) internal {
        _limit[asset] = Limit(p, t);
        hasLimit[asset] = true;
        emit LimitSet(asset, p, t);
    }

    function _setDefaultLimit(uint128 p, uint128 t) internal {
        if (p > 10_000 || t > 10_000) revert BadBps();
        defaultLimitBps = Limit(p, t);
        emit DefaultLimitSet(p, t);
    }

    function _setAuctionLimit(uint128 p, uint128 t) internal {
        auctionLimit = Limit(p, t);
        emit AuctionLimitSet(p, t);
    }

    function _setCapExempt(address account, bool exempt) internal {
        capExempt[account] = exempt;
        emit CapExemptSet(account, exempt);
    }

    function _addLaunchFactory(address factory) internal {
        if (factory == address(0)) revert ZeroAddress();
        if (isLaunchFactory[factory]) revert AlreadyAdded();
        isLaunchFactory[factory] = true;
        if (!_inList[factory]) {
            _inList[factory] = true;
            launchFactories.push(factory);
        }
        emit LaunchFactoryAdded(factory);
    }

    function _approveAsset(address token) internal {
        if (token == address(0)) revert ZeroAddress();
        approvedAsset[token] = true;
        emit AssetApproved(token);
    }

    function _register(bytes32 kind, address addr, uint16 version, uint64 startBlock) internal {
        if (addr == address(0)) revert ZeroAddress();
        if (startBlock > block.number) revert BadBlock();
        registry.push(Entry(kind, addr, version, startBlock));
        emit Registered(kind, addr, registry.length - 1);
    }
}
