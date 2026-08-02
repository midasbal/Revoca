# Roadmap

The single source of truth for Revoca's plan from now through the hackathon.
Prep window: now through Aug 7 (private repo, work happens here). Official
build window: Aug 8 00:00 UTC – Aug 9 23:59 UTC. See "Commit-timing rule"
below for exactly what that split does and doesn't require.

Keep this file updated as the plan evolves, when a phase's status changes,
when a blocker resolves, when scope shifts, edit it here first.

## Commit-timing rule (confirmed)

**Private work before the window is allowed.** The actual submission
requirement is that the repo is **public at submission time** and shows
**meaningful commits during Aug 8–9 UTC**, not that every commit must fall
inside that window. This corrects earlier, stricter language in this repo
(now fixed in [CLAUDE.md](../CLAUDE.md) and [HACKATHON.md](HACKATHON.md)).

Plan:
- **Now → Aug 7:** repo stays **private**. Build freely, commit normally.
- **Aug 8 00:00 UTC:** flip the repo to **public**.
- **Aug 8–9 UTC:** do real, substantive work in the open, this isn't
  theater, Phase 3 below is genuinely gated on the window (real credentials
  answers, testnet deploy, live sandbox run). Don't sandbag finished prep
  work to fake activity; don't do fake busywork either. Keep commits atomic
  and well-messaged throughout both windows, so the eventual public history
  reads as what it is: substantial prep, then a real integration push.

## Status legend

- **DONE**, built, tested, merged.
- **IN PROGRESS**, actively being worked on this session or the current one.
- **UNBLOCKED**, buildable right now, nothing external required.
- **BLOCKED**, cannot proceed; blocker is named explicitly.

## Architecture decision: Design A vs B

`IComplianceGate`/`ITierOracle` (`contracts/src/interfaces/`) are the seam
that lets us defer this choice, `LendingPool` and `RevocationGuardian` were
built against the interfaces, not a specific implementation, specifically so
this decision doesn't require touching pool/guardian code later.

