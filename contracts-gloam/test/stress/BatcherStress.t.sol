// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson, console2} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakGloamBatcher, CloakGloamBatcherBase} from "../../src/CloakGloamBatcher.sol";
import {TestToken} from "../../src/TestToken.sol";
import {AcceptVerifier, ToBindingVerifier, WETH9, V2Factory, V2Pair} from "../CloakV2PairSwap.t.sol";

/// A token that lies to one address (its own V2 pair): after each transfer into the pair, the pair's balance reads
/// 1e30 higher than it is, so the pair's K check passes and it pays out its whole WHYPE side. Used to show a hostile
/// token can only spend its own pool's HYPE, never HYPE the batcher holds for other tokens' rounds.
contract LyingToken {
    mapping(address => uint256) internal bal;
    address public liar;
    uint256 public bonus;

    function lieTo(address a) external {
        liar = a;
    }

    function mint(address to, uint256 amount) external {
        bal[to] += amount;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a == liar ? bal[a] + bonus : bal[a];
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(bal[msg.sender] >= amount, "balance");
        bal[msg.sender] -= amount;
        bal[to] += amount;
        if (to == liar && liar != address(0)) bonus += 1e30;
        return true;
    }
}

/**
 * Stress tests on CloakGloamBatcher (the V2 venue of CloakGloamBatcherBase, which the v4 venue shares).
 * Settings match the live v4 batcher: 60 s rounds, 2% band, 600 s refund window.
 */
