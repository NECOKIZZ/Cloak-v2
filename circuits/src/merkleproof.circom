pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Computes the Merkle root for `leaf` at position `pathIndices` (the leaf index
// as one number; bit i = 1 means the node at level i is a RIGHT child).
// Hash: Poseidon(left, right). Must match the ShieldedPool's MerkleTreeWithHistory contract and the SDK tree.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathIndices;
    signal input pathElements[levels];
    signal output root;

    component bits = Num2Bits(levels);   // also forces pathIndices < 2^levels
    bits.in <== pathIndices;

    component hashers[levels];
    signal hashes[levels + 1];
    signal left[levels];
    signal right[levels];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // bit = 0: (hash, sibling)   bit = 1: (sibling, hash)
        left[i]  <== hashes[i] + bits.out[i] * (pathElements[i] - hashes[i]);
        right[i] <== pathElements[i] + bits.out[i] * (hashes[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        hashes[i + 1] <== hashers[i].out;
    }
    root <== hashes[levels];
}
