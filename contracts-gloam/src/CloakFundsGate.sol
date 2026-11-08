// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFundsVerifierG {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata pub) external view returns (bool);
}

interface IVaultG {
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isSpent(bytes32 nullifier) external view returns (bool);
}

/**
 * @title CloakFundsGate
 * @notice Allocation gates for Cloak launches and drops: "only wallets that privately hold at least X of an asset may
 *         join", proved with Gloam's funds circuit (final keys) on Gloam's vault or Cloak's launch vault, without the
 *         wallet showing its balance or the vault notes it owns.
 *
 * Making a gate. Anyone creates one: an asset, a threshold and a closing time. The creator (a launch's creator) reads the
 * confirmed wallets once it closes, for the launch's allowlist.
 *
 * Entering. A proof that up to four unspent notes hold at least the threshold, bound by its context to this gate, this
 * vault and one wallet (Gloam's proofContext, kind "funds", expiring at the gate's close, computed here on chain, so a
 * proof made for one wallet or gate can't be used for another). Anyone may send it (a relayer), since it names the
 * wallet. The proof's note nullifiers are recorded: the same notes can't qualify a second wallet in this gate.
 *
 * Staying in. Moving the notes (to prove again for another wallet) spends them, and a wallet whose notes are spent
 * before the gate closes drops out. After the close, anyone (the keeper) confirms each wallet whose notes are still
 * unspent; a confirmed wallet stays eligible for good, and its owner is free to spend.
 *
 * What it shows: that the wallet holds at least the threshold (not how much), and, like every funds proof, the notes'
 * nullifiers, so whoever watches sees when those notes are later spent. No owner, nothing to pay, no funds held.
 */
