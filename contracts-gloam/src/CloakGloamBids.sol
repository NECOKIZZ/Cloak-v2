// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGloamVault} from "gloam/GloamVaultSwap.sol";

/// @notice The parts of CloakAuction (and CloakDrop, which has the same bid shape) a private bid uses.
interface ISealedAuction {
    function commit(bytes32 commitment, bytes calldata sealedBid) external payable returns (uint256 id);
    function claim(uint256 id) external;
}

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice One private bid's own address: the bidder the auction sees. Holds what the bid holds; only its
///         factory can move it. It takes HYPE from anyone (the auction's refund).
contract BidAccount {
    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    receive() external payable {}

    function run(address target, uint256 value, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == factory, "factory");
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/**
 * @title CloakGloamBids
 * @notice Sealed bids on Cloak launches (CloakAuction) and drops paid from a Gloam private balance, following Gloam's
 *         escrow pattern: one note leaves the vault to a one-time account bound to everything about the bid, the
 *         account bids, and what the auction pays back comes back into the vault as new notes.
 *
 * The bid's account is a CREATE2 address derived from its BidKey: the note (nullifier, amount), the auction, the
 * owner key, the fallback address and the timeout. The vault's unshield proof names it as `to`, so a copied call that
 * changes any of them gets another address and the proof fails. The bid call itself (its commitment names the
 * bidder, so it can't be part of the address) is signed by the owner key: a copier can't swap in a bid of its own
 * (one never revealed would be fined). Any auction with Cloak's bid shape works: launches (CloakAuction) and drops
 * (CloakDrop, public bids; a WL bid must come from the listed wallet, which a private balance can't be).
 *
 * Never stuck. At every moment the money is in one of three places, each with a way out:
 *  - the vault, as the note (if place() reverts, nothing moved);
 *  - the auction, as the bid's deposit: the auction's own claim() pays tokens and refund to the account, and anyone
 *    can call it once the auction settles (finish and the timeout exit call it for you);
 *  - the account: the owner key signs it back into the vault as notes (finish), or out to any address (exit); and
 *    after the timeout anyone can push all of it to the fallback address fixed in the key (exitAfterTimeout).
 * If the spend is sent alone (its proof is public once broadcast), the money waits in the account: place() then
 * still bids (before the auction closes), or finish() puts it back as a note.
 *
 * The owner key is a one-time address the bidder's device derives from its account seed and the note, so it links
 * to nothing. Nothing an owner signs can be replayed elsewhere: the digest names this contract, the chain, the
 * account and the exact deposits or destination. No owner, no admin, nothing upgradable.
 *
 * What stays public: the deposit (as for any bid), the bid's account, and the amounts paid back. Who bid stays
 * private: the account is funded from the vault and pays back into it.
 */
interface IFeeBps {
    function withdrawFeeBps() external view returns (uint16);
}

contract CloakGloamBids {
    struct Spend {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        address asset; // address(0): HYPE, the only bid currency today
        uint256 amount;
    }

    struct Deposit {
        bytes proof;
        bytes32 commitment;
        address asset;
        uint256 amount;
    }

    struct BidKey {
        bytes32 nullifier;
        uint256 amount;
        address auction;
        address ownerKey;
        address fallbackTo;
        uint256 exitAfter;
    }

    IGloamVault public immutable vault;
    bytes32 private constant PLACE_DOMAIN = keccak256("cloak.gloam.bid.place.v1");
    bytes32 private constant CALL_DOMAIN = keccak256("cloak.gloam.bid.call.v1");
    bytes32 private constant FINISH_DOMAIN = keccak256("cloak.gloam.bid.finish.v1");
    bytes32 private constant EXIT_DOMAIN = keccak256("cloak.gloam.bid.exit.v1");
    bytes32 public constant ACCOUNT_CODE_HASH = keccak256(type(BidAccount).creationCode);

    /// @notice The auction's bid id for each account, +1 (0: no bid yet).
    mapping(address => uint256) public bidIdPlus1;
    /// @notice Set once an account has paid out (finish or exit): later calls are refused.
    mapping(address => bool) public closed;
    /// @notice Owner calls made from each account (each signature names the next one).
    mapping(address => uint256) public callNonce;

    uint256 private _entered;
    bool private _finishing;

    event BidPlaced(address indexed account, address indexed auction, uint256 bidId, uint256 deposit);
    event BidFinished(address indexed account, uint256 notes);
    event BidExited(address indexed account, address indexed to, uint256 hype);

    error Reentrancy();
    error BadKey();
    error Closed();
    error TooLate();
    error TooEarly();
    error BadSignature();
    error NothingHere();
    error ShortFunds(uint256 have, uint256 want);
    error NotSpent();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address vault_) {
        vault = IGloamVault(vault_);
    }

    /// @notice The address a bid's unshield proof must name as `to` (and the bidder the auction will see).
    function accountFor(BidKey calldata k) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(k)), ACCOUNT_CODE_HASH)))));
    }

    /**
     * @notice Spend the note to the bid's account and bid with all that arrived.
     * @dev The commitment must be CloakAuction.commitmentOf(account, tick, quantity, salt) with this account: the
     *      bidder works it out before proving. When the note was already spent to this account, it bids with what
     *      waits there.
     */
    /**
     * @notice Spend the note to the bid's account and send the owner-signed bid call with all that arrived.
     * @param bidCall The exact call the account makes to the auction, e.g. CloakAuction.commit(commitment, sealedBid)
     *        or CloakDrop.commit(commitment, sealedBid, false, []), with the commitment made for this account. It must
     *        return the bid id.
     */
    function place(Spend calldata s, BidKey calldata k, bytes calldata bidCall, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 bidId)
    {
        if (s.nullifier != k.nullifier || s.amount != k.amount || s.asset != address(0)) revert BadKey();
        address account = accountFor(k);
        _checkSigned(placeDigest(account, bidCall), signature, k.ownerKey);
        if (closed[account] || bidIdPlus1[account] != 0) revert Closed();
        if (!vault.isSpent(s.nullifier)) {
            vault.unshield(s.proof, s.root, s.nullifier, s.asset, account, s.amount);
        }
        bidId = _bid(k, account, bidCall);
    }

    function _bid(BidKey calldata k, address account, bytes calldata bidCall) private returns (uint256 bidId) {
        BidAccount a = _open(k, account);
        // bid what the note brought (its amount less the vault's fee), not the account's whole balance: a stranger's
        // top-up can't push a bid at the auction's cap over it (review C-09); anything extra stays for an exit
        uint256 deposit = _arrived(k.amount);
        if (account.balance < deposit) deposit = account.balance;
        if (deposit == 0) revert NothingHere();
        bidId = abi.decode(a.run(k.auction, deposit, bidCall), (uint256));
        bidIdPlus1[account] = bidId + 1;
        emit BidPlaced(account, k.auction, bidId, deposit);
    }

    /// @dev What a note of `amount` brings out of the vault: the amount less the vault's cash-out fee (its rounding).
    function _arrived(uint256 amount) private view returns (uint256) {
        uint256 bps = IFeeBps(address(vault)).withdrawFeeBps();
        return amount - ((amount / 10_000) * bps + ((amount % 10_000) * bps) / 10_000);
    }

    /// @notice What the owner key signs to bid: this account and this exact bid call.
    function placeDigest(address account, bytes calldata bidCall) public view returns (bytes32) {
        return keccak256(abi.encode(PLACE_DOMAIN, block.chainid, address(this), account, keccak256(bidCall)));
    }

    /// @notice What the owner key signs for one call from the account (an NFT out to a wallet, claimTo, ...).
    function callDigest(address account, address target, uint256 value, bytes calldata data, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(CALL_DOMAIN, block.chainid, address(this), account, target, value, keccak256(data), nonce));
    }

    /**
     * @notice One owner-signed call from the account, for what can't go back into the vault: a drop's NFTs to a wallet
     *         of the owner's choice, say. Each signature works once (the account's nonce). Only after the note is
     *         spent, and never to the vault.
     */
    function ownerCall(BidKey calldata k, address target, uint256 value, bytes calldata data, bytes calldata signature)
        external
        nonReentrant
        returns (bytes memory)
    {
        address account = accountFor(k);
        _checkSigned(callDigest(account, target, value, data, callNonce[account]), signature, k.ownerKey);
        if (target == address(vault) || target == address(this)) revert BadKey();
        if (!vault.isSpent(k.nullifier)) revert NotSpent();
        callNonce[account]++;
        return _open(k, account).run(target, value, data);
    }

    /// @notice What the owner key signs to put the account's money back into the vault as exactly these notes.
    function finishDigest(address account, Deposit[] calldata ds) public view returns (bytes32) {
        bytes32[] memory parts = new bytes32[](ds.length);
        for (uint256 i = 0; i < ds.length; i++) parts[i] = keccak256(abi.encode(ds[i].commitment, ds[i].asset, ds[i].amount));
        return keccak256(abi.encode(FINISH_DOMAIN, block.chainid, address(this), account, keccak256(abi.encodePacked(parts))));
    }

    /// @notice Per account: exits signed and used so far. Each exit signature works once (review C-10).
    mapping(address => uint256) public exitNonce;

    function exitDigest(address account, address to) public view returns (bytes32) {
        return keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), account, to, exitNonce[account]));
    }

    /**
     * @notice Claim the bid (if not yet) and deposit the tokens and the refund back as new notes of the bidder, as the
     *         owner key signed. Anyone can send it (a relayer); the deposits' shield proofs bind each note's amount.
     *         Dust the deposits don't cover stays in the account for an exit.
     */
    function finish(BidKey calldata k, Deposit[] calldata ds, bytes calldata signature) external nonReentrant {
        address account = accountFor(k);
        if (closed[account]) revert Closed();
        if (_recover(finishDigest(account, ds), signature) != k.ownerKey || k.ownerKey == address(0)) revert BadSignature();
        if (!vault.isSpent(k.nullifier)) revert NotSpent();
        BidAccount a = _open(k, account);
        _tryClaim(k.auction, account);
        closed[account] = true;
        _finishing = true;
        for (uint256 i = 0; i < ds.length; i++) {
            Deposit calldata d = ds[i];
            if (d.asset == address(0)) {
                if (account.balance < d.amount) revert ShortFunds(account.balance, d.amount);
                a.run(address(this), d.amount, "");
                vault.shieldBound{value: d.amount}(address(0), d.amount, d.commitment, d.proof);
            } else {
                uint256 have = IERC20Bal(d.asset).balanceOf(account);
                if (have < d.amount) revert ShortFunds(have, d.amount);
                uint256 before = IERC20Bal(d.asset).balanceOf(address(this));
                a.run(d.asset, 0, abi.encodeCall(IERC20Bal.transfer, (address(this), d.amount)));
                if (IERC20Bal(d.asset).balanceOf(address(this)) - before != d.amount) revert ShortFunds(0, d.amount);
                IERC20Bal(d.asset).approve(address(vault), d.amount);
                vault.shieldBound(d.asset, d.amount, d.commitment, d.proof);
                IERC20Bal(d.asset).approve(address(vault), 0);
            }
        }
        _finishing = false;
        closed[account] = false; // dust may still leave by exit
        _closeIfEmpty(account, ds);
        emit BidFinished(account, ds.length);
    }

    /// @notice The owner key sends everything in the account (HYPE and `tokens`) to `to`, in the clear.
    function exit(BidKey calldata k, address to, address[] calldata tokens, bytes calldata signature) external nonReentrant {
        address account = accountFor(k);
        if (_recover(exitDigest(account, to), signature) != k.ownerKey || k.ownerKey == address(0)) revert BadSignature();
        exitNonce[account] += 1;
        _exit(k, account, to, tokens);
    }

    /// @notice After the key's timeout anyone can push everything to the key's fallback address.
    function exitAfterTimeout(BidKey calldata k, address[] calldata tokens) external nonReentrant {
        if (block.timestamp < k.exitAfter) revert TooEarly();
        _exit(k, accountFor(k), k.fallbackTo, tokens);
    }

    /// @notice HYPE comes in only from a bid account during finish(), on its way into the vault (review C-11).
    receive() external payable {
        if (!_finishing) revert Closed();
    }

    function _exit(BidKey calldata k, address account, address to, address[] calldata tokens) private {
        if (to == address(0) || to == account || to == address(this) || to == address(vault)) revert BadKey();
        if (!vault.isSpent(k.nullifier)) revert NotSpent();
        BidAccount a = _open(k, account);
        _tryClaim(k.auction, account);
        uint256 hype = account.balance;
        if (hype > 0) a.run(to, hype, "");
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20Bal(tokens[i]).balanceOf(account);
            if (bal > 0) a.run(tokens[i], 0, abi.encodeCall(IERC20Bal.transfer, (to, bal)));
        }
        emit BidExited(account, to, hype);
    }

    /// @dev Deploys the account on first use (CREATE2 from the key), else returns it.
    function _open(BidKey calldata k, address account) private returns (BidAccount) {
        if (account.code.length == 0) {
            bytes32 salt = keccak256(abi.encode(k));
            BidAccount created = new BidAccount{salt: salt}();
            if (address(created) != account) revert BadKey();
        }
        return BidAccount(payable(account));
    }

    /// @dev Pulls the auction's tokens and refund to the account when it has settled; a revert (not settled, already
    ///      claimed) is ignored so the money already in the account can always move.
    function _tryClaim(address auction, address account) private {
        uint256 idp1 = bidIdPlus1[account];
        if (idp1 == 0) return;
        (bool ok, ) = auction.call(abi.encodeCall(ISealedAuction.claim, (idp1 - 1)));
        ok;
    }

    function _closeIfEmpty(address account, Deposit[] calldata ds) private {
        if (account.balance != 0) return;
        for (uint256 i = 0; i < ds.length; i++) {
            if (ds[i].asset != address(0) && IERC20Bal(ds[i].asset).balanceOf(account) != 0) return;
        }
        closed[account] = true;
    }

    function _checkSigned(bytes32 digest, bytes calldata signature, address key) private pure {
        if (key == address(0) || _recover(digest, signature) != key) revert BadSignature();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
