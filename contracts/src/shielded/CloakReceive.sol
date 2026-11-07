// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakVaults} from "./CloakVaults.sol";
import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {SharedVault} from "./SharedVault.sol";
import {WHYPE} from "./WHYPE.sol";

/// @title ReceiveBox — the contract that ends up at a private receive address.
/// @notice Holds whatever was sent to its address until CloakReceive delivers it into a vault. Only its factory can move
///         anything out, and the factory only moves it into the vault (as its owner's note) or, with the owner's
///         signature, where the owner says. Its creation code takes no arguments, so its address depends only on the
///         factory and the salt, which commits to the owner's note.
contract ReceiveBox {
    address public immutable factory = msg.sender;

    receive() external payable {}

    /// @notice Hand everything of `token` (0 = native HYPE) to the factory. Factory only.
    function sweep(address token) external returns (uint256 amount) {
        require(msg.sender == factory, "factory");
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount > 0) {
                (bool ok,) = factory.call{value: amount}("");
                require(ok, "send");
            }
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount > 0) _transfer(token, factory, amount);
        }
    }

    /// @notice Any call, for the owner's rescue of something the vaults can't take (an NFT, a token without a vault).
    ///         Factory only, and the factory checks the owner's signature first.
    function exec(address target, uint256 value, bytes calldata data) external returns (bytes memory out) {
        require(msg.sender == factory, "factory");
        bool ok;
        (ok, out) = target.call{value: value}(data);
        require(ok, "call failed");
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }
}

/// @title CloakReceive — private receive addresses.
/// @notice A user's app derives, offline, an address for each payment it expects: the address of a ReceiveBox that
///         this factory would deploy with a salt committing to the user's note (a one-time key, a blinding, an encrypted
///         memo), the most a deliverer may charge, and a rescue key. Anyone (an exchange, a bridge, any wallet) sends
///         HYPE or a token there with a plain transfer. Anyone can then call `deliver`: it deploys the box if needed,
///         takes what it holds, pays the caller at most `maxFeeBps` of it, and deposits the rest into the asset's vault
///         as that note. The parameters are checked by the address itself, so nobody can deliver to a different note.
///
///         Public at delivery: the amount, the one-time key and the token, as with any deposit. Not public: who owns
///         the note. There is no owner and no admin; funds only ever go into the vault or, with the rescue key's
///         signature, where its holder says.
contract CloakReceive {
    struct Params {
        uint256 pubKey; // the one-time key the note is locked to
        uint256 blinding;
        bytes memo; // the note's blinding and key index, encrypted to the owner's view key
        uint16 maxFeeBps; // the most a deliverer may keep, at most MAX_FEE_BPS
        address rescuer; // signs rescues (a key derived for this address only)
    }

    uint16 public constant MAX_FEE_BPS = 500;
    bytes32 public constant RESCUE_TYPEHASH = keccak256("Rescue(address box,address target,uint256 value,bytes32 data,uint256 nonce)");

    CloakVaults public immutable vaults;
    SharedVault public immutable shared; // may be 0 on a chain without one
    WHYPE public immutable whype;
    bytes32 public immutable boxCodeHash;
    mapping(address => uint256) public nonces; // per box, for rescues

    event Delivered(address indexed box, address indexed token, uint256 amount, uint256 fee, uint256 commitment);
    event Rescued(address indexed box, address target, uint256 value);

    error FeeTooHigh();
    error NothingToDeliver();
    error NoVault();
    error BadSignature();

    constructor(CloakVaults vaults_, SharedVault shared_, WHYPE whype_) {
        vaults = vaults_;
        shared = shared_;
        whype = whype_;
        boxCodeHash = keccak256(type(ReceiveBox).creationCode);
    }

    receive() external payable {} // native HYPE swept from a box, wrapped right away

    function saltOf(Params calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.pubKey, p.blinding, keccak256(p.memo), p.maxFeeBps, p.rescuer));
    }

    /// @notice The receive address for these parameters (the box may not exist yet).
    function addressOf(Params calldata p) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltOf(p), boxCodeHash)))));
    }

    /// @notice Move what `token` (0 = native HYPE) the address holds into the vault as the owner's note. The caller
    ///         keeps `fee`, at most maxFeeBps of the amount.
    function deliver(Params calldata p, address token, uint256 fee) external returns (uint256 commitment) {
        if (p.maxFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        ReceiveBox box = _box(p);
        uint256 amount = box.sweep(token);
        if (amount == 0) revert NothingToDeliver();
        if (fee * 10_000 > amount * p.maxFeeBps) revert FeeTooHigh();
        address asset = token;
        if (token == address(0)) {
            whype.deposit{value: amount}();
            asset = address(whype);
        }
        uint256 net = amount - fee;
        if (fee > 0) _transfer(asset, msg.sender, fee);
        ShieldedPool pool = vaults.poolOf(asset);
        if (address(pool) != address(0)) {
            _approve(asset, address(pool), net);
            (commitment,) = pool.depositTo(p.pubKey, net, p.blinding, _memo(net, p.memo));
        } else if (address(shared) != address(0) && shared.admitted(asset)) {
            _approve(asset, address(shared), net);
            (commitment,) = shared.depositTo(asset, p.pubKey, net, p.blinding, _memo(net, p.memo));
        } else {
            revert NoVault();
        }
        emit Delivered(address(box), token, amount, fee, commitment);
    }

    /// @notice Get something out that the vaults can't take, as the box's rescue key says (anyone may submit it).
    function rescue(Params calldata p, address target, uint256 value, bytes calldata data, bytes calldata sig) external returns (bytes memory) {
        ReceiveBox box = _box(p);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("CloakReceive"), block.chainid, address(this))),
                keccak256(abi.encode(RESCUE_TYPEHASH, address(box), target, value, keccak256(data), nonces[address(box)]++))
            )
        );
        if (_recover(digest, sig) != p.rescuer || p.rescuer == address(0)) revert BadSignature();
        emit Rescued(address(box), target, value);
        return box.exec(target, value, data);
    }

    function _box(Params calldata p) internal returns (ReceiveBox box) {
        address a = addressOf(p);
        if (a.code.length == 0) {
            box = new ReceiveBox{salt: saltOf(p)}();
            require(address(box) == a, "address");
        } else {
            box = ReceiveBox(payable(a));
        }
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "approve");
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer");
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /// Same memo format as the routers: the (now public) amount in clear, then the owner's encrypted part.
    function _memo(uint256 amount, bytes calldata enc) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(0x02), bytes16(uint128(amount)), enc);
    }
}
