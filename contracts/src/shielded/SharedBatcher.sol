// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldedPool, IERC20} from "./ShieldedPool.sol";
import {SharedVault} from "./SharedVault.sol";
import {WHYPE} from "./WHYPE.sol";

interface ISharedBatchMarket {
    function reserveHype() external view returns (uint256);
    function reserveToken() external view returns (uint256);
    function cumulativeNow() external view returns (uint256 cum, uint64 t);
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external view returns (uint256);
    function swapExactHypeForTokens(uint256 minOut, address to) external payable returns (uint256 out);
    function swapExactTokensForHype(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
}

interface IApproveShared {
    function approve(address spender, uint256 value) external returns (bool);
}

/// @title SharedBatcher — PrivateBatcher's batch auctions for tokens in the SharedVault.
/// @notice Same rounds, sizes, pricing and safety limits as PrivateBatcher (same storage layout and events, so keepers
///         settle both the same way). Buy orders come from the HYPE vault and are paid out into the SharedVault; sell
///         orders come from the SharedVault (the proof must name the token) and are paid out into the HYPE vault.
///         Prices come from each token's Uniswap market (SharedVault.marketOf).
///
/// Original notes, unchanged:
/// @notice Private orders for a launch token collect into rounds (e.g. 30 s). Each order is a standard size
///         (1, 2 or 5 × 10ⁿ wei), placed from a shielded balance by a relayer. When the round ends:
///
///           1. buys and sells are crossed against each other at the pool's mid-price (no fee, no price impact),
///           2. only the *net* difference trades against the CloakPair, in one swap,
///           3. every buyer gets the same price, every seller gets the same price, paid as new private notes to
///              one-time keys.
///
///         Observers see "round 812: 7 buys and 3 sells of standard sizes, net +0.4 HYPE hit the pool". They don't
///         see who placed which order, or how much any one trader bought in total (a big trade is many small orders).
/// @dev Uses the SharedVault's markets. Price: buys and sells cross at the pool's time-weighted
///      average price over the round (from the pair's cumulative price), which one transaction can't move. Settlement
///      also needs the spot price within `maxSlippageBps` (at most 2%) of that average, so a settler can't sandwich the
///      batch. The net swap may cost at most MAX_IMPACT_BPS (5%) against the spot price, pool fee included, so a round
///      too big for the pool's depth refunds instead of filling badly. A batch that can't settle is refunded after a
///      delay.
///      An order is a withdrawal from a shielded pool, so the pool's withdrawal fee applies: the batch works with what
///      actually arrived (`net`), and every order of a round pays the same rate.
contract SharedBatcher {
    struct OrderData {
        address token; // launch token being traded
        uint256 outPubKey; // one-time key for the output note (or the refund)
        uint256 outBlinding;
        bytes outMemo; // (blinding, key index) encrypted to the trader's view key
    }

    struct Order {
        address token;
        uint64 round;
        bool buy;
        bool done;
        uint128 size; // the standard size the trader proved (public)
        uint128 net; // what arrived after the pool's withdrawal fee
        uint256 outPubKey;
        uint256 outBlinding;
        bytes outMemo;
    }

    struct Batch {
        uint128 buyHype; // total WHYPE in buy orders
        uint128 sellTokens; // total tokens in sell orders
        uint128 tokensForBuyers;
        uint128 hypeForSellers;
        uint256 cumStart; // pair.priceCumulative when the round's first order landed
        uint64 tStart;
        uint32 orders;
        bool settled;
        bool cancelled;
        uint256 spotStart; // the pool's spot price when the round's first order landed: the crossing price stays within maxSlippageBps of it
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 200;
    uint16 public constant MAX_IMPACT_BPS = 500;
    /// Each side of a round (all buys, all sells) is capped at this share of the pool's depth when an order lands, so the
    /// net swap always fits inside MAX_IMPACT_BPS and one oversized order can't make the whole round refund.
    uint16 public constant MAX_SIDE_BPS = 400;

    SharedVault public immutable shared;
    WHYPE public immutable whype;
    ShieldedPool public immutable hypePool;
    uint64 public immutable roundSecs;
    uint16 public immutable maxSlippageBps;
    uint64 public immutable refundAfter; // seconds after round end before an unsettled batch can be refunded
    uint128 public immutable minOrder; // smallest order size, so a round can't be filled with dust

    Order[] public orders;
    mapping(address => mapping(uint64 => Batch)) public batches;
    uint256 private _lock = 1;

    event OrderPlaced(uint256 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size);
    event BatchSettled(
        address indexed token,
        uint64 indexed round,
        uint256 buyHype,
        uint256 sellTokens,
        uint256 crossedHype,
        uint256 tokensForBuyers,
        uint256 hypeForSellers
    );
    event BatchCancelled(address indexed token, uint64 indexed round);
    event OrderFilled(uint256 indexed id, uint256 amountOut);
    event OrderRefunded(uint256 indexed id);

    error Reentrancy();
    error UnknownPool();
    error BadRecipient();
    error NotStandardSize();
    error NoMarket();
    error RoundOpen();
    error AlreadySettled();
    error NotSettled();
    error PriceMoved();
    error TooEarly();
    error TooSoon();
    error RoundFull();
    error BadConfig();

    modifier lock() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(SharedVault shared_, ShieldedPool hypePool_, WHYPE whype_, uint64 roundSecs_, uint16 maxSlippageBps_, uint64 refundAfter_, uint128 minOrder_) {
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS || roundSecs_ == 0) revert BadConfig();
        if (address(hypePool_.token()) != address(whype_)) revert BadConfig();
        minOrder = minOrder_;
        shared = shared_;
        whype = whype_;
        hypePool = hypePool_;
        roundSecs = roundSecs_;
        maxSlippageBps = maxSlippageBps_;
        refundAfter = refundAfter_;
    }

    /// @dev HYPE only arrives during the batcher's own calls (WHYPE unwraps and market payouts).
    receive() external payable {
        require(_lock == 2, "direct HYPE");
    }

    function _market(address token) internal view returns (ISharedBatchMarket m) {
        m = ISharedBatchMarket(shared.marketOf(token));
        if (address(m) == address(0)) revert NoMarket();
    }

    function currentRound() public view returns (uint64) {
        return uint64(block.timestamp / roundSecs);
    }

    function roundEnd(uint64 round) public view returns (uint256) {
        return (uint256(round) + 1) * roundSecs;
    }

    function ordersCount() external view returns (uint256) {
        return orders.length;
    }

    /// @notice 1, 2 or 5 followed by zeros (in wei). Standard sizes make orders interchangeable.
    function isStandardSize(uint256 x) public pure returns (bool) {
        if (x == 0) return false;
        while (x % 10 == 0) x /= 10;
        return x == 1 || x == 2 || x == 5;
    }

    function midPrice(address token) public view returns (uint256) {
        ISharedBatchMarket pair = _market(token);
        return (pair.reserveHype() * 1e18) / pair.reserveToken();
    }

    /// @notice The round's time-weighted average price so far (1e18-scaled HYPE per token).
    function twapOf(address token, uint64 round) public view returns (uint256) {
        Batch storage b = batches[token][round];
        (uint256 cum, uint64 t) = _market(token).cumulativeNow();
        if (t <= b.tStart) return midPrice(token);
        unchecked {
            return (cum - b.cumStart) / (t - b.tStart);
        }
    }

    /// @notice A standard-size buy order paid from the HYPE vault (relayed). The order's details sit in `ext.data`,
    ///         bound by the proof; the tokens are paid out into the SharedVault.
    function placeBuy(ShieldedPool.Proof calldata proof, ShieldedPool.ExtData calldata ext) external lock returns (uint256 id) {
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        uint256 size = uint256(-ext.extAmount);
        _checkSize(size);
        OrderData memory d = abi.decode(ext.data, (OrderData));
        _market(d.token); // must be a SharedVault token
        uint256 before = whype.balanceOf(address(this));
        hypePool.transact(proof, ext); // proof-checked: `size` of WHYPE minus the vault's fee, now held here
        id = _record(d, true, size, whype.balanceOf(address(this)) - before);
    }

    /// @notice A standard-size sell order paid from the SharedVault (relayed). The proof must name the token sold.
    function placeSell(SharedVault.Proof calldata proof, SharedVault.ExtData calldata ext) external lock returns (uint256 id) {
        if (ext.recipient != address(this) || ext.extAmount >= 0) revert BadRecipient();
        uint256 size = uint256(-ext.extAmount);
        _checkSize(size);
        OrderData memory d = abi.decode(ext.data, (OrderData));
        if (proof.publicAsset != uint256(uint160(d.token))) revert UnknownPool();
        _market(d.token);
        uint256 before = IERC20(d.token).balanceOf(address(this));
        shared.transact(proof, ext); // proof-checked: `size` of the token minus the vault's fee, now held here
        id = _record(d, false, size, IERC20(d.token).balanceOf(address(this)) - before);
    }

    function _checkSize(uint256 size) internal view {
        if (!isStandardSize(size) || size >= 2 ** 128 || size < minOrder) revert NotStandardSize();
    }

    function _record(OrderData memory d, bool buy, uint256 size, uint256 net) internal returns (uint256 id) {
        uint64 round = currentRound();
        Batch storage b = batches[d.token][round];
        if (b.orders == 0) {
            (b.cumStart, b.tStart) = _market(d.token).cumulativeNow();
            b.spotStart = midPrice(d.token);
        }
        if (buy) b.buyHype += uint128(net);
        else b.sellTokens += uint128(net);
        b.orders += 1;
        // this round has room for the order on its side; otherwise it goes in a later round
        ISharedBatchMarket m = _market(d.token);
        if (buy ? uint256(b.buyHype) * 10_000 > m.reserveHype() * MAX_SIDE_BPS : uint256(b.sellTokens) * 10_000 > m.reserveToken() * MAX_SIDE_BPS) revert RoundFull();
        id = orders.length;
        orders.push(Order(d.token, round, buy, false, uint128(size), uint128(net), d.outPubKey, d.outBlinding, d.outMemo));
        emit OrderPlaced(id, d.token, round, buy, size);
    }

    /// @notice Clear a finished round: cross buys against sells at the mid-price, swap only the net through the pool.
    function settle(address token, uint64 round) external lock {
        if (round >= currentRound()) revert RoundOpen();
        Batch storage b = batches[token][round];
        if (b.settled || b.cancelled) revert AlreadySettled();
        b.settled = true;
        if (b.orders == 0) return;

        ISharedBatchMarket pair = _market(token);
        // the average must cover at least one round, so a price has to be held that long (against arbitrage) to count
        if (block.timestamp < uint256(b.tStart) + roundSecs) revert TooSoon();
        uint256 mid = twapOf(token, round); // the crossing price
        uint256 spot = midPrice(token);
        uint256 dev = spot > mid ? spot - mid : mid - spot;
        if (dev * 10_000 > mid * maxSlippageBps) revert PriceMoved();
        // and it stays within maxSlippageBps of the price when the round opened, so moving the pool after orders are in
        // can shift what the other side gets by at most that much
        uint256 lo = (b.spotStart * (10_000 - maxSlippageBps)) / 10_000;
        uint256 hi = (b.spotStart * (10_000 + maxSlippageBps)) / 10_000;
        if (mid < lo) mid = lo;
        else if (mid > hi) mid = hi;

        uint256 B = b.buyHype;
        uint256 S = b.sellTokens;
        uint256 sellValue = (S * mid) / 1e18; // HYPE value of all sells at mid
        uint256 crossed;
        if (B >= sellValue) {
            // net buy: sellers are filled entirely by buyers at mid; the rest of the buy HYPE goes through the pool
            crossed = sellValue;
            uint256 residual = B - sellValue;
            uint256 fromPool;
            uint256 extraForSellers;
            if (residual > 0) {
                if (pair.getAmountOut(residual, pair.reserveHype(), pair.reserveToken()) == 0) {
                    extraForSellers = residual; // dust: too small to trade, so it stays with the crossed side
                } else {
                    uint256 minOut = (residual * 1e18 / (spot < hi ? spot : hi)) * (10_000 - MAX_IMPACT_BPS) / 10_000; // never above the band
                    whype.withdraw(residual);
                    fromPool = pair.swapExactHypeForTokens{value: residual}(minOut, address(this));
                }
            }
            b.tokensForBuyers = uint128(S + fromPool);
            b.hypeForSellers = uint128(sellValue + extraForSellers);
        } else {
            // net sell: buyers are filled entirely by sellers at mid; the rest of the tokens go through the pool
            crossed = B;
            uint256 matchedTokens = (B * 1e18) / mid;
            uint256 residual = S - matchedTokens;
            uint256 fromPool;
            if (pair.getAmountOut(residual, pair.reserveToken(), pair.reserveHype()) == 0) {
                matchedTokens = S; // dust: too small to trade, so it stays with the crossed side
            } else {
                uint256 minOut = (residual * (spot > lo ? spot : lo) / 1e18) * (10_000 - MAX_IMPACT_BPS) / 10_000; // never below the band
                IApproveShared(token).approve(address(pair), residual);
                fromPool = pair.swapExactTokensForHype(residual, minOut, address(this));
                whype.deposit{value: fromPool}();
            }
            b.tokensForBuyers = uint128(matchedTokens);
            b.hypeForSellers = uint128(B + fromPool);
        }
        emit BatchSettled(token, round, B, S, crossed, b.tokensForBuyers, b.hypeForSellers);
    }

    /// @notice Pay out settled orders as private notes (anyone can call; outputs go to each order's one-time key).
    function claim(uint256[] calldata ids) external lock {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[ids[i]];
            if (o.done) continue;
            Batch storage b = batches[o.token][o.round];
            if (!b.settled) revert NotSettled();
            o.done = true;
            uint256 out = o.buy
                ? (uint256(b.tokensForBuyers) * o.net) / b.buyHype
                : (uint256(b.hypeForSellers) * o.net) / b.sellTokens;
            if (out == 0) continue;
            _pay(o.buy, o.token, out, o);
            emit OrderFilled(ids[i], out);
        }
    }

