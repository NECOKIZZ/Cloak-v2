// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {ShieldPoolPayments} from "gloam/ShieldPoolPayments.sol";
import {CloakGloamBids, BidAccount} from "../src/CloakGloamBids.sol";
import {TestToken} from "../src/TestToken.sol";
import {AcceptVerifier, ToBindingVerifier, FreezeToken} from "./CloakV2PairSwap.t.sol";

/// CloakAuction's bid shape: commit with a HYPE deposit, settle, then anyone's claim pays tokens and refund to the bidder.
contract MockAuction {
    struct Bid {
        address bidder;
        uint256 deposit;
        bytes32 commitment;
        bool claimed;
    }
    Bid[] public bids;
    TestToken public token;
    uint256 public commitEnd;
    bool public settled;
    mapping(uint256 => uint256) public tokensFor;
    mapping(uint256 => uint256) public refundFor;

    constructor(TestToken t, uint256 end) {
        token = t;
        commitEnd = end;
    }

    function commit(bytes32 commitment, bytes calldata) external payable returns (uint256 id) {
        require(block.timestamp < commitEnd, "commit closed");
        require(msg.value > 0, "deposit");
        id = bids.length;
        bids.push(Bid(msg.sender, msg.value, commitment, false));
    }

    function settle(uint256 id, uint256 tokens, uint256 refund) external {
        settled = true;
        tokensFor[id] = tokens;
        refundFor[id] = refund;
    }

    function claim(uint256 id) external {
        require(settled, "not settled");
        Bid storage b = bids[id];
        require(!b.claimed, "claimed");
        b.claimed = true;
        if (tokensFor[id] > 0) token.transfer(b.bidder, tokensFor[id]);
        if (refundFor[id] > 0) {
            (bool ok, ) = b.bidder.call{value: refundFor[id]}("");
            require(ok, "refund");
        }
    }

    receive() external payable {}
}

