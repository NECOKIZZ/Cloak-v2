// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {CloakV4Market, IHookView} from "./CloakV4Market.sol";

interface IERC20V4 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// The launch factory, as far as the hook needs it: which addresses are its auctions.
interface ICloakLaunchFactory {
    function isAuction(address a) external view returns (bool);
    function config() external view returns (address);
}

/// The factory's token deployer, as far as the hook needs it: the one token its one-time door made (GLOAK).
interface ICloakFactoryDoor {
    function vestingDeployer() external view returns (address);
}

interface ICloakDoor {
    function doorToken() external view returns (address);
}

/// The door's token decides who may swap in its pool.
interface IPrivatePoolGate {
    function canSwap(address swapper) external view returns (bool);
}

/// CloakConfig's treasury: where the launch fee goes, and Cloak's share of the trading fees.
interface ICloakTreasury {
    function feeRecipient() external view returns (address);
}

/// A Cloak auction's parameters (CloakAuction.params()), as far as the hook needs them.
interface ICloakAuctionParams {
    function params()
        external
        view
        returns (
            address creator,
            uint256 saleSupply,
            uint256 lpReserve,
            uint256 minPrice,
            uint256 tickSize,
            uint16 numTicks,
            uint64 commitEnd,
            uint64 revealEnd,
            uint16 lpBps,
            uint16 noRevealPenaltyBps,
            uint64 lpLockUntil,
            uint64 tlockRound
        );
}

