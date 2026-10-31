// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivateBatcherTest} from "./PrivateBatcher.t.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVesting, CloakVestingDeployer} from "../src/CloakVesting.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {PrivateRouter} from "../src/shielded/PrivateRouter.sol";
import {CloakVaults} from "../src/shielded/CloakVaults.sol";
import {PrivateBatcher} from "../src/shielded/PrivateBatcher.sol";
import {CloakMigrator, ILegacyRouter} from "../src/shielded/CloakMigrator.sol";
import {MerkleTreeWithHistory} from "../src/shielded/MerkleTreeWithHistory.sol";
import {WHYPE} from "../src/shielded/WHYPE.sol";
import {IPoseidon2, IPoseidon3} from "../src/shielded/interfaces/IHasher.sol";

contract NoHype {
    function launch(CloakFactory f, CloakAuction.Params memory p) external returns (address a) {
        p.creator = address(this);
        (a,) = f.createLaunch("Brick", "BRK", 0, 0, p, "");
    }
}

contract GasBurner {
    fallback() external payable {
        while (true) {}
    }
}

contract TreeHarness is MerkleTreeWithHistory {
    constructor(IPoseidon2 h) MerkleTreeWithHistory(h) {}

    function insert(uint256 leaf) external returns (uint256) {
        return _insert(leaf);
    }

    function jumpToEnd() external {
        nextIndex = uint32(1) << LEVELS;
    }
}

