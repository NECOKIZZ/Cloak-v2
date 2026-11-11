// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console, stdJson} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey as V4Key} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakConfig} from "cloak/CloakConfig.sol";
import {CloakFactory} from "cloak/CloakFactory.sol";
import {CloakAuction, IMarketSeeder, IFeeLocker} from "cloak/CloakAuction.sol";
import {CloakVestingDeployer} from "cloak/CloakVesting.sol";
import {CloakLaunchVault} from "cloak-gloam/CloakLaunchVault.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakLaunchSwapV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {CloakGloamBids} from "cloak-gloam/CloakGloamBids.sol";
import {CloakV4Hook, ICloakLaunchFactory} from "../src/CloakV4Hook.sol";
import {CloakV4Market} from "../src/CloakV4Market.sol";
import {GloakToken, GloakMaker} from "../src/experiment/GloakToken.sol";
import {YesV, ToV, WHYPE} from "./CloakLaunchSwapV4.t.sol";

interface IUniversalRouterS {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/**
 * A narrated run of the GLOAK experiment, start to finish, with small numbers: 500,000 GLOAK, no team share, 3 HYPE of
 * bids in all (two private bidders, one public), a thin pool, then private trades, public moves, a buyback and a move
 * between two vaults. Proofs are stand-ins (as in the router's tests); everything else is the real code.
 *
 *   MAINNET_RPC=https://rpc.elysium.kinetiq.xyz forge test --match-contract GloakSimulation -vv
 * runs it on a fork of Elysium mainnet, on Uniswap's real PoolManager and Universal Router. Without MAINNET_RPC it runs
 * on a local PoolManager and skips the Universal Router step.
 */
contract GloakSimulation is Test {
    using stdJson for string;

    IPoolManager constant MAINNET_PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant UNIVERSAL_ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 constant FLAGS = (1 << 13) | (1 << 11) | (1 << 9) | (1 << 7);

    // the launch: 500,000 GLOAK = 300,000 for sale + 200,000 for the pool (the reserve must cover the pool's 50% of a
    // sold-out sale); 0.00001 HYPE a token at the lowest tick
    uint256 constant SALE = 300_000e18;
    uint256 constant LP_RESERVE = 200_000e18;
    uint256 constant MIN_PRICE = 1e13;

    uint8 constant RECEIVE = 1;
    uint8 constant FEED = 4;
    uint8 constant SWAP = 8;
    uint8 constant VAULT = 16;
    uint8 constant PAYEE = 32;

    IPoolManager pm;
    bool forked;
    CloakConfig config;
    CloakV4Hook hook;
    CloakVestingDeployer deployer;
    CloakFactory factory;
    CloakAuction auction;
    GloakToken gloak;
    CloakV4Market market;
    CloakLaunchVault lv;
    CloakLaunchVault otherVault;
    CloakLaunchSwapV4 router;
    CloakGloamBids bids;

    address admin = makeAddr("owner wallet");
    address treasury = makeAddr("treasury");
    address cy = makeAddr("cy (public bidder)");
    address eve = makeAddr("eve");
    address bridge = makeAddr("bridge wallet (Cloak's)");
    uint256 constant ADA = 0xADA; // owner keys of private balances
    uint256 constant BEN = 0xBE2;
    uint256 constant DAN = 0xDA2;
    uint256 constant TREASURY_KEY = 0x7E5;
    uint256 nonce;

    struct PrivateBid {
        CloakGloamBids.BidKey k;
        address account;
        uint256 id;
        uint128 qty;
        bytes32 salt;
    }

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC", string(""));
        if (bytes(rpc).length != 0) {
            vm.createSelectFork(rpc);
            require(block.chainid == 99901, "not Elysium mainnet");
            pm = MAINNET_PM;
            forked = true;
        } else {
            pm = IPoolManager(address(new PoolManager(address(this))));
        }
        config = new CloakConfig(address(1), address(0));
        config.setFees(0, 150, treasury); // the 1.5% launch fee
        hook = _deployHook();
        deployer = new CloakVestingDeployer(admin);
        factory = new CloakFactory(config, deployer, IMarketSeeder(address(hook)), IFeeLocker(address(0)));
        hook.setFactory(ICloakLaunchFactory(address(factory)));
        vm.deal(address(this), 100 ether);
        vm.deal(cy, 10 ether);
        vm.deal(eve, 10 ether);
    }

