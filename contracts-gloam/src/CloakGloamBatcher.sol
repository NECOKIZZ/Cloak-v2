// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGloamVault} from "gloam/GloamVaultSwap.sol";
import {IEscrowPayee, SwapEscrow2} from "gloam/SwapEscrow2.sol";

interface IV2Factory {
    function getPair(address a, address b) external view returns (address);
}

interface IV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IWHYPE {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title CloakGloamBatcher
 * @notice Cloak's batch rounds on a Gloam vault: private orders of standard sizes (1, 2 or 5 x 10^n wei) for a launch
 *         token collect into rounds; at the end buys and sells cross at the pool's spot price and only the net trades
 *         against the Uniswap V2 pair. Observers see the orders' sizes and the net, not who placed which.
 *
 * Entering. An order is one note spent with Gloam's escrow pattern: the unshield proof names a one-time escrow
 * (Gloam's SwapEscrow2, CREATE2 from the order's key), so a copier who changes the order's owner key, side, token or
 * fallback gets another escrow and the proof fails. The escrow hands what arrived (the note less the vault's fee) to
 * this contract as it opens.
 *
 * Leaving. Gloam's vault only takes a deposit with a proof for its exact amount, and an order's payout is known only
 * at settlement, so the trader comes back once: its owner key signs a deposit of exactly what it is owed, and anyone
 * (a relayer) sends it (claim). If the round can't settle in time it is cancelled and every order is owed its own
 * input back the same way. After EXIT_DELAY anyone can push an unclaimed payout to the order's fallback address, so
 * money never waits forever.
 *
 * Never stuck: the money is the note (order reverts whole), or in this contract as an order's payout with claim and
 * the timeout exit, or (if the spend was sent alone) at the order's escrow, where place() picks it up again.
 */
abstract contract CloakGloamBatcherBase is IEscrowPayee {
    struct Spend {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        address asset;
        uint256 amount;
    }

    struct Deposit {
        bytes proof;
        bytes32 commitment;
        address asset;
        uint256 amount;
    }

    struct OrderKey {
        bytes32 nullifier;
        address token;
        bool buy;
        uint128 size;
        address ownerKey;
        address fallbackTo;
    }

    struct Order {
        address token;
        uint64 round;
        bool buy;
        bool paid;
        uint128 net;
    }

    struct Batch {
        uint128 buyHype;
        uint128 sellTokens;
        uint128 tokensForBuyers;
        uint128 hypeForSellers;
        uint256 spotStart; // tokens per HYPE, 1e18 fixed point, when the round's first order landed (shown, not priced on)
        uint64 settledAt;
        bool settled;
        bool cancelled;
        uint256 cumStart; // the market's price accumulator when the round's first order landed
        uint64 tStart; // and when
        uint256 refStart; // a time-weighted price from before the round's first order, tokens per HYPE (C-01)
    }

    struct Checkpoint {
        uint256 cum;
        uint64 t;
    }

    IGloamVault public immutable vault;
    uint256 public immutable roundSecs;
    uint256 public immutable maxSlippageBps;
    uint256 public immutable refundAfter;
    uint256 public constant MAX_IMPACT_BPS = 500;
    /// @notice Each side of a round holds at most this share of the market's depth (4%), so its net trade stays inside
    ///         MAX_IMPACT_BPS and the round settles: one huge order can't make every order in it wait for a refund
    ///         (review CL-06, as Cloak v1's batchers). An order that doesn't fit goes in a later round.
    uint256 public constant MAX_SIDE_BPS = 400;
    /// @notice When a round settles the pool must be this close to the round's average (0.5%), so a push inside the
    ///         band in the settling transaction can't pay for its own round trip (review C-02).
    uint256 public constant SETTLE_BAND_BPS = 50;
    /// @notice The smallest order, and the most a vault can keep from it (Gloam's 1% fee ceiling): what lands in an
    ///         order must be a real note of its size, so orders can't be paid in from outside the vault (review C-07).
    uint256 public constant MIN_SIZE = 1e12;
    uint256 public constant MAX_VAULT_FEE_BPS = 100;
    uint256 public constant EXIT_DELAY = 30 days;
    address internal constant NATIVE = address(0);
    bytes32 private constant CLAIM_DOMAIN = keccak256("cloak.gloam.batch.claim.v1");
    bytes32 private constant CLAIM_MANY_DOMAIN = keccak256("cloak.gloam.batch.claimMany.v1");
    bytes32 private constant EXIT_DOMAIN = keccak256("cloak.gloam.batch.exit.v1");

    mapping(bytes32 => Order) public orders; // by keccak256(abi.encode(OrderKey))
    /// @notice Orders whose spend was sent alone and no longer fit a round: owed their input back (review C-03).
    mapping(bytes32 => uint64) public refundOnlySince;
    /// @notice Per token, two price checkpoints at least a round apart: the reference a round's prices are checked
    ///         against comes from them, never from one block (review C-01). Anyone may add one (checkpoint()).
    mapping(address => Checkpoint) public cpOld;
    mapping(address => Checkpoint) public cpNew;
    mapping(address => mapping(uint64 => Batch)) public batches;

    uint256 private _entered;
    bool private _opening;
    bool private _settling;

    event OrderPlaced(bytes32 indexed id, address indexed token, uint64 indexed round, bool buy, uint256 size, uint256 net);
    event BatchSettled(address indexed token, uint64 indexed round, uint256 tokensForBuyers, uint256 hypeForSellers, int256 netHype);
    event BatchCancelled(address indexed token, uint64 indexed round);
    event OrderPaid(bytes32 indexed id, address indexed asset, uint256 amount, bool toVault);

    error Reentrancy();
    error NotStandard();
    error BadKey();
    error Used();
    error NotYet();
    error Done();
    error Slipped();
    error Impact();
    error BadSignature();
    error WrongAmount(uint256 owed);
    error NoPair();
    error TooLate();
    error RoundFull();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address vault_, uint256 roundSecs_, uint256 maxSlippageBps_, uint256 refundAfter_) {
        // a round needs time to settle once its average covers a round (review C-13)
        require(maxSlippageBps_ <= 200 && roundSecs_ > 0 && refundAfter_ >= roundSecs_, "params");
        vault = IGloamVault(vault_);
        roundSecs = roundSecs_;
        maxSlippageBps = maxSlippageBps_;
        refundAfter = refundAfter_;
    }

    receive() external payable {
        // HYPE comes in from an order's escrow as it opens, or from the venue while settling
        if (!_opening && !_venueMayPay(msg.sender)) revert Used();
    }

    /// @dev A round is being settled (the venue may pay HYPE in).
    function _inSettle() internal view returns (bool) {
        return _settling;
    }

    // ── the venue: where a token's price comes from and where the net trades ──

    /// @dev Whether `token` has a market to trade the net against.
    function _hasMarket(address token) internal view virtual returns (bool);

    /// @dev The market's HYPE and token reserves, for the round's spot price.
    function _reserves(address token) internal view virtual returns (uint256 rH, uint256 rT);

    /// @dev The market's price accumulator now (wraps; only differences mean anything). It must count a price only for
    ///      the time it was held, as Uniswap V2's cumulative prices and CloakV4Hook's do, so one transaction can't move it.
    function _cumulative(address token) internal view virtual returns (uint256);

    /// @dev The average price, in wei of HYPE per 1e18 token units, from an accumulator difference over `dt` seconds.
    function _averagePrice(uint256 dCum, uint256 dt) internal pure virtual returns (uint256);

    /// @dev Buy tokens with `hypeIn` of HYPE held here; returns what arrived.
    function _swapHypeForTokens(address token, uint256 hypeIn) internal virtual returns (uint256 out);

    /// @dev Sell `tokensIn` held here for HYPE; returns what arrived.
    function _swapTokensForHype(address token, uint256 tokensIn) internal virtual returns (uint256 out);

    /// @dev Who may pay HYPE in outside an escrow opening (WHYPE unwrapping, a market paying out while settling).
    function _venueMayPay(address from) internal view virtual returns (bool);

    /// @notice SwapEscrow2 asks where to pay: always here.
    function escrowPayee() external view returns (address) {
        return address(this);
    }

    function idOf(OrderKey calldata k) public pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    /// @notice The address an order's unshield proof must name.
    function escrowFor(OrderKey calldata k) public view returns (address) {
        address asset = k.buy ? NATIVE : k.token;
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(asset)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), idOf(k), codeHash)))));
    }

    function currentRound() public view returns (uint64) {
        return uint64(block.timestamp / roundSecs);
    }

    /// @notice 1, 2 or 5 times a power of ten.
    function isStandard(uint256 x) public pure returns (bool) {
        if (x == 0) return false;
        while (x % 10 == 0) x /= 10;
        return x == 1 || x == 2 || x == 5;
    }

    /// @notice Place an order: the note (a standard size of HYPE to buy, or of the token to sell) into this round.
    function place(Spend calldata s, OrderKey calldata k) external nonReentrant returns (bytes32 id) {
        address asset = k.buy ? NATIVE : k.token;
        if (s.nullifier != k.nullifier || s.asset != asset || s.amount != k.size || k.ownerKey == address(0) || k.fallbackTo == address(0)) revert BadKey();
        if (!isStandard(k.size) || k.size < MIN_SIZE) revert NotStandard();
        if (!_hasMarket(k.token)) revert NoPair();
        id = idOf(k);
        if (orders[id].net != 0) revert Used();
        address escrow = escrowFor(k);
        bool sentAlone = vault.isSpent(s.nullifier);
        if (!sentAlone) vault.unshield(s.proof, s.root, s.nullifier, asset, escrow, s.amount);
        uint256 net = _openEscrow(id, asset);
        // what landed is a note of this size less at most the vault's fee ceiling: not an amount paid in from outside
        if (net > k.size || net * 10_000 < uint256(k.size) * (10_000 - MAX_VAULT_FEE_BPS)) revert NotStandard();
        _checkpoint(k.token);
        uint64 round = currentRound();
        Batch storage b = batches[k.token][round];
        {
            // each side holds at most MAX_SIDE_BPS of the pool, so the round always settles
            (uint256 rH, uint256 rT) = _reserves(k.token);
            bool fits = k.buy ? (uint256(b.buyHype) + net) * 10_000 <= rH * MAX_SIDE_BPS : (uint256(b.sellTokens) + net) * 10_000 <= rT * MAX_SIDE_BPS;
            if (!fits) {
                if (!sentAlone) revert RoundFull(); // reverts whole: the note stays in the vault
                // the spend was sent alone (its proof is public) and the order no longer fits: it joins no round and is
                // owed its input back, so the escrow's money is never stuck (review C-03)
                orders[id] = Order(k.token, 0, k.buy, false, uint128(net));
                refundOnlySince[id] = uint64(block.timestamp);
                emit OrderPlaced(id, k.token, 0, k.buy, k.size, net);
                return id;
            }
        }
        if (b.buyHype == 0 && b.sellTokens == 0) {
            b.spotStart = _spot(k.token);
            b.refStart = referencePrice(k.token);
            b.cumStart = _cumulative(k.token);
            b.tStart = uint64(block.timestamp);
        }
        if (k.buy) b.buyHype += uint128(net);
        else b.sellTokens += uint128(net);
        orders[id] = Order(k.token, round, k.buy, false, uint128(net));
        emit OrderPlaced(id, k.token, round, k.buy, k.size, net);
    }

    /**
     * @notice Cross a finished round at the market's average price over the round and trade the net against it. Anyone
     *         can call it, from `settleOpens` until `refundAfter` later; after that the round can only be cancelled.
     * @dev The price is time-weighted from the round's first order to now, over at least one round, so moving the pool
     *      in the settling transaction (or pinning it in the block of the first order) shifts it only by the share of
     *      time the moved price was held, against arbitrage. The pool must also be within maxSlippageBps of that
     *      average when the net trades, and the net trade within MAX_IMPACT_BPS of it.
     */
    function settle(address token, uint64 round) external nonReentrant {
        _settling = true;
        _settle(token, round);
        _settling = false;
    }

    function _settle(address token, uint64 round) private {
        Batch storage b = batches[token][round];
        if (b.settled || b.cancelled) revert Done();
        uint256 opens = settleOpens(token, round);
        if (block.timestamp < opens) revert NotYet();
        if (block.timestamp >= opens + refundAfter) revert TooLate();
        uint256 avgHypePerToken;
        unchecked {
            avgHypePerToken = _averagePrice(_cumulative(token) - b.cumStart, block.timestamp - b.tStart);
        }
        if (avgHypePerToken == 0) revert Slipped();
        uint256 spot = (1e36) / avgHypePerToken; // the crossing price, tokens per HYPE (1e18 fixed point)
        // the pool must sit close to that average as the net trades: a push in the settling transaction can't move what
        // the net gets by more than SETTLE_BAND_BPS (review C-02)
        if (_off(_spot(token), spot) > SETTLE_BAND_BPS) revert Slipped();
        // and the average must be within maxSlippageBps of where the round opened: the spot when its first order landed,
        // or a time-weighted price from before it (KupiaSec, Nov 6). One transaction can pin the spot but not the
        // time-weighted price (review C-01), and a move held through the round is away from both: then the round is
        // refunded, never crossed at a band's edge.
        if (_off(spot, b.spotStart) > maxSlippageBps && _off(spot, b.refStart) > maxSlippageBps) revert Slipped();
        uint256 sellsInHype = (uint256(b.sellTokens) * 1e18) / spot;
        int256 netHype;
        if (b.buyHype >= sellsInHype) {
            uint256 extra = b.buyHype - sellsInHype;
            uint256 got = extra == 0 ? 0 : _swapHypeForTokens(token, extra);
            if (got * 10_000 < ((extra * spot) / 1e18) * (10_000 - MAX_IMPACT_BPS)) revert Impact();
            b.tokensForBuyers = uint128(b.sellTokens + got);
            b.hypeForSellers = uint128(sellsInHype);
            netHype = int256(extra);
        } else {
            uint256 extraTokens = b.sellTokens - (uint256(b.buyHype) * spot) / 1e18;
            uint256 got = _swapTokensForHype(token, extraTokens);
            if (got * 10_000 < ((extraTokens * 1e18) / spot) * (10_000 - MAX_IMPACT_BPS)) revert Impact();
            b.tokensForBuyers = uint128((uint256(b.buyHype) * spot) / 1e18);
            b.hypeForSellers = uint128(b.buyHype + got);
            netHype = -int256(got);
        }
        b.settled = true;
        b.settledAt = uint64(block.timestamp);
        emit BatchSettled(token, round, b.tokensForBuyers, b.hypeForSellers, netHype);
    }

    /// @notice A round that couldn't settle within refundAfter is cancelled: every order is owed its own input back.
    function cancel(address token, uint64 round) external {
        Batch storage b = batches[token][round];
        if (b.settled || b.cancelled) revert Done();
        if (settleOpens(token, round) + refundAfter > block.timestamp) revert NotYet();
        b.cancelled = true;
        b.settledAt = uint64(block.timestamp);
        emit BatchCancelled(token, round);
    }

    /// @notice When a round can first be settled: once it has ended and its average covers at least one round.
    function settleOpens(address token, uint64 round) public view returns (uint256) {
        uint256 ends = uint256(round + 1) * roundSecs;
        uint256 minWindow = uint256(batches[token][round].tStart) + roundSecs;
        return ends > minWindow ? ends : minWindow;
    }

    /// @notice What an order is owed now (0 before its round settles or is cancelled), and in which asset.
    function owed(bytes32 id) public view returns (address asset, uint256 amount) {
        Order storage o = orders[id];
        if (o.paid || o.net == 0) return (address(0), 0);
        if (o.round == 0) return refundOnlySince[id] != 0 ? (o.buy ? NATIVE : o.token, uint256(o.net)) : (address(0), 0);
        Batch storage b = batches[o.token][o.round];
        if (b.cancelled) return (o.buy ? NATIVE : o.token, o.net);
        if (!b.settled) return (address(0), 0);
        if (o.buy) return (o.token, (uint256(b.tokensForBuyers) * o.net) / b.buyHype);
        return (NATIVE, (uint256(b.hypeForSellers) * o.net) / b.sellTokens);
    }

    function claimDigest(bytes32 id, bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_DOMAIN, block.chainid, address(this), id, commitment));
    }

    /// @notice Pay an order into the vault as one note of exactly what it is owed, as its owner key signed.
    function claim(OrderKey calldata k, Deposit calldata d, bytes calldata signature) external nonReentrant {
        bytes32 id = idOf(k);
        if (_recover(claimDigest(id, d.commitment), signature) != k.ownerKey) revert BadSignature();
        (address asset, uint256 amount) = owed(id);
        if (amount == 0) revert NotYet();
        if (d.asset != asset || d.amount != amount) revert WrongAmount(amount);
        orders[id].paid = true;
        if (asset == NATIVE) {
            vault.shieldBound{value: amount}(NATIVE, amount, d.commitment, d.proof);
        } else {
            IERC20B(asset).approve(address(vault), amount);
            vault.shieldBound(asset, amount, d.commitment, d.proof);
            IERC20B(asset).approve(address(vault), 0);
        }
        emit OrderPaid(id, asset, amount, true);
    }

    function claimManyDigest(bytes32 id, bytes32[] memory commitments) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_MANY_DOMAIN, block.chainid, address(this), id, keccak256(abi.encode(commitments))));
    }

    /**
     * @notice Pay an order into the vault as several notes that add up to exactly what it is owed, as its owner key
     *         signed: for a payout bigger than the vault's per-deposit cap (review C-04).
     */
    function claimMany(OrderKey calldata k, Deposit[] calldata ds, bytes calldata signature) external nonReentrant {
        bytes32 id = idOf(k);
        bytes32[] memory cs = new bytes32[](ds.length);
        for (uint256 i; i < ds.length; ++i) cs[i] = ds[i].commitment;
        if (ds.length == 0 || _recover(claimManyDigest(id, cs), signature) != k.ownerKey) revert BadSignature();
        (address asset, uint256 amount) = owed(id);
        if (amount == 0) revert NotYet();
        uint256 sum;
        for (uint256 i; i < ds.length; ++i) {
            if (ds[i].asset != asset) revert WrongAmount(amount);
            sum += ds[i].amount;
        }
        if (sum != amount) revert WrongAmount(amount);
        orders[id].paid = true;
        for (uint256 i; i < ds.length; ++i) {
            if (asset == NATIVE) {
                vault.shieldBound{value: ds[i].amount}(NATIVE, ds[i].amount, ds[i].commitment, ds[i].proof);
            } else {
                IERC20B(asset).approve(address(vault), ds[i].amount);
                vault.shieldBound(asset, ds[i].amount, ds[i].commitment, ds[i].proof);
            }
        }
        if (asset != NATIVE) IERC20B(asset).approve(address(vault), 0);
        emit OrderPaid(id, asset, amount, true);
    }

    function exitDigest(bytes32 id, address to) public view returns (bytes32) {
        return keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), id, to));
    }

    /**
     * @notice Pay what an order is owed in the clear to `to`, as its owner key signed: for when the vault won't take it
     *         back (its cap is full, review C-05). Public, so the app uses it only when a claim can't go through.
     */
    function exit(OrderKey calldata k, address to, bytes calldata signature) external nonReentrant {
        bytes32 id = idOf(k);
        if (to == address(0) || to == address(vault) || _recover(exitDigest(id, to), signature) != k.ownerKey) revert BadSignature();
        (address asset, uint256 amount) = owed(id);
        if (amount == 0) revert NotYet();
        orders[id].paid = true;
        if (asset == NATIVE) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "send");
        } else {
            require(IERC20B(asset).transfer(to, amount), "send");
        }
        emit OrderPaid(id, asset, amount, false);
    }

    /// @notice EXIT_DELAY after its round settled or was cancelled, anyone can push an unclaimed payout to the fallback.
    function exitAfterTimeout(OrderKey calldata k) external nonReentrant {
        bytes32 id = idOf(k);
        Order storage o = orders[id];
        uint256 since = o.round == 0 ? refundOnlySince[id] : batches[o.token][o.round].settledAt;
        if (since == 0 || block.timestamp < since + EXIT_DELAY) revert NotYet();
        (address asset, uint256 amount) = owed(id);
        if (amount == 0) revert Done();
        o.paid = true;
        if (asset == NATIVE) {
            (bool ok, ) = k.fallbackTo.call{value: amount}("");
            require(ok, "send");
        } else {
            require(IERC20B(asset).transfer(k.fallbackTo, amount), "send");
        }
        emit OrderPaid(id, asset, amount, false);
    }

    // ── internals ──────────────────────────────────────────────────────

    function _openEscrow(bytes32 salt, address asset) private returns (uint256 arrived) {
        uint256 before = asset == NATIVE ? address(this).balance : IERC20B(asset).balanceOf(address(this));
        bytes memory code = abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(asset));
        address e;
        _opening = true;
        assembly {
            e := create2(0, add(code, 0x20), mload(code), salt)
        }
        _opening = false;
        if (e == address(0)) revert Used();
        arrived = (asset == NATIVE ? address(this).balance : IERC20B(asset).balanceOf(address(this))) - before;
        if (arrived == 0) revert Used();
    }

    /// @dev Tokens per HYPE, 1e18 fixed point, from the market's reserves.
    function _spot(address token) private view returns (uint256) {
        (uint256 rH, uint256 rT) = _reserves(token);
        return (rT * 1e18) / rH;
    }

    /// @dev How far `a` is from `ref`, in basis points of `ref`.
    function _off(uint256 a, uint256 ref) private pure returns (uint256) {
        if (ref == 0) return type(uint256).max;
        return ((a > ref ? a - ref : ref - a) * 10_000) / ref;
    }

    /**
     * @notice A time-weighted price for `token` (tokens per HYPE, 1e18 fixed point) from its newest checkpoint that is at
     *         least a round old (or the one before it), so no single transaction can set it. Before the token has any
     *         history it is the spot.
     */
    function referencePrice(address token) public view returns (uint256) {
        Checkpoint memory n = cpNew[token];
        Checkpoint memory base = (n.t != 0 && block.timestamp >= uint256(n.t) + roundSecs) ? n : cpOld[token];
        if (base.t == 0 || block.timestamp <= base.t) return _spot(token);
        uint256 avg;
        unchecked {
            avg = _averagePrice(_cumulative(token) - base.cum, block.timestamp - base.t);
        }
        return avg == 0 ? _spot(token) : 1e36 / avg;
    }

    /// @notice Record a price checkpoint for `token` (anyone; the keeper does it for quiet tokens). At most one a round.
    function checkpoint(address token) external {
        if (!_hasMarket(token)) revert NoPair();
        _checkpoint(token);
    }

    function _checkpoint(address token) internal {
        Checkpoint storage n = cpNew[token];
        if (n.t == 0) {
            n.cum = _cumulative(token);
            n.t = uint64(block.timestamp);
        } else if (block.timestamp >= uint256(n.t) + roundSecs) {
            cpOld[token] = n;
            cpNew[token] = Checkpoint(_cumulative(token), uint64(block.timestamp));
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}

/**
 * @title CloakGloamBatcher
 * @notice The Uniswap V2 venue for CloakGloamBatcherBase: a token's market is its V2 pair with WHYPE.
 */
contract CloakGloamBatcher is CloakGloamBatcherBase {
    IV2Factory public immutable factory;
    IWHYPE public immutable whype;

    constructor(address vault_, address factory_, address whype_, uint256 roundSecs_, uint256 maxSlippageBps_, uint256 refundAfter_)
        CloakGloamBatcherBase(vault_, roundSecs_, maxSlippageBps_, refundAfter_)
    {
        factory = IV2Factory(factory_);
        whype = IWHYPE(whype_);
    }

    function _hasMarket(address token) internal view override returns (bool) {
        return factory.getPair(address(whype), token) != address(0);
    }

    function _venueMayPay(address from) internal view override returns (bool) {
        return from == address(whype);
    }

    function _reserves(address token) internal view override returns (uint256 rH, uint256 rT) {
        address pair = factory.getPair(address(whype), token);
        if (pair == address(0)) revert NoPair();
        (uint112 r0, uint112 r1, ) = IV2Pair(pair).getReserves();
        (rH, rT) = IV2Pair(pair).token0() == address(whype) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev The pair's cumulative HYPE-per-token price now (UQ112x112 × seconds), as Uniswap's oracle library computes it.
    function _cumulative(address token) internal view override returns (uint256 c) {
        address pair = factory.getPair(address(whype), token);
        if (pair == address(0)) revert NoPair();
        bool hypeIs0 = IV2Pair(pair).token0() == address(whype);
        c = hypeIs0 ? IV2Pair(pair).price1CumulativeLast() : IV2Pair(pair).price0CumulativeLast();
        (uint112 r0, uint112 r1, uint32 tLast) = IV2Pair(pair).getReserves();
        uint32 t = uint32(block.timestamp);
        if (tLast != t && r0 != 0 && r1 != 0) {
            (uint256 rH, uint256 rT) = hypeIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            unchecked {
                c += ((rH << 112) / rT) * (t - tLast);
            }
        }
    }

    function _averagePrice(uint256 dCum, uint256 dt) internal pure override returns (uint256) {
        if (dt == 0) return 0;
        return ((dCum / dt) * 1e18) >> 112;
    }

    function _out(uint256 amountIn, uint256 rIn, uint256 rOut) private pure returns (uint256) {
        uint256 x = amountIn * 997;
        return (x * rOut) / (rIn * 1000 + x);
    }

    function _swapHypeForTokens(address token, uint256 hypeIn) internal override returns (uint256 out) {
        address pair = factory.getPair(address(whype), token);
        (uint256 rH, uint256 rT) = _reserves(token);
        out = _out(hypeIn, rH, rT);
        whype.deposit{value: hypeIn}();
        whype.transfer(pair, hypeIn);
        bool hypeIs0 = IV2Pair(pair).token0() == address(whype);
        uint256 before = IERC20B(token).balanceOf(address(this));
        IV2Pair(pair).swap(hypeIs0 ? 0 : out, hypeIs0 ? out : 0, address(this), "");
        out = IERC20B(token).balanceOf(address(this)) - before; // what arrived, for a token that skims
    }

    function _swapTokensForHype(address token, uint256 tokensIn) internal override returns (uint256 out) {
        address pair = factory.getPair(address(whype), token);
        uint256 b0 = IERC20B(token).balanceOf(pair);
        require(IERC20B(token).transfer(pair, tokensIn), "t");
        (uint256 rH, uint256 rT) = _reserves(token);
        uint256 arrived = IERC20B(token).balanceOf(pair) - b0;
        out = _out(arrived, rT, rH);
        bool hypeIs0 = IV2Pair(pair).token0() == address(whype);
        IV2Pair(pair).swap(hypeIs0 ? out : 0, hypeIs0 ? 0 : out, address(this), "");
        whype.withdraw(out);
    }
}
