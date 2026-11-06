// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CloakConfig} from "./CloakConfig.sol";

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title CloakDrop
/// @notice One NFT collection and its sealed sale, in one contract.
///
///  GTD     — until `gtdEnd`, wallets on the GTD list (a Merkle root) mint their guaranteed spots at `gtdPrice`.
///            Spots nobody used fall into the auction.
///  COMMIT  — until `commitEnd`, anyone bids: a hash of (price level, quantity, salt) and a drand-timelocked copy of it,
///            with a HYPE deposit that covers it. Nobody can read a bid before the drand round opens it.
///  REVEAL  — the keeper (or anyone) opens every bid once the round is out.
///  SETTLE  — bids rank by score: their price, or for WL bids their price × (1 + boost). The score of the last bid that
///            fits the supply is the clearing score. Public winners pay it; WL winners pay it ÷ (1 + boost), never under
///            the floor. Bids tied at the clearing score share what's left by a lottery over tickets (one per NFT asked
///            for) whose random start comes from every bid's sealed salt, so nobody knew it before the bids were opened.
///  CLAIM   — anyone can deliver a bid: its NFTs to the bidder and the rest of its deposit back.
///
///  Money out is pull-based, as in CloakAuction: proceeds and the protocol fee are credited as sales happen.
contract CloakDrop {
    // ───────────────────────────── constants ─────────────────────────────

    uint256 public constant MAX_TICKS = 256;
    uint32 public constant MAX_SUPPLY = 10_000;
    uint32 public constant MAX_PER_BID = 20;
    uint16 public constant MAX_BOOST_BPS = 3_000;
    uint16 public constant MAX_ROYALTY_BPS = 1_000;
    uint16 public constant NO_REVEAL_PENALTY_BPS = 2_500; // a bid that never opens loses 25% (burned), so a ladder of bids
    // kept sealed to move the price (a creator shilling their own drop) costs real money
    uint256 internal constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // drand quicknet, the network bids are sealed to
    uint256 public constant DRAND_GENESIS = 1692803367;
    uint256 public constant DRAND_PERIOD = 3;
    uint256 public constant REVEAL_MARGIN = 30;

    struct Params {
        address creator; // set by the factory to the caller
        uint32 supply;
        uint32 maxPerBid;
        uint16 numTicks; // price levels: floor, floor + tickSize, …
        uint16 wlBoostBps; // WL bids rank as price × (1 + boost) and pay clearing ÷ (1 + boost)
        uint16 royaltyBps; // ERC-2981, paid to the creator
        uint64 gtdEnd; // GTD minting closes and bidding opens
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 tlockRound; // drand round the bids are sealed to (0 = not checked)
        uint128 floor; // wei per NFT, the creator's price
        uint128 tickSize;
        uint128 gtdPrice; // wei per NFT for GTD spots
        bytes32 gtdRoot; // leaves keccak(keccak(abi.encode(wallet, spots))); 0 = no GTD
        bytes32 wlRoot; // leaves keccak(keccak(abi.encode(wallet))); 0 = no WL
    }

    struct Bid {
        address bidder;
        uint16 tick;
        bool wl;
        bool revealed;
        bool claimed;
        uint32 quantity;
        uint32 tieStart; // first lottery ticket, for bids tied at the clearing score
        uint128 deposit;
        bytes32 commitment;
    }

    struct Reveal {
        uint256 id;
        uint16 tick;
        uint128 quantity;
        bytes32 salt;
    }

    // ───────────────────────────── state ─────────────────────────────

    address public immutable factory;
    CloakConfig public immutable config;
    uint16 public immutable launchFeeBps;
    uint256 public immutable bidCap; // 0 = no cap
    uint256 public immutable depositCap; // 0 = no cap

    Params internal _p;
    string public name;
    string public symbol;
    string public baseURI;

    Bid[] internal _bids;
    uint32[MAX_TICKS] public demandPublic;
    uint32[MAX_TICKS] public demandWl;
    uint256 public totalDemand;
    uint256 public revealCount;
    uint256 public totalDeposits;
    uint256 internal saltMix;

    mapping(address => uint32) public gtdMintedBy;
    uint32 public gtdMinted;

    bool public settled;
    bool public failed;
    uint256 public clearingScore; // price × BPS (a WL level: price × (BPS + boost))
    uint32 public sold; // NFTs the auction sells
    uint32 public tieSupply; // NFTs left for the bids tied at the clearing score
    uint32 public tieDemand; // NFTs those tied bids asked for
    uint256 public tieRandom;
    /// The block whose hash seeds the tie draw: the one after settlement, so no bidder can know or choose it when deciding
    /// which of their bids to open (the revealed salts alone could be steered by withholding some).
    uint64 public seedBlock;
    uint256 public tieCursor; // next bid id to number tickets for
    uint32 public tieAssigned;
    bool public tiesReady;
    uint32 public unsoldMinted;

    uint256 public creatorOwed;
    uint256 public feesOwed;
    uint256 public claimedCount;
    mapping(address => uint256) public refundOwed;
    uint256 internal refundsHeld;

    // ERC-721
    uint256 public totalSupply;
    mapping(uint256 => address) internal _owner;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    // ───────────────────────────── events ─────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event GtdMinted(address indexed wallet, uint32 quantity, uint256 paid);
    event Committed(uint256 indexed id, address indexed bidder, uint256 deposit, bool wl, bytes32 commitment, bytes sealedBid);
    event Revealed(uint256 indexed id, address indexed bidder, uint16 tick, uint256 quantity);
    event Settled(uint256 clearingScore, uint32 sold, uint32 tieSupply, uint32 tieDemand);
    event Failed();
    event TiesReady(uint256 random);
    event Claimed(uint256 indexed id, address indexed bidder, address to, uint32 nfts, uint256 paid, uint256 refund, uint256 penalty);
    event RefundHeld(address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed bidder, address to, uint256 amount);
    event ProceedsWithdrawn(address to, uint256 amount);
    event FeesCollected(address to, uint256 amount);
    event UnsoldMinted(address to, uint32 quantity);

    constructor(Params memory p, string memory name_, string memory symbol_, string memory baseURI_, CloakConfig config_) {
        require(p.creator != address(0), "creator");
        require(p.supply > 0 && p.supply <= MAX_SUPPLY, "supply");
        require(p.maxPerBid > 0 && p.maxPerBid <= MAX_PER_BID, "per bid");
        require(p.numTicks > 0 && p.numTicks <= MAX_TICKS, "ticks");
        require(p.numTicks == 1 || p.tickSize > 0, "tickSize");
        require(p.floor > 0, "floor");
        require(p.wlBoostBps <= MAX_BOOST_BPS && (p.wlRoot != bytes32(0) || p.wlBoostBps == 0), "boost");
        require(p.royaltyBps <= MAX_ROYALTY_BPS, "royalty");
        require(p.gtdEnd >= block.timestamp && p.commitEnd > p.gtdEnd && p.revealEnd > p.commitEnd, "times");
        if (p.tlockRound != 0) {
            uint256 at = DRAND_GENESIS + (uint256(p.tlockRound) - 1) * DRAND_PERIOD;
            require(at >= p.commitEnd && at + REVEAL_MARGIN <= p.revealEnd, "tlock round");
        }
        require(bytes(name_).length > 0 && bytes(name_).length <= 64 && bytes(symbol_).length > 0 && bytes(symbol_).length <= 16, "name");
        factory = msg.sender;
        config = config_;
        _p = p;
        name = name_;
        symbol = symbol_;
        // no metadata folder of its own: the factory's default, which serves each token from the drop's details
        baseURI = bytes(baseURI_).length > 0
            ? baseURI_
            : string.concat(CloakDropFactory(msg.sender).defaultBaseURI(), _hexAddress(address(this)), "/");
        launchFeeBps = config_.launchFeeBps();
        (uint128 perBid, uint128 total) = config_.auctionLimit();
        bool capped = config_.depositLimitsOn();
        bidCap = capped ? perBid : 0;
        depositCap = capped ? total : 0;
        if (capped) require(perBid > 0 && total > 0, "drops closed");
    }

    // ───────────────────────────── views ─────────────────────────────

    function params() external view returns (Params memory) {
        return _p;
    }

    function priceAt(uint16 tick) public view returns (uint256) {
        return uint256(_p.floor) + uint256(tick) * _p.tickSize;
    }

    /// @notice A bid's rank: price × BPS for a public bid, price × (BPS + boost) for a WL bid.
    function scoreOf(uint16 tick, bool wl) public view returns (uint256) {
        return priceAt(tick) * (BPS + (wl ? _p.wlBoostBps : 0));
    }

    /// @notice keccak256(abi.encode(drop, bidder, tick, quantity, salt)), the same preimage as a launch bid.
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

    /// @notice NFTs the auction offers: the supply less the GTD spots minted (final once GTD closes).
    function auctionSupply() public view returns (uint32) {
        return _p.supply - gtdMinted;
    }

    /// @notice 0 = GTD, 1 = bidding, 2 = reveal, 3 = awaiting settle, 4 = numbering tied bids, 5 = settled.
    function phase() external view returns (uint8) {
        if (settled) return tiesReady || tieSupply == 0 ? 5 : 4;
        if (block.timestamp < _p.gtdEnd) return 0;
        if (block.timestamp < _p.commitEnd) return 1;
        if (block.timestamp < _p.revealEnd && !_allOpen()) return 2;
        return 3;
    }

    /// @notice What a WL or public winner pays per NFT at the clearing score.
    function unitPrice(bool wl) public view returns (uint256) {
        if (!wl) return _ceilDiv(clearingScore, BPS);
        uint256 pay = _ceilDiv(clearingScore, BPS + _p.wlBoostBps);
        return pay < _p.floor ? _p.floor : pay;
    }

    /// @notice NFTs, payment, refund and penalty for a bid once the drop is settled (and tied bids numbered).
    function allocationOf(uint256 id) public view returns (uint32 nfts, uint256 paid, uint256 refund, uint256 penalty) {
        Bid storage b = _bids[id];
        if (!settled) return (0, 0, 0, 0);
        if (!b.revealed) {
            penalty = failed ? 0 : (uint256(b.deposit) * NO_REVEAL_PENALTY_BPS) / BPS;
            return (0, 0, b.deposit - penalty, penalty);
        }
        if (failed) return (0, 0, b.deposit, 0);
        uint256 s = scoreOf(b.tick, b.wl);
        if (s > clearingScore) nfts = b.quantity;
        else if (s == clearingScore) nfts = tieSupply == 0 ? b.quantity : _ticketsWon(b.tieStart, b.quantity);
        paid = uint256(nfts) * unitPrice(b.wl);
        refund = b.deposit - paid;
    }

    // ───────────────────────────── GTD ─────────────────────────────

    /// @notice Mint guaranteed spots from a listed wallet. `spots` is the wallet's allowance on the list.
    function gtdMint(uint32 spots, bytes32[] calldata proof, uint32 quantity) external payable {
        require(block.timestamp < _p.gtdEnd, "gtd closed");
        require(_p.gtdRoot != bytes32(0), "no gtd");
        require(quantity > 0 && gtdMintedBy[msg.sender] + quantity <= spots, "spots");
        require(_verify(proof, _p.gtdRoot, keccak256(bytes.concat(keccak256(abi.encode(msg.sender, spots))))), "not on gtd");
        require(gtdMinted + quantity <= _p.supply, "sold out");
        uint256 cost = uint256(_p.gtdPrice) * quantity;
        require(msg.value == cost, "price");
        gtdMintedBy[msg.sender] += quantity;
        gtdMinted += quantity;
        _credit(cost);
        for (uint32 i; i < quantity; ++i) _mint(msg.sender);
        emit GtdMinted(msg.sender, quantity, cost);
    }

    // ───────────────────────────── commit ─────────────────────────────

    /// @param commitment keccak256(abi.encode(drop, msg.sender, tick, quantity, salt))
    /// @param sealedBid  drand-tlock ciphertext of the preimage (the chain never reads it)
    /// @param wl         true for a WL bid, which must come from the listed wallet
    /// @param wlProof    Merkle proof that msg.sender is on the WL (empty for a one-wallet list or a public bid)
    function commit(bytes32 commitment, bytes calldata sealedBid, bool wl, bytes32[] calldata wlProof)
        external
        payable
        returns (uint256 id)
    {
        require(block.timestamp >= _p.gtdEnd, "gtd window");
        require(block.timestamp < _p.commitEnd, "bidding closed");
        // a bid must at least cover one NFT at the floor: no free spam for the keeper to deliver
        require(msg.value >= _p.floor && msg.value <= type(uint128).max, "deposit");
        if (bidCap != 0) require(msg.value <= bidCap && totalDeposits + msg.value <= depositCap, "over cap");
        if (wl) {
            require(_p.wlRoot != bytes32(0) && _verify(wlProof, _p.wlRoot, keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))), "not on wl");
        }
        id = _bids.length;
        _bids.push(
            Bid({
                bidder: msg.sender,
                tick: 0,
                wl: wl,
                revealed: false,
                claimed: false,
                quantity: 0,
                tieStart: 0,
                deposit: uint128(msg.value),
                commitment: commitment
            })
        );
        totalDeposits += msg.value;
        emit Committed(id, msg.sender, msg.value, wl, commitment, sealedBid);
    }

    // ───────────────────────────── reveal ─────────────────────────────

    function reveal(uint256 id, uint16 tick, uint128 quantity, bytes32 salt) external {
        require(_inReveal(), "not reveal phase");
        require(_tryReveal(id, tick, quantity, salt), "invalid reveal");
    }

    function revealBatch(Reveal[] calldata reveals) external returns (uint256 ok) {
        require(_inReveal(), "not reveal phase");
        for (uint256 i; i < reveals.length; ++i) {
            Reveal calldata r = reveals[i];
            if (_tryReveal(r.id, r.tick, r.quantity, r.salt)) ++ok;
        }
    }

    function _inReveal() internal view returns (bool) {
        return !settled && block.timestamp >= _p.commitEnd && block.timestamp < _p.revealEnd;
    }

    /// Every bid is open, so the reveal window can end early: a long window costs nobody time.
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
        // XOR is order-free: whoever opens the bids can't steer the tie draw by choosing the order
        saltMix ^= uint256(keccak256(abi.encode(salt, id)));
        emit Revealed(id, b.bidder, tick, quantity);
        return true;
    }

    // ───────────────────────────── settle ─────────────────────────────

    function settle() external {
        require(block.timestamp >= _p.revealEnd || (block.timestamp >= _p.commitEnd && _allOpen()), "reveal open");
        require(!settled, "settled");
        settled = true;
        uint32 supply = auctionSupply();
        if (totalDemand == 0 || supply == 0) {
            // nobody bid, or GTD took the whole supply: nothing sells and every deposit comes back in full
            failed = true;
            emit Failed();
            return;
        }

        // Walk the public and WL price levels from the highest score down, as one merged list.
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
            // fewer NFTs asked for than offered: everyone fills at the floor
            clearingScore = uint256(_p.floor) * BPS;
            sold = uint32(totalDemand);
        }
        if (tieSupply != 0) seedBlock = uint64(block.number + 1);
        emit Settled(clearingScore, sold, tieSupply, tieDemand);
    }

    /// @notice Number the tickets of bids tied at the clearing score, in bid order, `maxSteps` bids at a time.
    ///         Anyone can call it; claims wait until it is done (only when there is a tie).
    function numberTies(uint256 maxSteps) external {
        require(settled && tieSupply != 0 && !tiesReady, "no ties");
        uint256 end = tieCursor + maxSteps;
        if (end > _bids.length) end = _bids.length;
        uint32 n = tieAssigned;
        for (uint256 k = tieCursor; k < end; ++k) {
            Bid storage b = _bids[k];
            if (b.revealed && scoreOf(b.tick, b.wl) == clearingScore) {
                b.tieStart = n;
                n += b.quantity;
            }
        }
        tieAssigned = n;
        tieCursor = end;
        if (end == _bids.length && _drawSeed()) {
            tiesReady = true;
            emit TiesReady(tieRandom);
        }
    }

    /// The tie draw's random start, from the salts of every opened bid and the hash of `seedBlock`. False while that block
    /// isn't mined yet (call again). If nobody drew within 256 blocks the hash is gone, so a new future block is picked.
    function _drawSeed() internal returns (bool) {
        if (block.number <= seedBlock) return false;
        bytes32 h = blockhash(seedBlock);
        if (h == bytes32(0)) {
            seedBlock = uint64(block.number + 1);
            return false;
        }
        tieRandom = uint256(keccak256(abi.encode(saltMix, h, address(this))));
        return true;
    }

    /// Tickets [start, start + q) win where they fall in the window of `tieSupply` tickets from the random start.
    function _ticketsWon(uint32 start, uint32 q) internal view returns (uint32) {
        uint256 n = tieDemand;
        uint256 w0 = tieRandom % n;
        uint256 w1 = w0 + tieSupply; // the window is [w0, w1), wrapping past n
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

    // ───────────────────────────── claim ─────────────────────────────

    /// @notice Anyone can deliver a bid: its NFTs to the bidder, the rest of its deposit back.
    function claim(uint256 id) public {
        _claim(id, _bids[id].bidder);
    }

    /// @notice The bidder takes its NFTs to another address (a fresh wallet, say). The refund still goes to the bidder.
    function claimTo(uint256 id, address to) external {
        require(msg.sender == _bids[id].bidder, "bidder");
        require(to != address(0), "to");
        _claim(id, to);
    }

    function claimBatch(uint256[] calldata ids) external {
        for (uint256 k; k < ids.length; ++k) {
            if (!_bids[ids[k]].claimed) claim(ids[k]);
        }
    }

    function _claim(uint256 id, address to) internal {
        require(settled, "not settled");
        require(tieSupply == 0 || tiesReady, "ties not numbered");
        Bid storage b = _bids[id];
        require(!b.claimed, "claimed");
        (uint32 nfts, uint256 paid, uint256 refund, uint256 penalty) = allocationOf(id);
        b.claimed = true;
        ++claimedCount;
        if (paid > 0) _credit(paid);
        for (uint32 k; k < nfts; ++k) _mint(to);
        if (penalty > 0) _sendHype(DEAD, penalty);
        if (refund > 0 && !_trySendHype(b.bidder, refund)) {
            refundOwed[b.bidder] += refund;
            refundsHeld += refund;
            emit RefundHeld(b.bidder, refund);
        }
        emit Claimed(id, b.bidder, to, nfts, paid, refund, penalty);
    }

    function withdrawRefund(address to) external {
        uint256 amount = refundOwed[msg.sender];
        require(amount > 0, "nothing");
        refundOwed[msg.sender] = 0;
        refundsHeld -= amount;
        _sendHype(to, amount);
        emit RefundWithdrawn(msg.sender, to, amount);
    }

    /// @notice After settling, the creator may mint what nobody bought (or all of it, if the drop failed) to any address.
    function mintUnsold(address to, uint32 quantity) external {
        require(msg.sender == _p.creator, "creator");
        require(settled && to != address(0), "not settled");
        uint32 left = _p.supply - gtdMinted - sold - unsoldMinted;
        require(quantity > 0 && quantity <= left, "none left");
        unsoldMinted += quantity;
        for (uint32 k; k < quantity; ++k) _mint(to);
        emit UnsoldMinted(to, quantity);
    }

    function withdrawProceeds() external {
        uint256 amount = creatorOwed;
        require(amount > 0, "nothing");
        creatorOwed = 0;
        _sendHype(_p.creator, amount);
        emit ProceedsWithdrawn(_p.creator, amount);
    }

    function collectFees() external {
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

    // ───────────────────────────── ERC-721 ─────────────────────────────

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owner[tokenId];
        require(o != address(0), "no token");
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return string(abi.encodePacked(baseURI, _toString(tokenId)));
    }

    /// @notice ERC-2981: the creator's royalty on a sale price.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (_p.creator, (salePrice * _p.royaltyBps) / BPS);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f || id == 0x2a55205a;
    }

    function approve(address spender, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "not allowed");
        getApproved[tokenId] = spender;
        emit Approval(o, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(from == ownerOf(tokenId), "from");
        require(to != address(0), "to");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[tokenId], "not allowed");
        unchecked {
            balanceOf[from]--;
            balanceOf[to]++;
        }
        _owner[tokenId] = to;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) == IERC721Receiver.onERC721Received.selector,
                "unsafe receiver"
            );
        }
    }

    function _mint(address to) internal {
        uint256 tokenId = ++totalSupply;
        _owner[tokenId] = to;
        unchecked {
            balanceOf[to]++;
        }
        emit Transfer(address(0), to, tokenId);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    /// Sorted-pair Merkle proof (the OpenZeppelin MerkleProof layout).
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

    function _hexAddress(address a) internal pure returns (string memory) {
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        bytes16 hexChars = "0123456789abcdef";
        uint160 v = uint160(a);
        for (uint256 k = 41; k > 1; --k) {
            s[k] = hexChars[v & 0xf];
            v >>= 4;
        }
        return string(s);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory s = new bytes(len);
        for (; v != 0; v /= 10) s[--len] = bytes1(uint8(48 + (v % 10)));
        return string(s);
    }
}

