// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";

interface IPoolState {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IErc20Info {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface ILaunchTokensE {
    function isLaunchToken(address token) external view returns (bool);
}

interface ILaunchpadCheck {
    /// @notice True if `token` was made by this launchpad's factory (an adapter Cloak writes per launchpad, reading the
    ///         launchpad's own registry).
    function isLaunchpadToken(address token) external view returns (bool);
}

/**
 * @title CloakEcosystemVault
 * @notice Cloak's vault for outside tokens (KNTQ, other launchpads' tokens, stocks): Gloam's ShieldPoolCore, unchanged,
 *         plus one way in. HYPE and USDC stay in Gloam's vault and Cloak's launch tokens in the launch vault;
 *         CloakRouterV4 trades between the three.
 *
 * Cloak vets code once and markets each time:
 *  - A launchpad is vetted once. The approver (Cloak's owner wallet) approves a checker for it, a small adapter that
 *    answers "did this launchpad's factory make this token?". Its tokens' code is then known.
 *  - Each token is listed by the approver at once, with no wait, if it comes from an approved launchpad (or is named
 *    directly, as a token vetted on its own, like KNTQ) and passes the fixed rules below. The approver picks which
 *    tokens matter; the rules cut off the small ones.
 *
 * The rules, checked at every listing:
 *  1. A market Cloak can trade: the pool is native HYPE / the token with no hook (the router routes it), and initialized.
 *  2. Liquidity: the pool's in-range HYPE is at least `minHypeLiquidity`.
 *  3. Market cap: the token's total supply at the pool's price is at least `minMcapHype` (in HYPE).
 *  4. Caps: per deposit at most `maxPerDepositBps`, and in total at most `maxTotalBps`, of the token's supply.
 * The approver can move 2 and 3 at any time (`setMarketRules`), up freely and down only as far as floors fixed at
 * deploy, so even a stolen approver key can't list a token with no market. The rest is fixed at deploy.
 *  5. The token: real code, 6 to 18 decimals, a supply under 2^128, never a Cloak launch token, not listed already.
 *
 * Once listed a token is never un-listed here (isEcosystemToken stays true, so the router always knows its vault),
 * but the owner can still lower or zero its caps at once (ShieldPoolCore.lowerDepositLimit), and withdrawals never
 * close. Removing a launchpad stops new listings from it. The pauser can stop all listings. Prices are spot reads of
 * the pool, so the approver's judgment is what keeps a token out; the rules make a bad listing expensive.
 */
contract CloakEcosystemVault is ShieldPoolCore {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev Uniswap v4 PoolManager's storage: `pools` is mapping slot 6; a pool's slot0 is its first word and its
    ///      liquidity its fourth (v4-core StateLibrary).
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    IPoolState public immutable poolManager;
    /// @notice Approves launchpads and lists tokens: Cloak's owner wallet.
    address public immutable approver;
    /// @notice Can pause listings and remove launchpads; can't touch funds or caps.
    address public immutable pauser;
    /// @notice Cloak's launch vault: its tokens never come here.
    ILaunchTokensE public immutable launchVault;
    /// @notice The HYPE a token's pool must hold in range, and its market cap in HYPE. The approver adjusts them.
    uint256 public minHypeLiquidity;
    uint256 public minMcapHype;
    /// @notice The lowest the two can ever be set (fixed at deploy).
    uint256 public immutable liquidityFloor;
    uint256 public immutable mcapFloor;
    uint16 public immutable maxPerDepositBps;
    uint16 public immutable maxTotalBps;

    mapping(address => PoolKey) internal _poolKeys;
    /// @notice Launchpad checkers the approver vetted.
    mapping(address => bool) public isApprovedLaunchpad;
    /// @notice Where a listed token came from: its launchpad's checker, or address(0) for a token vetted on its own.
    mapping(address => address) public launchpadOf;
    /// @notice Tokens listed through list() (never cleared).
    mapping(address => bool) public isEcosystemToken;
    address[] public ecosystemTokens;
    bool public admissionsPaused;

    event LaunchpadApproved(address indexed checker, string name);
    event LaunchpadRemoved(address indexed checker);
    event TokenListed(address indexed token, address indexed launchpad, uint128 perDeposit, uint128 total);
    event AdmissionsPaused(bool paused);
    event MarketRulesSet(uint256 minHypeLiquidity, uint256 minMcapHype);

    error NotApprover();
    error NotPauser();
    error NotFromLaunchpad();
    error AdmissionStopped();
    error AlreadyListed();
    error BadToken();
    error BadPool();
    error ThinLiquidity(uint256 hype, uint256 needed);
    error SmallMcap(uint256 mcapHype, uint256 needed);
    error CapsTooHigh();
    error BadRules();

    struct Rules {
        uint256 minHypeLiquidity;
        uint256 minMcapHype;
        uint256 liquidityFloor;
        uint256 mcapFloor;
        uint16 maxPerDepositBps;
        uint16 maxTotalBps;
    }

    constructor(
        address poseidon2_,
        address verifier_,
        address poolManager_,
        address launchVault_,
        address approver_,
        address pauser_,
        Rules memory r
    ) ShieldPoolCore(poseidon2_, verifier_) {
        if (poolManager_ == address(0) || approver_ == address(0) || pauser_ == address(0)) revert ZeroAddress();
        if (r.liquidityFloor == 0 || r.mcapFloor == 0 || r.minHypeLiquidity < r.liquidityFloor || r.minMcapHype < r.mcapFloor) revert BadRules();
        if (r.maxPerDepositBps == 0 || r.maxPerDepositBps > r.maxTotalBps || r.maxTotalBps > 10_000) revert BadRules();
        poolManager = IPoolState(poolManager_);
        launchVault = ILaunchTokensE(launchVault_);
        approver = approver_;
        pauser = pauser_;
        minHypeLiquidity = r.minHypeLiquidity;
        minMcapHype = r.minMcapHype;
        liquidityFloor = r.liquidityFloor;
        mcapFloor = r.mcapFloor;
        maxPerDepositBps = r.maxPerDepositBps;
        maxTotalBps = r.maxTotalBps;
    }

    // ── admission ──────────────────────────────────────────────────────

    /// @notice Vet a launchpad: its checker says which tokens its factory made. Only the approver.
    function approveLaunchpad(address checker, string calldata name) external {
        if (msg.sender != approver) revert NotApprover();
        if (checker.code.length == 0) revert BadToken();
        isApprovedLaunchpad[checker] = true;
        emit LaunchpadApproved(checker, name);
    }

    /// @notice Stop new listings from a launchpad (its listed tokens stay). The approver or the pauser.
    function removeLaunchpad(address checker) external {
        if (msg.sender != approver && msg.sender != pauser) revert NotPauser();
        isApprovedLaunchpad[checker] = false;
        emit LaunchpadRemoved(checker);
    }

    /**
     * @notice List `token` at once with its pool and caps. Only the approver. `launchpad` is the approved checker of the
     *         launchpad that made it, or address(0) for a token vetted on its own (KNTQ). The rules must pass.
     */
    function list(address token, PoolKey calldata key, uint128 perDeposit, uint128 total, address launchpad) external {
        if (msg.sender != approver) revert NotApprover();
        if (admissionsPaused) revert AdmissionStopped();
        if (launchpad != address(0)) {
            if (!isApprovedLaunchpad[launchpad] || !ILaunchpadCheck(launchpad).isLaunchpadToken(token)) revert NotFromLaunchpad();
        }
        _check(token, key, perDeposit, total);
        isEcosystemToken[token] = true;
        ecosystemTokens.push(token);
        _poolKeys[token] = key;
        launchpadOf[token] = launchpad;
        _setDepositLimit(token, perDeposit, total);
        emit TokenListed(token, launchpad, perDeposit, total);
    }

    /// @notice Move the liquidity and market-cap rules for future listings. Only the approver; never below the floors.
    ///         Tokens already listed aren't affected.
    function setMarketRules(uint256 minHypeLiquidity_, uint256 minMcapHype_) external {
        if (msg.sender != approver) revert NotApprover();
        if (minHypeLiquidity_ < liquidityFloor || minMcapHype_ < mcapFloor) revert BadRules();
        minHypeLiquidity = minHypeLiquidity_;
        minMcapHype = minMcapHype_;
        emit MarketRulesSet(minHypeLiquidity_, minMcapHype_);
    }

    function pauseAdmissions(bool paused) external {
        if (msg.sender != pauser) revert NotPauser();
        admissionsPaused = paused;
        emit AdmissionsPaused(paused);
    }

    // ── reads ──────────────────────────────────────────────────────────

    /// @notice The pool a listed token trades through (the router's route).
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _poolKeys[token];
    }