contract CloakGloamBidsTest is Test {
    using stdJson for string;

    ShieldPoolPayments pool;
    CloakGloamBids bids;
    MockAuction auction;
    TestToken launch;
    uint256 ownerPk = 0x0B1D;
    address fallbackTo = address(0xFA11);
    address relayer = address(0x5E1A);
    address mallory = address(0xBAD);
    uint256 constant NOTE = 1e18;
    uint256 constant ARRIVES = NOTE - (NOTE * 50) / 10_000;

    function setUp() public {
        vm.warp(1_900_000_000);
        pool = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        pool.setShieldVerifier(address(new AcceptVerifier()));
        pool.setWithdrawFee(50, address(0xFEE));
        pool.turnOnDepositLimits();
        launch = new TestToken("Launch", "LNCH", 18);
        pool.setDepositLimit(address(0), 1000e18, 100_000e18);
        pool.setDepositLimit(address(launch), 1e30, 1e32);
        bids = new CloakGloamBids(address(pool), address(0));
        auction = new MockAuction(launch, block.timestamp + 1 hours);
        launch.mint(address(auction), 1_000_000e18);
        vm.deal(address(this), 100e18);
        for (uint256 i = 0; i < 3; i++) pool.shieldBound{value: NOTE}(address(0), NOTE, bytes32(uint256(0xAA + i)), hex"00");
    }

    receive() external payable {}

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
    }

    bytes32 constant COMMITMENT = keccak256("commitment");

    function _key(uint256 nul, bytes memory) internal view returns (CloakGloamBids.BidKey memory k) {
        k = CloakGloamBids.BidKey(bytes32(nul), NOTE, address(auction), vm.addr(ownerPk), fallbackTo, block.timestamp + 30 days);
    }

    function _bidCall(bytes32 commitment, bytes memory sealedBid) internal pure returns (bytes memory) {
        return abi.encodeCall(MockAuction.commit, (commitment, sealedBid));
    }

    function _placeSig(CloakGloamBids.BidKey memory k, bytes memory sealedBid) internal view returns (bytes memory) {
        return _sign(bids.placeDigest(bids.accountFor(k), _bidCall(COMMITMENT, sealedBid)));
    }

    function _spend(CloakGloamBids.BidKey memory k) internal view returns (CloakGloamBids.Spend memory) {
        return CloakGloamBids.Spend(abi.encode(bids.accountFor(k)), pool.currentRoot(), k.nullifier, address(0), NOTE);
    }

    function _place(uint256 nul) internal returns (CloakGloamBids.BidKey memory k, address account) {
        bytes memory sealedBid = "sealed";
        k = _key(nul, sealedBid);
        account = bids.accountFor(k);
        CloakGloamBids.Spend memory s = _spend(k);
        bytes memory sig = _placeSig(k, sealedBid);
        vm.prank(relayer);
        bids.place(s, k, _bidCall(COMMITMENT, sealedBid), sig);
    }

    function _deps(uint256 tokens, uint256 hype, uint256 c) internal view returns (CloakGloamBids.Deposit[] memory ds) {
        uint256 n = (tokens > 0 ? 1 : 0) + (hype > 0 ? 1 : 0);
        ds = new CloakGloamBids.Deposit[](n);
        uint256 i;
        if (tokens > 0) ds[i++] = CloakGloamBids.Deposit(hex"00", bytes32(c), address(launch), tokens);
        if (hype > 0) ds[i++] = CloakGloamBids.Deposit(hex"00", bytes32(c + 1), address(0), hype);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── happy path ─────────────────────────────────────────────────────────

    function test_place_bids_from_the_account_with_what_arrived() public {
        (, address account) = _place(0xAA);
        (address bidder, uint256 deposit, , ) = auction.bids(0);
        assertEq(bidder, account, "the auction sees the one-time account, not anyone's wallet");
        assertEq(deposit, ARRIVES, "the deposit is the note less the 0.5% cash-out fee");
        assertEq(bids.bidIdPlus1(account), 1);
    }

    function test_win_then_finish_returns_tokens_and_refund_as_notes() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 500e18, 0.3e18);
        CloakGloamBids.Deposit[] memory ds = _deps(500e18, 0.3e18, 0x500);
        uint256 hypeBefore = pool.deposited(address(0));
        vm.prank(relayer);
        bids.finish(k, ds, _sign(bids.finishDigest(account, ds)));
        assertEq(pool.deposited(address(launch)), 500e18, "tokens back as a note");
        assertEq(pool.deposited(address(0)) - hypeBefore, 0.3e18, "refund back as a note");
        assertEq(account.balance + launch.balanceOf(account), 0, "nothing left in the account");
        assertTrue(bids.closed(account));
    }

    function test_lose_then_finish_returns_the_whole_deposit() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 0, ARRIVES);
        CloakGloamBids.Deposit[] memory ds = _deps(0, ARRIVES, 0x600);
        bids.finish(k, ds, _sign(bids.finishDigest(account, ds)));
        assertEq(account.balance, 0);
    }

    // ── it reverts halfway, or the spend is sent alone ─────────────────────

    function test_place_after_the_auction_closed_reverts_and_the_note_stays() public {
        bytes memory sealedBid = "sealed";
        CloakGloamBids.BidKey memory k = _key(0xAA, sealedBid);
        CloakGloamBids.Spend memory s = _spend(k);
        bytes memory sig = _placeSig(k, sealedBid);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(bytes("commit closed"));
        bids.place(s, k, _bidCall(COMMITMENT, sealedBid), sig);
        assertFalse(pool.isSpent(k.nullifier), "note unspent");
    }

    function test_spend_sent_alone_then_place_still_bids() public {
        bytes memory sealedBid = "sealed";
        CloakGloamBids.BidKey memory k = _key(0xAA, sealedBid);
        CloakGloamBids.Spend memory s = _spend(k);
        vm.prank(mallory);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), bids.accountFor(k), NOTE);
        bids.place(s, k, _bidCall(COMMITMENT, sealedBid), _placeSig(k, sealedBid));
        (, uint256 deposit, , ) = auction.bids(0);
        assertEq(deposit, ARRIVES);
    }

    function test_spend_sent_alone_after_close_goes_back_as_a_note() public {
        bytes memory sealedBid = "sealed";
        CloakGloamBids.BidKey memory k = _key(0xAA, sealedBid);
        CloakGloamBids.Spend memory s = _spend(k);
        address account = bids.accountFor(k);
        vm.prank(mallory);
        pool.unshield(s.proof, s.root, s.nullifier, address(0), account, NOTE);
        vm.warp(block.timestamp + 2 hours);
        CloakGloamBids.Deposit[] memory ds = _deps(0, ARRIVES, 0x700);
        bids.finish(k, ds, _sign(bids.finishDigest(account, ds)));
        assertEq(account.balance, 0, "the money is a note again");
    }

    // ── exits ──────────────────────────────────────────────────────────────

    function test_timeout_exit_anyone_to_the_fallback_claims_first() public {
        (CloakGloamBids.BidKey memory k, ) = _place(0xAA);
        auction.settle(0, 500e18, 0.3e18);
        address[] memory toks = new address[](1);
        toks[0] = address(launch);
        vm.expectRevert(CloakGloamBids.TooEarly.selector);
        bids.exitAfterTimeout(k, toks);
        vm.warp(k.exitAfter);
        vm.prank(mallory);
        bids.exitAfterTimeout(k, toks);
        assertEq(launch.balanceOf(fallbackTo), 500e18, "tokens to the fallback");
        assertEq(fallbackTo.balance, 0.3e18, "refund to the fallback");
    }

    function test_timeout_exit_before_settlement_leaves_the_bid_in_the_auction() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        vm.warp(k.exitAfter);
        bids.exitAfterTimeout(k, new address[](0)); // nothing in the account yet, the deposit is in the auction
        auction.settle(0, 0, ARRIVES);
        auction.claim(0); // anyone, at any time: it pays the account
        assertEq(account.balance, ARRIVES);
        bids.exitAfterTimeout(k, new address[](0));
        assertEq(fallbackTo.balance, ARRIVES, "never stuck: it gets out the second time");
    }

    function test_owner_exit_signature_is_bound_to_its_address() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 0, ARRIVES);
        bytes memory sig = _sign(bids.exitDigest(account, address(0xF8E5)));
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.exit(k, mallory, new address[](0), sig);
        bids.exit(k, address(0xF8E5), new address[](0), sig);
        assertEq(address(0xF8E5).balance, ARRIVES);
    }

    // ── replay and tampering ───────────────────────────────────────────────

    function test_place_twice_is_refused() public {
        (CloakGloamBids.BidKey memory k, ) = _place(0xAA);
        CloakGloamBids.Spend memory s = _spend(k);
        bytes memory sig = _placeSig(k, "sealed");
        vm.expectRevert(CloakGloamBids.Closed.selector);
        bids.place(s, k, _bidCall(COMMITMENT, "sealed"), sig);
    }

    function test_finish_replay_is_refused() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 500e18, 0);
        CloakGloamBids.Deposit[] memory ds = _deps(500e18, 0, 0x800);
        bytes memory sig = _sign(bids.finishDigest(account, ds));
        bids.finish(k, ds, sig);
        vm.expectRevert(CloakGloamBids.Closed.selector);
        bids.finish(k, ds, sig);
    }

    function test_finish_with_other_notes_than_signed_is_refused() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 500e18, 0);
        CloakGloamBids.Deposit[] memory ds = _deps(500e18, 0, 0x900);
        bytes memory sig = _sign(bids.finishDigest(account, ds));
        ds[0].commitment = bytes32(uint256(0xBAD)); // mallory's note
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.finish(k, ds, sig);
    }

    function test_a_copied_place_with_another_bid_or_key_is_refused() public {
        bytes memory sealedBid = "sealed";
        CloakGloamBids.BidKey memory k = _key(0xAA, sealedBid);
        CloakGloamBids.Spend memory s = _spend(k);
        bytes memory sig = _placeSig(k, sealedBid);
        // a copier swaps in its own bid (one it would never reveal, to get the bidder fined): the signature fails
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.place(s, k, _bidCall(COMMITMENT, "other"), sig);
        vm.expectRevert(CloakGloamBids.BadSignature.selector);
        bids.place(s, k, _bidCall(keccak256("other"), sealedBid), sig);
        // or changes the key (a fallback of its own): another account, and the proof names the old one
        k.fallbackTo = mallory;
        bytes memory sig2 = _placeSig(k, sealedBid);
        vm.expectRevert();
        bids.place(s, k, _bidCall(COMMITMENT, sealedBid), sig2);
    }

    function test_only_the_factory_moves_an_account() public {
        (, address account) = _place(0xAA);
        auction.settle(0, 0, ARRIVES);
        auction.claim(0);
        vm.prank(mallory);
        vm.expectRevert(bytes("factory"));
        BidAccount(payable(account)).run(mallory, ARRIVES, "");
    }

    // ── hostile token ──────────────────────────────────────────────────────

    function test_token_that_freezes_the_account_still_lets_the_refund_out() public {
        FreezeToken z = new FreezeToken();
        MockAuction za = new MockAuction(TestToken(address(z)), block.timestamp + 1 hours);
        z.mint(address(za), 1000e18);
        bytes memory sealedBid = "sealed";
        CloakGloamBids.BidKey memory k = CloakGloamBids.BidKey(bytes32(uint256(0xAB)), NOTE, address(za), vm.addr(ownerPk), fallbackTo, block.timestamp + 30 days);
        address account = bids.accountFor(k);
        bytes memory psig = _sign(bids.placeDigest(account, _bidCall(COMMITMENT, sealedBid)));
        bids.place(CloakGloamBids.Spend(abi.encode(account), pool.currentRoot(), k.nullifier, address(0), NOTE), k, _bidCall(COMMITMENT, sealedBid), psig);
        z.freeze(account, true); // the token blocks the account: its claim can't pay tokens
        za.settle(0, 100e18, 0.5e18);
        CloakGloamBids.Deposit[] memory ds = new CloakGloamBids.Deposit[](1);
        ds[0] = CloakGloamBids.Deposit(hex"00", bytes32(uint256(0xA0A0)), address(0), 0.5e18);
        bytes memory sig = _sign(bids.finishDigest(account, ds));
        vm.expectRevert(); // claim reverts (frozen), so the refund never reached the account
        bids.finish(k, ds, sig);
        z.freeze(account, false); // the issuer unfreezes: the same call works
        bids.finish(k, ds, sig);
        assertEq(z.balanceOf(account), 100e18, "tokens wait for a second finish or an exit");
    }

    function test_owner_call_moves_what_cannot_go_back_and_works_once() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        auction.settle(0, 500e18, 0);
        auction.claim(0);
        bytes memory data = abi.encodeCall(TestToken.transfer, (address(0xF8E5), 500e18));
        bytes memory sig = _sign(bids.callDigest(account, address(launch), 0, data, 0));
        vm.prank(relayer);
        bids.ownerCall(k, address(launch), 0, data, sig);
        assertEq(launch.balanceOf(address(0xF8E5)), 500e18);
        vm.expectRevert(CloakGloamBids.BadSignature.selector); // the nonce moved on
        bids.ownerCall(k, address(launch), 0, data, sig);
    }

    function test_owner_call_can_not_touch_the_vault() public {
        (CloakGloamBids.BidKey memory k, address account) = _place(0xAA);
        bytes memory data = abi.encodeWithSignature("collectFees(address)", address(0));
        bytes memory sig = _sign(bids.callDigest(account, address(pool), 0, data, 0));
        vm.expectRevert(CloakGloamBids.BadKey.selector);
        bids.ownerCall(k, address(pool), 0, data, sig);
    }
}

