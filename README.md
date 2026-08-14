# Cleanverse Hackathon: 7th Place: https://cleanverse.com/hackathon-results

# Revoca

Most compliance-aware lending gates entry once, at the moment a loan opens,
and never looks again. Revoca is the design built around the case that
gate misses: an existing position whose borrower's identity status changes
mid-loan. It unwinds that position safely, fairly, and reversibly instead
of leaving it stuck.

Compliance-reactive, under-collateralized lending on Cleanverse. A borrower's
A-Pass tier sets their collateral ratio, and if their eligibility changes
mid-loan (frozen, expired, or a tier drop) an on-chain state machine drives
their position through a safe, auditable unwind: self-cure from their own
collateral first, a grace period before anything drastic happens, permissionless
liquidation only if self-cure isn't enough, and full reinstatement if
compliance is restored in time.

Target chain: Monad testnet, via the Cleanverse UAT sandbox. The full
contract stack is deployed there (provisional, redeployed as the
contracts evolve; see Current status and scope below). Track: DeFi
(Compliant DeFi), built for the Cleanverse Build hackathon.

## The problem

Cleanverse's Validator already answers "is this address eligible right now"
at entry, via `validator/verify`, and A-Token transfers are gated on A-Pass
status. That is runtime compliance gating, and Cleanverse already does it;
Revoca does not reinvent it.

What isn't handled is the lifecycle of an *existing* position once
eligibility changes mid-loan. `validator/verify` starts returning `false` for
an address that already has an open loan, and the loan, its collateral, and
its accrued interest are left with no defined outcome. There is no exit path.

Revoca is that missing exit. It also treats A-Pass tier as a live risk
parameter, a higher tier means a lower required collateral ratio, rather
than tier being a one-time, binary pass/fail gate.

## How it works

### The attestor path (Design B), and why it's primary

**Update, resolved.** The paragraph below records an early, since-superseded
finding: at the time it was written, Cleanverse's on-chain Validator
appeared unreachable on Monad. A later read-only probe against the real
Validator address on live Monad testnet found real bytecode there and a
working `complianceVerify` call, so the Validator is in fact live on
Monad; the earlier `12026`/`12027` errors reflected the Cleanverse API's
own on-chain read path, not an absent contract. The real architecture is
a hybrid, not attestor-only: `HybridComplianceGate.sol` gates
eligibility against the real on-chain Validator (Design A), while the
attestor below remains permanently required as the only source of a
borrower's actual tier number, since `complianceVerify` returns a
pass/fail boolean, never a tier. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full, current
account. The original reasoning is kept below for the record.

Cleanverse's on-chain Validator did not appear to be deployed on Monad in
the UAT sandbox: `validator/verify` and `validator/is_register` both return
error code `12027` ("Validator on-chain read failed") against Monad,
regardless of the address tested, and a separate report from another team
building on the sandbox found `validator/grant` returning `12026`
("apass compliance validator address not configured for chain: monad") for
both Monad and Ethereum. Two independent signals pointing the same way is
real, not conclusive, but it's why Revoca was built primary against an
off-chain attestor rather than a direct on-chain Validator read.

A backend attestor reads a borrower's real A-Pass state from Cleanverse
(`query_apass`, the singular per-address endpoint, never the list endpoint,
which was found to serve stale or partial tier/expiration data for a
specific address) and signs an EIP-712 `ComplianceAttestation` over the raw
facts: tier, subTier, country, A-Pass status, expiry, when it was read, and a
strictly increasing per-user nonce. The attestor signs *facts*, never a
verdict. There is no "compliant: true/false" field in what gets signed.

Anyone may relay a valid, signed attestation to `ComplianceRegistry` on-chain
(`submitAttestation` is permissionless; trust lives in the signature, not the
sender). Eligibility is then derived on-chain, live, from those stored facts
plus `CompliancePolicy` (minimum tier and subTier, an allowed/denied country
list, and a tier-to-collateral-ratio table). If the pool owner tightens the
policy after a user was attested, that user's eligibility can flip
immediately, with no new attestation involved, because the check is
evaluated at read time against current policy, not cached at attestation
time.

