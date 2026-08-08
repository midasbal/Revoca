# Audit report (Phase 2c)

Design and coverage notes for the audit-trail export, `backend/src/audit/`.
This is the artifact behind the hackathon's "audit-ready" framing: not just
events emitted, but a verifiable, penny-exact reconstruction of a position's
full compliance-and-unwind history, purely from on-chain logs.

## Part 1, event coverage check (gate, done before building)

Enumerated every state-changing event across `LendingPool`,
`ComplianceRegistry`, `CompliancePolicy`, and `RevocationGuardian`, and
checked whether, from events alone, the following are all reconstructable:

1. Every compliance attestation (facts + who attested + when).
2. Every policy change.
3. The full lifecycle of a position (deposit, borrow, each unwind step,
   self-cure, liquidation, reinstatement, resolution) with amounts and
   timestamps, to the wei.

### Findings

**Compliance attestations, fully covered.** `ComplianceAttested` carries
every raw fact (`tier`, `subTier`, `country`, `apassStatus`, `expiry`,
`issuedAt`, `nonce`) plus the recovered `attestor` address, indexed by
`user`. Nothing is missing.

**Policy changes, fully covered.** Every `CompliancePolicy` setter emits a
named event with old/new values (`MinTierChanged`, `RatioBandsChanged`,
`CountryRuleChanged`, `GraceDurationChanged`, `StalenessChanged`,
`TierBorrowCapChanged`, etc). Replaying them in order reconstructs the
policy as of any block. The one field with no setter event is the
constructor's initial values, closed by reading `getPolicy()` at (or just
after) the deployment block once, as the baseline the replay starts from.

