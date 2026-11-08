// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFundsVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata pub) external view returns (bool);
}

interface IVaultReads {
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isSpent(bytes32 nullifier) external view returns (bool);
}

/**
 * @title GloamFundsCheck
 * @notice On-chain proof of funds on a Gloam vault, for Cloak's allowlists (a launch or a drop that admits only wallets
 *         holding enough): Gloam's funds circuit (final ceremony keys, verifier exported from funds_final.zkey) shows
 *         that up to four notes under a root the vault has had hold at least `threshold` of `asset`, bound to a
 *         `context` (who it is for and until when, Gloam's proofContext). This contract adds what the circuit can't
 *         know: the root is one the vault really had, and none of the notes is spent now.
 *
 * Public signals, in Gloam's order: [root, asset, threshold, context, nullifier0..3]. Empty slots carry nullifier 0.
 * Like Cloak's own funds proof, the notes' nullifiers are public: whoever holds the proof sees when they are spent.
 */
contract GloamFundsCheck {
    IVaultReads public immutable vault;
    IFundsVerifier public immutable verifier;

    constructor(address vault_, address verifier_) {
        vault = IVaultReads(vault_);
        verifier = IFundsVerifier(verifier_);
    }

    /// @return ok true when the proof holds for `asset`, at least `threshold`, this `context`, right now.
    function check(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata pub,
        address asset,
        uint256 threshold,
        uint256 context
    ) external view returns (bool ok) {
        if (pub[1] != uint256(uint160(asset)) || pub[2] < threshold || pub[3] != context) return false;
        if (!vault.isKnownRoot(bytes32(pub[0]))) return false;
        for (uint256 i = 4; i < 8; i++) {
            if (pub[i] != 0 && vault.isSpent(bytes32(pub[i]))) return false;
        }
        return verifier.verifyProof(a, b, c, pub);
    }
}
