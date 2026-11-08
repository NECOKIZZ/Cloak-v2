// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakFundsGate} from "../src/CloakFundsGate.sol";
import {CloakReceiptCheck} from "../src/CloakReceiptCheck.sol";

contract MockVault {
    mapping(bytes32 => bool) public isKnownRoot;
    mapping(bytes32 => bool) public isSpent;
    mapping(bytes32 => bool) public commitmentSeen;

    function root(bytes32 r) external {
        isKnownRoot[r] = true;
    }

    function spend(bytes32 n) external {
        isSpent[n] = true;
    }

    function see(bytes32 c) external {
        commitmentSeen[c] = true;
    }
}

contract MockFundsVerifier {
    bool public answer = true;

    function set(bool a) external {
        answer = a;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[8] calldata) external view returns (bool) {
        return answer;
    }
}

contract MockReceiptVerifier {
    bool public answer = true;

    function set(bool a) external {
        answer = a;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[7] calldata) external view returns (bool) {
        return answer;
    }
}

contract CloakFundsGateTest is Test {
    CloakFundsGate gate;
    MockVault gv;
    MockVault lv;
    MockFundsVerifier fv;
    address constant HYPE = address(0);
    address w1 = address(0xA1);
    address w2 = address(0xA2);
    uint256 id;
    uint64 closes;
    bytes32 constant ROOT = bytes32(uint256(0x1234));

    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;

    function setUp() public {
        vm.warp(1_900_000_000);
        gv = new MockVault();
        lv = new MockVault();
        fv = new MockFundsVerifier();
        gate = new CloakFundsGate(address(fv), address(gv), address(lv));
        closes = uint64(block.timestamp + 1 days);
        id = gate.createGate(HYPE, 10e18, closes);
        gv.root(ROOT);
        lv.root(ROOT);
    }

    function _pub(address vault, address wallet, uint256 n0, uint256 n1) internal view returns (uint256[8] memory p) {
        p[0] = uint256(ROOT);
        p[1] = uint256(uint160(HYPE));
        p[2] = 10e18;
        p[3] = gate.contextFor(id, vault, wallet);
        p[4] = n0;
        p[5] = n1;
    }

    function test_verifierString() public view {
        string memory s = gate.verifierString(id, address(0xABCD00000000000000000000000000000000eF12));
        assertEq(s, string.concat("cloak.gate.v1:", vm.toLowercase(vm.toString(address(gate))), ":0:0xabcd00000000000000000000000000000000ef12"));
    }

    function test_enterAndConfirm() public {
        gate.enter(id, address(gv), w1, a, b, c, _pub(address(gv), w1, 11, 12));
        assertTrue(gate.isEligible(id, w1));
        assertFalse(gate.isEligible(id, w2));
        vm.expectRevert(CloakFundsGate.NotClosed.selector);
        gate.confirm(id, w1);
        vm.warp(closes + 1);
        gate.confirm(id, w1);
        assertTrue(gate.isConfirmed(id, w1));
        // once confirmed, spending is free
        gv.spend(bytes32(uint256(11)));
        assertTrue(gate.isEligible(id, w1));
        (,,,, uint32 entered, uint32 confirmed) = gate.gates(id);
        assertEq(entered, 1);
        assertEq(confirmed, 1);
        address[] memory ws = gate.wallets(id, 0, 10);
        assertEq(ws.length, 1);
        assertEq(ws[0], w1);
    }

    function test_launchVaultProofsCount() public {
        gate.enter(id, address(lv), w1, a, b, c, _pub(address(lv), w1, 11, 0));
        assertTrue(gate.isEligible(id, w1));
    }

    function test_sameNotesCantQualifyTwoWallets() public {
        gate.enter(id, address(gv), w1, a, b, c, _pub(address(gv), w1, 11, 12));
        uint256[8] memory q1 = _pub(address(gv), w2, 12, 0);
        vm.expectRevert(CloakFundsGate.NotesUsed.selector);
        gate.enter(id, address(gv), w2, a, b, c, q1);
    }

    function test_movingTheNotesDropsTheWallet() public {
        gate.enter(id, address(gv), w1, a, b, c, _pub(address(gv), w1, 11, 12));
        gv.spend(bytes32(uint256(12)));
        assertFalse(gate.isEligible(id, w1));
        vm.warp(closes + 1);
        vm.expectRevert(CloakFundsGate.NotesSpent.selector);
        gate.confirm(id, w1);
    }

    function test_proofForAnotherWalletFails() public {
        uint256[8] memory q2 = _pub(address(gv), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(gv), w2, a, b, c, q2);
    }

    function test_proofForAnotherVaultFails() public {
        uint256[8] memory q3 = _pub(address(gv), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(lv), w1, a, b, c, q3);
        uint256[8] memory q4 = _pub(address(0xBAD), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.BadVault.selector);
        gate.enter(id, address(0xBAD), w1, a, b, c, q4);
    }

    function test_proofForAnotherGateFails() public {
        uint256 id2 = gate.createGate(HYPE, 10e18, closes);
        uint256[8] memory p = _pub(address(gv), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id2, address(gv), w1, a, b, c, p);
    }

    function test_checks() public {
        uint256[8] memory p = _pub(address(gv), w1, 11, 0);
        p[2] = 9e18;
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(gv), w1, a, b, c, p);
        p = _pub(address(gv), w1, 11, 0);
        p[1] = 1;
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(gv), w1, a, b, c, p);
        p = _pub(address(gv), w1, 11, 0);
        p[0] = 0xdead;
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(gv), w1, a, b, c, p);
        gv.spend(bytes32(uint256(11)));
        uint256[8] memory q5 = _pub(address(gv), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.NotesSpent.selector);
        gate.enter(id, address(gv), w1, a, b, c, q5);
        fv.set(false);
        uint256[8] memory q6 = _pub(address(gv), w1, 13, 0);
        vm.expectRevert(CloakFundsGate.BadProof.selector);
        gate.enter(id, address(gv), w1, a, b, c, q6);
        // a failed proof leaves its notes unused
        fv.set(true);
        gate.enter(id, address(gv), w1, a, b, c, _pub(address(gv), w1, 13, 0));
        uint256[8] memory q7 = _pub(address(gv), w1, 14, 0);
        vm.expectRevert(CloakFundsGate.AlreadyIn.selector);
        gate.enter(id, address(gv), w1, a, b, c, q7);
    }

    function test_closedGate() public {
        vm.warp(closes + 1);
        uint256[8] memory p = _pub(address(gv), w1, 11, 0);
        vm.expectRevert(CloakFundsGate.Closed.selector);
        gate.enter(id, address(gv), w1, a, b, c, p);
        vm.expectRevert(CloakFundsGate.NotIn.selector);
        gate.confirm(id, w1);
    }

    function test_badGates() public {
        vm.expectRevert(CloakFundsGate.BadGate.selector);
        gate.createGate(HYPE, 0, closes);
        vm.expectRevert(CloakFundsGate.BadGate.selector);
        gate.createGate(HYPE, 1, uint64(block.timestamp));
        uint256[8] memory p;
        vm.expectRevert(CloakFundsGate.BadGate.selector);
        gate.enter(9, address(gv), w1, a, b, c, p);
    }
}

