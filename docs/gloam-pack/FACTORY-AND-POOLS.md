# Cloak's factory token and v4 launch pools

## The factory token, for Gloam's one-time review

Every Cloak launch token is `CloakToken` (`contracts/src/CloakToken.sol`, 59 lines, below), deployed by `CloakFactory.createLaunch` through `CloakVestingDeployer.deployToken`. Only launches registered in the factory count, and both `CloakLaunchVault.admitLaunch` and the keeper read the token from `factory.launches(i)`, never from a caller.

- **Factory (Uniswap v4 launches), Elysium testnet:** Cloak v2's own, `0x59d2cd703747a47288518c7380efa95879295784` (Nov 9; Cloak v1 keeps its own factory). Mainnet's goes in here when it's deployed.
- **What the token can't do:** the whole supply is minted once in the constructor. No owner, no mint, no burn function (burns go to `0x...dEaD`), no tax, no fee on transfer, no blacklist, no pause, no hooks, no upgrade. Plain 18-decimal ERC-20 with `type(uint256).max` allowances.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-supply ERC20. The whole supply is minted once at construction; no owner, no mint, no tax, no blacklist.
contract CloakToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, address[] memory to, uint256[] memory amounts) {
        name = name_;
        symbol = symbol_;
        require(to.length == amounts.length, "len");
        for (uint256 i; i < to.length; ++i) {
            if (amounts[i] == 0) continue;
            totalSupply += amounts[i];
            balanceOf[to[i]] += amounts[i];
            emit Transfer(address(0), to[i], amounts[i]);
        }
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "to zero"); // burns go to 0x…dEaD, so totalSupply stays honest
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
```

## Cloak's v4 launch pools, for Gloam's router allowlist

Every launch opens a Uniswap v4 pool (native HYPE and the token) at its clearing price behind `CloakV4Hook` (`0xc6296320cdfab6074fc650f1d788608b16fa2a80`, immutable, reviewed by Cloak): it keeps the liquidity forever, pays trading fees to the creator, and charges an anti-snipe fee for 5 minutes after listing. PoolManager `0x51027076df8416e42ea8438b27a0c433d9662e68`. The hook's `keyFor(token)` gives each pool's key. The fee `8388608` is v4's dynamic-fee flag (`0x800000`), tick spacing 60, `hooks` is CloakV4Hook for all of them.

Settled launches with a pool on Elysium testnet, read from the chain on Nov 8 (launch index from the factory):

| # | Symbol | Token | CloakV4Market | currency0 | currency1 | fee | tickSpacing | PoolId |
|---|---|---|---|---|---|---|---|---|
| 0 | SSHADE | `0x98aCdA79F320F9DE804674D93228d779D22996a1` | `0x935A9a008AF1c722A12151D90B1bc3be1b2346F8` | `0x0000000000000000000000000000000000000000` | `0x98aCdA79F320F9DE804674D93228d779D22996a1` | 8388608 | 60 | `0x98124441cc414a0ae0771eefb30efe9931f7bd9c5eb0af8db04d9b6ebdd5410c` |
| 2 | DOLLY | `0x384789c1BC7c39aCfA3B956B05A983D8ca131ea8` | `0x4c88Ae9F4Dc41c268981880b3779C1149109E4C9` | `0x0000000000000000000000000000000000000000` | `0x384789c1BC7c39aCfA3B956B05A983D8ca131ea8` | 8388608 | 60 | `0x78527c998b901cb1b443db0e3cbb33bf3073e3ce2c6bef78fa2aa822d1279375` |
| 4 | PHA | `0xe1FF44F3dF84902ceBC8906Efa7d7F99Ced7b7df` | `0x1662Db35ecA9Ae867610C9d24d14770A640ed4A2` | `0x0000000000000000000000000000000000000000` | `0xe1FF44F3dF84902ceBC8906Efa7d7F99Ced7b7df` | 8388608 | 60 | `0x4dad37e195c960e6ded486885a8a97a4d488e5c0350dfbe20a7f024321a1f8ad` |
| 8 | BSHADE | `0x9c39Db92da7ED919D86851D078Cb478b1240094B` | `0x55c133b74e66BA5da200224872Db8528D055c430` | `0x0000000000000000000000000000000000000000` | `0x9c39Db92da7ED919D86851D078Cb478b1240094B` | 8388608 | 60 | `0xcc2a445926481ee2d9f5fbb0e1ebae79e633b88707cc44bc7d20e488a9f8c71c` |
| 10 | FRTN | `0xa7cD1Abd22921c91bB87404e7ae20174eC504B9b` | `0x98070A2892007c8b6F5Ee6EF18A261B99bD5F92b` | `0x0000000000000000000000000000000000000000` | `0xa7cD1Abd22921c91bB87404e7ae20174eC504B9b` | 8388608 | 60 | `0x80b13ef7eaa7142272353e3193496d778e89c243e876d9ad1de94d98e367c25e` |

New launches add a row each. `CloakLaunchSwapV4` trades any pool behind CloakV4Hook at once, so these are only needed for Gloam's router.
