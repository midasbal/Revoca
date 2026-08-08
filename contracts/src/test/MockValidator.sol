// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAPassComplianceValidator} from "../interfaces/IAPassComplianceValidator.sol";

/**
 * @title MockValidator
 * @notice TEST ONLY. A deterministic, owner-toggleable double for
 * IAPassComplianceValidator, used to unit-test HybridComplianceGate's
 * ValidatorGated mode (return true / return false / revert) offline and
 * without a live Monad RPC. NEVER deploy this to any network a real pool
 * uses, see CLAUDE.md's "no mock data for compliance" rule, this exists
 * purely to test HybridComplianceGate's own dispatch and fail-closed logic
 * in isolation from the real validator.
 *
 * Only implements `complianceVerify`, the sole function HybridComplianceGate
 * calls; every other IAPassComplianceValidator function reverts, since
 * nothing under test should ever call them.
 */
contract MockValidator is IAPassComplianceValidator {
    mapping(address poolAddress => mapping(address userAddress => bool result)) private _result;
    mapping(address poolAddress => bool shouldRevert) private _reverts;

    error MockValidatorReverts();
    error NotImplemented();

    /// @notice TEST ONLY. Sets the boolean `complianceVerify(poolAddress, userAddress)` should return.
    function setResult(address poolAddress, address userAddress, bool result) external {
        _result[poolAddress][userAddress] = result;
    }

    /// @notice TEST ONLY. Sets whether `complianceVerify` should revert for `poolAddress`, regardless of userAddress, simulating PoolNotRegistered() or any other on-chain failure.
    function setReverts(address poolAddress, bool shouldRevert) external {
        _reverts[poolAddress] = shouldRevert;
    }

    function complianceVerify(address poolAddress, address userAddress) external view returns (bool) {
        if (_reverts[poolAddress]) revert MockValidatorReverts();
        return _result[poolAddress][userAddress];
    }

    function isRegistered(address) external pure returns (bool) {
        revert NotImplemented();
    }

    function registerV2(address, RuleV2 calldata) external pure {
        revert NotImplemented();
    }

    function registerApass(address, address) external pure {
        revert NotImplemented();
    }

    function registerApass(address, address, address) external pure {
        revert NotImplemented();
    }

    function setRuleV2FromRegistrar(address, RuleV2 calldata) external pure {
        revert NotImplemented();
    }

    function setRuleV2FromContract(RuleV2 calldata) external pure {
        revert NotImplemented();
    }

    function addRuleV2FromContract(RuleV2 calldata) external pure {
        revert NotImplemented();
    }

    function removeRuleV2FromContract(uint256) external pure {
        revert NotImplemented();
    }

    function getRulesV2(address) external pure returns (RuleV2[] memory) {
        revert NotImplemented();
    }
}
