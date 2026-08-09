import { GuardianReason, GuardianState } from './chain';
import type { RegistryEntry } from './hooks/usePositionsRegistry';

export type PositionStatusPhase = 'valid' | 'struck';

export interface PositionStatus {
  phase: PositionStatusPhase;
  label: string;
  detail: string;
}

/** The single place "what does this position's guardian state mean" is decided, shared by the positions registry and the pool risk view so the two never quietly disagree. */
export function positionStatus(entry: Pick<RegistryEntry, 'guardianState' | 'guardianReason' | 'compliant' | 'tier' | 'subTier'>): PositionStatus {
  const inGrace = entry.guardianState === GuardianState.FLAGGED;
  const unwinding = entry.guardianState === GuardianState.UNWINDING;
  const struck = inGrace || unwinding || (entry.guardianState === GuardianState.RESOLVED && !entry.compliant);

  if (unwinding) return { phase: 'struck', label: 'UNWINDING', detail: GuardianReason[entry.guardianReason] ?? 'UNKNOWN' };
  if (inGrace) return { phase: 'struck', label: 'IN GRACE', detail: GuardianReason[entry.guardianReason] ?? 'UNKNOWN' };
  if (struck) return { phase: 'struck', label: 'STRUCK', detail: GuardianReason[entry.guardianReason] ?? 'UNKNOWN' };
  return { phase: 'valid', label: 'VALID', detail: `Tier ${entry.tier}/${entry.subTier}` };
}
