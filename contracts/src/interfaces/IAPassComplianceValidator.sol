// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAPassComplianceValidator
 * @notice Cleanverse's on-chain CVI Compliance Validator (Design A). Real,
 * wired interface, promoted out of src/spike/IAPassComplianceValidator.sol
 * once docs/DESIGN_A_SPIKE.md (gitignored, local) proved the validator live
 * on Monad testnet end to end: deploy, grant, register, and both a clean
 * `false` and a clean `true` from `complianceVerify` against real A-Pass
 * state, all with real transaction hashes. The spike file is left in place
 * as the historical probe artifact; this file is the one HybridComplianceGate
 * actually imports.
 *
 * Transcribed verbatim from docs/cleanverse2.pdf (the CCP Integration Guide,
 * V2), section 3.2, "Core Interface Specification", per CLAUDE.md's "API is
 * a source of truth, not something to invent" rule. Deployed at the SAME
 * address on every chain (per Cleanverse, via Telegram):
 * 0xaC7e5179C2C7f03f209136886c172eb34F161792.
 */
interface IAPassComplianceValidator {
    /// @notice One compliance rule. Fields within one RuleV2 are AND;
    /// multiple RuleV2s registered against the same pool are OR; country
    /// bitmaps are checked via bitwise AND.
    struct RuleV2 {
        bytes2 allowedGroup; // Allowed CVI group (empty = no restriction)
        bytes2 allowedSubGroup; // Allowed CVI sub-group (empty = no restriction)
        uint8 minTier; // Minimum CVI tier (0 = no restriction)
        uint8 minSubTier; // Minimum CVI sub-tier (0 = no restriction)
        uint256 poolCountryBitmap; // Country bitmap (0 = no restriction)
    }

    // -----------------------------------------------------------------
    // Registration (REGISTER_ROLE required on-chain; the caller must be
    // authorized via the off-chain API registration flow first).
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
    // Compliance verification, plain view, no permission required. Returns
    // only a pass/fail bool, never a tier value, see
    // docs/DESIGN_A_SPIKE.md objective 4 and ITierOracle.sol's header.
    // Reverts with a decoded custom error, PoolNotRegistered(), for an
    // unregistered pool rather than returning false, confirmed empirically
    // against real Monad state, see docs/DESIGN_A_SPIKE.md objective 2.
    // -----------------------------------------------------------------

    function complianceVerify(address poolAddress, address userAddress) external view returns (bool);
}
