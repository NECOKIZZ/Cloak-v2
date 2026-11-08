// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson, console2} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakGloamBatcher, CloakGloamBatcherBase} from "../../src/CloakGloamBatcher.sol";
import {CloakGraduation} from "../../src/CloakGraduation.sol";
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

    /// Each round, the attacker (in one transaction) pushes the pool ~3%, places a 1-wei first order paid from outside
    /// the vault (so it pays no vault fee), and pushes the pool back. The round's opening spot is now ~3% off, the
    /// honest average can never be within 2% of it, so the round can only be cancelled. Every honest order is locked
    /// for a round plus the 10-minute refund window, then refunded, having paid the vault's 0.5% fee for nothing.
    function test_batcher_openingBandGrief_oneWeiFirstOrderForcesRefundEveryRound() public {
        vm.prank(attacker);
        weth.deposit{value: 100e18}();
        uint256 attackerStart = weth.balanceOf(attacker);
        uint256 victimFees;
        uint256 rounds = 5;
        for (uint256 r = 0; r < rounds; r++) {
            _startOfNextRound();
            uint64 round = batcher.currentRound();
            // -- the attacker's one transaction --
            uint256 got = _marketSwap(attacker, true, 1.5e18); // push spot ~3%
            _outsideOrder(address(launch), true, 1, r); // 1 wei, first order: pins spotStart
            _marketSwap(attacker, false, got); // push back
            // -- honest traders through the round, at the normal price --
            vm.warp(block.timestamp + 5);
            (CloakGloamBatcherBase.OrderKey memory b1, ) = _honest(true, 1e18);
            (CloakGloamBatcherBase.OrderKey memory s1, ) = _honest(false, 1000e18);
            victimFees += 0.005e18 * 2; // 0.5% of each order's value (1 HYPE each)
            // -- settling is refused for the whole window --
            vm.warp(batcher.settleOpens(address(launch), round));
            vm.expectRevert(CloakGloamBatcherBase.Slipped.selector);
            batcher.settle(address(launch), round);
            vm.warp(block.timestamp + REFUND_AFTER - 1);
            vm.expectRevert(CloakGloamBatcherBase.Slipped.selector);
            batcher.settle(address(launch), round);
            vm.warp(block.timestamp + 1);
            batcher.cancel(address(launch), round);
            assertEq(_claim(b1, ownerPk, 0x1000 + r), 0.995e18, "buyer refunded, less the 0.5% fee");
            assertEq(_claim(s1, ownerPk, 0x2000 + r), 995e18, "seller refunded, less the 0.5% fee");
        }
        uint256 attackerCost = attackerStart - weth.balanceOf(attacker);
        console2.log("attacker cost for", rounds, "rounds (wei HYPE):", attackerCost);
        console2.log("victims' fees lost (wei HYPE):", victimFees);
        // ~0.009 HYPE per round on a 100 HYPE pool (two 0.3% pool fees on a 1.5 HYPE push), plus gas.
        assertLt(attackerCost, (rounds * 1e16), "under 0.01 HYPE per round");
    }

    // ── C-02: settle can be sandwiched in one transaction, up to the 2% slippage band ────────────────────────────────

    /// Anyone may call settle(), so an attacker pushes the pool just inside the 2% band, settles (the round's net buys
    /// at the pushed price, still inside the 5% impact cap measured from the average), and swaps back, all at once.
    function test_batcher_settleSandwich_atomicExtractionFromBuyers() public {
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
        uint256 start = weth.balanceOf(attacker);
        // -- the attacker's one transaction --
        uint256 tokens = _marketSwap(attacker, true, 0.9e18); // spot ~1.8% worse for buyers, inside the 2% band
        batcher.settle(address(launch), round);
        _marketSwap(attacker, false, tokens);
        // --
        uint256 sandwiched = _claim(b1, ownerPk, 0xF1) + _claim(b2, ownerPk, 0xF2);
        uint256 profit = weth.balanceOf(attacker) - start;
        console2.log("buyers' tokens, fair settle:", fair);
        console2.log("buyers' tokens, sandwiched :", sandwiched);
        console2.log("attacker profit (wei HYPE):", profit);
        assertGt(profit, 0, "the sandwich pays");
        assertLt(sandwiched * 1000, fair * 985, "buyers lose more than 1.5% of their tokens");
    }

    // ── C-03: an order's escrow has no way out if place() can no longer fit the order ─────────────────────────────────

    /// The unshield proof in a place() call is public, so anyone can send the spend alone (the vault pays the escrow).
    /// From then on only place() can open the escrow, and place() refuses an order bigger than 4% of the pool's HYPE.
    /// If the pool shrinks (the token's price falls), the order never fits again: no cancel, no claim, no timeout exit.
    function test_batcher_spentAloneEscrow_lockedWhenTheOrderNoLongerFits() public {
        _seedPool(30e18, 30_000e18); // 130 HYPE: the side cap is 5.2 HYPE
        // the victim's app sizes a 5 HYPE order (it fits the room left)
        pool.shieldBound{value: 5e18}(address(0), 5e18, bytes32(uint256(0x5555)), hex"00");
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x5556)), address(launch), true, 5e18, owner, fallbackTo);
        CloakGloamBatcherBase.Spend memory s = _spend(k);
        address escrow = batcher.escrowFor(k);
        // the attacker copies the proof out of the pending place() and sends the spend alone
        vm.prank(attacker);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), escrow, s.amount);
        // and the token dips ~9% (a big seller; for a fresh launch, routine)
        launch.mint(attacker, 6_000e18);
        _marketSwap(attacker, false, 6_000e18);
        (uint256 rH, ) = _reserves();
        assertLt(rH * 400 / 10_000, 4.975e18, "the side cap is now under the order");
        // place() can never land it, in this round or any later one
        for (uint256 i = 0; i < 3; i++) {
            _startOfNextRound();
            vm.expectRevert(CloakGloamBatcherBase.RoundFull.selector);
            batcher.place(s, k);
        }
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(CloakGloamBatcherBase.RoundFull.selector);
        batcher.place(s, k);
        // and nothing else in the batcher can reach it
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.exitAfterTimeout(k);
        assertEq(escrow.balance, 4.975e18, "the order's HYPE sits at its escrow with no exit");
        assertEq(escrow.code.length, 0, "never opened");
    }

    // ── C-04: a seller's payout over the vault's per-deposit cap can't be claimed; it waits 30 days ──────────────────

    /// The partner deploy lists HYPE at 10 per deposit. A claim must be one note of exactly what is owed, so a sell
    /// order worth more than 10 HYPE can't come back privately: it waits EXIT_DELAY (30 days) and then goes to the
    /// fallback address in the clear. (Pool of 1,000 HYPE, so a 20 HYPE order is well inside the 4% side cap.)
    function test_batcher_sellPayoutOverHypePerDeposit_lockedThirtyDaysThenPublic() public {
        pool.setDepositLimit(address(0), 10e18, 100_000e18); // as deploy-partner.mjs
        _seedPool(900e18, 900_000e18); // 1,000 HYPE / 1,000,000 LNCH
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory s1, bytes32 id) = _honest(false, 20_000e18);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round));
        batcher.settle(address(launch), round);
        (address asset, uint256 amount) = batcher.owed(id);
        assertEq(asset, address(0));
        assertGt(amount, 10e18, "the seller is owed more than one deposit's worth of HYPE");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(uint256(0xC1))));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        batcher.claim(s1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xC1)), asset, amount), abi.encodePacked(r, s, v));
        vm.warp(block.timestamp + 30 days - 1);
        vm.expectRevert(CloakGloamBatcherBase.NotYet.selector);
        batcher.exitAfterTimeout(s1);
        vm.warp(block.timestamp + 1);
        batcher.exitAfterTimeout(s1);
        assertEq(fallbackTo.balance, amount, "paid out in the clear, 30 days later");
    }

    /// The same lock, caused on purpose: a whale fills the vault's HYPE total cap with its own notes (refundable, 0.5%
    /// to leave), and every HYPE payout of every settled round (and every cancelled buy's refund) can't be claimed
    /// until there is room again; the only other way out is the 30-day timeout, in the clear.
    function test_batcher_vaultTotalCapFilledBlocksEveryHypeClaim() public {
        pool.setDepositLimit(address(0), 1000e18, 1_000e18); // as deploy-partner.mjs: 1,000 HYPE in total
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory s1, bytes32 id) = _honest(false, 1000e18);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round));
        batcher.settle(address(launch), round);
        // the whale tops the HYPE side up to the cap
        uint256 room = 1_000e18 - pool.deposited(address(0));
        vm.deal(attacker, room);
        vm.prank(attacker);
        pool.shieldBound{value: room}(address(0), room, bytes32(uint256(0x3A1E)), hex"00");
        (address asset, uint256 amount) = batcher.owed(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, batcher.claimDigest(id, bytes32(uint256(0xC2))));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        batcher.claim(s1, CloakGloamBatcherBase.Deposit(hex"00", bytes32(uint256(0xC2)), asset, amount), abi.encodePacked(r, s, v));
    }

    // ── C-05: orders paid from outside the vault, with any spent nullifier and any amount ─────────────────────────────

    /// place() skips the unshield when the nullifier is already spent, without checking it was spent to this escrow.
    /// So anyone can reuse any public spent nullifier, fund the escrow directly with any amount (not a standard size),
    /// and get an order. No vault fee, no note: cheap to pad a round's crowd or to be the first order (C-01).
    function test_batcher_outsideOrder_anySpentNullifierAnyAmount() public {
        _startOfNextRound();
        (, bytes32 id1) = _outsideOrder(address(launch), true, 123_456_789, 1);
        (, bytes32 id2) = _outsideOrder(address(launch), true, 3.3e18, 2);
        (, , , , uint128 net1) = batcher.orders(id1);
        (, , , , uint128 net2) = batcher.orders(id2);
        assertEq(net1, 123_456_789, "a non-standard size");
        assertEq(net2, 3.3e18, "a non-standard size, no vault fee taken");
        // 20 more 1-wei orders pad the round for almost nothing
        for (uint256 i = 0; i < 20; i++) _outsideOrder(address(launch), true, 1, 100 + i);
    }

    /// Graduation has the same shape: its per-round crowd count (roundEntries, which the app waits on) can be padded.
    function test_graduation_outsideEntriesPadTheCrowd() public {
        // a minimal launch vault stand-in is the ShieldPoolPayments `pool`, and Gloam's vault another one
        ShieldPoolPayments gv = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        CloakGraduation grad = new CloakGraduation(address(pool), address(gv), 1 hours);
        launch.mint(attacker, 1000);
        for (uint256 i = 0; i < 10; i++) {
            CloakGraduation.EntryKey memory k = CloakGraduation.EntryKey(SPENT, address(launch), 1, vm.addr(0x1000 + i), attacker);
            vm.startPrank(attacker);
            launch.transfer(grad.escrowFor(k), 1);
            grad.enter(CloakGraduation.Spend(hex"", bytes32(0), SPENT, 1), k);
            vm.stopPrank();
        }
        assertEq(grad.roundEntries(address(launch), grad.currentRound()), 10, "ten 'entries' for 10 wei of tokens");
    }

    // ── C-06: the 4% side cap can be squatted by self-crossing orders ────────────────────────────────────────────────

    /// The attacker fills both sides to the cap with orders paid from outside the vault. They cross each other at the
    /// average with no net trade (so no pool fee), the attacker gets its value back, and honest orders hit RoundFull.
    function test_batcher_sideCapSquat_selfCrossingOrdersBlockHonestOrders() public {
        launch.mint(attacker, 4_000e18);
        _startOfNextRound();
        uint64 round = batcher.currentRound();
        (CloakGloamBatcherBase.OrderKey memory kb, ) = _outsideOrder(address(launch), true, 4e18, 1); // 4% of 100 HYPE
        (CloakGloamBatcherBase.OrderKey memory ks, ) = _outsideOrder(address(launch), false, 4_000e18, 2); // 4% of 100k
        pool.shieldBound{value: 1e18}(address(0), 1e18, bytes32(uint256(0x77)), hex"00");
        CloakGloamBatcherBase.OrderKey memory hk = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x78)), address(launch), true, 1e18, owner, fallbackTo);
        CloakGloamBatcherBase.Spend memory hks = _spend(hk);
        vm.expectRevert(CloakGloamBatcherBase.RoundFull.selector);
        batcher.place(hks, hk);
        pool.shieldBound(address(launch), 1000e18, bytes32(uint256(0x79)), hex"00");
        CloakGloamBatcherBase.OrderKey memory hs = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x7A)), address(launch), false, 1000e18, owner, fallbackTo);
        CloakGloamBatcherBase.Spend memory hss = _spend(hs);
        vm.expectRevert(CloakGloamBatcherBase.RoundFull.selector);
        batcher.place(hss, hs);
        // the squatter's round settles with (almost) nothing traded against the pool
        (uint256 rH0, ) = _reserves();
        vm.warp(batcher.settleOpens(address(launch), round));
        batcher.settle(address(launch), round);
        (uint256 rH1, ) = _reserves();
        assertLt(rH1 > rH0 ? rH1 - rH0 : rH0 - rH1, 1e15, "no net trade");
        (, uint256 tokensBack) = batcher.owed(batcher.idOf(kb));
        (, uint256 hypeBack) = batcher.owed(batcher.idOf(ks));
        assertApproxEqRel(tokensBack, 4_000e18, 1e14, "the squatter gets its value back");
        assertApproxEqRel(hypeBack, 4e18, 1e14, "both sides");
    }

    // ── held: a hostile token's round can't reach HYPE owed to other rounds ──────────────────────────────────────────

    function test_batcher_hostileTokenRoundCantTouchOtherRoundsHype() public {
        // an honest LNCH round owes its buyer 0.995 HYPE (it will be cancelled and refunded)
        _startOfNextRound();
        (CloakGloamBatcherBase.OrderKey memory honest, bytes32 hid) = _honest(true, 1e18);
        uint64 hr = batcher.currentRound();
        // the attacker lists a lying token against WHYPE (its own 10 HYPE pool) and sells it in the same batcher
        LyingToken lie = new LyingToken();
        V2Pair lp = factory.create(address(weth), address(lie));
        vm.startPrank(attacker);
        weth.deposit{value: 10e18}();
        weth.transfer(address(lp), 10e18);
        vm.stopPrank();
        lie.mint(address(lp), 10_000e18);
        lp.sync();
        lie.mint(attacker, 400e18);
        CloakGloamBatcherBase.OrderKey memory ks = CloakGloamBatcherBase.OrderKey(SPENT, address(lie), false, 1, vm.addr(0x7777), attacker);
        vm.startPrank(attacker);
        lie.transfer(batcher.escrowFor(ks), 400e18);
        batcher.place(CloakGloamBatcherBase.Spend(hex"", bytes32(0), SPENT, address(lie), 1), ks);
        vm.stopPrank();
        uint64 lr = batcher.currentRound();
        lie.lieTo(address(lp)); // from now on the pair is fooled
        vm.warp(batcher.settleOpens(address(lie), lr));
        batcher.settle(address(lie), lr);
        (, uint256 owedLiar) = batcher.owed(batcher.idOf(ks));
        console2.log("liar's round owes its sellers (wei HYPE):", owedLiar);
        assertLe(owedLiar, 10e18, "at most its own pool's HYPE");
        // the honest round is cancelled after its window and pays in full
        vm.warp(batcher.settleOpens(address(launch), hr) + REFUND_AFTER);
        batcher.cancel(address(launch), hr);
        (, uint256 owedHonest) = batcher.owed(hid);
        assertGe(address(batcher).balance, owedHonest + owedLiar, "the batcher still holds what it owes");
        assertEq(_claim(honest, ownerPk, 0x4242), 0.995e18);
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

    /// info: the constructor takes refundAfter = 0, and then no round can ever settle (always TooLate): a deploy typo
    /// turns the batcher into a refund machine that still takes the vault's 0.5% on the way in.
    function test_batcher_zeroRefundWindowNeverSettles() public {
        CloakGloamBatcher b0 = new CloakGloamBatcher(address(pool), address(factory), address(weth), ROUND, 200, 0);
        batcher = b0;
        _startOfNextRound();
        _honest(true, 1e18);
        uint64 round = b0.currentRound();
        vm.warp(b0.settleOpens(address(launch), round));
        vm.expectRevert(CloakGloamBatcherBase.TooLate.selector);
        b0.settle(address(launch), round);
        b0.cancel(address(launch), round);
    }

    // ── info: the fallback isn't checked; a zero fallback burns a timed-out HYPE payout ──────────────────────────────

    function test_batcher_zeroFallbackBurnsTimedOutHype() public {
        _startOfNextRound();
        CloakGloamBatcherBase.OrderKey memory k = CloakGloamBatcherBase.OrderKey(bytes32(uint256(0x9A)), address(launch), false, 1, owner, address(0));
        // a sell order with fallback 0 (Graduation refuses fallback 0; the batcher doesn't)
        pool.shieldBound(address(launch), 1, bytes32(uint256(0x9B)), hex"00");
        batcher.place(_spend(k), k);
        uint64 round = batcher.currentRound();
        vm.warp(batcher.settleOpens(address(launch), round) + REFUND_AFTER);
        batcher.cancel(address(launch), round);
        vm.warp(block.timestamp + 30 days);
        // a token payout to address(0): TestToken allows it, so the token is burned
        batcher.exitAfterTimeout(k);
        assertEq(launch.balanceOf(address(0)), 1, "sent to the zero address");
    }
}
