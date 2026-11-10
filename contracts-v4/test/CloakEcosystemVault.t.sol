// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey as V4Key} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakEcosystemVault} from "cloak-gloam/CloakEcosystemVault.sol";
import {CloakLaunchpadCheck} from "cloak-gloam/CloakLaunchpadCheck.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakRouterV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {TestToken} from "cloak-gloam/TestToken.sol";
import {CloakLaunchSwapV4Test, ToV, YesV} from "./CloakLaunchSwapV4.t.sol";

/// Opens a plain HYPE / token v4 pool (no hook) and adds or removes full-range liquidity, paying both sides.
contract PlainLp is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function open(V4Key memory key, uint160 sqrtPriceX96) external {
        pm.initialize(key, sqrtPriceX96);
    }

    function liquidity(V4Key memory key, int256 delta) external payable {
        pm.unlock(abi.encode(key, delta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (V4Key memory key, int256 delta) = abi.decode(data, (V4Key, int256));
        (BalanceDelta d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, delta, 0), "");
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
        else if (a0 > 0) pm.take(key.currency0, address(this), uint256(uint128(a0)));
        if (a1 < 0) {
            pm.sync(key.currency1);
            TestToken(Currency.unwrap(key.currency1)).transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        } else if (a1 > 0) {
            pm.take(key.currency1, address(this), uint256(uint128(a1)));
        }
        return "";
    }

    receive() external payable {}
}

/// A launchpad's own registry, as most keep one: tokenInfo(token) is the creator, or zero for a token it didn't make.
contract FakeLaunchpad {
    mapping(address => address) public tokenInfo;

    function made(address token) external {
        tokenInfo[token] = msg.sender;
    }
}

/**
 * CloakEcosystemVault: an outside token (KNTQ here) gets in only when the approver lists it, from a vetted launchpad
 * or vetted on its own, with a market Cloak can trade, enough liquidity and market cap, and capped deposits. Then
 * CloakRouterV4 buys it with HYPE from Gloam's vault into the ecosystem vault, and sells it back.
 */
