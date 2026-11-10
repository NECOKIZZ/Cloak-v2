// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey as V4Key} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakRouterV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {TestToken} from "cloak-gloam/TestToken.sol";
import {CloakLaunchSwapV4Test, ToV, YesV} from "./CloakLaunchSwapV4.t.sol";
import {PlainLp} from "./CloakEcosystemVault.t.sol";

/**
 * CloakRouterV4's two-pool routes: USDC (in Gloam's vault, with a plain HYPE pool) to a Cloak launch token (in the
 * launch vault) through HYPE, and back, in one private swap each. HYPE only passes through the PoolManager.
 */
contract CloakRouterV4RoutesTest is CloakLaunchSwapV4Test {
    ShieldPoolPayments gv;
    CloakRouterV4 rv;
    TestToken usdc;
    PlainLp lp;

    // 1 HYPE = 100 USDC (6 decimals): sqrtP = sqrt(100e6 / 1e18) * 2^96; L = 1e15 is about 100 HYPE and 10,000 USDC in range
    uint160 constant SQRT_USDC = uint160((uint256(1) << 96) / 100_000);
    int256 constant LIQ = 1e15;

    function _setUpRoutes() internal {
        _setUpVault();
        usdc = new TestToken("USD Coin", "USDC", 6);
        lp = new PlainLp(pm);
        usdc.mint(address(lp), 20_000e6);
        vm.deal(address(lp), 200 ether);
        lp.open(_usdcV4(), SQRT_USDC);
        lp.liquidity(_usdcV4(), LIQ);

        gv = new ShieldPoolPayments(_poseidon(), address(new ToV()));
        gv.setShieldVerifier(address(new YesV()));
        gv.setWithdrawFee(50, address(0x6A0A));
        gv.turnOnDepositLimits();
        gv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        gv.setDepositLimit(address(usdc), 10_000e6, 1_000_000e6);
        gv.endSetup();
        rv = new CloakRouterV4(address(lv), address(gv), address(0), address(pm), address(whype), address(hook));
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(gv), type(uint256).max);
        gv.shieldBound(address(usdc), 50e6, bytes32(uint256(0xD0)), hex"00");
    }

    function _usdcV4() internal view returns (V4Key memory) {
        return V4Key(Currency.wrap(address(0)), Currency.wrap(address(usdc)), 3000, 60, IHooks(address(0)));
    }

    function _usdcKey() internal view returns (PoolKey memory) {
        return PoolKey(address(0), address(usdc), 3000, 60, address(0));
    }

    function _two(PoolKey memory a, PoolKey memory b) internal pure returns (bytes memory) {
        PoolKey[] memory hops = new PoolKey[](2);
        hops[0] = a;
        hops[1] = b;
        return abi.encode(hops);
    }

    struct Call {
        CloakLaunchSwapBase.Spend s;
        CloakLaunchSwapBase.Deposit d;
        bytes route;
        uint256 deadline;
    }

    function _prep(bytes32 n, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut, bytes memory route) internal view returns (Call memory c) {
        c.route = route;
        c.deadline = block.timestamp + 600;
        c.s = CloakLaunchSwapBase.Spend(hex"", address(rv.vaultFor(assetIn)) == address(gv) ? gv.currentRoot() : lv.currentRoot(), n, assetIn, amountIn);
        c.d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        c.s.proof = abi.encode(rv.escrowFor(rv.keyOf(c.s, c.d, c.route, owner, c.deadline)));
    }

    function _go(Call memory c) internal returns (bytes32 id, uint256 left) {
        return rv.swap(c.s, c.d, c.route, owner, c.deadline);
    }

    function test_routes_usdcIsInGloamsVault() public {
        _setUpRoutes();
        assertEq(address(rv.vaultFor(address(usdc))), address(gv));
    }

    function test_routes_usdcBuysALaunchTokenThroughHype() public {
        _setUpRoutes();
        uint256 u0 = gv.deposited(address(usdc));
        uint256 t0 = lv.deposited(address(token));
        uint256 h0 = gv.deposited(address(0));
        uint256 lh0 = lv.deposited(address(0));
        // 50 USDC, 49.75 after Gloam's fee, is about 0.49 HYPE, which buys well over 100 tokens
        (bytes32 id, uint256 left) = _go(_prep(bytes32(uint256(0xD0)), address(usdc), 50e6, address(token), 100e18, _two(_usdcKey(), _key())));
        assertEq(u0 - gv.deposited(address(usdc)), 50e6, "the USDC note left Gloam's vault");
        assertEq(gv.feesOwed(address(usdc)), 0.25e6, "Gloam's vault kept its fee on the USDC spent");
        assertEq(lv.deposited(address(token)) - t0, 100e18, "exactly 100 tokens landed as a note in the launch vault");
        assertEq(gv.deposited(address(0)), h0, "no HYPE moved in Gloam's vault: it only passed through the pools");
        assertEq(lv.deposited(address(0)), lh0, "nor in the launch vault");
        (address asset,, uint256 amount) = rv.owed(id);
        assertEq(asset, address(usdc), "what the swap didn't need is owed back in USDC");
        assertEq(amount, left);
        assertGt(left, 0);
        assertEq(address(rv).balance, 0, "the router holds no HYPE");
    }

    function test_routes_aLaunchTokenSellsForUsdcThroughHype() public {
        _setUpRoutes();
        uint256 u0 = gv.deposited(address(usdc));
        uint256 fees0 = lv.feesOwed(address(token));
        // 2,000 tokens are about 1 HYPE, about 100 USDC
        (bytes32 id, uint256 left) = _go(_prep(bytes32(uint256(0x70)), address(token), 2_000e18, address(usdc), 80e6, _two(_key(), _usdcKey())));
        assertEq(gv.deposited(address(usdc)) - u0, 80e6, "exactly 80 USDC landed as a note in Gloam's vault");
        assertEq(lv.feesOwed(address(token)) - fees0, 10e18, "the launch vault kept its fee on the tokens spent");
        (address asset,, uint256 amount) = rv.owed(id);
        assertEq(asset, address(token));
        assertEq(amount, left, "the token buffer is owed back into the launch vault");
    }

    function test_routes_greedyTwoHopRevertsWhole() public {
        _setUpRoutes();
        Call memory c = _prep(bytes32(uint256(0xD0)), address(usdc), 50e6, address(token), 10_000e18, _two(_usdcKey(), _key()));
        vm.expectRevert();
        _go(c);
        assertFalse(gv.isSpent(bytes32(uint256(0xD0))), "the USDC note stays in Gloam's vault");
    }

    function test_routes_aHookedPoolOtherThanCloaksIsRefused() public {
        _setUpRoutes();
        PoolKey memory bad = _usdcKey();
        bad.hooks = address(0xBAD);
        Call memory c = _prep(bytes32(uint256(0xD0)), address(usdc), 50e6, address(token), 100e18, _two(bad, _key()));
        vm.expectRevert();
        _go(c);
    }
}
