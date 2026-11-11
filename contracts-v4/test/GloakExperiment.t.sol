// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, stdJson} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey as V4Key} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakConfig} from "cloak/CloakConfig.sol";
import {CloakFactory} from "cloak/CloakFactory.sol";
import {CloakAuction, IMarketSeeder, IFeeLocker} from "cloak/CloakAuction.sol";
import {CloakToken} from "cloak/CloakToken.sol";
import {CloakVestingDeployer} from "cloak/CloakVesting.sol";
import {CloakLaunchVault} from "cloak-gloam/CloakLaunchVault.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakLaunchSwapV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {CloakV4Hook, ICloakLaunchFactory} from "../src/CloakV4Hook.sol";
import {CloakV4Market} from "../src/CloakV4Market.sol";
import {GloakToken, GloakMaker} from "../src/experiment/GloakToken.sol";
import {YesV, ToV, WHYPE} from "./CloakLaunchSwapV4.t.sol";

interface IUniversalRouterG {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// Trades on the PoolManager directly, as the Universal Router or any contract can: a plain swap that takes the output,
/// a swap that keeps the output as v4 claims (ERC-6909), and paying tokens in to mint claims without a swap.
contract Outsider is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function buy(V4Key memory key, uint256 hype, bool asClaims) external payable returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(uint8(0), key, hype, asClaims)), (uint256));
    }

    function payInForClaims(V4Key memory key, uint256 amount) external {
        pm.unlock(abi.encode(uint8(1), key, amount, true));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 what, V4Key memory key, uint256 amount, bool asClaims) = abi.decode(data, (uint8, V4Key, uint256, bool));
        address token = Currency.unwrap(key.currency1);
        if (what == 1) {
            pm.sync(key.currency1);
            GloakToken(token).transfer(address(pm), amount);
            pm.settle();
            pm.mint(address(this), uint256(uint160(token)), amount);
            return "";
        }
        BalanceDelta d = pm.swap(key, SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "");
        pm.settle{value: uint256(uint128(-d.amount0()))}();
        uint256 out = uint256(uint128(d.amount1()));
        if (asClaims) pm.mint(address(this), uint256(uint160(token)), out);
        else pm.take(key.currency1, address(this), out);
        return abi.encode(out);
    }

    receive() external payable {}
}

/**
 * The GLOAK experiment end to end: the one-time door makes GLOAK's launch, Cloak's hook makes its pool private-only, and
 * GLOAK trades privately through Cloak's router and the launch vault while every way out to a public address pays the
 * surcharge. A plain launch on the same hook and factory is checked to be untouched.
 *
 * Runs on a local PoolManager (Uniswap's v4-core, built byte-identical to mainnet's). With MAINNET_RPC set it runs on a
 * fork of Elysium mainnet instead, on Uniswap's real PoolManager:
 *   MAINNET_RPC=https://rpc-live.elysp.com forge test --match-contract GloakExperiment -vv
 */