**Position lifecycle, one real gap found and closed.** Every
balance-mutating `LendingPool` event reports the resulting balance directly
except one: `CollateralAppliedToDebt` (the guardian's self-cure step)
reported `remainingDebt` but not the resulting collateral balance. Every
sibling event does report its resulting balance directly (`Repay` ->
`remainingDebt`, `CollateralWithdrawn` -> `newCollateralBalance`,
`Liquidate` -> `remainingCollateral`). Without it, the resulting collateral
balance after a self-cure step was only derivable indirectly, by
subtracting `amountApplied` from a collateral figure tracked separately
across a different event type (`CollateralPosted`/`CollateralWithdrawn`).
That's fragile for an audit-grade artifact: a claim should trace to a
single event, not a cross-event subtraction chain.

**Closed:** added `remainingCollateral` to `CollateralAppliedToDebt`
(`contracts/src/LendingPool.sol`), matching every sibling event's pattern.
Covered by `test_ApplyCollateralToDebt_EmitsRemainingCollateral` in
`contracts/test/LendingPool.t.sol`. With this fix, every collateral- and
debt-mutating event is self-describing: the report builder never derives a
balance by subtracting deltas across event types, it reads the resulting
balance directly off the event that caused it.

**Interest, reconstructable, not a gap.** No event fires on every second
of accrual (accrual is lazy, realized only at the next state-changing
call), but every event that DOES touch principal or debt (`Borrow`,
`Repay`, `CollateralAppliedToDebt`, `Liquidate`) reports the resulting
values directly, and pending interest since the last such checkpoint is a
closed-form function of principal, elapsed time, and the CURRENT
`currentInterestRateBpsPerSecond()` (`LendingPool._pendingInterest` reads
the live, utilization-derived rate, not a historical one, see
`LendingPool.sol`'s curve header for the formula). Read literally, this
means the effective rate for the ENTIRE backdated elapsed window since a
position's last accrual checkpoint is whatever the rate happens to be
RIGHT NOW, not a time-weighted/segmented average of what it actually was
at each moment in between, this pool has no time-weighted/segmented
accrual. Since the rate is a function of live utilization
(`currentUtilizationBps()`), this isn't only true after an owner
`ParamChanged` (base rate/slope/kink) any more, ordinary borrow/repay/
deposit/withdraw activity from ANY user moves utilization, and therefore
the rate, constantly. That's a real, slightly surprising property of the
deployed contract, not a report-builder bug, so the report builder
matches it exactly (`backend/src/audit/reconstruct.ts`'s `projectDebt`
uses the live `currentInterestRateBpsPerSecond()` read at the report's
block, the same value `currentDebt()` itself would use). This is why the
self-cross-check in Part 3 recomputes projected debt from the last
on-chain checkpoint rather than assuming the last event's `remainingDebt`
is still current, that would silently drift for any position with debt
still open when the report is generated.

**Cross-contract joins, documented, not a gap.** A liquidation that spills
out of a guardian-initiated unwind is TWO separate events in two separate
contracts in two separate transactions: `RevocationGuardian.UnwindStarted`
+ `UnwindStep("self-cure", ...)` in one tx, then a later, permissionless
`LendingPool.liquidate()` call emitting `Liquidate` in a different tx (see
`RevocationGuardian.sol`'s header on why `startUnwind` never calls
`pool.liquidate` itself). The report builder joins these by borrower
address and block/log ordering; this is a deliberate design consequence of
the guardian never performing the liquidation itself, not a missing event.

### Conclusion

One gap found, closed with a minimal, symmetric event field addition (a
Solidity change, a Forge test, both green). No other event/field additions
were needed; the rest of Part 2's honesty constraint is satisfied by
careful replay logic (rate-segmented interest, cross-contract joins), not
further contract changes.

## Part 2, report contents

`backend/src/audit/` builds a report from a pool address (registry, policy,
and guardian addresses are all read live off the pool, since `LendingPool`
holds them as immutables/owner-settable state, so only the pool address is
required input):

- **Per position**: full timeline (every event touching that borrower,
  ordered by block/log index, each entry citing its `txHash` and
  `logIndex`), every compliance observation, the unwind lifecycle if one
  occurred (flagged reason + grace deadline, each unwind step with
  amounts, completion + residual), and a running principal/collateral
  checkpoint used for the interest projection.
- **Per pool**: the compliance policy reconstructed purely from
  `CompliancePolicy` events (`policyAsOfBlock`), the live `getPolicy()`
  snapshot at the report's block for cross-check, the list of positions
  touched in the scanned range, and aggregate outcomes (counts by final
  guardian state, total interest realized, total liquidated, total
  residual returned).
- Every line item carries its source `txHash`, `blockNumber`, and
  `logIndex`.

Lender-side deposit/withdraw share accounting is deliberately out of this
report's scope, it's pool-economics bookkeeping, not compliance/unwind
history, and isn't needed to answer "was this position's revocation and
unwind handled correctly and auditable." `Deposit`/`Withdraw` events exist
and are complete if that's ever wanted, they're just not reconstructed
here.

## Part 3, verifiability

- **Self-cross-check**: for every position touched in the scanned range,
  the builder reads live on-chain state (`pool.positions`,
  `pool.currentDebt`, `guardian.positions`) at the report's block and
  asserts it matches the event-replay's reconstruction exactly (to the
  wei for debt/collateral, exact enum match for guardian state). A
  mismatch is a hard error surfaced in the report's `crossCheck` section,
  never a silent pass.
- **Signing**: the canonical JSON report (deterministic key ordering, all
  amounts as decimal strings, no floats) is hashed with keccak256, and the
  hash is signed EIP-191 (`personal_sign`) by the holder of
  `ATTESTOR_PRIVATE_KEY`, the same key already used for
  `ComplianceRegistry` attestations (see `docs/THREAT_MODEL.md` item 9).
  Reusing it is a deliberate choice: the attestor key is already the
  project's designated "the backend vouches for this" key, and the report
  is exactly that kind of claim. A third party recovers the signer from
  `(reportHash, signature)` and confirms it matches the known attestor
  address, no separate key to manage or document.

## Design note, why the pool address is sufficient input

`LendingPool` exposes `complianceGate()` (== the `ComplianceRegistry`,
since it implements `IComplianceGate`), `policy()`, and `guardian()` as
public reads. The CLI/library only require a pool address (and optionally
a borrower address to scope the report to one position); every other
contract address is derived on-chain rather than passed in, so there's no
way to accidentally point the report at a mismatched registry/policy/
guardian trio.