/// @title CloakV4Hook — opens a settled Cloak launch's market as a Uniswap v4 pool, and looks after it forever.
/// @notice The launch factory's seeder: at settlement the auction hands it the LP budget and the clearing price, and the
///         hook opens a native-HYPE / token v4 pool at exactly that price with all of it as one full-range position.
///
///         - **The liquidity is permanent.** The hook owns the only position and never removes it; nobody else can add
///           or remove liquidity in a Cloak pool, so its depth is exactly the launch's (the market adapter's reserves are
///           then exact, and no one can pull liquidity out from under traders).
///         - **Trading fees:** `PROTOCOL_SHARE_BPS` (20%) to Cloak's treasury (CloakConfig's `feeRecipient`), the rest
///           to the creator (or, for a launch that chose to burn its LP, to 0x…dEaD). Anyone can call `collectFees`.
///         - **Anti-snipe fee.** The pool's fee starts at `startFee` when it opens and falls in a straight line to
///           `baseFee` over `decaySecs`, so racing the listing costs the racer, and what they pay goes to the creator.
///         - **A time-weighted price** for batch rounds, updated before every swap (like Uniswap V2's accumulator).
///
/// @dev Deployed to an address whose low bits grant exactly: beforeInitialize, beforeAddLiquidity,
///      beforeRemoveLiquidity, beforeSwap. Pools are only initialised by the hook itself.
contract CloakV4Hook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 public constant TICK_SPACING = 60;
    int24 public constant MIN_TICK = -887220; // TickMath.minUsableTick(60)
    int24 public constant MAX_TICK = 887220;
    uint256 internal constant Q96 = 1 << 96;
    /// @notice Cloak's share of every launch pool's trading fees (anti-snipe fee included), in basis points. Fixed.
    uint256 public constant PROTOCOL_SHARE_BPS = 2_000;

    IPoolManager public immutable poolManager;
    address public immutable deployer;
    uint24 public immutable baseFee; // pips (1e6 = 100%)
    uint24 public immutable startFee;
    uint32 public immutable decaySecs;

    ICloakLaunchFactory public factory;

    struct Launch {
        CloakV4Market market;
        address feeTo;
        uint64 listedAt;
        uint64 lastAt; // the accumulator's last update
        uint256 cum; // Σ price × seconds (price in wei of HYPE per 1e18 token units); wraps by design
    }

    mapping(PoolId => Launch) internal _launches;
    /// @notice A creator's HYPE fees its address wouldn't take (a contract that refuses HYPE): it claims them to another
    ///         address with claimHeldFees. Holding them keeps one refusal from blocking Cloak's share (review R-02).
    mapping(address => uint256) public heldFees;
    mapping(address => PoolId) internal _poolOf; // token → its pool
    /// @notice The one private-only pool (the GLOAK experiment: the token the factory deployer's one-time door made), or
    ///         zero. Only swappers that token approves may swap there. Every other pool is untouched: its id is never zero.
    PoolId public privatePool;

    event Listed(address indexed token, PoolId indexed id, address market, address feeTo, uint160 sqrtPriceX96, uint128 liquidity, uint256 hype, uint256 tokens);
    event FeesCollected(address indexed token, address indexed to, uint256 hype, uint256 tokens);
    event ProtocolFeesCollected(address indexed token, address indexed treasury, uint256 hype, uint256 tokens);
    event FeesHeld(address indexed to, uint256 hype);
    event HeldFeesClaimed(address indexed by, address indexed to, uint256 hype);

    error NotPoolManager();
    error OnlyHook();
    error PrivatePool();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @param admin_ who may name the launch factory, once (deployed through a CREATE2 deployer, msg.sender isn't us)
    constructor(IPoolManager poolManager_, address admin_, uint24 baseFee_, uint24 startFee_, uint32 decaySecs_) {
        require(baseFee_ <= startFee_ && startFee_ <= 500_000, "fees"); // never more than 50%
        require(admin_ != address(0), "admin");
        poolManager = poolManager_;
        deployer = admin_;
        baseFee = baseFee_;
        startFee = startFee_;
        decaySecs = decaySecs_;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: true,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice v4 liquidity stays with the hook, so a launch can't lock it until a date and then take it back.
    function timedLocks() external pure returns (bool) {
        return false;
    }

    /// @notice The launch factory whose auctions may list here. Set once, by the deployer.
    function setFactory(ICloakLaunchFactory f) external {
        require(msg.sender == deployer && address(factory) == address(0) && address(f) != address(0), "factory");
        factory = f;
    }

    /// The pools' key for a token: native HYPE (currency0, address 0 sorts first) against the token.
    function keyFor(address token) public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(this)));
    }

    function poolIdOf(address token) external view returns (PoolId) {
        return _poolOf[token];
    }

    function launchOf(address token) external view returns (Launch memory) {
        return _launches[_poolOf[token]];
    }

    // ───────────────────────────── seeding (IMarketSeeder) ─────────────────────────────

    /// @notice Open the market for `token` at `price` (wei of HYPE per 1e18 tokens) with up to msg.value HYPE and up to
    ///         `tokenAmount` tokens pulled from the caller, which must be one of the factory's auctions. `lpTo` is
    ///         0x…dEaD for a launch that burns its LP (fees then go to 0x…dEaD too); anything else means the creator
    ///         earns the trading fees. Returns the market adapter, as `market` and as `uniPair` (the vault and the
    ///         auction treat a non-zero `uniPair` as "a Uniswap market"), the position's liquidity as `shares`, and what
    ///         was used; the rest goes back to the caller.
    function seed(address token, uint256 tokenAmount, uint256 price, address lpTo)
        external
        payable
        returns (address market, address uniPair, uint256 shares, uint256 hypeUsed, uint256 tokensUsed)
    {
        require(address(factory) != address(0) && factory.isAuction(msg.sender), "not a launch");
        require(msg.value > 0 && tokenAmount > 0 && price > 0, "zero");
        require(PoolId.unwrap(_poolOf[token]) == bytes32(0), "listed");
        require(IERC20V4(token).transferFrom(msg.sender, address(this), tokenAmount), "tf");

        PoolKey memory key = keyFor(token);
        PoolId id = key.toId();
        uint160 sqrtP = sqrtPriceFor(price);
        poolManager.initialize(key, sqrtP);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(MIN_TICK), TickMath.getSqrtPriceAtTick(MAX_TICK), msg.value, tokenAmount
        );
        require(liquidity > 0, "liquidity");
        (hypeUsed, tokensUsed) = abi.decode(poolManager.unlock(abi.encode(uint8(0), key, uint256(liquidity), address(0), address(0))), (uint256, uint256));

        address feeTo = lpTo == DEAD ? DEAD : _creatorOf(msg.sender);
        CloakV4Market m = new CloakV4Market(poolManager, IHookView(address(this)), token);
        _poolOf[token] = id;
        _launches[id] = Launch(m, feeTo, uint64(block.timestamp), uint64(block.timestamp), 0);
        if (_isDoorToken(token)) privatePool = id;
        (market, uniPair, shares) = (address(m), address(m), liquidity);

        if (tokenAmount > tokensUsed) require(IERC20V4(token).transfer(msg.sender, tokenAmount - tokensUsed), "t");
        if (msg.value > hypeUsed) {
            (bool ok,) = msg.sender.call{value: msg.value - hypeUsed}("");
            require(ok, "refund");
        }
        emit Listed(token, id, address(m), feeTo, sqrtP, liquidity, hypeUsed, tokensUsed);
    }

    /// @dev Whether `token` is the one token the factory's deployer made through its one-time door. Never reverts: a
    ///      factory or deployer without a door answers no.
    function _isDoorToken(address token) internal view returns (bool) {
        if (PoolId.unwrap(privatePool) != bytes32(0)) return false;
        try ICloakFactoryDoor(address(factory)).vestingDeployer() returns (address d) {
            if (d.code.length == 0) return false;
            try ICloakDoor(d).doorToken() returns (address t) {
                return t != address(0) && t == token;
            } catch {}
        } catch {}
        return false;
    }

    function _creatorOf(address auction) internal view returns (address creator) {
        (creator,,,,,,,,,,,) = ICloakAuctionParams(auction).params();
        if (creator == address(0)) creator = DEAD;
    }

    /// @notice The pool price for `price` wei of HYPE per 1e18 tokens: sqrt(tokens per HYPE) × 2^96.
    function sqrtPriceFor(uint256 price) public pure returns (uint160) {
        uint256 s = _sqrt(FullMath.mulDiv(1e18, 1 << 192, price));
        require(s >= TickMath.getSqrtPriceAtTick(MIN_TICK) && s < TickMath.getSqrtPriceAtTick(MAX_TICK), "price out of range");
        return uint160(s);
    }

    /// @notice Pay a launch's trading fees so far: `PROTOCOL_SHARE_BPS` to Cloak's treasury, the rest to its creator
    ///         (or 0x…dEaD). Anyone can call it. Returns the creator's part.
    function collectFees(address token) external returns (uint256 hype, uint256 tokens) {
        PoolId id = _poolOf[token];
        Launch storage l = _launches[id];
        require(address(l.market) != address(0), "not listed");
        address treasury = treasuryOf();
        uint256 ph;
        uint256 pt;
        (hype, tokens, ph, pt) = abi.decode(poolManager.unlock(abi.encode(uint8(1), keyFor(token), uint256(0), l.feeTo, treasury)), (uint256, uint256, uint256, uint256));
        // the creator's HYPE came here: pay it on, and hold it if the address refuses, so a creator that can't take HYPE
        // never blocks the payout, Cloak's share included (review R-02)
        if (hype > 0) {
            (bool ok,) = l.feeTo.call{value: hype, gas: 50_000}("");
            if (!ok) {
                heldFees[l.feeTo] += hype;
                emit FeesHeld(l.feeTo, hype);
            }
        }
        emit FeesCollected(token, l.feeTo, hype, tokens);
        if (ph > 0 || pt > 0) emit ProtocolFeesCollected(token, treasury, ph, pt);
    }

    /// @notice A creator whose address refused its HYPE fees takes them to another address.
    function claimHeldFees(address payable to) external {
        uint256 amount = heldFees[msg.sender];
        require(amount > 0, "nothing held");
        heldFees[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
        emit HeldFeesClaimed(msg.sender, to, amount);
    }

    /// @notice HYPE arrives only from the PoolManager, as a creator's fees on their way out.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    /// @notice Where Cloak's share goes: the launch factory's CloakConfig treasury (address(0) if it can't be read,
    ///         and then the creator gets it all, so collecting never gets stuck).
    function treasuryOf() public view returns (address t) {
        if (address(factory) == address(0)) return address(0);
        try factory.config() returns (address c) {
            try ICloakTreasury(c).feeRecipient() returns (address r) {
                t = r;
            } catch {}
        } catch {}
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, PoolKey memory key, uint256 liquidity, address to, address treasury) = abi.decode(data, (uint8, PoolKey, uint256, address, address));
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(MIN_TICK, MAX_TICK, int256(liquidity), 0);
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key, mp, "");
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (action == 0) {
            // adding: pay what the position needs
            uint256 h = uint256(uint128(-a0));
            uint256 t = uint256(uint128(-a1));
            poolManager.settle{value: h}();
            poolManager.sync(key.currency1);
            require(IERC20V4(Currency.unwrap(key.currency1)).transfer(address(poolManager), t), "t");
            poolManager.settle();
            return abi.encode(h, t);
        }
        // collecting: a zero change pays out the fees the position has earned, Cloak's share first
        uint256 fh = a0 > 0 ? uint256(uint128(a0)) : 0;
        uint256 ft = a1 > 0 ? uint256(uint128(a1)) : 0;
        uint256 ph = treasury == address(0) ? 0 : (fh * PROTOCOL_SHARE_BPS) / 10_000;
        uint256 pt = treasury == address(0) ? 0 : (ft * PROTOCOL_SHARE_BPS) / 10_000;
        if (ph > 0) poolManager.take(key.currency0, treasury, ph);
        if (pt > 0) poolManager.take(key.currency1, treasury, pt);
        // the creator's HYPE comes here first and is paid on after the unlock (collectFees), so a refusal can't revert it
        if (fh > ph) poolManager.take(key.currency0, address(this), fh - ph);
        if (ft > pt) poolManager.take(key.currency1, to, ft - pt);
        return abi.encode(fh - ph, ft - pt, ph, pt);
    }

    // ───────────────────────────── reads for the market adapter ─────────────────────────────

    /// @notice The fee a swap pays right now, in pips: `startFee` at listing, falling to `baseFee` over `decaySecs`.
    function currentFee(address token) public view returns (uint24) {
        Launch storage l = _launches[_poolOf[token]];
        if (l.listedAt == 0) return baseFee;
        uint256 dt = block.timestamp - l.listedAt;
        if (dt >= decaySecs) return baseFee;
        return uint24(startFee - (uint256(startFee - baseFee) * dt) / decaySecs);
    }

    /// @notice Spot price: wei of HYPE per 1e18 token units.
    function priceOf(PoolId id) public view returns (uint256) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        if (sqrtP == 0) return 0;
        return FullMath.mulDiv(FullMath.mulDiv(1e18, Q96, sqrtP), Q96, sqrtP);
    }

    /// @notice Σ price × seconds up to now, and when (the market adapter's `cumulativeNow`).
    function cumulativeNow(address token) external view returns (uint256 cum, uint64 at) {
        PoolId id = _poolOf[token];
        Launch storage l = _launches[id];
        cum = l.cum;
        unchecked {
            cum += priceOf(id) * (block.timestamp - l.lastAt);
        }
        at = uint64(block.timestamp);
    }

    function lastSwapAt(address token) external view returns (uint64) {
        return _launches[_poolOf[token]].lastAt;
    }

    // ───────────────────────────── hooks ─────────────────────────────

    function beforeInitialize(address sender, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        if (sender != address(this)) revert OnlyHook();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(this)) revert OnlyHook();
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata params, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        // only the hook, and only to collect fees: the position itself is never reduced
        if (sender != address(this) || params.liquidityDelta != 0) revert OnlyHook();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        // the GLOAK experiment's pool only: its token names who may swap (a router that delivers into a vault)
        if (PoolId.unwrap(id) == PoolId.unwrap(privatePool) && !IPrivatePoolGate(Currency.unwrap(key.currency1)).canSwap(sender)) {
            revert PrivatePool();
        }
        Launch storage l = _launches[id];
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs > l.lastAt) {
            // the price since the last swap held until now: add it to the accumulator before this swap moves it
            unchecked {
                l.cum += priceOf(id) * (nowTs - l.lastAt);
            }
            l.lastAt = nowTs;
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, currentFee(Currency.unwrap(key.currency1)) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // not enabled in the hook's address: the PoolManager never calls these
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert OnlyHook();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert OnlyHook();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert OnlyHook();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) {
        revert OnlyHook();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert OnlyHook();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert OnlyHook();
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }

}