/// v2: regressions for every finding of the Oct 25 review, plus fees, caps, the timelock and migration.
contract V2Test is PrivateBatcherTest {
    address treasury = makeAddr("treasury");

    function _params() internal view returns (CloakAuction.Params memory) {
        return CloakAuction.Params(
            address(this), 1_000e18, 1_000e18, 0.001 ether, 0.001 ether, 10,
            uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours), 5000, 1000, 0, 0
        );
    }

    function _factory() internal returns (CloakFactory) {
        return new CloakFactory(config, new CloakVestingDeployer());
    }

    function _unshield(address to, uint256 amount) internal returns (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) {
        ext = ShieldedPool.ExtData(address(router), -int256(amount), address(0), 0, "", "", abi.encode(to));
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(hypePool, ext);
        pr.inputNullifiers = [uint256(keccak256(abi.encode(nonce++))) % hypePool.FIELD_SIZE(), uint256(keccak256(abi.encode(nonce++))) % hypePool.FIELD_SIZE()];
        pr.outputCommitments = [uint256(11), uint256(12)];
    }

    // ───────────── review findings ─────────────

    /// H-1: a creator that can't take HYPE no longer blocks settlement or refunds.
    function test_H1_creatorRejectingHype_cannotLockBidders() public {
        NoHype c = new NoHype();
        CloakAuction a = CloakAuction(payable(c.launch(_factory(), _params())));
        address bob = makeAddr("bob");
        vm.deal(bob, 100 ether);
        bytes32 h = a.commitmentOf(bob, 3, 1_000e18, bytes32(uint256(1)));
        vm.prank(bob);
        a.commit{value: 10 ether}(h, "");
        vm.warp(block.timestamp + 1 hours);
        a.reveal(0, 3, 1_000e18, bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 hours);
        a.settle();
        a.claim(0);
        assertEq(CloakToken(address(a.token())).balanceOf(bob), 1_000e18);
        assertGt(bob.balance, 90 ether); // refund arrived
        vm.expectRevert(bytes("send"));
        a.withdrawProceeds(); // only the creator's own money waits
    }

    /// H-2: a settler who pumps the pool can't make the round cross at the pumped price.
    function test_H2_pumpAtSettle_revertsOutsideBand() public {
        _order(hypePool, 1 ether);
        _order(tokenPool, 200e18);
        uint64 r = _endRound();
        pair.swapExactHypeForTokens{value: 250 ether}(0, address(this)); // ~20% pump
        vm.expectRevert(PrivateBatcher.PriceMoved.selector);
        batcher.settle(address(token), r);
    }

    function test_H2_smallPump_stillCrossesAtTwap() public {
        _order(hypePool, 1 ether);
        _order(tokenPool, 200e18);
        uint256 fair = batcher.midPrice(address(token));
        uint64 r = _endRound();
        pair.swapExactHypeForTokens{value: 5 ether}(0, address(this)); // inside the 2% band, same block as settle
        assertGt(batcher.midPrice(address(token)), fair);
        batcher.settle(address(token), r);
        (,, uint128 tokensForBuyers,,,,,,) = batcher.batches(address(token), r);
        assertEq(tokensForBuyers, (1 ether * 1e18) / fair); // the buyer crossed at the round's TWAP, not the pumped spot
    }

    function test_H2_bandCappedAt2pct() public {
        vm.expectRevert(PrivateBatcher.BadConfig.selector);
        new PrivateBatcher(router, ROUND, 2500, 10 minutes, 1);
    }

    /// H-3: a full tree starts a new epoch; old roots stay valid and nothing reverts.
    function test_H3_fullTreeRollsOver() public {
        TreeHarness t = new TreeHarness(IPoseidon2(_deployCode("test/fixtures/poseidon2.hex")));
        t.insert(5);
        uint256 oldRoot = t.currentRoot();
        t.jumpToEnd();
        uint256 idx = t.insert(7);
        assertEq(t.epoch(), 1);
        assertEq(idx, uint256(1) << 20); // global index: epoch 1, position 0
        assertTrue(t.isKnownRoot(oldRoot));
        assertEq(t.nextIndex(), 1);
    }

    /// H-4 / L-5: a recipient that burns gas can't drain the relayer; it gets WHYPE instead.
    function test_H4_gasBurningRecipient_getsWhype() public {
        GasBurner g = new GasBurner();
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _unshield(address(g), 1 ether);
        uint256 gasBefore = gasleft();
        router.unshieldHype(pr, ext);
        assertLt(gasBefore - gasleft(), 2_000_000); // the burner gets 100k gas, not the rest of the block
        assertEq(whype.balanceOf(address(g)), 1 ether);
    }

    /// M-1: a nearly balanced round settles instead of reverting on a dust swap.
    function test_M1_dustResidual_settles() public {
        _order(tokenPool, 100e18);
        uint256 mid = batcher.midPrice(address(token));
        uint256 target = (100e18 * mid) / 1e18 - 1;
        uint256 unit = 1;
        for (uint256 x = target; x > 0; x /= 10) {
            for (uint256 k; k < x % 10; ++k) _order(hypePool, unit);
            unit *= 10;
        }
        uint64 r = _endRound();
        batcher.settle(address(token), r);
        (,,,,,,, bool settled,) = batcher.batches(address(token), r);
        assertTrue(settled);
    }

    function test_M1_minOrderSize() public {
        PrivateBatcher b = new PrivateBatcher(router, ROUND, 200, 10 minutes, 1e15);
        batcher = b;
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _build(hypePool, 1e14, 1);
        vm.expectRevert(PrivateBatcher.NotStandardSize.selector);
        b.placeOrder(hypePool, pr, ext);
    }

    /// M-2: a sealed bid can't be withheld for free, and the tlock round must fall inside the reveal window.
    function test_M2_minimumPenalty_andTlockRound() public {
        CloakFactory f = _factory();
        CloakAuction.Params memory p = _params();
        p.noRevealPenaltyBps = 0;
        vm.expectRevert(bytes("penalty"));
        f.createLaunch("X", "X", 0, 0, p, "");

        vm.warp(1_800_000_000);
        p = _params();
        p.tlockRound = 1; // 2023: before bidding closes
        vm.expectRevert(bytes("tlock round"));
        f.createLaunch("X", "X", 0, 0, p, "");
        uint256 good = (uint256(p.commitEnd) + 60 - 1692803367) / 3 + 1;
        p.tlockRound = uint64(good);
        f.createLaunch("X", "X", 0, 0, p, "");
    }

    /// M-4: the creator share is capped and vests.
    function test_M4_creatorShare_cappedAndVested() public {
        CloakFactory f = _factory();
        vm.expectRevert(bytes("creator share"));
        f.createLaunch("X", "X", 600e18, 30 days, _params(), ""); // 600 of 2,600 > 20%
        vm.expectRevert(bytes("vesting"));
        f.createLaunch("X", "X", 400e18, 1 days, _params(), "");
        (, address t) = f.createLaunch("X", "X", 400e18, 30 days, _params(), "");
        (,,,,, address v) = f.launches(0);
        CloakVesting vest = CloakVesting(v);
        assertEq(CloakToken(t).balanceOf(v), 400e18);
        vm.warp(vest.start() + 15 days);
        vest.release();
        assertApproxEqAbs(CloakToken(t).balanceOf(address(this)), 200e18, 1e18);
        vm.warp(vest.end());
        vest.release();
        assertEq(CloakToken(t).balanceOf(address(this)), 400e18);
    }

    /// L-4: tokens can't be sent to address(0).
    function test_L4_noTransferToZero() public {
        vm.expectRevert(bytes("to zero"));
        token.transfer(address(0), 1);
    }

    // ───────────── fees ─────────────

    function test_fees_withdrawalKeepsFee_collectedToTreasury() public {
        config.setFees(25, 150, treasury);
        address fresh = makeAddr("fresh");
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _unshield(fresh, 10 ether);
        router.unshieldHype(pr, ext);
        assertEq(fresh.balance, 9.975 ether);
        assertEq(hypePool.feesOwed(), 0.025 ether);
        assertGe(whype.balanceOf(address(hypePool)), hypePool.deposited() + hypePool.feesOwed());
        hypePool.collectFees();
        assertEq(whype.balanceOf(treasury), 0.025 ether);
    }

    function test_fees_privateSwapPaysWithdrawalFee() public {
        config.setFees(25, 0, treasury);
        uint256 before = token.balanceOf(address(tokenPool));
        PrivateRouter.SwapData memory d = PrivateRouter.SwapData(address(pair), address(tokenPool), 0, 1, 2, "", uint64(block.timestamp + 60));
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, "", "", abi.encode(d));
        ShieldedPool.Proof memory pr;
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(hypePool, ext);
        pr.inputNullifiers = [uint256(991), uint256(992)];
        pr.outputCommitments = [uint256(11), uint256(12)];
        uint256 expect = pair.getAmountOut(0.9975 ether, pair.reserveHype(), pair.reserveToken());
        router.privateSwap(hypePool, pr, ext);
        assertEq(token.balanceOf(address(tokenPool)) - before, expect);
        assertEq(hypePool.feesOwed(), 0.0025 ether);
    }

    function test_fees_launchFeeAtSettlement() public {
        config.setFees(0, 150, treasury);
        CloakFactory f = _factory();
        (address a_,) = f.createLaunch("Fee", "FEE", 0, 0, _params(), "");
        CloakAuction a = CloakAuction(payable(a_));
        address bob = makeAddr("bob2");
        vm.deal(bob, 100 ether);
        bytes32 h = a.commitmentOf(bob, 9, 1_000e18, bytes32(uint256(1)));
        vm.prank(bob);
        a.commit{value: 20 ether}(h, "");
        vm.warp(block.timestamp + 1 hours);
        a.reveal(0, 9, 1_000e18, bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 hours);
        a.settle();
        uint256 raised = a.raised();
        assertEq(a.feesOwed(), (raised * 150) / 10_000);
        a.collectFees();
        assertEq(treasury.balance, (raised * 150) / 10_000);
        a.claim(0);
        a.withdrawProceeds();
        a.sweepDust();
        assertLe(address(a).balance, a.feesOwed());
    }

    function test_fees_hardCaps() public {
        vm.expectRevert(CloakConfig.FeeTooHigh.selector);
        config.setFees(101, 0, treasury);
        vm.expectRevert(CloakConfig.FeeTooHigh.selector);
        config.setFees(0, 301, treasury);
        vm.expectRevert(CloakConfig.ZeroAddress.selector);
        config.setFees(25, 0, address(0));
    }

    function test_fees_failedLaunchPaysNothing() public {
        config.setFees(0, 300, treasury);
        CloakFactory f = _factory();
        (address a_,) = f.createLaunch("Nope", "NOPE", 0, 0, _params(), "");
        CloakAuction a = CloakAuction(payable(a_));
        vm.warp(block.timestamp + 2 hours);
        a.settle();
        assertTrue(a.failed());
        assertEq(a.feesOwed(), 0);
    }

    // ───────────── caps ─────────────

    function test_caps_hypePool() public {
        config.turnOnDepositLimits();
        config.setLimit(address(whype), 1 ether, 102 ether); // the pool already holds 100
        config.setCapExempt(address(router), true);
        vm.deal(address(this), 10 ether);
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        router.shieldHype{value: 1.5 ether}(1, 2, "");
        router.shieldHype{value: 1 ether}(1, 2, "");
        router.shieldHype{value: 1 ether}(1, 2, "");
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        router.shieldHype{value: 1 ether}(1, 2, "");
        // withdrawals are never capped
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _unshield(makeAddr("x"), 50 ether);
        router.unshieldHype(pr, ext);
    }

    function test_caps_launchTokenDefaultShareOfSupply() public {
        config.turnOnDepositLimits();
        config.setDefaultLimit(1, 100); // 0.01% per deposit, 1% in total
        uint256 supply = token.totalSupply();
        pair.swapExactHypeForTokens{value: 10 ether}(0, address(this));
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        tokenPool.depositTo(5, supply / 10_000 + 1, 6, "");
    }

    function test_caps_routerSwapOutputsExempt() public {
        config.turnOnDepositLimits();
        config.setDefaultLimit(0, 0); // public token deposits closed
        config.setLimit(address(whype), 1000 ether, 1000 ether);
        config.setCapExempt(address(router), true);
        PrivateRouter.SwapData memory d = PrivateRouter.SwapData(address(pair), address(tokenPool), 0, 1, 2, "", uint64(block.timestamp + 60));
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, "", "", abi.encode(d));
        ShieldedPool.Proof memory pr;
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(hypePool, ext);
        pr.inputNullifiers = [uint256(981), uint256(982)];
        pr.outputCommitments = [uint256(11), uint256(12)];
        router.privateSwap(hypePool, pr, ext); // the output deposit isn't capped
    }

    function test_caps_auction() public {
        config.turnOnDepositLimits();
        config.setAuctionLimit(10 ether, 15 ether);
        CloakFactory f = _factory();
        (address a_,) = f.createLaunch("Cap", "CAP", 0, 0, _params(), "");
        CloakAuction a = CloakAuction(payable(a_));
        vm.deal(address(this), 100 ether);
        vm.expectRevert(bytes("over cap"));
        a.commit{value: 11 ether}(bytes32(uint256(1)), "");
        a.commit{value: 10 ether}(bytes32(uint256(1)), "");
        vm.expectRevert(bytes("over cap"));
        a.commit{value: 6 ether}(bytes32(uint256(1)), "");
        a.commit{value: 5 ether}(bytes32(uint256(1)), "");
    }

    // ───────────── timelock ─────────────

    function test_timelock_afterSetup() public {
        config.setFees(25, 150, treasury);
        config.endSetup();
        vm.expectRevert(CloakConfig.TimelockRequired.selector);
        config.setFees(50, 150, treasury);

        bytes memory call = abi.encodeCall(CloakConfig.setFees, (50, 150, treasury));
        config.queueChange(call);
        vm.expectRevert(CloakConfig.NotReady.selector);
        config.executeChange(call);
        vm.warp(block.timestamp + 3 days);
        config.executeChange(call);
        assertEq(config.withdrawFeeBps(), 50);

        // tightening is instant; loosening through the instant path is refused
        config.lowerFees(10, 100);
        assertEq(config.withdrawFeeBps(), 10);
        vm.expectRevert(CloakConfig.NotLower.selector);
        config.lowerFees(20, 100);

        // only the owner, and replays fail
        vm.expectRevert(CloakConfig.NotQueued.selector);
        config.executeChange(call);
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(CloakConfig.NotOwner.selector);
        config.queueChange(call);
    }

    function test_registry_setupThenTimelock() public {
        assertEq(config.current("router"), address(0));
        vm.roll(100);
        config.register("router", address(0xA1), 3, 50);
        config.register("batcher", address(0xB1), 3, 50);
        config.register("router", address(0xA2), 4, 100);
        assertEq(config.current("router"), address(0xA2), "newest entry of a kind is current");
        assertEq(config.current("batcher"), address(0xB1));
        assertEq(config.registryCount(), 3);
        (bytes32 kind, address addr, uint16 version, uint64 at) = config.registry(0);
        assertEq(kind, bytes32("router"));
        assertEq(addr, address(0xA1));
        assertEq(version, 3);
        assertEq(at, 50);
        vm.expectRevert(CloakConfig.ZeroAddress.selector);
        config.register("router", address(0), 4, 1);
        vm.expectRevert(CloakConfig.BadBlock.selector);
        config.register("router", address(0xA9), 4, 101);

        config.endSetup();
        // every registry change loosens a rule, so after setup it waits the timelock
        vm.expectRevert(CloakConfig.TimelockRequired.selector);
        config.register("router", address(0xA3), 4, 100);
        vm.expectRevert(CloakConfig.TimelockRequired.selector);
        config.addLaunchFactory(address(0xF1));
        vm.expectRevert(CloakConfig.TimelockRequired.selector);
        config.approveAsset(address(0xC1));
        bytes[3] memory calls = [
            abi.encodeCall(CloakConfig.register, (bytes32("router"), address(0xA3), uint16(4), uint64(100))),
            abi.encodeCall(CloakConfig.addLaunchFactory, (address(0xF1))),
            abi.encodeCall(CloakConfig.approveAsset, (address(0xC1)))
        ];
        for (uint256 i; i < 3; i++) config.queueChange(calls[i]);
        vm.expectRevert(CloakConfig.NotReady.selector);
        config.executeChange(calls[0]);
        vm.warp(block.timestamp + 3 days);
        for (uint256 i; i < 3; i++) config.executeChange(calls[i]);
        assertEq(config.current("router"), address(0xA3));
        assertTrue(config.isLaunchFactory(address(0xF1)) && config.approvedAsset(address(0xC1)));

        // removing a factory tightens, so it is instant
        config.removeLaunchFactory(address(0xF1));
        assertFalse(config.isLaunchFactory(address(0xF1)));
        vm.expectRevert(CloakConfig.NotAdded.selector);
        config.removeLaunchFactory(address(0xF1));
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(CloakConfig.NotOwner.selector);
        config.removeLaunchFactory(address(0xF1));
    }

    function test_timelock_expires_andCancels() public {
        config.endSetup();
        bytes memory call = abi.encodeCall(CloakConfig.setVerifier, (address(0xBEEF)));
        config.queueChange(call);
        vm.warp(block.timestamp + 3 days + 14 days + 1);
        vm.expectRevert(CloakConfig.Expired.selector);
        config.executeChange(call);
        config.queueChange(call); // an expired entry can be re-queued
        config.cancelChange(call);
        vm.expectRevert(CloakConfig.NotQueued.selector);
        config.executeChange(call);
    }

    function test_timelock_onlyWhitelistedSetters() public {
        config.endSetup();
        vm.expectRevert(CloakConfig.UnknownChange.selector);
        config.queueChange(abi.encodeCall(CloakConfig.transferOwnership, (address(1))));
    }

    function test_lowerLimit_closesDepositsAtOnce() public {
        config.turnOnDepositLimits();
        config.setLimit(address(whype), 10 ether, 1000 ether);
        config.endSetup();
        config.lowerLimit(address(whype), 0, 0);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        router.shieldHype{value: 1 ether}(1, 2, "");
        vm.expectRevert(CloakConfig.NotLower.selector);
        config.lowerLimit(address(whype), 1, 0);
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        config.transferOwnership(next);
        assertEq(config.owner(), address(this));
        vm.prank(next);
        config.acceptOwnership();
        assertEq(config.owner(), next);
    }

    // ───────────── migration ─────────────

    function test_migrate_oldPoolToNewPool() public {
        // the deployment set up in setUp() plays "an earlier one"; the next one reuses its WHYPE
        PrivateRouter v2 = _nextDeployment();
        CloakMigrator m = _migrator(v2, new address[](0));
        config.turnOnDepositLimits();
        config.setLimit(address(whype), 0, 0); // even with v2 deposits closed, a balance can move
        config.setCapExempt(address(m), true);

        CloakMigrator.MoveData memory d = CloakMigrator.MoveData(77, 88, hex"ee");
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(m), -40 ether, address(0), 0, "", "", abi.encode(d));
        ShieldedPool.Proof memory pr;
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(hypePool, ext);
        pr.inputNullifiers = [uint256(971), uint256(972)];
        pr.outputCommitments = [uint256(11), uint256(12)];
        // the relayer can't redirect it
        CloakMigrator.MoveData memory evil = CloakMigrator.MoveData(666, 88, hex"ee");
        ShieldedPool.ExtData memory bad = ShieldedPool.ExtData(address(m), -40 ether, address(0), 0, "", "", abi.encode(evil));
        vm.expectRevert(ShieldedPool.BadExtDataHash.selector);
        m.migrate(hypePool, pr, bad);

        m.migrate(hypePool, pr, ext);
        assertEq(whype.balanceOf(address(v2.hypePool())), 40 ether);
        assertEq(v2.hypePool().deposited(), 40 ether);
    }

    function _nextDeployment() internal returns (PrivateRouter) {
        CloakVaults next = new CloakVaults(
            config, IPoseidon2(_deployCode("test/fixtures/poseidon2.hex")), IPoseidon3(_deployCode("test/fixtures/poseidon3.hex"))
        );
        next.createAssetPool(address(whype));
        return new PrivateRouter(next, whype);
    }

    function _migrator(PrivateRouter to, address[] memory standalone) internal returns (CloakMigrator) {
        ILegacyRouter[] memory olds = new ILegacyRouter[](1);
        olds[0] = ILegacyRouter(address(router));
        return new CloakMigrator(olds, standalone, to);
    }

    function _moveExt(CloakMigrator m, ShieldedPool pool, int256 amount, uint256 n)
        internal
        returns (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext)
    {
        ext = ShieldedPool.ExtData(address(m), -amount, address(0), 0, "", "", abi.encode(CloakMigrator.MoveData(77, 88, "")));
        pr.root = pool.currentRoot();
        pr.publicAmount = pool.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(pool, ext);
        pr.inputNullifiers = [n, n + 1];
        pr.outputCommitments = [uint256(11), uint256(12)];
    }

    /// A standalone earlier vault (v2's USDC vault lived outside its router) moves too; the target's own vaults don't.
    function test_migrate_standaloneVault_andNotFromTarget() public {
        PrivateRouter v2 = _nextDeployment();
        // a standalone WHYPE vault on the old config stands in for v2's USDC vault
        ShieldedPool standalone = new ShieldedPool(config, hypePool.hasher(), hypePool.hasher3(), hypePool.token());
        address[] memory list = new address[](1);
        list[0] = address(standalone);
        CloakMigrator m = _migrator(v2, list);
        config.setCapExempt(address(m), true);
        assertTrue(m.isOldPool(address(standalone)) && m.isOldPool(address(hypePool)));
        assertFalse(m.isOldPool(address(v2.hypePool())));

        vm.deal(address(this), 3 ether);
        whype.deposit{value: 3 ether}();
        whype.approve(address(standalone), 3 ether);
        standalone.depositTo(5, 3 ether, 6, "");
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _moveExt(m, standalone, 3 ether, 981);
        m.migrate(standalone, pr, ext);
        assertEq(v2.hypePool().deposited(), 3 ether);

        // moving "out of" the target's own vault is refused
        ShieldedPool target = v2.hypePool();
        (pr, ext) = _moveExt(m, target, 1 ether, 991);
        vm.expectRevert(CloakMigrator.UnknownPool.selector);
        m.migrate(target, pr, ext);
    }

    // ───────────── fuzz: solvency ─────────────

    function testFuzz_poolSolvent(uint8 bps, uint96 amount, uint64 relayerFee) public {
        bps = uint8(bound(bps, 0, 100));
        amount = uint96(bound(amount, 1, 90 ether));
        relayerFee = uint64(bound(relayerFee, 0, 1 ether));
        config.setFees(bps, 0, treasury);
        ShieldedPool.ExtData memory ext =
            ShieldedPool.ExtData(makeAddr("to"), -int256(uint256(amount)), makeAddr("relayer"), relayerFee, "", "", "");
        ShieldedPool.Proof memory pr;
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, relayerFee);
        pr.extDataHash = this.hashExt(hypePool, ext);
        pr.inputNullifiers = [uint256(961), uint256(962)];
        pr.outputCommitments = [uint256(11), uint256(12)];
        hypePool.transact(pr, ext);
        assertEq(whype.balanceOf(address(hypePool)), hypePool.deposited() + hypePool.feesOwed());
        assertEq(whype.balanceOf(makeAddr("to")) + hypePool.feesOwed(), amount);
    }

    function testFuzz_batchSolvent(uint8 nBuys, uint8 nSells, uint8 bps, uint256 seed) public {
        nBuys = uint8(bound(nBuys, 0, 6));
        nSells = uint8(bound(nSells, 0, 6));
        vm.assume(nBuys + nSells > 0);
        config.setFees(uint16(bound(bps, 0, 100)), 0, treasury);
        uint256[] memory ids = new uint256[](uint256(nBuys) + nSells);
        uint256[3] memory std = [uint256(1), 2, 5];
        for (uint256 i; i < ids.length; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool buy = i < nBuys;
            uint256 size = std[r % 3] * (buy ? 1e17 : 1e19);
            ids[i] = _order(buy ? hypePool : tokenPool, size);
        }
        uint64 round = _endRound();
        batcher.settle(address(token), round);
        batcher.claim(ids); // every payout succeeds: the batch never owes more than it holds
    }

    /// A net trade that moves a shallow pool a few percent still settles; one that would cost more than 5% refunds.
    function test_residualImpact_boundedAt5pct() public {
        uint256 rH = pair.reserveHype();
        vm.deal(address(this), 1_000 ether);
        router.shieldHype{value: 1_000 ether}(1, 2, "");
        _order(hypePool, _std(rH / 50)); // ~2% of the pool's HYPE
        uint64 r = _endRound();
        batcher.settle(address(token), r);

        vm.warp((block.timestamp / ROUND + 1) * ROUND);
        _order(hypePool, _std(rH / 5)); // ~20% of the pool: far more than 5% impact
        r = _endRound();
        vm.expectRevert(bytes("slippage"));
        batcher.settle(address(token), r);
    }

    /// largest 1/2/5 × 10ⁿ at or below x
    function _std(uint256 x) internal pure returns (uint256 v) {
        v = 1;
        while (v * 10 <= x) v *= 10;
        if (v * 5 <= x) return v * 5;
        if (v * 2 <= x) return v * 2;
    }
}
