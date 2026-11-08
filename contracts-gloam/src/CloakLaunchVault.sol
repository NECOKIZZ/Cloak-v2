// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldPoolCore} from "gloam/ShieldPoolCore.sol";

interface ILaunchFactoryV {
    function launches(uint256 i)
        external
        view
        returns (address auction, address token, address creator, address launchpad, uint256 creatorAlloc, address vesting);
}

interface ILaunchAuctionV {
    function settled() external view returns (bool);
}

/**
 * @title CloakLaunchVault
 * @notice Cloak's own private vault for launch tokens, built from Gloam's vault code and run with Gloam's circuits and
 *         final keys, so the same app code and the same proofs work in both vaults.
 *
 *         It is Gloam's ShieldPoolPayments with one addition. A token Cloak's factory made gets its deposit limits the
 *         moment its launch settles, with no 3-day wait, because the factory wrote the token and its rules are known
 *         (fixed supply, no owner, no mint, no tax, no blacklist). Everything else is Gloam's design unchanged:
 *          - deposits take shieldBound only (a proof binds the note to the amount sent),
 *          - every other asset, the verifiers and the fee go through setup, then the 3-day timelock,
 *          - the owner can lower any limit or the fee at once, and has no function that moves user funds.
 *
 *         Admission is permissionless and one-shot. Anyone may call admitLaunch for a settled launch, and it sets the
 *         fixed launch caps once. A second call does nothing, so a limit the owner lowered during an incident can't be
 *         raised back by anyone.
 *
 * @dev Notes here and in Gloam's vault use the same format but live in different trees, so a note can't be spent
 *      across vaults. Moving between them is a cash-out from one and a deposit into the other (see the graduation
 *      escrow).
 */
contract CloakLaunchVault is ShieldPoolCore {
    /// @notice The only factory whose launches are admitted without the timelock.
    ILaunchFactoryV public immutable factory;
    /// @notice The limits every admitted launch token gets (the owner can lower them per token at once).
    uint128 public immutable launchPerDeposit;
    uint128 public immutable launchTotal;

    /// @notice Launch tokens admitted through admitLaunch (never cleared).
    mapping(address => bool) public isLaunchToken;
    address[] public launchTokens;

    event LaunchAdmitted(uint256 indexed launchIndex, address indexed token);

    error NotSettled();
    error AlreadyLimited();
    error BadLaunchCaps();

    /**
     * @param poseidon2_ Circomlib Poseidon (2 inputs)
     * @param verifier_ Gloam's final unshield verifier, or address(0) until set in setup
     * @param factory_ Cloak's launch factory
     * @param perDeposit_ the largest single deposit of a launch token
     * @param total_ the most of one launch token the vault holds
     */
    constructor(address poseidon2_, address verifier_, address factory_, uint128 perDeposit_, uint128 total_)
        ShieldPoolCore(poseidon2_, verifier_)
    {
        if (factory_ == address(0)) revert ZeroAddress();
        if (perDeposit_ == 0 || perDeposit_ > total_) revert BadLaunchCaps();
        factory = ILaunchFactoryV(factory_);
        launchPerDeposit = perDeposit_;
        launchTotal = total_;
    }

    /// @notice Open deposits for a settled launch's token. Anyone may call it. Does nothing for a token already admitted.
    function admitLaunch(uint256 launchIndex) external returns (address token) {
        address auction;
        (auction, token,,,,) = factory.launches(launchIndex);
        if (!ILaunchAuctionV(auction).settled()) revert NotSettled();
        if (isLaunchToken[token]) return token;
        // a token the owner already gave limits (in setup or through the timelock) keeps them
        DepositLimit memory cur = depositLimit[token];
        if (cur.perDeposit != 0 || cur.total != 0) revert AlreadyLimited();
        isLaunchToken[token] = true;
        launchTokens.push(token);
        _setDepositLimit(token, launchPerDeposit, launchTotal);
        emit LaunchAdmitted(launchIndex, token);
    }

    function launchTokensCount() external view returns (uint256) {
        return launchTokens.length;
    }

    /// @notice Deposits take shieldBound() only, as in Gloam's ShieldPoolPayments.
    function shield(address, uint256, bytes32) external payable override {
        revert ShieldProofRequired();
    }

    /// @dev Setup ends only on a vault ready to go live: both verifiers wired and deposit limits on.
    function _checkReadyToEndSetup() internal view override {
        if (address(verifier) == address(0) || address(shieldVerifier) == address(0)) revert VerifierNotSet();
        if (!depositLimitsOn) revert DepositLimitsOff();
    }

    /// @notice Always zero: no sealed swap here, read the same way the app reads Gloam's.
    function sealedSwapVerifier() external pure returns (address) {
        return address(0);
    }
}
