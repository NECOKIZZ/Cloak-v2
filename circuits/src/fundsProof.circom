pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./merkleproof.circom";

/*
 * Proof of funds: "I hold at least `threshold` in this vault", backed by up to n notes of the vault's one asset,
 * without showing the balance, the notes, or who holds them.
 *
 * Notes are the vault's own (transaction.circom):
 *   pubKey     = Poseidon(privKey)
 *   commitment = Poseidon(amount, pubKey, blinding)
 *   signature  = Poseidon(privKey, commitment, leafIndex)
 *   nullifier  = Poseidon(commitment, leafIndex, signature)
 *
 * The nullifier of each used note is public, so a verifier can check on chain that none was spent (as of a block).
 * Empty slots carry amount 0 and nullifier 0. Used notes must be distinct (no double counting) and in the tree under
 * `root`; at least one slot is used. `context` binds the proof to one verifier and moment (label, expiry, vault,
 * chain), so it can't be replayed elsewhere.
 *
 * Public inputs, in this order: [0] root  [1] threshold  [2] context  [3..3+n) nullifier
 */
template FundsProof(levels, n) {
    signal input root;
    signal input threshold;
    signal input context;
    signal input nullifier[n];

    signal input used[n];
    signal input amount[n];
    signal input privKey[n];
    signal input blinding[n];
    signal input pathIndices[n];
    signal input pathElements[n][levels];

    component keypair[n];
    component commitment[n];
    component signature[n];
    component nullHash[n];
    component tree[n];
    component rootCheck[n];
    component amountBits[n];
    var total = 0;
    var usedCount = 0;

    for (var i = 0; i < n; i++) {
        used[i] * (used[i] - 1) === 0;

        amountBits[i] = Num2Bits(128);
        amountBits[i].in <== amount[i];
        amount[i] * (1 - used[i]) === 0; // empty slots carry nothing

        keypair[i] = Poseidon(1);
        keypair[i].inputs[0] <== privKey[i];

        commitment[i] = Poseidon(3);
        commitment[i].inputs[0] <== amount[i];
        commitment[i].inputs[1] <== keypair[i].out;
        commitment[i].inputs[2] <== blinding[i];

        signature[i] = Poseidon(3);
        signature[i].inputs[0] <== privKey[i];
        signature[i].inputs[1] <== commitment[i].out;
        signature[i].inputs[2] <== pathIndices[i];

        nullHash[i] = Poseidon(3);
        nullHash[i].inputs[0] <== commitment[i].out;
        nullHash[i].inputs[1] <== pathIndices[i];
        nullHash[i].inputs[2] <== signature[i].out;
        nullifier[i] === used[i] * nullHash[i].out;

        tree[i] = MerkleProof(levels);
        tree[i].leaf <== commitment[i].out;
        tree[i].pathIndices <== pathIndices[i];
        for (var j = 0; j < levels; j++) tree[i].pathElements[j] <== pathElements[i][j];
        rootCheck[i] = ForceEqualIfEnabled();
        rootCheck[i].in[0] <== root;
        rootCheck[i].in[1] <== tree[i].root;
        rootCheck[i].enabled <== used[i];

        total += amount[i];
        usedCount += used[i];
    }

    // used notes are distinct: the same note in two slots would count twice
    component same[n * (n - 1) / 2];
    signal both[n * (n - 1) / 2];
    var k = 0;
    for (var i = 0; i < n - 1; i++) {
        for (var j = i + 1; j < n; j++) {
            same[k] = IsEqual();
            same[k].in[0] <== nullifier[i];
            same[k].in[1] <== nullifier[j];
            both[k] <== used[i] * used[j];
            same[k].out * both[k] === 0;
            k++;
        }
    }

    // at least one real note backs the claim
    component none = IsZero();
    none.in <== usedCount;
    none.out === 0;

    // the notes add up to at least the threshold (n ≤ 4 notes of < 2^128 each stay below 2^130; the app uses n = 3)
    component thresholdBits = Num2Bits(128);
    thresholdBits.in <== threshold;
    component enough = GreaterEqThan(130);
    enough.in[0] <== total;
    enough.in[1] <== threshold;
    enough.out === 1;

    signal contextSquare <== context * context;
}
