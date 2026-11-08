// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {stdJson} from "forge-std/Test.sol";
import {PoolKey as V4Key} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {IVerifier} from "gloam/interfaces/IVerifier.sol";
import {PoolKey} from "gloam/GloamVaultSwapV4.sol";
import {CloakLaunchVault} from "cloak-gloam/CloakLaunchVault.sol";
import {CloakLaunchSwapBase} from "cloak-gloam/CloakLaunchSwap.sol";
import {CloakLaunchSwapV4} from "cloak-gloam/CloakLaunchSwapV4.sol";
import {CloakV4Test} from "./CloakV4.t.sol";

contract YesV is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// The unshield "proof" names the `to` it was made for, as a real proof binds it.
contract ToV is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

contract WHYPE {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        payable(msg.sender).transfer(a);
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/**
 * CloakLaunchSwapV4 on the real v4 PoolManager, on a real Cloak launch: the factory opens the launch's pool behind
 * Cloak's own hook when the auction settles, CloakLaunchVault admits the token, and notes trade privately through
 * that hooked pool. Inherits CloakV4Test's launch setup (its own tests run here too).
 */
contract CloakLaunchSwapV4Test is CloakV4Test {
    using stdJson for string;

    CloakLaunchVault lv;
    CloakLaunchSwapV4 router;
    WHYPE whype;
    address owner = address(0x0A11CE);
    uint256 ownerPk = 0x0A11CE;

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    function _setUpVault() internal {
        _launch(0);
        _bidAndSettle();
        whype = new WHYPE();
        lv = new CloakLaunchVault(_poseidon(), address(new ToV()), address(factory), 1e30, 1e32, address(0));
        lv.setShieldVerifier(address(new YesV()));
        lv.setWithdrawFee(50, address(0xFEE));
        lv.turnOnDepositLimits();
        lv.setDepositLimit(address(0), 1_000 ether, 100_000 ether);
        lv.endSetup();
        lv.admitLaunch(0);
        router = new CloakLaunchSwapV4(address(lv), address(pm), address(whype), address(hook));
        // notes: 5 x 1 HYPE, and one of 2,000 launch tokens
        vm.deal(address(this), 100 ether);
        for (uint256 i = 0; i < 5; i++) lv.shieldBound{value: 1 ether}(address(0), 1 ether, bytes32(0xE0 + i), hex"00");
        deal(address(token), address(this), 2_000e18);
        token.approve(address(lv), type(uint256).max);
        lv.shieldBound(address(token), 2_000e18, bytes32(uint256(0x70)), hex"00");
    }

    function _key() internal view returns (PoolKey memory k) {
        V4Key memory v = hook.keyFor(address(token));
        k = PoolKey(Currency.unwrap(v.currency0), Currency.unwrap(v.currency1), v.fee, v.tickSpacing, address(v.hooks));
    }

    function _route(PoolKey memory k) internal pure returns (bytes memory) {
        PoolKey[] memory hops = new PoolKey[](1);
        hops[0] = k;
        return abi.encode(hops);
    }

    function _swap(bytes32 n, address assetIn, uint256 amountIn, address assetOut, uint256 amountOut, bytes memory route)
        internal
        returns (bytes32 id, uint256 left)
    {
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), n, assetIn, amountIn);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", keccak256(abi.encode(n, "out")), assetOut, amountOut);
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, route, owner, deadline)));
        return router.swap(s, d, route, owner, deadline);
    }

    function test_privateBuyOnTheLaunchPool() public {
        _setUpVault();
        PoolKey memory k = _key();
        assertEq(k.hooks, address(hook), "the launch's pool is behind Cloak's hook");
        assertTrue(router.poolAllowed(k), "and is usable at once, with no 3-day wait");
        uint256 before = lv.deposited(address(token));
        (bytes32 id, uint256 left) = _swap(bytes32(uint256(1)), address(0), 1 ether, address(token), 300e18, _route(k));
        assertEq(lv.deposited(address(token)) - before, 300e18, "exactly 300 tokens deposited as the new note");
        assertGt(left, 0, "a buffer is left");
        (address asset, address key, uint256 amount) = router.owed(id);
        assertEq(asset, address(0));
        assertEq(key, owner);
        assertEq(amount, left, "and owed back to the trader");
        assertEq(address(router).balance, left);
    }

    function test_privateSellOnTheLaunchPool() public {
        _setUpVault();
        uint256 before = lv.deposited(address(0));
        (bytes32 id, uint256 left) = _swap(bytes32(uint256(0x70)), address(token), 2_000e18, address(0), 1 ether, _route(_key()));
        assertEq(lv.deposited(address(0)) - before, 1 ether, "exactly 1 HYPE deposited as the new note");
        (address asset,, uint256 amount) = router.owed(id);
        assertEq(asset, address(token));
        assertEq(amount, left);
    }

    function test_onlyNoHookOrCloaksHook() public {
        _setUpVault();
        PoolKey memory bad = _key();
        bad.hooks = address(0xBAD);
        assertFalse(router.poolAllowed(bad));
        bytes memory route = _route(bad);
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), bytes32(uint256(2)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xD2)), address(token), 300e18);
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, route, owner, deadline)));
        vm.expectRevert(abi.encodeWithSelector(CloakLaunchSwapV4.HookNotAllowed.selector, address(0xBAD)));
        router.swap(s, d, route, owner, deadline);
        PoolKey memory plain = _key();
        plain.hooks = address(0);
        assertTrue(router.poolAllowed(plain), "a pool with no hook is allowed");
        PoolKey memory unsorted = _key();
        (unsorted.currency0, unsorted.currency1) = (unsorted.currency1, unsorted.currency0);
        assertFalse(router.poolAllowed(unsorted), "unsorted currencies are not a v4 pool");
    }

    function test_greedyBuyRevertsWhole() public {
        _setUpVault();
        bytes memory route = _route(_key());
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", lv.currentRoot(), bytes32(uint256(3)), address(0), 1 ether);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xD3)), address(token), 900e18);
        uint256 deadline = block.timestamp + 600;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, route, owner, deadline)));
        vm.expectRevert();
        router.swap(s, d, route, owner, deadline);
        assertFalse(lv.isSpent(bytes32(uint256(3))), "the note stays unspent");
    }

    function test_onlyThePoolManagerCallsBack() public {
        _setUpVault();
        vm.expectRevert(CloakLaunchSwapV4.NotPoolManager.selector);
        router.unlockCallback("");
    }

    function test_noExitToThePoolManager() public {
        _setUpVault();
        (bytes32 id,) = _swap(bytes32(uint256(1)), address(0), 1 ether, address(token), 300e18, _route(_key()));
        (uint8 v, bytes32 r, bytes32 s2) = vm.sign(ownerPk, router.exitDigest(id, address(pm)));
        vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
        router.exit(id, address(pm), abi.encodePacked(r, s2, v));
    }

    receive() external payable {}
}