contract BatcherStressTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    CloakGloamBatcher batcher;
    V2Factory factory;
    WETH9 weth;
    TestToken launch;
    V2Pair pair;
    uint256 ownerPk = 0x0B1D;
    address owner;
    address fallbackTo = address(0xFA11);
    address attacker = address(0xA77AC);
    uint256 constant ROUND = 60;
    uint256 constant REFUND_AFTER = 600;
    uint256 nonce;
    /// a nullifier anyone saw spent on chain (any earlier withdrawal)
    bytes32 constant SPENT = bytes32(uint256(0x5BE7));

    function setUp() public {
        vm.warp(1_900_000_020);
        owner = vm.addr(ownerPk);
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
        vm.deal(address(this), 100_000e18);
        _seedPool(100e18, 100_000e18); // 1 HYPE = 1000 LNCH
        batcher = new CloakGloamBatcher(address(pool), address(factory), address(weth), ROUND, 200, REFUND_AFTER);
        launch.mint(address(this), 1e30);
        launch.approve(address(pool), type(uint256).max);
        // one public withdrawal, so SPENT is a spent nullifier
        pool.shieldBound{value: 1e18}(address(0), 1e18, bytes32(uint256(0xDEAD01)), hex"00");
        pool.unshield(abi.encode(address(0xCAFE)), pool.currentRoot(), SPENT, address(0), address(0xCAFE), 1e18);
        vm.deal(attacker, 1000e18);
    }

    receive() external payable {}

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
    }

    function _seedPool(uint256 h, uint256 t) internal {
        weth.deposit{value: h}();
        weth.transfer(address(pair), h);
        launch.mint(address(pair), t);
        pair.sync();
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    /// An honest order: a vault note of `size`, its unshield proof naming the order's escrow, sent by a relayer.
    function _honest(bool buy, uint128 size) internal returns (CloakGloamBatcherBase.OrderKey memory k, bytes32 id) {
        bytes32 c = keccak256(abi.encode("note", ++nonce));
        if (buy) pool.shieldBound{value: size}(address(0), size, c, hex"00");
        else pool.shieldBound(address(launch), size, c, hex"00");
        k = CloakGloamBatcherBase.OrderKey(keccak256(abi.encode("nul", nonce)), address(launch), buy, size, owner, fallbackTo);
        id = batcher.place(_spend(k), k);
    }

    function _spend(CloakGloamBatcherBase.OrderKey memory k) internal view returns (CloakGloamBatcherBase.Spend memory) {
        return CloakGloamBatcherBase.Spend(abi.encode(batcher.escrowFor(k)), pool.currentRoot(), k.nullifier, k.buy ? address(0) : k.token, k.size);
    }

    /// An order paid from outside the vault: reuse any spent nullifier, fund the escrow directly, then place().
    /// `size` only has to be a standard number; what lands (`amount`) can be anything.
    function _outsideOrder(address token, bool buy, uint256 amount, uint256 salt)
        internal
        returns (CloakGloamBatcherBase.OrderKey memory k, bytes32 id)
    {
        k = CloakGloamBatcherBase.OrderKey(SPENT, token, buy, 1, vm.addr(ownerPk + salt), attacker);
        address escrow = batcher.escrowFor(k);
        vm.startPrank(attacker);
        if (buy) {
            (bool ok, ) = escrow.call{value: amount}("");
            require(ok, "fund");
        } else {
            TestToken(token).transfer(escrow, amount);
        }
        CloakGloamBatcherBase.Spend memory s = CloakGloamBatcherBase.Spend(hex"", bytes32(0), SPENT, buy ? address(0) : token, 1);
        id = batcher.place(s, k);
        vm.stopPrank();
    }

    function _out(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        uint256 x = amountIn * 997;
        return (x * rOut) / (rIn * 1000 + x);
    }

    function _reserves() internal view returns (uint256 rH, uint256 rT) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        (rH, rT) = pair.token0() == address(weth) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// A plain market swap on the pair by `who` (WHYPE in for tokens, or tokens in for WHYPE).
    function _marketSwap(address who, bool hypeIn, uint256 amountIn) internal returns (uint256 out) {
        (uint256 rH, uint256 rT) = _reserves();
        bool hypeIs0 = pair.token0() == address(weth);
        vm.startPrank(who);
        if (hypeIn) {
            out = _out(amountIn, rH, rT);
            weth.transfer(address(pair), amountIn);
            pair.swap(hypeIs0 ? 0 : out, hypeIs0 ? out : 0, who, "");
        } else {
            out = _out(amountIn, rT, rH);
            launch.transfer(address(pair), amountIn);
            pair.swap(hypeIs0 ? out : 0, hypeIs0 ? 0 : out, who, "");
        }
        vm.stopPrank();
    }

    function _claim(CloakGloamBatcherBase.OrderKey memory k, uint256 pk, uint256 c) internal returns (uint256 amount) {
        bytes32 id = batcher.idOf(k);
        address asset;
        (asset, amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, batcher.claimDigest(id, bytes32(c)));
        batcher.claim(k, CloakGloamBatcherBase.Deposit(hex"00", bytes32(c), asset, amount), abi.encodePacked(r, s, v));
    }

    function _startOfNextRound() internal {
        vm.warp((block.timestamp / ROUND + 1) * ROUND);
    }

    // ── C-01: the opening band can be pinned by a 1-wei first order, so every round is refunded ──────────────────────

    /// C-01, fixed: the attacker pushes the pool ~3%, places the round's first order (now a real note of at least
    /// MIN_SIZE: an outside 1-wei order is refused) and pushes back, in one go. The opening spot is pinned, but the
    /// round is also checked against a time-weighted reference from before it, which one transaction can't move, so the
    /// round settles for the honest traders.
    function test_batcher_openingBandGrief_fixed_roundStillSettles() public {
        batcher.checkpoint(address(launch)); // price history (the keeper keeps it for quiet tokens)
        vm.warp(block.timestamp + 2 * ROUND);
        batcher.checkpoint(address(launch));
        vm.prank(attacker);
        weth.deposit{value: 100e18}();
        for (uint256 r = 0; r < 3; r++) {
            _startOfNextRound();
            uint64 round = batcher.currentRound();
            uint256 got = _marketSwap(attacker, true, 1.5e18); // push ~3%
            _honest(true, 1e15); // the attacker's tiny first order: pins spotStart
            _marketSwap(attacker, false, got); // push back
            vm.warp(block.timestamp + 5);
            (CloakGloamBatcherBase.OrderKey memory b1, ) = _honest(true, 1e18);
            (CloakGloamBatcherBase.OrderKey memory s1, ) = _honest(false, 1000e18);
            vm.warp(batcher.settleOpens(address(launch), round));
            batcher.settle(address(launch), round);
            assertGt(_claim(b1, ownerPk, 0x1000 + r), 0, "the buyer filled");
            assertGt(_claim(s1, ownerPk, 0x2000 + r), 0, "the seller filled");
        }
    }

    /// C-07, fixed: an order paid from outside the vault (a reused spent nullifier, any amount) is refused.
    function test_batcher_outsideOneWeiOrderRefused() public {
        _startOfNextRound();
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        this.outsideOrder(address(launch), true, 1, 1);
    }

    function outsideOrder(address token, bool buy, uint256 amount, uint256 salt) external {
        _outsideOrder(token, buy, amount, salt);
    }

    // ── C-02: settle can be sandwiched in one transaction, up to the 2% slippage band ────────────────────────────────

    /// C-02, fixed: a push of ~1.8% in the settling transaction (inside the old 2% band) is refused: at settle the pool
    /// must be within 0.5% of the round's average. A push inside 0.5% can still be made, and costs buyers at most that.
    function test_batcher_settleSandwich_fixed() public {
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory b1, ) = _honest(true, 1e18);
        (CloakGloamBatcherBase.OrderKey memory b2, ) = _honest(true, 1e18);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round));
        uint256 snap = vm.snapshotState();
        batcher.settle(address(launch), round);
        uint256 fair = _claim(b1, ownerPk, 0xF1) + _claim(b2, ownerPk, 0xF2);
        vm.revertToState(snap);
        vm.prank(attacker);
        weth.deposit{value: 10e18}();
        uint256 snap2 = vm.snapshotState();
        _marketSwap(attacker, true, 0.9e18); // ~1.8%
        vm.expectRevert(CloakGloamBatcherBase.Slipped.selector);
        batcher.settle(address(launch), round);
        vm.revertToState(snap2);
        uint256 tokens = _marketSwap(attacker, true, 0.2e18); // ~0.4%: inside the settle band
        batcher.settle(address(launch), round);
        _marketSwap(attacker, false, tokens);
        uint256 sandwiched = _claim(b1, ownerPk, 0xF1) + _claim(b2, ownerPk, 0xF2);
        console2.log("buyers' tokens, fair / with a 0.4% push:", fair, sandwiched);
        assertGt(sandwiched * 1000, fair * 994, "buyers lose under 0.6%");
    }

    // ── C-03: an order's escrow has no way out if place() can no longer fit the order ─────────────────────────────────

    /// C-03, fixed: the spend is sent alone, the pool shrinks, the order no longer fits: place() now records it as
    /// refund-only, owed its input back, so the escrow's money is claimable at once (and has the timeout exit too).
    function test_batcher_spentAloneEscrow_fixed_refundOnly() public {
        _seedPool(30e18, 30_000e18);
        pool.shieldBound{value: 5e18}(address(0), 5e18, bytes32(uint256(0x5555)), hex"00");
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x5556)), address(launch), true, 5e18, owner, fallbackTo);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        vm.prank(attacker);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), batcher.escrowFor(k), s.amount);
        launch.mint(attacker, 6_000e18);
        _marketSwap(attacker, false, 6_000e18);
        bytes32 id = batcher.place(s, k);
        (address asset, uint256 amount) = batcher.owed(id);
        assertEq(asset, address(0));
        assertEq(amount, 4.975e18, "owed its input back");
        assertEq(_claim(k, ownerPk, 0x5557), 4.975e18, "claimed into the vault as a note");
    }

    // ── C-04: a seller's payout over the vault's per-deposit cap can't be claimed; it waits 30 days ──────────────────

    /// C-04, fixed: a payout over the vault's per-deposit cap comes back as several notes (claimMany).
    function test_batcher_sellPayoutOverHypePerDeposit_fixed_claimMany() public {
        pool.setDepositLimit(address(0), 10e18, 100_000e18);
        _seedPool(900e18, 900_000e18);
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory s1, bytes32 id) = _honest(false, 20_000e18);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round));
        batcher.settle(address(launch), round);
        (address asset, uint256 amount) = batcher.owed(id);
        assertGt(amount, 10e18);
        CloakGloamBatcherBase.Deposit[] memory ds = new CloakGloamBatcherBase.Deposit[](2);
        ds[0] = CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xC1)), asset, 10e18);
        ds[1] = CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xC2)), asset, amount - 10e18);
        bytes32[] memory cs = new bytes32[](2);
        cs[0] = ds[0].commitment;
        cs[1] = ds[1].commitment;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimManyDigest(id, cs));
        batcher.claimMany(s1, ds, abi.encodePacked(r, s, v));
        assertTrue(pool.commitmentSeen(bytes32(uint256(0xC1))) && pool.commitmentSeen(bytes32(uint256(0xC2))), "two notes");
    }

    /// C-05, fixed: the vault's total cap is full, so no claim fits; the owner key can take the payout out in the clear.
    function test_batcher_vaultTotalCapFilled_fixed_signedExit() public {
        pool.setDepositLimit(address(0), 1000e18, 1_000e18);
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory s1, bytes32 id) = _honest(false, 1000e18);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round));
        batcher.settle(address(launch), round);
        uint256 room = 1_000e18 - pool.deposited(address(0));
        vm.deal(attacker, room);
        vm.prank(attacker);
        pool.shieldBound{value: room}(address(0), room, bytes32(uint256(0x3A1E)), hex"00");
        (, uint256 amount) = batcher.owed(id);
        address to = address(0xBEEF01);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.exitDigest(id, to));
        vm.prank(attacker); // anyone may send it
        batcher.exit(s1, to, abi.encodePacked(r, s, v));
        assertEq(to.balance, amount, "paid out at once, to where the owner signed");
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.exit(s1, to, abi.encodePacked(r, s, v)); // once
    }

    // ── C-05: orders paid from outside the vault, with any spent nullifier and any amount ─────────────────────────────

    /// C-07, fixed: outside orders of any amount are refused.
    function test_batcher_outsideOrder_fixed() public {
        _startOfNextRound();
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        this.outsideOrder(address(launch), true, 123_456_789, 1);
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        this.outsideOrder(address(launch), true, 3.3e18, 2);
    }

    // ── C-06: the 4% side cap can be squatted by self-crossing orders ────────────────────────────────────────────────

    /// C-08: squatting both sides now needs real notes (outside orders are refused), each paying the vault's fee.
    function test_batcher_sideCapSquat_needsRealNotes() public {
        launch.mint(attacker, 4_000e18);
        _startOfNextRound();
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        this.outsideOrder(address(launch), true, 4e18, 1);
    }

    // ── held: a hostile token's round can't reach HYPE owed to other rounds ──────────────────────────────────────────

    /// held (and now also refused at the door): a lying token's order paid from outside the vault is refused; an
    /// honest round elsewhere pays in full.
    function test_batcher_hostileTokenOutsideOrderRefused() public {
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory honest, ) = _honest(true, 1e18);
        uint64 hr = batcher.currentRound();
        LyingToken lie = new LyingToken();
        V2Pair lp = factory.create(address(weth), address(lie));
        vm.startPrank(attacker);
        weth.deposit{value: 10e18}();
        weth.transfer(address(lp), 10e18);
        vm.stopPrank();
        lie.mint(address(lp), 10_000e18);
        lp.sync();
        lie.mint(attacker, 400e18);
        vm.expectRevert(CloakGloamBatcherBase.NotStandard.selector);
        this.outsideOrder(address(lie), false, 400e18, 9);
        vm.warp(batcher.settleOpens(address(launch), hr));
        batcher.settle(address(launch), hr);
        assertGt(_claim(honest, ownerPk, 0x4242), 0);
    }

    // ── held: claim / cancel / settle exclusivity and double pay ─────────────────────────────────────────────────────

    function test_batcher_settleCancelExclusiveAndNoDoublePay() public {
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory b1, bytes32 id) = _honest(true, 1e18);
        uint64 round = batcher.currentRound();
        uint256 opens = batcher.settleOpens(address(launch), round);
        vm.warp(opens + REFUND_AFTER - 1);
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.cancel(address(launch), round); // still settleable: no cancel
        batcher.settle(address(launch), round);
        vm.expectRevert(CloakGloamBatcherBase.Done.selector);
        batcher.cancel(address(launch), round);
        _claim(b1, ownerPk, 0x51);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(CloakGloamBatcherBase.Done.selector);
        batcher.exitAfterTimeout(b1); // claimed already
        (, uint256 left) = batcher.owed(id);
        assertEq(left, 0);
    }

    /// An empty round can be "cancelled" by anyone; that harms nobody (no order can join a past round).
    function test_batcher_emptyRoundCancelHarmless() public {
        uint64 round = batcher.currentRound();
        vm.warp((uint256(round) + 1) * ROUND + REFUND_AFTER);
        batcher.cancel(address(launch), round);
        _honest(true, 1e18); // lands in the current round, unaffected
    }

    /// C-13, fixed: a refund window shorter than a round is refused at deploy.
    function test_batcher_zeroRefundWindow_refused() public {
        vm.expectRevert(bytes("params"));
        new CloakGloamBatcher(address(pool), address(factory), address(weth), ROUND, 200, 0);
    }

    // ── info: the fallback isn't checked; a zero fallback burns a timed-out HYPE payout ──────────────────────────────

    /// C-12, fixed: an order with a zero fallback is refused.
    function test_batcher_zeroFallback_refused() public {
        _startOfNextRound();
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x9A)), address(launch), false, 1e18, owner, address(0));
        pool.shieldBound(address(launch), 1e18, bytes32(uint256(0x9B)), hex"00");
        CloakGloamBatcherBase.Spend memory sp = _spend(k);
        vm.expectRevert(CloakGloamBatcherBase.BadKey.selector);
        batcher.place(sp, k);
    }
}