contract CloakReceiptCheckTest is Test {
    CloakReceiptCheck rc;
    MockVault gv;
    MockVault lv;
    MockReceiptVerifier rv;
    address constant ASSET = address(0xA55E7);
    bytes32 constant ROOT = bytes32(uint256(0x1234));
    bytes32 constant NOTE = bytes32(uint256(0xC0));
    uint64 exp;
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;

    function setUp() public {
        vm.warp(1_900_000_000);
        gv = new MockVault();
        lv = new MockVault();
        rv = new MockReceiptVerifier();
        rc = new CloakReceiptCheck(address(rv), address(gv), address(lv));
        exp = uint64(block.timestamp + 1 days);
        gv.root(ROOT);
        gv.see(NOTE);
    }

    function _pub(bool reveal, uint256 amount, uint256 minAmount) internal view returns (uint256[7] memory p) {
        p[0] = uint256(ROOT);
        p[1] = uint256(NOTE);
        p[2] = uint256(uint160(ASSET));
        p[3] = minAmount;
        p[4] = reveal ? 1 : 0;
        p[5] = reveal ? amount : 0;
        p[6] = rc.contextFor(address(gv), exp, "shop #1");
    }

    function test_hiddenAmount() public view {
        (bool ok, uint256 amount, bytes32 commitment) = rc.check(address(gv), a, b, c, _pub(false, 0, 50), ASSET, 50, exp, "shop #1");
        assertTrue(ok);
        assertEq(amount, 0);
        assertEq(commitment, NOTE);
        (ok,,) = rc.check(address(gv), a, b, c, _pub(false, 0, 50), ASSET, 51, exp, "shop #1");
        assertFalse(ok);
    }

    function test_shownAmount() public view {
        (bool ok, uint256 amount,) = rc.check(address(gv), a, b, c, _pub(true, 75, 75), ASSET, 60, exp, "shop #1");
        assertTrue(ok);
        assertEq(amount, 75);
    }

    function test_refusals() public {
        uint256[7] memory p = _pub(false, 0, 50);
        (bool ok,,) = rc.check(address(gv), a, b, c, p, ASSET, 50, exp, "shop #2");
        assertFalse(ok, "another reader");
        (ok,,) = rc.check(address(lv), a, b, c, p, ASSET, 50, exp, "shop #1");
        assertFalse(ok, "another vault");
        (ok,,) = rc.check(address(0xBAD), a, b, c, p, ASSET, 50, exp, "shop #1");
        assertFalse(ok, "not a vault");
        (ok,,) = rc.check(address(gv), a, b, c, p, address(0x1), 50, exp, "shop #1");
        assertFalse(ok, "another asset");
        p[1] = 0xC1;
        (ok,,) = rc.check(address(gv), a, b, c, p, ASSET, 50, exp, "shop #1");
        assertFalse(ok, "a note the vault never had");
        p = _pub(false, 0, 50);
        rv.set(false);
        (ok,,) = rc.check(address(gv), a, b, c, p, ASSET, 50, exp, "shop #1");
        assertFalse(ok, "a bad proof");
        rv.set(true);
        vm.warp(exp + 1);
        (ok,,) = rc.check(address(gv), a, b, c, p, ASSET, 50, exp, "shop #1");
        assertFalse(ok, "expired");
    }
}
