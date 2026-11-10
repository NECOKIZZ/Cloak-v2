// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGloamVault} from "gloam/GloamVaultSwap.sol";
import {IEscrowPayee, SwapEscrow2} from "gloam/SwapEscrow2.sol";

interface IV2FactoryL {
    function getPair(address a, address b) external view returns (address);
}

interface IV2PairL {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IWETHL {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IERC20L {
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title CloakLaunchSwap
 * @notice Private swaps between notes in Cloak's launch vault through Uniswap V2 pairs, where the price buffer comes
 *         back to the trader instead of going to a treasury.
 *
 *         A deposit needs its exact amount up front (its proof binds it), and a swap's leftover is known only once it
 *         runs, so Gloam's own swap base sends leftovers to its treasury. Here the leftover stays in this contract,
 *         owed to the swap, and the owner's app takes it back later as one note of exactly that amount (claim), or in
 *         the clear to an address it names (exit).
 *
 * Entering. As Gloam's: the unshield proof names a one-time SwapEscrow2 made from the swap's key (the spend, the new
 * note, the route, the owner key, the deadline), so a copier who changes any of them gets another escrow and the proof
 * fails.
 *
 * Never stuck. The note is still in the vault (the whole swap reverted), or the new note is in the vault and the
 * leftover is owed here, or the spend was sent alone and the money waits at the escrow. In that last case, before the
 * deadline anyone can send the swap again, and after it anyone can call rescue, which owes the whole input back.
 *
 * @dev No owner, no fee, no allowlist: a hop may use only the pair the immutable V2 factory reports. No approval is
 *      given to pairs (they are paid by transfer), and the vault's approval is reset to zero after each deposit.
 *      A bad pair or token can at most cost the swap that uses it.
 */
abstract contract CloakLaunchSwapBase is IEscrowPayee {
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

    struct SwapKey {
        bytes32 nullifier;
        address assetIn;
        uint256 amountIn;
        bytes32 outCommitment;
        address assetOut;
        uint256 amountOut;
        bytes32 routeHash;
        address ownerKey;
        uint256 deadline;
    }

    struct Owed {
        address asset;
        address ownerKey;
        uint256 amount;
    }

    address internal constant NATIVE = address(0);
    uint256 public constant MAX_HOPS = 3;
    bytes32 private constant CLAIM_DOMAIN = keccak256("cloak.launch-swap.claim.v1");
    bytes32 private constant EXIT_DOMAIN = keccak256("cloak.launch-swap.exit.v1");

    IGloamVault public immutable vault;

    /// @notice What each swap (by keccak256 of its SwapKey) is owed: its leftover, or its whole input after a rescue.
    mapping(bytes32 => Owed) public owed;

    uint256 private _entered;
    bool private _openingNow;
    bool private _swappingNow;

    event LaunchSwap(bytes32 indexed id, address indexed assetIn, address indexed assetOut, uint256 amountIn, uint256 amountOut, uint256 leftover);
    event Rescued(bytes32 indexed id, address indexed asset, uint256 amount);
    event OwedPaid(bytes32 indexed id, address indexed asset, uint256 amount, bool toVault);
    /// @notice Cloak's fee on a sale out of its vaults, paid in what the sale brought (CloakRouterV4).
    event TradeFeePaid(bytes32 indexed id, address indexed asset, address indexed to, uint256 amount);

    error Reentrancy();
    error ZeroAddress();
    error SameAsset();
    error BadKey();
    error Expired();
    error NotYet();
    error Used();
    error BadRoute();
    error NoPair(address a, address b);
    error OverInput(uint256 need, uint256 have);
    error ShortOutput(uint256 got, uint256 want);
    error NothingOwed();
    error WrongAmount(uint256 owed);
    error BadSignature();
    error BadExit();
    error NativeRefused();
    error TokenCallFailed();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address vault_) {
        if (vault_ == address(0)) revert ZeroAddress();
        vault = IGloamVault(vault_);
    }

