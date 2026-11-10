// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {CloakGloamReceive, ReceiveBox} from "../../src/CloakGloamReceive.sol";
import {CloakGloamBids, BidAccount} from "../../src/CloakGloamBids.sol";
import {CloakLaunchVault} from "../../src/CloakLaunchVault.sol";
import {CloakLaunchSwap, CloakLaunchSwapBase} from "../../src/CloakLaunchSwap.sol";
import {CloakFundsGate} from "../../src/CloakFundsGate.sol";
import {TestToken} from "../../src/TestToken.sol";
import {YesVerifier, ToVerifier, FakeAuction, FakeFactory} from "../CloakLaunchVault.t.sol";
import {AcceptVerifier, ToBindingVerifier, FeeToken, V2Factory, V2Pair, WETH9} from "../CloakV2PairSwap.t.sol";
import {MockVault, MockFundsVerifier} from "../CloakFundsGate.t.sol";

abstract contract StressBase is Test {
    using stdJson for string;

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The other valid signature for the same digest (s' = n - s, v flipped): ecrecover takes both.
    function _malleate(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        return abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }
}

// ── CloakGloamReceive ─────────────────────────────────────────────────────────────────────────────────────────────────

contract ReceiveStressTest is StressBase {
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
        vm.deal(payer, 1000e18);
    }

    function _vault() internal returns (ShieldPoolPayments v) {
        v = new ShieldPoolPayments(_poseidon(), address(new YesVerifier()));
        v.setShieldVerifier(address(new YesVerifier()));
        v.turnOnDepositLimits();
    }

    function _shield(ShieldPoolPayments v, address asset, uint256 amount, bytes32 c) internal {
        bytes memory sig = _sig(ownerPk, rx.shieldDigest(rx.boxOf(ownerKey, 0), address(v), asset, amount, c));
        rx.shield(ownerKey, 0, address(v), asset, amount, c, hex"00", sig);
    }

    /// C-07: a box has no exit. Anything neither vault takes (a token no vault lists, a fee-on-transfer token, HYPE once
    /// the vault's total cap is full or lowered) can only wait at the box: there is no owner-signed withdrawal, no
    /// timeout, and only the factory can move a box's money, only into a vault.
    function test_receive_unlistedTokenIsStuckInTheBox() public {
        TestToken rando = new TestToken("Random", "RND", 18);
        FeeToken fee = new FeeToken();
        address box = rx.boxOf(ownerKey, 0);
        rando.mint(box, 1_000e18);
        fee.mint(box, 1_000e18);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector); // not listed in Gloam's vault
        this.shieldVia(va, address(rando), 1e18, bytes32(uint256(1)));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector); // nor in the launch vault
        this.shieldVia(vb, address(rando), 1e18, bytes32(uint256(2)));
        vm.expectRevert(bytes("short")); // fee-on-transfer: refused by the factory itself
        this.shieldVia(va, address(fee), 1e18, bytes32(uint256(3)));
        // the box exists now (made on first use); the owner key can't pull, nobody but the factory can
        _shieldOk(); // make the box
        vm.prank(ownerKey);
        vm.expectRevert(bytes("factory"));
        ReceiveBox(payable(box)).pull(address(rando), 1_000e18);
        // review C-06, fixed: the owner key signs a sweep, and anyone sends it
        _sweepOut(box, address(rando), 1_000e18);
        _sweepOut(box, address(fee), 1_000e18);
    }

    /// HYPE over the vault's total cap waits at the box until the vault has room again (or for good, if never).
    function test_receive_hypeOverTheTotalCapWaits() public {
        address box = rx.boxOf(ownerKey, 0);
        vm.prank(payer);
        (bool ok, ) = box.call{value: 150e18}("");
        require(ok);
        for (uint256 i = 0; i < 10; i++) _shield(va, address(0), 10e18, bytes32(uint256(0x100 + i)));
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        this.shieldVia(va, address(0), 10e18, bytes32(uint256(0x200)));
        assertEq(box.balance, 50e18, "50 HYPE waits at the box");
        // review C-06, fixed: its owner can take it out in the clear
        _sweepHype(box, address(0xF00E), 50e18);
        assertEq(address(0xF00E).balance, 50e18, "swept out");
    }

    function _sweepData(address token, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TestToken.transfer.selector, address(0xF00D), amount);
    }

    function _sweepSig(address box, address token, bytes memory data) internal view returns (bytes memory) {
        return _sig(ownerPk, rx.sweepDigest(box, token, 0, data, rx.sweepNonce(box)));
    }

    function _sweepHype(address box, address to, uint256 amount) internal {
        bytes memory sig = _sig(ownerPk, rx.sweepDigest(box, to, amount, "", rx.sweepNonce(box)));
        rx.sweep(ownerKey, 0, to, amount, "", sig);
    }

    function _sweepOut(address box, address token, uint256 amount) internal {
        bytes memory data = _sweepData(token, amount);
        bytes memory sig = _sweepSig(box, token, data);
        rx.sweep(ownerKey, 0, token, 0, data, sig);
        assertGt(TestToken(token).balanceOf(address(0xF00D)), 0, "swept out by its owner");
        vm.expectRevert(CloakGloamReceive.BadSignature.selector); // each signature works once
        rx.sweep(ownerKey, 0, token, 0, data, sig);
    }

    function test_receive_sweepNeedsTheOwnerKey() public {
        address box = rx.boxOf(ownerKey, 0);
        bytes memory data = abi.encodeWithSelector(TestToken.transfer.selector, address(0xF00D), 1);
        bytes memory sig = _sig(0xBAD, rx.sweepDigest(box, address(0x1234), 0, data, 0));
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.sweep(ownerKey, 0, address(0x1234), 0, data, sig);
    }

    function shieldVia(ShieldPoolPayments v, address asset, uint256 amount, bytes32 c) external {
        _shield(v, asset, amount, c);
    }

    function _shieldOk() internal {
        address box = rx.boxOf(ownerKey, 0);
        vm.prank(payer);
        (bool ok, ) = box.call{value: 1e18}("");
        require(ok);
        _shield(va, address(0), 1e18, bytes32(uint256(0xF00)));
    }

    /// held: a malleated signature can't move a second deposit (the commitment is single-use in the vault).
    function test_receive_malleatedSignatureCantDoubleShield() public {
        address box = rx.boxOf(ownerKey, 0);
        vm.prank(payer);
        (bool ok, ) = box.call{value: 4e18}("");
        require(ok);
        bytes32 c = bytes32(uint256(0xAB));
        bytes memory sig = _sig(ownerPk, rx.shieldDigest(box, address(va), address(0), 2e18, c));
        rx.shield(ownerKey, 0, address(va), address(0), 2e18, c, hex"00", sig);
        vm.expectRevert(ShieldPoolCore.DuplicateCommitment.selector);
        rx.shield(ownerKey, 0, address(va), address(0), 2e18, c, hex"00", _malleate(sig));
        assertEq(box.balance, 2e18);
    }

    /// held: a zero owner key with a garbage signature (ecrecover returns 0) is refused.
    function test_receive_zeroOwnerKeyRefused() public {
        address box = rx.boxOf(address(0), 0);
        vm.prank(payer);
        (bool ok, ) = box.call{value: 1e18}("");
        require(ok);
        vm.expectRevert(CloakGloamReceive.BadSignature.selector);
        rx.shield(address(0), 0, address(va), address(0), 1e18, bytes32(uint256(1)), hex"00", new bytes(65));
    }
}

