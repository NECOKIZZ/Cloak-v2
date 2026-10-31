// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {WHYPE} from "./WHYPE.sol";
import {CloakPair} from "../CloakPair.sol";
import {CloakConfig} from "../CloakConfig.sol";

import {CloakVaults} from "./CloakVaults.sol";

/// @title PrivateRouter — private buys and sells of Cloak launch tokens.
/// @notice Swaps *between* the permanent vaults in CloakVaults through each launch's CloakPair:
///
///           shielded WHYPE note ──proof──▶ router ──unwrap──▶ CloakPair ──▶ tokens ──depositTo──▶ shielded token note
///
///         The swap is submitted by a relayer, so the trader's wallet never appears. The instructions (pair, vault, min
///         out, output note) sit in `ExtData.data`, which the proof commits to, so the relayer can only submit the
///         swap exactly as the user built it. Trade size and direction are visible on the AMM; the trader is not.
///
///         A swap is a withdrawal from the input vault, so the vault's withdrawal fee (CloakConfig) applies; the router
///         trades what actually arrived. The router holds no vaults and no funds between calls: a newer router can be
///         added next to this one and every balance stays where it is.
contract PrivateRouter {
    struct SwapData {
        address pair; // CloakPair of the launch (checked against CloakVaults)
        address poolOut; // vault that receives the output
        uint256 minOut;
        uint256 outPubKey; // one-time pubKey for the output note
        uint256 outBlinding;
        bytes outMemo; // output note encrypted to the trader's view key
        uint64 deadline;
    }

    uint256 public constant HYPE_SEND_GAS = 100_000;

    CloakConfig public immutable config;
    CloakVaults public immutable vaults;
    WHYPE public immutable whype;
    ShieldedPool public immutable hypePool;

    uint256 private _lock = 1;

    event Shielded(address indexed pool, uint256 amount);
    event PrivateSwap(address indexed poolIn, address indexed poolOut, uint256 amountIn, uint256 amountOut);
    event Unshielded(address indexed pool, uint256 amount);
    event PaidInWhype(address indexed to, uint256 amount);

    error Reentrancy();
    error NoHypeVault();
    error UnknownPool();
    error BadRecipient();
    error BadPair();
    error Expired();

    modifier lock() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(CloakVaults vaults_, WHYPE whype_) {
        vaults = vaults_;
        config = vaults_.config();
        whype = whype_;
        hypePool = vaults_.poolOf(address(whype_));
        if (address(hypePool) == address(0)) revert NoHypeVault();
    }

    receive() external payable {
        require(msg.sender == address(whype) || isPairAddress(msg.sender), "direct HYPE");
    }

    function isPairAddress(address a) internal view returns (bool) {
        CloakPair p = CloakPair(payable(a));
        try p.token() returns (address t) {
            return address(vaults.pairOf(t)) == a;
        } catch {
            return false;
        }
    }

    // The vault list lives in CloakVaults; these read it, so batchers, migrators and apps can ask the router.

    function poolOf(address token) public view returns (ShieldedPool) {
        return vaults.poolOf(token);
    }

    function pairOf(address token) public view returns (CloakPair) {
        return vaults.pairOf(token);
    }

    function isPool(address pool) public view returns (bool) {
        return vaults.isPool(pool);
    }

    function tokens(uint256 i) external view returns (address) {
        return vaults.tokens(i);
    }

    function tokensCount() external view returns (uint256) {
        return vaults.tokensCount();
    }

    /// @notice Public HYPE → private WHYPE note (one tx, no proof). Use a one-time pubKey.
    function shieldHype(uint256 pubKey, uint256 blinding, bytes calldata memo) external payable lock {
        // the router is cap-exempt for swap outputs, so public deposits are capped here
        (bool on, uint256 perDeposit, uint256 total) = config.limitOf(address(whype));
        if (on && (msg.value > perDeposit || hypePool.deposited() + msg.value > total)) revert ShieldedPool.OverDepositLimit();
        whype.deposit{value: msg.value}();
        whype.approve(address(hypePool), msg.value);
        hypePool.depositTo(pubKey, msg.value, blinding, _memo(msg.value, memo));
        emit Shielded(address(hypePool), msg.value);
    }

    /// @notice Private buy (WHYPE pool → token pool) or private sell (token pool → WHYPE pool).
    function privateSwap(ShieldedPool poolIn, ShieldedPool.Proof calldata proof, ShieldedPool.ExtData calldata ext)
        external
        lock
        returns (uint256 out)
    {
        if (!isPool(address(poolIn))) revert UnknownPool();
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        SwapData memory d = abi.decode(ext.data, (SwapData));
        if (block.timestamp > d.deadline) revert Expired();
        if (!isPool(d.poolOut)) revert UnknownPool();

        address tokenIn = address(poolIn.token());
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        poolIn.transact(proof, ext); // proof-checked withdrawal to this router (minus the pool's withdrawal fee)
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this)) - before;

        address tokenOut = address(ShieldedPool(d.poolOut).token());
        CloakPair pair = CloakPair(payable(d.pair));
        if (tokenIn == address(whype)) {
            // buy: WHYPE → HYPE → launch token
            if (address(pairOf(tokenOut)) != d.pair || d.pair == address(0)) revert BadPair();
            whype.withdraw(amountIn);
            out = pair.swapExactHypeForTokens{value: amountIn}(d.minOut, address(this));
        } else {
            // sell: launch token → HYPE → WHYPE
            if (tokenOut != address(whype) || address(pairOf(tokenIn)) != d.pair || d.pair == address(0)) revert BadPair();
            IERC20Approve(tokenIn).approve(d.pair, amountIn);
            out = pair.swapExactTokensForHype(amountIn, d.minOut, address(this));
            whype.deposit{value: out}();
        }
        IERC20Approve(tokenOut).approve(d.poolOut, out);
        ShieldedPool(d.poolOut).depositTo(d.outPubKey, out, d.outBlinding, _memo(out, d.outMemo));
        emit PrivateSwap(address(poolIn), d.poolOut, amountIn, out);
    }

    /// @notice Private WHYPE → native HYPE to any address (`ext.data` = abi.encode(to), bound by the proof).
    function unshieldHype(ShieldedPool.Proof calldata proof, ShieldedPool.ExtData calldata ext) external lock {
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        address to = abi.decode(ext.data, (address));
        uint256 before = whype.balanceOf(address(this));
        hypePool.transact(proof, ext);
        uint256 amount = whype.balanceOf(address(this)) - before;
        whype.withdraw(amount);
        // Bounded gas and no return data copied: a recipient can't burn the relayer's gas. A recipient that can't take
        // HYPE that way gets WHYPE instead, so the withdrawal still lands.
        bool ok;
        assembly {
            ok := call(HYPE_SEND_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            whype.deposit{value: amount}();
            require(whype.transfer(to, amount), "whype");
            emit PaidInWhype(to, amount);
        }
        emit Unshielded(address(hypePool), amount);
    }
}

/// @dev Notes created by the router carry their (already public) amount in clear, followed by the trader's encrypted
///      (blinding, key index). The output amount of a swap is only known on-chain, so the client cannot encrypt it.
function _memo(uint256 amount, bytes memory enc) pure returns (bytes memory) {
    return bytes.concat(bytes1(0x02), bytes16(uint128(amount)), enc);
}

interface IERC20Approve {
    function approve(address spender, uint256 value) external returns (bool);
}
