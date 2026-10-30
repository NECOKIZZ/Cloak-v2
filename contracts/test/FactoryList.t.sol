// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CloakFactory} from "../src/CloakFactory.sol";
import {CloakAuction} from "../src/CloakAuction.sol";
import {CloakConfig} from "../src/CloakConfig.sol";
import {CloakVestingDeployer} from "../src/CloakVesting.sol";
import {PrivateRouter, ICloakFactory} from "../src/shielded/PrivateRouter.sol";
import {CloakFactoryList, ICloakFactoryRead} from "../src/shielded/CloakFactoryList.sol";
import {WHYPE} from "../src/shielded/WHYPE.sol";
import {IPoseidon2, IPoseidon3} from "../src/shielded/interfaces/IHasher.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

/// A first-deployment factory: its `launches` returns five fields (no vesting contract).
contract FiveFieldFactory {
    struct L {
        address auction;
        address token;
    }

    L[] internal ls;

    function add(address a, address t) external {
        ls.push(L(a, t));
    }

    function launchesCount() external view returns (uint256) {
        return ls.length;
    }

    function launches(uint256 i) external view returns (address, address, address, address, uint256) {
        return (ls[i].auction, ls[i].token, address(1), address(2), 0);
    }
}

/// v3 wiring: one new router opens private vaults for launches from every earlier factory, through CloakFactoryList.
contract FactoryListTest is Test {
    CloakConfig config;
    IPoseidon2 p2;
    IPoseidon3 p3;
    address alice = makeAddr("alice");

    function _deployCode(string memory path) internal returns (address a) {
        bytes memory code = vm.parseBytes(vm.readFile(path));
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "deploy");
    }

    function _settled(CloakFactory f, string memory sym) internal returns (address auction, address token) {
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
        (auction, token) = f.createLaunch(sym, sym, 0, 0, p, "");
        CloakAuction a = CloakAuction(payable(auction));
        vm.deal(alice, 10_000 ether);
        bytes32 salt = bytes32(uint256(7));
        bytes32 h = a.commitmentOf(alice, 4, 1_000_000e18, salt);
        vm.prank(alice);
        uint256 id = a.commit{value: 5_000 ether}(h, "");
        vm.warp(block.timestamp + 1 hours);
        a.reveal(id, 4, 1_000_000e18, salt);
        vm.warp(block.timestamp + 1 hours);
        a.settle();
    }

    function setUp() public {
        config = new CloakConfig(address(new MockVerifier()), address(0));
        p2 = IPoseidon2(_deployCode("test/fixtures/poseidon2.hex"));
        p3 = IPoseidon3(_deployCode("test/fixtures/poseidon3.hex"));
    }

    function test_newRouter_opensVaultsForEveryEarlierFactory() public {
        // v1: a five-field factory; v2: today's factory with two launches; v3: the new factory
        CloakFactory v2 = new CloakFactory(config, new CloakVestingDeployer());
        CloakFactory scratch = new CloakFactory(config, new CloakVestingDeployer());
        (address a1, address t1) = _settled(scratch, "OLD");
        FiveFieldFactory v1 = new FiveFieldFactory();
        v1.add(a1, t1);
        (, address t2) = _settled(v2, "SHADE");
        (, address t3) = _settled(v2, "AYS");
        CloakFactory v3 = new CloakFactory(config, new CloakVestingDeployer());

        ICloakFactoryRead[] memory list = new ICloakFactoryRead[](2);
        list[0] = ICloakFactoryRead(address(v1));
        list[1] = ICloakFactoryRead(address(v2));
        CloakFactoryList old = new CloakFactoryList(list);
        assertEq(old.launchesCount(), 3);
        (, address tok,,,) = old.launches(2);
        assertEq(tok, t3);
        vm.expectRevert(bytes("index"));
        old.launches(3);

        PrivateRouter r = new PrivateRouter(
            config, p2, p3, ICloakFactory(address(v3)), ICloakFactory(address(old)), WHYPE(payable(address(0)))
        );
        r.createLegacyPool(0);
        r.createLegacyPool(1);
        r.createLegacyPool(2);
        assertTrue(address(r.poolOf(t1)) != address(0), "v1 launch has a v3 vault");
        assertTrue(
            address(r.poolOf(t2)) != address(0) && address(r.poolOf(t3)) != address(0), "v2 launches have v3 vaults"
        );
        assertEq(
            address(r.pairOf(t2)),
            address(CloakAuction(payable(_auctionOf(v2, 0))).pair()),
            "trades through the launch's own pair"
        );
        vm.expectRevert(PrivateRouter.PoolExists.selector);
        r.createLegacyPool(1);
    }

    function test_list_isFixed_andRejectsEmptyOrZero() public {
        vm.expectRevert(bytes("none"));
        new CloakFactoryList(new ICloakFactoryRead[](0));
        ICloakFactoryRead[] memory z = new ICloakFactoryRead[](1);
        vm.expectRevert(bytes("zero"));
        new CloakFactoryList(z);
    }

    function _auctionOf(CloakFactory f, uint256 i) internal view returns (address a) {
        (a,,,,,) = f.launches(i);
    }
}
