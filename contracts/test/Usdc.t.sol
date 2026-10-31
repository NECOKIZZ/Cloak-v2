// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivateBatcherTest} from "./PrivateBatcher.t.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// A permanent vault for a 6-decimal stablecoin: the same ShieldedPool, made by CloakVaults once the config approves it.
contract UsdcPoolTest is PrivateBatcherTest {
    MockUSDC usdc;
    ShieldedPool usdcPool;
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");

    function setUp() public override {
        super.setUp();
        usdc = new MockUSDC();
        config.approveAsset(address(usdc));
        usdcPool = router.vaults().createAssetPool(address(usdc));
        assertTrue(router.isPool(address(usdcPool)));
        assertEq(address(router.pairOf(address(usdc))), address(0)); // an asset vault, not a launch market
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(usdcPool), type(uint256).max);
    }

    function _withdraw(address to, uint256 amount, uint256 fee) internal returns (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) {
        ext = ShieldedPool.ExtData(to, -int256(amount), relayer, fee, "", "", "");
        pr.root = usdcPool.currentRoot();
        pr.publicAmount = usdcPool.calculatePublicAmount(ext.extAmount, fee);
        pr.extDataHash = this.hashExt(usdcPool, ext);
        pr.inputNullifiers = [uint256(keccak256(abi.encode(nonce++))) % usdcPool.FIELD_SIZE(), uint256(keccak256(abi.encode(nonce++))) % usdcPool.FIELD_SIZE()];
        pr.outputCommitments = [uint256(21), uint256(22)];
    }

    function test_usdc_depositThenWithdraw_keepsFeeAndPaysRelayerInUsdc() public {
        config.setFees(25, 150, treasury);
        usdcPool.depositTo(5, 500e6, 6, "");
        assertEq(usdcPool.deposited(), 500e6);
        address fresh = makeAddr("fresh");
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _withdraw(fresh, 200e6, 0.05e6);
        usdcPool.transact(pr, ext);
        assertEq(usdc.balanceOf(fresh), 199.5e6); // 0.25% of 200 USDC kept
        assertEq(usdc.balanceOf(relayer), 0.05e6); // relayer paid in USDC, inside the proof
        assertEq(usdcPool.feesOwed(), 0.5e6);
        assertEq(usdcPool.deposited(), 500e6 - 200e6 - 0.05e6);
        assertGe(usdc.balanceOf(address(usdcPool)), usdcPool.deposited() + usdcPool.feesOwed());
        usdcPool.collectFees();
        assertEq(usdc.balanceOf(treasury), 0.5e6);
    }

    function test_usdc_caps() public {
        config.turnOnDepositLimits();
        config.setLimit(address(usdc), 1_000e6, 50_000e6);
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        usdcPool.depositTo(5, 1_000e6 + 1, 6, "");
        for (uint256 i; i < 50; i++) usdcPool.depositTo(5 + i, 1_000e6, 6, "");
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        usdcPool.depositTo(99, 1, 6, "");
        // tightening is instant, even to zero: exits stay open
        config.lowerLimit(address(usdc), 0, 0);
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        usdcPool.depositTo(100, 1, 6, "");
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _withdraw(makeAddr("out"), 1_000e6, 0);
        usdcPool.transact(pr, ext);
    }

    function testFuzz_usdcSolvent(uint96 deposit, uint96 out, uint32 relayerFee) public {
        config.setFees(25, 150, treasury);
        uint256 d = bound(deposit, 1, 1_000_000e6);
        uint256 o = bound(out, 0, d);
        uint256 f = bound(relayerFee, 0, d - o);
        usdcPool.depositTo(5, d, 6, "");
        if (o + f > 0) {
            (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _withdraw(makeAddr("x"), o, f);
            if (o == 0) ext.extAmount = 0;
            pr.publicAmount = usdcPool.calculatePublicAmount(ext.extAmount, f);
            pr.extDataHash = this.hashExt(usdcPool, ext);
            usdcPool.transact(pr, ext);
        }
        assertGe(usdc.balanceOf(address(usdcPool)), usdcPool.deposited() + usdcPool.feesOwed());
    }
}