// ── CloakGloamBids ────────────────────────────────────────────────────────────────────────────────────────────────────

/// CloakAuction's commit rules that matter here: a per-bid cap on the deposit (bidCap), and claim pays the bidder.
contract CappedAuction {
    uint256 public immutable bidCap;
    uint256 public commitEnd;
    bool public settled;
    address[] public bidders;
    uint256[] public deposits;

    constructor(uint256 cap, uint256 end) {
        bidCap = cap;
        commitEnd = end;
    }

    function commit(bytes32, bytes calldata) external payable returns (uint256 id) {
        require(block.timestamp < commitEnd, "commit closed");
        require(msg.value > 0, "deposit");
        require(msg.value <= bidCap, "over cap"); // as CloakAuction.commit
        id = bidders.length;
        bidders.push(msg.sender);
        deposits.push(msg.value);
    }

    function settle() external {
        settled = true;
    }

    function claim(uint256 id) external {
        require(settled, "not settled");
        uint256 d = deposits[id];
        deposits[id] = 0;
        (bool ok, ) = bidders[id].call{value: d}(""); // lost: the whole deposit back
        require(ok);
    }
}

contract BidsStressTest is StressBase {
    ShieldPoolPayments pool;
    CloakGloamBids bids;
    CappedAuction auction;
    uint256 ownerPk = 0x0B1D;
    address fallbackTo = address(0xFA11);
    address mallory = address(0xBAD);
    uint256 constant NOTE = 1e18;
    uint256 constant ARRIVES = NOTE - (NOTE * 50) / 10_000;

    function setUp() public {
        vm.warp(1_900_000_000);
        pool = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        pool.setShieldVerifier(address(new AcceptVerifier()));
        pool.setWithdrawFee(50, address(0xFEE));
        pool.turnOnDepositLimits();
        pool.setDepositLimit(address(0), 1000e18, 100_000e18);
        bids = new CloakGloamBids(address(pool), address(0));
        // the app bids exactly the cap: the note is the deposit plus the vault's fee
        auction = new CappedAuction(ARRIVES, block.timestamp + 1 hours);
        vm.deal(address(this), 100e18);
        for (uint256 i = 0; i < 3; i++) pool.shieldBound{value: NOTE}(address(0), NOTE, bytes32(uint256(0xAA + i)), hex"00");
        vm.deal(mallory, 1e18);
    }

    receive() external payable {}

    function _key(uint256 nul) internal view returns (CloakGloamBids.BidKey memory) {
        return CloakGloamBids.BidKey(bytes32(nul), NOTE, address(auction), vm.addr(ownerPk), fallbackTo, block.timestamp + 30 days);
    }

    function _bidCall() internal pure returns (bytes memory) {
        return abi.encodeCall(CappedAuction.commit, (keccak256("c"), bytes("sealed")));
    }

    function _spend(CloakGloamBids.BidKey memory k) internal view returns (CloakGloamBids.Spend memory) {
        return CloakGloamBids.Spend(abi.encode(bids.accountFor(k)), pool.currentRoot(), k.nullifier, address(0), NOTE);
    }

    /// C-09, fixed: a 1-wei top-up no longer blocks a bid at the cap: place() bids what the note brought, and the
    /// stranger's wei stays in the account for an exit.
    function test_bids_oneWeiTopUp_fixed() public {
        CloakGloamBids.BidKey memory k = _key(1);
        address account = bids.accountFor(k);
        CloakGloamBids.Spend memory s = _spend(k);
        bytes memory call_ = _bidCall();
        bytes memory sig = _sig(ownerPk, bids.placeDigest(account, call_));
        vm.startPrank(mallory);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), account, NOTE);
        (bool ok, ) = account.call{value: 1}("");
        require(ok);
        vm.stopPrank();
        bids.place(s, k, call_, sig);
        assertEq(account.balance, 1, "only the stranger's wei is left over");
    }

    /// C-10, fixed: an exit signature works once; a later replay is refused.
    function test_bids_exitSignatureReplay_fixed() public {
        CloakGloamBids.BidKey memory k = _key(2);
        address account = bids.accountFor(k);
        CloakGloamBids.Spend memory s = _spend(k);
        bids.place(s, k, _bidCall(), _sig(ownerPk, bids.placeDigest(account, _bidCall())));
        address to = address(0x70);
        bytes memory exitSig = _sig(ownerPk, bids.exitDigest(account, to));
        address[] memory none = new address[](0);
        bids.exit(k, to, none, exitSig);
        auction.settle();
        vm.prank(mallory);
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.exit(k, to, none, exitSig);
        assertEq(to.balance, 0, "nothing pushed out by a replay");
    }

    /// C-11, fixed: the bids contract refuses HYPE outside finish(), so none can get stuck there.
    function test_bids_strayHype_refused() public {
        vm.prank(mallory);
        (bool ok, ) = address(bids).call{value: 0.5e18}("");
        assertFalse(ok, "refused");
    }

    /// held: a malleated owner-call signature can't run twice (the nonce moves).
    function test_bids_malleatedOwnerCallCantReplay() public {
        CloakGloamBids.BidKey memory k = _key(3);
        address account = bids.accountFor(k);
        CloakGloamBids.Spend memory s = _spend(k);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), account, NOTE); // money waits at the account
        address to = address(0x71);
        bytes memory sig = _sig(ownerPk, bids.callDigest(account, to, 0.1e18, "", 0));
        bids.ownerCall(k, to, 0.1e18, "", sig);
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.ownerCall(k, to, 0.1e18, "", _malleate(sig));
        assertEq(to.balance, 0.1e18);
    }

    /// held: an account's money can't be pulled with a key that names another fallback or owner.
    function test_bids_otherKeyCantReachTheAccount() public {
        CloakGloamBids.BidKey memory k = _key(4);
        address account = bids.accountFor(k);
        CloakGloamBids.Spend memory s = _spend(k);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), account, NOTE);
        CloakGloamBids.BidKey memory evil = k;
        evil.fallbackTo = mallory;
        evil.exitAfter = 0;
        address[] memory none = new address[](0);
        bids.exitAfterTimeout(evil, none); // runs on evil's own (empty) account
        assertEq(mallory.balance, 1e18, "mallory got nothing");
        assertEq(account.balance, ARRIVES, "the real account is untouched");
    }
}

