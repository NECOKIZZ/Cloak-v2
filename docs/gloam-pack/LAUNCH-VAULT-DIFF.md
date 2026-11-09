# CloakLaunchVault against Gloam's ShieldPoolPayments

For Gloam's review of our one addition. `CloakLaunchVault` (`contracts-gloam/src/CloakLaunchVault.sol`) inherits Gloam's `ShieldPoolCore` unchanged (imported from the pinned submodule `vendor/gloam` at `16dac34`, never edited) and repeats `ShieldPoolPayments`' three rules word for word. Testnet: `0x13050b9a0abece56f80d30da107c3f3fad33288f`, owned by its own `VaultOwnerGuard` at `0x8362860ea98c1b95dda1d28077909779b457dcc2`.

## What is the same as ShieldPoolPayments

- Inherits `ShieldPoolCore` with no override other than the three below.
- `shield()` always reverts: deposits take `shieldBound` only.
- `_checkReadyToEndSetup()`: setup ends only with both verifiers set and deposit limits on.
- `sealedSwapVerifier()` returns zero: no sealed swap.
- Deployed the way your guarded deploy does it: final-key verifiers, setup, end of setup, ownership to a `VaultOwnerGuard`, the controller accepting. `e2e-gloam/stack.mjs` `checkLaunchVault` reads back 12 settings and throws on a mismatch.
- Once you deploy your verifiers on Elysium, we redeploy it with yours instead of our copies.

## What is added

