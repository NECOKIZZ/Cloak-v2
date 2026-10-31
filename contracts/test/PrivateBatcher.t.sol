// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakToken} from "../src/CloakToken.sol";
import {CloakPair} from "../src/CloakPair.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {PrivateRouter} from "../src/shielded/PrivateRouter.sol";
import {CloakVaults, ILaunchFactory} from "../src/shielded/CloakVaults.sol";
import {PrivateBatcher} from "../src/shielded/PrivateBatcher.sol";
import {WHYPE} from "../src/shielded/WHYPE.sol";
import {IPoseidon2, IPoseidon3} from "../src/shielded/interfaces/IHasher.sol";
import {IVerifier} from "../src/shielded/interfaces/IVerifier.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

contract PrivateBatcherTest is Test {
    CloakConfig config;
    CloakAuction auction;
    CloakToken token;
    CloakPair pair;
    PrivateRouter router;
    PrivateBatcher batcher;
    ShieldedPool hypePool;
    ShieldedPool tokenPool;
    WHYPE whype;
    uint256 nonce = 1;
    uint64 constant ROUND = 30;

    function _deployCode(string memory path) internal returns (address a) {
        bytes memory code = vm.parseBytes(vm.readFile(path));
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
    }

    function setUp() public virtual {
        vm.warp(1_000_000);
        config = new CloakConfig(address(new MockVerifier()), address(0));
        CloakFactory factory = new CloakFactory(config, new CloakVestingDeployer());
        CloakAuction.Params memory p = CloakAuction.Params(
            address(this), 1_000_000e18, 1_000_000e18, 0.001 ether, 0.001 ether, 10,
            uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours), 5000, 1000, 0, 0
        );
        (address a, address t) = factory.createLaunch("Shade", "SHADE", 0, 0, p, "");
        auction = CloakAuction(payable(a));
        token = CloakToken(t);
        // settle: one bidder takes the whole sale at tick 4 (0.005 HYPE/token)
        address alice = makeAddr("alice");
        vm.deal(alice, 10_000 ether);
        bytes32 h = auction.commitmentOf(alice, 4, 1_000_000e18, bytes32(uint256(7)));
        vm.prank(alice);
        auction.commit{value: 5_000 ether}(h, "");
        vm.warp(block.timestamp + 1 hours);
        auction.reveal(0, 4, 1_000_000e18, bytes32(uint256(7)));
        vm.warp(block.timestamp + 1 hours);
        auction.settle();
        auction.claim(0);
        pair = auction.pair();

        whype = new WHYPE();
        config.addLaunchFactory(address(factory));
        config.approveAsset(address(whype));
        CloakVaults vaults = new CloakVaults(
            config, IPoseidon2(_deployCode("test/fixtures/poseidon2.hex")), IPoseidon3(_deployCode("test/fixtures/poseidon3.hex"))
        );
        vaults.createAssetPool(address(whype));
        router = new PrivateRouter(vaults, whype);
        tokenPool = vaults.createPool(ILaunchFactory(address(factory)), 0);
        hypePool = router.hypePool();
        batcher = new PrivateBatcher(router, ROUND, 200, 10 minutes, 1);

        // fund the shielded pools: 100 HYPE, and 10k tokens bought publicly then shielded
        vm.deal(address(this), 1_000 ether);
        router.shieldHype{value: 100 ether}(1, 2, "");
        pair.swapExactHypeForTokens{value: 60 ether}(0, address(this));
        token.approve(address(tokenPool), type(uint256).max);
        tokenPool.depositTo(3, token.balanceOf(address(this)), 4, "");
        vm.warp((block.timestamp / ROUND + 1) * ROUND); // start of a fresh round
    }

    function hashExt(ShieldedPool pool, ShieldedPool.ExtData calldata ext) external pure returns (uint256) {
        return pool.hashExtData(ext);
    }

    function _order(ShieldedPool poolIn, uint256 size) internal returns (uint256) {
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _build(poolIn, size, 77);
        return batcher.placeOrder(poolIn, pr, ext);
    }

    function _build(ShieldedPool poolIn, uint256 size, uint256 outKey)
        internal
        returns (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext)
    {
        PrivateBatcher.OrderData memory d = PrivateBatcher.OrderData(address(token), outKey, 88, hex"cc");
        ext = ShieldedPool.ExtData(address(batcher), -int256(size), address(0), 0, "", "", abi.encode(d));
        pr.root = poolIn.currentRoot();
        pr.publicAmount = poolIn.calculatePublicAmount(ext.extAmount, 0);
        pr.extDataHash = this.hashExt(poolIn, ext);
        pr.inputNullifiers = [uint256(keccak256(abi.encode(nonce++))) % poolIn.FIELD_SIZE(), uint256(keccak256(abi.encode(nonce++))) % poolIn.FIELD_SIZE()];
        pr.outputCommitments = [uint256(11), uint256(12)];
    }

    function _endRound() internal returns (uint64 r) {
        r = batcher.currentRound();
        vm.warp(batcher.roundEnd(r));
    }

    function test_standardSizes() public view {
        assertTrue(batcher.isStandardSize(1));
        assertTrue(batcher.isStandardSize(2e17));
        assertTrue(batcher.isStandardSize(5e18));
        assertTrue(batcher.isStandardSize(1000));
        assertFalse(batcher.isStandardSize(3e17));
        assertFalse(batcher.isStandardSize(15e16));
        assertFalse(batcher.isStandardSize(0));
    }

    function test_rejectsNonStandardSize() public {
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _build(hypePool, 3e17, 1);
        vm.expectRevert(PrivateBatcher.NotStandardSize.selector);
        batcher.placeOrder(hypePool, pr, ext);
    }

    function test_netBuyRound_uniformPrice_onlyNetHitsPool() public {
        uint256 b1 = _order(hypePool, 1 ether);
        uint256 b2 = _order(hypePool, 2 ether);
        uint256 b3 = _order(hypePool, 1 ether);
        uint256 s1 = _order(tokenPool, 100e18); // 100 tokens ≈ 0.5 HYPE at mid
        uint256 mid = batcher.midPrice(address(token));
        uint256 rH = pair.reserveHype();
        uint64 r = _endRound();

        batcher.settle(address(token), r);
        (,, uint128 tokensForBuyers, uint128 hypeForSellers,,,, bool settled,) = batcher.batches(address(token), r);
        assertTrue(settled);
        // the seller was crossed at exactly the mid-price, with no pool fee
        assertEq(hypeForSellers, (100e18 * mid) / 1e18);
        // only the net (4 HYPE − sell value) went through the pool
        assertEq(pair.reserveHype() - rH, 4 ether - hypeForSellers);

        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (b1, b2, b3, s1);
        uint256 before = token.balanceOf(address(tokenPool));
        batcher.claim(ids);
        uint256 paid = token.balanceOf(address(tokenPool)) - before;
        assertLe(paid, tokensForBuyers);
        assertApproxEqAbs(paid, tokensForBuyers, 3);
        // same price for every buyer: order 2 (2 HYPE) got exactly twice order 1 (1 HYPE)
        assertEq(uint256(tokensForBuyers) * 2 ether / 4 ether, 2 * (uint256(tokensForBuyers) * 1 ether / 4 ether));
    }

    function test_netSellRound() public {
        _order(hypePool, 1e17);
        _order(tokenPool, 500e18);
        _order(tokenPool, 200e18);
        uint256 mid = batcher.midPrice(address(token));
        uint256 rT = pair.reserveToken();
        uint64 r = _endRound();
        batcher.settle(address(token), r);
        (,, uint128 tokensForBuyers, uint128 hypeForSellers,,,,,) = batcher.batches(address(token), r);
        assertEq(tokensForBuyers, (1e17 * 1e18) / mid); // buyer filled by sellers at mid
        assertEq(pair.reserveToken() - rT, 700e18 - tokensForBuyers); // only the net sold into the pool
        assertGt(hypeForSellers, 1e17);
    }

    function test_settleTiming() public {
        _order(hypePool, 1 ether);
        uint64 r = batcher.currentRound();
        vm.expectRevert(PrivateBatcher.RoundOpen.selector);
        batcher.settle(address(token), r);
        _endRound();
        batcher.settle(address(token), r);
        vm.expectRevert(PrivateBatcher.AlreadySettled.selector);
        batcher.settle(address(token), r);
    }

    function test_manipulatedPrice_blocksSettle_thenRefund() public {
        uint256 id = _order(hypePool, 1 ether);
        uint64 r = _endRound();
        pair.swapExactHypeForTokens{value: 300 ether}(0, address(this)); // push the price way up
        vm.expectRevert(PrivateBatcher.PriceMoved.selector);
        batcher.settle(address(token), r);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectRevert(PrivateBatcher.TooEarly.selector);
        batcher.refund(ids);
        vm.warp(block.timestamp + 10 minutes);
        uint256 before = whype.balanceOf(address(hypePool));
        batcher.refund(ids);
        assertEq(whype.balanceOf(address(hypePool)) - before, 1 ether);
        vm.expectRevert(PrivateBatcher.AlreadySettled.selector);
        batcher.settle(address(token), r);
    }

    function test_relayerCannotRedirectOrder() public {
        (ShieldedPool.Proof memory pr, ShieldedPool.ExtData memory ext) = _build(hypePool, 1 ether, 77);
        PrivateBatcher.OrderData memory d = abi.decode(ext.data, (PrivateBatcher.OrderData));
        d.outPubKey = 666;
        ext.data = abi.encode(d);
        vm.expectRevert(ShieldedPool.BadExtDataHash.selector);
        batcher.placeOrder(hypePool, pr, ext);
    }

    receive() external payable {}
}
