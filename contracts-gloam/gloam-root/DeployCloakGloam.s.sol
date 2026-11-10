// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Resolved against vendor/gloam/contracts (run with --root, see ../deploy.sh), so every Gloam contract compiles from
// the same paths and settings as upstream and its runtime code matches their build.
import {MainnetDeploy} from "script/MainnetDeploy.sol";

/**
 * Cloak's own Gloam instance on Elysium testnet (99801), until Gloam's shared Elysium vault is up.
 *
 * Exactly Gloam's guarded mainnet deploy (MainnetDeploy._deployMainnetGuarded, the path DeployElysiumTestnet uses):
 * the ceremony's final-key verifiers behind the same key gate (final-key proofs accepted, dev-key proofs refused, or
 * no pool), ShieldPoolPayments, deposit limits, the cash-out fee and a VaultOwnerGuard as owner from the first block.
 *
 * One difference from DeployElysiumTestnet: native HYPE may be listed (address 0 in LIMIT_ASSETS). Gloam's founder
 * said HYPE goes in the shared Elysium vault, and Cloak's private balances are mostly HYPE today.
 *
 * Runs on 99801 (anvil started with --chain-id 99801 rehearses it). A fork of mainnet (99901) needs
 * STANDIN_ON_MAINNET_FORK=1: there it stands in for Gloam's mainnet vault in part 22's rehearsal, never on mainnet
 * itself, where Cloak uses Gloam's own vault.
 */
contract DeployCloakGloam is MainnetDeploy {
    uint256 public constant ELYSIUM_TESTNET = 99801;
    uint256 public constant ELYSIUM_MAINNET = 99901;

    function run() external {
        bool fork = vm.envOr("STANDIN_ON_MAINNET_FORK", false) && block.chainid == ELYSIUM_MAINNET;
        _deployMainnetGuarded(fork ? ELYSIUM_MAINNET : ELYSIUM_TESTNET, true);
    }
}
