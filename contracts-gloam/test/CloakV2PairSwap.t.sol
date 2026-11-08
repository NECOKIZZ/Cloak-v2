// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {IVerifier} from "gloam/interfaces/IVerifier.sol";
import {GloamVaultSwap2} from "gloam/GloamVaultSwap2.sol";
import {CloakV2PairSwap} from "../src/CloakV2PairSwap.sol";
import {TestToken} from "../src/TestToken.sol";

// ── stand-ins: proofs, WETH, a Uniswap V2 pair and factory, hostile tokens ───────────────────────────────────────────

contract AcceptVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// The unshield "proof" names the `to` it was made for; any other `to` fails, as a real Groth16 proof would.
contract ToBindingVerifier is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

contract WETH9 is TestToken {
    constructor() TestToken("Wrapped HYPE", "WHYPE", 18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        totalSupply -= a;
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "weth send");
    }
}

/// Uniswap V2's pair, cut to the swap: constant product, 0.3% fee, the k check after optimistic transfers.
contract V2Pair {
    address public token0;
    address public token1;
    uint112 r0;
    uint112 r1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    uint32 tLast;
    uint256 public price0CumulativeLast; // Uniswap V2's: token1 per token0, UQ112x112 × seconds
    uint256 public price1CumulativeLast;

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, tLast);
    }

    function sync() public {
        uint32 t = uint32(block.timestamp);
        unchecked {
            if (t != tLast && r0 != 0 && r1 != 0) {
                price0CumulativeLast += ((uint256(r1) << 112) / r0) * (t - tLast);
                price1CumulativeLast += ((uint256(r0) << 112) / r1) * (t - tLast);
            }
        }
        r0 = uint112(TestToken(token0).balanceOf(address(this)));
        r1 = uint112(TestToken(token1).balanceOf(address(this)));
        tLast = t;
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        require(out0 < r0 && out1 < r1, "liquidity");
        if (out0 > 0) TestToken(token0).transfer(to, out0);
        if (out1 > 0) TestToken(token1).transfer(to, out1);
        uint256 b0 = TestToken(token0).balanceOf(address(this));
        uint256 b1 = TestToken(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "input");
        require((b0 * 1000 - in0 * 3) * (b1 * 1000 - in1 * 3) >= uint256(r0) * r1 * 1e6, "K");
        sync();
    }
}

contract V2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function create(address a, address b) external returns (V2Pair p) {
        p = new V2Pair(a, b);
        getPair[a][b] = address(p);
        getPair[b][a] = address(p);
    }
}

/// Takes 1% of every transfer (the vault refuses it as a deposit; as a swap output it arrives short).
contract FeeToken is TestToken {
    constructor() TestToken("Fee", "FEE", 18) {}

    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        totalSupply -= amount / 100;
    }
}

/// An issuer that can freeze any address, including the router or the vault.
contract FreezeToken is TestToken {
    mapping(address => bool) public frozen;

    constructor() TestToken("Freeze", "FRZ", 18) {}

    function freeze(address who, bool on) external {
        frozen[who] = on;
    }

    function _move(address from, address to, uint256 amount) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._move(from, to, amount);
    }
}

// ── the tests ──────────────────────────────────────────────────────────────────────────────────────────────────────

