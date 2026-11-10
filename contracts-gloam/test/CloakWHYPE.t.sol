// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakWHYPE} from "../src/CloakWHYPE.sol";

contract CloakWHYPETest is Test {
    CloakWHYPE w;
    address a = address(0xA11CE);
    address b = address(0xB0B);

    function setUp() public {
        w = new CloakWHYPE();
        vm.deal(a, 10 ether);
    }

    function test_wrapAndUnwrapOneForOne() public {
        vm.prank(a);
        w.deposit{value: 3 ether}();
        assertEq(w.balanceOf(a), 3 ether);
        assertEq(w.totalSupply(), 3 ether);
        vm.prank(a);
        w.withdraw(1 ether);
        assertEq(a.balance, 8 ether);
        assertEq(w.balanceOf(a), 2 ether);
    }

    function test_plainSendWraps() public {
        vm.prank(a);
        (bool ok,) = address(w).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(w.balanceOf(a), 1 ether);
    }

    function test_transferAndAllowance() public {
        vm.startPrank(a);
        w.deposit{value: 2 ether}();
        w.transfer(b, 1 ether);
        w.approve(b, 0.5 ether);
        vm.stopPrank();
        vm.prank(b);
        w.transferFrom(a, b, 0.5 ether);
        assertEq(w.balanceOf(b), 1.5 ether);
        assertEq(w.allowance(a, b), 0);
        vm.prank(b);
        vm.expectRevert(bytes("allowance"));
        w.transferFrom(a, b, 0.1 ether);
    }

    function test_cantTakeMoreThanHeld() public {
        vm.prank(a);
        vm.expectRevert(bytes("balance"));
        w.withdraw(1);
        vm.prank(a);
        vm.expectRevert(bytes("balance"));
        w.transfer(b, 1);
    }
}
