// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakVaults} from "./CloakVaults.sol";
import {ShieldedPool} from "./ShieldedPool.sol";

interface IVerifierFunds {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata pub) external view returns (bool);
}

/// @title CloakFundsCheck — on-chain proof of funds.
/// @notice "Someone holds at least `threshold` in this Cloak vault right now", from a zero-knowledge proof over up to
///         three of their notes (circuits/src/fundsProof.circom), without revealing the balance, the notes or the
///         holder. Other contracts call `holds` to gate on private holdings: a launch or drop allowlist, an agent's
///         credit line. The caller picks `context` and must make it bind the proof to its own use, for example
///         keccak256(its address, the wallet being let in, an expiry) mod the field, so a proof made for one place or
///         one wallet can't be reused for another.
/// @dev Read-only; no owner. A backing note spent since the proof was made fails the check.
contract CloakFundsCheck {
    uint256 internal constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256[3] nullifiers; // 0 for an empty slot
    }

    IVerifierFunds public immutable verifier;
    CloakVaults public immutable vaults;

    constructor(IVerifierFunds verifier_, CloakVaults vaults_) {
        verifier = verifier_;
        vaults = vaults_;
    }

    /// @notice Whether the proof shows at least `threshold` in `pool` for this `context`, with every backing note
    ///         still unspent.
    function holds(ShieldedPool pool, uint256 threshold, uint256 context, Proof calldata p) external view returns (bool) {
        if (!vaults.isPool(address(pool)) || context >= FIELD_SIZE) return false;
        if (!pool.isKnownRoot(p.root)) return false;
        for (uint256 i; i < 3; ++i) {
            if (p.nullifiers[i] != 0 && pool.isSpent(p.nullifiers[i])) return false;
        }
        return verifier.verifyProof(p.a, p.b, p.c, [p.root, threshold, context, p.nullifiers[0], p.nullifiers[1], p.nullifiers[2]]);
    }

    /// @notice The context a contract at `gate` should require for letting `who` in until `expiresAt` (a helper; any
    ///         binding the caller checks itself works).
    function contextFor(address gate, address who, uint64 expiresAt) external pure returns (uint256) {
        return uint256(keccak256(abi.encode("cloak-funds-gate-v1", gate, who, expiresAt))) % FIELD_SIZE;
    }
}
