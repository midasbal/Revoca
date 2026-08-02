# Revoca

Compliance-reactive, under-collateralized lending on Cleanverse. A borrower's
A-Pass tier sets their collateral ratio, and if their eligibility changes
mid-loan (frozen, expired, or a tier drop) an on-chain state machine drives
their position through a safe, auditable unwind: self-cure from their own
collateral first, a grace period before anything drastic happens, permissionless
liquidation only if self-cure isn't enough, and full reinstatement if
compliance is restored in time.

Chain: Monad testnet, via the Cleanverse UAT sandbox. Track: DeFi (Compliant
DeFi), built for the Cleanverse Build hackathon.

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

Cleanverse's on-chain Validator does not appear to be deployed on Monad in
the UAT sandbox: `validator/verify` and `validator/is_register` both return
error code `12027` ("Validator on-chain read failed") against Monad,
regardless of the address tested, and a separate report from another team
building on the sandbox found `validator/grant` returning `12026`
("apass compliance validator address not configured for chain: monad") for
both Monad and Ethereum. Two independent signals pointing the same way is
real, not conclusive, but it's why Revoca is built primary against an
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
`ComplianceRegistry` implements all three. If Cleanverse ever confirms a real
on-chain Validator on a given chain, an on-chain-read implementation of the
same interfaces would slot in without touching pool or guardian code at all.
That swap has not been built; the seam for it has.

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
                              | implemented but not yet exercised live
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
   |                Monad testnet (local anvil today)          |
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

Verified locally before writing this document: `forge test` passes 129 tests
across 8 suites in `contracts/`, and the backend's `vitest` suite passes 86
tests with 1 intentionally skipped (it needs a genuine encrypted response
from the live Cleanverse sandbox to validate the AES round-trip against real
data, not just the documented spec).

**Contracts** (`contracts/src/`):
- `LendingPool.sol`, deposit, borrow, repay, withdraw, liquidate, tier-scaled
  collateral ratios, simple linear interest, Pausable, ReentrancyGuard,
  SafeERC20, custom errors throughout.
- `RevocationGuardian.sol`, the unwind state machine described above.
- `ComplianceRegistry.sol`, the EIP-712 attestation store and verifier.
- `CompliancePolicy.sol`, the single, owner-configurable, event-logged home
  for every eligibility and risk parameter the rest of the system reads.
- `IComplianceGate` / `ITierOracle` / `ICountrySource`, the seams described
  above.

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

Everything described above is proven against a real local `anvil` chain, and
read-only calls (`query_apass`, `validator/verify`, and others) have been
exercised against the real Cleanverse UAT sandbox. The following has not
been done yet:

- No deployment to the real Monad testnet.
- No live encrypted write call (`generate_apass`, `update_status`,
  `validator/register`, `validator/grant`, `validator/set_rule`, and
  related endpoints) has been made against the sandbox. They're implemented
  per the documented API spec, but our sandbox account's role and
  permissions for them are unconfirmed, and this project's rule against
  mock compliance data means they stay untested rather than faked.
- The frontend does not exist yet, `frontend/` is a placeholder.
- On-chain enforcement via a real Cleanverse Validator contract (Design A)
  is not built. As explained above, the seam for it (`IComplianceGate` /
  `ITierOracle` / `ICountrySource`) already exists and would not require
  touching `LendingPool` or `RevocationGuardian`.
- The interest model is simple linear interest, not utilization-based.
  Liquidation is all-or-nothing (a liquidator must repay the full
  outstanding debt), not partial.

The attestor is a trusted off-chain signer of facts. That trust boundary is
explicit, not hidden: a compromised attestor key could sign false facts for
any address, bounded by `CompliancePolicy` (it cannot grant eligibility the
policy itself forbids) and by a maximum staleness window (a forged
attestation stops being usable once it ages out, forcing a fresh one). This
is the accepted tradeoff of Design B, adopted because no on-chain Validator
appears reachable on Monad in the sandbox today; it is not presented as
equivalent to a direct on-chain read, and Design A remains a drop-in
replacement behind the same interfaces if that ever changes.

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

## Repo layout

```
contracts/   Foundry project: CompliancePolicy, ComplianceRegistry,
             LendingPool, RevocationGuardian, the compliance seams, and
             the Forge test suite.
backend/     Node/TS: the Cleanverse API client, the EIP-712 attestor, the
             keeper, the event-sourced audit report builder, and the
             vitest suite (unit tests, the local anvil rehearsal, and the
             adversarial scenario suite).
docs/        PROJECT.md (scope and non-goals), ARCHITECTURE.md (the
             Design A/B decision in full), THREAT_MODEL.md (the security
             analysis this repo is built against), AUDIT_REPORT.md (the
             audit report's design and event-coverage analysis).
frontend/    Not yet built.
```