contract CloakFundsGate {
    struct Gate {
        address creator;
        address asset;
        uint128 threshold;
        uint64 closesAt;
        uint32 entered;
        uint32 confirmed;
    }

    struct Entry {
        address vault;
        bool confirmed;
        bytes32[4] nullifiers;
    }

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IFundsVerifierG public immutable verifier;
    /// @notice The vaults a proof may come from: Gloam's vault and Cloak's launch vault.
    IVaultG public immutable vaultA;
    IVaultG public immutable vaultB;

    Gate[] public gates;
    mapping(uint256 => mapping(address => Entry)) internal _entries;
    mapping(uint256 => address[]) internal _wallets;
    /// @notice gate => vault => nullifier => used by an entry already
    mapping(uint256 => mapping(address => mapping(bytes32 => bool))) public nullifierUsed;

    event GateCreated(uint256 indexed gateId, address indexed creator, address indexed asset, uint256 threshold, uint64 closesAt);
    event Entered(uint256 indexed gateId, address indexed wallet, address vault);
    event Confirmed(uint256 indexed gateId, address indexed wallet);

    error BadGate();
    error Closed();
    error NotClosed();
    error BadVault();
    error BadProof();
    error AlreadyIn();
    error NotIn();
    error NotesUsed();
    error NotesSpent();

    constructor(address verifier_, address vaultA_, address vaultB_) {
        require(verifier_ != address(0) && vaultA_ != address(0) && vaultB_ != address(0) && vaultA_ != vaultB_, "params");
        verifier = IFundsVerifierG(verifier_);
        vaultA = IVaultG(vaultA_);
        vaultB = IVaultG(vaultB_);
    }

    function createGate(address asset, uint128 threshold, uint64 closesAt) external returns (uint256 gateId) {
        if (threshold == 0 || closesAt <= block.timestamp) revert BadGate();
        gateId = gates.length;
        gates.push(Gate(msg.sender, asset, threshold, closesAt, 0, 0));
        emit GateCreated(gateId, msg.sender, asset, threshold, closesAt);
    }

    function gatesCount() external view returns (uint256) {
        return gates.length;
    }

    /// @notice Who a proof for this gate is made for, as Gloam's proofContext `verifier` string.
    function verifierString(uint256 gateId, address wallet) public view returns (string memory) {
        return string.concat("cloak.gate.v1:", _hex(address(this)), ":", _dec(gateId), ":", _hex(wallet));
    }

    /// @notice The context a proof for (gate, vault, wallet) must carry: Gloam's proofContext, kind "funds".
    function contextFor(uint256 gateId, address vault, address wallet) public view returns (uint256) {
        Gate storage g = gates[gateId];
        bytes memory enc = abi.encode("gloam.proof.v1", "funds", block.chainid, vault, uint64(g.closesAt), verifierString(gateId, wallet));
        return uint256(keccak256(enc)) % FIELD;
    }

    /// @notice Enter `wallet` with a funds proof. Public signals: [root, asset, threshold, context, nullifier0..3].
    function enter(
        uint256 gateId,
        address vault,
        address wallet,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata pub
    ) external {
        if (gateId >= gates.length) revert BadGate();
        Gate storage g = gates[gateId];
        if (block.timestamp > g.closesAt) revert Closed();
        if (vault != address(vaultA) && vault != address(vaultB)) revert BadVault();
        if (wallet == address(0)) revert BadProof();
        Entry storage e = _entries[gateId][wallet];
        if (e.vault != address(0)) revert AlreadyIn();
        if (pub[1] != uint256(uint160(g.asset)) || pub[2] < g.threshold || pub[3] != contextFor(gateId, vault, wallet)) revert BadProof();
        if (!IVaultG(vault).isKnownRoot(bytes32(pub[0]))) revert BadProof();
        for (uint256 i = 4; i < 8; i++) {
            bytes32 n = bytes32(pub[i]);
            if (n == 0) continue;
            if (IVaultG(vault).isSpent(n)) revert NotesSpent();
            if (nullifierUsed[gateId][vault][n]) revert NotesUsed();
            nullifierUsed[gateId][vault][n] = true;
            e.nullifiers[i - 4] = n;
        }
        if (!verifier.verifyProof(a, b, c, pub)) revert BadProof();
        e.vault = vault;
        g.entered += 1;
        _wallets[gateId].push(wallet);
        emit Entered(gateId, wallet, vault);
    }

    /// @notice True while the wallet's entry stands: entered and none of its notes spent, or confirmed after the close.
    function isEligible(uint256 gateId, address wallet) public view returns (bool) {
        Entry storage e = _entries[gateId][wallet];
        if (e.vault == address(0)) return false;
        if (e.confirmed) return true;
        for (uint256 i = 0; i < 4; i++) {
            if (e.nullifiers[i] != 0 && IVaultG(e.vault).isSpent(e.nullifiers[i])) return false;
        }
        return true;
    }

    /// @notice After the close, fix a wallet whose notes are still unspent as eligible for good. Anyone may call it.
    function confirm(uint256 gateId, address wallet) external {
        Gate storage g = gates[gateId];
        if (block.timestamp <= g.closesAt) revert NotClosed();
        Entry storage e = _entries[gateId][wallet];
        if (e.vault == address(0)) revert NotIn();
        if (e.confirmed) return;
        if (!isEligible(gateId, wallet)) revert NotesSpent();
        e.confirmed = true;
        g.confirmed += 1;
        emit Confirmed(gateId, wallet);
    }

    function isConfirmed(uint256 gateId, address wallet) external view returns (bool) {
        return _entries[gateId][wallet].confirmed;
    }

    /// @notice The wallets that entered, from `start`, at most `count` (for the keeper and the creator's allowlist).
    function wallets(uint256 gateId, uint256 start, uint256 count) external view returns (address[] memory out) {
        address[] storage w = _wallets[gateId];
        if (start >= w.length) return out;
        uint256 end = start + count > w.length ? w.length : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = w[i];
    }

    function entryOf(uint256 gateId, address wallet) external view returns (address vault, bool confirmed, bytes32[4] memory nullifiers) {
        Entry storage e = _entries[gateId][wallet];
        return (e.vault, e.confirmed, e.nullifiers);
    }

    // ── strings, as viem prints them (lowercase hex, plain decimal) ──

    function _hex(address x) private pure returns (string memory) {
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        uint160 v = uint160(x);
        for (uint256 i = 0; i < 20; i++) {
            uint8 bt = uint8(v >> (8 * (19 - i)));
            s[2 + 2 * i] = _nib(bt >> 4);
            s[3 + 2 * i] = _nib(bt & 0x0f);
        }
        return string(s);
    }

    function _nib(uint8 n) private pure returns (bytes1) {
        return bytes1(n < 10 ? n + 0x30 : n + 0x57);
    }

    function _dec(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory s = new bytes(len);
        for (; v != 0; v /= 10) s[--len] = bytes1(uint8(0x30 + (v % 10)));
        return string(s);
    }
}