    /// @notice If a batch could not settle (price moved too far) within `refundAfter`, return every order's input.
    function refund(uint256[] calldata ids) external lock {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[ids[i]];
            if (o.done) continue;
            Batch storage b = batches[o.token][o.round];
            if (b.settled) revert AlreadySettled();
            if (block.timestamp < roundEnd(o.round) + refundAfter) revert TooEarly();
            if (!b.cancelled) {
                b.cancelled = true;
                emit BatchCancelled(o.token, o.round);
            }
            o.done = true;
            _pay(!o.buy, o.token, o.net, o); // a refund goes back where the order came from
            emit OrderRefunded(ids[i]);
        }
    }

    /// @dev Tokens into the SharedVault (`toShared`), or WHYPE into the HYPE vault, as a note for the order's one-time key.
    function _pay(bool toShared, address token, uint256 amount, Order storage o) internal {
        if (toShared) {
            IApproveShared(token).approve(address(shared), amount);
            shared.depositTo(token, o.outPubKey, amount, o.outBlinding, _memo(amount, o.outMemo));
        } else {
            whype.approve(address(hypePool), amount);
            hypePool.depositTo(o.outPubKey, amount, o.outBlinding, _memo(amount, o.outMemo));
        }
    }

    function _memo(uint256 amount, bytes memory enc) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(0x02), bytes16(uint128(amount)), enc);
    }
}
