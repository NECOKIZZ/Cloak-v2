// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {IVerifier} from "gloam/interfaces/IVerifier.sol";
import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
import {ChangeTimelock} from "gloam/lib/ChangeTimelock.sol";
import {CloakLaunchVault} from "../src/CloakLaunchVault.sol";
import {TestToken} from "../src/TestToken.sol";

contract YesVerifier is IVerifier {
    function verify(bytes calldata, uint256[] calldata) external pure returns (bool) {
        return true;
    }
}

/// The unshield "proof" names the `to` it was made for, as a real proof binds it.
contract ToVerifier is IVerifier {
    function verify(bytes calldata proof, uint256[] calldata inputs) external pure returns (bool) {
        if (inputs.length != 5) return true;
        return abi.decode(proof, (address)) == address(uint160(inputs[4]));
    }
}

contract FakeAuction {
    bool public settled;

    function settle() external {
        settled = true;
    }
}

/// Stands in for CloakFactory: the same launches() shape.
contract FakeFactory {
    struct Launch {
        address auction;
        address token;
        address creator;
        address launchpad;
        uint256 creatorAlloc;
        address vesting;
    }

    Launch[] public launches;

    function add(address auction, address token) external returns (uint256) {
        launches.push(Launch(auction, token, address(0xC0), address(0xC1), 0, address(0)));
        return launches.length - 1;
    }

    function launchesCount() external view returns (uint256) {
        return launches.length;
    }
}