// ── CloakLaunchSwap (V2 venue) ────────────────────────────────────────────────────────────────────────────────────────

contract LaunchSwapStressTest is StressBase {
    CloakLaunchVault vault;
    CloakLaunchSwap router;
    V2Factory pairs;
    WETH9 weth;
    TestToken launch;
    address relayer = address(0x5E1A);
    address mallory = address(0xBAD);
    uint256 ownerPk = 0x0A11CE;
    address ownerKey;
    uint256 constant NOTE = 10e18;

    function setUp() public {
        vm.warp(1_900_000_000);
        ownerKey = vm.addr(ownerPk);
        FakeFactory factory = new FakeFactory();
        FakeAuction auction = new FakeAuction();
        launch = new TestToken("Launch", "LNCH", 18);
        uint256 idx = factory.add(address(auction), address(launch));
        auction.settle();
        vault = new CloakLaunchVault(_poseidon(), address(new ToVerifier()), address(factory), 1_000_000e18, 50_000_000e18, address(0));
        vault.setShieldVerifier(address(new YesVerifier()));
        vault.setWithdrawFee(50, address(0xFEE));
        vault.turnOnDepositLimits();
        vault.setDepositLimit(address(0), 1_000e18, 100_000e18);
        vault.endSetup();
        vault.admitLaunch(idx);
        weth = new WETH9();
        pairs = new V2Factory();
        router = new CloakLaunchSwap(address(vault), address(pairs), address(weth));
        V2Pair p = pairs.create(address(weth), address(launch));
        vm.deal(address(this), 1_000e18);
        weth.deposit{value: 100e18}();
        weth.transfer(address(p), 100e18);
        launch.mint(address(p), 100_000e18);
        p.sync();
        for (uint256 i = 0; i < 5; i++) vault.shieldBound{value: NOTE}(address(0), NOTE, bytes32(uint256(0xE0 + i)), hex"00");
    }

    function _route() internal view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(launch);
        return abi.encode(path);
    }

    function _swap(uint256 n, uint256 out, uint256 noteAmount) internal returns (bytes32 id, uint256 left) {
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", vault.currentRoot(), bytes32(n), address(0), noteAmount);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(n + 0x1000), address(launch), out);
        uint256 deadline = block.timestamp + 1 hours;
        s.proof = abi.encode(router.escrowFor(router.keyOf(s, d, _route(), ownerKey, deadline)));
        vm.prank(relayer);
        return router.swap(s, d, _route(), ownerKey, deadline);
    }

    /// held: a swap can't spend the leftovers other traders are owed. The router holds them, but a swap pays at most
    /// what its own note brought in.
    function test_launchSwap_greedySwapCantSpendOthersLeftovers() public {
        (, uint256 left1) = _swap(1, 5_000e18, NOTE); // leaves ~4.4-4.9 HYPE owed here
        (, uint256 left2) = _swap(2, 5_000e18, NOTE);
        assertGt(address(router).balance, 8e18);
        // a 1 HYPE note asking for 2,000 tokens (needs ~2 HYPE) is refused, though the router holds ~9.8 HYPE
        vault.shieldBound{value: 1e18}(address(0), 1e18, bytes32(uint256(0xF1)), hex"00");
        vm.expectRevert();
        this.swapVia(0xF1, 2_000e18, 1e18);
        assertEq(address(router).balance, left1 + left2, "every leftover still here");
    }

    function swapVia(uint256 n, uint256 out, uint256 noteAmount) external {
        _swap(n, out, noteAmount);
    }

    /// held: a malleated claim signature can't claim twice.
    function test_launchSwap_malleatedClaimSignatureOnce() public {
        (bytes32 id, uint256 left) = _swap(3, 5_000e18, NOTE);
        bytes32 c = bytes32(uint256(0xC1A));
        bytes memory sig = _sig(ownerPk, router.claimDigest(id, c));
        router.claim(id, CloakLaunchSwapBase.Deposit(hex"00", c, address(0), left), _malleate(sig));
        vm.expectRevert(CloakLaunchSwapBase.NothingOwed.selector);
        router.claim(id, CloakLaunchSwapBase.Deposit(hex"00", bytes32(uint256(0xC1B)), address(0), left), sig);
    }

    /// held: rescue of a key with another owner opens another (empty) escrow; the real spend's money stays put.
    function _spentAlone(uint256 n) internal returns (CloakLaunchSwapBase.SwapKey memory k, address escrow) {
        CloakLaunchSwapBase.Spend memory s = CloakLaunchSwapBase.Spend(hex"", vault.currentRoot(), bytes32(n), address(0), NOTE);
        CloakLaunchSwapBase.Deposit memory d = CloakLaunchSwapBase.Deposit(hex"00", bytes32(n + 0x1000), address(launch), 5_000e18);
        k = router.keyOf(s, d, _route(), ownerKey, block.timestamp + 1 hours);
        escrow = router.escrowFor(k);
        vault.unshield(abi.encode(escrow), s.root, s.nullifier, address(0), escrow, NOTE);
    }

    function test_launchSwap_rescueWithAChangedKeyGetsNothing() public {
        (CloakLaunchSwapBase.SwapKey memory k, address escrow) = _spentAlone(4);
        vm.warp(k.deadline + 1);
        CloakLaunchSwapBase.SwapKey memory evil = k;
        evil.ownerKey = mallory;
        vm.expectRevert(CloakLaunchSwapBase.Used.selector);
        router.rescue(evil);
        assertEq(escrow.balance, 9.95e18);
        k.ownerKey = ownerKey; // evil aliased k in memory
        router.rescue(k);
        (, address key, uint256 amount) = router.owed(router.idOf(k));
        assertEq(key, ownerKey);
        assertEq(amount, 9.95e18);
    }

    /// held: the exit can't be pointed at the venue's own contracts or the vault.
    function test_launchSwap_exitRefusesStopAddresses() public {
        (bytes32 id, ) = _swap(5, 5_000e18, NOTE);
        address[5] memory bad = [address(vault), address(router), address(weth), address(pairs), address(0)];
        for (uint256 i = 0; i < bad.length; i++) {
            bytes memory sig = _sig(ownerPk, router.exitDigest(id, bad[i]));
            vm.expectRevert(CloakLaunchSwapBase.BadExit.selector);
            router.exit(id, bad[i], sig);
        }
    }
}

