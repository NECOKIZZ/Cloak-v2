// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakConfig} from "./CloakConfig.sol";
import {CloakDrop} from "./CloakDrop.sol";

interface IERC721Min {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title CloakEscrowDrop
/// @notice A sealed auction of NFTs that already exist: the owner's tokens sit in this contract from the moment it is
///         created, and the auction works like a CloakDrop's (sealed bids to a drand round, WL boost, one price for
///         every winner, a fair draw for ties).
///
///  ESCROW  — CloakEscrowDropFactory moves every listed token from the owner into this contract in the transaction that
///            creates it, and checks it holds each one before bidding can open. Anyone can check `held()`.
///  ITEMS   — after settling, `numberTies` gives every winning bid its run of slots in bid order. Slot s is the token at
///            index (s + rotation) mod supply, where `rotation` comes from every bid's sealed salt: nobody knew it
///            before the bids opened, and the order bids are claimed in can't change who gets which token.
///  CLAIM   — anyone can deliver a bid: its tokens to the bidder, the rest of its deposit back. A token the collection
///            refuses to transfer is refunded to the winner at the price it paid, and goes back to the owner.
///  UNSOLD  — what nobody bought (everything, if the auction failed) goes back to the owner with `mintUnsold`.
///
///  No GTD: every token is sold in the auction. The view surface matches CloakDrop's, so one client reads both.
contract CloakEscrowDrop {
    uint256 public constant MAX_TICKS = 256;
    uint32 public constant MAX_SUPPLY = 500; // every token moves in at creation, in one transaction
    uint32 public constant MAX_PER_BID = 20;
    uint16 public constant MAX_BOOST_BPS = 3_000;
    uint16 public constant NO_REVEAL_PENALTY_BPS = 2_500; // a bid kept sealed to steer the price costs real money
    uint256 internal constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant DRAND_GENESIS = 1692803367;
    uint256 public constant DRAND_PERIOD = 3;
    uint256 public constant REVEAL_MARGIN = 30;
    /// Gas a token transfer may use: a collection can't make delivering a bid run out of gas.
    uint256 public constant TRANSFER_GAS = 300_000;

    struct Bid {
        address bidder;
        uint16 tick;
        bool wl;
        bool revealed;
        bool claimed;
        uint32 quantity;
        uint32 tieStart;
        uint128 deposit;
        bytes32 commitment;
    }

    address public immutable factory;
    CloakConfig public immutable config;
    IERC721Min public immutable collection;
    uint16 public immutable launchFeeBps;
    uint256 public immutable bidCap;
    uint256 public immutable depositCap;

    CloakDrop.Params internal _p;
    string public name;
    string public symbol;
    /// Kept for CloakDrop's view surface: an escrow drop's tokens keep their own metadata, read from the collection.
    string public constant baseURI = "";
    uint256[] internal _tokenIds;
    bool public funded;

    Bid[] internal _bids;
    uint32[MAX_TICKS] public demandPublic;
    uint32[MAX_TICKS] public demandWl;
    uint256 public totalDemand;
    uint256 public revealCount;
    uint256 public totalDeposits;
    uint256 internal saltMix;

    bool public settled;
    bool public failed;
    uint256 public clearingScore;
    uint32 public sold;
    uint32 public tieSupply;
    uint32 public tieDemand;
    uint256 public tieRandom;
    uint256 public rotation;
    /// The block whose hash seeds the tie draw and the rotation: the one after settlement, so no bidder can know or choose
    /// it when deciding which of their bids to open (the revealed salts alone could be steered by withholding some).
    uint64 public seedBlock;
    bool public seeded;
    uint256 public tieCursor;
    uint32 public tieAssigned;
    uint32 public slotsAssigned;
    bool public tiesReady; // every winning bid has its slots (and tied bids their tickets)
    mapping(uint256 => uint32) public slotStart;
    uint32 public unsoldMinted; // unsold tokens returned to the owner
    uint32 public delivered; // tokens delivered to winners
    mapping(uint256 => bool) public undelivered; // token index the collection refused to transfer
    mapping(uint256 => bool) public recovered;

    uint256 public creatorOwed;
    uint256 public feesOwed;
    uint256 public claimedCount;
    mapping(address => uint256) public refundOwed;
    uint256 internal refundsHeld;
    uint256 private _lock = 1;

    event Funded(address indexed collection, uint256 count);
    event Committed(uint256 indexed id, address indexed bidder, uint256 deposit, bool wl, bytes32 commitment, bytes sealedBid);
    event Revealed(uint256 indexed id, address indexed bidder, uint16 tick, uint256 quantity);
    event Settled(uint256 clearingScore, uint32 sold, uint32 tieSupply, uint32 tieDemand);
    event Failed();
    event TiesReady(uint256 random);
    event Delivered(uint256 indexed id, address indexed to, uint256 tokenId);
    event DeliveryFailed(uint256 indexed id, uint256 tokenId, uint256 refunded);
    event Claimed(uint256 indexed id, address indexed bidder, address to, uint32 nfts, uint256 paid, uint256 refund, uint256 penalty);
    event RefundHeld(address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed bidder, address to, uint256 amount);
    event ProceedsWithdrawn(address to, uint256 amount);
    event FeesCollected(address to, uint256 amount);
    event UnsoldMinted(address to, uint32 quantity);

    modifier nonReentrant() {
        require(_lock == 1, "busy");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        CloakDrop.Params memory p,
        IERC721Min collection_,
        uint256[] memory tokenIds_,
        string memory name_,
        string memory symbol_,
        CloakConfig config_
    ) {
        require(p.creator != address(0), "creator");
        require(address(collection_).code.length > 0, "collection");
        require(tokenIds_.length > 0 && tokenIds_.length <= MAX_SUPPLY && p.supply == tokenIds_.length, "supply");
        require(p.maxPerBid > 0 && p.maxPerBid <= MAX_PER_BID, "per bid");
        require(p.numTicks > 0 && p.numTicks <= MAX_TICKS, "ticks");
        require(p.numTicks == 1 || p.tickSize > 0, "tickSize");
        require(p.floor > 0, "floor");
        require(p.gtdRoot == bytes32(0) && p.gtdPrice == 0, "no gtd");
        require(p.wlBoostBps <= MAX_BOOST_BPS && (p.wlRoot != bytes32(0) || p.wlBoostBps == 0), "boost");
        require(p.royaltyBps == 0, "royalty"); // royalties are the collection's own
        require(p.gtdEnd >= block.timestamp && p.commitEnd > p.gtdEnd && p.revealEnd > p.commitEnd, "times");
        if (p.tlockRound != 0) {
            uint256 at = DRAND_GENESIS + (uint256(p.tlockRound) - 1) * DRAND_PERIOD;
            require(at >= p.commitEnd && at + REVEAL_MARGIN <= p.revealEnd, "tlock round");
        }
        require(bytes(name_).length > 0 && bytes(name_).length <= 64 && bytes(symbol_).length > 0 && bytes(symbol_).length <= 16, "name");
        // listed in increasing order: no token twice (the SDK sorts them)
        for (uint256 i = 1; i < tokenIds_.length; ++i) require(tokenIds_[i] > tokenIds_[i - 1], "token order");
        factory = msg.sender;
        config = config_;
        collection = collection_;
        _p = p;
        _tokenIds = tokenIds_;
        name = name_;
        symbol = symbol_;
        launchFeeBps = config_.launchFeeBps();
        (uint128 perBid, uint128 total) = config_.auctionLimit();
        bool capped = config_.depositLimitsOn();
        bidCap = capped ? perBid : 0;
        depositCap = capped ? total : 0;
        if (capped) require(perBid > 0 && total > 0, "drops closed");
    }

    /// @notice Called by the factory once it has moved every token in: bidding can't open on an empty escrow.
    function activate() external {
        require(msg.sender == factory && !funded, "factory");
        require(held() == _tokenIds.length, "not escrowed");
        funded = true;
        emit Funded(address(collection), _tokenIds.length);
    }

    // ───────────────────────────── views ─────────────────────────────

    function params() external view returns (CloakDrop.Params memory) {
        return _p;
    }

    function tokenIds() external view returns (uint256[] memory) {
        return _tokenIds;
    }

    /// @notice How many of the listed tokens this contract holds right now.
    function held() public view returns (uint256 n) {
        for (uint256 i; i < _tokenIds.length; ++i) if (_ownsToken(_tokenIds[i])) ++n;
    }

    function priceAt(uint16 tick) public view returns (uint256) {
        return uint256(_p.floor) + uint256(tick) * _p.tickSize;
    }

    function scoreOf(uint16 tick, bool wl) public view returns (uint256) {
        return priceAt(tick) * (BPS + (wl ? _p.wlBoostBps : 0));
    }

    function commitmentOf(address bidder, uint16 tick, uint128 quantity, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), bidder, tick, quantity, salt));
    }

    function costOf(uint16 tick, uint256 quantity) public view returns (uint256) {
        return priceAt(tick) * quantity;
    }

    function bidsCount() external view returns (uint256) {
        return _bids.length;
    }

    function getBid(uint256 id) external view returns (Bid memory) {
        return _bids[id];
    }

    function gtdMinted() external pure returns (uint32) {
        return 0;
    }

    function gtdMintedBy(address) external pure returns (uint32) {
        return 0;
    }

    function auctionSupply() public view returns (uint32) {
        return _p.supply;
    }

    /// @notice Tokens that have left the escrow to winners (CloakDrop's totalSupply counts minted NFTs).
    function totalSupply() external view returns (uint256) {
        return delivered;
    }

    /// @notice 0 = not open yet, 1 = bidding, 2 = reveal, 3 = awaiting settle, 4 = numbering slots, 5 = settled.
    function phase() external view returns (uint8) {
        if (settled) return failed || tiesReady ? 5 : 4;
        if (block.timestamp < _p.gtdEnd) return 0;
        if (block.timestamp < _p.commitEnd) return 1;
        if (block.timestamp < _p.revealEnd && !_allOpen()) return 2;
        return 3;
    }

    function unitPrice(bool wl) public view returns (uint256) {
        if (!wl) return _ceilDiv(clearingScore, BPS);
        uint256 pay = _ceilDiv(clearingScore, BPS + _p.wlBoostBps);
        return pay < _p.floor ? _p.floor : pay;
    }

    function allocationOf(uint256 id) public view returns (uint32 nfts, uint256 paid, uint256 refund, uint256 penalty) {
        Bid storage b = _bids[id];
        if (!settled) return (0, 0, 0, 0);
        if (!b.revealed) {
            penalty = failed ? 0 : (uint256(b.deposit) * NO_REVEAL_PENALTY_BPS) / BPS;
            return (0, 0, b.deposit - penalty, penalty);
        }
        if (failed) return (0, 0, b.deposit, 0);
        nfts = _won(b);
        paid = uint256(nfts) * unitPrice(b.wl);
        refund = b.deposit - paid;
    }

    /// @notice The token ids a bid wins (once slots are numbered).
    function tokensOf(uint256 id) external view returns (uint256[] memory out) {
        if (!settled || failed || !tiesReady) return out;
        (uint32 nfts,,,) = allocationOf(id);
        out = new uint256[](nfts);
        for (uint32 k; k < nfts; ++k) out[k] = _tokenIds[_indexOf(slotStart[id] + k)];
    }

    // ───────────────────────────── bidding ─────────────────────────────

    function commit(bytes32 commitment, bytes calldata sealedBid, bool wl, bytes32[] calldata wlProof)
        external
        payable
        returns (uint256 id)
    {
        require(funded, "not escrowed");
        require(block.timestamp >= _p.gtdEnd, "not open");
        require(block.timestamp < _p.commitEnd, "bidding closed");
        require(msg.value >= _p.floor && msg.value <= type(uint128).max, "deposit");
        if (bidCap != 0) require(msg.value <= bidCap && totalDeposits + msg.value <= depositCap, "over cap");
        if (wl) {
            require(_p.wlRoot != bytes32(0) && _verify(wlProof, _p.wlRoot, keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))), "not on wl");
        }
        id = _bids.length;
        _bids.push(Bid({bidder: msg.sender, tick: 0, wl: wl, revealed: false, claimed: false, quantity: 0, tieStart: 0, deposit: uint128(msg.value), commitment: commitment}));
        totalDeposits += msg.value;
        emit Committed(id, msg.sender, msg.value, wl, commitment, sealedBid);
    }

    function reveal(uint256 id, uint16 tick, uint128 quantity, bytes32 salt) external {
        require(_inReveal(), "not reveal phase");
        require(_tryReveal(id, tick, quantity, salt), "invalid reveal");
    }

    function revealBatch(CloakDrop.Reveal[] calldata reveals) external returns (uint256 ok) {
        require(_inReveal(), "not reveal phase");
        for (uint256 i; i < reveals.length; ++i) {
            CloakDrop.Reveal calldata r = reveals[i];
            if (_tryReveal(r.id, r.tick, r.quantity, r.salt)) ++ok;
        }
    }

    function _inReveal() internal view returns (bool) {
        return !settled && block.timestamp >= _p.commitEnd && block.timestamp < _p.revealEnd;
    }

    function _allOpen() internal view returns (bool) {
        return _bids.length > 0 && revealCount == _bids.length;
    }

    function _tryReveal(uint256 id, uint16 tick, uint128 quantity, bytes32 salt) internal returns (bool) {
        if (id >= _bids.length) return false;
        Bid storage b = _bids[id];
        if (b.revealed || tick >= _p.numTicks || quantity == 0 || quantity > _p.maxPerBid) return false;
        if (commitmentOf(b.bidder, tick, quantity, salt) != b.commitment) return false;
        if (costOf(tick, quantity) > b.deposit) return false;
        b.revealed = true;
        b.tick = tick;
        b.quantity = uint32(quantity);
        if (b.wl) demandWl[tick] += uint32(quantity);
        else demandPublic[tick] += uint32(quantity);
        totalDemand += quantity;
        ++revealCount;
        saltMix ^= uint256(keccak256(abi.encode(salt, id)));
        emit Revealed(id, b.bidder, tick, quantity);
        return true;
    }

    // ───────────────────────────── settle ─────────────────────────────

    function settle() external {
        require(block.timestamp >= _p.revealEnd || (block.timestamp >= _p.commitEnd && _allOpen()), "reveal open");
        require(!settled, "settled");
        settled = true;
        uint32 supply = _p.supply;
        if (totalDemand == 0) {
            failed = true;
            emit Failed();
            return;
        }
        uint256 cum;
        int256 i = int256(uint256(_p.numTicks)) - 1;
        int256 j = i;
        bool covered;
        uint16 boost = _p.wlBoostBps;
        while (i >= 0 || j >= 0) {
            uint256 sp = i >= 0 ? priceAt(uint16(uint256(i))) * BPS : 0;
            uint256 sw = j >= 0 ? priceAt(uint16(uint256(j))) * (BPS + boost) : 0;
            uint256 score = sp > sw ? sp : sw;
            uint256 d;
            if (i >= 0 && sp == score) {
                d += demandPublic[uint256(i)];
                --i;
            }
            if (j >= 0 && sw == score) {
                d += demandWl[uint256(j)];
                --j;
            }
            if (d == 0) continue;
            if (cum + d >= supply) {
                clearingScore = score;
                sold = supply;
                if (cum + d > supply) {
                    tieSupply = uint32(supply - cum);
                    tieDemand = uint32(d);
                }
                covered = true;
                break;
            }
            cum += d;
        }
        if (!covered) {
            clearingScore = uint256(_p.floor) * BPS;
            sold = uint32(totalDemand);
        }
        seedBlock = uint64(block.number + 1);
        emit Settled(clearingScore, sold, tieSupply, tieDemand);
    }

    /// @notice Give every winning bid its run of slots, in bid order (and tied bids their tickets), `maxSteps` bids at
    ///         a time. Anyone can call it; claims wait until it's done. The name matches CloakDrop's tie numbering.
    function numberTies(uint256 maxSteps) external {
        require(settled && !failed && !tiesReady, "nothing to number");
        if (!seeded) {
            if (!_drawSeed()) return; // the seed block isn't mined yet: call again
            seeded = true;
        }
        uint256 end = tieCursor + maxSteps;
        if (end > _bids.length) end = _bids.length;
        uint32 tickets = tieAssigned;
        uint32 slots = slotsAssigned;
        for (uint256 k = tieCursor; k < end; ++k) {
            Bid storage b = _bids[k];
            if (!b.revealed) continue;
            if (tieSupply != 0 && scoreOf(b.tick, b.wl) == clearingScore) {
                b.tieStart = tickets;
                tickets += b.quantity;
            }
            slotStart[k] = slots;
            slots += _won(b);
        }
        tieAssigned = tickets;
        slotsAssigned = slots;
        tieCursor = end;
        if (end == _bids.length) {
            tiesReady = true;
            emit TiesReady(tieRandom);
        }
    }

    /// The tie draw and the rotation, from the salts of every opened bid and the hash of `seedBlock`. False while that
    /// block isn't mined yet. If nobody drew within 256 blocks the hash is gone, so a new future block is picked.
    function _drawSeed() internal returns (bool) {
        if (block.number <= seedBlock) return false;
        bytes32 h = blockhash(seedBlock);
        if (h == bytes32(0)) {
            seedBlock = uint64(block.number + 1);
            return false;
        }
        if (tieSupply != 0) tieRandom = uint256(keccak256(abi.encode(saltMix, h, address(this))));
        rotation = uint256(keccak256(abi.encode(saltMix, h, address(this), "slots"))) % _p.supply;
        return true;
    }

    /// Tokens a revealed bid wins (ties need their tickets numbered first).
    function _won(Bid storage b) internal view returns (uint32) {
        uint256 s = scoreOf(b.tick, b.wl);
        if (s > clearingScore) return b.quantity;
        if (s < clearingScore) return 0;
        return tieSupply == 0 ? b.quantity : _ticketsWon(b.tieStart, b.quantity);
    }

    function _ticketsWon(uint32 start, uint32 q) internal view returns (uint32) {
        uint256 n = tieDemand;
        uint256 w0 = tieRandom % n;
        uint256 w1 = w0 + tieSupply;
        uint256 a = start;
        uint256 b = uint256(start) + q;
        uint256 won = _overlap(a, b, w0, w1 < n ? w1 : n);
        if (w1 > n) won += _overlap(a, b, 0, w1 - n);
        return uint32(won);
    }

    function _overlap(uint256 a0, uint256 a1, uint256 b0, uint256 b1) internal pure returns (uint256) {
        uint256 lo = a0 > b0 ? a0 : b0;
        uint256 hi = a1 < b1 ? a1 : b1;
        return hi > lo ? hi - lo : 0;
    }

    function _indexOf(uint256 slot) internal view returns (uint256) {
        return (slot + rotation) % _p.supply;
    }

    // ───────────────────────────── claim ─────────────────────────────

    function claim(uint256 id) public nonReentrant {
        _claim(id, _bids[id].bidder);
    }

    function claimTo(uint256 id, address to) external nonReentrant {
        require(msg.sender == _bids[id].bidder, "bidder");
        require(to != address(0), "to");
        _claim(id, to);
    }

    function claimBatch(uint256[] calldata ids) external nonReentrant {
        for (uint256 k; k < ids.length; ++k) {
            if (!_bids[ids[k]].claimed) _claim(ids[k], _bids[ids[k]].bidder);
        }
    }

    function _claim(uint256 id, address to) internal {
        require(settled, "not settled");
        require(failed || tiesReady, "ties not numbered");
        Bid storage b = _bids[id];
        require(!b.claimed, "claimed");
        (uint32 nfts, uint256 paid, uint256 refund, uint256 penalty) = allocationOf(id);
        b.claimed = true;
        ++claimedCount;
        uint256 each = nfts > 0 ? paid / nfts : 0;
        uint32 got;
        for (uint32 k; k < nfts; ++k) {
            uint256 idx = _indexOf(slotStart[id] + k);
            uint256 tokenId = _tokenIds[idx];
            if (_send(tokenId, to)) {
                ++got;
                emit Delivered(id, to, tokenId);
            } else {
                // the collection refused: the winner gets its money back for this one, the owner gets the token back
                undelivered[idx] = true;
                emit DeliveryFailed(id, tokenId, each);
            }
        }
        delivered += got;
        uint256 kept = uint256(got) * each;
        refund += paid - kept;
        if (kept > 0) _credit(kept);
        if (penalty > 0) _sendHype(DEAD, penalty);
        if (refund > 0 && !_trySendHype(b.bidder, refund)) {
            refundOwed[b.bidder] += refund;
            refundsHeld += refund;
            emit RefundHeld(b.bidder, refund);
        }
        emit Claimed(id, b.bidder, to, got, kept, refund, penalty);
    }

    function withdrawRefund(address to) external nonReentrant {
        uint256 amount = refundOwed[msg.sender];
        require(amount > 0, "nothing");
        refundOwed[msg.sender] = 0;
        refundsHeld -= amount;
        _sendHype(to, amount);
        emit RefundWithdrawn(msg.sender, to, amount);
    }

    /// @notice After settling, the owner takes back what nobody bought (everything, if the auction failed). The name
    ///         matches CloakDrop's, where unsold NFTs are minted instead.
    function mintUnsold(address to, uint32 quantity) external nonReentrant {
        require(msg.sender == _p.creator, "creator");
        require(settled && to != address(0), "not settled");
        uint32 soldNow = failed ? 0 : sold;
        uint32 left = _p.supply - soldNow - unsoldMinted;
        require(quantity > 0 && quantity <= left, "none left");
        for (uint32 k; k < quantity; ++k) {
            uint256 idx = failed ? unsoldMinted + k : _indexOf(soldNow + unsoldMinted + k);
            collection.transferFrom(address(this), to, _tokenIds[idx]);
        }
        unsoldMinted += quantity;
        emit UnsoldMinted(to, quantity);
    }

    /// @notice The owner takes back a token the collection refused to deliver to its winner (who was refunded).
    function recoverUndelivered(uint256 index, address to) external nonReentrant {
        require(msg.sender == _p.creator, "creator");
        require(undelivered[index] && !recovered[index] && to != address(0), "nothing");
        recovered[index] = true;
        collection.transferFrom(address(this), to, _tokenIds[index]);
    }

    function withdrawProceeds() external nonReentrant {
        uint256 amount = creatorOwed;
        require(amount > 0, "nothing");
        creatorOwed = 0;
        _sendHype(_p.creator, amount);
        emit ProceedsWithdrawn(_p.creator, amount);
    }

    function collectFees() external nonReentrant {
        uint256 amount = feesOwed;
        address to = config.feeRecipient();
        require(amount > 0 && to != address(0), "nothing");
        feesOwed = 0;
        _sendHype(to, amount);
        emit FeesCollected(to, amount);
    }

    function _credit(uint256 amount) internal {
        uint256 fee = (amount * launchFeeBps) / BPS;
        feesOwed += fee;
        creatorOwed += amount - fee;
    }

    // ───────────────────────────── helpers ─────────────────────────────

    /// Move one token to `to` with bounded gas, and check it arrived. False if the collection refused or lied.
    function _send(uint256 tokenId, address to) internal returns (bool) {
        (bool ok,) = address(collection).call{gas: TRANSFER_GAS}(abi.encodeCall(IERC721Min.transferFrom, (address(this), to, tokenId)));
        if (!ok) return false;
        (bool ok2, bytes memory r) = address(collection).staticcall{gas: 50_000}(abi.encodeCall(IERC721Min.ownerOf, (tokenId)));
        return ok2 && r.length >= 32 && abi.decode(r, (uint256)) == uint256(uint160(to)); // compare the whole word: a collection returning dirty upper bits must not brick claims
    }

    function _ownsToken(uint256 tokenId) internal view returns (bool) {
        (bool ok, bytes memory r) = address(collection).staticcall{gas: 50_000}(abi.encodeCall(IERC721Min.ownerOf, (tokenId)));
        return ok && r.length >= 32 && abi.decode(r, (uint256)) == uint256(uint160(address(this)));
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 k; k < proof.length; ++k) {
            bytes32 x = proof[k];
            h = h < x ? keccak256(abi.encode(h, x)) : keccak256(abi.encode(x, h));
        }
        return h == root;
    }

    uint256 internal constant REFUND_SEND_GAS = 100_000;

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

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}

