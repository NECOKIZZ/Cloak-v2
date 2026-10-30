pragma circom 2.1.6;
include "./vault_transaction.circom";
component main {public [root, publicAmount, extDataHash, publicAsset, inputNullifier, outputCommitment]} = VaultTransaction(20, 2, 2);
