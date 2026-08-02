/**
 * ABI fragments the audit report builder needs, kept minimal and hand-typed
 * (not the full Foundry artifact) so this module has no build-time
 * dependency on `contracts/`. Event signatures MUST match the deployed
 * contracts exactly, see docs/AUDIT_REPORT.md's event-coverage check for
 * why each one is here, and CollateralAppliedToDebt's `remainingCollateral`
 * field in particular (the one gap that check found and closed).
 */
import { parseAbi } from "viem";

export const LENDING_POOL_EVENTS_ABI = parseAbi([
  "event Deposit(address indexed lender, uint256 amount, uint256 sharesMinted, uint256 totalShares)",
  "event Withdraw(address indexed lender, uint256 amount, uint256 sharesBurned, uint256 totalShares)",
  "event CollateralPosted(address indexed borrower, uint256 amount, uint256 newCollateralBalance)",
  "event Borrow(address indexed borrower, uint256 amount, uint256 newPrincipal, uint256 newDebt, uint16 tier, uint16 subTier, uint16 ratioBps)",
  "event Repay(address indexed borrower, uint256 amount, uint256 principalPaid, uint256 interestPaid, uint256 remainingDebt)",
  "event CollateralWithdrawn(address indexed borrower, uint256 amount, uint256 newCollateralBalance)",
  "event Liquidate(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized, uint256 remainingCollateral)",
  "event ParamChanged(string name, uint256 oldValue, uint256 newValue)",
  "event GuardianChanged(address indexed oldGuardian, address indexed newGuardian)",
  "event CollateralAppliedToDebt(address indexed borrower, uint256 amountApplied, uint256 principalPaid, uint256 interestPaid, uint256 remainingDebt, uint256 remainingCollateral)",
]);

export const LENDING_POOL_READ_ABI = parseAbi([
  "function asset() external view returns (address)",
  "function complianceGate() external view returns (address)",
  "function policy() external view returns (address)",
  "function guardian() external view returns (address)",
  "function interestRateBpsPerSecond() external view returns (uint256)",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function currentDebt(address) external view returns (uint256)",
]);

export const COMPLIANCE_REGISTRY_EVENTS_ABI = parseAbi([
  "event ComplianceAttested(address indexed user, uint16 tier, uint16 subTier, bytes2 country, uint8 apassStatus, uint256 expiry, uint256 issuedAt, uint256 nonce, address indexed attestor)",
  "event AttestorSet(address indexed attestor, bool authorized)",
]);

export const COMPLIANCE_POLICY_EVENTS_ABI = parseAbi([
  "event MinTierChanged(uint16 oldValue, uint16 newValue)",
  "event MinSubTierChanged(uint16 oldValue, uint16 newValue)",
  "event AllowedGroupChanged(bytes2 oldValue, bytes2 newValue)",
  "event AllowedSubGroupChanged(bytes2 oldValue, bytes2 newValue)",
  "event CountryRuleChanged(bytes2[] countries, bool isBlacklist)",
  "event RatioBandsChanged((uint16 minTier, uint16 minSubTier, uint16 ratioBps)[] bands)",
  "event GraceDurationChanged(uint256 oldValue, uint256 newValue)",
  "event StalenessChanged(uint256 oldValue, uint256 newValue)",
  "event DefaultBorrowCapChanged(uint256 oldValue, uint256 newValue)",
  "event TierBorrowCapChanged(uint16 indexed tier, uint256 oldValue, uint256 newValue)",
  "event MaxTotalBorrowChanged(uint256 oldValue, uint256 newValue)",
]);

// getPolicy() returns a SINGLE struct (Policy memory), i.e. one tuple
// output parameter, not N separate top-level outputs, its ABI encoding is
// not the same bytes as N flat outputs would be (a lesson from a real
// decode failure this ABI definition used to have, see git history), so
// the tuple nesting below must match the Solidity struct exactly.
export const COMPLIANCE_POLICY_READ_ABI = parseAbi([
  "function getPolicy() external view returns ((uint16 minTier, uint16 minSubTier, bytes2 allowedGroup, bytes2 allowedSubGroup, bool isBlacklist, bytes2[] countries, (uint16 minTier, uint16 minSubTier, uint16 ratioBps)[] ratioBands, uint256 graceDuration, uint256 maxComplianceStaleness, uint256 defaultBorrowCap, uint256 maxTotalBorrow))",
]);

export const REVOCATION_GUARDIAN_EVENTS_ABI = parseAbi([
  "event PositionFlagged(address indexed borrower, uint8 reason, uint256 graceEndsAt)",
  "event PositionReinstated(address indexed borrower)",
  "event UnwindStarted(address indexed borrower, uint256 debtAtStart, uint256 collateralAtStart)",
  "event UnwindStep(address indexed borrower, string step, uint256 amount, uint256 remainingDebt)",
  "event UnwindCompleted(address indexed borrower, uint256 residualCollateral)",
]);

export const REVOCATION_GUARDIAN_READ_ABI = parseAbi([
  "function positions(address) external view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)",
]);

export const ERC20_READ_ABI = parseAbi([
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
]);

/** Matches RevocationGuardian.sol's PositionState enum order exactly. */
export const GUARDIAN_STATE_NAMES = ["HEALTHY", "FLAGGED", "UNWINDING", "RESOLVED"] as const;

/** Matches ComplianceRegistry.sol's Reason enum order exactly. */
export const REASON_NAMES = ["NONE", "FROZEN", "EXPIRED", "BLACKLISTED", "INELIGIBLE", "TIER_DROP"] as const;
