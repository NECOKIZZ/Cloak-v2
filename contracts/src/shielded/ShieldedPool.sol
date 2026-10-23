// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";
import {IPoseidon2, IPoseidon3} from "./interfaces/IHasher.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";

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
/// @dev No owner, no pause, no admin: nobody can move pooled funds.
contract ShieldedPool is MerkleTreeWithHistory {
    int256 public constant MAX_EXT_AMOUNT = 2 ** 120;
    uint256 public constant MAX_FEE = 2 ** 120;
    uint256 public constant MAX_NOTE_AMOUNT = 2 ** 128; // matches Num2Bits(128) in the circuit

    IVerifier public immutable verifier;
    IPoseidon3 public immutable hasher3;
    IERC20 public immutable token;

    mapping(uint256 => bool) public nullifierHashes;
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

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IVerifier verifier_, IPoseidon2 hasher2_, IPoseidon3 hasher3_, IERC20 token_)
        MerkleTreeWithHistory(hasher2_)
    {
        verifier = verifier_;
        hasher3 = hasher3_;
        token = token_;
    }

    function transact(Proof calldata proof, ExtData calldata extData) external nonReentrant {
        if (extData.extAmount > 0) _pull(msg.sender, uint256(extData.extAmount));

        _transact(proof, extData);

        if (extData.extAmount < 0) {
            if (extData.recipient == address(0)) revert ZeroRecipient();
            _send(extData.recipient, uint256(-extData.extAmount));
        }
        if (extData.fee > 0) {
            if (extData.relayer == address(0)) revert ZeroRelayer();
            _send(extData.relayer, extData.fee);
        }
    }

    /// @notice Create a note for `pubKey` from the caller's tokens. No proof: the pool hashes the commitment itself, so
    ///         `amount` is exactly what was paid in. Reveals that `pubKey` received `amount` — clients use a one-time
    ///         pubKey for every public entry, so nothing links back to the user's other notes.
    function depositTo(uint256 pubKey, uint256 amount, uint256 blinding, bytes calldata encryptedOutput)
        external
        nonReentrant
        returns (uint256 commitment, uint32 index)
    {
        if (amount == 0 || amount >= MAX_NOTE_AMOUNT) revert InvalidNote();
        if (pubKey >= FIELD_SIZE || blinding >= FIELD_SIZE) revert ValueOutOfField();
        _pull(msg.sender, amount);
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
        uint32 i0 = _insert(proof.outputCommitments[0]);
        uint32 i1 = _insert(proof.outputCommitments[1]);
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
        return verifier.verifyProof(p.a, p.b, p.c, pub);
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
