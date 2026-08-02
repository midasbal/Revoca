# Revoca

**Track:** DeFi (Compliant DeFi)
**Chain:** Monad testnet (via Cleanverse UAT sandbox)

## One-line

A tier-scaled, under-collateralized lending pool built on the Cleanverse
Validator, whose defining feature is a safe, auditable unwind of an existing
position when a borrower's A-Pass is frozen, expires, is blacklisted, or drops
below the pool's minimum tier.

## The gap it fills

The Validator already answers "is this address eligible right now" **at
entry**, via `validator/verify`, and A-Token transfers are already gated on
A-Pass status. That's runtime compliance gating, and Cleanverse already does
it, Revoca is not reinventing that.

What nobody handles is the lifecycle of an **existing** position when
eligibility flips mid-loan: `verify` starts returning `false` for an address
that already has an open loan, and the loan, collateral, and accrued interest
are left with no defined outcome. There's no exit path.

Revoca is that missing exit, plus it uses A-Pass **tier** as a live risk
parameter (higher tier → lower collateral requirement), rather than a
one-time gate.

**Framing to hold onto:** don't describe this as "inventing runtime
compliance." The Validator already does that. The novelty here is (1) the
unwind path for positions that were opened compliantly and later fall out of
compliance, and (2) tier-as-risk-parameter instead of tier-as-binary-gate.

## Scope

- Single lending asset, single pool.
- Fixed tier-to-collateral-ratio table (not a curve, not dynamic).
- Simple linear interest.
- Small caps on deposit/borrow size.
- The unwind (`RevocationGuardian`) is the centerpiece, most design and
  review effort goes there.

## Non-goals

- Real credit scoring.
- Multi-asset lending or multiple pools.
- Governance.
- Mainnet deployment.
- Oracles beyond the minimum needed for liquidation math.

## A-Token as settlement asset, STRETCH goal only

The **required core** uses a plain testnet token (or a provided `aUSDC`) as
the lent asset, so the critical path never depends on the AES-encrypted
A-Token issuance flow. If time allows on Day 2, explore using A-Token as the
settlement asset as a stretch enhancement, but the demo must work end-to-end
without it.
