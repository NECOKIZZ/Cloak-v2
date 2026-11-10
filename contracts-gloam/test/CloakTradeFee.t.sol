// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakTradeFee} from "../src/CloakTradeFee.sol";

contract CloakTradeFeeTest is Test {
    CloakTradeFee f;
    address constant TREASURY = address(0x7EA5);

    function setUp() public {
        f = new CloakTradeFee(address(this), TREASURY, 50);
    }

    function test_startsAsSet() public view {
        (uint16 bps, address to) = f.current();
        assertEq(bps, 50);
        assertEq(to, TREASURY);
        assertEq(f.owner(), address(this));
    }

    function test_neverOverOnePercent() public {
        vm.expectRevert(CloakTradeFee.TooHigh.selector);
        new CloakTradeFee(address(this), TREASURY, 101);
        vm.expectRevert(CloakTradeFee.TooHigh.selector);
        f.queue(101, TREASURY);
    }

    function test_feeIsItsShareOfTheWhole() public view {
        // the trader keeps 995; the fee is 0.5% of 1,000
        assertEq(f.feeOn(995e18), 5e18);
        // rounded up, never down
        assertEq(f.feeOn(1), 1);
    }

    function test_lowerAtOnce() public {
        f.lower(25);
        assertEq(f.feeBps(), 25);
        vm.expectRevert(CloakTradeFee.NotLower.selector);
        f.lower(25);
        f.lower(0);
        assertEq(f.feeOn(1e18), 0);
    }

    function test_raiseAndTreasuryMoveWaitThreeDays() public {
        f.queue(80, address(0xBEEF));
        vm.expectRevert(CloakTradeFee.NotYet.selector);
        f.applyQueued();
        vm.warp(block.timestamp + 3 days - 1);
        vm.expectRevert(CloakTradeFee.NotYet.selector);
        f.applyQueued();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xA11)); // anyone applies it once due
        f.applyQueued();
        assertEq(f.feeBps(), 80);
        assertEq(f.treasury(), address(0xBEEF));
        vm.expectRevert(CloakTradeFee.NotQueued.selector);
        f.applyQueued();
    }

    function test_cancelAQueuedChange() public {
        f.queue(80, TREASURY);
        f.cancel();
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(CloakTradeFee.NotQueued.selector);
        f.applyQueued();
        assertEq(f.feeBps(), 50);
    }

    function test_onlyTheOwner() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(CloakTradeFee.NotOwner.selector);
        f.lower(10);
        vm.expectRevert(CloakTradeFee.NotOwner.selector);
        f.queue(10, TREASURY);
        vm.expectRevert(CloakTradeFee.NotOwner.selector);
        f.transferOwnership(address(0xBAD));
        vm.stopPrank();
    }

    function test_ownershipInTwoSteps() public {
        f.transferOwnership(address(0xB0B));
        assertEq(f.owner(), address(this));
        vm.prank(address(0xBAD));
        vm.expectRevert(CloakTradeFee.NotOwner.selector);
        f.acceptOwnership();
        vm.prank(address(0xB0B));
        f.acceptOwnership();
        assertEq(f.owner(), address(0xB0B));
    }
}
