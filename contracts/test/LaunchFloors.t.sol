// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IFeeLocker} from "../src/CloakAuction.sol";
import {CloakSeeder} from "../src/CloakSeeder.sol";
import {IUniswapV2Factory, IWETH} from "../src/uniswap/IUniswapV2.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";

/// Cloak's launch floors: every launch names a minimum raise and gives its pool a minimum share of the raise, at least
/// the floors in CloakConfig. Below its minimum raise a launch fails and every deposit comes back.
contract LaunchFloorsTest is Test {
    CloakConfig config;
    CloakFactory factory;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant SALE = 1_000_000e18;
    uint256 constant MIN_PRICE = 0.0001 ether; // a sell-out at the lowest price raises 100 HYPE
    uint256 constant TICK = 0.0001 ether;

    function setUp() public {
        config = new CloakConfig(address(1), address(0));
        config.setFees(0, 150, treasury);
        factory = new CloakFactory(config, new CloakVestingDeployer(address(0)), new CloakSeeder(IUniswapV2Factory(address(0)), IWETH(address(0)), 997), IFeeLocker(address(0)));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _p(uint128 minRaise, uint16 lpBps, uint256 lpReserve) internal view returns (CloakAuction.Params memory) {
        return CloakAuction.Params({
            creator: creator,
            saleSupply: SALE,
            lpReserve: lpReserve,
            minPrice: MIN_PRICE,
            tickSize: TICK,
            numTicks: 100,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: lpBps,
            noRevealPenaltyBps: 2_000,
            lpLockUntil: 0,
            tlockRound: 0,
            minRaise: minRaise
        });
    }

    function _launch(CloakAuction.Params memory p) internal returns (CloakAuction a, CloakToken t) {
        (address x, address y) = factory.createLaunch("Floors", "FLR", 0, 0, p, "");
        (a, t) = (CloakAuction(payable(x)), CloakToken(y));
    }

    function _bid(CloakAuction a, address who, uint16 tick, uint128 qty, uint256 deposit) internal returns (uint256 id, bytes32 salt) {
        salt = keccak256(abi.encode(who, tick, qty));
        bytes32 h = a.commitmentOf(who, tick, qty, salt);
        vm.prank(who);
        id = a.commit{value: deposit}(h, "");
    }

    function _toReveal(CloakAuction a) internal {
        (,,,,,, uint64 commitEnd,,,,,,) = a.params();
        vm.warp(commitEnd);
    }

    function _toSettle(CloakAuction a) internal {
        (,,,,,,, uint64 revealEnd,,,,,) = a.params();
        vm.warp(revealEnd);
    }

    // ───────────── the floors at creation ─────────────

    function test_noFloorsByDefault() public {
        (uint128 r, uint16 b) = config.launchFloors();
        assertEq(r, 0);
        assertEq(b, 0);
        _launch(_p(0, 0, 0)); // no minimum, no pool share: allowed until the floors are set
    }

    function test_aLaunchMustMeetBothFloors() public {
        config.setLaunchFloors(50 ether, 5_000);
        vm.expectRevert(bytes("min raise"));
        factory.createLaunch("Floors", "FLR", 0, 0, _p(49 ether, 5_000, SALE), "");
        vm.expectRevert(bytes("pool share"));
        factory.createLaunch("Floors", "FLR", 0, 0, _p(50 ether, 4_999, SALE), "");
        _launch(_p(50 ether, 5_000, SALE));
    }

    function test_theReserveMustCoverThePoolsShare() public {
        vm.expectRevert(bytes("pool reserve"));
        factory.createLaunch("Floors", "FLR", 0, 0, _p(0, 5_000, SALE / 2 - 1), "");
        _launch(_p(0, 5_000, SALE / 2));
    }

    function test_aMinimumThatCantBeReachedIsRefused() public {
        // all 1,000,000 sold at the top price (0.01 HYPE) raises 10,000 HYPE
        vm.expectRevert(bytes("min raise unreachable"));
        factory.createLaunch("Floors", "FLR", 0, 0, _p(10_001 ether, 5_000, SALE), "");
        _launch(_p(10_000 ether, 5_000, SALE));
    }

    // ───────────── at settlement ─────────────

    function test_underTheMinimumTheLaunchFailsAndEveryDepositComesBack() public {
        (CloakAuction a, CloakToken t) = _launch(_p(60 ether, 5_000, SALE));
        // 400,000 at the lowest price: 40 HYPE, under the 60 HYPE minimum
        (uint256 id, bytes32 salt) = _bid(a, alice, 0, 400_000e18, 40 ether);
        (uint256 id2,) = _bid(a, bob, 3, 100_000e18, 50 ether); // never revealed
        _toReveal(a);
        a.reveal(id, 0, 400_000e18, salt);
        _toSettle(a);
        a.settle();
        assertTrue(a.failed(), "it fails");
        assertEq(address(a.pair()), address(0), "no pool opens");
        assertEq(a.feesOwed(), 0, "no launch fee");
        assertEq(t.balanceOf(creator), 2 * SALE, "the tokens go back to the creator");
        uint256 before = alice.balance;
        a.claim(id);
        assertEq(alice.balance - before, 40 ether, "alice gets her whole deposit back");
        assertEq(t.balanceOf(alice), 0);
        before = bob.balance;
        a.claim(id2);
        assertEq(bob.balance - before, 50 ether, "even an unrevealed bid comes back in full: no penalty on a failed launch");
    }

    function test_atTheMinimumTheLaunchOpensItsPool() public {
        (CloakAuction a, CloakToken t) = _launch(_p(60 ether, 5_000, SALE));
        (uint256 id, bytes32 salt) = _bid(a, alice, 0, 700_000e18, 70 ether);
        _toReveal(a);
        a.reveal(id, 0, 700_000e18, salt);
        _toSettle(a);
        a.settle();
        assertFalse(a.failed());
        assertGe(a.raised(), 60 ether);
        assertTrue(address(a.pair()) != address(0), "the pool opens");
        a.claim(id);
        assertEq(t.balanceOf(alice), 700_000e18);
    }

    function test_aRaisedFloorDoesntTouchLaunchesAlreadyCreated() public {
        (CloakAuction a,) = _launch(_p(0, 0, 0));
        config.setLaunchFloors(1_000 ether, 9_000);
        (uint256 id, bytes32 salt) = _bid(a, alice, 0, 100_000e18, 10 ether);
        _toReveal(a);
        a.reveal(id, 0, 100_000e18, salt);
        _toSettle(a);
        a.settle();
        assertFalse(a.failed(), "a launch keeps the rules it was created under");
    }

    // ───────────── who moves the floors ─────────────

    function test_raisingIsInstantLoweringWaitsThreeDays() public {
        config.setLaunchFloors(50 ether, 5_000);
        config.endSetup();
        vm.expectRevert(CloakConfig.TimelockRequired.selector);
        config.setLaunchFloors(10 ether, 5_000);
        config.raiseLaunchFloors(100 ether, 6_000); // tightening: at once
        (uint128 r, uint16 b) = config.launchFloors();
        assertEq(r, 100 ether);
        assertEq(b, 6_000);
        vm.expectRevert(CloakConfig.NotHigher.selector);
        config.raiseLaunchFloors(99 ether, 6_000);
        bytes memory lower = abi.encodeCall(CloakConfig.setLaunchFloors, (10 ether, 5_000));
        config.queueChange(lower); // loosening: public for 3 days first
        vm.expectRevert(CloakConfig.NotReady.selector);
        config.executeChange(lower);
        vm.warp(block.timestamp + 3 days);
        config.executeChange(lower);
        (r, b) = config.launchFloors();
        assertEq(r, 10 ether);
        assertEq(b, 5_000);
        vm.prank(alice);
        vm.expectRevert(CloakConfig.NotOwner.selector);
        config.raiseLaunchFloors(1_000 ether, 9_000);
    }

    function test_aPoolShareFloorAbove100PercentIsRefused() public {
        vm.expectRevert(CloakConfig.BadBps.selector);
        config.setLaunchFloors(0, 10_001);
    }
}