    function ecosystemTokensCount() external view returns (uint256) {
        return ecosystemTokens.length;
    }

    /// @notice The pool's price (sqrtPriceX96, token per HYPE) and in-range liquidity.
    function poolState(PoolKey memory key) public view returns (uint160 sqrtPriceX96, uint128 liquidity) {
        bytes32 id = keccak256(abi.encode(key));
        uint256 slot = uint256(keccak256(abi.encode(id, POOLS_SLOT)));
        sqrtPriceX96 = uint160(uint256(poolManager.extsload(bytes32(slot))));
        liquidity = uint128(uint256(poolManager.extsload(bytes32(slot + LIQUIDITY_OFFSET))));
    }

    /// @notice The HYPE in the pool's current range (amount0 = L / sqrtP), and the token's market cap in HYPE.
    function marketOf(address token, PoolKey memory key) public view returns (uint256 hypeLiquidity, uint256 mcapHype) {
        (uint160 sqrtP, uint128 liq) = poolState(key);
        if (sqrtP == 0) return (0, 0);
        hypeLiquidity = (uint256(liq) << 96) / sqrtP;
        // supply / price, with price = (sqrtP / 2^96)^2 tokens per HYPE; a supply under 2^128 keeps the first step safe
        uint256 supply = IErc20Info(token).totalSupply();
        uint256 a = (supply << 96) / sqrtP;
        mcapHype = a >= 2 ** 160 ? type(uint256).max : (a << 96) / sqrtP;
    }

