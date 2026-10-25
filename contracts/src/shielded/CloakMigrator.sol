// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {PrivateRouter, IERC20Approve, _memo} from "./PrivateRouter.sol";

interface ILegacyRouter {
    function isPool(address pool) external view returns (bool);
}

/// @title CloakMigrator — move a private balance from an earlier Cloak deployment into this one, in one transaction.
/// @notice The old pool's proof withdraws the notes to this contract, and the same transaction deposits the amount into
///         the matching pool here as a new note for a one-time key. The instructions (output key, memo) sit in
///         `ExtData.data`, bound by the old proof, so the relayer can't redirect anything. Like any public entry, the
///         amount is visible; who moved it is not.
/// @dev No owner. Old pools charge no withdrawal fee, and this contract is cap-exempt in CloakConfig, so a balance can
///      always move in full.
contract CloakMigrator {
    struct MoveData {
        uint256 outPubKey;
        uint256 outBlinding;
        bytes outMemo;
    }

    ILegacyRouter public immutable legacyRouter;
    PrivateRouter public immutable router;
    uint256 private _lock = 1;

    event Migrated(address indexed fromPool, address indexed toPool, uint256 amount);

    error Reentrancy();
    error UnknownPool();
    error BadRecipient();
    error NoPoolHere();

    modifier lock() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ILegacyRouter legacyRouter_, PrivateRouter router_) {
        legacyRouter = legacyRouter_;
        router = router_;
    }

    function migrate(ShieldedPool oldPool, ShieldedPool.Proof calldata proof, ShieldedPool.ExtData calldata ext)
        external
        lock
        returns (uint256 amount)
    {
        if (!legacyRouter.isPool(address(oldPool))) revert UnknownPool();
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        MoveData memory d = abi.decode(ext.data, (MoveData));
        IERC20 token = oldPool.token();
        ShieldedPool newPool = router.poolOf(address(token));
        if (address(newPool) == address(0)) revert NoPoolHere();

        uint256 before = token.balanceOf(address(this));
        oldPool.transact(proof, ext);
        amount = token.balanceOf(address(this)) - before;

        IERC20Approve(address(token)).approve(address(newPool), amount);
        newPool.depositTo(d.outPubKey, amount, d.outBlinding, _memo(amount, d.outMemo));
        emit Migrated(address(oldPool), address(newPool), amount);
    }
}
