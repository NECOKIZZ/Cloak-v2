pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./merkleproof.circom";

/*
 * Shielded transaction: spend nIns notes, create nOuts notes, in ONE asset (one pool per asset).
 *
 *   pubKey     = Poseidon(privKey)
 *   commitment = Poseidon(amount, pubKey, blinding)
 *   signature  = Poseidon(privKey, commitment, leafIndex)
 *   nullifier  = Poseidon(commitment, leafIndex, signature)
 *
 * Value rule (in the BN254 field):  sum(inAmount) + publicAmount == sum(outAmount)
 *   deposit:  publicAmount = extAmount - fee          (positive)
 *   withdraw: publicAmount = FIELD - (|extAmount|+fee) (field-negative)
 * The contract computes publicAmount itself from (extAmount, fee), so the prover cannot pick it.
 *
 * Public inputs, in this exact order (snarkjs puts outputs first; there are no outputs here):
 *   [0] root  [1] publicAmount  [2] extDataHash  [3] inputNullifier[0]  [4] inputNullifier[1]
 *   [5] outputCommitment[0]  [6] outputCommitment[1]
 */
template Transaction(levels, nIns, nOuts) {
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKeypair[nIns];
    component inCommitmentHasher[nIns];
    component inSignature[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inRootCheck[nIns];
    component inAmountCheck[nIns];
    var sumIns = 0;

    for (var tx = 0; tx < nIns; tx++) {
        inKeypair[tx] = Poseidon(1);
        inKeypair[tx].inputs[0] <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(3);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].out;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];

        inSignature[tx] = Poseidon(3);
        inSignature[tx].inputs[0] <== inPrivateKey[tx];
        inSignature[tx].inputs[1] <== inCommitmentHasher[tx].out;
        inSignature[tx].inputs[2] <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }

        // Root must match unless this is a zero-amount dummy input.
        inRootCheck[tx] = ForceEqualIfEnabled();
        inRootCheck[tx].in[0] <== root;
        inRootCheck[tx].in[1] <== inTree[tx].root;
        inRootCheck[tx].enabled <== inAmount[tx];

        // Range check (field-wrap protection: amounts must fit in 128 bits).
        inAmountCheck[tx] = Num2Bits(128);
        inAmountCheck[tx].in <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;

    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(3);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].out === outputCommitment[tx];

        outAmountCheck[tx] = Num2Bits(128);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

    // No nullifier may appear twice in one transaction.
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var index = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[index] = IsEqual();
            sameNullifiers[index].in[0] <== inputNullifier[i];
            sameNullifiers[index].in[1] <== inputNullifier[j];
            sameNullifiers[index].out === 0;
            index++;
        }
    }

    sumIns + publicAmount === sumOuts;

    // Bind extDataHash into the proof (recipient, relayer, fee, encrypted outputs).
    signal extDataSquare <== extDataHash * extDataHash;
}
