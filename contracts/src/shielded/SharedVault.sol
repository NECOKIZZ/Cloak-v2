// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";
import {IPoseidon2} from "./interfaces/IHasher.sol";
import {CloakConfig} from "../CloakConfig.sol";
import {IERC20} from "./ShieldedPool.sol";

/// circomlibjs `poseidonContract.createCode(4)` bytecode. Same constants as circomlib's Poseidon(4).
interface IPoseidon4 {
    function poseidon(uint256[4] memory input) external pure returns (uint256);
}

/// Groth16 verifier for the shared-vault circuit (transactionMA2x2, 8 public signals).
interface IVerifierMA {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[8] calldata _pubSignals
    ) external view returns (bool);
}

interface ISharedLaunchFactory {
    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc);
}

interface ISharedLaunchAuction {
    function settled() external view returns (bool);
    function failed() external view returns (bool);
    function pair() external view returns (address); // the CloakV2Market in front of the launch's Uniswap V2 pool
    function uniPair() external view returns (address);
}

interface IVaultList {
    function poolOf(address token) external view returns (address);
}

/// @title SharedVault — one private vault for every Cloak launch token that opens on Uniswap from now on.
/// @notice One Merkle tree holds notes of many tokens. A note is Poseidon(amount, pubKey, blinding, asset), where asset is
///         the token's address, and one proof only ever spends and creates notes of a single token (transactionMA
///         circuit), so value can never move from one token to another.
///
///         What stays hidden: a private send inside the vault that pays no fee here (extAmount 0, fee 0) proves with
///         publicAsset = 0, so nobody can tell which token moved. Its relayer is paid from the sender's HYPE vault in
///         the same transaction (SharedRouter.send). Anything that moves tokens in or out (deposit, withdrawal, swap,
///         relayer fee) names its token publicly, as it must: the vault has to know what to pay out.
///
///         Safety, twice over:
///           - in the circuit, one token per proof;
///           - in the contract, a separate balance per token. A withdrawal of token X can only take from what was
///             deposited as X (`deposited[X]`), so even a broken proof could never touch another token's money.
///         Only launches from a factory registered in CloakConfig, settled with a Uniswap V2 pool and without a vault
///         of their own in CloakVaults, can be admitted, so the vault only ever holds Cloak's own fixed-supply tokens.
///         HYPE and USDC keep their own vaults.
/// @dev Fees and caps work like ShieldedPool's, per token. No owner, no function that moves funds without a proof.
contract SharedVault is MerkleTreeWithHistory {
    int256 public constant MAX_EXT_AMOUNT = 2 ** 120;
    uint256 public constant MAX_FEE = 2 ** 120;
    uint256 public constant MAX_NOTE_AMOUNT = 2 ** 128;

    CloakConfig public immutable config;
    IPoseidon4 public immutable hasher4;
    IVerifierMA public immutable verifier;
    IVaultList public immutable vaults; // CloakVaults: a token with its own vault there can't also be admitted here

    mapping(uint256 => bool) public nullifierHashes;
    mapping(address => bool) public admitted;
    mapping(address => address) public marketOf; // token → CloakV2Market of its launch
    mapping(address => uint256) public deposited; // per token: value backing its notes
    mapping(address => uint256) public feesOwed; // per token: withdrawal fees waiting for collectFees
    address[] public tokens;
    uint256 private _lock = 1;

    struct ExtData {
        address recipient;
        int256 extAmount; // > 0 deposit, < 0 withdrawal, 0 private send
        address relayer;
        uint256 fee; // paid in the note's token to `relayer`
        bytes encryptedOutput1;
        bytes encryptedOutput2;
        bytes data; // instructions for a contract recipient (SharedRouter), bound by the proof
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256 publicAmount;
        uint256 extDataHash;
        uint256 publicAsset; // the token's address as a number, or 0 for a hidden private send
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    event Admitted(address indexed token, address market, uint256 index);
    event NewCommitment(uint256 commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(uint256 nullifier);
    event Deposit(address indexed token, uint256 amount);
    event Withdrawal(address indexed token, uint256 amount);
    event WithdrawFee(address indexed token, uint256 fee);
    event FeesCollected(address indexed token, address indexed to, uint256 amount);

    error Reentrancy();
    error UnknownFactory();
    error NotLaunched();
    error NotUniswap();
    error HasOwnVault();
    error AlreadyAdmitted();
    error NotAdmitted();
    error HiddenAssetMustBeFree();
    error UnknownRoot();
    error NullifierAlreadySpent();
    error BadExtDataHash();
    error BadPublicAmount();
    error InvalidProof();
    error InvalidExtAmount();
    error InvalidFee();
    error ZeroRecipient();
    error ZeroRelayer();
    error FeeOnTransferToken();
    error InvalidNote();
    error TransferFailed();
    error OverDepositLimit();
    error NothingToCollect();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(CloakConfig config_, IPoseidon2 hasher2_, IPoseidon4 hasher4_, IVerifierMA verifier_, IVaultList vaults_)
        MerkleTreeWithHistory(hasher2_)
    {
        config = config_;
        hasher4 = hasher4_;
        verifier = verifier_;
        vaults = vaults_;
    }

    function tokensCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @notice Let a settled launch's token into the vault. Anyone can call it.
    function admit(ISharedLaunchFactory factory, uint256 launchIndex) external {
        if (!config.isLaunchFactory(address(factory))) revert UnknownFactory();
        (address auction, address token,,,) = factory.launches(launchIndex);
        ISharedLaunchAuction a = ISharedLaunchAuction(auction);
        if (!a.settled() || a.failed()) revert NotLaunched();
        if (a.uniPair() == address(0)) revert NotUniswap();
        if (vaults.poolOf(token) != address(0)) revert HasOwnVault();
        if (admitted[token]) revert AlreadyAdmitted();
        admitted[token] = true;
        marketOf[token] = a.pair();
        tokens.push(token);
        emit Admitted(token, a.pair(), tokens.length - 1);
    }

    function transact(Proof calldata proof, ExtData calldata extData) external nonReentrant {
        address token;
        if (extData.extAmount != 0 || extData.fee != 0) {
            // tokens move in or out: the proof must name the token, and it must be one this vault holds
            if (proof.publicAsset >> 160 != 0) revert NotAdmitted();
            token = address(uint160(proof.publicAsset));
            if (!admitted[token]) revert NotAdmitted();
        } else if (proof.publicAsset != 0) {
            // a free private send may name its token, but then it must be a real one
            if (proof.publicAsset >> 160 != 0 || !admitted[address(uint160(proof.publicAsset))]) revert NotAdmitted();
        }

        if (extData.extAmount > 0) {
            uint256 amount = uint256(extData.extAmount);
            _checkLimit(token, amount);
            _pull(token, msg.sender, amount);
            deposited[token] += amount;
            emit Deposit(token, amount);
        }

        _transact(proof, extData);

        if (extData.fee > 0) {
            if (extData.relayer == address(0)) revert ZeroRelayer();
            // the relayer's fee leaves the vault too, so it pays the same protocol fee as a withdrawal
            uint256 pf = config.withdrawFee(extData.fee);
            deposited[token] -= extData.fee;
            if (pf != 0) {
                feesOwed[token] += pf;
                emit WithdrawFee(token, pf);
            }
            _send(token, extData.relayer, extData.fee - pf);
        }
        if (extData.extAmount < 0) {
            if (extData.recipient == address(0)) revert ZeroRecipient();
            uint256 amount = uint256(-extData.extAmount);
            uint256 fee = config.withdrawFee(amount);
            deposited[token] -= amount; // per-token guard: never more than was put in as this token
            if (fee != 0) {
                feesOwed[token] += fee;
                emit WithdrawFee(token, fee);
            }
            _send(token, extData.recipient, amount - fee);
            emit Withdrawal(token, amount);
        }
    }

    /// @notice Create a note of `token` for `pubKey` from the caller's tokens. The vault hashes the commitment itself,
    ///         so the note is exactly what was paid in. Reveals that `pubKey` received `amount` of `token`; clients use a
    ///         one-time pubKey for every public entry.
    function depositTo(address token, uint256 pubKey, uint256 amount, uint256 blinding, bytes calldata encryptedOutput)
        external
        nonReentrant
        returns (uint256 commitment, uint256 index)
    {
        if (!admitted[token]) revert NotAdmitted();
        if (amount == 0 || amount >= MAX_NOTE_AMOUNT) revert InvalidNote();
        if (pubKey >= FIELD_SIZE || blinding >= FIELD_SIZE) revert ValueOutOfField();
        _checkLimit(token, amount);
        _pull(token, msg.sender, amount);
        deposited[token] += amount;
        commitment = hasher4.poseidon([amount, pubKey, blinding, uint256(uint160(token))]);
        index = _insert(commitment);
        emit Deposit(token, amount);
        emit NewCommitment(commitment, index, encryptedOutput);
    }

    /// @notice What a withdrawal of `amount` actually pays after the protocol fee.
    function afterFee(uint256 amount) external view returns (uint256) {
        return amount - config.withdrawFee(amount);
    }

    /// @notice Send `token`'s owed withdrawal fees to the treasury. Anyone may call it.
    function collectFees(address token) external nonReentrant {
        address to = config.feeRecipient();
        if (to == address(0)) revert ZeroRecipient();
        uint256 amount = feesOwed[token];
        if (amount == 0) revert NothingToCollect();
        feesOwed[token] = 0;
        _send(token, to, amount);
        emit FeesCollected(token, to, amount);
    }

    function calculatePublicAmount(int256 extAmount, uint256 fee) public pure returns (uint256) {
        if (fee >= MAX_FEE) revert InvalidFee();
        if (extAmount <= -MAX_EXT_AMOUNT || extAmount >= MAX_EXT_AMOUNT) revert InvalidExtAmount();
        int256 publicAmount = extAmount - int256(fee);
        return publicAmount >= 0 ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
    }

    function hashExtData(ExtData calldata extData) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(extData))) % FIELD_SIZE;
    }

    function isSpent(uint256 nullifierHash) external view returns (bool) {
        return nullifierHashes[nullifierHash];
    }

    function _transact(Proof calldata proof, ExtData calldata extData) internal {
        if (!isKnownRoot(proof.root)) revert UnknownRoot();
        if (proof.inputNullifiers[0] == proof.inputNullifiers[1]) revert NullifierAlreadySpent();
        for (uint256 i = 0; i < 2; i++) {
            if (nullifierHashes[proof.inputNullifiers[i]]) revert NullifierAlreadySpent();
        }
        if (proof.extDataHash != hashExtData(extData)) revert BadExtDataHash();
        if (proof.publicAmount != calculatePublicAmount(extData.extAmount, extData.fee)) revert BadPublicAmount();
        if (!_verify(proof)) revert InvalidProof();

        for (uint256 i = 0; i < 2; i++) {
            nullifierHashes[proof.inputNullifiers[i]] = true;
            emit NewNullifier(proof.inputNullifiers[i]);
        }
        uint256 i0 = _insert(proof.outputCommitments[0]);
        uint256 i1 = _insert(proof.outputCommitments[1]);
        emit NewCommitment(proof.outputCommitments[0], i0, extData.encryptedOutput1);
        emit NewCommitment(proof.outputCommitments[1], i1, extData.encryptedOutput2);
    }

    function _verify(Proof calldata p) internal view returns (bool) {
        uint256[8] memory pub = [
            p.root,
            p.publicAmount,
            p.extDataHash,
            p.publicAsset,
            p.inputNullifiers[0],
            p.inputNullifiers[1],
            p.outputCommitments[0],
            p.outputCommitments[1]
        ];
        return verifier.verifyProof(p.a, p.b, p.c, pub);
    }

    function _checkLimit(address token, uint256 amount) internal view {
        (bool on, uint256 perDeposit, uint256 total) = config.limitOf(token);
        if (!on || config.capExempt(msg.sender)) return;
        if (amount > perDeposit || deposited[token] + amount > total) revert OverDepositLimit();
    }

    function _pull(address token, address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transferFrom(from, address(this), amount)) revert TransferFailed();
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
    }

    function _send(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
