// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CloakWHYPE
 * @notice Wrapped HYPE for Cloak's routers: WETH9, unchanged in behaviour, in Solidity 0.8. One HYPE in, one WHYPE out,
 *         and back. No owner, no admin, no upgrade, no fee.
 * @dev Elysium's WHYPE (0xbA87…5E81) is an upgradeable proxy. The routers trust their WHYPE to send HYPE back on
 *      withdraw, so they take this fixed one instead, which nobody can change.
 */
contract CloakWHYPE {
    string public constant name = "Wrapped HYPE";
    string public constant symbol = "WHYPE";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        emit Withdrawal(msg.sender, value);
        (bool ok,) = payable(msg.sender).call{value: value}("");
        require(ok, "send");
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return transferFrom(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        require(balanceOf[from] >= value, "balance");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= value, "allowance");
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
