// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IShieldVault {
    function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) external payable;
}

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title ReceiveBox
 * @notice One receive address. Anyone can pay it (HYPE or a token), before or after it exists on chain (its address is
 *         fixed by CREATE2). Only the factory that made it can move what it holds, and the factory only moves it into
 *         a vault as a note its owner signed for.
 */
contract ReceiveBox {
    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    receive() external payable {}

    /// @notice Hand `amount` of `asset` (address(0) for HYPE) to the factory, which deposits it at once.
    function pull(address asset, uint256 amount) external {
        require(msg.sender == factory, "factory");
        if (asset == address(0)) {
            (bool ok,) = factory.call{value: amount}("");
            require(ok, "send");
        } else {
            (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20R.transfer.selector, factory, amount));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
        }
    }
}

/**
 * @title CloakGloamReceive
 * @notice Receive addresses for Cloak v2 on Gloam: a public address anyone can pay, whose money its owner moves into
 *         a private balance.
 *
 *         A vault deposit needs a proof made with the note's secret, so a contract can't shield on its own. The owner's
 *         app makes the proof (a note of exactly the amount, in the vault it chooses) and signs it with the address's
 *         owner key (a key made from the account's seed and the address's number, so it says nothing about the
 *         account). Anyone (a relayer) then calls shield(): the box hands the funds to this contract, which deposits
 *         them as that note. A copier can't swap in another note: the signature names it.
 *
 *         Public: the address, every payment to it, and each deposit (amount, asset, commitment). Private: everything
 *         the note does afterwards. A payment over the vault's per-deposit cap is moved in several deposits.
 * @dev No owner, no fee, nothing kept here between calls. A failed deposit reverts whole, and the money stays in its box.
 */
contract CloakGloamReceive {
    /// @notice The vaults deposits may go into (Gloam's vault and Cloak's launch vault).
    address public immutable vaultA;
    address public immutable vaultB;
    bytes32 private constant SHIELD_DOMAIN = keccak256("cloak.gloam.receive.shield.v1");

    uint256 private _entered;

    event Received(address indexed box, address indexed vault, address indexed asset, uint256 amount, bytes32 commitment);

    error BadVault();
    error BadSignature();
    error Reentrancy();
    error NothingThere();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address vaultA_, address vaultB_) {
        require(vaultA_ != address(0) && vaultB_ != address(0) && vaultA_ != vaultB_, "vaults");
        vaultA = vaultA_;
        vaultB = vaultB_;
    }

    /// @notice HYPE comes in from a box during shield().
    receive() external payable {
        if (_entered != 1) revert Reentrancy();
    }

    /// @notice The receive address of (ownerKey, n), whether or not its box exists yet.
    function boxOf(address ownerKey, uint256 n) public view returns (address) {
        bytes32 codeHash = keccak256(type(ReceiveBox).creationCode);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ownerKey, n), codeHash)))));
    }

    /// @notice What the owner key signs to deposit `amount` of `asset` from its box into `vault` as `commitment`.
    function shieldDigest(address box, address vault, address asset, uint256 amount, bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encode(SHIELD_DOMAIN, block.chainid, address(this), box, vault, asset, amount, commitment));
    }

    /**
     * @notice Move `amount` of `asset` from the box of (ownerKey, n) into `vault` as the note `commitment`, whose shield
     *         proof is `proof`, as the owner key signed. Anyone may send it. Makes the box on first use.
     */
    function shield(
        address ownerKey,
        uint256 n,
        address vault,
        address asset,
        uint256 amount,
        bytes32 commitment,
        bytes calldata proof,
        bytes calldata signature
    ) external nonReentrant {
        if (vault != vaultA && vault != vaultB) revert BadVault();
        address box = boxOf(ownerKey, n);
        if (ownerKey == address(0) || _recover(shieldDigest(box, vault, asset, amount, commitment), signature) != ownerKey) revert BadSignature();
        if (box.code.length == 0) {
            bytes memory code = type(ReceiveBox).creationCode;
            bytes32 salt = _salt(ownerKey, n);
            address made;
            assembly {
                made := create2(0, add(code, 0x20), mload(code), salt)
            }
            require(made == box, "box");
        }
        if (_balance(asset, box) < amount || amount == 0) revert NothingThere();
        uint256 before = _balance(asset, address(this));
        ReceiveBox(payable(box)).pull(asset, amount);
        // a fee-on-transfer token arrives short: the vault would refuse it anyway, so stop here with the money in place
        require(_balance(asset, address(this)) - before == amount, "short");
        if (asset == address(0)) {
            IShieldVault(vault).shieldBound{value: amount}(asset, amount, commitment, proof);
        } else {
            require(IERC20R(asset).approve(vault, amount), "approve");
            IShieldVault(vault).shieldBound(asset, amount, commitment, proof);
            require(IERC20R(asset).approve(vault, 0), "approve");
        }
        emit Received(box, vault, asset, amount, commitment);
    }

    function _salt(address ownerKey, uint256 n) private pure returns (bytes32) {
        return keccak256(abi.encode(ownerKey, n));
    }

    function _balance(address asset, address who) private view returns (uint256) {
        return asset == address(0) ? who.balance : IERC20R(asset).balanceOf(who);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
