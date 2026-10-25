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
import {PrivateRouter, ICloakFactory} from "../src/shielded/PrivateRouter.sol";
import {WHYPE} from "../src/shielded/WHYPE.sol";
import {IPoseidon2, IPoseidon3} from "../src/shielded/interfaces/IHasher.sol";
import {IVerifier} from "../src/shielded/interfaces/IVerifier.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

/// Router logic with a mock verifier (proof validity itself is covered by the JS e2e with real Groth16 proofs).
contract PrivateRouterTest is Test {
    CloakConfig config;
    CloakFactory factory;
    CloakAuction auction;
    CloakToken token;
    CloakPair pair;
    PrivateRouter router;
    MockVerifier verifier;
    ShieldedPool hypePool;
    ShieldedPool tokenPool;
    WHYPE whype;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    uint256 nonce = 1;

    function _deployCode(string memory path) internal returns (address a) {
        bytes memory code = vm.parseBytes(vm.readFile(path));
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "deploy");
    }

    function setUp() public {
        config = new CloakConfig(address(new MockVerifier()), address(0));
        factory = new CloakFactory(config, new CloakVestingDeployer());
        CloakAuction.Params memory p = CloakAuction.Params({
            creator: address(this),
            saleSupply: 1_000_000e18,
            lpReserve: 1_000_000e18,
            minPrice: 0.001 ether,
            tickSize: 0.001 ether,
            numTicks: 10,
            commitEnd: uint64(block.timestamp + 1 hours),
            revealEnd: uint64(block.timestamp + 2 hours),
            lpBps: 5000,
            noRevealPenaltyBps: 1000,
            lpLockUntil: 0,
            tlockRound: 0
        });
        (address a, address t) = factory.createLaunch("Shade", "SHADE", 0, 0, p, "");
        auction = CloakAuction(payable(a));
        token = CloakToken(t);

        verifier = MockVerifier(config.verifier());
        IPoseidon2 p2 = IPoseidon2(_deployCode("test/fixtures/poseidon2.hex"));
        IPoseidon3 p3 = IPoseidon3(_deployCode("test/fixtures/poseidon3.hex"));
        router = new PrivateRouter(config, p2, p3, ICloakFactory(address(factory)), ICloakFactory(address(0)), WHYPE(payable(address(0))));
        hypePool = router.hypePool();
        whype = router.whype();
    }

    function _settleLaunch() internal {
        vm.deal(alice, 10_000 ether);
        bytes32 salt = bytes32(uint256(7));
        bytes32 h = auction.commitmentOf(alice, 4, 1_000_000e18, salt);
        vm.prank(alice);
        uint256 id = auction.commit{value: 5_000 ether}(h, "");
        vm.warp(block.timestamp + 1 hours);
        auction.reveal(id, 4, 1_000_000e18, salt);
        vm.warp(block.timestamp + 1 hours);
        auction.settle();
        auction.claim(id);
        pair = auction.pair();
        tokenPool = router.createPool(0);
    }

    function _proof(ShieldedPool pool, ShieldedPool.ExtData memory ext) internal returns (ShieldedPool.Proof memory pr) {
        pr.root = pool.currentRoot();
        pr.publicAmount = pool.calculatePublicAmount(ext.extAmount, ext.fee);
        pr.extDataHash = this.hashExt(pool, ext);
        pr.inputNullifiers = [uint256(keccak256(abi.encode(nonce++))) % pool.FIELD_SIZE(), uint256(keccak256(abi.encode(nonce++))) % pool.FIELD_SIZE()];
        pr.outputCommitments = [uint256(11), uint256(12)];
    }

    function hashExt(ShieldedPool pool, ShieldedPool.ExtData calldata ext) external pure returns (uint256) {
        return pool.hashExtData(ext);
    }

    function _swapExt(int256 amountIn, address poolOut, uint256 minOut, uint256 fee) internal view returns (ShieldedPool.ExtData memory) {
        PrivateRouter.SwapData memory d = PrivateRouter.SwapData({
            pair: address(pair),
            poolOut: poolOut,
            minOut: minOut,
            outPubKey: 123,
            outBlinding: 456,
            outMemo: hex"aa",
            deadline: uint64(block.timestamp + 60)
        });
        return ShieldedPool.ExtData(address(router), -amountIn, relayer, fee, hex"01", hex"02", abi.encode(d));
    }

    function test_createPool_onlyAfterSettle() public {
        vm.expectRevert(PrivateRouter.NotLaunched.selector);
        router.createPool(0);
        _settleLaunch();
        assertEq(address(router.poolOf(address(token))), address(tokenPool));
        assertEq(address(router.pairOf(address(token))), address(pair));
        vm.expectRevert(PrivateRouter.PoolExists.selector);
        router.createPool(0);
    }

    function test_shieldHype() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        router.shieldHype{value: 1 ether}(42, 43, hex"bb");
        assertEq(whype.balanceOf(address(hypePool)), 1 ether);
        assertEq(hypePool.nextIndex(), 1);
    }

    function test_privateBuy_thenPrivateSell() public {
        _settleLaunch();
        vm.deal(address(this), 10 ether);
        router.shieldHype{value: 10 ether}(1, 2, "");

        // buy: 1 WHYPE (+0.01 fee) out of the shielded pool → tokens into the token pool
        ShieldedPool.ExtData memory ext = _swapExt(1 ether, address(tokenPool), 1, 0.01 ether);
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        uint256 expected = pair.getAmountOut(1 ether, pair.reserveHype(), pair.reserveToken());
        vm.prank(relayer); // a relayer submits; the trader's address never appears
        uint256 out = router.privateSwap(hypePool, pr, ext);
        assertEq(out, expected);
        assertEq(token.balanceOf(address(tokenPool)), out);
        assertEq(whype.balanceOf(relayer), 0.01 ether);
        assertEq(whype.balanceOf(address(hypePool)), 10 ether - 1.01 ether);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);

        // sell half back: tokens out of the token pool → WHYPE into the HYPE pool
        uint256 sellAmt = out / 2;
        ext = _swapExt(int256(sellAmt), address(hypePool), 1, 0);
        pr = _proof(tokenPool, ext);
        uint256 before = whype.balanceOf(address(hypePool));
        uint256 hypeOut = router.privateSwap(tokenPool, pr, ext);
        assertGt(hypeOut, 0);
        assertEq(whype.balanceOf(address(hypePool)) - before, hypeOut);
        assertEq(token.balanceOf(address(tokenPool)), out - sellAmt);
    }

    function test_relayerCannotChangeInstructions() public {
        _settleLaunch();
        vm.deal(address(this), 10 ether);
        router.shieldHype{value: 10 ether}(1, 2, "");
        ShieldedPool.ExtData memory ext = _swapExt(1 ether, address(tokenPool), 1, 0);
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        // relayer swaps in its own output key → extDataHash no longer matches the proof
        PrivateRouter.SwapData memory d = abi.decode(ext.data, (PrivateRouter.SwapData));
        d.outPubKey = 999;
        ext.data = abi.encode(d);
        vm.expectRevert(ShieldedPool.BadExtDataHash.selector);
        router.privateSwap(hypePool, pr, ext);
    }

    function test_rejectsBadRoutes() public {
        _settleLaunch();
        vm.deal(address(this), 10 ether);
        router.shieldHype{value: 10 ether}(1, 2, "");

        // WHYPE → WHYPE is not a trade
        ShieldedPool.ExtData memory ext = _swapExt(1 ether, address(hypePool), 1, 0);
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        vm.expectRevert(PrivateRouter.BadPair.selector);
        router.privateSwap(hypePool, pr, ext);

        // unregistered pair
        CloakPair fake = new CloakPair(address(token));
        PrivateRouter.SwapData memory d = PrivateRouter.SwapData(address(fake), address(tokenPool), 1, 1, 1, "", uint64(block.timestamp + 60));
        ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, "", "", abi.encode(d));
        pr = _proof(hypePool, ext);
        vm.expectRevert(PrivateRouter.BadPair.selector);
        router.privateSwap(hypePool, pr, ext);

        // expired
        ext = _swapExt(1 ether, address(tokenPool), 1, 0);
        pr = _proof(hypePool, ext);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(PrivateRouter.Expired.selector);
        router.privateSwap(hypePool, pr, ext);
    }

    function test_slippageRevertsWholeSwap() public {
        _settleLaunch();
        vm.deal(address(this), 10 ether);
        router.shieldHype{value: 10 ether}(1, 2, "");
        ShieldedPool.ExtData memory ext = _swapExt(1 ether, address(tokenPool), type(uint128).max, 0);
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        vm.expectRevert(bytes("slippage"));
        router.privateSwap(hypePool, pr, ext);
        // nothing spent: nullifiers untouched
        assertFalse(hypePool.isSpent(pr.inputNullifiers[0]));
    }

    function test_unshieldHype() public {
        vm.deal(address(this), 3 ether);
        router.shieldHype{value: 3 ether}(1, 2, "");
        address fresh = makeAddr("fresh");
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, "", "", abi.encode(fresh));
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        router.unshieldHype(pr, ext);
        assertEq(fresh.balance, 1 ether);
    }

    function test_invalidProofRejected() public {
        vm.deal(address(this), 3 ether);
        router.shieldHype{value: 3 ether}(1, 2, "");
        verifier.set(false);
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(address(router), -1 ether, address(0), 0, "", "", abi.encode(alice));
        ShieldedPool.Proof memory pr = _proof(hypePool, ext);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        router.unshieldHype(pr, ext);
    }

    receive() external payable {}
}
