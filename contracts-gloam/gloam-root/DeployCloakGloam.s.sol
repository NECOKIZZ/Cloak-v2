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
 * Runs on 99801 only (anvil started with --chain-id 99801 rehearses it).
 */
contract DeployCloakGloam is MainnetDeploy {
    uint256 public constant ELYSIUM_TESTNET = 99801;

    function run() external {
        _deployMainnetGuarded(ELYSIUM_TESTNET, true);
    }
}
