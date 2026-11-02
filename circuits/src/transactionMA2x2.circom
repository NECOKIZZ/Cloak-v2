pragma circom 2.1.6;

include "./transactionMA.circom";

component main {public [root, publicAmount, extDataHash, publicAsset, inputNullifier, outputCommitment]} = TransactionMA(20, 2, 2);
