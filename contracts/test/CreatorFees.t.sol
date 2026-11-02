// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapLaunchTest} from "./UniswapLaunch.t.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction, IFeeLocker} from "../src/CloakAuction.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";
import {CloakSeeder} from "../src/CloakSeeder.sol";
import {CloakFeeLocker} from "../src/CloakFeeLocker.sol";
import {CloakV2Market} from "../src/CloakV2Market.sol";
import {IUniswapV2Pair} from "../src/uniswap/IUniswapV2.sol";

/// "Locked forever, the creator earns the trading fees": against the real testnet Uniswap V2 (fork).
///   forge test --match-contract CreatorFees
contract CreatorFeesTest is UniswapLaunchTest {
    CloakFeeLocker locker;
    address attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        locker = new CloakFeeLocker();
        factory = new CloakFactory(config, new CloakVestingDeployer(), seeder, IFeeLocker(address(locker)));
        vm.deal(attacker, 10_000 ether);
    }

    function _settleForever() internal returns (CloakV2Market m, IUniswapV2Pair p) {
        _launch(type(uint64).max);
        _bidAndClose();
        auction.settle();
        m = CloakV2Market(payable(address(auction.pair())));
        p = _pool();
    }

    /// what the locked LP is worth, in √k units (must never fall below its value at the lock)
    function _lockedValue(IUniswapV2Pair p, uint256 shares) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = p.getReserves();
        return (_sqrt(uint256(r0) * r1) * shares) / p.totalSupply();
    }

    function _trade(CloakV2Market m, address who, uint256 hypeIn) internal {
        vm.startPrank(who);
        uint256 got = m.swapExactHypeForTokens{value: hypeIn}(0, who);
        token.approve(address(m), got);
        m.swapExactTokensForHype(got, 0, who);
        vm.stopPrank();
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ───────────────────────────── the lock ─────────────────────────────

    function test_foreverLock_LPInLocker_forCreator() public {
        (, IUniswapV2Pair p) = _settleForever();
        assertTrue(auction.creatorFees());
        CloakFeeLocker.Position memory pos = locker.positions(auction.feePosition());
        assertEq(address(pos.pair), address(p));
        assertEq(pos.beneficiary, creator);
        assertEq(pos.shares, auction.lpShares());
        assertEq(p.balanceOf(address(locker)), auction.lpShares());
        assertEq(p.balanceOf(address(auction)), 0);
        assertEq(locker.claimable(auction.feePosition()), 0, "nothing earned before any trade");
        vm.warp(vm.getBlockTimestamp() + 3650 days);
        vm.expectRevert("locked");
        auction.releaseLP(); // never, even in ten years
    }

    function test_burnAndDatedLock_unchanged() public {
        _launch(0);
        _bidAndClose();
        auction.settle();
        assertFalse(auction.creatorFees());
        assertEq(locker.positionsCount(), 0);
    }

    // ───────────────────────────── earning fees ─────────────────────────────

    function test_tradesEarnFees_claimPaysCreator_lockNeverShrinks() public {
        (CloakV2Market m, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        uint256 hypeBefore = m.reserveHype();
        for (uint256 i; i < 10; ++i) _trade(m, trader, 20 ether); // ~400 HYPE of volume
        assertGt(locker.claimable(id), 0);
        (uint256 e0, uint256 e1) = locker.claimableAmounts(id);
        uint256 wBefore = WHYPE.balanceOf(creator);
        uint256 tBefore = token.balanceOf(creator);
        (uint256 a0, uint256 a1) = locker.claim(id); // anyone can call; it pays the creator
        assertEq(a0, e0);
        assertEq(a1, e1);
        uint256 gotW = WHYPE.balanceOf(creator) - wBefore;
        uint256 gotT = token.balanceOf(creator) - tBefore;
        assertGt(gotW, 0);
        assertGt(gotT, 0);
        // the fee earned is about 0.3% × volume on each side; the HYPE side alone is ~half of it
        emit log_named_decimal_uint("creator fee, WHYPE", gotW, 18);
        emit log_named_decimal_uint("creator fee, tokens", gotT, 18);
        assertLt(gotW, (400 ether * 3) / 1000, "never more than the fees paid");
        // the locked liquidity is still worth what it was at the lock
        assertGe(_lockedValue(p, locker.positions(id).shares), v0);
        assertGe(m.reserveHype(), hypeBefore - gotW - 1);
        // nothing more to claim right after
        assertEq(locker.claimable(id), 0);
    }

    function test_repeatedClaims_neverTakePrincipal() public {
        (CloakV2Market m, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        for (uint256 i; i < 20; ++i) {
            _trade(m, trader, 3 ether);
            locker.claim(id);
            assertGe(_lockedValue(p, locker.positions(id).shares), v0, "lock shrank");
        }
        // claiming with no new trades does nothing
        uint256 s = locker.positions(id).shares;
        locker.claim(id);
        locker.claim(id);
        assertEq(locker.positions(id).shares, s);
    }

    // ───────────────────────────── attacks ─────────────────────────────

    function test_flashMovePriceAndBack_attackerPaysCreator() public {
        (CloakV2Market m, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        uint256 start = attacker.balance;
        // push the price hard, claim at the moved price, push it back
        vm.startPrank(attacker);
        uint256 got = m.swapExactHypeForTokens{value: 500 ether}(0, attacker);
        locker.claim(id);
        token.approve(address(m), got);
        m.swapExactTokensForHype(got, 0, attacker);
        vm.stopPrank();
        assertLt(attacker.balance, start, "the attacker loses (the fees)");
        assertGe(_lockedValue(p, locker.positions(id).shares), v0, "lock intact");
    }

    function test_donationAndSync_onlyAddsToFees() public {
        (, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        vm.startPrank(attacker);
        WHYPE.deposit{value: 10 ether}();
        WHYPE.transfer(address(p), 10 ether);
        (bool ok,) = address(p).call(abi.encodeWithSignature("sync()"));
        assertTrue(ok);
        vm.stopPrank();
        uint256 before = WHYPE.balanceOf(creator);
        locker.claim(id);
        assertLt(WHYPE.balanceOf(creator) - before, 10 ether, "the creator gets part of a donation, never more");
        assertGe(_lockedValue(p, locker.positions(id).shares), v0);
    }

    function test_outsideLP_keepsTheirOwn_lockUnaffected() public {
        (CloakV2Market m, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        // someone else provides liquidity at the market price, trades happen, they leave
        vm.startPrank(attacker);
        uint256 tok = m.swapExactHypeForTokens{value: 50 ether}(0, attacker);
        uint256 rH = m.reserveHype();
        uint256 rT = m.reserveToken();
        uint256 hypeForTok = (tok * rH) / rT;
        WHYPE.deposit{value: hypeForTok}();
        WHYPE.transfer(address(p), hypeForTok);
        token.transfer(address(p), tok);
        uint256 lp = p.mint(attacker);
        vm.stopPrank();
        _trade(m, trader, 30 ether);
        locker.claim(id);
        vm.startPrank(attacker);
        p.transfer(address(p), lp);
        p.burn(attacker);
        vm.stopPrank();
        assertGe(_lockedValue(p, locker.positions(id).shares), v0);
        locker.claim(id);
        assertGe(_lockedValue(p, locker.positions(id).shares), v0);
    }

    function testFuzz_anyTradesAndClaims_lockNeverShrinks(uint256 seed) public {
        (CloakV2Market m, IUniswapV2Pair p) = _settleForever();
        uint256 id = auction.feePosition();
        uint256 v0 = _lockedValue(p, locker.positions(id).shares);
        for (uint256 i; i < 8; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 amt = (r % 200 ether) + 0.01 ether;
            if (r % 3 == 0) {
                locker.claim(id);
            } else if (r % 3 == 1) {
                vm.prank(trader);
                m.swapExactHypeForTokens{value: amt}(0, trader);
            } else {
                uint256 bal = token.balanceOf(trader);
                if (bal == 0) continue;
                vm.startPrank(trader);
                token.approve(address(m), bal / 2 + 1);
                m.swapExactTokensForHype(bal / 2 + 1, 0, trader);
                vm.stopPrank();
            }
            assertGe(_lockedValue(p, locker.positions(id).shares), v0, "lock shrank");
        }
        locker.claim(id);
        assertGe(_lockedValue(p, locker.positions(id).shares), v0);
    }

    // ───────────────────────────── beneficiary ─────────────────────────────

    function test_onlyBeneficiaryMovesFees() public {
        _settleForever();
        uint256 id = auction.feePosition();
        vm.expectRevert(CloakFeeLocker.NotBeneficiary.selector);
        vm.prank(attacker);
        locker.setBeneficiary(id, attacker);
        address treasury = makeAddr("treasury");
        vm.prank(creator);
        locker.setBeneficiary(id, treasury);
        assertEq(locker.positions(id).beneficiary, treasury);
    }

    function test_fallbackCloakPair_staysLockedForever() public {
        // the rare fallback (someone else's LP already in the Uniswap pool): a CloakPair, its LP stays in the auction
        _launch(type(uint64).max);
        _bidAndClose();
        (,,,,, address vest) = factory.launches(0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(creator);
        (bool ok,) = vest.call(abi.encodeWithSignature("release()"));
        assertTrue(ok);
        address pool = UNI.createPair(address(token), address(WHYPE));
        uint256 vested = token.balanceOf(creator);
        vm.startPrank(creator);
        token.transfer(pool, vested);
        vm.deal(creator, 1 ether);
        WHYPE.deposit{value: 1 ether}();
        WHYPE.transfer(pool, 1 ether);
        IUniswapV2Pair(pool).mint(creator);
        vm.stopPrank();
        auction.settle();
        assertEq(auction.uniPair(), address(0));
        assertFalse(auction.creatorFees());
        assertEq(auction.pair().sharesOf(address(auction)), auction.lpShares());
        vm.warp(vm.getBlockTimestamp() + 3650 days);
        vm.expectRevert("locked");
        auction.releaseLP();
    }
}