1. **`admitLaunch(launchIndex)`.** Anyone may call it. For a launch of the one factory fixed at deploy whose auction has settled, it sets that token's deposit limits to fixed caps (immutable, set at deploy) through `ShieldPoolCore._setDepositLimit`, with no 3-day wait. Once per token: a second call does nothing, and a token the owner already gave limits (in setup or through the timelock) is refused, so a limit lowered in an incident can't be raised back by anyone.
2. **A launch pauser** (immutable, Cloak's multisig or nobody). Under your guard the owner can close a token only once it's admitted, since `lowerDepositLimit` can't tell "never set" from "lowered to zero". The pauser can stop all new admissions (`pauseAdmissions`) or one token's (`blockLaunch`). It can't touch funds, limits, the fee, or a token already admitted.
3. Views: `factory`, `launchPerDeposit`, `launchTotal`, `isLaunchToken`, `launchTokens`, `launchTokensCount`, `admissionsPaused`, `launchBlocked`.

What it doesn't change: the verifiers, the fee, every other asset and every limit increase still go through setup and then your guard's 3-day timelock. The owner still has no function that moves user funds.

**Why it's safe to skip the wait for these tokens:** the factory writes the token (`contracts/src/CloakToken.sol`, see FACTORY-AND-POOLS.md): fixed supply minted once in the constructor, no owner, no mint, no tax, no blacklist, no hooks on transfer.

**Tests:** `contracts-gloam/test/CloakLaunchVault.t.sol` and the guard handover tests (the guard refuses a vault still in setup, admission needs nobody, the guard lowers an admitted token and re-admitting can't raise it, another asset lists through the 3-day wait, a verifier change is refused). It isn't covered by Kann's audit of your vault, so it gets an outside review of its own before mainnet.

## The diff

```diff
--- gloam/contracts/src/ShieldPoolPayments.sol (16dac34)
+++ contracts-gloam/src/CloakLaunchVault.sol
@@ -1,41 +1,137 @@
 // SPDX-License-Identifier: MIT
 pragma solidity ^0.8.24;
 
-import {ShieldPoolCore} from "./ShieldPoolCore.sol";
+import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";
+
+interface ILaunchFactoryV {
+    function launches(uint256 i)
+        external
+        view
+        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting);
+}
+
+interface ILaunchAuctionV {
+    function settled() external view returns (bool);
+}
 
 /**
- * @title ShieldPoolPayments
- * @notice The mainnet pool: private deposits, transfers and withdrawals, with
- *         beta deposit limits, and no sealed swap. See ShieldPoolCore for the
- *         owner's powers.
- * @dev Sealed swaps stay off until their accounting is redesigned (audit H1,
- *      ZK-1), so this pool leaves that code out entirely. That also keeps the
- *      deploy under Tempo's 30M per-transaction gas cap.
+ * @title CloakLaunchVault
+ * @notice Cloak's own private vault for launch tokens, built from Gloam's vault code and run with Gloam's circuits and
+ *         final keys, so the same app code and the same proofs work in both vaults.
+ *
+ *         It is Gloam's ShieldPoolPayments with one addition. A token Cloak's factory made gets its deposit limits the
+ *         moment its launch settles, with no 3-day wait, because the factory wrote the token and its rules are known
+ *         (fixed supply, no owner, no mint, no tax, no blacklist). Everything else is Gloam's design unchanged:
+ *          - deposits take shieldBound only (a proof binds the note to the amount sent),
+ *          - every other asset, the verifiers and the fee go through setup, then the 3-day timelock,
+ *          - the owner can lower any limit or the fee at once, and has no function that moves user funds.
+ *
+ *         Admission is permissionless and one-shot. Anyone may call admitLaunch for a settled launch, and it sets the
+ *         fixed launch caps once. A second call does nothing, so a limit the owner lowered during an incident can't be
+ *         raised back by anyone.
+ *
+ * @dev Notes here and in Gloam's vault use the same format but live in different trees, so a note can't be spent
+ *      across vaults. Moving between them is a cash-out from one and a deposit into the other (see the graduation
+ *      escrow).
  */
-contract ShieldPoolPayments is ShieldPoolCore {
+contract CloakLaunchVault is ShieldPoolCore {
+    /// @notice The only factory whose launches are admitted without the timelock.
+    ILaunchFactoryV public immutable factory;
+    /// @notice The limits every admitted launch token gets (the owner can lower them per token at once).
+    uint128 public immutable launchPerDeposit;
+    uint128 public immutable launchTotal;
+
+    /// @notice Launch tokens admitted through admitLaunch (never cleared).
+    mapping(address => bool) public isLaunchToken;
+    address[] public launchTokens;
+
+    /**
+     * @notice The incident stop for launches not admitted yet (Cloak's multisig, or address(0) for none). Under Gloam's
+     *         VaultOwnerGuard the owner can close a token only once it is admitted (the guard forwards
+     *         lowerDepositLimit, which can't tell "never set" from "lowered to zero"). The pauser can only stop
+     *         admissions, one token or all of them; it can't touch funds, limits or the fee.
+     */
+    address public immutable launchPauser;
+    /// @notice No launch is admitted while this is on.
+    bool public admissionsPaused;
+    /// @notice A token the pauser stopped from being admitted.
+    mapping(address => bool) public launchBlocked;
+
+    event LaunchAdmitted(uint256 indexed launchIndex, address indexed token);
+    event AdmissionsPaused(bool paused);
+    event LaunchBlocked(address indexed token, bool blocked);
+
+    error NotSettled();
+    error AlreadyLimited();
+    error BadLaunchCaps();
+    error NotPauser();
+    error AdmissionStopped();
+
     /**
      * @param poseidon2_ Circomlib Poseidon (2 inputs)
-     * @param verifier_ UnshieldIVerifier or address(0) until set
+     * @param verifier_ Gloam's final unshield verifier, or address(0) until set in setup
+     * @param factory_ Cloak's launch factory
+     * @param perDeposit_ the largest single deposit of a launch token
+     * @param total_ the most of one launch token the vault holds
+     * @param launchPauser_ who may stop admissions (address(0) for nobody)
      */
-    constructor(address poseidon2_, address verifier_) ShieldPoolCore(poseidon2_, verifier_) {}
+    constructor(address poseidon2_, address verifier_, address factory_, uint128 perDeposit_, uint128 total_, address launchPauser_)
+        ShieldPoolCore(poseidon2_, verifier_)
+    {
+        launchPauser = launchPauser_;
+        if (factory_ == address(0)) revert ZeroAddress();
+        if (perDeposit_ == 0 || perDeposit_ > total_) revert BadLaunchCaps();
+        factory = ILaunchFactoryV(factory_);
+        launchPerDeposit = perDeposit_;
+        launchTotal = total_;
+    }
+
+    /// @notice Open deposits for a settled launch's token. Anyone may call it. Does nothing for a token already admitted.
+    function admitLaunch(uint256 launchIndex) external returns (address token) {
+        address auction;
+        (auction, token,,,,) = factory.launches(launchIndex);
+        if (!ILaunchAuctionV(auction).settled()) revert NotSettled();
+        if (isLaunchToken[token]) return token;
+        if (admissionsPaused || launchBlocked[token]) revert AdmissionStopped();
+        // a token the owner already gave limits (in setup or through the timelock) keeps them
+        DepositLimit memory cur = depositLimit[token];
+        if (cur.perDeposit != 0 || cur.total != 0) revert AlreadyLimited();
+        isLaunchToken[token] = true;
+        launchTokens.push(token);
+        _setDepositLimit(token, launchPerDeposit, launchTotal);
+        emit LaunchAdmitted(launchIndex, token);
+    }
+
+    /// @notice Stop (or restart) every new admission. Admitted tokens are untouched.
+    function pauseAdmissions(bool paused) external {
+        if (msg.sender != launchPauser) revert NotPauser();
+        admissionsPaused = paused;
+        emit AdmissionsPaused(paused);
+    }
+
+    /// @notice Stop (or allow again) one token's admission. A token already admitted is untouched (the owner lowers it).
+    function blockLaunch(address token, bool blocked) external {
+        if (msg.sender != launchPauser) revert NotPauser();
+        launchBlocked[token] = blocked;
+        emit LaunchBlocked(token, blocked);
+    }
+
+    function launchTokensCount() external view returns (uint256) {
+        return launchTokens.length;
+    }
 
-    /// @notice Deposits take shieldBound() only: its proof binds the commitment to
-    ///         the amount sent, so this pool never takes an unbound deposit, not
-    ///         even in the deploy window before the shield verifier is wired
-    ///         (pre-mainnet audit F1).
+    /// @notice Deposits take shieldBound() only, as in Gloam's ShieldPoolPayments.
     function shield(address, uint256, bytes32) external payable override {
         revert ShieldProofRequired();
     }
 
-    /// @dev Setup can only end on a pool that is ready to go live: both proof
-    ///      verifiers wired and deposit limits on (pre-mainnet audit F1, GATE 1).
+    /// @dev Setup ends only on a vault ready to go live: both verifiers wired and deposit limits on.
     function _checkReadyToEndSetup() internal view override {
         if (address(verifier) == address(0) || address(shieldVerifier) == address(0)) revert VerifierNotSet();
         if (!depositLimitsOn) revert DepositLimitsOff();
     }
 
-    /// @notice Always zero: this pool has no sealed swap. The app reads it the
-    ///         same way it reads ShieldPoolPoseidon's to keep trading off.
+    /// @notice Always zero: no sealed swap here, read the same way the app reads Gloam's.
     function sealedSwapVerifier() external pure returns (address) {
         return address(0);
     }
```