`LendingPool` and `RevocationGuardian` are written against three small
interfaces, `IComplianceGate`, `ITierOracle`, and `ICountrySource`, and
`ComplianceRegistry` implements all three. That on-chain-read swap, now
that the real Validator is confirmed live on Monad, has since been
built: `HybridComplianceGate.sol` implements the same interfaces against
the real Validator, deployed and proven on live Monad testnet, with zero
changes to `LendingPool` or `RevocationGuardian`, exactly what the seam
was built for.

### The unwind: RevocationGuardian's state machine

Every position moves through four states:

```
  HEALTHY --flag()--> FLAGGED --startUnwind()--> UNWINDING --completeUnwind()--> RESOLVED
             ^                     |
             |                     |
             +-----reinstate()-----+
```

- `flag()` is permissionless and callable once the registry shows a fresh,
  non-compliant observation (frozen, expired, or otherwise ineligible), or
  once the pool independently considers the position unhealthy at the
  borrower's current tier-derived ratio (a tier drop). It starts a grace
  timer, read live from `CompliancePolicy`.
- Within the grace window, `reinstate()` returns the position to `HEALTHY`
  if compliance and health are both restored.
- Once grace elapses, `startUnwind()` first applies the borrower's own
  posted collateral to their own debt (self-cure), interest accrued exactly
  to that moment, not approximated. If that fully clears the debt, the
  position resolves immediately in the same transaction. If not, the
  position is left exposed to `LendingPool.liquidate()`, which is already
  permissionless, anyone may complete it.
- `completeUnwind()` is a separate, permissionless step that marks the
  position `RESOLVED` once its debt has actually reached zero, whether that
  happened via self-cure alone, a direct repayment, or liquidation.
- Once debt is fully cleared, by any path, `withdrawCollateral` never gates
  on compliance or freshness again. A borrower who is still non-compliant
  can always withdraw their residual collateral. Revocation settles what was
  owed; it does not confiscate what wasn't.

### Architecture

```
                     Cleanverse UAT sandbox
                (query_apass, validator/verify, ...)
                              |
                              | HTTPS reads (live); encrypted writes
                              | (register/grant/rules) also proven live
                              v
                 +------------------------------+
                 |      Backend (Node/TS)        |
                 |  Cleanverse API client         |
                 |  Attestor (reads facts, signs  |
                 |    EIP-712 attestations)       |
                 |  Keeper (relays attestations,   |
                 |    drives guardian state)      |
                 |  Audit report builder           |
                 +---------------+----------------+
                                 |
                   signed ComplianceAttestation,
                   relayed permissionlessly
                                 v
   +----------------------------------------------------------+
   |                Monad testnet (live, provisional deploy)   |
   |                                                            |
   |   ComplianceRegistry  (facts + freshness; implements       |
   |         |               IComplianceGate/ITierOracle/       |
   |         |               ICountrySource)                    |
   |         v                                                  |
   |   CompliancePolicy  (owner-configurable, event-logged:     |
   |         ^            min tier/subTier, country rule,       |
   |         |            ratio bands, grace duration,          |
   |         |            staleness window, borrow caps)        |
   |         |                                                  |
   |   LendingPool  <---------------->  RevocationGuardian       |
   |   (deposit/borrow/repay/           (flag/reinstate/         |
   |    withdraw/liquidate,              startUnwind/            |
   |    tier-scaled collateral            completeUnwind)        |
   |    ratios)                                                  |
   +----------------------------------------------------------+
                                 |
                        on-chain events
                                 v
                  Audit report builder (backend/src/audit)
              event replay -> self-cross-check against live
              chain state -> optional EIP-191 signed JSON/markdown report
```

## What's built and tested

Verified locally before writing this update: `forge test` passes 182 of
183 tests across 13 suites in `contracts/` (the 1 skip only happens when
`MONAD_TESTNET_RPC` isn't available to `forge`, that one suite is a real,
no-mock-data integration test against the live Monad testnet validator, see
`contracts/test/HybridComplianceGateMonadFork.t.sol`), and the backend's
`vitest` suite passes 86 tests with 1 intentionally skipped (it needs a
genuine encrypted response from the live Cleanverse sandbox to validate the
AES round-trip against real data, not just the documented spec).