// ── CloakLaunchVault ──────────────────────────────────────────────────────────────────────────────────────────────────

contract LaunchVaultStressTest is StressBase {
    CloakLaunchVault vault;
    FakeFactory factory;
    address pauser = address(0x9A05E);

    function setUp() public {
        vm.warp(1_900_000_000);
        factory = new FakeFactory();
        vault = new CloakLaunchVault(_poseidon(), address(new ToVerifier()), address(factory), 1_000e18, 10_000e18, pauser);
        vault.setShieldVerifier(address(new YesVerifier()));
        vault.setWithdrawFee(50, address(0xFEE));
        vault.turnOnDepositLimits();
        vault.endSetup();
    }

    /// C-11 (info): admission is instant and permissionless, so the pauser's blockLaunch can be raced. Once admitted, the
    /// pauser has no power over the token; only the owner can lower it (through its guard).
    function test_launchVault_pauserBlockCanBeFrontRun() public {
        FakeAuction a = new FakeAuction();
        TestToken t = new TestToken("Bad", "BAD", 18);
        uint256 i = factory.add(address(a), address(t));
        a.settle();
        vault.admitLaunch(i); // anyone, the moment the launch settles
        vm.prank(pauser);
        vault.blockLaunch(address(t), true); // too late
        (uint128 per, ) = vault.depositLimit(address(t));
        assertEq(per, 1_000e18, "still open for deposits");
        t.mint(address(this), 1e18);
        t.approve(address(vault), 1e18);
        vault.shieldBound(address(t), 1e18, bytes32(uint256(1)), hex"00");
    }

    /// held: the owner lowers an admitted token to zero; re-admission by anyone (even under a new index naming the same
    /// token) can't raise it back.
    function test_launchVault_reAdmissionUnderAnotherIndexCantRaise() public {
        FakeAuction a = new FakeAuction();
        TestToken t = new TestToken("T", "T", 18);
        uint256 i = factory.add(address(a), address(t));
        a.settle();
        vault.admitLaunch(i);
        vault.lowerDepositLimit(address(t), 0, 0);
        uint256 j = factory.add(address(a), address(t)); // a second launch entry naming the same token
        vault.admitLaunch(j);
        (uint128 per, uint128 total) = vault.depositLimit(address(t));
        assertEq(per, 0);
        assertEq(total, 0);
    }

    /// held: an unsettled launch is refused, and the pauser can't touch funds or limits of admitted tokens.
    function test_launchVault_pauserPowersAreAdmissionOnly() public {
        FakeAuction a = new FakeAuction();
        TestToken t = new TestToken("T", "T", 18);
        uint256 i = factory.add(address(a), address(t));
        vm.expectRevert(CloakLaunchVault.NotSettled.selector);
        vault.admitLaunch(i);
        vm.prank(pauser);
        vault.pauseAdmissions(true);
        a.settle();
        vm.expectRevert(CloakLaunchVault.AdmissionStopped.selector);
        vault.admitLaunch(i);
        vm.startPrank(pauser);
        vm.expectRevert(ShieldPoolCore.NotOwner.selector);
        vault.lowerDepositLimit(address(t), 0, 0);
        vm.expectRevert(ShieldPoolCore.NotOwner.selector);
        vault.sweepStrayNative(pauser);
        vm.stopPrank();
    }
}