    function test_simulation() public {
        console.log(forked ? "== GLOAK on a fork of Elysium mainnet (Uniswap's real PoolManager) ==" : "== GLOAK on a local PoolManager ==");

        // ── 1. the vault, the router, private bids and the door ──
        lv = new CloakLaunchVault(_poseidon(), address(new ToV()), address(factory), 1e30, 1e32, address(0));
        lv.setShieldVerifier(address(new YesV()));
        lv.turnOnDepositLimits();
        lv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        lv.endSetup();
        router = new CloakLaunchSwapV4(address(lv), address(pm), address(new WHYPE()), address(hook));
        bids = new CloakGloamBids(address(lv), address(0)); // HYPE in the launch vault here (Gloam's vault on mainnet)

        // GLOAK is born with its private zone approved (the maker fixes it at deploy)
        address[] memory zone = new address[](3);
        uint8[] memory roles = new uint8[](3);
        (zone[0], roles[0]) = (address(lv), RECEIVE | VAULT);
        (zone[1], roles[1]) = (address(router), RECEIVE | FEED | SWAP | PAYEE);
        (zone[2], roles[2]) = (address(bids), RECEIVE);
        GloakMaker maker = new GloakMaker(address(deployer), admin, address(pm), address(hook), zone, roles);
        bytes memory call_ = abi.encodeCall(CloakFactory.createLaunch, ("GLOAK", "GLOAK", 0, 0, _params(), ""));
        vm.prank(admin);
        deployer.useDoor(address(maker), address(factory), call_);
        (address a, address t,,,,) = factory.launches(0);
        auction = CloakAuction(payable(a));
        gloak = GloakToken(t);
        console.log("1. Door used: GLOAK launched. Supply", _f(gloak.totalSupply()), "| team share 0 | door closed:", deployer.doorUsed());

        console.log("   Born approved: the launch vault (Receive, Vault), the router (Receive, Feed, Swap, Payee), private bids (Receive)");

        // ── 2. bids: 3 HYPE in all ──
        PrivateBid memory ada = _privateBid(ADA, 1 ether, 100_000e18);
        PrivateBid memory ben = _privateBid(BEN, 1.5 ether, 150_000e18);
        bytes32 cySalt = keccak256("cy");
        bytes32 cyCommitment = auction.commitmentOf(cy, 0, uint128(50_000e18), cySalt);
        vm.prank(cy);
        uint256 cyId = auction.commit{value: 0.5 ether}(cyCommitment, "");
        console.log("2. Bids sealed: Ada 1 HYPE and Ben 1.5 HYPE from private balances, Cy 0.5 HYPE from her public wallet");
        console.log("   The auction sees Ada's and Ben's one-time bid accounts, not who they are:", ada.account, ben.account);

        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,,) = auction.params();
        vm.warp(commitEnd);
        auction.reveal(ada.id, 0, ada.qty, ada.salt);
        auction.reveal(ben.id, 0, ben.qty, ben.salt);
        auction.reveal(cyId, 0, uint128(50_000e18), cySalt);
        vm.warp(revealEnd);
        auction.settle();
        market = CloakV4Market(payable(address(auction.pair())));
        (uint256 rH, uint256 rT,) = market.reserves();
        console.log("3. Settled at", _f8(auction.clearingPrice()), "HYPE per GLOAK. Sold", _f(auction.sold()));
        console.log("   Raised", _f(auction.raised()), "HYPE; launch fee", _f(auction.feesOwed()));
        console.log("   Pool opened with", _f(rH), "HYPE and GLOAK", _f(rT));
        console.log("   GLOAK at 0xdEaD (unsold + unused pool reserve):", _f(gloak.balanceOf(DEAD)));
        console.log("   GLOAK's pool is the hook's private pool:", PoolId.unwrap(hook.privatePool()) == PoolId.unwrap(hook.poolIdOf(address(gloak))));
        lv.admitLaunch(0);
        _meter("after settlement");

        // ── 3. claims ──
        console.log("4. Claims");
        (uint256 adaTokens,,) = auction.allocationOf(ada.id);
        CloakGloamBids.Deposit[] memory ds = new CloakGloamBids.Deposit[](1);
        ds[0] = CloakGloamBids.Deposit(hex"00", _commitment(), address(gloak), adaTokens);
        bids.finish(ada.k, ds, _sign(ADA, bids.finishDigest(ada.account, ds)));
        console.log("   Ada claims", _f(adaTokens), "GLOAK straight into the vault as a note (free, exact)");
        (uint256 benTokens,,) = auction.allocationOf(ben.id);
        bytes32 benNote = _finishPrivate(ben, BEN, benTokens);
        console.log("   Ben claims", _f(benTokens), "GLOAK into the vault as a note");
        auction.claim(cyId);
        console.log("   Cy claims in public:", _f(gloak.balanceOf(cy)), "GLOAK in her wallet (the auction pays out free)");
        vm.startPrank(cy);
        gloak.approve(address(lv), 25_000e18);
        lv.shieldBound(address(gloak), 25_000e18, _commitment(), hex"00");
        vm.stopPrank();
        console.log("   Cy shields 25,000 of it: free, the vault gets exactly 25,000");
        _meter("after claims");

