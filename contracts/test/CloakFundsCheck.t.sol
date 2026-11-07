// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivateBatcherTest} from "./PrivateBatcher.t.sol";
import {ShieldedPool} from "../src/shielded/ShieldedPool.sol";
import {CloakFundsCheck, IVerifierFunds} from "../src/shielded/CloakFundsCheck.sol";
import {Groth16VerifierFunds} from "../src/shielded/VerifierFunds.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Proof of funds on chain, with a REAL Groth16 proof from circuits/src/fundsProof3 (made by e2e tooling against a
/// one-note tree): 500 USDC held privately, proved as "at least 100", context 777.
contract CloakFundsCheckTest is PrivateBatcherTest {
    CloakFundsCheck check;
    MockUSDC usdc;
    ShieldedPool usdcPool;
    uint256 constant PUBKEY = 9904028930859697121695025471312564917337032846528014134060777877259199866166;
    uint256 constant ROOT = 14074973177090540650404020877147707839626624997485752851033628373576397180388;
    uint256 constant NUL = 13830336913890461456398029594625931633791167545917418174290943879239104598957;

    function setUp() public override {
        super.setUp();
        check = new CloakFundsCheck(IVerifierFunds(address(new Groth16VerifierFunds())), router.vaults());
        usdc = new MockUSDC();
        config.approveAsset(address(usdc));
        usdcPool = router.vaults().createAssetPool(address(usdc));
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(usdcPool), type(uint256).max);
        usdcPool.depositTo(PUBKEY, 500e6, 456, ""); // the proved note, leaf 0
        assertEq(usdcPool.currentRoot(), ROOT, "the SDK's tree and the vault's agree");
    }

    function _proof() internal pure returns (CloakFundsCheck.Proof memory p) {
        p.a = [uint256(16628895715468242127388899662407490837281289914844109487418471338122795072516), 9690214963184147606298788957102809335406621153818448512993455710133085886176];
        p.b = [[uint256(9999328927939048163944310175199226522174210747236921150561514734597796554065), 6094779463409469772770266297854163661654565941233011195861658040362687761852], [uint256(10059653463566402522738261746617828696820858317349445739484234032547035045002), 10508207574579687518562257587867513609782433268359248312054001207927690946669]];
        p.c = [uint256(7541992124345899452286953963499993635374826267868619830933213866430312455705), 4487800120627829395230164680717282821761383661986509487907504284194434968649];
        p.root = ROOT;
        p.nullifiers = [NUL, 0, 0];
    }

    function test_aRealProofOfFundsVerifiesOnChain() public view {
        assertTrue(check.holds(usdcPool, 100e6, 777, _proof()));
    }

    function test_aBiggerClaimOrAnotherContextFails() public view {
        assertFalse(check.holds(usdcPool, 100e6 + 1, 777, _proof()), "more than proved");
        assertFalse(check.holds(usdcPool, 100e6, 778, _proof()), "another context (another gate, wallet or expiry)");
    }

    function test_anotherVaultOrAForgedRootFails() public {
        assertFalse(check.holds(hypePool, 100e6, 777, _proof()), "the root isn't the HYPE vault's");
        CloakFundsCheck.Proof memory p = _proof();
        p.root = ROOT + 1;
        assertFalse(check.holds(usdcPool, 100e6, 777, p), "a root the vault never had");
        assertFalse(check.holds(ShieldedPool(address(usdc)), 100e6, 777, _proof()), "not a Cloak vault");
    }

    function test_spendingTheNoteEndsTheProof() public {
        assertTrue(check.holds(usdcPool, 100e6, 777, _proof()));
        // spend it (mock verifier: any proof passes the pool, but the nullifier is the real one)
        ShieldedPool.ExtData memory ext = ShieldedPool.ExtData(makeAddr("to"), -int256(500e6), address(0), 0, "", "", "");
        ShieldedPool.Proof memory sp;
        sp.root = usdcPool.currentRoot();
        sp.publicAmount = usdcPool.calculatePublicAmount(ext.extAmount, 0);
        sp.extDataHash = this.hashExt(usdcPool, ext);
        sp.inputNullifiers = [NUL, uint256(5)];
        sp.outputCommitments = [uint256(1), uint256(2)];
        usdcPool.transact(sp, ext);
        assertFalse(check.holds(usdcPool, 100e6, 777, _proof()), "a spent note no longer counts");
    }

    function test_aTamperedProofFails() public view {
        CloakFundsCheck.Proof memory p = _proof();
        p.nullifiers = [NUL, 1, 0]; // claim a second note
        assertFalse(check.holds(usdcPool, 100e6, 777, p));
    }
}
