// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReceiptVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[7] calldata pub) external view returns (bool);
}

interface IVaultR {
    function isKnownRoot(bytes32 root) external view returns (bool);
    function commitmentSeen(bytes32 commitment) external view returns (bool);
}

/**
 * @title CloakReceiptCheck
 * @notice Private receipts on Gloam's receipt circuit (final keys, verifier exported from receipt_final.zkey), for
 *         Gloam's vault and Cloak's launch vault: "this payment note is real, of this asset, worth at least X" (or
 *         exactly X when the payer chooses to show it), bound to who the receipt is for and until when. The note's
 *         nullifier is not shown, so the receipt never tells its reader when the payment is later spent.
 *
 * Who can make one: whoever knows the note's secret. For a private send that is the payer (it chose the payment note's
 * secret) and the payee. A buyer proves to a seller, a payer to an accountant, without either showing a wallet.
 *
 * Public signals, in Gloam's order: [root, commitment, asset, minAmount, reveal, shownAmount, context]. This adds what
 * the circuit can't know: the root is one the vault really had, and the vault really holds that commitment.
 */
contract CloakReceiptCheck {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IReceiptVerifier public immutable verifier;
    IVaultR public immutable vaultA;
    IVaultR public immutable vaultB;

    constructor(address verifier_, address vaultA_, address vaultB_) {
        require(verifier_ != address(0) && vaultA_ != address(0) && vaultB_ != address(0) && vaultA_ != vaultB_, "params");
        verifier = IReceiptVerifier(verifier_);
        vaultA = IVaultR(vaultA_);
        vaultB = IVaultR(vaultB_);
    }

    /// @notice Gloam's proofContext for a receipt: kind "payment", this chain, this vault.
    function contextFor(address vault, uint64 expiresAt, string calldata verifierName) public view returns (uint256) {
        return uint256(keccak256(abi.encode("gloam.proof.v1", "payment", block.chainid, vault, expiresAt, verifierName))) % FIELD;
    }

    /**
     * @return ok true when the receipt holds: a note of `asset` worth at least `minAmount` in `vault`, made for
     *         (`verifierName`, `expiresAt`), and not expired
     * @return amount the exact amount when the payer showed it, else 0
     * @return commitment the payment note's commitment, to match against what the payee received
     */
    function check(
        address vault,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[7] calldata pub,
        address asset,
        uint256 minAmount,
        uint64 expiresAt,
        string calldata verifierName
    ) external view returns (bool ok, uint256 amount, bytes32 commitment) {
        commitment = bytes32(pub[1]);
        if (vault != address(vaultA) && vault != address(vaultB)) return (false, 0, commitment);
        if (block.timestamp > expiresAt) return (false, 0, commitment);
        if (pub[2] != uint256(uint160(asset)) || pub[6] != contextFor(vault, expiresAt, verifierName)) return (false, 0, commitment);
        bool shown = pub[4] == 1;
        // shown: the exact amount; hidden: the floor the payer proved
        if ((shown ? pub[5] : pub[3]) < minAmount) return (false, 0, commitment);
        if (!IVaultR(vault).isKnownRoot(bytes32(pub[0])) || !IVaultR(vault).commitmentSeen(commitment)) return (false, 0, commitment);
        if (!verifier.verifyProof(a, b, c, pub)) return (false, 0, commitment);
        return (true, shown ? pub[5] : 0, commitment);
    }
}