        // ── 4. private trading ──
        vm.warp(block.timestamp + 600); // past the anti-snipe window
        console.log("5. Private trading (a thin pool, so prices move a lot)");
        bytes32 danHype = _shieldHype(0.5 ether);
        (rH, rT,) = market.reserves();
        uint256 want = market.getAmountOut(0.2 ether, rH, rT);
        uint256 supplyBefore = gloak.totalSupply();
        (bytes32 danSwap, uint256 danLeft) = _swap(DAN, danHype, address(0), 0.5 ether, address(gloak), want);
        console.log("   Dan buys", _f(want), "GLOAK with a 0.5 HYPE note; HYPE left over, owed back:", _f(danLeft));
        danSwap;
        bytes32 adaNote = bytes32(uint256(keccak256(abi.encode("ada note"))));
        (rH, rT,) = market.reserves();
        uint256 hypeOut = (market.getAmountOut(adaTokens / 2, rT, rH) * 99) / 100;
        (bytes32 adaSwap, uint256 adaLeft) = _swap(ADA, adaNote, address(gloak), adaTokens, address(0), hypeOut);
        console.log("   Ada spends her whole note to sell about half for", _f(hypeOut), "HYPE");
        CloakLaunchSwapBase.Deposit memory back = CloakLaunchSwapBase.Deposit(hex"00", _commitment(), address(gloak), adaLeft);
        router.claim(adaSwap, back, _sign(ADA, router.claimDigest(adaSwap, back.commitment)));
        console.log("   The unsold GLOAK comes back to her as a new note:", _f(adaLeft));
        console.log("   GLOAK burned by those trades:", _f(supplyBefore - gloak.totalSupply()));

        if (forked) {
            V4Key memory k = hook.keyFor(address(gloak));
            vm.prank(eve);
            try this.universalBuy{value: 0.1 ether}(k) {
                console.log("   unexpected: the Universal Router bought GLOAK");
            } catch {
                console.log("   Eve tries Uniswap's real Universal Router: refused (GLOAK's pool is private)");
            }
        }
        _meter("after trading");

        // ── 5. public moves ──
        console.log("6. Leaving the vault and moving in public");
        supplyBefore = gloak.totalSupply();
        _unshield(_note(), 10_000e18, cy);
        console.log("   Cy withdraws 10,000 from a note to her wallet: receives", _f(10_000e18 - (supplyBefore - gloak.totalSupply())), "(1,000 burned)");
        vm.prank(cy);
        gloak.transfer(eve, 5_000e18);
        console.log("   Cy sends Eve 5,000: Eve receives", _f(gloak.balanceOf(eve)));
        vm.prank(eve);
        try gloak.transfer(address(pm), 1_000e18) {
            console.log("   unexpected: Eve paid GLOAK into Uniswap");
        } catch {
            console.log("   Eve tries to pay GLOAK into Uniswap to sell it: refused");
        }
        vm.startPrank(eve);
        gloak.approve(address(lv), 4_500e18);
        lv.shieldBound(address(gloak), 4_500e18, _commitment(), hex"00");
        vm.stopPrank();
        console.log("   Eve shields her 4,500 instead: free and exact. She can now sell privately.");
        console.log("   Burned by surcharges so far:", _f(gloak.surchargeBurned()));
        _meter("after public moves");

        // ── 6. buyback from the pool's fees ──
        console.log("7. Buyback");
        (uint256 feeHype, uint256 feeTokens) = hook.collectFees(address(gloak));
        console.log("   Pool fees to the treasury (creator share):", _f(feeHype), "HYPE; GLOAK (after its 10%)", _f(gloak.balanceOf(treasury)));
        feeTokens;
        uint256 hypeFees = treasury.balance;
        console.log("   The treasury holds", _f(hypeFees), "HYPE in fees (the 20% protocol share included)");
        if (hypeFees > 0) {
            vm.prank(treasury);
            lv.shieldBound{value: hypeFees}(address(0), hypeFees, _commitment(), hex"00");
            bytes32 tNote = _lastNote;
            (rH, rT,) = market.reserves();
            uint256 buy = (market.getAmountOut(hypeFees, rH, rT) * 98) / 100;
            (bytes32 tSwap,) = _swap(TREASURY_KEY, tNote, address(0), hypeFees, address(gloak), buy);
            tSwap;
            uint256 deadBefore = gloak.balanceOf(DEAD);
            _unshield(_lastSwapNote, buy, DEAD);
            console.log("   It buys", _f(buy), "GLOAK privately and sends it to 0xdEaD from the vault: burned in full:", _f(gloak.balanceOf(DEAD) - deadBefore));
        }
        _meter("after buyback");

