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

/**
 * @title CloakEcosystemVault
 * @notice Cloak's vault for outside ecosystem tokens (KNTQ, other launchpads' tokens, stocks): Gloam's ShieldPoolCore,
 *         unchanged, plus one way in for a token: a proposal by Cloak's approver (the Safe) that passes preset rules
 *         twice, when proposed and again when admitted after a delay. HYPE and USDC stay in Gloam's vault and Cloak's
 *         launch tokens in the launch vault; CloakRouterV4 trades between the three.
 *
 * The rules are fixed at deploy, and nobody can change them:
 *  1. Approval: only the approver proposes a token, with its Uniswap v4 pool and its deposit caps.
 *  2. A market Cloak can trade: the pool is native HYPE / the token with no hook (the router routes it), and initialized.
 *  3. Liquidity: the pool's in-range HYPE is at least `minHypeLiquidity`.
 *  4. Market cap: the token's total supply at the pool's price is at least `minMcapHype` (in HYPE).
 *  5. Caps: per deposit at most `maxPerDepositBps`, and in total at most `maxTotalBps`, of the token's supply.
 *  6. The token: real code, 6 to 18 decimals, a supply under 2^128, never a Cloak launch token, not listed already.
 *  7. Time: admit() runs at least `admitDelay` after the proposal and checks 2 to 6 again, so a pool pushed for one
 *     block doesn't get a token in; the approver (or the pauser) can cancel any proposal meanwhile.
 *
 * Once admitted a token is never un-listed here (isEcosystemToken stays true, so the router always knows its vault),
 * but the owner can still lower or zero its caps at once (ShieldPoolCore.lowerDepositLimit), and withdrawals never
 * close. Prices are spot reads of the pool at two moments, so the approval and the delay are what keep a token out;
 * the rules make a bad listing expensive, not impossible.
 */
contract CloakEcosystemVault is ShieldPoolCore {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct Proposal {
        PoolKey key;
        uint128 perDeposit;
        uint128 total;
        uint64 readyAt;
    }

    /// @dev Uniswap v4 PoolManager's storage: `pools` is mapping slot 6; a pool's slot0 is its first word and its
    ///      liquidity its fourth (v4-core StateLibrary).
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    IPoolState public immutable poolManager;
    /// @notice Proposes and cancels tokens: Cloak's Safe.
    address public immutable approver;
    /// @notice Can cancel proposals and pause admissions; can't touch funds or caps.
    address public immutable pauser;
    /// @notice Cloak's launch vault: its tokens never come here.
    ILaunchTokensE public immutable launchVault;
    uint256 public immutable minHypeLiquidity;
    uint256 public immutable minMcapHype;
    uint64 public immutable admitDelay;
    uint16 public immutable maxPerDepositBps;
    uint16 public immutable maxTotalBps;

    mapping(address => Proposal) internal _proposals;
    mapping(address => PoolKey) internal _poolKeys;
    /// @notice Tokens admitted through admit() (never cleared).
    mapping(address => bool) public isEcosystemToken;
    address[] public ecosystemTokens;
    bool public admissionsPaused;

    event TokenProposed(address indexed token, uint256 readyAt, uint128 perDeposit, uint128 total);
    event TokenCancelled(address indexed token);
    event TokenAdmitted(address indexed token, uint128 perDeposit, uint128 total);
    event AdmissionsPaused(bool paused);

    error NotApprover();
    error NotPauser();
    error NoProposal();
    error NotReady();
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
        uint64 admitDelay;
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
        if (r.minHypeLiquidity == 0 || r.minMcapHype == 0 || r.admitDelay == 0) revert BadRules();
        if (r.maxPerDepositBps == 0 || r.maxPerDepositBps > r.maxTotalBps || r.maxTotalBps > 10_000) revert BadRules();
        poolManager = IPoolState(poolManager_);
        launchVault = ILaunchTokensE(launchVault_);
        approver = approver_;
        pauser = pauser_;
        minHypeLiquidity = r.minHypeLiquidity;
        minMcapHype = r.minMcapHype;
        admitDelay = r.admitDelay;
        maxPerDepositBps = r.maxPerDepositBps;
        maxTotalBps = r.maxTotalBps;
    }

    // ── admission ──────────────────────────────────────────────────────

    /// @notice Propose `token` with its pool and caps. Only the approver; the rules must already pass.
    function propose(address token, PoolKey calldata key, uint128 perDeposit, uint128 total) external {
        if (msg.sender != approver) revert NotApprover();
        _check(token, key, perDeposit, total);
        uint64 readyAt = uint64(block.timestamp) + admitDelay;
        _proposals[token] = Proposal(key, perDeposit, total, readyAt);
        emit TokenProposed(token, readyAt, perDeposit, total);
    }

    /// @notice Drop a proposal. The approver or the pauser.
    function cancel(address token) external {
        if (msg.sender != approver && msg.sender != pauser) revert NotPauser();
        if (_proposals[token].readyAt == 0) revert NoProposal();
        delete _proposals[token];
        emit TokenCancelled(token);
    }

    /// @notice Admit a proposed token once its delay has passed and the rules still hold. Anyone may call it.
    function admit(address token) external {
        Proposal memory p = _proposals[token];
        if (p.readyAt == 0) revert NoProposal();
        if (block.timestamp < p.readyAt) revert NotReady();
        if (admissionsPaused) revert AdmissionStopped();
        _check(token, p.key, p.perDeposit, p.total);
        delete _proposals[token];
        isEcosystemToken[token] = true;
        ecosystemTokens.push(token);
        _poolKeys[token] = p.key;
        _setDepositLimit(token, p.perDeposit, p.total);
        emit TokenAdmitted(token, p.perDeposit, p.total);
    }

    function pauseAdmissions(bool paused) external {
        if (msg.sender != pauser) revert NotPauser();
        admissionsPaused = paused;
        emit AdmissionsPaused(paused);
    }

    // ── reads ──────────────────────────────────────────────────────────

    function proposalOf(address token) external view returns (Proposal memory) {
        return _proposals[token];
    }

    /// @notice The pool an admitted token trades through (the router's route).
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
