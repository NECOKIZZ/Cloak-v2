pragma circom 2.1.6;
include "./fundsProof.circom";
component main {public [root, threshold, context, nullifier]} = FundsProof(20, 3);