        // ── 7. another protocol's vault, and moving between vaults ──
        console.log("8. Another privacy protocol's vault, and moving GLOAK into it");
        otherVault = new CloakLaunchVault(_poseidon(), address(new ToV()), address(factory), 1e30, 1e32, address(0));
        otherVault.setShieldVerifier(address(new YesV()));
        otherVault.turnOnDepositLimits();
        otherVault.endSetup();
        otherVault.admitLaunch(0);
        vm.startPrank(admin);
        gloak.endSetup();
        gloak.queueRoles(address(otherVault), RECEIVE | VAULT);
        gloak.queueRoles(bridge, RECEIVE);
        vm.warp(block.timestamp + 3 days);
        gloak.applyRoles(address(otherVault), RECEIVE | VAULT);
        gloak.applyRoles(bridge, RECEIVE);
        vm.stopPrank();
        console.log("   Setup ended; the other vault and Cloak's bridge wallet approved after 3 days in public");
        supplyBefore = gloak.totalSupply();
        _unshield(benNote, 50_000e18, bridge);
        vm.startPrank(bridge);
        gloak.approve(address(otherVault), 50_000e18);
        otherVault.shieldBound(address(gloak), 50_000e18, _commitment(), hex"00");
        vm.stopPrank();
        console.log("   Ben moves 50,000 through the bridge wallet: the other vault holds", _f(otherVault.deposited(address(gloak))), "| burned:", _f(supplyBefore - gloak.totalSupply()));
        console.log("   (Ben trusts Cloak for that moment: the bridge wallet holds his GLOAK between the two steps)");
        supplyBefore = gloak.totalSupply();
        uint256 cyBefore = gloak.balanceOf(cy);
        _unshield(_noteOf(cy), 5_000e18, cy);
        uint256 got = gloak.balanceOf(cy) - cyBefore;
        vm.startPrank(cy);
        gloak.approve(address(otherVault), got);
        otherVault.shieldBound(address(gloak), got, _commitment(), hex"00");
        vm.stopPrank();
        console.log("   Cy moves a 5,000 note on her own, through her own wallet: pays", _f(supplyBefore - gloak.totalSupply()), "and lands", _f(got));
        _meter("final");