contract CloakLaunchVaultTest is Test {
    using stdJson for string;

    CloakLaunchVault vault;
    FakeFactory factory;
    FakeAuction auction;
    TestToken launch;
    TestToken usd;
    uint256 idx;
    address cloakFees = address(0xFEE);
    address alice = address(0xA11CE);
    address mallory = address(0xBAD);
    uint128 constant PER = 1_000_000e18;
    uint128 constant TOTAL = 50_000_000e18;

    function setUp() public {
        vm.warp(1_900_000_000);
        factory = new FakeFactory();
        vault = new CloakLaunchVault(_poseidon(), address(new ToVerifier()), address(factory), PER, TOTAL);
        vault.setShieldVerifier(address(new YesVerifier()));
        vault.setWithdrawFee(50, cloakFees);
        vault.turnOnDepositLimits();
        vault.endSetup();

        auction = new FakeAuction();
        launch = new TestToken("Launch", "LNCH", 18);
        usd = new TestToken("USDC", "USDC", 6);
        idx = factory.add(address(auction), address(launch));
        launch.mint(alice, 10_000_000e18);
        usd.mint(alice, 1_000e6);
        vm.startPrank(alice);
        launch.approve(address(vault), type(uint256).max);
        usd.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _poseidon() internal returns (address addr) {
        bytes memory code = vm.readFile("../vendor/gloam/contracts/test/fixtures/Poseidon2.json").readBytes(".bytecode");
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon");
    }

    function test_constructorChecks() public {
        address p = _poseidon();
        vm.expectRevert(ShieldPoolCore.ZeroAddress.selector);
        new CloakLaunchVault(p, address(0), address(0), PER, TOTAL);
        vm.expectRevert(CloakLaunchVault.BadLaunchCaps.selector);
        new CloakLaunchVault(p, address(0), address(factory), 0, TOTAL);
        vm.expectRevert(CloakLaunchVault.BadLaunchCaps.selector);
        new CloakLaunchVault(p, address(0), address(factory), TOTAL + 1, TOTAL);
    }

    function test_setupNeedsVerifiersAndLimits() public {
        CloakLaunchVault v = new CloakLaunchVault(_poseidon(), address(0), address(factory), PER, TOTAL);
        vm.expectRevert(ShieldPoolCore.VerifierNotSet.selector);
        v.endSetup();
        v.setVerifier(address(new YesVerifier()));
        v.setShieldVerifier(address(new YesVerifier()));
        vm.expectRevert(ShieldPoolCore.DepositLimitsOff.selector);
        v.endSetup();
        v.turnOnDepositLimits();
        v.endSetup();
    }

    function test_plainShieldReverts() public {
        vm.expectRevert(ShieldPoolCore.ShieldProofRequired.selector);
        vault.shield(address(launch), 1, bytes32(uint256(1)));
        assertEq(vault.sealedSwapVerifier(), address(0));
    }

    function test_unsettledLaunchRefused() public {
        vm.expectRevert(CloakLaunchVault.NotSettled.selector);
        vault.admitLaunch(idx);
        vm.prank(alice);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        vault.shieldBound(address(launch), 1e18, bytes32(uint256(1)), hex"00");
    }

    function test_settledLaunchAdmittedAtOnceByAnyone() public {
        auction.settle();
        vm.prank(mallory);
        assertEq(vault.admitLaunch(idx), address(launch));
        assertTrue(vault.isLaunchToken(address(launch)));
        assertEq(vault.launchTokensCount(), 1);
        (uint128 per, uint128 total) = vault.depositLimit(address(launch));
        assertEq(per, PER);
        assertEq(total, TOTAL);
        vm.prank(alice);
        vault.shieldBound(address(launch), 500e18, bytes32(uint256(1)), hex"00");
        assertEq(vault.deposited(address(launch)), 500e18);
    }

    function test_unknownIndexReverts() public {
        vm.expectRevert();
        vault.admitLaunch(7);
    }

    function test_capsHold() public {
        auction.settle();
        vault.admitLaunch(idx);
        vm.startPrank(alice);
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        vault.shieldBound(address(launch), PER + 1, bytes32(uint256(1)), hex"00");
        vm.stopPrank();
    }

    function test_totalCapHolds() public {
        CloakLaunchVault v = new CloakLaunchVault(_poseidon(), address(new YesVerifier()), address(factory), 100e18, 150e18);
        v.setShieldVerifier(address(new YesVerifier()));
        v.turnOnDepositLimits();
        v.endSetup();
        auction.settle();
        v.admitLaunch(idx);
        vm.startPrank(alice);
        launch.approve(address(v), type(uint256).max);
        v.shieldBound(address(launch), 100e18, bytes32(uint256(1)), hex"00");
        vm.expectRevert(ShieldPoolCore.OverDepositLimit.selector);
        v.shieldBound(address(launch), 51e18, bytes32(uint256(2)), hex"00");
        v.shieldBound(address(launch), 50e18, bytes32(uint256(3)), hex"00");
        vm.stopPrank();
    }

    /// An owner who lowered a launch token's limit in an incident can't be overridden by re-admitting it.
    function test_readmitDoesNotRaiseALoweredLimit() public {
        auction.settle();
        vault.admitLaunch(idx);
        vault.lowerDepositLimit(address(launch), 0, 0);
        vm.prank(mallory);
        vault.admitLaunch(idx);
        (uint128 per, uint128 total) = vault.depositLimit(address(launch));
        assertEq(per, 0);
        assertEq(total, 0);
        assertEq(vault.launchTokensCount(), 1);
    }

    /// The fast path only covers launch tokens. Any other asset waits out the timelock.
    function test_otherTokensNeedTheTimelock() public {
        vm.expectRevert(ChangeTimelock.TimelockRequired.selector);
        vault.setDepositLimit(address(usd), 500e6, 25_000e6);

        bytes memory call = abi.encodeCall(ShieldPoolCore.setDepositLimit, (address(usd), uint128(500e6), uint128(25_000e6)));
        vm.prank(mallory);
        vm.expectRevert(ShieldPoolCore.NotOwner.selector);
        vault.queueChange(call);
        vault.queueChange(call);
        vm.expectRevert(ChangeTimelock.ChangeNotReady.selector);
        vault.executeChange(call);
        vm.warp(block.timestamp + 3 days);
        vault.executeChange(call);
        vm.prank(alice);
        vault.shieldBound(address(usd), 100e6, bytes32(uint256(9)), hex"00");
    }

    /// A launch whose token the owner already listed keeps the owner's limits.
    function test_alreadyLimitedTokenKeepsItsLimits() public {
        CloakLaunchVault v = new CloakLaunchVault(_poseidon(), address(new YesVerifier()), address(factory), PER, TOTAL);
        v.setDepositLimit(address(launch), 10e18, 20e18);
        auction.settle();
        vm.expectRevert(CloakLaunchVault.AlreadyLimited.selector);
        v.admitLaunch(idx);
    }

    function test_onlyTheNamedFactoryCounts() public {
        FakeFactory other = new FakeFactory();
        FakeAuction a2 = new FakeAuction();
        a2.settle();
        TestToken t2 = new TestToken("Other", "OTH", 18);
        other.add(address(a2), address(t2));
        // index 0 of the vault's factory is still the unsettled `launch`
        vm.expectRevert(CloakLaunchVault.NotSettled.selector);
        vault.admitLaunch(0);
        assertFalse(vault.isLaunchToken(address(t2)));
    }

    /// Deposit, private send, cash out: Cloak's fee is held and collected to Cloak.
    function test_depositSendCashOutPaysCloak() public {
        auction.settle();
        vault.admitLaunch(idx);
        vm.prank(alice);
        vault.shieldBound(address(launch), 1_000e18, bytes32(uint256(0xC0FFEE)), hex"00");

        bytes32 root = vault.currentRoot();
        bytes32[2] memory outs = [bytes32(uint256(0xB0B)), bytes32(uint256(0xCA7))];
        vault.transfer(abi.encode(address(0)), root, bytes32(uint256(0x111)), outs);
        assertEq(vault.nextIndex(), 3);
        vm.expectRevert(ShieldPoolCore.AlreadySpent.selector);
        vault.transfer(abi.encode(address(0)), root, bytes32(uint256(0x111)), outs);

        address bob = address(0xB0B0);
        root = vault.currentRoot();
        // a proof made for bob can't be redirected
        vm.expectRevert(ShieldPoolCore.InvalidProof.selector);
        vault.unshield(abi.encode(bob), root, bytes32(uint256(0x222)), address(launch), mallory, 1_000e18);
        vault.unshield(abi.encode(bob), root, bytes32(uint256(0x222)), address(launch), bob, 1_000e18);
        assertEq(launch.balanceOf(bob), 995e18);
        assertEq(vault.feesOwed(address(launch)), 5e18);
        vault.collectFees(address(launch));
        assertEq(launch.balanceOf(cloakFees), 5e18);
        assertEq(launch.balanceOf(address(vault)), 0);
    }

    function test_feeCappedAtOnePercent() public {
        CloakLaunchVault v = new CloakLaunchVault(_poseidon(), address(0), address(factory), PER, TOTAL);
        vm.expectRevert(ShieldPoolCore.FeeTooHigh.selector);
        v.setWithdrawFee(101, cloakFees);
    }
}
