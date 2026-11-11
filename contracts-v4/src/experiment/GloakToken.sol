// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title GloakToken
 * @notice Cloak's one private-only token experiment (docs/GLOAK-EXPERIMENT.md). It is meant to live in private vaults
 *         and be traded only through private routers. Bringing it in and trading it privately are free; taking it out
 *         to a public address, or moving it between public addresses, burns a surcharge (10%, never raised).
 *
 *         The token keeps a list of approved contracts, each with roles:
 *          - RECEIVE  receives for free (vaults, routers, batch rounds, the hook);
 *          - SEND     sends to anyone for free (the launch's auction, which pays bidders; the hook);
 *          - FEED     may send into Uniswap's PoolManager (the hook, routers, batch rounds). Nobody else can, so nobody
 *                     outside the private zone can sell into a pool, add liquidity, or turn tokens into v4 claims;
 *          - SWAP     may swap in GLOAK's own pool (the hook asks canSwap): routers that always deliver into a vault;
 *          - VAULT    a private vault. Its withdrawals pay the surcharge, unless the recipient is a one-time swap
 *                     escrow that hands everything to a PAYEE in the same transaction (a private sell): then the
 *                     surcharge comes back to the PAYEE, so the swap gets the full amount;
 *          - PAYEE    a router or batch round that one-time escrows pay (it receives that refund).
 *
 *         The admin (Cloak's owner wallet) sets roles at once during setup. After endSetup, adding a role waits 3 days
 *         in public; removing one is instant. The surcharge can only be lowered. What the admin may grant is limited,
 *         in setup too: SEND never (only the launch's auction and the hook have it, from the constructor), and FEED or
 *         SWAP only to an address with code, since those open Uniswap. RECEIVE, VAULT and PAYEE may go to any address:
 *         they make arriving free, never leaving, so what an approved address sends on to a public one still pays.
 *
 * @dev The escrow refund uses transient storage (EIP-1153): what a vault's withdrawal burned is remembered for the rest
 *      of that transaction only, keyed by the recipient.
 */
contract GloakToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint8 public constant RECEIVE = 1;
    uint8 public constant SEND = 2;
    uint8 public constant FEED = 4;
    uint8 public constant SWAP = 8;
    uint8 public constant VAULT = 16;
    uint8 public constant PAYEE = 32;
    uint8 internal constant ALL_ROLES = 63;

    /// @notice The surcharge's ceiling: 10%. It starts there and can only go down.
    uint16 public constant MAX_SURCHARGE_BPS = 1_000;
    /// @notice How long a new role waits after setup.
    uint256 public constant ROLE_DELAY = 3 days;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 private constant OWED_DOMAIN = keccak256("gloak.exit-owed.v1");

    /// @notice Uniswap v4's PoolManager: only FEED contracts may send GLOAK into it.
    address public immutable poolManager;

    address public admin;
    address public pendingAdmin;
    bool public setupMode = true;
    uint16 public surchargeBps = MAX_SURCHARGE_BPS;
    /// @notice GLOAK burned by surcharges so far.
    uint256 public surchargeBurned;

    mapping(address => uint8) public rolesOf;
    /// @notice Every address that ever had a role (for the privacy meter).
    address[] public members;
    mapping(address => bool) internal _isMember;
    /// @notice A queued role change (keccak256(account, roles)) → when it may be applied.
    mapping(bytes32 => uint256) public queuedAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RolesSet(address indexed account, uint8 roles);
    event RolesQueued(address indexed account, uint8 roles, uint256 eta);
    event RolesCancelled(address indexed account, uint8 roles);
    event SetupEnded();
    event SurchargeLowered(uint16 bps);
    event Surcharged(address indexed from, address indexed to, uint256 burned);
    event SurchargeRefunded(address indexed escrow, address indexed payee, uint256 amount);
    event AdminOffered(address indexed to);
    event AdminChanged(address indexed to);

    error NotAdmin();
    error NotPrivate();
    error TimelockRequired();
    error NotQueued();
    error TooEarly();
    error SetupEnded_();
    error BadSurcharge();
    error BadRoles();
    /// @notice The admin can never grant SEND, and grants FEED or SWAP only to contracts.
    error RoleNotGrantable();
    error ZeroAddress();
    error Balance();
    error Allowance();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @param to, amounts the whole supply, as CloakToken mints it (the factory passes the launch's auction). Each holder
     *        here gets RECEIVE and SEND, so the auction can pay bidders and take back what the pool didn't use.
     * @param hook Cloak's v4 hook: it seeds the pool and collects its fees (RECEIVE, SEND, FEED).
     * @param zone, zoneRoles the private zone GLOAK is born with (the launch vault, the router, batch rounds, private
     *        bids), so nothing depends on approving them in time. The same limits as the admin's apply: no SEND, and
     *        FEED or SWAP only to contracts.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory to,
        uint256[] memory amounts,
        address admin_,
        address poolManager_,
        address hook,
        address[] memory zone,
        uint8[] memory zoneRoles
    ) {
        if (admin_ == address(0) || poolManager_ == address(0) || hook == address(0)) revert ZeroAddress();
        require(to.length == amounts.length && zone.length == zoneRoles.length, "len");
        name = name_;
        symbol = symbol_;
        admin = admin_;
        poolManager = poolManager_;
        for (uint256 i; i < to.length; ++i) {
            if (amounts[i] == 0) continue;
            _setRoles(to[i], RECEIVE | SEND);
            totalSupply += amounts[i];
            balanceOf[to[i]] += amounts[i];
            emit Transfer(address(0), to[i], amounts[i]);
        }
        _setRoles(hook, RECEIVE | SEND | FEED);
        for (uint256 i; i < zone.length; ++i) {
            if (zoneRoles[i] > ALL_ROLES) revert BadRoles();
            _checkGrant(zone[i], zoneRoles[i] & ~rolesOf[zone[i]]);
            _setRoles(zone[i], zoneRoles[i] | rolesOf[zone[i]]);
        }
    }

    // ───────────────────────────── ERC-20 ─────────────────────────────

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert Allowance();
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    // ───────────────────────────── the rule ─────────────────────────────

    /// @notice Whether `swapper` may swap in GLOAK's pool (asked by Cloak's v4 hook before every swap there).
    function canSwap(address swapper) external view returns (bool) {
        return rolesOf[swapper] & SWAP != 0;
    }

    /// @notice What a transfer of `value` from `from` to `to` would burn right now (ignoring a same-transaction refund).
    function surchargeOn(address from, address to, uint256 value) public view returns (uint256) {
        if (to == poolManager || to == DEAD) return 0;
        if (rolesOf[to] & RECEIVE != 0 || rolesOf[from] & SEND != 0) return 0;
        return (value * surchargeBps) / 10_000;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < value) revert Balance();
        uint8 rf = rolesOf[from];

        // into Uniswap: only the private zone's own contracts
        if (to == poolManager) {
            if (rf & FEED == 0) revert NotPrivate();
            _move(from, to, value);
            return;
        }

        uint8 rt = rolesOf[to];
        if (to == DEAD || rt & RECEIVE != 0) {
            _move(from, to, value);
            // a one-time escrow handing all of a vault withdrawal to a router or batch round: give back what it burned
            if (rt & PAYEE != 0 && balanceOf[from] == 0) {
                uint256 owed = _owed(from);
                if (owed != 0) {
                    _setOwed(from, 0);
                    surchargeBurned -= owed;
                    totalSupply += owed;
                    balanceOf[to] += owed;
                    emit Transfer(address(0), to, owed);
                    emit SurchargeRefunded(from, to, owed);
                }
            }
            return;
        }
        if (rf & SEND != 0) {
            _move(from, to, value);
            return;
        }

        // out of the private zone, or between public addresses
        uint256 burned = (value * surchargeBps) / 10_000;
        _move(from, to, value - burned);
        if (burned != 0) {
            balanceOf[from] -= burned;
            totalSupply -= burned;
            surchargeBurned += burned;
            emit Transfer(from, address(0), burned);
            emit Surcharged(from, to, burned);
            if (rf & VAULT != 0) _setOwed(to, _owed(to) + burned);
        }
    }

    function _move(address from, address to, uint256 value) private {
        unchecked {
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _owedSlot(address a) private pure returns (bytes32) {
        return keccak256(abi.encode(OWED_DOMAIN, a));
    }

    function _owed(address a) private view returns (uint256 v) {
        bytes32 s = _owedSlot(a);
        assembly {
            v := tload(s)
        }
    }

    function _setOwed(address a, uint256 v) private {
        bytes32 s = _owedSlot(a);
        assembly {
            tstore(s, v)
        }
    }

    // ───────────────────────────── the privacy meter ─────────────────────────────

    /**
     * @notice Where GLOAK is: in private vaults, in Uniswap's PoolManager (the pool), in other approved contracts,
     *         burned at 0x…dEaD, and in public addresses (the rest). `privateBps` is the vaults' share of everything not
     *         burned, in basis points.
     */
    function meter()
        external
        view
        returns (uint256 inVaults, uint256 inPool, uint256 inContracts, uint256 atDead, uint256 inPublic, uint256 privateBps)
    {
        for (uint256 i; i < members.length; ++i) {
            address m = members[i];
            if (m == poolManager || m == DEAD) continue;
            if (rolesOf[m] & VAULT != 0) inVaults += balanceOf[m];
            else inContracts += balanceOf[m];
        }
        inPool = balanceOf[poolManager];
        atDead = balanceOf[DEAD];
        inPublic = totalSupply - inVaults - inPool - inContracts - atDead;
        uint256 live = totalSupply - atDead;
        privateBps = live == 0 ? 0 : (inVaults * 10_000) / live;
    }

    function membersCount() external view returns (uint256) {
        return members.length;
    }

    // ───────────────────────────── admin ─────────────────────────────

    /// @notice Set `account`'s roles. In setup: at once. After: at once only if it removes roles; adding waits (queueRoles).
    function setRoles(address account, uint8 roles) external onlyAdmin {
        if (roles > ALL_ROLES) revert BadRoles();
        uint8 added = roles & ~rolesOf[account];
        if (added != 0) {
            if (!setupMode) revert TimelockRequired();
            _checkGrant(account, added);
        }
        _setRoles(account, roles);
    }

    /// @notice After setup: announce a role change that adds roles; it may be applied ROLE_DELAY later.
    function queueRoles(address account, uint8 roles) external onlyAdmin returns (uint256 eta) {
        if (roles > ALL_ROLES || account == address(0)) revert BadRoles();
        if (roles & SEND & ~rolesOf[account] != 0) revert RoleNotGrantable();
        eta = block.timestamp + ROLE_DELAY;
        queuedAt[keccak256(abi.encode(account, roles))] = eta;
        emit RolesQueued(account, roles, eta);
    }

    function applyRoles(address account, uint8 roles) external onlyAdmin {
        bytes32 id = keccak256(abi.encode(account, roles));
        uint256 eta = queuedAt[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly();
        delete queuedAt[id];
        _checkGrant(account, roles & ~rolesOf[account]);
        _setRoles(account, roles);
    }

    /// @dev What the admin may add: never SEND; FEED and SWAP only to a contract (checked when applied).
    function _checkGrant(address account, uint8 added) private view {
        if (added & SEND != 0) revert RoleNotGrantable();
        if (added & (FEED | SWAP) != 0 && account.code.length == 0) revert RoleNotGrantable();
    }

    function cancelRoles(address account, uint8 roles) external onlyAdmin {
        bytes32 id = keccak256(abi.encode(account, roles));
        if (queuedAt[id] == 0) revert NotQueued();
        delete queuedAt[id];
        emit RolesCancelled(account, roles);
    }

    /// @notice End setup, for good: from now on, new roles wait ROLE_DELAY in public.
    function endSetup() external onlyAdmin {
        if (!setupMode) revert SetupEnded_();
        setupMode = false;
        emit SetupEnded();
    }

    /// @notice Lower the surcharge (never raise it).
    function lowerSurcharge(uint16 bps) external onlyAdmin {
        if (bps >= surchargeBps) revert BadSurcharge();
        surchargeBps = bps;
        emit SurchargeLowered(bps);
    }

    function offerAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminOffered(to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminChanged(msg.sender);
    }

    /// @notice Give up the admin for good: roles and the surcharge are then frozen as they are.
    function renounceAdmin() external onlyAdmin {
        admin = address(0);
        pendingAdmin = address(0);
        emit AdminChanged(address(0));
    }

    function _setRoles(address account, uint8 roles) private {
        if (account == address(0)) revert ZeroAddress();
        rolesOf[account] = roles;
        if (!_isMember[account]) {
            _isMember[account] = true;
            members.push(account);
        }
        emit RolesSet(account, roles);
    }
}

/// @notice The door's maker: CloakVestingDeployer's one-time door calls make() for the GLOAK launch.
/// @dev The private zone is fixed here, at the maker's deploy, so GLOAK is born with it: the launch vault (Receive,
///      Vault), the router (Receive, Feed, Swap, Payee), batch rounds (Receive, Feed, Payee) and private bids (Receive).
contract GloakMaker {
    address public immutable door;
    address public immutable admin;
    address public immutable poolManager;
    address public immutable hook;
    address[] internal _zone;
    uint8[] internal _zoneRoles;

    constructor(address door_, address admin_, address poolManager_, address hook_, address[] memory zone, uint8[] memory zoneRoles) {
        require(zone.length == zoneRoles.length, "len");
        door = door_;
        admin = admin_;
        poolManager = poolManager_;
        hook = hook_;
        _zone = zone;
        _zoneRoles = zoneRoles;
    }

    /// @notice The contracts GLOAK will be born approved, and their roles.
    function zone() external view returns (address[] memory, uint8[] memory) {
        return (_zone, _zoneRoles);
    }

    function make(string calldata name, string calldata symbol, address[] calldata to, uint256[] calldata amounts)
        external
        returns (address)
    {
        require(msg.sender == door, "door only");
        return address(new GloakToken(name, symbol, to, amounts, admin, poolManager, hook, _zone, _zoneRoles));
    }
}