**Contracts** (`contracts/src/`):
- `LendingPool.sol`, deposit, borrow, repay, withdraw, liquidate, tier-scaled
  collateral ratios, a utilization-based two-slope interest rate (base
  rate, a slope up to an owner-configurable kink, a steeper slope beyond
  it), Pausable, ReentrancyGuard, SafeERC20, custom errors throughout.
- `RevocationGuardian.sol`, the unwind state machine described above.
- `IUnwindStrategy` (`contracts/src/interfaces/`) and three implementations
  (`contracts/src/strategies/`): `GraceAndNotifyStrategy` (the default,
  reads grace duration live from `CompliancePolicy`, preserves the
  original behavior exactly), `ImmediateQuarantineStrategy` (a short,
  fixed grace period), `ForcedUnwindStrategy` (zero grace, unwind is
  callable in the same block a position is flagged). A strategy varies
  ONLY timing/aggressiveness, `RevocationGuardian.setStrategy` (owner-only)
  rejects, on-chain, any strategy that doesn't declare self-cure-before-
  liquidation and reinstatement-allowed, so no strategy can confiscate
  value or trap a borrower's exit, that stays guaranteed by the guardian's
  own unconditional mechanics regardless of which strategy is active.
- `ComplianceRegistry.sol`, the EIP-712 attestation store and verifier.
- `CompliancePolicy.sol`, the single, owner-configurable, event-logged home
  for every eligibility and risk parameter the rest of the system reads.
- `IComplianceGate` / `ITierOracle` / `ICountrySource`, the seams described
  above.
- `HybridComplianceGate.sol`, the real Design A/B hybrid gate: an
  owner-set, explicit `ValidatorGated`/`AttestorGated` mode (never
  inferred from a revert), calls the real on-chain Validator directly in
  `ValidatorGated` mode and fails closed to "not compliant" if that call
  reverts for any reason, delegates to `ComplianceRegistry` in
  `AttestorGated` mode. `ComplianceRegistry` remains the tier-value source
  either way. Proven both offline (a mock validator: true, false, revert)
  and against the real validator on live Monad testnet.

**Backend** (`backend/src/`):
- `cleanverse/`, the API client (AES encrypt/decrypt for encrypted
  endpoints, EIP-191 owner-signature helper, a typed client covering every
  endpoint in the distilled API spec).
- `attestor/`, builds and signs `ComplianceAttestation`s and relays them
  on-chain.
- `keeper/`, drives the guardian's state machine from live classification.
- `audit/`, the event-sourced audit report builder and its CLI.

**Proven end to end, against a real local chain, not simulated in-process**:
a Foundry deploy script (`contracts/script/DeployLocal.s.sol`) spins up the
full stack on a real `anvil` instance, and
`backend/test/e2e-local-rehearsal.test.ts` drives real transactions through
it: an under-collateralized borrow, a freeze, a flag, a reinstatement within
grace, an unwind that spills into permissionless liquidation, and a separate
unwind resolved entirely by self-cure with a genuine, non-zero residual
returned to a still-non-compliant borrower.

**Adversarial scenario suite** (`backend/test/adversarial/`): seven
scenarios, each a real transaction sequence against a live local deployment,
not a mock, each printing an attack-and-outcome trace. Griefing (an induced
freeze does not let an attacker force an immediate profitable liquidation in
the tested scenario, self-cure runs first and the attacker's balance is
unchanged); a stale attestation blocking risk-increasing actions while
repay and the unwind mechanics proceed regardless; attestation replay and
out-of-order nonces rejected; forged, tampered, and revoked-attestor
attestations rejected; attestations signed under the wrong chain ID or the
wrong verifying contract rejected; a frozen borrower blocked from new
draws but still able to recover their full residual collateral; and a
policy tightening flipping eligibility live with no new attestation
involved.

**Audit report** (`backend/src/audit/`, `docs/AUDIT_REPORT.md`): reconstructs
a pool's full compliance-and-unwind history purely from on-chain event logs,
citing the source transaction and log index for every line item. It
self-cross-checks its own reconstruction against a live on-chain read at the
report's block, a mismatch is a hard error in the report, never a silent
pass, and it can be signed (EIP-191 over the canonical JSON hash) with the
attestor key so a third party can verify who produced it. Event queries are
paged in bounded block chunks rather than one unbounded request, since real
RPC providers commonly cap `eth_getLogs` by block range or response size.

