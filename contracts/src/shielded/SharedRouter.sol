// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {SharedVault} from "./SharedVault.sol";
import {WHYPE} from "./WHYPE.sol";

interface ISharedMarket {
    function swapExactHypeForTokens(uint256 minOut, address to) external payable returns (uint256 out);
    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
}

/// @title SharedRouter — private trading for tokens in the SharedVault, through each launch's Uniswap V2 pool.
/// @notice Three moves, each submitted by a relayer so the trader's wallet never appears:
///           buy   HYPE vault note ──proof──▶ router ──▶ Uniswap ──▶ tokens ──▶ SharedVault note
///           sell  SharedVault note ──proof──▶ router ──▶ Uniswap ──▶ HYPE ──▶ HYPE vault note
///           send  a SharedVault send with no fee (its token stays hidden), with the relayer paid from the sender's
///                 HYPE vault in the same transaction
///         Every instruction sits in `ExtData.data`, which the proof commits to, so a relayer can only submit a move
///         exactly as the user built it. The router holds no funds between calls.
contract SharedRouter {
    struct SwapData {
        address token; // the launch token bought or sold
        uint256 minOut;
        uint256 outPubKey; // one-time pubKey for the output note
        uint256 outBlinding;
        bytes outMemo; // output note encrypted to the trader's view key
        uint64 deadline;
    }

    uint256 public constant HYPE_SEND_GAS = 100_000;

    SharedVault public immutable shared;
    ShieldedPool public immutable hypePool;
    WHYPE public immutable whype;

    uint256 private _lock = 1;

    event PrivateBuy(address indexed token, uint256 hypeIn, uint256 tokensOut);
    event PrivateSell(address indexed token, uint256 tokensIn, uint256 hypeOut);
    event PrivateSend(uint256 relayFee);
    event PaidInWhype(address indexed to, uint256 amount);

    error Reentrancy();
    error BadRecipient();
    error BadFeeProof();
    error NotAdmitted();
    error Expired();
    error NotFree();

    modifier lock() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(SharedVault shared_, ShieldedPool hypePool_, WHYPE whype_) {
        shared = shared_;
        hypePool = hypePool_;
        whype = whype_;
        require(address(hypePool_.token()) == address(whype_), "hype vault");
    }

    /// @dev HYPE only arrives during the router's own calls (WHYPE unwraps and market payouts).
    receive() external payable {
        require(_lock == 2, "direct HYPE");
    }

    /// @notice Private buy: spend a HYPE vault note, receive a SharedVault note of `d.token`.
    function buy(ShieldedPool.Proof calldata proof, ShieldedPool.ExtData calldata ext) external lock returns (uint256 out) {
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        SwapData memory d = abi.decode(ext.data, (SwapData));
        if (block.timestamp > d.deadline) revert Expired();
        address market = shared.marketOf(d.token);
        if (market == address(0)) revert NotAdmitted();

        uint256 before = whype.balanceOf(address(this));
        hypePool.transact(proof, ext);
        uint256 amountIn = whype.balanceOf(address(this)) - before;
        whype.withdraw(amountIn);
        out = ISharedMarket(market).swapExactHypeForTokens{value: amountIn}(d.minOut, address(this));
        ISharedApprove(d.token).approve(address(shared), out);
        shared.depositTo(d.token, d.outPubKey, out, d.outBlinding, _sharedMemo(out, d.outMemo));
        emit PrivateBuy(d.token, amountIn, out);
    }

    /// @notice Private sell: spend a SharedVault note of `d.token`, receive a HYPE vault note.
    function sell(SharedVault.Proof calldata proof, SharedVault.ExtData calldata ext) external lock returns (uint256 out) {
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        SwapData memory d = abi.decode(ext.data, (SwapData));
        if (block.timestamp > d.deadline) revert Expired();
        if (proof.publicAsset != uint256(uint160(d.token))) revert NotAdmitted();
        address market = shared.marketOf(d.token);
        if (market == address(0)) revert NotAdmitted();

        uint256 before = IERC20(d.token).balanceOf(address(this));
        shared.transact(proof, ext);
        uint256 amountIn = IERC20(d.token).balanceOf(address(this)) - before;
        ISharedApprove(d.token).approve(market, amountIn);
        out = ISharedMarket(market).swapExactTokensForHype(amountIn, d.minOut, address(this));
        whype.deposit{value: out}();
        whype.approve(address(hypePool), out);
        hypePool.depositTo(d.outPubKey, out, d.outBlinding, _sharedMemo(out, d.outMemo));
        emit PrivateSell(d.token, amountIn, out);
    }

    /// @notice A private send whose token stays hidden: the SharedVault send pays no fee, and a HYPE vault proof pays
    ///         the relayer (the caller). The HYPE proof's `data` is the send's fingerprint, so it pays for this send only.
    function send(
        SharedVault.Proof calldata sendProof,
        SharedVault.ExtData calldata sendExt,
        ShieldedPool.Proof calldata feeProof,
        ShieldedPool.ExtData calldata feeExt
    ) external lock {
        if (sendExt.extAmount != 0 || sendExt.fee != 0) revert NotFree();
        if (feeExt.recipient != address(this) || feeExt.extAmount >= 0 || feeExt.fee != 0) revert BadFeeProof();
        if (abi.decode(feeExt.data, (bytes32)) != sendFingerprint(sendProof)) revert BadFeeProof();

        shared.transact(sendProof, sendExt);
        uint256 before = whype.balanceOf(address(this));
        hypePool.transact(feeProof, feeExt);
        uint256 fee = whype.balanceOf(address(this)) - before;
        whype.withdraw(fee);
        _payHype(msg.sender, fee);
        emit PrivateSend(fee);
    }

    /// @notice What a fee proof must carry in `data` to pay for `p`: its nullifiers and new notes, which no other send has.
    function sendFingerprint(SharedVault.Proof calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.inputNullifiers, p.outputCommitments));
    }

    function _payHype(address to, uint256 amount) internal {
        bool ok;
        assembly {
            ok := call(HYPE_SEND_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            whype.deposit{value: amount}();
            require(whype.transfer(to, amount), "whype");
            emit PaidInWhype(to, amount);
        }
    }
}

/// @dev Same memo format as PrivateRouter: the (already public) amount in clear, then the trader's encrypted part.
function _sharedMemo(uint256 amount, bytes memory enc) pure returns (bytes memory) {
    return bytes.concat(bytes1(0x02), bytes16(uint128(amount)), enc);
}

interface ISharedApprove {
    function approve(address spender, uint256 value) external returns (bool);
}
