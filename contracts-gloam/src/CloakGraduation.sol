// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGloamVault} from "gloam/GloamVaultSwap.sol";
import {IEscrowPayee, SwapEscrow2} from "gloam/SwapEscrow2.sol";

interface IERC20G {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/**
 * @title CloakGraduation
 * @notice Moves a launch token from Cloak's launch vault into Gloam's vault, in rounds, so a watcher sees amounts of
 *         standard sizes go in and notes come out, not which came from which.
 *
 *         A note can't be spent across vaults (each vault has its own tree), so graduating is a cash out from one and
 *         a deposit into the other. Both are in the clear (token and amount). Who is not: the cash out names a one-time
 *         escrow, and the deposit is a fresh note made by the owner's app.
 *
 * Entering. One note of a standard size (1, 2 or 5 x 10^n) of a launch token, spent from the launch vault with
 * Gloam's escrow pattern: the unshield proof names a one-time SwapEscrow2 made from the entry's key, so a copier who
 * changes the owner key or the fallback gets another escrow and the proof fails. What arrives is the note less the
 * launch vault's cash-out fee.
 *
 * Leaving. After the round ends, the owner key signs a deposit of exactly what arrived, and anyone (a relayer) sends it.
 * The signature names the vault, so the owner can choose Gloam's vault or, if Gloam hasn't listed the token yet or its
 * cap is full, back into the launch vault. After EXIT_DELAY anyone can push an unclaimed entry to its fallback address,
 * so money never waits forever.
 *
 * @dev No owner, no fee of its own, no function that moves money anywhere but those three places. The deposit into
 *      Gloam's vault pays Gloam nothing (Gloam charges on cash outs), so graduating costs only the launch vault's fee.
 */
contract CloakGraduation is IEscrowPayee {
    struct Spend {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        uint256 amount;
    }

    struct Deposit {
        bytes proof;
        bytes32 commitment;
    }

    struct EntryKey {
        bytes32 nullifier;
        address token;
        uint128 size;
        address ownerKey;
        address fallbackTo;
    }

    struct Entry {
        address token;
        uint64 round;
        bool paid;
        uint128 net;
    }

    IGloamVault public immutable launchVault;
    IGloamVault public immutable gloamVault;
    uint256 public immutable roundSecs;
    uint256 public constant EXIT_DELAY = 30 days;
    bytes32 private constant CLAIM_DOMAIN = keccak256("cloak.graduation.claim.v1");

    mapping(bytes32 => Entry) public entries; // by keccak256(abi.encode(EntryKey))
    /// @notice How many entries each token's round has, so the app can wait for a crowd before leaving.
    mapping(address => mapping(uint64 => uint256)) public roundEntries;

    uint256 private _entered;

    event Entered(bytes32 indexed id, address indexed token, uint64 indexed round, uint256 size, uint256 net);
    event Left(bytes32 indexed id, address indexed token, uint256 amount, address to);

    error Reentrancy();
    error NotStandard();
    error BadKey();
    error Used();
    error NotYet();
    error Done();
    error BadVault();
    error BadSignature();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address launchVault_, address gloamVault_, uint256 roundSecs_) {
        require(launchVault_ != address(0) && gloamVault_ != address(0) && launchVault_ != gloamVault_, "vaults");
        require(roundSecs_ > 0, "round");
        launchVault = IGloamVault(launchVault_);
        gloamVault = IGloamVault(gloamVault_);
        roundSecs = roundSecs_;
    }

    /// @notice SwapEscrow2 asks where to pay: always here.
    function escrowPayee() external view returns (address) {
        return address(this);
    }

    function idOf(EntryKey calldata k) public pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    /// @notice The address an entry's unshield proof must name.
    function escrowFor(EntryKey calldata k) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(k.token)));
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

    /// @notice Spend a note of a standard size from the launch vault into this round.
    function enter(Spend calldata s, EntryKey calldata k) external nonReentrant returns (bytes32 id) {
        if (s.nullifier != k.nullifier || s.amount != k.size || k.ownerKey == address(0) || k.token == address(0)) {
            revert BadKey();
        }
        if (k.fallbackTo == address(0)) revert BadKey();
        if (!isStandard(k.size)) revert NotStandard();
        id = idOf(k);
        if (entries[id].round != 0) revert Used();
        // a spend sent alone already paid the escrow; pick it up
        if (!launchVault.isSpent(s.nullifier)) {
            launchVault.unshield(s.proof, s.root, s.nullifier, k.token, escrowFor(k), s.amount);
        }
        uint256 net = _openEscrow(id, k.token);
        uint64 round = currentRound();
        entries[id] = Entry(k.token, round, false, uint128(net));
        roundEntries[k.token][round] += 1;
        emit Entered(id, k.token, round, k.size, net);
    }

    function claimDigest(bytes32 id, address toVault, bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_DOMAIN, block.chainid, address(this), id, toVault, commitment));
    }

    /// @notice After the round, deposit what arrived as one note in Gloam's vault (or back in the launch vault), as the
    ///         owner key signed. Anyone may send it.
    function leave(EntryKey calldata k, address toVault, Deposit calldata d, bytes calldata signature)
        external
        nonReentrant
    {
        if (toVault != address(gloamVault) && toVault != address(launchVault)) revert BadVault();
        bytes32 id = idOf(k);
        Entry storage e = entries[id];
        if (e.round == 0) revert NotYet();
        if (e.paid) revert Done();
        if (block.timestamp < (uint256(e.round) + 1) * roundSecs) revert NotYet();
        if (_recover(claimDigest(id, toVault, d.commitment), signature) != k.ownerKey) revert BadSignature();
        e.paid = true;
        uint256 amount = e.net;
        IERC20G(k.token).approve(toVault, amount);
        IGloamVault(toVault).shieldBound(k.token, amount, d.commitment, d.proof);
        IERC20G(k.token).approve(toVault, 0);
        emit Left(id, k.token, amount, toVault);
    }

    /// @notice EXIT_DELAY after its round ended, anyone can push an unclaimed entry to its fallback address.
    function exitAfterTimeout(EntryKey calldata k) external nonReentrant {
        bytes32 id = idOf(k);
        Entry storage e = entries[id];
        if (e.round == 0) revert NotYet();
        if (e.paid) revert Done();
        if (block.timestamp < (uint256(e.round) + 1) * roundSecs + EXIT_DELAY) revert NotYet();
        e.paid = true;
        require(IERC20G(k.token).transfer(k.fallbackTo, e.net), "send");
        emit Left(id, k.token, e.net, k.fallbackTo);
    }

    // ── internals ──────────────────────────────────────────────────────

    function _openEscrow(bytes32 salt, address token) private returns (uint256 arrived) {
        uint256 before = IERC20G(token).balanceOf(address(this));
        bytes memory code = abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(token));
        address e;
        assembly {
            e := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (e == address(0)) revert Used();
        arrived = IERC20G(token).balanceOf(address(this)) - before;
        if (arrived == 0) revert Used();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