**Deployed to real Monad testnet** (`frontend/src/deployment.ts` holds the
current addresses; provisional, redeployed as the contracts evolve): the
full stack, `CompliancePolicy`, `ComplianceRegistry`, `HybridComplianceGate`,
`LendingPool`, `RevocationGuardian`, is live there, not local `anvil` only.
The deployed gate runs in `ValidatorGated` mode, checking eligibility
against Cleanverse's real on-chain Validator directly, with
`ComplianceRegistry` still supplying the tier value. The full loop, real
`generate_apass`, a real signed attestation landing on chain, a real
borrow, has been driven end to end against this live deployment, not
simulated.

**Frontend** (`frontend/`, React + viem/wagmi): built, not a placeholder.
Landing page; a lending app at `/lend` with a borrower view (live A-Pass
standing, the real tier-scaled collateral ratio, post/borrow/repay/withdraw
as real transactions) and a lender view (deposit/withdraw, live pool
utilization) behind one toggle; real onboarding for a wallet with no
A-Pass yet (provisions a real A-Pass, attests it on chain, funds real
testnet gas and rtUSD); `/positions`, a live registry of every open
position in the pool; `/positions/:address`, the single-record view; `/pool`,
the pool's compliance-risk composition; `/docs`, the technical reference.
Every read goes straight to Monad testnet via viem; the one action that
needs a secret (onboarding's provisioning call) goes through the backend
described above, built deployable as small serverless functions
(`backend/api/`, see `backend/DEPLOY.md`), never a process run locally to
serve the app. Runs today with `npm run dev`; not yet deployed to a public
URL, see Current status and scope below.

## Compliance and security properties

- **Freshness is a separate question from compliance.** A stale-but-once-true
  attestation still reports `isCompliant() == true`; it separately reports
  `isFresh() == false`. Risk-increasing actions (borrow, withdrawing
  collateral while debt is open) require both. Risk-decreasing actions
  (repay, liquidate, every step of the unwind, and withdrawing collateral
  once debt is zero) never gate on staleness, a stale attestation can never
  trap a borrower's exit.
- **Facts, never a verdict.** The attestor cannot itself grant eligibility
  the policy forbids: it only ever signs raw facts, and `isCompliant` is
  derived from those facts plus the current `CompliancePolicy` at read time.
- **Replay, domain, and malleability protection.** The EIP-712 domain binds
  chain ID and the exact verifying contract into the signed digest, so a
  signature valid on one deployment cannot be replayed on another. A
  strictly increasing per-user nonce prevents replaying or reordering an
  attestation. Signature recovery is via OpenZeppelin's `ECDSA.recover`,
  which rejects malformed and non-canonical signatures.
- **Attestor rotation.** `setAttestor(address, bool)` is owner-only and
  takes effect immediately; multiple attestors can be authorized at once, so
  rotating a compromised key needs no downtime.
- **The audit report proves itself against live state**, not just against
  its own replay, see above.

## Current status and scope

This section describes what actually exists right now, not the plan, see
`ROADMAP.md` for what comes next, or the history in the "Update" notes above.

**Built and live:**

- The full contract stack, `CompliancePolicy`, `ComplianceRegistry`,
  `HybridComplianceGate`, `LendingPool`, `RevocationGuardian`, is deployed
  to real Monad testnet (provisional, see `frontend/src/deployment.ts` for
  current addresses; it will be redeployed again as the contracts keep
  evolving, that is expected, not a gap).
- The deployed pool is registered with Cleanverse's real on-chain
  Validator, and its gate runs in `ValidatorGated` mode: eligibility is
  checked with a real, live on-chain call to that Validator, not the
  attestor, fail-closed to "not compliant" if that call ever reverts.
  `ComplianceRegistry` remains the tier-number source either way, since
  the Validator only ever returns a pass/fail boolean.
- A full position lifecycle, borrow, a real Cleanverse freeze,
  `complianceVerify` flipping to `false`, flag, grace, self-cure,
  liquidation spillover, resolution, has been driven through this live
  deployment end to end with real transactions, no mock data.
- The frontend is built, not a placeholder: the landing page, a lending
  app (`/lend`, borrower and lender views behind one toggle, plus real
  onboarding that provisions a real A-Pass, attests it on chain, and
  funds real testnet gas and rtUSD), a live positions registry
  (`/positions`), the single-record view (`/positions/:address`), the
  pool's compliance-risk view (`/pool`), and the technical docs (`/docs`).
  It reads Monad testnet directly via viem and runs today with
  `npm run dev`.
- The interest model is utilization-based (a two-slope curve with an
  owner-configurable kink), not flat linear interest, see `LendingPool.sol`.

**Not yet done:**

- Neither the frontend nor the backend is deployed to a public URL yet.
  The backend is built deployable as small serverless functions
  (`backend/api/`, see `backend/DEPLOY.md`) specifically so it never has
  to run on anyone's own machine to serve the app, but the actual deploy
  step hasn't happened yet. The frontend builds clean and is
  deploy-ready. This is the main remaining gap before submission.
- Liquidation is still all-or-nothing (a liquidator must repay the full
  outstanding debt), not partial.
- Cross-pool revocation propagation, native token, ZK identity, and the
  rest of `ROADMAP.md`'s "Deliberately not here" list remain explicitly out
  of scope.

The attestor is a trusted off-chain signer of facts regardless of gate
mode. That trust boundary is explicit, not hidden: a compromised attestor
key could sign false facts for any address, bounded by `CompliancePolicy`
(it cannot grant eligibility the policy itself forbids) and by a maximum
staleness window (a forged attestation stops being usable once it ages
out, forcing a fresh one). See `docs/THREAT_MODEL.md` item 9 for the full
analysis.

## Building and running

Requires [Foundry](https://book.getfoundry.sh/) (`forge`, `anvil`) and
Node.js 20+.

Copy `.env.example` to `.env` and fill in real values locally (never commit
`.env`):

```bash
cp .env.example .env
```

Contracts:

```bash
cd contracts
forge test
```

Backend:

```bash
cd backend
npm install
npm run build   # tsc --noEmit
npm test        # vitest run
```

The local end-to-end rehearsal (spins up a real `anvil` instance, deploys
the full stack, and drives real transactions through the complete lifecycle;
requires `anvil` and `forge` on `PATH`, skips automatically otherwise):

```bash
cd backend
npx vitest run test/e2e-local-rehearsal.test.ts
```

The adversarial scenario suite (same requirements, its own local deployment):

```bash
cd backend
npx vitest run test/adversarial/scenarios.test.ts
```

Building an audit report against any already-deployed pool (for example,
the address `DeployLocal.s.sol` prints after a local deployment):

```bash
cd backend
npx tsx src/audit/cli.ts --rpc-url http://127.0.0.1:8545 --pool 0xPOOL_ADDRESS \
  [--borrower 0xADDRESS] [--from-block 0] [--out ./audit-report] [--sign]
```

A dry run of the keeper's classification logic against the live Cleanverse
sandbox (reads only, requires real `CLEANVERSE_API_ID` / `CLEANVERSE_API_KEY`
in `.env`, sends no transactions):

```bash
cd backend
npm run keeper:dry-run
```

Frontend, reads real Monad testnet state directly, never needs a locally
running backend:

```bash
cd frontend
npm install
npm run dev
```

Deploying the backend as serverless functions (so onboarding works without
anyone running it locally) is documented in `backend/DEPLOY.md`.

## Repo layout

```
contracts/   Foundry project: CompliancePolicy, ComplianceRegistry,
             LendingPool, RevocationGuardian, the compliance seams, and
             the Forge test suite.
backend/     Node/TS: the Cleanverse API client, the EIP-712 attestor, the
             keeper, the event-sourced audit report builder, the real
             borrower-onboarding logic, and api/, the deployable
             serverless functions that expose it (see DEPLOY.md). Plus
             the vitest suite (unit tests, the local anvil rehearsal, and
             the adversarial scenario suite).
docs/        PROJECT.md (scope and non-goals), ARCHITECTURE.md (the
             Design A/B decision in full), THREAT_MODEL.md (the security
             analysis this repo is built against), AUDIT_REPORT.md (the
             audit report's design and event-coverage analysis).
frontend/    React + viem/wagmi. Landing page, the lending app (borrower
             and lender views, real onboarding), the positions registry,
             the single-record view, the pool risk view, and the docs
             page. Runs with npm run dev, reads Monad testnet directly.
```