**New evidence (record it):** a competitor on the RWA track reported that
calling `/validator/grant` against the UAT sandbox on **monad** returns code
`12026`, *"apass compliance validator address not configured for chain:
monad"*, and the same for **ethereum**; **only polygon** has the Validator
actually deployed in the sandbox. This lines up with our own finding
([docs/OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) item 1): `validator/verify` and
`validator/is_register` both return `12027` ("Validator on-chain read
failed") against Monad, regardless of the address tested.

**Implication:** the on-chain Validator (Design A) appears **not available
on Monad** in the sandbox, independent of our own role/permissions. Two
data points (ours + a competitor's) pointing the same direction is a real
signal, not proof, Cleanverse could still confirm otherwise.

**Decision:** plan **Design B (backend attestor) as PRIMARY**. Keep Design A
behind the `IComplianceGate`/`ITierOracle` seam as a swap-in **if and only
if** Cleanverse confirms real on-chain Validator support on Monad.

**Two Telegram questions remain open** to actually confirm this (not
close the loop on inference alone):
1. What role do our sandbox credentials have? (Issue Member vs. Gateway
   Member vs. Service Partner, see OPEN_QUESTIONS.md item 1.)
2. Is there an on-chain Validator address + ABI for Monad testnet at all,
   or does the `12026`/`12027` pattern mean it's genuinely not deployed
   there? (OPEN_QUESTIONS.md item 2.)

## Milestones

In dependency order. Each phase name is stable, refer to phases by name
("Phase 2b") in commits/PRs so history stays legible.

### Phase 0, Foundation, **DONE**

Cleanverse API client (`backend/src/cleanverse/`): config, AES crypto,
EIP-191 owner-signature helper, typed client, error model. Live probes
against the real UAT sandbox (role/permission investigation, tier
distribution analysis, status-field singular-vs-list semantics). Tier-to-risk
mapping (`backend/src/risk/tierRatios.ts`) grounded in real sandbox data, and
its on-chain mirror (`contracts/src/CollateralRatioPolicy.sol`), kept in
mechanical parity via an `vm.ffi`-based Forge test. `LendingPool.sol`, full
deposit/borrow/repay/withdraw/liquidate mechanics, tier-scaled
under-collateralized borrowing, interest accrual, caps, pause.
`ComplianceRegistry.sol`, keeper-gated on-chain observation store with a
staleness guard (`isFresh`), wired into `IComplianceGate`. `RevocationGuardian.sol`,
the full HEALTHY→FLAGGED→UNWINDING→RESOLVED state machine, reinstatement,
self-cure-before-liquidation ordering. Backend keeper, read + classify
(`classifyBorrower`, source-agnostic via `ApassDataSource`), live dry-run
against real frozen sandbox records. Exhaustive local test suite: 75 Forge
tests, 44 backend tests (1 intentionally skipped pending a live encrypted
call).

### Phase 1, End-to-end local loop, **DONE**

Full stack deployed to a local anvil instance
(`contracts/script/DeployLocal.s.sol`); the keeper wrote real on-chain
transactions (not dry-run) against it; the full lifecycle
healthy → frozen → flagged → grace → unwind (+ reinstatement branch) ran
against real, mined transactions, not simulated in JS. Confirmed
self-cure-happens-before-liquidation with a real event log, not just Forge
`vm.warp`-based unit tests. This is the dress rehearsal the live demo
(Phase 3e) will re-run against the real sandbox.

### Phase 2, **UNBLOCKED**, build this week (prep window), in this order

Nothing here needs Telegram answers or testnet access, all buildable now,
against local/test infrastructure already in place.

**2a. Compliance Policy Engine.** Elevate the current min-tier + ratio-band
logic into a first-class, owner-configurable, event-logged on-chain policy
object. Adds: allowed/denied country sets (mirroring Cleanverse's
`countries` + `is_black_list` fields on the Rule object, see
[CLEANVERSE_API.md](CLEANVERSE_API.md)), grace duration, staleness
tolerance, and per-tier caps, all as owner-settable, event-emitting
parameters in one place. This becomes the backbone every other feature
(oracle, audit export, risk view) reads from, build it before 2b–2d, not
alongside them.

**2b. Signed-attestation Tier Oracle (EIP-712).** The backend signs
`(user, tier, subTier, timestamp, nonce)`; the contract verifies the
signature, checks freshness, and rejects replay via the nonce. This *is*
the foundation of the Design B attestor decided above, it's no longer a
"maybe," it's the load-bearing path, so build the signing/verification
machinery now, independent of *where* the signed data comes from (a real
`query_apass` call slots in later without touching this contract).

**2c. Audit-trail export.** A script or endpoint that reconstructs a full,
human-readable compliance-and-unwind history for a single position or the
whole pool, purely from on-chain events (`ComplianceObserved`,
`PositionFlagged`, `PositionReinstated`, `UnwindStarted`, `UnwindStep`,
`UnwindCompleted`, `Liquidate`, ...), exportable as a signed report.
Directly on-theme with the hackathon's "audit-ready reports" framing,
this is a demo-strength deliverable, not just internal tooling.

**2d. (Polish) Utilization-based interest rate.** Replace the current flat
linear per-second rate with a utilization-responsive curve. Lower priority
than 2a–2c, only pick this up if time remains after those land solidly.

### Phase 3, **BLOCKED** until the Aug 8–9 window

Needs: Telegram answers to the two open questions above, AND real Monad
testnet deployment (funded deployer, live sandbox credentials exercised for
real). This is *why* it's gated on the window, not an arbitrary rule.

**3a. Real Cleanverse-backed gate/oracle.** Implement the Design B attestor
for real (primary path): wire real `query_apass` SINGULAR reads (per
[docs/OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) item 7, singular, never
`query_apass_list`, which can serve stale/partial data) into the tier
oracle built in 2b. Design A only if Cleanverse confirms real on-chain
Validator support on Monad.

**3b. Deploy the full stack to Monad testnet.** Seed **real** positions
using test accounts we control: real deposits, real borrows, real A-Passes
registered at varied tiers, at least one deliberately frozen, not
anvil-local simulation this time.

**3c. Lender-side risk view.** Aggregate pool exposure by tier, percentage
under-collateralized, count of flagged/in-grace positions, per-lender
at-risk principal. Deliberately placed here, not earlier, it needs the
real seeded positions from 3b to be meaningful; built against synthetic
local data it would just be a UI shell.

**3d. Live end-to-end against the real UAT sandbox.** The dry-run
(Phase 0) and the local rehearsal (Phase 1), made real: the keeper's write
path, the registry, the guardian, all running against live Cleanverse data
and a real Monad testnet deployment simultaneously.

**3e. Demo.** Script + recorded video of a healthy position auto-unwinding
triggered by a real Cleanverse freeze, the actual money-shot the whole
project has been building toward.

## Backlog

Explicitly out of scope for the hackathon; possible future work, not to be
picked up now even if time allows:

- Cross-chain settlement
- Native AMM / token
- ZK identity proofs
- On-chain governance
- Multi-asset collateral
- Partial liquidation / bad-debt socialization

**Rationale:** each of these scatters the compliance-reactive thesis
(tier-scaled lending + auditable unwind on revocation) rather than
deepening it. Revisit only after the core is airtight, i.e., not before
Phase 3 is fully done, and not without a deliberate decision to re-scope.
