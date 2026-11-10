// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CloakLaunchpadCheck
 * @notice Answers CloakEcosystemVault's question "did this launchpad's factory make this token?" by asking the
 *         launchpad's own registry. Most launchpads keep one: a view `f(address token)` that returns true, a non-zero
 *         record, or the token's creator for their tokens, and zero for anything else (`isToken`, `tokenInfo`,
 *         `creatorOf` and so on). One checker per launchpad, deployed with that launchpad's factory and selector after
 *         Cloak vets its code. No owner, nothing to change.
 * @dev The token counts when the call succeeds and its first returned word is non-zero. A launchpad whose registry
 *      can't be read that way gets its own small adapter implementing `isLaunchpadToken`.
 */
contract CloakLaunchpadCheck {
    address public immutable factory;
    bytes4 public immutable selector;

    error ZeroAddress();

    constructor(address factory_, bytes4 selector_) {
        if (factory_ == address(0) || factory_.code.length == 0) revert ZeroAddress();
        factory = factory_;
        selector = selector_;
    }

    function isLaunchpadToken(address token) external view returns (bool) {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSelector(selector, token));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (uint256)) != 0;
    }
}