contract CloakEcosystemVaultTest is CloakLaunchSwapV4Test {
    TestToken kntq;
    PlainLp lp;
    CloakEcosystemVault ev;
    ShieldPoolPayments gv;
    CloakRouterV4 rv;
    address constant PAUSER = address(0xFA05E);
    uint256 constant KNTQ_SUPPLY = 1_000_000e18;
    // 1 HYPE = 100 KNTQ, and 1,000e18 liquidity: 100 HYPE in range, a market cap of 10,000 HYPE
    uint160 constant SQRT_100 = uint160(10 << 96);
    int256 constant LIQ = 1_000e18;

    function _rules(uint256 minLiq, uint256 minMcap) internal pure returns (CloakEcosystemVault.Rules memory) {
        return CloakEcosystemVault.Rules({minHypeLiquidity: minLiq, minMcapHype: minMcap, maxPerDepositBps: 10, maxTotalBps: 200});
    }

    function _vault(CloakEcosystemVault.Rules memory r) internal returns (CloakEcosystemVault v) {
        v = new CloakEcosystemVault(_poseidon(), address(new ToV()), address(pm), address(lv), address(this), PAUSER, r);
        v.setShieldVerifier(address(new YesV()));
        v.setWithdrawFee(50, address(0xFEE));
        v.turnOnDepositLimits();
        v.endSetup();
    }

    function _v4Key() internal view returns (V4Key memory) {
        return V4Key(Currency.wrap(address(0)), Currency.wrap(address(kntq)), 3000, 60, IHooks(address(0)));
    }

    function _kntqKey() internal view returns (CloakEcosystemVault.PoolKey memory) {
        return CloakEcosystemVault.PoolKey(address(0), address(kntq), 3000, 60, address(0));
    }

    function _setUpEco() internal {
        _setUpVault();
        kntq = new TestToken("Kinetiq", "KNTQ", 18);
        kntq.mint(address(this), KNTQ_SUPPLY);
        lp = new PlainLp(pm);
        kntq.transfer(address(lp), 50_000e18);
        vm.deal(address(lp), 500 ether);
        lp.open(_v4Key(), SQRT_100);
        lp.liquidity(_v4Key(), LIQ);
        ev = _vault(_rules(50 ether, 5_000 ether));
    }

    function _list() internal {
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(0));
    }

    // ── the rules ──────────────────────────────────────────────────────

    function test_eco_marketReadsThePool() public {
        _setUpEco();
        (uint256 hype, uint256 mcap) = ev.marketOf(address(kntq), _kntqKey());
        assertApproxEqRel(hype, 100 ether, 1e15, "about 100 HYPE in range");
        assertApproxEqRel(mcap, 10_000 ether, 1e15, "a market cap of about 10,000 HYPE");
    }

    function test_eco_listedAtOnce() public {
        _setUpEco();
        _list();
        assertTrue(ev.isEcosystemToken(address(kntq)));
        assertEq(ev.launchpadOf(address(kntq)), address(0), "vetted on its own");
        (uint128 per, uint128 total) = ev.depositLimit(address(kntq));
        assertEq(per, 1_000e18);
        assertEq(total, 20_000e18);
        assertEq(ev.poolKeyOf(address(kntq)).currency1, address(kntq));
        assertEq(ev.ecosystemTokensCount(), 1);
        // and KNTQ notes can now be deposited, within the caps
        kntq.approve(address(ev), type(uint256).max);
        ev.shieldBound(address(kntq), 1_000e18, bytes32(uint256(0xC1)), hex"00");
        vm.expectRevert();
        ev.shieldBound(address(kntq), 1_001e18, bytes32(uint256(0xC2)), hex"00");
    }

    function test_eco_fromAVettedLaunchpad() public {
        _setUpEco();
        FakeLaunchpad pad = new FakeLaunchpad();
        CloakLaunchpadCheck check = new CloakLaunchpadCheck(address(pad), bytes4(keccak256("tokenInfo(address)")));
        // not approved yet
        vm.expectRevert(CloakEcosystemVault.NotFromLaunchpad.selector);
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(check));
        ev.approveLaunchpad(address(check), "Pad");
        assertTrue(ev.isApprovedLaunchpad(address(check)));
        // approved, but the launchpad didn't make this token
        vm.expectRevert(CloakEcosystemVault.NotFromLaunchpad.selector);
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(check));
        pad.made(address(kntq));
        assertTrue(check.isLaunchpadToken(address(kntq)));
        assertFalse(check.isLaunchpadToken(address(0xBEEF)));
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(check));
        assertTrue(ev.isEcosystemToken(address(kntq)));
        assertEq(ev.launchpadOf(address(kntq)), address(check));
    }

    function test_eco_launchpadRemovedStopsNewListings() public {
        _setUpEco();
        FakeLaunchpad pad = new FakeLaunchpad();
        CloakLaunchpadCheck check = new CloakLaunchpadCheck(address(pad), bytes4(keccak256("tokenInfo(address)")));
        ev.approveLaunchpad(address(check), "Pad");
        pad.made(address(kntq));
        vm.prank(PAUSER);
        ev.removeLaunchpad(address(check));
        vm.expectRevert(CloakEcosystemVault.NotFromLaunchpad.selector);
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(check));
        vm.prank(address(0xBAD));
        vm.expectRevert(CloakEcosystemVault.NotPauser.selector);
        ev.removeLaunchpad(address(check));
        vm.prank(address(0xBAD));
        vm.expectRevert(CloakEcosystemVault.NotApprover.selector);
        ev.approveLaunchpad(address(check), "Pad");
    }

    function test_eco_onlyTheApproverLists() public {
        _setUpEco();
        vm.prank(address(0xBAD));
        vm.expectRevert(CloakEcosystemVault.NotApprover.selector);
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(0));
    }

    function test_eco_thinLiquidityRefused() public {
        _setUpEco();
        CloakEcosystemVault strict = _vault(_rules(500 ether, 5_000 ether));
        vm.expectRevert();
        strict.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(0));
    }

    function test_eco_smallMcapRefused() public {
        _setUpEco();
        CloakEcosystemVault strict = _vault(_rules(50 ether, 50_000 ether));
        vm.expectRevert();
        strict.list(address(kntq), _kntqKey(), 1_000e18, 20_000e18, address(0));
    }

    function test_eco_onlyAPlainHypePool() public {
        _setUpEco();
        CloakEcosystemVault.PoolKey memory k = _kntqKey();
        k.hooks = address(hook);
        vm.expectRevert(CloakEcosystemVault.BadPool.selector);
        ev.list(address(kntq), k, 1_000e18, 20_000e18, address(0));
        k = _kntqKey();
        k.currency0 = address(whype);
        vm.expectRevert(CloakEcosystemVault.BadPool.selector);
        ev.list(address(kntq), k, 1_000e18, 20_000e18, address(0));
        k = _kntqKey();
        k.fee = 500; // a pool nobody opened
        vm.expectRevert();
        ev.list(address(kntq), k, 1_000e18, 20_000e18, address(0));
    }

    function test_eco_capsBoundedBySupply() public {
        _setUpEco();
        vm.expectRevert(CloakEcosystemVault.CapsTooHigh.selector);
        ev.list(address(kntq), _kntqKey(), 1_001e18, 20_000e18, address(0)); // over 0.1% per deposit
        vm.expectRevert(CloakEcosystemVault.CapsTooHigh.selector);
        ev.list(address(kntq), _kntqKey(), 1_000e18, 20_001e18, address(0)); // over 2% in total
        vm.expectRevert(CloakEcosystemVault.CapsTooHigh.selector);
        ev.list(address(kntq), _kntqKey(), 2e18, 1e18, address(0)); // per deposit over the total
    }

    function test_eco_launchTokensNeverComeHere() public {
        _setUpEco();
        vm.expectRevert(CloakEcosystemVault.BadToken.selector);
        ev.list(address(token), _kntqKey(), 1, 1, address(0));
    }

    function test_eco_pausedStopsListing() public {
        _setUpEco();
        vm.prank(PAUSER);
        ev.pauseAdmissions(true);
        vm.expectRevert(CloakEcosystemVault.AdmissionStopped.selector);
        _list();
        vm.prank(address(0xBAD));
        vm.expectRevert(CloakEcosystemVault.NotPauser.selector);
        ev.pauseAdmissions(false);
        vm.prank(PAUSER);
        ev.pauseAdmissions(false);
        _list();
        assertTrue(ev.isEcosystemToken(address(kntq)));
    }

    function test_eco_listedOnceAndNotTwice() public {
        _setUpEco();
        _list();
        vm.expectRevert(CloakEcosystemVault.AlreadyListed.selector);
        _list();
    }

    function test_eco_rulesAreChecked() public {
        _setUpEco();
        address p = _poseidon();
        address v = address(new ToV());
        vm.expectRevert(CloakEcosystemVault.BadRules.selector);
        new CloakEcosystemVault(p, v, address(pm), address(lv), address(this), PAUSER, _rules(0, 1));
        CloakEcosystemVault.Rules memory r = _rules(1, 1);
        r.maxPerDepositBps = 300; // per deposit over the total share
        vm.expectRevert(CloakEcosystemVault.BadRules.selector);
        new CloakEcosystemVault(p, v, address(pm), address(lv), address(this), PAUSER, r);
    }

    // ── trading it through the router ──────────────────────────────────

    function _setUpTrading() internal {
        _setUpEco();
        _list();
        owner = vm.addr(ownerPk);
        gv = new ShieldPoolPayments(_poseidon(), address(new ToV()));
        gv.setShieldVerifier(address(new YesV()));
        gv.setWithdrawFee(50, address(0x6A0A));
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        gv.endSetup();
        rv = new CloakRouterV4(address(lv), address(gv), address(ev), address(pm), address(whype), address(hook));
        gv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(uint256(0xA0)), hex"00");
        kntq.approve(address(ev), type(uint256).max);
        ev.shieldBound(address(kntq), 500e18, bytes32(uint256(0xC0)), hex"00");
    }

    function _kRoute() internal view returns (bytes memory) {
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = PoolKey(address(0), address(kntq), 3000, 60, address(0));
        return abi.encode(hops);
    }

    function _swapVia(bytes32 n, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut) internal returns (bytes32 id, uint256 left) {
        bytes memory route = _kRoute();
        uint256 deadline = block.timestamp + 600;
        address vin = address(rv.vaultFor(assetIn));
        bytes32 root = vin == address(gv) ? gv.currentRoot() : ev.currentRoot();
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", root, n, assetIn, amountIn);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        s.proof = abi.encode(rv.escrowFor(rv.keyOf(s, d, route, owner, deadline)));
        return rv.swap(s, d, route, owner, deadline);
    }

    function test_eco_routerKnowsEachAssetsVault() public {
        _setUpTrading();
        assertEq(address(rv.vaultFor(address(0))), address(gv), "HYPE: Gloam's vault");
        assertEq(address(rv.vaultFor(address(token))), address(lv), "a Cloak launch token: the launch vault");
        assertEq(address(rv.vaultFor(address(kntq))), address(ev), "KNTQ: the ecosystem vault");
        assertEq(address(rv.vaultFor(address(0xC0FFEE))), address(gv), "anything else: Gloam's vault");
    }

    function test_eco_buyKntqWithHypeFromGloamsVault() public {
        _setUpTrading();
        uint256 g0 = gv.deposited(address(0));
        uint256 k0 = ev.deposited(address(kntq));
        _swapVia(bytes32(uint256(0xA0)), address(0), 1 ether, address(kntq), 95e18);
        assertEq(g0 - gv.deposited(address(0)), 1 ether, "the HYPE note left Gloam's vault");
        assertEq(ev.deposited(address(kntq)) - k0, 95e18, "95 KNTQ landed as a note in the ecosystem vault");
    }

    function test_eco_sellKntqIntoGloamsVault() public {
        _setUpTrading();
        uint256 g0 = gv.deposited(address(0));
        uint256 fees0 = ev.feesOwed(address(kntq));
        _swapVia(bytes32(uint256(0xC0)), address(kntq), 500e18, address(0), 4.5 ether);
        assertEq(gv.deposited(address(0)) - g0, 4.5 ether, "4.5 HYPE landed as a note in Gloam's vault");
        assertEq(ev.feesOwed(address(kntq)) - fees0, 2.5e18, "the ecosystem vault kept its fee on the KNTQ spent");
    }

    function test_eco_routerExitsNeverIntoTheEcosystemVault() public {
        _setUpTrading();
        (bytes32 id,) = _swapVia(bytes32(uint256(0xA0)), address(0), 1 ether, address(kntq), 95e18);
        (uint8 v, bytes32 r, bytes32 s2) = vm.sign(ownerPk, rv.exitDigest(id, address(ev)));
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        rv.exit(id, address(ev), abi.encodePacked(r, s2, v));
    }
}