        console.log("9. Totals: supply", _f(gloak.totalSupply()), "| burned by surcharges", _f(gloak.surchargeBurned()));
        console.log("   at 0xdEaD", _f(gloak.balanceOf(DEAD)));
    }

    // ───────────── helpers ─────────────

    function universalBuy(V4Key memory key) external payable {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, true, uint128(msg.value), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, msg.value);
        params[2] = abi.encode(key.currency1, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), params);
        IUniversalRouterS(UNIVERSAL_ROUTER).execute{value: msg.value}(abi.encodePacked(uint8(0x10)), inputs, type(uint256).max);
    }

    function _params() internal view returns (CloakAuction.Params memory) {
        return CloakAuction.Params({
            creator: treasury,
            saleSupply: SALE,
            lpReserve: LP_RESERVE,
            minPrice: MIN_PRICE,
            tickSize: 1e12,
            numTicks: 50,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: 5_000,
            noRevealPenaltyBps: 2_000,
            lpLockUntil: type(uint64).max,
            tlockRound: 0,
            minRaise: 0
        });
    }

    bytes32 _lastNote;
    bytes32 _lastSwapNote;
    mapping(address => bytes32) _notes;

    function _commitment() internal returns (bytes32 c) {
        c = keccak256(abi.encode("note", ++nonce));
        _lastNote = c;
    }

    function _note() internal view returns (bytes32) {
        return _lastNote;
    }

    function _noteOf(address) internal returns (bytes32) {
        return keccak256(abi.encode("spend", ++nonce)); // stand-in proofs: any unspent nullifier
    }

    function _shieldHype(uint256 amount) internal returns (bytes32 n) {
        lv.shieldBound{value: amount}(address(0), amount, _commitment(), hex"00");
        n = keccak256(abi.encode("hype note", nonce));
    }

    function _privateBid(uint256 pk, uint256 hype, uint128 qty) internal returns (PrivateBid memory b) {
        bytes32 nullifier = keccak256(abi.encode("bid note", pk));
        lv.shieldBound{value: hype}(address(0), hype, _commitment(), hex"00"); // the bidder's private HYPE, from earlier
        b.k = CloakGloamBids.BidKey(nullifier, hype, address(auction), vm.addr(pk), vm.addr(pk), block.timestamp + 30 days);
        b.account = bids.accountFor(b.k);
        b.qty = qty;
        b.salt = keccak256(abi.encode("salt", pk));
        bytes memory bidCall = abi.encodeCall(CloakAuction.commit, (auction.commitmentOf(b.account, 0, qty, b.salt), bytes("")));
        CloakGloamBids.Spend memory s = CloakGloamBids.Spend(abi.encode(b.account), lv.currentRoot(), nullifier, address(0), hype);
        b.id = bids.place(s, b.k, bidCall, _sign(pk, bids.placeDigest(b.account, bidCall)));
    }

    function _finishPrivate(PrivateBid memory b, uint256 pk, uint256 tokens) internal returns (bytes32 spendable) {
        CloakGloamBids.Deposit[] memory ds = new CloakGloamBids.Deposit[](1);
        ds[0] = CloakGloamBids.Deposit(hex"00", _commitment(), address(gloak), tokens);
        bids.finish(b.k, ds, _sign(pk, bids.finishDigest(b.account, ds)));
        spendable = keccak256(abi.encode("spend of", ds[0].commitment));
    }

    function _swap(uint256 pk, bytes32 nullifier, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut)
        internal
        returns (bytes32 id, uint256 left)
    {
        V4Key memory v = hook.keyFor(address(gloak));
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = PoolKey(Currency.unwrap(v.currency0), Currency.unwrap(v.currency1), v.fee, v.tickSpacing, address(v.hooks));
        bytes memory route = abi.encode(hops);
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), nullifier, assetIn, amountIn);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", _commitment(), assetOut, amountOut);
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, route, vm.addr(pk), deadline)));
        (id, left) = router.swap(s, d, route, vm.addr(pk), deadline);
        _lastSwapNote = keccak256(abi.encode("spend of", d.commitment));
    }

    function _unshield(bytes32 nullifier, uint256 amount, address to) internal {
        lv.unshield(abi.encode(to), lv.currentRoot(), nullifier, address(gloak), to, amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _meter(string memory when) internal view {
        (uint256 v, uint256 p, uint256 c, uint256 d, uint256 pub, uint256 bps) = gloak.meter();
        console.log(string.concat("   [meter, ", when, "] vaults ", _f(v), " | pool ", _f(p), " | other contracts ", _f(c)));
        console.log(string.concat("                       0xdEaD ", _f(d), " | public ", _f(pub), " | private share ", _pct(bps)));
    }

    /// 18-decimal amount with 8 decimals (prices).
    function _f8(uint256 x) internal pure returns (string memory) {
        uint256 frac = (x % 1e18) / 1e10;
        string memory digits = vm.toString(frac + 1e8); // "1" + 8 digits, zero-padded
        bytes memory b = bytes(digits);
        bytes memory out = new bytes(8);
        for (uint256 i; i < 8; ++i) out[i] = b[i + 1];
        return string.concat(vm.toString(x / 1e18), ".", string(out));
    }

    /// 18-decimal amount with 4 decimals.
    function _f(uint256 x) internal pure returns (string memory) {
        uint256 frac = (x % 1e18) / 1e14;
        string memory pad = frac < 10 ? "000" : frac < 100 ? "00" : frac < 1000 ? "0" : "";
        return string.concat(vm.toString(x / 1e18), ".", pad, vm.toString(frac));
    }

    function _pct(uint256 bps) internal pure returns (string memory) {
        uint256 frac = bps % 100;
        return string.concat(vm.toString(bps / 100), ".", frac < 10 ? "0" : "", vm.toString(frac), "%");
    }

    function _deployHook() internal returns (CloakV4Hook h) {
        bytes memory init = abi.encodePacked(type(CloakV4Hook).creationCode, abi.encode(address(pm), address(this), uint24(3_000), uint24(100_000), uint32(300)));
        bytes32 ih = keccak256(init);
        for (uint256 s; s < 500_000; ++s) {
            address a = vm.computeCreate2Address(bytes32(s), ih, address(this));
            if (uint160(a) & ((1 << 14) - 1) == FLAGS) {
                return new CloakV4Hook{salt: bytes32(s)}(pm, address(this), 3_000, 100_000, 300);
            }
        }
        revert("no salt");
    }

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    receive() external payable {}
}
