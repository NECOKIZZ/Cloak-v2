// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Pair} from "./uniswap/IUniswapV2.sol";
import {mulDiv} from "./CloakV2Market.sol";

/// @title CloakFeeLocker — a launch's Uniswap V2 liquidity, locked forever, earning trading fees for its creator.
/// @notice A launch that picks "locked forever, creator earns fees" sends its LP here at settlement. Every trade on a
///         Uniswap V2 pool pays a 0.3% fee into the pool, which grows the pool's √(reserve0 × reserve1) per LP token.
///         This contract remembers that value when the LP was locked and, on `claim`, pays the beneficiary only the
///         growth since: it burns exactly the share of the LP that the fees added and keeps the rest.
///
///         What stays true, whatever anyone does:
///           - the liquidity locked never shrinks: the LP kept is always worth at least √k per LP at lock time,
///           - only fees (and anything someone donates to the pool) can be claimed, never the original liquidity,
///           - there is no owner, no unlock and no way to move the LP anywhere but back into the pool as a claim.
///
///         Trades can't fake fees: a swap only raises √k by the fee it pays, so moving the price and moving it back
///         costs the trader exactly what the creator then earns. Anyone may call `claim`; it always pays the beneficiary.
contract CloakFeeLocker {
    struct Position {
        IUniswapV2Pair pair;
        address beneficiary;
        uint256 shares; // LP tokens held for this position
        uint256 locked; // the value locked for good: LP at the lock × (√k × 2^64 / totalSupply) at the lock
    }

    Position[] internal _positions;

    event Locked(uint256 indexed id, address indexed pair, address indexed beneficiary, uint256 shares);
    event FeesClaimed(uint256 indexed id, address indexed beneficiary, uint256 shares, uint256 amount0, uint256 amount1);
    event BeneficiaryChanged(uint256 indexed id, address from, address to);

    error NotBeneficiary();
    error Zero();

    uint256 private _lock = 1;

    modifier lock() {
        require(_lock == 1, "locked");
        _lock = 2;
        _;
        _lock = 1;
    }

    function positionsCount() external view returns (uint256) {
        return _positions.length;
    }

    function positions(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice Lock `shares` LP tokens of `pair` (pulled from the caller) forever, paying their fees to `beneficiary`.
    function lockFor(IUniswapV2Pair pair, uint256 shares, address beneficiary) external lock returns (uint256 id) {
        if (shares == 0 || beneficiary == address(0)) revert Zero();
        require(pair.transferFrom(msg.sender, address(this), shares), "lp");
        id = _positions.length;
        _positions.push(Position({pair: pair, beneficiary: beneficiary, shares: shares, locked: shares * _perShare(pair)}));
        emit Locked(id, address(pair), beneficiary, shares);
    }

    /// @notice LP tokens a claim would burn now (the fees earned since the lock or the last claim).
    function claimable(uint256 id) public view returns (uint256 lp) {
        Position storage p = _positions[id];
        uint256 nowPer = _perShare(p.pair);
        if (nowPer == 0) return 0;
        // keep enough LP to stay worth the locked value at today's √k per LP, rounded UP so the lock never shrinks
        uint256 keep = (p.locked + nowPer - 1) / nowPer;
        lp = p.shares > keep ? p.shares - keep : 0;
    }

    /// @notice Token amounts a claim would pay now (the beneficiary's share of the pool's current balances).
    function claimableAmounts(uint256 id) external view returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[id];
        uint256 lp = claimable(id);
        if (lp == 0) return (0, 0);
        (uint112 r0, uint112 r1,) = p.pair.getReserves();
        uint256 total = p.pair.totalSupply();
        (amount0, amount1) = (mulDiv(lp, r0, total), mulDiv(lp, r1, total));
    }

    /// @notice Pay the fees earned so far to the beneficiary (anyone may call).
    function claim(uint256 id) external lock returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[id];
        uint256 lp = claimable(id);
        if (lp == 0) return (0, 0);
        p.shares -= lp;
        require(p.pair.transfer(address(p.pair), lp), "lp");
        (amount0, amount1) = p.pair.burn(p.beneficiary);
        emit FeesClaimed(id, p.beneficiary, lp, amount0, amount1);
    }

    /// @notice The beneficiary can hand its fees to another address (a multisig, a treasury).
    function setBeneficiary(uint256 id, address to) external {
        Position storage p = _positions[id];
        if (msg.sender != p.beneficiary) revert NotBeneficiary();
        if (to == address(0)) revert Zero();
        emit BeneficiaryChanged(id, p.beneficiary, to);
        p.beneficiary = to;
    }

    /// @dev √(r0 × r1) × 2^64 / totalSupply (rounded down, so the LP kept is rounded up). It never falls: swaps only add fees, mints and burns keep it (or round it up).
    function _perShare(IUniswapV2Pair pair) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 total = pair.totalSupply();
        if (total == 0) return 0;
        return mulDiv(_sqrt(uint256(r0) * uint256(r1)), 1 << 64, total);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