/// @title CloakDropFactory
/// @notice Creates drops and lists them for the site and the keeper.
contract CloakDropFactory {
    CloakConfig public immutable config;
    address[] public drops;
    /// Metadata for drops that bring no folder of their own: tokenURI = defaultBaseURI + drop + "/" + id.
    string public defaultBaseURI;

    uint256 public constant MAX_DETAILS = 96_000;

    event DropCreated(uint256 indexed index, address indexed drop, address indexed creator, string name, string symbol);
    /// The drop's public details as JSON: its image and description, and the GTD and WL lists the roots were built
    /// from, so anyone can rebuild a proof. The roots on the drop are what count; a list that doesn't match is ignored.
    event DropDetails(address indexed drop, string details);

    constructor(CloakConfig config_, string memory defaultBaseURI_) {
        config = config_;
        defaultBaseURI = defaultBaseURI_;
    }

    function createDrop(
        CloakDrop.Params memory p,
        string calldata name,
        string calldata symbol,
        string calldata baseURI,
        string calldata details
    ) external returns (CloakDrop d) {
        require(bytes(details).length <= MAX_DETAILS, "details");
        p.creator = msg.sender;
        d = new CloakDrop(p, name, symbol, baseURI, config);
        drops.push(address(d));
        emit DropCreated(drops.length - 1, address(d), msg.sender, name, symbol);
        emit DropDetails(address(d), details);
    }

    function dropsCount() external view returns (uint256) {
        return drops.length;
    }
}