    /// @notice HYPE comes in from an escrow as it opens. A venue lets its own contracts pay in during a swap.
    receive() external payable virtual {
        if (!_openingNow) revert NativeRefused();
    }

    /// @dev An escrow is opening (paying this contract).
    function _opening() internal view returns (bool) {
        return _openingNow;
    }

    /// @dev A swap is running (between paying the venue and taking its output).
    function _inSwap() internal view returns (bool) {
        return _swappingNow;
    }

    /// @notice The vault that holds `asset`: a note of it is spent from there and a note of it is deposited there. One
    ///         vault here; CloakRouterV4 splits launch tokens (Cloak's launch vault) from HYPE and USDC (Gloam's).
    function vaultFor(address) public view virtual returns (IGloamVault) {
        return vault;
    }

    /// @notice Cloak's fee on a swap from `assetIn` to `assetOut`: what it takes (on top of the note's exact amount) and
    ///         where it goes. None here; CloakRouterV4 charges sales out of Cloak's vaults.
    function tradeFee(address assetIn, address assetOut, uint256 amountOut) public view virtual returns (uint256 fee, address to) {
        assetIn;
        assetOut;
        amountOut;
        return (0, address(0));
    }

    /// @dev The venue's own contracts, where money sent in an exit would stop.
    function _stopsHere(address) internal view virtual returns (bool) {
        return false;
    }

    /// @dev Buy exactly `amountOut` of `assetOut` with at most `maxIn` of `assetIn` held here, leaving the output here.
    function _swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxIn, bytes calldata route)
        internal
        virtual
        returns (uint256 amountIn);

    /// @notice SwapEscrow2 asks where to pay: always here.
    function escrowPayee() external view returns (address) {
        return address(this);
    }

    function idOf(SwapKey memory k) public pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    function keyOf(Spend calldata s, Deposit calldata d, bytes calldata route, address ownerKey, uint256 deadline)
        public
        pure
        returns (SwapKey memory)
    {
        return SwapKey(s.nullifier, s.asset, s.amount, d.commitment, d.asset, d.amount, keccak256(route), ownerKey, deadline);
    }

    /// @notice The address a swap's unshield proof must name.
    function escrowFor(SwapKey memory k) public view returns (address) {
        return _escrowAt(idOf(k), k.assetIn);
    }

    function _escrowAt(bytes32 salt, address token) private view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(token)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }

    /**
     * @notice Spend note `s`, buy exactly `d.amount` of `d.asset` through `route`, deposit it as note `d`, and owe the
     *         leftover to this swap. route = abi.encode(address[] path), WHYPE standing for HYPE.
     */
    function swap(Spend calldata s, Deposit calldata d, bytes calldata route, address ownerKey, uint256 deadline)
        external
        nonReentrant
        returns (bytes32 id, uint256 leftover)
    {
        if (s.asset == d.asset) revert SameAsset();
        if (d.amount == 0 || ownerKey == address(0)) revert BadKey();
        if (block.timestamp > deadline) revert Expired();
        id = _enter(s, keyOf(s, d, route, ownerKey, deadline));
        uint256 available = _open(id, s.asset);
        uint256 amountIn = _buy(id, d, available, s.asset, route);
        leftover = available - amountIn;
        if (leftover != 0) owed[id] = Owed(s.asset, ownerKey, leftover);
        emit LaunchSwap(id, s.asset, d.asset, amountIn, d.amount, leftover);
    }

    /// @dev Pays the note to the swap's escrow, unless a spend sent alone already did.
    function _enter(Spend calldata s, SwapKey memory k) private returns (bytes32 id) {
        id = idOf(k);
        IGloamVault v = vaultFor(s.asset);
        if (!v.isSpent(s.nullifier)) v.unshield(s.proof, s.root, s.nullifier, s.asset, escrowFor(k), s.amount);
    }

