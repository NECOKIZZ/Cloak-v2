#!/usr/bin/env bash
# Verify the Cloak v2 testnet contracts on the Elysium explorer (Blockscout). Run from contracts/.
# The explorer sometimes puts its API behind a bot check (HTTP 429 / HTML); rerun later if that happens.
set -euo pipefail
V=https://elysium.kinetiq.xyz/testnet-explorer/api/
CFG=0x9d30c7b23fa2d5c40779d3db3bb4292e18c94373 VER=0xA554AC0150E853DEAC5214cFf9F5001Ad2f441ED DEP=0x6616C2566baD950FcDD420159a51fDdfFa220E8e
P2=0x80d9d0b2bdd42a77d083235662925f2907392723 P3=0xc36ae84e30a13c9463e00f350ee5e507f5f45564 WH=0xe44b27113D4b947c0B1bDf4a93878D0e115f4bdD
FAC=0xc1fc14e84cbbd10f75dad9d91bf50f47c48757fc VD=0x4f278e7810bed444d38D7157AE092f63D52e8bd2 RT=0xd51e731467c49991496329c2b7979cb1aa220ee2
LF=0x1dc1ea9837ecbd31ec74f0d558e1db1c303a7e1c LR=0xfa2574cfc3afb8f7d3a0651fa2111ff4e3d2fc41 CLOAK=0x7e65c418e4E3CDdB1C3C8a9bD2dcE336AC7fd17D
AU=0x973cC9B654484EE2deCcB159a44dCa218d318b7a TK=0x4319AE71F27A2a7932c238B56f5F96A2B6b902cd
v() { forge verify-contract --verifier blockscout --verifier-url $V --skip-is-verified-check --chain 99801 "$1" "$2" --constructor-args "$3"; }
v $CFG src/CloakConfig.sol:CloakConfig "$(cast abi-encode 'c(address,address)' $VER $DEP)"
v $VD src/CloakVesting.sol:CloakVestingDeployer 0x
v $FAC src/CloakFactory.sol:CloakFactory "$(cast abi-encode 'c(address,address)' $CFG $VD)"
v $RT src/shielded/PrivateRouter.sol:PrivateRouter "$(cast abi-encode 'c(address,address,address,address,address,address)' $CFG $P2 $P3 $FAC $LF $WH)"
v 0x4deFEC0814d11c581e5947020ac4ec41e88B55Df src/shielded/ShieldedPool.sol:ShieldedPool "$(cast abi-encode 'c(address,address,address,address)' $CFG $P2 $P3 $WH)"
v 0xDD361593560722c3d965cAA551a6Ed81Cd7dd703 src/shielded/ShieldedPool.sol:ShieldedPool "$(cast abi-encode 'c(address,address,address,address)' $CFG $P2 $P3 $CLOAK)"
v 0x2c2792e116110e24FC83eFB9d0dE2e55DF48b015 src/shielded/ShieldedPool.sol:ShieldedPool "$(cast abi-encode 'c(address,address,address,address)' $CFG $P2 $P3 $TK)"
v 0xa13ffd763a8cccfea1b868c616291723579ddb77 src/shielded/PrivateBatcher.sol:PrivateBatcher "$(cast abi-encode 'c(address,uint64,uint16,uint64,uint128)' $RT 30 200 600 1000000000000)"
v 0xe54c02fa685f2c95e5ae98e1155547194d04d9ad src/shielded/CloakMigrator.sol:CloakMigrator "$(cast abi-encode 'c(address,address)' $LR $RT)"
v $AU src/CloakAuction.sol:CloakAuction "$(cast abi-encode 'c((address,uint256,uint256,uint256,uint256,uint16,uint64,uint64,uint16,uint16,uint64,uint64),address)' "($DEP,1000000000000000000000000,1000000000000000000000000,1000000000,1000000000,50,1792962496,1792962534,8000,1000,0,33386378)" $CFG)"
v $TK src/CloakToken.sol:CloakToken "$(cast abi-encode 'c(string,string,address[],uint256[])' Shade SHADE "[$AU,0x0000000000000000000000000000000000000000]" "[2000000000000000000000000,0]")"
v 0x34fBCaE40b22898f8995C2cF1eF528eaeAf875D4 src/CloakPair.sol:CloakPair "$(cast abi-encode 'c(address)' $TK)"
