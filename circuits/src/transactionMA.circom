pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./merkleproof.circom";

/*
 * Shielded transaction for the SHARED launch-token vault: one tree holds notes of many tokens.
 * Same as transaction.circom, plus a token ("asset") inside every note.
 *
 *   pubKey     = Poseidon(privKey)
 *   commitment = Poseidon(amount, pubKey, blinding, asset)     asset = the token's address as a number
 *   signature  = Poseidon(privKey, commitment, leafIndex)
 *   nullifier  = Poseidon(commitment, leafIndex, signature)
 *
 * One `asset` for the whole transaction: every input and output note is of the same token, so value can never move
 * from one token to another. Value rule as before:  sum(inAmount) + publicAmount == sum(outAmount).
 *
 * `publicAsset` says which token, when it has to be public:
 *   publicAsset != 0  →  every note must be of exactly that token. The vault sets it for anything that moves tokens in
 *                        or out (deposit, withdrawal, swap, relayer fee) and pays out only that token.
 *   publicAsset == 0  →  a private send inside the vault with no fee: the token stays hidden. The vault only accepts
 *                        that when nothing enters or leaves (extAmount == 0 and fee == 0).
 *
 * Public inputs, in this exact order:
 *   [0] root  [1] publicAmount  [2] extDataHash  [3] publicAsset  [4] inputNullifier[0]  [5] inputNullifier[1]
 *   [6] outputCommitment[0]  [7] outputCommitment[1]
 */
template TransactionMA(levels, nIns, nOuts) {
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input publicAsset;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    signal input asset;
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    // the token is public whenever the vault says so
    publicAsset * (asset - publicAsset) === 0;

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

        inCommitmentHasher[tx] = Poseidon(4);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].out;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];
        inCommitmentHasher[tx].inputs[3] <== asset;

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

        inAmountCheck[tx] = Num2Bits(128);
        inAmountCheck[tx].in <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;
    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(4);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].inputs[3] <== asset;
        outCommitmentHasher[tx].out === outputCommitment[tx];

        outAmountCheck[tx] = Num2Bits(128);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

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

    signal extDataSquare <== extDataHash * extDataHash;
}