/// HYPE in Gloam's vault, launch tokens in Cloak's launch vault: a bid spends HYPE from Gloam's vault, and its win
/// comes back as tokens in the launch vault and its refund as HYPE in Gloam's vault.
contract CloakGloamBidsTwoVaultsTest is Test {
    using stdJson for string;

    ShieldPoolPayments gv; // Gloam's vault: HYPE
    ShieldPoolPayments lv; // the launch vault: launch tokens
    CloakGloamBids bids;
    MockAuction auction;
    TestToken launch;
    uint256 ownerPk = 0x0B1D;
    uint256 constant NOTE = 1e18;
    uint256 constant ARRIVES = NOTE - (NOTE * 50) / 10_000;
    bytes32 constant COMMITMENT = keccak256("commitment");

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
    }

    function _vault() internal returns (ShieldPoolPayments v) {
        v = new ShieldPoolPayments(_poseidon(), address(new ToBindingVerifier()));
        v.setShieldVerifier(address(new AcceptVerifier()));
        v.setWithdrawFee(50, address(0xFEE));
        v.turnOnDepositLimits();
    }

    function setUp() public {
        vm.warp(1_900_000_000);
        launch = new TestToken("Launch", "LNCH", 18);
        gv = _vault();
        gv.setDepositLimit(address(0), 1000e18, 100_000e18);
        lv = _vault();
        lv.setDepositLimit(address(launch), 1e30, 1e32);
        bids = new CloakGloamBids(address(lv), address(gv));
        auction = new MockAuction(launch, block.timestamp + 1 hours);
        launch.mint(address(auction), 1_000_000e18);
        vm.deal(address(this), 100e18);
        gv.shieldBound{value: NOTE}(address(0), NOTE, bytes32(uint256(0xAA)), hex"00");
    }

    receive() external payable {}

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _place() internal returns (CloakGloamBids.BidKey memory k, address account) {
        k = CloakGloamBids.BidKey(bytes32(uint256(0xAA)), NOTE, address(auction), vm.addr(ownerPk), address(0xFA11), block.timestamp + 30 days);
        account = bids.accountFor(k);
        bytes memory call = abi.encodeCall(MockAuction.commit, (COMMITMENT, bytes("sealed")));
        CloakGloamBids.Spend memory s = CloakGloamBids.Spend(abi.encode(account), gv.currentRoot(), k.nullifier, address(0), NOTE);
        bids.place(s, k, call, _sign(bids.placeDigest(account, call)));
    }

    function test_twoVaults_theBidSpendsHypeFromGloamsVault() public {
        uint256 g0 = gv.deposited(address(0));
        (, address account) = _place();
        (address bidder, uint256 deposit, , ) = auction.bids(0);
        assertEq(bidder, account);
        assertEq(deposit, ARRIVES, "the deposit is the note less Gloam's vault's fee");
        assertEq(g0 - gv.deposited(address(0)), NOTE, "the HYPE note left Gloam's vault");
        assertEq(address(bids.hypeVault()), address(gv));
        assertEq(address(bids.vault()), address(lv));
    }

    function test_twoVaults_winGoesToTheLaunchVaultAndRefundToGloamsVault() public {
        (CloakGloamBids.BidKey memory k, address account) = _place();
        auction.settle(0, 500e18, 0.3e18);
        CloakGloamBids.Deposit[] memory ds = new CloakGloamBids.Deposit[](2);
        ds[0] = CloakGloamBids.Deposit(hex"00", bytes32(uint256(0x500)), address(launch), 500e18);
        ds[1] = CloakGloamBids.Deposit(hex"00", bytes32(uint256(0x501)), address(0), 0.3e18);
        uint256 g0 = gv.deposited(address(0));
        bids.finish(k, ds, _sign(bids.finishDigest(account, ds)));
        assertEq(lv.deposited(address(launch)), 500e18, "the won tokens are a note in the launch vault");
        assertEq(gv.deposited(address(0)) - g0, 0.3e18, "the refund is a note in Gloam's vault");
        assertEq(lv.deposited(address(0)), 0, "no HYPE in the launch vault");
        assertEq(account.balance + launch.balanceOf(account), 0);
    }

    function test_twoVaults_noOwnerCallOrExitIntoEitherVault() public {
        (CloakGloamBids.BidKey memory k, address account) = _place();
        bytes memory data = abi.encodeWithSignature("collectFees(address)", address(0));
        bytes memory sg = _sign(bids.callDigest(account, address(gv), 0, data, 0));
        vm.expectRevert(CloakGloamBids.BadKey.selector);
        bids.ownerCall(k, address(gv), 0, data, sg);
        bytes memory sl = _sign(bids.callDigest(account, address(lv), 0, data, 0));
        vm.expectRevert(CloakGloamBids.BadKey.selector);
        bids.ownerCall(k, address(lv), 0, data, sl);
        address[] memory none = new address[](0);
        bytes memory se = _sign(bids.exitDigest(account, address(gv)));
        vm.expectRevert(CloakGloamBids.BadKey.selector);
        bids.exit(k, address(gv), none, se);
    }
}