    // ── internals ──────────────────────────────────────────────────────

    function _check(address token, PoolKey memory key, uint128 perDeposit, uint128 total) internal view {
        if (token == address(0) || token.code.length == 0) revert BadToken();
        if (isEcosystemToken[token]) revert AlreadyListed();
        DepositLimit memory cur = depositLimit[token];
        if (cur.perDeposit != 0 || cur.total != 0) revert AlreadyListed();
        if (address(launchVault) != address(0) && launchVault.isLaunchToken(token)) revert BadToken();
        uint8 dec = IErc20Info(token).decimals();
        uint256 supply = IErc20Info(token).totalSupply();
        if (dec < 6 || dec > 18 || supply == 0 || supply >= 2 ** 128) revert BadToken();
        if (key.currency0 != address(0) || key.currency1 != token || key.hooks != address(0)) revert BadPool();
        (uint256 hype, uint256 mcap) = marketOf(token, key);
        if (hype < minHypeLiquidity) revert ThinLiquidity(hype, minHypeLiquidity);
        if (mcap < minMcapHype) revert SmallMcap(mcap, minMcapHype);
        if (perDeposit == 0 || perDeposit > total) revert CapsTooHigh();
        if (uint256(perDeposit) * 10_000 > supply * maxPerDepositBps || uint256(total) * 10_000 > supply * maxTotalBps) revert CapsTooHigh();
    }

    /// @notice Deposits take shieldBound() only, as in Gloam's ShieldPoolPayments.
    function shield(address, uint256, bytes32) external payable override {
        revert ShieldProofRequired();
    }

    function _checkReadyToEndSetup() internal view override {
        if (address(verifier) == address(0) || address(shieldVerifier) == address(0)) revert VerifierNotSet();
        if (!depositLimitsOn) revert DepositLimitsOff();
    }

    function sealedSwapVerifier() external pure returns (address) {
        return address(0);
    }
}
