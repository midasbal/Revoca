/**
 * Types for the audit report (Phase 2c, docs/AUDIT_REPORT.md). All amounts
 * are decimal strings (never numbers/floats, see CLAUDE.md-adjacent
 * "penny-exact" requirement in docs/ROADMAP.md Phase 2c), carried as raw
 * base-unit strings (wei-equivalent) so JSON round-trips without precision
 * loss; human-readable formatted amounts are a separate field.
 */
import type { Address, Hex } from "viem";

/** A source citation, every line item in the report carries one. */
export interface SourceRef {
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  timestamp: string;
}

export interface Amount {
  /** Raw base-unit value, e.g. wei, as a decimal string. */
  raw: string;
  /** Formatted using the asset's decimals(), e.g. "1000.0". */
  formatted: string;
}

export type TimelineEntryType =
  | "ComplianceAttested"
  | "CollateralPosted"
  | "Borrow"
  | "Repay"
  | "CollateralWithdrawn"
  | "CollateralAppliedToDebt"
  | "Liquidate"
  | "PositionFlagged"
  | "PositionReinstated"
  | "UnwindStarted"
  | "UnwindStep"
  | "UnwindCompleted";

export interface TimelineEntry {
  source: SourceRef;
  type: TimelineEntryType;
  detail: Record<string, unknown>;
}

export interface ComplianceObservation {
  source: SourceRef;
  attestor: Address;
  tier: number;
  subTier: number;
  country: Hex;
  apassStatus: number;
  expiry: string;
  issuedAt: string;
  nonce: string;
}

export interface UnwindStep {
  source: SourceRef;
  step: string;
  amount: Amount;
  remainingDebt: Amount;
}

export interface UnwindRecord {
  reason: string;
  flaggedAt: SourceRef;
  graceEndsAt: string;
  unwindStarted?: { source: SourceRef; debtAtStart: Amount; collateralAtStart: Amount } | undefined;
  steps: UnwindStep[];
  liquidation?: { source: SourceRef; debtRepaid: Amount; collateralSeized: Amount; remainingCollateral: Amount } | undefined;
  reinstatedAt?: SourceRef | undefined;
  completedAt?: { source: SourceRef; residualCollateral: Amount } | undefined;
}

export interface PositionReport {
  borrower: Address;
  originatedAt?: SourceRef | undefined;
  timeline: TimelineEntry[];
  complianceObservations: ComplianceObservation[];
  /** Every flag->[reinstate|unwind->resolve] cycle this borrower went through, in order. A borrower can be flagged more than once over its lifetime (RESOLVED and HEALTHY are both re-flaggable). */
  unwinds: UnwindRecord[];
  reconstructed: {
    principal: Amount;
    collateral: Amount;
    /** Projected current debt (principal + accrued + pending interest) as of the report's block, using rate-segmented projection from the last on-chain checkpoint. See docs/AUDIT_REPORT.md's interest section. */
    debtAsOfReport: Amount;
    guardianState: string;
  };
  onChain: {
    principal: Amount;
    collateral: Amount;
    debtAsOfReport: Amount;
    guardianState: string;
  };
  crossCheckOk: boolean;
  crossCheckDiscrepancies: string[];
}

export interface PolicyChangeEvent {
  source: SourceRef;
  type: string;
  detail: Record<string, unknown>;
}

export interface PoolAggregate {
  positionCount: number;
  byFinalGuardianState: Record<string, number>;
  totalInterestRealized: Amount;
  totalCollateralSeizedByLiquidation: Amount;
  totalResidualCollateralReturned: Amount;
}

export interface AuditReport {
  meta: {
    generatedAtBlock: string;
    generatedAtTimestamp: string;
    fromBlock: string;
    toBlock: string;
    chainId: number;
    pool: Address;
    registry: Address;
    policy: Address;
    guardian: Address;
    asset: Address;
    assetSymbol: string;
    assetDecimals: number;
  };
  policy: {
    history: PolicyChangeEvent[];
    asOfReport: Record<string, unknown>;
    crossCheckOk: boolean;
    crossCheckDiscrepancies: string[];
  };
  positions: PositionReport[];
  aggregate: PoolAggregate;
  crossCheckOk: boolean;
}

export interface SignedReport {
  report: AuditReport;
  reportHash: Hex;
  signature: Hex;
  signer: Address;
}
