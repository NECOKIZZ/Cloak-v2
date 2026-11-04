// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A plain ERC-721 standing in for an existing collection (local tests and testnet demos only).
contract MockNFT {
    string public name;
    string public symbol;
    string public baseURI;
    address public immutable minter;
    mapping(uint256 => address) internal _owner;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory name_, string memory symbol_, string memory baseURI_) {
        name = name_;
        symbol = symbol_;
        baseURI = baseURI_;
        minter = msg.sender;
    }

    function mint(address to, uint256 from, uint256 count) external {
        require(msg.sender == minter, "minter");
        for (uint256 id = from; id < from + count; ++id) {
            require(_owner[id] == address(0), "minted");
            _owner[id] = to;
            emit Transfer(address(0), to, id);
        }
        balanceOf[to] += count;
    }

    function ownerOf(uint256 id) public view returns (address o) {
        o = _owner[id];
        require(o != address(0), "no token");
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id);
        return string.concat(baseURI, _toString(id));
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function approve(address op, uint256 id) external {
        address o = ownerOf(id);
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "not allowed");
        getApproved[id] = op;
        emit Approval(o, op, id);
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
        emit ApprovalForAll(msg.sender, op, ok);
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(from == ownerOf(id), "from");
        require(to != address(0), "to");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[id], "not allowed");
        balanceOf[from]--;
        balanceOf[to]++;
        _owner[id] = to;
        delete getApproved[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata) external {
        transferFrom(from, to, id);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory s = new bytes(len);
        for (; v != 0; v /= 10) s[--len] = bytes1(uint8(48 + (v % 10)));
        return string(s);
    }
}