    /// @dev Buys exactly d.amount (plus Cloak's fee, if any) and deposits d.amount as note d, the fee to the treasury.
    ///      Returns the input spent.
    function _buy(bytes32 id, Deposit calldata d, uint256 available, address assetIn, bytes calldata route)
        private
        returns (uint256 amountIn)
    {
        (uint256 fee, address feeTo) = tradeFee(assetIn, d.asset, d.amount);
        uint256 want = d.amount + fee;
        uint256 outBefore = _balance(d.asset);
        _swappingNow = true;
        amountIn = _swapExactOut(assetIn, d.asset, want, available, route);
        _swappingNow = false;
        uint256 got = _balance(d.asset) - outBefore;
        if (got < want) revert ShortOutput(got, want);
        _deposit(d.asset, d.amount, d.commitment, d.proof);
        if (fee != 0) {
            _pay(d.asset, feeTo, fee);
            emit TradeFeePaid(id, d.asset, feeTo, fee);
        }
    }

    function _pay(address asset, address to, uint256 amount) private {
        if (asset == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TokenCallFailed();
        } else {
            _call(asset, abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
    }

    /// @notice After its deadline, a swap whose spend was sent alone owes its whole input back. Anyone may call it.
    function rescue(SwapKey calldata k) external nonReentrant returns (uint256 amount) {
        if (block.timestamp <= k.deadline) revert NotYet();
        if (k.ownerKey == address(0)) revert BadKey();
        bytes32 id = idOf(k);
        amount = _open(id, k.assetIn);
        owed[id] = Owed(k.assetIn, k.ownerKey, amount);
        emit Rescued(id, k.assetIn, amount);
    }

    function claimDigest(bytes32 id, bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_DOMAIN, block.chainid, address(this), id, commitment));
    }

    function exitDigest(bytes32 id, address to) public view returns (bytes32) {
        return keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), id, to));
    }

    /// @notice Deposit what a swap is owed as one note of exactly that amount, as its owner key signed.
    function claim(bytes32 id, Deposit calldata d, bytes calldata signature) external nonReentrant {
        Owed memory o = owed[id];
        if (o.amount == 0) revert NothingOwed();
        if (d.asset != o.asset || d.amount != o.amount) revert WrongAmount(o.amount);
        if (_recover(claimDigest(id, d.commitment), signature) != o.ownerKey) revert BadSignature();
        delete owed[id];
        _deposit(o.asset, o.amount, d.commitment, d.proof);
        emit OwedPaid(id, o.asset, o.amount, true);
    }

    /// @notice Pay what a swap is owed to `to` in the clear, as its owner key signed.
    function exit(bytes32 id, address to, bytes calldata signature) external nonReentrant {
        Owed memory o = owed[id];
        if (o.amount == 0) revert NothingOwed();
        if (to == address(0) || to == address(this) || to == address(vault) || to == o.asset || _stopsHere(to)) revert BadExit();
        if (_recover(exitDigest(id, to), signature) != o.ownerKey) revert BadSignature();
        delete owed[id];
        if (o.asset == NATIVE) {
            (bool ok,) = to.call{value: o.amount}("");
            if (!ok) revert TokenCallFailed();
        } else {
            _call(o.asset, abi.encodeWithSelector(0xa9059cbb, to, o.amount));
        }
        emit OwedPaid(id, o.asset, o.amount, false);
    }

    // ── internals ──────────────────────────────────────────────────────

    function _open(bytes32 salt, address token) private returns (uint256 arrived) {
        // an opened escrow keeps one byte of code: refuse it before a second deploy fails there and burns the gas sent
        if (_escrowAt(salt, token).code.length != 0) revert Used();
        uint256 before = _balance(token);
        bytes memory code = abi.encodePacked(type(SwapEscrow2).creationCode, abi.encode(token));
        address e;
        _openingNow = true;
        assembly {
            e := create2(0, add(code, 0x20), mload(code), salt)
        }
        _openingNow = false;
        if (e == address(0)) revert Used();
        arrived = _balance(token) - before;
        if (arrived == 0) revert Used();
    }

    function _deposit(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) private {
        IGloamVault v = vaultFor(asset);
        if (asset == NATIVE) {
            v.shieldBound{value: amount}(NATIVE, amount, commitment, proof);
            return;
        }
        _call(asset, abi.encodeWithSelector(0x095ea7b3, address(v), amount));
        v.shieldBound(asset, amount, commitment, proof);
        _call(asset, abi.encodeWithSelector(0x095ea7b3, address(v), 0));
    }

    function _balance(address token) internal view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20L(token).balanceOf(address(this));
    }

    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}

