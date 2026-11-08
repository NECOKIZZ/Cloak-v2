// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakGloamReceive} from "../src/CloakGloamReceive.sol";
import {TestToken} from "../src/TestToken.sol";
import {YesVerifier} from "./CloakLaunchVault.t.sol";
import {FeeToken} from "./CloakV2PairSwap.t.sol";

contract CloakGloamReceiveTest is Test {
    using stdJson for string;

    ShieldPoolPayments va;
    ShieldPoolPayments vb;
    CloakGloamReceive rx;
    TestToken usd;
    uint256 ownerPk = 0x0BEEF;
    address ownerKey;
    address payer = address(0xA1);

    function setUp() public {
        vm.warp(1_900_000_000);
        ownerKey = vm.addr(ownerPk);
        va = _vault();
        vb = _vault();
        usd = new TestToken("USDC", "USDC", 6);
        va.setDepositLimit(address(0), 10e18, 100e18);
        va.setDepositLimit(address(usd), 500e6, 25_000e6);
        va.endSetup();
        vb.endSetup();
        rx = new CloakGloamReceive(address(va), address(vb));
        vm.deal(payer, 100e18);
        usd.mint(payer, 10_000e6);
    }

    function _vault() internal returns (ShieldPoolPayments v) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        address p;
        assembly {
            p := create(0, add(code, 0x20), mload(code))
        }
        v = new ShieldPoolPayments(p, address(new YesVerifier()));
        v.setShieldVerifier(address(new YesVerifier()));
        v.turnOnDepositLimits();
    }

    function _sig(address box, address vault, address asset, uint256 amount, bytes32 c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, rx.shieldDigest(box, vault, asset, amount, c));
        return abi.encodePacked(r, s, v);
    }

    function _pay(address box, uint256 amount) internal {
        vm.prank(payer);
        (bool ok,) = box.call{value: amount}("");
        require(ok, "pay");
    }

    function test_payBeforeTheBoxExistsThenShield() public {
        address box = rx.boxOf(ownerKey, 0);
        assertEq(box.code.length, 0);
        _pay(box, 3e18);
        bytes32 c = bytes32(uint256(0xC1));
        bytes memory sig = _sig(box, address(va), address(0), 3e18, c);
        vm.prank(address(0x5E1A)); // a relayer
        rx.shield(ownerKey, 0, address(va), address(0), 3e18, c, hex"00", sig);
        assertGt(box.code.length, 0);
        assertEq(va.deposited(address(0)), 3e18);
        assertTrue(va.commitmentSeen(c));
        assertEq(box.balance, 0);
        assertEq(address(rx).balance, 0);
    }

    function test_theSameAddressReceivesAgain() public {
        address box = rx.boxOf(ownerKey, 0);
        _pay(box, 1e18);
        rx.shield(ownerKey, 0, address(va), address(0), 1e18, bytes32(uint256(1)), hex"00", _sig(box, address(va), address(0), 1e18, bytes32(uint256(1))));
        _pay(box, 2e18);
        rx.shield(ownerKey, 0, address(va), address(0), 2e18, bytes32(uint256(2)), hex"00", _sig(box, address(va), address(0), 2e18, bytes32(uint256(2))));
        assertEq(va.deposited(address(0)), 3e18);
    }

    function test_aCopierCantSwapTheNote() public {
        address box = rx.boxOf(ownerKey, 0);
        _pay(box, 1e18);
        bytes memory sig = _sig(box, address(va), address(0), 1e18, bytes32(uint256(1)));
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.shield(ownerKey, 0, address(va), address(0), 1e18, bytes32(uint256(0xBAD)), hex"00", sig);
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.shield(ownerKey, 0, address(vb), address(0), 1e18, bytes32(uint256(1)), hex"00", sig);
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.shield(ownerKey, 0, address(va), address(0), 1e17, bytes32(uint256(1)), hex"00", sig);
        // another key can't sign for this box
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, rx.shieldDigest(box, address(va), address(0), 1e18, bytes32(uint256(1))));
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.shield(ownerKey, 0, address(va), address(0), 1e18, bytes32(uint256(1)), hex"00", abi.encodePacked(r, s, v));
        vm.expectRevert(CloakGloamReceive.BadVault.selector);
        rx.shield(ownerKey, 0, address(0xBAD), address(0), 1e18, bytes32(uint256(1)), hex"00", sig);
    }

    function test_overTheCapInSeveralDeposits() public {
        address box = rx.boxOf(ownerKey, 1);
        _pay(box, 25e18); // the vault takes 10 per deposit
        bytes32 c = bytes32(uint256(9));
        bytes memory sig = _sig(box, address(va), address(0), 25e18, c);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        rx.shield(ownerKey, 1, address(va), address(0), 25e18, c, hex"00", sig);
        assertEq(box.balance, 25e18, "a refused deposit leaves the money in its box");
        uint256[3] memory parts = [uint256(10e18), 10e18, 5e18];
        for (uint256 i = 0; i < 3; i++) {
            bytes32 ci = bytes32(uint256(100 + i));
            rx.shield(ownerKey, 1, address(va), address(0), parts[i], ci, hex"00", _sig(box, address(va), address(0), parts[i], ci));
        }
        assertEq(va.deposited(address(0)), 25e18);
        assertEq(box.balance, 0);
    }

    function test_tokens() public {
        address box = rx.boxOf(ownerKey, 2);
        vm.prank(payer);
        usd.transfer(box, 300e6);
        bytes32 c = bytes32(uint256(7));
        rx.shield(ownerKey, 2, address(va), address(usd), 300e6, c, hex"00", _sig(box, address(va), address(usd), 300e6, c));
        assertEq(va.deposited(address(usd)), 300e6);
        assertEq(usd.allowance(address(rx), address(va)), 0);
        assertEq(usd.balanceOf(address(rx)), 0);
    }

    function test_nothingThereOrAVaultThatSaysNo() public {
        address box = rx.boxOf(ownerKey, 3);
        bytes32 c = bytes32(uint256(5));
        bytes memory sigA = _sig(box, address(va), address(0), 1e18, c);
        vm.expectRevert(CloakGloamReceive.NothingThere.selector);
        rx.shield(ownerKey, 3, address(va), address(0), 1e18, c, hex"00", sigA);
        _pay(box, 1e18);
        // vb lists nothing: the deposit is refused and the money waits in the box
        bytes memory sigB = _sig(box, address(vb), address(0), 1e18, c);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        rx.shield(ownerKey, 3, address(vb), address(0), 1e18, c, hex"00", sigB);
        assertEq(box.balance, 1e18);
    }

    function test_feeOnTransferRefused() public {
        FeeToken fee = new FeeToken();
        fee.mint(payer, 100e18);
        address box = rx.boxOf(ownerKey, 4);
        vm.prank(payer);
        fee.transfer(box, 10e18);
        uint256 have = fee.balanceOf(box);
        bytes32 c = bytes32(uint256(6));
        bytes memory sig = _sig(box, address(va), address(fee), have, c);
        vm.expectRevert(bytes("short"));
        rx.shield(ownerKey, 4, address(va), address(fee), have, c, hex"00", sig);
        assertEq(fee.balanceOf(box), have);
    }

    function test_strayHypeRefused() public {
        vm.prank(payer);
        (bool ok,) = address(rx).call{value: 1}("");
        assertFalse(ok);
    }

    function test_onlyTheFactoryPulls() public {
        address box = rx.boxOf(ownerKey, 0);
        _pay(box, 1e18);
        rx.shield(ownerKey, 0, address(va), address(0), 5e17, bytes32(uint256(1)), hex"00", _sig(box, address(va), address(0), 5e17, bytes32(uint256(1))));
        vm.expectRevert(bytes("factory"));
        (bool ok,) = box.call(abi.encodeWithSignature("pull(address,uint256)", address(0), 5e17));
        ok;
    }
}