// ── CloakFundsGate ────────────────────────────────────────────────────────────────────────────────────────────────────

contract FundsGateStressTest is Test {
    CloakFundsGate gate;
    MockVault gv;
    MockVault lv;
    MockFundsVerifier fv;
    uint256 id;
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
        id = gate.createGate(address(0), 10e18, uint64(block.timestamp + 1 days));
        gv.root(ROOT);
    }

    function _pub(address wallet, uint256 n0, uint256 n1) internal view returns (uint256[8] memory p) {
        p[0] = uint256(ROOT);
        p[2] = 10e18;
        p[3] = gate.contextFor(id, address(gv), wallet);
        p[4] = n0;
        p[5] = n1;
    }

    /// held: the same note twice in one proof is refused (a circuit that let one note fill two slots couldn't double it).
    function test_fundsGate_sameNoteInTwoSlotsRefused() public {
        uint256[8] memory p = _pub(address(0xA1), 11, 11);
        vm.expectRevert(CloakFundsGate.NotesUsed.selector);
        gate.enter(id, address(gv), address(0xA1), a, b, c, p);
    }

    /// held: one entry per wallet, no entries after the close, confirm only after it, and a second confirm is a no-op.
    /// (Nullifier aliases above the field size are refused by the real verifier's checkField on every public input.)
    function test_fundsGate_entryWindowAndConfirmOrder() public {
        gate.enter(id, address(gv), address(0xA1), a, b, c, _pub(address(0xA1), 11, 0));
        uint256[8] memory again = _pub(address(0xA1), 12, 0);
        vm.expectRevert(CloakFundsGate.AlreadyIn.selector);
        gate.enter(id, address(gv), address(0xA1), a, b, c, again);
        vm.expectRevert(CloakFundsGate.NotClosed.selector);
        gate.confirm(id, address(0xA1));
        vm.warp(block.timestamp + 1 days + 1);
        uint256[8] memory late = _pub(address(0xA2), 13, 0);
        vm.expectRevert(CloakFundsGate.Closed.selector);
        gate.enter(id, address(gv), address(0xA2), a, b, c, late);
        gate.confirm(id, address(0xA1));
        gate.confirm(id, address(0xA1)); // a second confirm is a no-op, not a double count
        (, , , , , uint32 confirmed) = gate.gates(id);
        assertEq(confirmed, 1);
    }
}
