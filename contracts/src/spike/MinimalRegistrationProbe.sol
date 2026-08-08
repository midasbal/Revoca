// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAPassComplianceValidator} from "./IAPassComplianceValidator.sol";

/**
 * @title MinimalRegistrationProbe (SPIKE / PROBE, not wired into anything)
 * @notice THIS IS A SPIKE FILE. Deployed once, on real Monad testnet, for
 * the sole purpose of proving the `validator/grant` + `validator/register`
 * handshake and then `setRuleV2FromContract` + `complianceVerify` actually
 * work end to end against Cleanverse's real CVI Compliance Validator. It is
 * NOT LendingPool, NOT wired into RevocationGuardian or ComplianceRegistry,
 * and NOT the real on-chain gate integration, that is separate, later work
 * once this probe proves the handshake itself. See
 * docs/DESIGN_A_SPIKE.md and docs/ROADMAP.md Phase 3's 3a (both gitignored,
 * local) for the full context.
 *
 * Deliberately minimal, matching the CCP Integration Guide's (Pattern 2,
 * "Single-Contract Mode") stated requirements exactly, nothing more:
 *   - Store the validator address (immutable).
 *   - Inherit Ownable, only the owner manages rules.
 *   - Expose the rule-management passthroughs the guide's own template
 *     shows (setRuleV2FromContract / addRuleV2FromContract /
 *     removeRuleV2FromContract / getRulesV2).
 * `complianceVerify` itself is not wrapped here, it's a plain, no-permission
 * view on the validator (poolAddress, userAddress), callable directly by
 * the probe script without needing this contract to relay it.
 */
contract MinimalRegistrationProbe is Ownable {
    IAPassComplianceValidator public immutable validator;

    constructor(address validator_, address owner_) Ownable(owner_) {
        require(validator_ != address(0), "validator=0");
        validator = IAPassComplianceValidator(validator_);
    }

    function setRuleV2FromContract(IAPassComplianceValidator.RuleV2 calldata rule) external onlyOwner {
        validator.setRuleV2FromContract(rule);
    }

    function addRuleV2FromContract(IAPassComplianceValidator.RuleV2 calldata rule) external onlyOwner {
        validator.addRuleV2FromContract(rule);
    }

    function removeRuleV2FromContract(uint256 index) external onlyOwner {
        validator.removeRuleV2FromContract(index);
    }

    function getRulesV2() external view returns (IAPassComplianceValidator.RuleV2[] memory) {
        return validator.getRulesV2(address(this));
    }
}
