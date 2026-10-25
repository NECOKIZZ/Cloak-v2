// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";
import {IPoseidon2, IPoseidon3} from "./interfaces/IHasher.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";
import {CloakConfig} from "../CloakConfig.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title ShieldedPool — private balances for ONE ERC-20 (one pool per asset: WHYPE, each launch token).
/// @notice Notes are commitments Poseidon(amount, pubKey, blinding) in a depth-20 tree;
///         `transact` spends 2 notes and creates 2 with a Groth16 proof (2-in/2-out), and can also deposit
///         (extAmount > 0) or withdraw (extAmount < 0) to `recipient`.
///
///         `ExtData.data` — opaque bytes bound into `extDataHash`, so whatever a contract
///         recipient does with a withdrawal (the PrivateRouter: swap into another pool) is fixed by the proof and a
///         relayer cannot alter it.
///
///         Rules come from `CloakConfig` (setup, then a public 3-day timelock):
///           - Deposits and private transfers are free. Every withdrawal (a cash out, a private swap, a batch order)
///             keeps `withdrawFeeBps` of the amount in the pool as `feesOwed`; `collectFees()` sends it to the treasury.
///           - Deposits are capped per deposit and in total while limits are on. Withdrawals are never capped.
/// @dev No function moves user funds: notes leave only through a proof. Invariant:
///      token.balanceOf(pool) >= deposited + feesOwed.
contract ShieldedPool is MerkleTreeWithHistory {
    int256 public constant MAX_EXT_AMOUNT = 2 ** 120;
    uint256 public constant MAX_FEE = 2 ** 120;
    uint256 public constant MAX_NOTE_AMOUNT = 2 ** 128; // matches Num2Bits(128) in the circuit

    CloakConfig public immutable config;
    IPoseidon3 public immutable hasher3;
    IERC20 public immutable token;

    mapping(uint256 => bool) public nullifierHashes;
    uint256 public deposited; // value backing notes
    uint256 public feesOwed; // withdrawal fees waiting for collectFees()
    uint256 private _lock = 1;

    struct ExtData {
        address recipient; // withdrawal recipient (0 if none)
        int256 extAmount; // > 0 deposit, < 0 withdrawal, 0 private transfer
        address relayer; // gets `fee` (0 if none)
        uint256 fee; // paid out of the pool in `token` to `relayer`
        bytes encryptedOutput1;
        bytes encryptedOutput2;
        bytes data; // instructions for a contract recipient, bound by the proof
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b; // Solidity order (G2 coordinates swapped vs snarkjs JSON)
        uint256[2] c;
        uint256 root;
        uint256 publicAmount;
        uint256 extDataHash;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    event NewCommitment(uint256 commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(uint256 nullifier);
    event WithdrawFee(uint256 fee);
    event FeesCollected(address indexed to, uint256 amount);

    error Reentrancy();
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

    constructor(CloakConfig config_, IPoseidon2 hasher2_, IPoseidon3 hasher3_, IERC20 token_)
        MerkleTreeWithHistory(hasher2_)
    {
        config = config_;
        hasher3 = hasher3_;
        token = token_;
    }

    function transact(Proof calldata proof, ExtData calldata extData) external nonReentrant {
        if (extData.extAmount > 0) {
            uint256 amount = uint256(extData.extAmount);
            _checkLimit(amount);
            _pull(msg.sender, amount);
            deposited += amount;
        }

        _transact(proof, extData);

        if (extData.fee > 0) {
            if (extData.relayer == address(0)) revert ZeroRelayer();
            deposited -= extData.fee;
            _send(extData.relayer, extData.fee);
        }
        if (extData.extAmount < 0) {
            if (extData.recipient == address(0)) revert ZeroRecipient();
            uint256 amount = uint256(-extData.extAmount);
            uint256 fee = config.withdrawFee(amount);
            deposited -= amount;
            if (fee != 0) {
                feesOwed += fee;
                emit WithdrawFee(fee);
            }
            _send(extData.recipient, amount - fee);
        }
    }

    /// @notice What a withdrawal of `amount` actually pays its recipient after the protocol fee.
    function afterFee(uint256 amount) external view returns (uint256) {
        return amount - config.withdrawFee(amount);
    }

    /// @notice Send owed withdrawal fees to the treasury. Anyone may call it; the destination is fixed by the config.
    function collectFees() external nonReentrant {
        address to = config.feeRecipient();
        if (to == address(0)) revert ZeroRecipient();
        uint256 amount = feesOwed;
        if (amount == 0) revert NothingToCollect();
        feesOwed = 0;
        _send(to, amount);
        emit FeesCollected(to, amount);
    }

    /// @notice Create a note for `pubKey` from the caller's tokens. No proof: the pool hashes the commitment itself, so
    ///         `amount` is exactly what was paid in. Reveals that `pubKey` received `amount` — clients use a one-time
    ///         pubKey for every public entry, so nothing links back to the user's other notes.
    function depositTo(uint256 pubKey, uint256 amount, uint256 blinding, bytes calldata encryptedOutput)
        external
        nonReentrant
        returns (uint256 commitment, uint256 index)
    {
        if (amount == 0 || amount >= MAX_NOTE_AMOUNT) revert InvalidNote();
        if (pubKey >= FIELD_SIZE || blinding >= FIELD_SIZE) revert ValueOutOfField();
        _checkLimit(amount);
        _pull(msg.sender, amount);
        deposited += amount;
        commitment = hasher3.poseidon([amount, pubKey, blinding]);
        index = _insert(commitment);
        emit NewCommitment(commitment, index, encryptedOutput);
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
        uint256[7] memory pub = [
            p.root,
            p.publicAmount,
            p.extDataHash,
            p.inputNullifiers[0],
            p.inputNullifiers[1],
            p.outputCommitments[0],
            p.outputCommitments[1]
        ];
        return IVerifier(config.verifier()).verifyProof(p.a, p.b, p.c, pub);
    }

    /// @dev Deposit caps (off until the config turns them on). Cloak's own contracts move money already inside Cloak.
    function _checkLimit(uint256 amount) internal view {
        (bool on, uint256 perDeposit, uint256 total) = config.limitOf(address(token));
        if (!on || config.capExempt(msg.sender)) return;
        if (amount > perDeposit || deposited + amount > total) revert OverDepositLimit();
    }

    function _pull(address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
        if (token.balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
    }

    function _send(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
