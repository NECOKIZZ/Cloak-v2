// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {CloakGloamBatcher, CloakGloamBatcherBase} from "../src/CloakGloamBatcher.sol";
import {TestToken} from "../src/TestToken.sol";
import {AcceptVerifier, ToBindingVerifier, WETH9, V2Factory, V2Pair, FreezeToken} from "./CloakV2PairSwap.t.sol";

contract CloakGloamBatcherTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    CloakGloamBatcher batcher;
    V2Factory factory;
    WETH9 weth;
    TestToken launch;
    V2Pair pair;
    uint256 ownerPk = 0x0B1D;
    address fallbackTo = address(0xFA11);
    address mallory = address(0xBAD);
    uint256 constant ROUND = 30;
    uint256 nonce;

    function setUp() public {
        vm.warp(1_900_000_000);
        pool = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        pool.setShieldVerifier(address(new AcceptVerifier()));
        pool.setWithdrawFee(50, address(0xFEE));
        pool.turnOnDepositLimits();
        weth = new WETH9();
        launch = new TestToken("Launch", "LNCH", 18);
        pool.setDepositLimit(address(0), 1000e18, 100_000e18);
        pool.setDepositLimit(address(launch), 1e30, 1e32);
        factory = new V2Factory();
        pair = factory.create(address(weth), address(launch));
        vm.deal(address(this), 1000e18);
        weth.deposit{value: 100e18}();
        weth.transfer(address(pair), 100e18);
        launch.mint(address(pair), 100_000e18); // 1 HYPE = 1000 LNCH
        pair.sync();
        batcher = new CloakGloamBatcher(address(pool), address(factory), address(weth), ROUND, 200, 1 hours);
        // notes to trade: HYPE and LNCH deposits
        for (uint256 i = 0; i < 4; i++) pool.shieldBound{value: 1e18}(address(0), 1e18, bytes32(uint256(0xA0 + i)), hex"00");
        launch.mint(address(this), 10_000e18);
        launch.approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) pool.shieldBound(address(launch), 1000e18, bytes32(uint256(0xB0 + i)), hex"00");
    }

    receive() external payable {}

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
    }

    function _key(bool buy, uint128 size) internal returns (CloakGloamBatcherBase.OrderKey memory k) {
        k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(keccak256(abi.encode(++nonce)))), address(launch), buy, size, vm.addr(ownerPk), fallbackTo);
    }

    function _spend(CloakGloamBatcherBase.OrderKey memory k) internal view returns (CloakGloamBatcherBase.Spend memory) {
        return CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), pool.currentRoot(), k.nullifier, k.buy ? address(0) : address(launch), k.size);
    }

    function _order(bool buy, uint128 size) internal returns (CloakGloamBatcherBase.OrderKey memory k, bytes32 id) {
        k = _key(buy, size);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        vm.prank(mallory); // any relayer
        id = batcher.place(s, k);
    }

    function _claim(CloakGloamBatcherBase.OrderKey memory k, uint256 c) internal returns (uint256 amount) {
        bytes32 id = batcher.idOf(k);
        address asset;
        (asset, amount) = batcher.owed(id);
        bytes32 commitment = bytes32(c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, commitment));
        batcher.claim(k, CloakGloamBatcherBase.Deposit(hex"00", commitment, asset, amount), abi.encodePacked(r, s, v));
    }

    /// @dev To the first moment the current round can settle: it has ended and its average covers a whole round.
    function _endRound() internal {
        _endRound(address(launch));
    }

    function _endRound(address token) internal {
        vm.warp(batcher.settleOpens(token, batcher.currentRound()));
    }

    // ── crossing ───────────────────────────────────────────────────────────

    function test_buys_and_sells_cross_at_spot_and_only_the_net_trades() public {
        (CloakGloamBatcherBase.OrderKey memory b1, ) = _order(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory b2, ) = _order(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory s1, ) = _order(false, 1000e18);
        uint64 round = batcher.currentRound();
        uint256 hBefore = weth.balanceOf(address(pair));
        _endRound();
        batcher.settle(address(launch), round);
        uint256 hAfter = weth.balanceOf(address(pair));
        uint256 moved = hAfter > hBefore ? hAfter - hBefore : hBefore - hAfter;
        assertLt(moved, 1.1e18, "about one HYPE's worth trades against the pool, not three");
        uint256 got1 = _claim(b1, 0x1);
        uint256 got2 = _claim(b2, 0x2);
        assertEq(got1, got2, "every buyer in the round gets the same price");
        uint256 hype = _claim(s1, 0x3);
        assertApproxEqRel(hype, 0.995e18, 0.001e18, "the seller gets spot for its tokens (less the 0.5% fee taken on the way in)");
        assertTrue(pool.commitmentSeen(bytes32(uint256(0x1))) && pool.commitmentSeen(bytes32(uint256(0x3))), "payouts are notes in the vault");
    }

    function test_a_round_of_only_sells() public {
        (CloakGloamBatcherBase.OrderKey memory s1, ) = _order(false, 1000e18);
        uint64 round = batcher.currentRound();
        _endRound();
        batcher.settle(address(launch), round);
        assertGt(_claim(s1, 0x9), 0.9e18);
    }

    // ── entering ───────────────────────────────────────────────────────────

    function test_non_standard_size_is_refused() public {
        CloakGloamBatcherBase.OrderKey memory k = _key(true, 3e18);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        batcher.place(s, k);
    }

    function test_copied_order_with_another_owner_cannot_use_the_proof() public {
        CloakGloamBatcherBase.OrderKey memory k = _key(true, 1e18);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        k.ownerKey = mallory;
        vm.expectRevert(); // another escrow: the proof names the first one
        batcher.place(s, k);
        assertFalse(pool.isSpent(k.nullifier));
    }

    function test_spend_sent_alone_is_picked_up_by_place() public {
        CloakGloamBatcherBase.OrderKey memory k = _key(true, 1e18);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        vm.prank(mallory);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), batcher.escrowFor(k), s.amount);
        batcher.place(s, k);
        (, , , , uint128 net) = batcher.orders(batcher.idOf(k));
        assertEq(net, 0.995e18);
    }

    function test_order_twice_is_refused() public {
        (CloakGloamBatcherBase.OrderKey memory k, ) = _order(true, 1e18);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        vm.expectRevert(CloakGloamBatcherBase.Used.selector);
        batcher.place(s, k);
    }

    // ── leaving ────────────────────────────────────────────────────────────

    function test_claim_must_be_the_exact_amount_and_works_once() public {
        (CloakGloamBatcherBase.OrderKey memory b1, bytes32 id) = _order(true, 1e18);
        uint64 round = batcher.currentRound();
        _endRound();
        batcher.settle(address(launch), round);
        (address asset, uint256 amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(uint256(7))));
        vm.expectRevert(abi.encodeWithSelector(CloakGloamBatcherBase.WrongAmount.selector, amount));
        batcher.claim(b1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(7)), asset, amount + 1), abi.encodePacked(r, s, v));
        batcher.claim(b1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(7)), asset, amount), abi.encodePacked(r, s, v));
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector); // owed is 0 once paid
        batcher.claim(b1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(7)), asset, amount), abi.encodePacked(r, s, v));
    }

    function test_claim_needs_the_owner_signature_for_that_note() public {
        (CloakGloamBatcherBase.OrderKey memory b1, bytes32 id) = _order(true, 1e18);
        uint64 round = batcher.currentRound();
        _endRound();
        batcher.settle(address(launch), round);
        (address asset, uint256 amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(uint256(7))));
        vm.expectRevert(CloakGloamBatcherBase.BadSignature.selector); // mallory's note, the owner's signature for another
        batcher.claim(b1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xBAD)), asset, amount), abi.encodePacked(r, s, v));
    }

    function test_price_moved_too_far_then_cancel_refunds_the_input() public {
        (CloakGloamBatcherBase.OrderKey memory b1, ) = _order(true, 1e18);
        uint64 round = batcher.currentRound();
        _endRound();
        launch.mint(address(pair), 10_000e18); // someone moves the price 10% just before settling
        pair.sync();
        vm.expectRevert(CloakGloamBatcherBase.Slipped.selector); // the pool is far from its average over the round
        batcher.settle(address(launch), round);
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.cancel(address(launch), round);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(CloakGloamBatcherBase.TooLate.selector); // past the settling window: only a cancel now
        batcher.settle(address(launch), round);
        batcher.cancel(address(launch), round);
        assertEq(_claim(b1, 0x11), 0.995e18, "the order's own HYPE back, as a note");
    }

    // ── the crossing price can't be set by one transaction (review, Nov 8) ─────

    function test_a_push_in_the_settling_transaction_doesnt_set_the_price() public {
        _order(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory s1, ) = _order(false, 1000e18);
        uint64 round = batcher.currentRound();
        _endRound();
        // inside the 2% band: 1.5% more tokens per HYPE, pushed in the same transaction as settle
        launch.mint(address(pair), 1500e18);
        pair.sync();
        batcher.settle(address(launch), round);
        uint256 hype = _claim(s1, 0x21);
        // priced at the spot after the push, the seller would get about 0.980 HYPE; at the round's average, 0.995
        assertApproxEqRel(hype, 0.995e18, 0.001e18, "the seller is paid at the round's average, not the pushed spot");
    }

    function test_a_push_in_the_first_orders_block_doesnt_pin_the_price() public {
        // the pool is pushed 1.5%, the first order lands, and the push is undone, all in one block
        launch.mint(address(pair), 1500e18);
        pair.sync();
        _order(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory s1, ) = _order(false, 1000e18);
        vm.prank(address(pair));
        launch.transfer(address(0xdead), 1500e18);
        pair.sync();
        uint64 round = batcher.currentRound();
        _endRound();
        batcher.settle(address(launch), round);
        assertApproxEqRel(_claim(s1, 0x22), 0.995e18, 0.001e18, "a push held for no time doesn't count");
    }

    function test_a_price_held_through_the_round_is_the_price() public {
        _order(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory s1, ) = _order(false, 1000e18);
        uint64 round = batcher.currentRound();
        vm.warp(block.timestamp + 1);
        launch.mint(address(pair), 10_000e18); // the market moves 10% and stays there
        pair.sync();
        _endRound();
        batcher.settle(address(launch), round);
        // held for all but the first second of the window: the seller gets close to the new price
        assertApproxEqRel(_claim(s1, 0x23), uint256(0.995e18) * 1000 / 1100, 0.01e18, "a real move held all round sets the price");
    }

    function test_the_average_always_covers_a_whole_round() public {
        vm.warp((block.timestamp / ROUND + 1) * ROUND - 1); // the last second of a round
        (CloakGloamBatcherBase.OrderKey memory b1, ) = _order(true, 1e18);
        uint64 round = batcher.currentRound();
        vm.warp((uint256(round) + 1) * ROUND); // the round has ended, but its first order is one second old
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.settle(address(launch), round);
        vm.warp(block.timestamp + ROUND - 1);
        batcher.settle(address(launch), round);
        assertGt(_claim(b1, 0x24), 0);
    }

    function test_timeout_exit_pays_the_fallback_once() public {
        (CloakGloamBatcherBase.OrderKey memory b1, bytes32 id) = _order(true, 1e18);
        uint64 round = batcher.currentRound();
        _endRound();
        batcher.settle(address(launch), round);
        (, uint256 amount) = batcher.owed(id);
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.exitAfterTimeout(b1);
        vm.warp(block.timestamp + 30 days);
        vm.prank(mallory);
        batcher.exitAfterTimeout(b1);
        assertEq(launch.balanceOf(fallbackTo), amount);
        vm.expectRevert(CloakGloamBatcherBase.Done.selector);
        batcher.exitAfterTimeout(b1);
    }

    function test_settle_twice_and_settle_early_are_refused() public {
        _order(true, 1e18);
        uint64 round = batcher.currentRound();
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.settle(address(launch), round);
        _endRound();
        batcher.settle(address(launch), round);
        vm.expectRevert(CloakGloamBatcherBase.Done.selector);
        batcher.settle(address(launch), round);
    }

    function test_a_big_round_against_a_thin_pool_refuses_to_fill_badly() public {
        for (uint256 i = 0; i < 1; i++) pool.shieldBound{value: 50e18}(address(0), 50e18, bytes32(uint256(0xC0)), hex"00");
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0xC1)), address(launch), true, 50e18, vm.addr(ownerPk), fallbackTo);
        batcher.place(_spend(k), k);
        uint64 round = batcher.currentRound();
        _endRound();
        vm.expectRevert(CloakGloamBatcherBase.Impact.selector); // half the pool's HYPE: far over 5% impact
        batcher.settle(address(launch), round);
    }

    function test_isStandard() public view {
        assertTrue(batcher.isStandard(1) && batcher.isStandard(2e18) && batcher.isStandard(5e17) && batcher.isStandard(10));
        assertFalse(batcher.isStandard(0) || batcher.isStandard(3) || batcher.isStandard(15e17) || batcher.isStandard(25));
    }

    /// A token that freezes the batcher holds the round's token payouts until it lets go: the HYPE side still pays,
    /// and nothing in the vault is touched. No contract that holds a token can do better against its issuer.
    function test_hostile_token_that_freezes_the_batcher() public {
        FreezeToken z = new FreezeToken();
        pool.setDepositLimit(address(z), 1e30, 1e32);
        V2Pair zp = factory.create(address(weth), address(z));
        weth.deposit{value: 100e18}();
        weth.transfer(address(zp), 100e18);
        z.mint(address(zp), 100_000e18);
        zp.sync();
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0xD1)), address(z), true, 1e18, vm.addr(ownerPk), fallbackTo);
        batcher.place(_spend(k), k);
        uint64 round = batcher.currentRound();
        _endRound(address(z));
        batcher.settle(address(z), round);
        z.freeze(address(batcher), true);
        bytes32 id = batcher.idOf(k);
        (address asset, uint256 amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(uint256(0xD2))));
        vm.expectRevert();
        batcher.claim(k, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xD2)), asset, amount), abi.encodePacked(r, s, v));
        z.freeze(address(batcher), false);
        batcher.claim(k, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xD2)), asset, amount), abi.encodePacked(r, s, v));
        assertTrue(pool.commitmentSeen(bytes32(uint256(0xD2))), "paid once the issuer lets go");
    }
}
