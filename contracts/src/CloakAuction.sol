// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakPair, IERC20Min} from "./CloakPair.sol";
import {CloakConfig} from "./CloakConfig.sol";

interface IERC20Approve is IERC20Min {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title CloakAuction
/// @notice Sealed-bid, uniform-price token launch.
///
///  COMMIT  — `commit(hash, sealedBid)` with an over-collateralised HYPE deposit. Only a hash (and a drand-timelocked
///            ciphertext of the bid, opaque to the chain) is visible, so ordering and priority fees buy nothing.
///  REVEAL  — anyone can open any bid with its preimage (the keeper decrypts the timelock once the drand round passes).
///  SETTLE  — walks price ticks high→low to find the single clearing price; seeds a CloakPair at exactly that price
///            and locks (or burns) the LP shares.
///  CLAIM   — every winner pays the same price; the rest of the deposit is refunded.
///
///  Money out is pull-based: the creator's proceeds and the launch fee are credited at settlement and withdrawn
///  separately, so a recipient that can't take HYPE can never block settlement or anyone's claim.
///  The launch fee and the deposit caps are read from CloakConfig when the auction is created and never change for it.
contract CloakAuction {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_TICKS = 256;
    uint16 public constant MIN_NO_REVEAL_PENALTY_BPS = 1_000; // withholding a sealed bid always costs 10%
    // drand quicknet (the network sealed bids are encrypted to)
    uint256 public constant DRAND_GENESIS = 1692803367;
    uint256 public constant DRAND_PERIOD = 3;
    uint256 public constant REVEAL_MARGIN = 30; // seconds the keeper needs between the round and the end of reveals

    struct Params {
        address creator; // receives the raise (minus LP) and, after the lock, the LP shares
        uint256 saleSupply; // tokens sold in the auction
        uint256 lpReserve; // tokens reserved to pair with HYPE in the pool
        uint256 minPrice; // wei of HYPE per 1e18 token units at tick 0
        uint256 tickSize; // price step between ticks
        uint16 numTicks; // number of price levels (1..256)
        uint64 commitEnd;
        uint64 revealEnd;
        uint16 lpBps; // share of the raise that goes into the pool
        uint16 noRevealPenaltyBps; // burned from deposits that never get revealed
        uint64 lpLockUntil; // 0 = LP shares are burned forever
        uint64 tlockRound; // drand round the sealed bids are encrypted to (metadata for clients/keepers)
    }

    struct Bid {
        address bidder;
        uint16 tick;
        bool revealed;
        bool claimed;
        uint128 deposit;
        uint128 quantity;
        bytes32 commitment;
    }

    struct Reveal {
        uint256 id;
        uint16 tick;
        uint128 quantity;
        bytes32 salt;
    }

    address public immutable factory;
    CloakConfig public immutable config;
    uint16 public immutable launchFeeBps;
    uint256 public immutable bidCap; // 0 = no cap
    uint256 public immutable depositCap; // 0 = no cap
    IERC20Approve public token;
    Params public params;

    Bid[] internal _bids;
    uint256[MAX_TICKS] public demand;
    uint256 public totalDemand;
    uint256 public revealCount;
    uint256 public totalDeposits;

    bool public settled;
    bool public failed;
    uint16 public clearingTick;
    uint256 public clearingPrice;
    uint256 public sold;
    uint256 public marginalRemaining; // tokens available to the clearing tick
    uint256 public marginalDemand; // tokens demanded at the clearing tick
    uint256 public raised;
    CloakPair public pair;
    uint256 public lpShares;
    bool public lpReleased;
    uint256 public creatorOwed; // proceeds waiting for withdrawProceeds()
    uint256 public feesOwed; // launch fee waiting for collectFees()
    uint256 public claimedCount;
    /// @notice Refunds a bidder's address couldn't take when claimed, waiting for withdrawRefund().
    mapping(address => uint256) public refundOwed;
    uint256 internal refundsHeld;

    event Committed(uint256 indexed id, address indexed bidder, uint256 deposit, bytes32 commitment, bytes sealedBid);
    event Revealed(uint256 indexed id, address indexed bidder, uint16 tick, uint256 quantity);
    event Settled(uint16 clearingTick, uint256 clearingPrice, uint256 sold, uint256 raised);
    event FairLaunch(
        address indexed token,
        address pair,
        uint256 clearingPrice,
        uint256 sold,
        uint256 raised,
        uint256 lpHype,
        uint256 lpTokens,
        uint64 lpLockUntil,
        uint256 bidders,
        uint256 commits
    );
    event Failed();
    event Claimed(uint256 indexed id, address indexed bidder, uint256 tokens, uint256 refund, uint256 penalty);
    event LPReleased(address to, uint256 shares);
    event ProceedsWithdrawn(address to, uint256 amount);
    event FeesCollected(address to, uint256 amount);
    event DustSwept(uint256 hype, uint256 tokens);
    event RefundHeld(address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed bidder, address to, uint256 amount);

    modifier onlyFactory() {
        require(msg.sender == factory, "factory");
        _;
    }

    constructor(Params memory p, CloakConfig config_) {
        require(p.creator != address(0), "creator");
        require(p.saleSupply > 0 && p.minPrice > 0, "supply/price");
        require(p.numTicks > 0 && p.numTicks <= MAX_TICKS, "ticks");
        require(p.numTicks == 1 || p.tickSize > 0, "tickSize");
        require(p.commitEnd > block.timestamp && p.revealEnd > p.commitEnd, "times");
        require(p.lpBps <= 10_000 && p.noRevealPenaltyBps <= 5_000, "bps");
        require(p.noRevealPenaltyBps >= MIN_NO_REVEAL_PENALTY_BPS, "penalty");
        require(p.lpLockUntil == 0 || p.lpLockUntil >= p.revealEnd, "lock");
        if (p.tlockRound != 0) {
            // the round must open after bidding closes and early enough for the keeper to reveal before the end
            uint256 at = DRAND_GENESIS + (uint256(p.tlockRound) - 1) * DRAND_PERIOD;
            require(at >= p.commitEnd && at + REVEAL_MARGIN <= p.revealEnd, "tlock round");
        }
        factory = msg.sender;
        params = p;
        config = config_;
        launchFeeBps = config_.launchFeeBps();
        (uint128 perBid, uint128 total) = config_.auctionLimit();
        bool capped = config_.depositLimitsOn();
        bidCap = capped ? perBid : 0;
        depositCap = capped ? total : 0;
        if (capped) require(perBid > 0 && total > 0, "auctions closed");
    }

    function init(address token_) external onlyFactory {
        require(address(token) == address(0), "init");
        token = IERC20Approve(token_);
    }

    // ───────────────────────────── views ─────────────────────────────

    function priceAt(uint16 tick) public view returns (uint256) {
        return params.minPrice + uint256(tick) * params.tickSize;
    }

    /// @notice keccak256(abi.encode(auction, bidder, tick, quantity, salt)) — what `commit` expects.
    function commitmentOf(address bidder, uint16 tick, uint128 quantity, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), bidder, tick, quantity, salt));
    }

    function costOf(uint16 tick, uint256 quantity) public view returns (uint256) {
        return _mulDivUp(priceAt(tick), quantity, 1e18);
    }

    function bidsCount() external view returns (uint256) {
        return _bids.length;
    }

    function getBid(uint256 id) external view returns (Bid memory) {
        return _bids[id];
    }

    function demandCurve() external view returns (uint256[] memory curve) {
        curve = new uint256[](params.numTicks);
        for (uint256 t; t < params.numTicks; ++t) {
            curve[t] = demand[t];
        }
    }

    /// @notice 0 = commit, 1 = reveal, 2 = awaiting settle, 3 = settled.
    function phase() external view returns (uint8) {
        if (settled) return 3;
        if (block.timestamp < params.commitEnd) return 0;
        if (block.timestamp < params.revealEnd) return 1;
        return 2;
    }

    /// @notice Tokens and refund a bid will receive once settled.
    function allocationOf(uint256 id) public view returns (uint256 tokens, uint256 refund, uint256 penalty) {
        Bid storage b = _bids[id];
        if (!settled) return (0, 0, 0);
        if (!b.revealed) {
            penalty = failed ? 0 : (uint256(b.deposit) * params.noRevealPenaltyBps) / 10_000;
            return (0, b.deposit - penalty, penalty);
        }
        if (failed || b.tick < clearingTick) return (0, b.deposit, 0);
        tokens = b.tick > clearingTick ? b.quantity : (uint256(b.quantity) * marginalRemaining) / marginalDemand;
        refund = b.deposit - _mulDivUp(clearingPrice, tokens, 1e18);
    }

    // ───────────────────────────── commit ─────────────────────────────

    /// @param commitment keccak256(abi.encode(auction, msg.sender, tick, quantity, salt))
    /// @param sealedBid  drand-tlock ciphertext of the preimage; the chain never reads it, keepers decrypt it after the round
    function commit(bytes32 commitment, bytes calldata sealedBid) external payable returns (uint256 id) {
        require(address(token) != address(0), "init");
        require(block.timestamp < params.commitEnd, "commit closed");
        require(msg.value > 0 && msg.value <= type(uint128).max, "deposit");
        if (bidCap != 0) require(msg.value <= bidCap && totalDeposits + msg.value <= depositCap, "over cap");
        id = _bids.length;
        _bids.push(
            Bid({
                bidder: msg.sender,
                tick: 0,
                revealed: false,
                claimed: false,
                deposit: uint128(msg.value),
                quantity: 0,
                commitment: commitment
            })
        );
        totalDeposits += msg.value;
        emit Committed(id, msg.sender, msg.value, commitment, sealedBid);
    }

    // ───────────────────────────── reveal ─────────────────────────────

    /// @notice Anyone may reveal anyone's bid: knowledge of the preimage is the only authority needed.
    function reveal(uint256 id, uint16 tick, uint128 quantity, bytes32 salt) external {
        require(_inReveal(), "not reveal phase");
        require(_tryReveal(id, tick, quantity, salt), "invalid reveal");
    }

    /// @notice Keeper-friendly batch: invalid entries are skipped instead of reverting the batch.
    function revealBatch(Reveal[] calldata reveals) external returns (uint256 ok) {
        require(_inReveal(), "not reveal phase");
        for (uint256 i; i < reveals.length; ++i) {
            Reveal calldata r = reveals[i];
            if (_tryReveal(r.id, r.tick, r.quantity, r.salt)) ++ok;
        }
    }

    function _inReveal() internal view returns (bool) {
        return block.timestamp >= params.commitEnd && block.timestamp < params.revealEnd;
    }

    function _tryReveal(uint256 id, uint16 tick, uint128 quantity, bytes32 salt) internal returns (bool) {
        if (id >= _bids.length) return false;
        Bid storage b = _bids[id];
        if (b.revealed || tick >= params.numTicks || quantity == 0) return false;
        if (commitmentOf(b.bidder, tick, quantity, salt) != b.commitment) return false;
        if (costOf(tick, quantity) > b.deposit) return false;
        b.revealed = true;
        b.tick = tick;
        b.quantity = quantity;
        demand[tick] += quantity;
        totalDemand += quantity;
        ++revealCount;
        emit Revealed(id, b.bidder, tick, quantity);
        return true;
    }

    // ───────────────────────────── settle ─────────────────────────────

    function settle() external {
        require(block.timestamp >= params.revealEnd, "reveal open");
        require(!settled, "settled");
        settled = true;
        Params memory p = params;

        if (totalDemand == 0) {
            failed = true;
            require(token.transfer(p.creator, p.saleSupply + p.lpReserve), "t");
            emit Failed();
            return;
        }

        // Walk high → low. The first tick where cumulative demand covers supply is the clearing tick; if supply is never
        // covered, everyone fills and the lowest revealed tick sets the price.
        uint256 cum;
        uint16 lowest;
        bool covered;
        for (uint256 i = p.numTicks; i > 0; --i) {
            uint16 t = uint16(i - 1);
            uint256 d = demand[t];
            if (d == 0) continue;
            if (cum + d >= p.saleSupply) {
                clearingTick = t;
                marginalRemaining = p.saleSupply - cum;
                marginalDemand = d;
                sold = p.saleSupply;
                covered = true;
                break;
            }
            cum += d;
            lowest = t;
        }
        if (!covered) {
            clearingTick = lowest;
            marginalRemaining = demand[lowest];
            marginalDemand = demand[lowest];
            sold = totalDemand;
        }

        uint256 price = priceAt(clearingTick);
        clearingPrice = price;
        // Pro-rata fills round down and payments round up, so bidders always pay at least price × filled. The buffer
        // keeps the contract solvent against the gap between `sold` and the sum of rounded-down fills.
        uint256 gross = (price * sold) / 1e18;
        uint256 buffer = revealCount * (price / 1e18 + 1);
        raised = gross > buffer ? gross - buffer : 0;

        uint256 fee = (raised * launchFeeBps) / 10_000;
        feesOwed = fee;
        uint256 net = raised - fee;
        uint256 lpHype = (net * p.lpBps) / 10_000;
        uint256 lpTokens = lpHype == 0 ? 0 : (lpHype * 1e18) / price;
        if (lpTokens > p.lpReserve) {
            lpTokens = p.lpReserve;
            lpHype = (lpTokens * price) / 1e18;
        }
        if (lpHype > 1e6 && lpTokens > 1e6) {
            pair = new CloakPair(address(token));
            require(token.approve(address(pair), lpTokens), "approve");
            lpShares = pair.addLiquidity{value: lpHype}(lpTokens, 0, p.lpLockUntil == 0 ? DEAD : address(this));
        } else {
            lpHype = 0;
            lpTokens = 0;
        }

        uint256 unused = (p.saleSupply - sold) + (p.lpReserve - lpTokens);
        if (unused > 0) require(token.transfer(DEAD, unused), "burn");
        creatorOwed = net - lpHype;

        emit Settled(clearingTick, price, sold, raised);
        emit FairLaunch(
            address(token),
            address(pair),
            price,
            sold,
            raised,
            lpHype,
            lpTokens,
            p.lpLockUntil,
            revealCount,
            _bids.length
        );
    }

    // ───────────────────────────── claim ─────────────────────────────

    /// @notice Anyone can push a bid's tokens and refund to its bidder.
    function claim(uint256 id) public {
        require(settled, "not settled");
        Bid storage b = _bids[id];
        require(!b.claimed, "claimed");
        (uint256 tokens, uint256 refund, uint256 penalty) = allocationOf(id);
        b.claimed = true;
        ++claimedCount;
        if (tokens > 0) require(token.transfer(b.bidder, tokens), "t");
        if (penalty > 0) _sendHype(DEAD, penalty);
        // A bidder whose address can't take HYPE (or burns the gas it's given) must not block its own tokens, a
        // keeper's batch or the dust sweep: the refund is held for it instead, to pull to any address.
        if (refund > 0 && !_trySendHype(b.bidder, refund)) {
            refundOwed[b.bidder] += refund;
            refundsHeld += refund;
            emit RefundHeld(b.bidder, refund);
        }
        emit Claimed(id, b.bidder, tokens, refund, penalty);
    }

    /// @notice Pull a refund that couldn't be sent at claim time, to any address (only the bidder can).
    function withdrawRefund(address to) external {
        uint256 amount = refundOwed[msg.sender];
        require(amount > 0, "nothing");
        refundOwed[msg.sender] = 0;
        refundsHeld -= amount;
        _sendHype(to, amount);
        emit RefundWithdrawn(msg.sender, to, amount);
    }

    function claimBatch(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            if (!_bids[ids[i]].claimed) claim(ids[i]);
        }
    }

    /// @notice Pay the creator's proceeds (anyone can call; the destination is fixed).
    function withdrawProceeds() external {
        uint256 amount = creatorOwed;
        require(amount > 0, "nothing");
        creatorOwed = 0;
        _sendHype(params.creator, amount);
        emit ProceedsWithdrawn(params.creator, amount);
    }

    /// @notice Send the launch fee to the treasury set in CloakConfig (anyone can call).
    function collectFees() external {
        uint256 amount = feesOwed;
        address to = config.feeRecipient();
        require(amount > 0 && to != address(0), "nothing");
        feesOwed = 0;
        _sendHype(to, amount);
        emit FeesCollected(to, amount);
    }

    /// @notice Once every bid is claimed, rounding dust goes to the treasury (HYPE) and the burn address (tokens).
    function sweepDust() external {
        require(settled && claimedCount == _bids.length, "claims open");
        uint256 hype = address(this).balance - creatorOwed - feesOwed - refundsHeld;
        uint256 tokens = token.balanceOf(address(this));
        if (hype > 0) feesOwed += hype;
        if (tokens > 0) require(token.transfer(DEAD, tokens), "burn");
        emit DustSwept(hype, tokens);
    }

    function releaseLP() external {
        require(settled && address(pair) != address(0), "no lp");
        require(params.lpLockUntil != 0 && block.timestamp >= params.lpLockUntil, "locked");
        require(!lpReleased, "released");
        lpReleased = true;
        pair.transferShares(params.creator, lpShares);
        emit LPReleased(params.creator, lpShares);
    }

    /// Gas for a refund send in claim(): plenty for a smart wallet's receive, too little to grief a batch.
    uint256 internal constant REFUND_SEND_GAS = 100_000;

    /// A bounded-gas native send that copies no return data, so a recipient can't burn the caller's gas.
    function _trySendHype(address to, uint256 amount) internal returns (bool ok) {
        uint256 g = REFUND_SEND_GAS;
        assembly {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
    }

    function _sendHype(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }
}