/// @title CloakEscrowDropFactory
/// @notice Sealed auctions of NFTs that already exist. The caller lists tokens it owns (approved to this factory); the
///         factory creates the auction and moves every token into it in the same transaction.
contract CloakEscrowDropFactory {
    CloakConfig public immutable config;
    address[] public drops;
    uint256 public constant MAX_DETAILS = 96_000;

    event DropCreated(uint256 indexed index, address indexed drop, address indexed creator, string name, string symbol);
    event DropDetails(address indexed drop, string details);
    event Escrowed(address indexed drop, address indexed collection, uint256[] tokenIds);

    constructor(CloakConfig config_) {
        config = config_;
    }

    function createDrop(
        CloakDrop.Params memory p,
        IERC721Min collection,
        uint256[] calldata tokenIds,
        string calldata name,
        string calldata symbol,
        string calldata details
    ) external returns (CloakEscrowDrop d) {
        require(bytes(details).length <= MAX_DETAILS, "details");
        p.creator = msg.sender;
        p.supply = uint32(tokenIds.length);
        d = new CloakEscrowDrop(p, collection, tokenIds, name, symbol, config);
        for (uint256 i; i < tokenIds.length; ++i) {
            require(collection.ownerOf(tokenIds[i]) == msg.sender, "not your token");
            collection.transferFrom(msg.sender, address(d), tokenIds[i]);
        }
        d.activate();
        drops.push(address(d));
        emit DropCreated(drops.length - 1, address(d), msg.sender, name, symbol);
        emit DropDetails(address(d), details);
        emit Escrowed(address(d), address(collection), tokenIds);
    }

    function dropsCount() external view returns (uint256) {
        return drops.length;
    }
}