contract CloakV2PairSwapTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    CloakV2PairSwap router;
    V2Factory factory;
    WETH9 weth;
    TestToken usd;
    TestToken launch; // a Cloak launch token
    address treasury = address(0x7EA5);
    address depositor = address(0xD0D0);
    address relayer = address(0x5E1A);
    address mallory = address(0xBAD);
    uint256 exitPk = 0xE817;
    uint256 constant NOTE = 100e6;
    uint256 constant FEE_BPS = 50; // Elysium's 0.5%

    struct Call {
        GloamVaultSwap2.Spend s;
        GloamVaultSwap2.Deposit d;
        GloamVaultSwap2.Deposit r;
        bytes route;
        uint256 deadline;
        address escrow;
        GloamVaultSwap2.EscrowKey k;
    }

    function setUp() public {
        vm.warp(1_900_000_000);
        pool = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        pool.setShieldVerifier(address(new AcceptVerifier()));
        pool.setWithdrawFee(uint16(FEE_BPS), address(0xFEE));
        pool.turnOnDepositLimits();
        weth = new WETH9();
        usd = new TestToken("USDC", "USDC", 6);
        launch = new TestToken("Launch", "LNCH", 18);
        pool.setDepositLimit(address(usd), 500e6, 25_000e6);
        pool.setDepositLimit(address(launch), 1e30, 1e32);
        pool.setDepositLimit(address(0), 1000e18, 100_000e18);
        factory = new V2Factory();
        router = new CloakV2PairSwap(address(pool), treasury, address(factory), address(weth));

        // the notes below are backed by earlier deposits
        usd.mint(depositor, 10_000e6);
        vm.startPrank(depositor);
        usd.approve(address(pool), type(uint256).max);
        for (uint256 i = 0; i < 4; i++) pool.shieldBound(address(usd), NOTE, bytes32(uint256(0xC0FFEE + i)), hex"00");
        vm.deal(depositor, 100e18);
        pool.shieldBound{value: 10e18}(address(0), 10e18, bytes32(uint256(0xE7E7)), hex"00");
        vm.stopPrank();

        // pools: usd/launch (1 launch = 0.5 usd), WHYPE/launch (1 HYPE = 1000 launch)
        _seed(address(usd), address(launch), 100_000e6, 200_000e18);
        vm.deal(address(this), 1000e18);
        weth.deposit{value: 100e18}();
        _seed(address(weth), address(launch), 100e18, 100_000e18);
    }

    receive() external payable {}

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    function _seed(address a, address b, uint256 amtA, uint256 amtB) internal returns (V2Pair p) {
        p = factory.create(a, b);
        if (a != address(weth)) TestToken(a).mint(address(p), amtA);
        else weth.transfer(address(p), amtA);
        TestToken(b).mint(address(p), amtB);
        p.sync();
    }

    function _path(address a, address b) internal pure returns (bytes memory) {
        address[] memory p = new address[](2);
        p[0] = a;
        p[1] = b;
        return abi.encode(p);
    }

    function _arrives(uint256 amount) internal pure returns (uint256) {
        return amount - (amount * FEE_BPS) / 10_000;
    }

    /// A swap of note `nul` (`amount` of `assetIn`) for `amountOut`, its unshield "proof" made for its escrow.
    function _call(uint256 nul, address assetIn, uint256 amount, address assetOut, uint256 amountOut, bytes memory route)
        internal
        view
        returns (Call memory c)
    {
        c.d = GloamVaultSwap2.Deposit(hex"00", bytes32(nul + 0x100), assetOut, amountOut);
        c.r = GloamVaultSwap2.Deposit(hex"00", bytes32(nul + 0x200), assetIn, amount - amount / 100);
        c.route = route;
        c.deadline = block.timestamp + 600;
        c.k = GloamVaultSwap2.EscrowKey(bytes32(nul), amount, c.d.commitment, assetOut, amountOut, c.r.commitment, c.r.amount, keccak256(route), vm.addr(exitPk), c.deadline);
        c.escrow = router.escrowFor(assetIn, c.k);
        c.s = GloamVaultSwap2.Spend(abi.encode(c.escrow), pool.currentRoot(), bytes32(nul), assetIn, amount);
    }

    function _go(Call memory c) internal returns (uint256) {
        vm.prank(relayer);
        return router.swap(c.s, c.d, c.r, c.route, vm.addr(exitPk), c.deadline);
    }

    function _spendAlone(Call memory c) internal {
        vm.prank(mallory);
        pool.unshield(c.s.proof, c.s.root, c.s.nullifier, c.s.asset, c.escrow, c.s.amount);
    }

    // ── happy paths ─────────────────────────────────────────────────────────

    function test_usd_note_to_launch_note_exact_and_router_ends_empty() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        uint256 before = pool.deposited(address(launch));
        uint256 spent = _go(c);
        assertEq(pool.deposited(address(launch)) - before, 190e18, "the new note is exactly the amount asked");
        assertTrue(pool.commitmentSeen(c.d.commitment), "new note in the vault");
        assertTrue(spent <= _arrives(NOTE), "never more than arrived");
        assertEq(usd.balanceOf(address(router)) + launch.balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(usd.balanceOf(treasury), _arrives(NOTE) - spent, "the price buffer goes to the treasury");
    }

    function test_hype_note_wraps_and_buys() public {
        Call memory c = _call(0xE7E7, address(0), 10e18, address(launch), 9000e18, _path(address(weth), address(launch)));
        _go(c);
        assertTrue(pool.commitmentSeen(c.d.commitment));
        assertEq(address(router).balance + weth.balanceOf(address(router)), 0);
    }

    function test_launch_note_to_hype_note_unwraps() public {
        test_hype_note_wraps_and_buys(); // a launch note of 9000e18 now exists, nullifier 0xE7E7 + 0x100 as commitment
        uint256 hypeBefore = pool.deposited(address(0));
        Call memory c = _call(0xE7E7 + 0x100, address(launch), 9000e18, address(0), 8e18, _path(address(launch), address(weth)));
        _go(c);
        assertEq(pool.deposited(address(0)) - hypeBefore, 8e18, "native HYPE note back");
    }

    function test_two_hops_usd_to_hype() public {
        address[] memory p = new address[](3);
        p[0] = address(usd);
        p[1] = address(launch);
        p[2] = address(weth);
        Call memory c = _call(2, address(usd), NOTE, address(0), 0.15e18, abi.encode(p));
        _go(c);
        assertTrue(pool.commitmentSeen(c.d.commitment));
    }

    // ── it reverts halfway: the note stays, or comes back ──────────────────

    function test_swap_that_cannot_fill_reverts_whole_and_the_note_stays() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 500e18, _path(address(usd), address(launch)));
        vm.expectRevert();
        _go(c);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note unspent");
        assertEq(usd.balanceOf(c.escrow), 0);
    }

    function test_spend_sent_alone_waits_then_anyone_refunds() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _spendAlone(c);
        assertEq(usd.balanceOf(c.escrow), _arrives(NOTE), "waits at the escrow");
        vm.prank(mallory); // anyone
        assertEq(router.swap(c.s, c.d, c.r, c.route, vm.addr(exitPk), c.deadline), 0);
        assertTrue(pool.commitmentSeen(c.r.commitment), "refund note in the vault");
        assertFalse(pool.commitmentSeen(c.d.commitment), "no swap on a refund");
    }

    function test_refund_has_no_deadline() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _spendAlone(c);
        vm.warp(block.timestamp + 365 days);
        _go(c);
        assertTrue(pool.commitmentSeen(c.r.commitment));
    }

    // ── the exit, for when a refund can't land ─────────────────────────────

    function test_exit_after_the_refund_is_blocked_by_a_full_deposit_cap() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _spendAlone(c);
        pool.lowerDepositLimit(address(usd), 0, 0); // deposits closed: the refund can't land
        vm.expectRevert();
        _go(c);
        address to = address(0xF8E5);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(exitPk, router.exitDigest(c.escrow, to));
        vm.prank(mallory); // anyone can send it, only the exit key signs it
        router.exit(address(usd), c.k, to, abi.encodePacked(r, s, v));
        assertEq(usd.balanceOf(to), _arrives(NOTE));
    }

    function test_exit_signature_for_one_address_cannot_pay_another() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _spendAlone(c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(exitPk, router.exitDigest(c.escrow, address(0xF8E5)));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        router.exit(address(usd), c.k, mallory, abi.encodePacked(r, s, v));
    }

    function test_exit_needs_the_note_spent() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(exitPk, router.exitDigest(c.escrow, address(0xF8E5)));
        vm.expectRevert(GloamVaultSwap2.BadExit.selector);
        router.exit(address(usd), c.k, address(0xF8E5), abi.encodePacked(r, s, v));
    }

    // ── replay, expiry, tampering ──────────────────────────────────────────

    function test_replay_is_refused() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _go(c);
        vm.expectRevert();
        _go(c);
    }

    function test_refund_and_exit_never_both() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        _spendAlone(c);
        _go(c); // refund
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(exitPk, router.exitDigest(c.escrow, address(0xF8E5)));
        vm.expectRevert();
        router.exit(address(usd), c.k, address(0xF8E5), abi.encodePacked(r, s, v));
    }

    function test_expired_swap_is_refused_and_the_note_stays() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        vm.warp(c.deadline + 1);
        vm.expectRevert(GloamVaultSwap2.SwapExpired.selector);
        _go(c);
        assertFalse(pool.isSpent(bytes32(uint256(1))));
    }

    function test_copied_call_with_another_output_cannot_use_the_proof() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(usd), address(launch)));
        c.d.amount = 1e18; // the copier wants less out (and the rest as leftover); its escrow differs
        vm.expectRevert(); // the vault rejects the proof: it names the original escrow
        _go(c);
        assertFalse(pool.isSpent(bytes32(uint256(1))));
    }

    function test_route_must_start_and_end_on_the_notes() public {
        Call memory c = _call(1, address(usd), NOTE, address(launch), 190e18, _path(address(weth), address(launch)));
        vm.expectRevert(CloakV2PairSwap.BadRoute.selector);
        _go(c);
    }

    function test_a_pair_the_factory_does_not_know_cannot_be_used() public {
        TestToken fake = new TestToken("Fake", "FAKE", 18);
        pool.setDepositLimit(address(fake), 1e30, 1e30);
        new V2Pair(address(usd), address(fake)); // deployed, but not by the factory
        Call memory c = _call(1, address(usd), NOTE, address(fake), 1e18, _path(address(usd), address(fake)));
        vm.expectRevert(abi.encodeWithSelector(CloakV2PairSwap.NoPair.selector, address(usd), address(fake)));
        _go(c);
    }

    // ── hostile tokens ─────────────────────────────────────────────────────

    function test_fee_on_transfer_output_arrives_short_and_reverts_the_swap() public {
        FeeToken f = new FeeToken();
        pool.setDepositLimit(address(f), 1e30, 1e32);
        _seed(address(usd), address(f), 100_000e6, 200_000e18);
        Call memory c = _call(1, address(usd), NOTE, address(f), 190e18, _path(address(usd), address(f)));
        vm.expectRevert();
        _go(c);
        assertFalse(pool.isSpent(bytes32(uint256(1))), "note unspent");
    }

    function test_token_that_freezes_the_router_reverts_and_the_exit_still_pays() public {
        FreezeToken z = new FreezeToken();
        pool.setDepositLimit(address(z), 1e30, 1e32);
        z.mint(depositor, 1000e18);
        vm.startPrank(depositor);
        z.approve(address(pool), type(uint256).max);
        pool.shieldBound(address(z), 100e18, bytes32(uint256(0x2222)), hex"00");
        vm.stopPrank();
        _seed(address(z), address(usd), 100_000e18, 100_000e6);
        Call memory c = _call(0x2222, address(z), 100e18, address(usd), 50e6, _path(address(z), address(usd)));
        z.freeze(address(router), true);
        vm.expectRevert(); // the escrow can't pay the router
        _go(c);
        _spendAlone(c); // the money leaves the vault to the escrow
        vm.expectRevert(); // the refund passes through the router too
        _go(c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(exitPk, router.exitDigest(c.escrow, address(0xF8E5)));
        router.exit(address(z), c.k, address(0xF8E5), abi.encodePacked(r, s, v));
        assertEq(z.balanceOf(address(0xF8E5)), _arrives(100e18), "the exit pays straight from the escrow, past the frozen router");
    }

    function test_treasury_that_cannot_receive_never_blocks_a_swap() public {
        FreezeToken z = new FreezeToken();
        pool.setDepositLimit(address(z), 1e30, 1e32);
        _seed(address(usd), address(z), 100_000e6, 200_000e18);
        z.freeze(treasury, true);
        Call memory c = _call(1, address(usd), NOTE, address(z), 190e18, _path(address(usd), address(z)));
        _go(c);
        assertTrue(pool.commitmentSeen(c.d.commitment));
    }

    function testFuzz_never_pays_more_than_arrived(uint96 want) public {
        uint256 out = bound(uint256(want), 1e18, 300e18);
        Call memory c = _call(1, address(usd), NOTE, address(launch), out, _path(address(usd), address(launch)));
        try router.swap(c.s, c.d, c.r, c.route, vm.addr(exitPk), c.deadline) returns (uint256 spent) {
            assertLe(spent, _arrives(NOTE));
            assertTrue(pool.commitmentSeen(c.d.commitment));
        } catch {
            assertFalse(pool.isSpent(bytes32(uint256(1))), "a failed swap leaves the note");
        }
    }
}