contract GloakExperimentTest is Test {
    using stdJson for string;

    IPoolManager constant MAINNET_PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    uint160 constant FLAGS = (1 << 13) | (1 << 11) | (1 << 9) | (1 << 7);
    uint256 constant SALE = 1_000_000e18;

    IPoolManager pm;
    bool forked;
    CloakConfig config;
    CloakV4Hook hook;
    CloakVestingDeployer deployer;
    CloakFactory factory;
    GloakMaker maker;
    CloakAuction auction;
    GloakToken gloak;
    CloakV4Market market;
    CloakLaunchVault lv;
    CloakLaunchSwapV4 router;
    WHYPE whype;

    address admin = makeAddr("owner wallet");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 ownerPk = 0x0A11CE;
    address owner = vm.addr(ownerPk); // the router's owner key for claims and exits

    // GloakToken's roles
    uint8 constant RECEIVE = 1;
    uint8 constant SEND = 2;
    uint8 constant FEED = 4;
    uint8 constant SWAP = 8;
    uint8 constant VAULT = 16;
    uint8 constant PAYEE = 32;

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
        config.setFees(0, 150, treasury);
        hook = _deployHook();
        deployer = new CloakVestingDeployer(admin);
        factory = new CloakFactory(config, deployer, IMarketSeeder(address(hook)), IFeeLocker(address(0)));
        hook.setFactory(ICloakLaunchFactory(address(factory)));
        maker = new GloakMaker(address(deployer), admin, address(pm), address(hook), new address[](0), new uint8[](0));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _deployHook() internal returns (CloakV4Hook h) {
        bytes memory init = abi.encodePacked(type(CloakV4Hook).creationCode, abi.encode(address(pm), address(this), uint24(3_000), uint24(100_000), uint32(300)));
        bytes32 ih = keccak256(init);
        for (uint256 s; s < 500_000; ++s) {
            address a = vm.computeCreate2Address(bytes32(s), ih, address(this));
            if (uint160(a) & ((1 << 14) - 1) == FLAGS) {
                h = new CloakV4Hook{salt: bytes32(s)}(pm, address(this), 3_000, 100_000, 300);
                require(address(h) == a, "create2");
                return h;
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

    function _params() internal view returns (CloakAuction.Params memory) {
        return CloakAuction.Params({
            creator: treasury, // Cloak is the creator: the pool's fees fund GLOAK buybacks
            saleSupply: SALE,
            lpReserve: SALE,
            minPrice: 0.0001 ether,
            tickSize: 0.0001 ether,
            numTicks: 100,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: 5_000,
            noRevealPenaltyBps: 2_000,
            lpLockUntil: type(uint64).max, // locked forever, fees to the creator
            tlockRound: 0,
            minRaise: 0
        });
    }

    /// The owner wallet opens GLOAK's launch through the one-time door: no team share.
    function _doorLaunch() internal {
        bytes memory call_ = abi.encodeCall(CloakFactory.createLaunch, ("GLOAK", "GLOAK", 0, 0, _params(), ""));
        vm.prank(admin);
        deployer.useDoor(address(maker), address(factory), call_);
        (address a, address t,,,,) = factory.launches(factory.launchesCount() - 1);
        auction = CloakAuction(payable(a));
        gloak = GloakToken(t);
    }

    function _commit(CloakAuction a, address bidder) internal returns (uint256 id) {
        bytes32 h = a.commitmentOf(bidder, 19, uint128(SALE), keccak256("s"));
        vm.prank(bidder);
        id = a.commit{value: 3_000 ether}(h, "");
    }

    /// Reveal, settle and claim a committed bid (the bidder takes the whole sale at tick 19).
    function _settle(CloakAuction a, uint256 id) internal {
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,,) = a.params();
        if (block.timestamp < commitEnd) vm.warp(commitEnd);
        a.reveal(id, 19, uint128(SALE), keccak256("s"));
        if (block.timestamp < revealEnd) vm.warp(revealEnd);
        a.settle();
        a.claim(id);
    }

    function _bidAndSettle(CloakAuction a, address bidder) internal {
        _settle(a, _commit(a, bidder));
    }

    /// GLOAK launched and settled, the launch vault and router live and on GLOAK's list, alice's GLOAK shielded.
    function _live() internal {
        _doorLaunch();
        _bidAndSettle(auction, alice);
        market = CloakV4Market(payable(address(auction.pair())));
        vm.warp(block.timestamp + 600); // past the anti-snipe window

        whype = new WHYPE();
        lv = new CloakLaunchVault(_poseidon(), address(new ToV()), address(factory), 1e30, 1e32, address(0));
        lv.setShieldVerifier(address(new YesV()));
        lv.turnOnDepositLimits();
        lv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        lv.endSetup();
        lv.admitLaunch(factory.launchesCount() - 1);
        router = new CloakLaunchSwapV4(address(lv), address(pm), address(whype), address(hook));

        vm.startPrank(admin);
        gloak.setRoles(address(lv), RECEIVE | VAULT);
        gloak.setRoles(address(router), RECEIVE | FEED | SWAP | PAYEE);
        vm.stopPrank();

        // HYPE notes for buys, and alice shields all her GLOAK (free)
        for (uint256 i = 0; i < 5; i++) lv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(0xE0 + i), hex"00");
        uint256 bal = gloak.balanceOf(alice);
        vm.startPrank(alice);
        gloak.approve(address(lv), bal);
        lv.shieldBound(address(gloak), bal, bytes32(uint256(0x70)), hex"00");
        vm.stopPrank();
    }

    function _key() internal view returns (PoolKey memory k) {
        V4Key memory v = hook.keyFor(address(gloak));
        k = PoolKey(Currency.unwrap(v.currency0), Currency.unwrap(v.currency1), v.fee, v.tickSpacing, address(v.hooks));
    }

    function _route() internal view returns (bytes memory) {
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = _key();
        return abi.encode(hops);
    }

    function _swap(bytes32 n, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut)
        internal
        returns (bytes32 id, uint256 left)
    {
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), n, assetIn, amountIn);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, _route(), owner, deadline)));
        return router.swap(s, d, _route(), owner, deadline);
    }

    function _unshield(bytes32 n, uint256 amount, address to) internal {
        lv.unshield(abi.encode(to), lv.currentRoot(), n, address(gloak), to, amount);
    }

    // ───────────── the door ─────────────

    function test_doorMakesGloaksLaunch() public {
        _doorLaunch();
        assertEq(deployer.doorToken(), address(gloak), "the door recorded its one token");
        assertTrue(deployer.doorUsed(), "and is closed");
        assertEq(gloak.totalSupply(), 2 * SALE, "the whole supply sits with the auction: no team share");
        assertEq(gloak.balanceOf(address(auction)), 2 * SALE);
        assertEq(gloak.admin(), admin);
        assertEq(address(auction.token()), address(gloak));
    }

    function test_doorIsOneTimeAndOwnerOnly() public {
        bytes memory call_ = abi.encodeCall(CloakFactory.createLaunch, ("GLOAK", "GLOAK", 0, 0, _params(), ""));
        vm.expectRevert(bytes("door admin"));
        deployer.useDoor(address(maker), address(factory), call_);
        _doorLaunch();
        vm.prank(admin);
        vm.expectRevert(bytes("door used"));
        deployer.useDoor(address(maker), address(factory), call_);
    }

    function test_doorRevertsWholeIfItsLaunchFails() public {
        CloakAuction.Params memory p = _params();
        p.saleSupply = 0; // the factory refuses this launch
        bytes memory call_ = abi.encodeCall(CloakFactory.createLaunch, ("GLOAK", "GLOAK", 0, 0, p, ""));
        vm.prank(admin);
        vm.expectRevert();
        deployer.useDoor(address(maker), address(factory), call_);
        assertFalse(deployer.doorUsed(), "a failed attempt leaves the door unused");
    }

    function test_onlyTheDoorCanMakeAGloak() public {
        vm.expectRevert(bytes("door only"));
        maker.make("X", "X", new address[](0), new uint256[](0));
    }

    // ───────────── every other launch is untouched ─────────────

    function test_plainLaunchesStayPlainAndOpen() public {
        _doorLaunch();
        (address a, address t) = factory.createLaunch("Plain", "PLAIN", 0, 0, _params(), "");
        assertEq(CloakToken(t).totalSupply(), 2 * SALE, "a launch after the door gets a plain CloakToken");
        CloakAuction plain = CloakAuction(payable(a));
        uint256 plainBid = _commit(plain, bob);
        uint256 gloakBid = _commit(auction, alice);
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,,) = plain.params();
        vm.warp(commitEnd);
        plain.reveal(plainBid, 19, uint128(SALE), keccak256("s"));
        auction.reveal(gloakBid, 19, uint128(SALE), keccak256("s"));
        vm.warp(revealEnd);
        plain.settle();
        auction.settle();
        assertEq(PoolId.unwrap(hook.privatePool()), PoolId.unwrap(hook.poolIdOf(address(gloak))), "only GLOAK's pool is private");
        assertTrue(PoolId.unwrap(hook.poolIdOf(t)) != PoolId.unwrap(hook.privatePool()));
        vm.warp(block.timestamp + 600);
        Outsider o = new Outsider(pm);
        vm.deal(address(o), 10 ether);
        V4Key memory plainKey = hook.keyFor(t);
        uint256 out = o.buy(plainKey, 1 ether, false);
        assertGt(out, 0, "anyone still trades a plain launch's pool directly");
        assertEq(CloakToken(t).balanceOf(address(o)), out);
    }

    function test_launchesWithoutADoorHaveNoPrivatePool() public {
        CloakVestingDeployer plainDeployer = new CloakVestingDeployer(address(0));
        vm.expectRevert(bytes("door admin"));
        plainDeployer.useDoor(address(maker), address(factory), "");
        (address a,) = factory.createLaunch("Plain", "PLAIN", 0, 0, _params(), "");
        _bidAndSettle(CloakAuction(payable(a)), bob);
        assertEq(PoolId.unwrap(hook.privatePool()), bytes32(0), "no door used: no private pool");
    }

    // ───────────── the private pool ─────────────

    function test_outsidersCantSwapGloaksPool() public {
        _live();
        Outsider o = new Outsider(pm);
        vm.deal(address(o), 10 ether);
        V4Key memory key = hook.keyFor(address(gloak));
        vm.expectRevert();
        o.buy(key, 1 ether, false);
        vm.expectRevert();
        o.buy(key, 1 ether, true); // and so can't take v4 claims out of it either
    }

    function test_publicAddressesCantPayIntoThePoolManager() public {
        _live();
        _unshield(bytes32(uint256(0x70)), 1_000e18, bob);
        vm.prank(bob);
        vm.expectRevert(GloakToken.NotPrivate.selector);
        gloak.transfer(address(pm), 1e18);
        Outsider o = new Outsider(pm);
        vm.prank(bob);
        gloak.transfer(address(o), 100e18);
        V4Key memory key = hook.keyFor(address(gloak));
        vm.expectRevert();
        o.payInForClaims(key, 50e18); // no claims minted from public GLOAK
        vm.prank(bob);
        gloak.approve(address(market), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert();
        market.swapExactTokensForHype(100e18, 1, bob); // nor a public sell through the market adapter
    }

    // ───────────── private trading is free ─────────────

    function test_privateBuyIsExactAndFree() public {
        _live();
        uint256 supply = gloak.totalSupply();
        uint256 before = lv.deposited(address(gloak));
        _swap(bytes32(uint256(1)), address(0), 1 ether, address(gloak), 300e18);
        assertEq(lv.deposited(address(gloak)) - before, 300e18, "exactly 300 GLOAK lands as a note");
        assertEq(gloak.totalSupply(), supply, "nothing burned");
        assertEq(gloak.surchargeBurned(), 0);
    }

    function test_privateSellIsExactAndFree() public {
        _live();
        uint256 supply = gloak.totalSupply();
        uint256 noteSize = lv.deposited(address(gloak));
        uint256 before = lv.deposited(address(0));
        (bytes32 id, uint256 left) = _swap(bytes32(uint256(0x70)), address(gloak), noteSize, address(0), 1 ether);
        assertEq(lv.deposited(address(0)) - before, 1 ether, "exactly 1 HYPE lands as a note");
        (address asset,, uint256 amount) = router.owed(id);
        assertEq(asset, address(gloak));
        assertEq(amount, left, "the unspent GLOAK is owed back in full");
        assertEq(gloak.totalSupply(), supply, "the escrow's surcharge came back: nothing burned");
        assertEq(gloak.surchargeBurned(), 0);
    }

    function test_leftoverClaimedBackIntoTheVaultIsFree() public {
        _live();
        uint256 noteSize = lv.deposited(address(gloak));
        (bytes32 id, uint256 left) = _swap(bytes32(uint256(0x70)), address(gloak), noteSize, address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xC1)), address(gloak), left);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, router.claimDigest(id, d.commitment));
        router.claim(id, d, abi.encodePacked(r, s, v));
        assertEq(lv.deposited(address(gloak)), left, "the leftover is a note again, in full");
    }

    // ───────────── leaving costs 10% ─────────────

    function test_withdrawalToAPublicAddressBurns10Percent() public {
        _live();
        uint256 supply = gloak.totalSupply();
        _unshield(bytes32(uint256(0x70)), 1_000e18, bob);
        assertEq(gloak.balanceOf(bob), 900e18, "bob gets 90%");
        assertEq(gloak.totalSupply(), supply - 100e18, "10% is burned");
        assertEq(gloak.surchargeBurned(), 100e18);
    }

    function test_exitFromTheRouterBurns10Percent() public {
        _live();
        uint256 noteSize = lv.deposited(address(gloak));
        (bytes32 id, uint256 left) = _swap(bytes32(uint256(0x70)), address(gloak), noteSize, address(0), 1 ether);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, router.exitDigest(id, bob));
        router.exit(id, bob, abi.encodePacked(r, s, v));
        assertEq(gloak.balanceOf(bob), left - left / 10, "a leftover taken out in public pays the surcharge too");
    }

    function test_publicToPublicBurns10PercentAndShieldingBackIsFree() public {
        _live();
        _unshield(bytes32(uint256(0x70)), 1_000e18, bob);
        vm.prank(bob);
        gloak.transfer(alice, 500e18);
        assertEq(gloak.balanceOf(alice), 450e18, "public to public: 10% burned");
        uint256 before = lv.deposited(address(gloak));
        vm.startPrank(alice);
        gloak.approve(address(lv), 450e18);
        lv.shieldBound(address(gloak), 450e18, bytes32(uint256(0x71)), hex"00");
        vm.stopPrank();
        assertEq(lv.deposited(address(gloak)) - before, 450e18, "coming back in is free and exact");
    }

    /// forge-config: default.isolate = true
    function test_aSpendSentAloneLosesTheSurchargeButIsRescued() public {
        _live();
        uint256 noteSize = lv.deposited(address(gloak));
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), bytes32(uint256(0x70)), address(gloak), noteSize);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", keccak256("out"), address(0), 1 ether);
        uint256 deadline = block.timestamp + 600;
        CloakLaunchSwapBase.SwapKey memory k = router.keyOf(s, d, _route(), owner, deadline);
        address escrow = router.escrowFor(k);
        // someone sends the spend alone, in its own transaction: the escrow isn't opened in it
        lv.unshield(abi.encode(escrow), s.root, s.nullifier, address(gloak), escrow, noteSize);
        assertEq(gloak.balanceOf(escrow), noteSize - noteSize / 10, "the refund only works inside one transaction");
        vm.warp(deadline + 1);
        uint256 got = router.rescue(k);
        assertEq(got, noteSize - noteSize / 10, "nothing is stuck: 90% is owed back to the owner key");
    }

    // ───────────── the market adapter (batch rounds) ─────────────

    function test_marketAdapterBuysOnceApprovedAndPublicBuysPay10Percent() public {
        _live();
        vm.prank(bob);
        vm.expectRevert();
        market.swapExactHypeForTokens{value: 1 ether}(1, bob);
        vm.prank(admin);
        gloak.setRoles(address(market), SWAP);
        (uint256 rH, uint256 rT,) = market.reserves();
        uint256 q = market.getAmountOut(1 ether, rH, rT);
        vm.prank(bob);
        market.swapExactHypeForTokens{value: 1 ether}(1, bob);
        assertApproxEqAbs(gloak.balanceOf(bob), q - q / 10, 1e15, "a public buy through the adapter arrives less 10%");
    }

    // ───────────── the rules' owner ─────────────

    function test_rolesWaitThreeDaysAfterSetupAndRemovalIsInstant() public {
        _live();
        address other = makeAddr("another protocol's vault");
        vm.startPrank(admin);
        gloak.endSetup();
        vm.expectRevert(GloakToken.TimelockRequired.selector);
        gloak.setRoles(other, RECEIVE | VAULT);
        gloak.queueRoles(other, RECEIVE | VAULT);
        vm.expectRevert(GloakToken.TooEarly.selector);
        gloak.applyRoles(other, RECEIVE | VAULT);
        vm.warp(block.timestamp + 3 days);
        gloak.applyRoles(other, RECEIVE | VAULT);
        assertEq(gloak.rolesOf(other), RECEIVE | VAULT);
        gloak.setRoles(other, 0); // removing is instant
        assertEq(gloak.rolesOf(other), 0);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(GloakToken.NotAdmin.selector);
        gloak.setRoles(bob, SEND);
    }

    function test_surchargeOnlyFalls() public {
        _doorLaunch();
        vm.startPrank(admin);
        vm.expectRevert(GloakToken.BadSurcharge.selector);
        gloak.lowerSurcharge(1_000);
        gloak.lowerSurcharge(500);
        assertEq(gloak.surchargeBps(), 500);
        vm.expectRevert(GloakToken.BadSurcharge.selector);
        gloak.lowerSurcharge(600);
        gloak.renounceAdmin();
        vm.expectRevert(GloakToken.NotAdmin.selector);
        gloak.lowerSurcharge(0);
        vm.stopPrank();
    }

    function test_privacyMeter() public {
        _live();
        (uint256 inVaults, uint256 inPool, uint256 inContracts, uint256 atDead, uint256 inPublic, uint256 privateBps) = gloak.meter();
        assertEq(inVaults, lv.deposited(address(gloak)), "the vault holds alice's GLOAK");
        assertGt(inPool, 0, "the pool holds its reserve");
        assertEq(inVaults + inPool + inContracts + atDead + inPublic, gloak.totalSupply());
        assertEq(inPublic, 0, "nothing is in public yet");
        _unshield(bytes32(uint256(0x70)), 1_000e18, bob);
        (,,,, uint256 pub2, uint256 bps2) = gloak.meter();
        assertEq(pub2, 900e18, "bob's withdrawal shows as public");
        assertLt(bps2, privateBps);
    }

    function test_forkUsesUniswapsRealPoolManager() public view {
        if (!forked) return;
        assertEq(address(hook.poolManager()), address(MAINNET_PM));
    }

    struct ExactInputSingleParams {
        V4Key poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// Buy with HYPE through Uniswap's real Universal Router on mainnet (what wallets and aggregators use).
    function _universalBuy(V4Key memory key, uint128 amountIn) internal {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, true, amountIn, 0, ""));
        params[1] = abi.encode(key.currency0, uint256(amountIn));
        params[2] = abi.encode(key.currency1, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL inside one V4_SWAP command
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), params);
        IUniversalRouterG(0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a).execute{value: amountIn}(abi.encodePacked(uint8(0x10)), inputs, type(uint256).max);
    }

    function test_forkUniswapsUniversalRouterCantTradeGloakButTradesPlainLaunches() public {
        if (!forked) return;
        _doorLaunch();
        (address a, address t) = factory.createLaunch("Plain", "PLAIN", 0, 0, _params(), "");
        CloakAuction plain = CloakAuction(payable(a));
        uint256 plainBid = _commit(plain, bob);
        uint256 gloakBid = _commit(auction, alice);
        (,,,,,, uint64 commitEnd, uint64 revealEnd,,,,,) = plain.params();
        vm.warp(commitEnd);
        plain.reveal(plainBid, 19, uint128(SALE), keccak256("s"));
        auction.reveal(gloakBid, 19, uint128(SALE), keccak256("s"));
        vm.warp(revealEnd + 600);
        plain.settle();
        auction.settle();
        V4Key memory gk = hook.keyFor(address(gloak));
        V4Key memory pk = hook.keyFor(t);
        vm.startPrank(bob);
        vm.expectRevert();
        _universalBuy(gk, 1 ether);
        _universalBuy(pk, 1 ether);
        vm.stopPrank();
        assertGt(CloakToken(t).balanceOf(bob), 0, "the Universal Router still buys a plain launch");
        assertEq(gloak.balanceOf(bob), 0, "but not GLOAK");
    }

    // ───────────── what the admin may grant ─────────────

    function test_adminCanNeverGrantTaxFreeSending() public {
        _live();
        address wallet = makeAddr("some wallet");
        vm.startPrank(admin);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.setRoles(wallet, SEND); // not even in setup
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.setRoles(address(lv), RECEIVE | VAULT | SEND);
        gloak.endSetup();
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.queueRoles(wallet, RECEIVE | SEND);
        vm.stopPrank();
    }

    function test_uniswapAccessOnlyForContracts() public {
        _live();
        address wallet = makeAddr("some wallet");
        vm.startPrank(admin);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.setRoles(wallet, FEED);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.setRoles(wallet, SWAP);
        gloak.endSetup();
        gloak.queueRoles(wallet, RECEIVE | FEED); // queueing is allowed, applying checks the code
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        gloak.applyRoles(wallet, RECEIVE | FEED);
        vm.stopPrank();
    }

    /// A public address approved to receive (3 days in public) carries GLOAK from one vault to another for free. Whatever
    /// it sends anywhere else still pays, so it isn't a way out.
    function test_anApprovedAddressMovesGloakBetweenVaultsForFree() public {
        _live();
        CloakLaunchVault other = new CloakLaunchVault(_poseidon(), address(new ToV()), address(factory), 1e30, 1e32, address(0));
        other.setShieldVerifier(address(new YesV()));
        other.turnOnDepositLimits();
        other.endSetup();
        other.admitLaunch(factory.launchesCount() - 1);
        address bridge = makeAddr("bridge wallet");
        vm.startPrank(admin);
        gloak.endSetup();
        gloak.queueRoles(address(other), RECEIVE | VAULT);
        gloak.queueRoles(bridge, RECEIVE);
        vm.warp(block.timestamp + 3 days);
        gloak.applyRoles(address(other), RECEIVE | VAULT);
        gloak.applyRoles(bridge, RECEIVE);
        vm.stopPrank();

        uint256 supply = gloak.totalSupply();
        _unshield(bytes32(uint256(0x70)), 1_000e18, bridge);
        assertEq(gloak.balanceOf(bridge), 1_000e18, "out of the first vault to the approved address: free");
        vm.startPrank(bridge);
        gloak.approve(address(other), 900e18);
        other.shieldBound(address(gloak), 900e18, bytes32(uint256(0xB1)), hex"00");
        assertEq(other.deposited(address(gloak)), 900e18, "into the second vault: free and exact");
        gloak.transfer(bob, 100e18);
        vm.stopPrank();
        assertEq(gloak.balanceOf(bob), 90e18, "but anything it sends to a public address pays 10%");
        assertEq(gloak.totalSupply(), supply - 10e18);
    }

    // ───────────── born with its private zone ─────────────

    function _makerWith(address[] memory zone, uint8[] memory roles) internal returns (GloakMaker m) {
        m = new GloakMaker(address(deployer), admin, address(pm), address(hook), zone, roles);
    }

    function test_gloakIsBornWithItsPrivateZone() public {
        address vaultLike = address(new YesV());
        address routerLike = address(new YesV());
        address[] memory zone = new address[](2);
        uint8[] memory roles = new uint8[](2);
        (zone[0], roles[0]) = (vaultLike, RECEIVE | VAULT);
        (zone[1], roles[1]) = (routerLike, RECEIVE | FEED | SWAP | PAYEE);
        maker = _makerWith(zone, roles);
        _doorLaunch();
        assertEq(gloak.rolesOf(vaultLike), RECEIVE | VAULT, "approved from its first block");
        assertEq(gloak.rolesOf(routerLike), RECEIVE | FEED | SWAP | PAYEE);
        assertEq(gloak.rolesOf(address(auction)), RECEIVE | SEND, "the auction keeps its own roles");
    }

    function test_theZoneFollowsTheSameLimits() public {
        address[] memory zone = new address[](1);
        uint8[] memory roles = new uint8[](1);
        (zone[0], roles[0]) = (makeAddr("a wallet"), RECEIVE | SEND);
        maker = _makerWith(zone, roles);
        bytes memory call_ = abi.encodeCall(CloakFactory.createLaunch, ("GLOAK", "GLOAK", 0, 0, _params(), ""));
        vm.prank(admin);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        deployer.useDoor(address(maker), address(factory), call_);
        (zone[0], roles[0]) = (makeAddr("a wallet"), FEED);
        maker = _makerWith(zone, roles);
        vm.prank(admin);
        vm.expectRevert(GloakToken.RoleNotGrantable.selector);
        deployer.useDoor(address(maker), address(factory), call_);
        assertFalse(deployer.doorUsed(), "a refused zone leaves the door unused");
    }
}
