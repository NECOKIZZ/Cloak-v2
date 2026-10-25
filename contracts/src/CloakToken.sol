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
