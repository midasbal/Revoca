// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAPassComplianceValidator (SPIKE / PROBE, not wired into anything)
 * @notice THIS IS A SPIKE FILE. It exists only to type the on-chain CVI
 * Compliance Validator for the read-only Design A probe in
 * backend/scripts/spike-validator-read.ts. It is NOT imported by
 * LendingPool.sol, RevocationGuardian.sol, ComplianceRegistry.sol, or any
 * of the real IComplianceGate/ITierOracle/ICountrySource seam. Do not wire
 * it into anything this session, see docs/DESIGN_A_SPIKE.md (gitignored,
 * local) for the full findings writeup and the intended real integration
 * plan, which is reserved for the Aug 8-9 window.
 *
 * Transcribed directly from docs/cleanverse2.pdf (the CCP Integration
 * Guide, V2), section 3.2, "Core Interface Specification". Field order,
 * names, and types are copied verbatim from the guide's Solidity snippets,
 * not invented or guessed, per CLAUDE.md's "API is a source of truth"
 * rule. The deployed validator address is documented (by Cleanverse, via
 * Telegram) as the SAME address on every chain:
 * 0xaC7e5179C2C7f03f209136886c172eb34F161792.
 */
interface IAPassComplianceValidator {
    /// @notice One compliance rule. Fields within one RuleV2 are AND;
    /// multiple RuleV2s registered against the same pool are OR; country
    /// bitmaps are checked via bitwise AND. Verbatim from the guide's 3.1.
    struct RuleV2 {
        bytes2 allowedGroup; // Allowed CVI group (empty = no restriction)
        bytes2 allowedSubGroup; // Allowed CVI sub-group (empty = no restriction)
        uint8 minTier; // Minimum CVI tier (0 = no restriction)
        uint8 minSubTier; // Minimum CVI sub-tier (0 = no restriction)
        uint256 poolCountryBitmap; // Country bitmap (0 = no restriction)
    }

    // -----------------------------------------------------------------
    // Registration (REGISTER_ROLE required on-chain; the caller must be
    // authorized via the off-chain API registration flow first, see the
    // guide's 5.4 and docs/DESIGN_A_SPIKE.md's signature-scheme analysis).
    // -----------------------------------------------------------------

    function registerV2(address poolAddress, RuleV2 calldata rule) external;
    function registerApass(address poolAddress, address aTokenAddress) external;
    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external;
    function setRuleV2FromRegistrar(address poolAddress, RuleV2 calldata rule) external;

    /// @notice Whether `poolAddress` has been registered with the validator. Plain view, no permission required.
    function isRegistered(address poolAddress) external view returns (bool);

    // -----------------------------------------------------------------
    // Rule management, called BY the business contract itself (msg.sender
    // == poolAddress), not by a registrar.
    // -----------------------------------------------------------------

    function setRuleV2FromContract(RuleV2 calldata rule) external;
    function addRuleV2FromContract(RuleV2 calldata rule) external;
    function removeRuleV2FromContract(uint256 index) external;

    /// @notice Current V2 rules for `poolAddress`. Plain view, no permission required.
    function getRulesV2(address poolAddress) external view returns (RuleV2[] memory);

    // -----------------------------------------------------------------
    // Compliance verification, plain view, no permission required. THIS
    // IS THE FUNCTION THE PROBE CALLS. Returns only a pass/fail bool, no
    // tier value, see docs/DESIGN_A_SPIKE.md objective 4.
    // -----------------------------------------------------------------

    function complianceVerify(address poolAddress, address userAddress) external view returns (bool);
}
