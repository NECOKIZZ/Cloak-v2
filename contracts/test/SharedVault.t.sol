// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeLocker} from "../src/CloakAuction.sol";
import {Test} from "forge-std/Test.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";
import {CloakSeeder} from "../src/CloakSeeder.sol";
import {IUniswapV2Factory, IWETH} from "../src/uniswap/IUniswapV2.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {CloakVaults, ILaunchFactory} from "../src/shielded/CloakVaults.sol";
import {WHYPE} from "../src/shielded/WHYPE.sol";
import {SharedVault, IPoseidon4, IVerifierMA, ISharedLaunchFactory, IVaultList} from "../src/shielded/SharedVault.sol";
import {SharedRouter} from "../src/shielded/SharedRouter.sol";
import {CloakV2Market} from "../src/CloakV2Market.sol";
import {SharedBatcher} from "../src/shielded/SharedBatcher.sol";
import {IPoseidon2, IPoseidon3} from "../src/shielded/interfaces/IHasher.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

contract MockVerifierMA {
    bool public ok = true;

    function set(bool v) external {
        ok = v;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[8] calldata)
        external
        view
        returns (bool)
    {
        return ok;
    }
}

/// The shared launch-token vault and its router, on a fork of Elysium testnet with real Uniswap V2 pools.
/// Proofs come from mock verifiers (an accepting verifier is the worst case: every check here must hold even when the
/// proof itself proves nothing). The circuit is covered by the JS e2e with real Groth16 proofs.
///   forge test --match-contract SharedVaultTest   (needs the testnet RPC)
contract SharedVaultTest is Test {
    IUniswapV2Factory constant UNI = IUniswapV2Factory(0xb2F8ad730e9D05d333C7861184AAD0bFF1785dd0);
    IWETH constant UNI_WHYPE = IWETH(0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234);

    CloakConfig config;
    CloakFactory factory;
    CloakFactory pairFactory; // a factory without Uniswap (CloakPair launches)
    CloakVaults vaults;
    ShieldedPool hypePool;
    WHYPE whype;
    SharedVault shared;
    SharedRouter router;
    SharedBatcher batcher;
    MockVerifierMA maVerifier;
    IPoseidon4 p4;

    CloakToken a; // launch 0
    CloakToken b; // launch 1
    address alice = makeAddr("alice");
    address relayer = makeAddr("relayer");
    uint256 nonce = 1;

    function _deployCode(string memory path) internal returns (address x) {
        bytes memory code = vm.parseBytes(vm.readFile(path));
        assembly {
            x := create(0, add(code, 0x20), mload(code))
        }
        require(x != address(0), "deploy");
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("RPC_URL", string("https://testnet-rpc.elysium.kinetiq.xyz")));
        config = new CloakConfig(address(new MockVerifier()), address(0xFEE));
        factory = new CloakFactory(config, new CloakVestingDeployer(), new CloakSeeder(UNI, UNI_WHYPE, 997), IFeeLocker(address(0)));
        pairFactory = new CloakFactory(config, new CloakVestingDeployer(), new CloakSeeder(IUniswapV2Factory(address(0)), IWETH(address(0)), 997), IFeeLocker(address(0)));
        config.addLaunchFactory(address(factory));
        config.addLaunchFactory(address(pairFactory));

        IPoseidon2 p2 = IPoseidon2(_deployCode("test/fixtures/poseidon2.hex"));
        IPoseidon3 p3 = IPoseidon3(_deployCode("test/fixtures/poseidon3.hex"));
        p4 = IPoseidon4(_deployCode("test/fixtures/poseidon4.hex"));
        whype = new WHYPE();
        config.approveAsset(address(whype));
        vaults = new CloakVaults(config, p2, p3);
        hypePool = vaults.createAssetPool(address(whype));
        maVerifier = new MockVerifierMA();
        shared = new SharedVault(config, p2, p4, IVerifierMA(address(maVerifier)), IVaultList(address(vaults)));
        router = new SharedRouter(shared, hypePool, whype);
        batcher = new SharedBatcher(shared, hypePool, whype, 30, 200, 600, 1e12);

        vm.deal(alice, 100_000 ether);
        a = _launchAndSettle(factory, "Alpha", 19);
        b = _launchAndSettle(factory, "Beta", 9);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _launchAndSettle(CloakFactory f, string memory name, uint16 tick) internal returns (CloakToken t) {
        CloakAuction.Params memory p = CloakAuction.Params({
            creator: address(this),
            saleSupply: 1_000_000e18,
            lpReserve: 1_000_000e18,
            minPrice: 0.0001 ether,
            tickSize: 0.0001 ether,
            numTicks: 100,
            commitEnd: uint64(vm.getBlockTimestamp() + 1 hours),
            revealEnd: uint64(vm.getBlockTimestamp() + 2 hours),
            lpBps: 5_000,
            noRevealPenaltyBps: 1_000,
            lpLockUntil: 0,
            tlockRound: 0
        });
        (address auc, address tok) = f.createLaunch(name, name, 0, 0, p, "");
        CloakAuction au = CloakAuction(payable(auc));
        bytes32 salt = keccak256(bytes(name));
        bytes32 h = au.commitmentOf(alice, tick, 1_000_000e18, salt);
        vm.prank(alice);
        uint256 id = au.commit{value: 5_000 ether}(h, "");
        vm.warp(p.commitEnd);
        au.reveal(id, tick, 1_000_000e18, salt);
        vm.warp(p.revealEnd);
        au.settle();
        au.claim(id); // alice holds the whole sale
        t = CloakToken(tok);
    }

    function _admit(uint256 i) internal {
        shared.admit(ISharedLaunchFactory(address(factory)), i);
    }

    function _deposit(CloakToken t, uint256 amount) internal returns (uint256 commitment) {
        vm.startPrank(alice);
        t.approve(address(shared), amount);
        (commitment,) = shared.depositTo(address(t), 7, amount, 9, hex"");
        vm.stopPrank();
    }

    function _sp(SharedVault.ExtData memory ext, uint256 publicAsset) internal returns (SharedVault.Proof memory pr) {
        pr.root = shared.currentRoot();
        pr.publicAmount = shared.calculatePublicAmount(ext.extAmount, ext.fee);
        pr.extDataHash = this.hashShared(ext);
        pr.publicAsset = publicAsset;
        pr.inputNullifiers = [_rnd(), _rnd()];
        pr.outputCommitments = [uint256(11), uint256(12)];
    }

    function _hp(ShieldedPool.ExtData memory ext) internal returns (ShieldedPool.Proof memory pr) {
        pr.root = hypePool.currentRoot();
        pr.publicAmount = hypePool.calculatePublicAmount(ext.extAmount, ext.fee);
        pr.extDataHash = this.hashHype(ext);
        pr.inputNullifiers = [_rnd(), _rnd()];
        pr.outputCommitments = [uint256(21), uint256(22)];
    }

    function _rnd() internal returns (uint256) {
        return uint256(keccak256(abi.encode(nonce++))) % shared.FIELD_SIZE();
    }

    function hashShared(SharedVault.ExtData calldata ext) external view returns (uint256) {
        return shared.hashExtData(ext);
    }

    function hashHype(ShieldedPool.ExtData calldata ext) external view returns (uint256) {
        return hypePool.hashExtData(ext);
    }

    function _out(address to, int256 amount, uint256 fee) internal view returns (SharedVault.ExtData memory) {
        return SharedVault.ExtData(to, -amount, fee > 0 ? relayer : address(0), fee, hex"01", hex"02", "");
    }

    function _swapData(address token, uint256 minOut) internal view returns (bytes memory) {
        return abi.encode(SharedRouter.SwapData(token, minOut, 123, 456, hex"aa", uint64(vm.getBlockTimestamp() + 60)));
    }

    function _shieldHype(uint256 amount) internal {
        vm.startPrank(alice);
        whype.deposit{value: amount}();
        whype.approve(address(hypePool), amount);
        hypePool.depositTo(5, amount, 6, hex"");
        vm.stopPrank();
    }

    // ───────────────────────────── admission ─────────────────────────────

    function test_admit_newUniswapLaunch() public {
        _admit(0);
        assertTrue(shared.admitted(address(a)));
        assertEq(shared.tokensCount(), 1);
        assertTrue(shared.marketOf(address(a)) != address(0));
        vm.expectRevert(SharedVault.AlreadyAdmitted.selector);
        _admit(0);
    }

    function test_admit_rejectsUnknownFactory() public {
        CloakFactory stranger = new CloakFactory(config, new CloakVestingDeployer(), new CloakSeeder(UNI, UNI_WHYPE, 997), IFeeLocker(address(0)));
        vm.expectRevert(SharedVault.UnknownFactory.selector);
        shared.admit(ISharedLaunchFactory(address(stranger)), 0);
    }

    function test_admit_rejectsUnsettled() public {
        CloakAuction.Params memory p = CloakAuction.Params(address(this), 1e24, 1e24, 1e14, 1e14, 10, uint64(vm.getBlockTimestamp() + 1 hours), uint64(vm.getBlockTimestamp() + 2 hours), 5000, 1000, 0, 0);
        factory.createLaunch("Gamma", "G", 0, 0, p, "");
        vm.expectRevert(SharedVault.NotLaunched.selector);
        _admit(2);
    }

    function test_admit_rejectsPairLaunches() public {
        _launchAndSettle(pairFactory, "Old", 5);
        vm.expectRevert(SharedVault.NotUniswap.selector);
        shared.admit(ISharedLaunchFactory(address(pairFactory)), 0);
    }

    /// CL-05 (external review, Nov 2026): anyone could open a per-token vault for a Uniswap launch before the keeper
    /// admitted it here, and admit then refused it forever (HasOwnVault). Now CloakVaults refuses a launch that opened
    /// on Uniswap, so the race can't be won and the token still joins the shared vault.
    function test_aUniswapLaunchCantBeLockedOutOfTheSharedVault() public {
        vm.expectRevert(CloakVaults.SharedVaultToken.selector);
        vaults.createPool(ILaunchFactory(address(factory)), 0);
        _admit(0);
        assertTrue(shared.admitted(address(a)));
    }

    // ───────────────────────────── deposits ─────────────────────────────

    function test_depositTo_hashesTheTokenIntoTheNote() public {
        _admit(0);
        uint256 c = _deposit(a, 1000e18);
        assertEq(c, p4.poseidon([uint256(1000e18), 7, 9, uint256(uint160(address(a)))]));
        assertEq(shared.deposited(address(a)), 1000e18);
        assertEq(a.balanceOf(address(shared)), 1000e18);
    }

    function test_depositTo_rejectsTokensNotAdmitted() public {
        vm.startPrank(alice);
        a.approve(address(shared), 1);
        vm.expectRevert(SharedVault.NotAdmitted.selector);
        shared.depositTo(address(a), 7, 1, 9, hex"");
        vm.stopPrank();
    }

    function test_transactDeposit_mustNameItsToken() public {
        _admit(0);
        vm.startPrank(alice);
        a.approve(address(shared), 100e18);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(0), int256(100e18), address(0), 0, hex"01", hex"02", "");
        SharedVault.Proof memory pr = _sp(ext, 0); // token hidden while money comes in: refused
        vm.expectRevert(SharedVault.NotAdmitted.selector);
        shared.transact(pr, ext);
        pr = _sp(ext, uint256(uint160(address(a))));
        shared.transact(pr, ext);
        vm.stopPrank();
        assertEq(shared.deposited(address(a)), 100e18);
    }

    function test_limits_perToken() public {
        _admit(0);
        config.setDefaultLimit(1, 2); // 0.01% per deposit, 0.02% total, of each token's supply
        config.turnOnDepositLimits();
        uint256 per = (a.totalSupply() * 1) / 10_000;
        _deposit(a, per);
        vm.startPrank(alice);
        a.approve(address(shared), per + 1);
        vm.expectRevert(SharedVault.OverDepositLimit.selector);
        shared.depositTo(address(a), 7, per + 1, 9, hex"");
        vm.stopPrank();
    }

    // ───────────────────────────── withdrawals and the per-token guard ─────────────────────────────

    function test_withdraw_paysTheNamedTokenMinusFee() public {
        _admit(0);
        _deposit(a, 1000e18);
        SharedVault.ExtData memory ext = _out(address(0xB0B), 400e18, 0);
        shared.transact(_sp(ext, uint256(uint160(address(a)))), ext);
        uint256 fee = config.withdrawFee(400e18);
        assertEq(a.balanceOf(address(0xB0B)), 400e18 - fee);
        assertEq(shared.deposited(address(a)), 600e18);
        assertEq(shared.feesOwed(address(a)), fee);
        if (fee > 0) {
            shared.collectFees(address(a));
            assertEq(a.balanceOf(address(0xFEE)), fee);
        }
    }

    /// Even with a verifier that accepts anything, a withdrawal of A can never take B's money.
    function test_guard_cannotWithdrawMoreOfATokenThanWasDeposited() public {
        _admit(0);
        _admit(1);
        _deposit(a, 100e18);
        _deposit(b, 100_000e18);
        SharedVault.ExtData memory ext = _out(address(0xB0B), 101e18, 0);
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert(); // deposited[a] underflow
        shared.transact(pr, ext);
        // and a relayer fee can't drain it either
        ext = SharedVault.ExtData(address(0), 0, relayer, 101e18, hex"01", hex"02", "");
        pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert();
        shared.transact(pr, ext);
        assertEq(a.balanceOf(address(shared)), 100e18);
        assertEq(b.balanceOf(address(shared)), 100_000e18);
    }

    function test_withdraw_hiddenTokenRefused() public {
        _admit(0);
        _deposit(a, 100e18);
        SharedVault.ExtData memory ext = _out(address(0xB0B), 1e18, 0);
        SharedVault.Proof memory pr = _sp(ext, 0);
        vm.expectRevert(SharedVault.NotAdmitted.selector);
        shared.transact(pr, ext);
    }

    function test_feeWithHiddenTokenRefused() public {
        _admit(0);
        _deposit(a, 100e18);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(0), 0, relayer, 1e18, hex"01", hex"02", "");
        SharedVault.Proof memory pr = _sp(ext, 0);
        vm.expectRevert(SharedVault.NotAdmitted.selector);
        shared.transact(pr, ext);
    }

    function test_publicAssetMustBeAnAddress() public {
        _admit(0);
        _deposit(a, 100e18);
        SharedVault.ExtData memory ext = _out(address(0xB0B), 1e18, 0);
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))) | (uint256(1) << 160));
        vm.expectRevert(SharedVault.NotAdmitted.selector);
        shared.transact(pr, ext);
    }

    function test_hiddenSend_movesNoTokens() public {
        _admit(0);
        _deposit(a, 100e18);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(0), 0, address(0), 0, hex"01", hex"02", "");
        SharedVault.Proof memory pr = _sp(ext, 0);
        shared.transact(pr, ext);
        assertEq(shared.deposited(address(a)), 100e18);
        assertTrue(shared.isSpent(pr.inputNullifiers[0]));
        vm.expectRevert(SharedVault.NullifierAlreadySpent.selector);
        shared.transact(pr, ext);
    }

    function test_badProofRefused() public {
        _admit(0);
        _deposit(a, 100e18);
        maVerifier.set(false);
        SharedVault.ExtData memory ext = _out(address(0xB0B), 1e18, 0);
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert(SharedVault.InvalidProof.selector);
        shared.transact(pr, ext);
    }

    function test_duplicateNullifierInOneProofRefused() public {
        _admit(0);
        _deposit(a, 100e18);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(0), 0, address(0), 0, hex"01", hex"02", "");
        SharedVault.Proof memory pr = _sp(ext, 0);
        pr.inputNullifiers[1] = pr.inputNullifiers[0];
        vm.expectRevert(SharedVault.NullifierAlreadySpent.selector);
        shared.transact(pr, ext);
    }

    // ───────────────────────────── router ─────────────────────────────

    function test_router_buy() public {
        _admit(0);
        _shieldHype(10 ether);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, hex"01", hex"02", _swapData(address(a), 1));
        uint256 out = router.buy(_hp(ext), ext);
        assertGt(out, 0);
        assertEq(shared.deposited(address(a)), out);
        assertEq(a.balanceOf(address(shared)), out);
        assertEq(address(router).balance, 0);
        assertEq(whype.balanceOf(address(router)), 0);
    }

    function test_router_buy_refusesTokensNotAdmitted() public {
        _shieldHype(10 ether);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, hex"01", hex"02", _swapData(address(a), 1));
        ShieldedPool.Proof memory pr = _hp(ext);
        vm.expectRevert(SharedRouter.NotAdmitted.selector);
        router.buy(pr, ext);
    }

    function test_router_buy_minOut() public {
        _admit(0);
        _shieldHype(10 ether);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, hex"01", hex"02", _swapData(address(a), type(uint128).max));
        ShieldedPool.Proof memory pr = _hp(ext);
        vm.expectRevert();
        router.buy(pr, ext);
    }

    function test_router_sell() public {
        _admit(0);
        _deposit(a, 10_000e18);
        uint256 hypeBefore = hypePool.deposited();
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(router), -int256(10_000e18), address(0), 0, hex"01", hex"02", _swapData(address(a), 1));
        uint256 out = router.sell(_sp(ext, uint256(uint160(address(a)))), ext);
        assertGt(out, 0);
        assertEq(hypePool.deposited() - hypeBefore, out);
        assertEq(shared.deposited(address(a)), 0);
        assertEq(a.balanceOf(address(router)), 0);
    }

    function test_router_sell_tokenMustMatchProof() public {
        _admit(0);
        _admit(1);
        _deposit(a, 10_000e18);
        _deposit(b, 10_000e18);
        // proof spends A, instructions claim B: refused
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(router), -int256(1_000e18), address(0), 0, hex"01", hex"02", _swapData(address(b), 1));
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert(SharedRouter.NotAdmitted.selector);
        router.sell(pr, ext);
    }

    function test_router_send_paysRelayerInHype() public {
        _admit(0);
        _deposit(a, 100e18);
        _shieldHype(1 ether);
        SharedVault.ExtData memory sExt = SharedVault.ExtData(address(0), 0, address(0), 0, hex"01", hex"02", "");
        SharedVault.Proof memory sp = _sp(sExt, 0);
        ShieldedPool.ExtData memory fExt = ShieldedPool.ExtData(address(router), -0.01 ether, address(0), 0, hex"03", hex"04", abi.encode(router.sendFingerprint(sp)));
        ShieldedPool.Proof memory fp = _hp(fExt);
        vm.prank(relayer);
        router.send(sp, sExt, fp, fExt);
        assertEq(relayer.balance, hypePool.afterFee(0.01 ether));
        assertEq(shared.deposited(address(a)), 100e18);
        assertTrue(shared.isSpent(sp.inputNullifiers[0]));
    }

    function test_router_send_feeProofBoundToThisSend() public {
        _admit(0);
        _deposit(a, 100e18);
        _shieldHype(1 ether);
        SharedVault.ExtData memory sExt = SharedVault.ExtData(address(0), 0, address(0), 0, hex"01", hex"02", "");
        SharedVault.Proof memory sp = _sp(sExt, 0);
        ShieldedPool.ExtData memory fExt = ShieldedPool.ExtData(address(router), -0.01 ether, address(0), 0, hex"03", hex"04", abi.encode(bytes32(uint256(1))));
        ShieldedPool.Proof memory fp = _hp(fExt);
        vm.expectRevert(SharedRouter.BadFeeProof.selector);
        router.send(sp, sExt, fp, fExt);
    }

    function test_router_send_mustBeFree() public {
        _admit(0);
        _deposit(a, 100e18);
        _shieldHype(1 ether);
        SharedVault.ExtData memory sExt = SharedVault.ExtData(address(0), 0, relayer, 1e18, hex"01", hex"02", "");
        SharedVault.Proof memory sp = _sp(sExt, uint256(uint160(address(a))));
        ShieldedPool.ExtData memory fExt = ShieldedPool.ExtData(address(router), -0.01 ether, address(0), 0, hex"03", hex"04", abi.encode(router.sendFingerprint(sp)));
        ShieldedPool.Proof memory fp = _hp(fExt);
        vm.expectRevert(SharedRouter.NotFree.selector);
        router.send(sp, sExt, fp, fExt);
    }

    function test_router_refusesDirectHype() public {
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
    }

    // ───────────────────────────── batch rounds ─────────────────────────────

    function _order(address token) internal view returns (bytes memory) {
        return abi.encode(SharedBatcher.OrderData(token, 77, 88, hex"bb"));
    }

    function _buyOrder(address token, uint256 size) internal returns (uint256) {
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(batcher), -int256(size), address(0), 0, hex"01", hex"02", _order(token));
        return batcher.placeBuy(_hp(ext), ext);
    }

    function _sellOrder(address token, uint256 size, uint256 publicAsset) internal returns (uint256) {
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(batcher), -int256(size), address(0), 0, hex"01", hex"02", _order(token));
        return batcher.placeSell(_sp(ext, publicAsset), ext);
    }

    /// Buys and sells of a shared-vault token cross at the round's average price; only the net trades on Uniswap, and
    /// every output lands as a note in the right vault.
    function test_batch_crossesAndPaysIntoTheRightVaults() public {
        _admit(0);
        _shieldHype(10 ether);
        _deposit(a, 100_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(((t0 / 30) + 1) * 30); // start of a fresh round
        uint256 buyId = _buyOrder(address(a), 1 ether);
        uint256 sellId = _sellOrder(address(a), 1000e18, uint256(uint160(address(a)))); // ~2 HYPE: net 1 HYPE of selling, well inside the 5% impact guard
        vm.warp(((t0 / 30) + 2) * 30 + 1); // round over
        (,,,,,, uint32 n,,,) = batcher.batches(address(a), batcher.currentRound() - 1);
        assertEq(n, 2);
        uint256 sharedBefore = shared.deposited(address(a));
        uint256 hypeBefore = hypePool.deposited();
        batcher.settle(address(a), batcher.currentRound() - 1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = buyId;
        ids[1] = sellId;
        batcher.claim(ids);
        assertGt(shared.deposited(address(a)), sharedBefore, "buyer's tokens landed in the shared vault");
        assertGt(hypePool.deposited(), hypeBefore, "seller's HYPE landed in the HYPE vault");
        assertEq(address(batcher).balance, 0);
        assertLe(a.balanceOf(address(batcher)), 1e6, "the batcher keeps at most rounding dust");
    }

    /// A round whose net trade would move the pool more than 5% can't settle, and is refunded instead.
    /// In a quiet round the first order can land seconds before the end: settling still waits one full round after it,
    /// and moving the pool for that whole window shifts the crossing price by at most the slippage bound.
    function test_batch_quietRoundCrossingPriceIsBounded() public {
        _admit(0);
        _shieldHype(10 ether);
        _deposit(a, 100_000e18);
        uint256 R = ((vm.getBlockTimestamp() / 30) + 1) * 30;
        vm.warp(R + 28);
        uint256 open = batcher.midPrice(address(a));
        _buyOrder(address(a), 1 ether);
        _sellOrder(address(a), 1000e18, uint256(uint160(address(a))));
        CloakV2Market m = CloakV2Market(payable(shared.marketOf(address(a))));
        m.swapExactHypeForTokens{value: 500 ether}(0, address(this));
        uint64 r = batcher.currentRound();
        vm.warp(R + 31);
        vm.expectRevert(SharedBatcher.TooSoon.selector);
        batcher.settle(address(a), r);
        vm.warp(R + 28 + 30);
        assertGt(batcher.twapOf(address(a), r), (open * 12) / 10, "the pool's average really did move");
        batcher.settle(address(a), r);
        (,, uint128 tokensForBuyers,,,,,,,) = batcher.batches(address(a), r);
        uint256 floor = (1 ether * 1e18) / ((open * (10_000 + batcher.maxSlippageBps())) / 10_000);
        assertGe(tokensForBuyers, floor - 1, "the buyer pays at most the opening price plus the slippage bound");
    }

    /// An order too big for the pool's depth never gets into a round, so it can't make the round refund for everyone.
    function test_batch_tooBigForThePoolIsRefused() public {
        _admit(0);
        _deposit(a, 100_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(((t0 / 30) + 1) * 30);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(batcher), -int256(50_000e18), address(0), 0, hex"01", hex"02", _order(address(a)));
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a)))); // ~100 HYPE into a ~985 HYPE pool
        vm.expectRevert(SharedBatcher.RoundFull.selector);
        batcher.placeSell(pr, ext);
    }

    /// CL-06 (external review, Nov 2026): a whale order used to push the round's net swap past the impact guard and make
    /// every order in the round refund (less the vault fee). Now each side of a round is capped at 4% of the pool's depth:
    /// the oversized order is refused, and the honest orders already in the round still settle.
    function test_batch_whaleOrderCantPoisonTheRound() public {
        _admit(0);
        _deposit(a, 200_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(((t0 / 30) + 1) * 30);
        uint256 honest = _sellOrder(address(a), 1_000e18, uint256(uint160(address(a))));
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(batcher), -int256(100_000e18), address(0), 0, hex"01", hex"02", _order(address(a)));
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert(SharedBatcher.RoundFull.selector);
        batcher.placeSell(pr, ext);
        vm.warp(((t0 / 30) + 2) * 30 + 1);
        uint64 round = batcher.currentRound() - 1;
        batcher.settle(address(a), round); // settles: the round isn't poisoned
        (,,, uint128 hypeForSellers,,,, bool settled, bool cancelled,) = batcher.batches(address(a), round);
        assertTrue(settled && !cancelled, "the round settled");
        assertGt(hypeForSellers, 0, "the honest seller is paid");
        (address tok,,,,,,,,) = batcher.orders(honest);
        assertEq(tok, address(a));
    }

    function test_batch_sellMustNameItsToken() public {
        _admit(0);
        _admit(1);
        _deposit(a, 10_000e18);
        _deposit(b, 10_000e18);
        SharedVault.ExtData memory ext = SharedVault.ExtData(address(batcher), -int256(1000e18), address(0), 0, hex"01", hex"02", _order(address(b)));
        SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(a))));
        vm.expectRevert(SharedBatcher.UnknownPool.selector);
        batcher.placeSell(pr, ext);
    }

    function test_batch_onlySharedVaultTokens() public {
        _shieldHype(10 ether);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(batcher), -int256(1 ether), address(0), 0, hex"01", hex"02", _order(address(a)));
        ShieldedPool.Proof memory pr = _hp(ext);
        vm.expectRevert(SharedBatcher.NoMarket.selector);
        batcher.placeBuy(pr, ext);
    }

    function test_batch_standardSizesOnly() public {
        _admit(0);
        _shieldHype(10 ether);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(batcher), -int256(3 ether), address(0), 0, hex"01", hex"02", _order(address(a)));
        ShieldedPool.Proof memory pr = _hp(ext);
        vm.expectRevert(SharedBatcher.NotStandardSize.selector);
        batcher.placeBuy(pr, ext);
    }

    function test_batch_refundGoesBackWhereItCameFrom() public {
        _admit(0);
        _shieldHype(10 ether);
        _deposit(a, 10_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 buyId = _buyOrder(address(a), 1 ether);
        uint256 sellId = _sellOrder(address(a), 1000e18, uint256(uint160(address(a))));
        uint256 hypeAfterOrder = hypePool.deposited();
        uint256 sharedAfterOrder = shared.deposited(address(a));
        uint256[] memory ids = new uint256[](2);
        ids[0] = buyId;
        ids[1] = sellId;
        vm.expectRevert(SharedBatcher.TooEarly.selector);
        batcher.refund(ids);
        vm.warp(t0 + 30 + 600 + 31);
        batcher.refund(ids);
        assertEq(hypePool.deposited(), hypeAfterOrder + hypePool.afterFee(1 ether), "buy refunded into the HYPE vault");
        assertEq(shared.deposited(address(a)), sharedAfterOrder + shared.afterFee(1000e18), "sell refunded into the shared vault");
    }

    function test_batch_refusesDirectHype() public {
        (bool ok,) = address(batcher).call{value: 1}("");
        assertFalse(ok);
    }

    // ───────────────────────────── fuzz: two tokens, random moves ─────────────────────────────

    /// Random deposits and withdrawals across two tokens with an accepting verifier: every token's balance always
    /// covers its own notes and fees, and a failed move never changes anything.
    function testFuzz_perTokenSolvency(uint256 seed) public {
        _admit(0);
        _admit(1);
        CloakToken[2] memory ts = [a, b];
        for (uint256 i = 0; i < 12; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            CloakToken t = ts[r % 2];
            uint256 amt = (r >> 8) % 50_000e18 + 1;
            if ((r >> 200) % 2 == 0) {
                _deposit(t, amt);
            } else {
                SharedVault.ExtData memory ext = _out(address(0xB0B), int256(amt), 0);
                SharedVault.Proof memory pr = _sp(ext, uint256(uint160(address(t))));
                try this.doTransact(pr, ext) {} catch {}
            }
            for (uint256 k = 0; k < 2; k++) {
                assertGe(ts[k].balanceOf(address(shared)), shared.deposited(address(ts[k])) + shared.feesOwed(address(ts[k])), "solvent");
            }
        }
    }

    function doTransact(SharedVault.Proof calldata pr, SharedVault.ExtData calldata ext) external {
        shared.transact(pr, ext);
    }
}
