// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivateBatcherTest} from "./PrivateBatcher.t.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {SharedVault} from "../src/shielded/SharedVault.sol";
import {CloakReceive, ReceiveBox} from "../src/shielded/CloakReceive.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Vm} from "forge-std/Vm.sol";

/// Private receive addresses: a plain transfer to an address derived offline becomes the owner's note in the vault.
contract CloakReceiveTest is PrivateBatcherTest {
    CloakReceive rx;
    MockUSDC usdc;
    ShieldedPool usdcPool;
    address keeper = makeAddr("keeper");
    uint256 rescuerKey = 0xA11CE;

    function setUp() public override {
        super.setUp();
        rx = new CloakReceive(router.vaults(), SharedVault(address(0)), whype);
        usdc = new MockUSDC();
        config.approveAsset(address(usdc));
        usdcPool = router.vaults().createAssetPool(address(usdc));
    }

    function _p(uint256 pubKey) internal view returns (CloakReceive.Params memory) {
        return CloakReceive.Params(pubKey, 4242, hex"aabbcc", 100, vm.addr(rescuerKey));
    }

    function test_hypeSentBeforeTheBoxExistsBecomesTheOwnersNote() public {
        CloakReceive.Params memory p = _p(77);
        address a = rx.addressOf(p);
        assertEq(a.code.length, 0, "nothing deployed yet");
        vm.deal(address(this), 10 ether);
        (bool ok,) = a.call{value: 2 ether}(""); // an exchange withdrawal: a plain transfer
        assertTrue(ok);
        uint256 before = hypePool.deposited();
        vm.prank(keeper);
        uint256 c = rx.deliver(p, address(0), 0.01 ether);
        assertEq(hypePool.deposited() - before, 1.99 ether, "the rest is in the vault");
        assertEq(c, hypePool.hasher3().poseidon([uint256(1.99 ether), 77, 4242]), "as exactly the owner's note");
        assertEq(whype.balanceOf(keeper), 0.01 ether, "the deliverer kept its fee");
        assertEq(a.balance, 0);
        assertGt(a.code.length, 0, "the box exists now");
    }

    function test_theMemoCarriesTheAmountInClearThenTheOwnersPart() public {
        CloakReceive.Params memory p = _p(78);
        vm.deal(rx.addressOf(p), 1 ether);
        vm.recordLogs();
        rx.deliver(p, address(0), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hypePool) || logs[i].topics[0] != keccak256("NewCommitment(uint256,uint256,bytes)")) continue;
            (uint256 c,, bytes memory memo) = abi.decode(logs[i].data, (uint256, uint256, bytes));
            assertEq(c, hypePool.hasher3().poseidon([uint256(1 ether), 78, 4242]));
            assertEq(memo, bytes.concat(bytes1(0x02), bytes16(uint128(1 ether)), hex"aabbcc"), "the same memo format as the routers");
            found = true;
        }
        assertTrue(found);
    }

    function test_theFeeIsCapped() public {
        CloakReceive.Params memory p = _p(79);
        vm.deal(rx.addressOf(p), 1 ether);
        vm.expectRevert(CloakReceive.FeeTooHigh.selector);
        rx.deliver(p, address(0), 0.0101 ether); // 1.01% > 1%
        p.maxFeeBps = 501;
        vm.deal(rx.addressOf(p), 1 ether);
        vm.expectRevert(CloakReceive.FeeTooHigh.selector);
        rx.deliver(p, address(0), 0);
    }

    function test_nobodyCanDeliverToADifferentNote() public {
        CloakReceive.Params memory p = _p(80);
        vm.deal(rx.addressOf(p), 1 ether);
        CloakReceive.Params memory q = _p(81); // someone else's key
        q.memo = p.memo;
        vm.expectRevert(CloakReceive.NothingToDeliver.selector);
        rx.deliver(q, address(0), 0);
        assertEq(rx.addressOf(p).balance, 1 ether, "still there for its owner");
    }

    function test_aSecondPaymentToTheSameAddressIsAnotherNote() public {
        CloakReceive.Params memory p = _p(82);
        address a = rx.addressOf(p);
        vm.deal(a, 1 ether);
        rx.deliver(p, address(0), 0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = a.call{value: 0.5 ether}(""); // the box accepts HYPE once deployed too
        assertTrue(ok);
        uint256 before = hypePool.deposited();
        rx.deliver(p, address(0), 0);
        assertEq(hypePool.deposited() - before, 0.5 ether);
        vm.expectRevert(CloakReceive.NothingToDeliver.selector);
        rx.deliver(p, address(0), 0);
    }

    function test_tokensWithAVaultArriveToo() public {
        CloakReceive.Params memory p = _p(83);
        usdc.mint(rx.addressOf(p), 250e6);
        rx.deliver(p, address(usdc), 0);
        assertEq(usdcPool.deposited(), 250e6);
    }

    function test_depositCapsStillApply() public {
        config.turnOnDepositLimits();
        config.setLimit(address(usdc), 100e6, 1_000e6);
        CloakReceive.Params memory p = _p(84);
        usdc.mint(rx.addressOf(p), 250e6);
        vm.expectRevert(ShieldedPool.OverDepositLimit.selector);
        rx.deliver(p, address(usdc), 0);
        assertEq(usdc.balanceOf(rx.addressOf(p)), 250e6, "safe in the address until it fits");
    }

    function _rescueSig(CloakReceive.Params memory p, address target, bytes memory data, uint256 nonce, uint256 key) internal view returns (bytes memory) {
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak256("CloakReceive"), block.chainid, address(rx)));
        bytes32 h = keccak256(abi.encode(rx.RESCUE_TYPEHASH(), rx.addressOf(p), target, uint256(0), keccak256(data), nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, h)));
        return abi.encodePacked(r, s, v);
    }

    function test_somethingTheVaultsCantTakeIsRescuedByItsOwnerOnly() public {
        CloakReceive.Params memory p = _p(85);
        MockUSDC odd = new MockUSDC(); // no vault for it
        odd.mint(rx.addressOf(p), 5e6);
        vm.expectRevert(CloakReceive.NoVault.selector);
        rx.deliver(p, address(odd), 0);
        address to = makeAddr("owner's fresh wallet");
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", to, 5e6);
        bytes memory wrong = _rescueSig(p, address(odd), data, 0, 0xB0B); // someone else's key
        bytes memory sig = _rescueSig(p, address(odd), data, 0, rescuerKey);
        vm.expectRevert(CloakReceive.BadSignature.selector);
        rx.rescue(p, address(odd), 0, data, wrong);
        vm.prank(keeper); // anyone may submit it
        rx.rescue(p, address(odd), 0, data, sig);
        assertEq(odd.balanceOf(to), 5e6);
        vm.expectRevert(CloakReceive.BadSignature.selector);
        rx.rescue(p, address(odd), 0, data, sig); // and it can't be replayed
    }

    function test_onlyTheFactoryCanMoveABoxsFunds() public {
        CloakReceive.Params memory p = _p(86);
        vm.deal(rx.addressOf(p), 1 ether);
        rx.deliver(p, address(0), 0); // deploys it
        vm.deal(rx.addressOf(p), 1 ether);
        ReceiveBox box = ReceiveBox(payable(rx.addressOf(p)));
        vm.expectRevert(bytes("factory"));
        box.sweep(address(0));
        vm.expectRevert(bytes("factory"));
        box.exec(address(this), 1 ether, "");
    }
}