/**
 * @title CloakLaunchSwap
 * @notice The Uniswap V2 venue for CloakLaunchSwapBase: routes through the pairs the immutable V2 factory reports.
 *         route = abi.encode(address[] path), WHYPE standing for HYPE, at most 3 hops.
 */
contract CloakLaunchSwap is CloakLaunchSwapBase {
    IV2FactoryL public immutable factory;
    IWETHL public immutable weth;

    constructor(address vault_, address factory_, address weth_) CloakLaunchSwapBase(vault_) {
        if (factory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        factory = IV2FactoryL(factory_);
        weth = IWETHL(weth_);
    }

    /// @notice HYPE comes in from an escrow as it opens, or from WHYPE during a swap (an unwrap).
    receive() external payable override {
        if (_opening()) return;
        if (!_inSwap() || msg.sender != address(weth)) revert NativeRefused();
    }

    function _stopsHere(address to) internal view override returns (bool) {
        return to == address(weth) || to == address(factory);
    }

    function _swapExactOut(address assetIn, address assetOut, uint256 amountOut, uint256 maxIn, bytes calldata route)
        internal
        override
        returns (uint256 amountIn)
    {
        address[] memory path = abi.decode(route, (address[]));
        if (path.length < 2 || path.length - 1 > MAX_HOPS) revert BadRoute();
        uint256 hops = path.length - 1;
        if (path[0] != (assetIn == NATIVE ? address(weth) : assetIn)) revert BadRoute();
        if (path[hops] != (assetOut == NATIVE ? address(weth) : assetOut)) revert BadRoute();

        // amounts backwards from the exact output (Uniswap V2's getAmountIn, 0.3% fee)
        address[] memory pairs = new address[](hops);
        uint256[] memory amounts = new uint256[](path.length);
        amounts[hops] = amountOut;
        for (uint256 i = hops; i > 0; i--) {
            address pair = factory.getPair(path[i - 1], path[i]);
            if (pair == address(0)) revert NoPair(path[i - 1], path[i]);
            pairs[i - 1] = pair;
            (uint256 rIn, uint256 rOut) = _reserves(pair, path[i - 1]);
            if (amounts[i] >= rOut) revert ShortOutput(0, amounts[i]);
            amounts[i - 1] = (rIn * amounts[i] * 1000) / ((rOut - amounts[i]) * 997) + 1;
        }
        amountIn = amounts[0];
        if (amountIn > maxIn) revert OverInput(amountIn, maxIn);

        if (assetIn == NATIVE) weth.deposit{value: amountIn}();
        _call(path[0], abi.encodeWithSelector(0xa9059cbb, pairs[0], amountIn));
        for (uint256 i = 0; i < hops; i++) {
            address to = i + 1 < hops ? pairs[i + 1] : address(this);
            bool zeroIn = IV2PairL(pairs[i]).token0() == path[i];
            IV2PairL(pairs[i]).swap(zeroIn ? 0 : amounts[i + 1], zeroIn ? amounts[i + 1] : 0, to, "");
        }
        if (assetOut == NATIVE) weth.withdraw(amountOut);
    }

    function _reserves(address pair, address tokenIn) private view returns (uint256 rIn, uint256 rOut) {
        (uint112 r0, uint112 r1,) = IV2PairL(pair).getReserves();
        (rIn, rOut) = IV2PairL(pair).token0() == tokenIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
