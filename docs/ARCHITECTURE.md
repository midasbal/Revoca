# Architecture

## Enforcement design, the hybrid: Design A as the gate, the attestor as the tier source

**Update.** An earlier finding here said the on-chain CVI Compliance
Validator did not appear deployed on Monad, based on a competitor's
report of API error `12026` on `/validator/grant` and our own `12027` on
`validator/verify`/`is_register`. That conclusion no longer holds. A
read-only on-chain probe (no private key, no transaction) against the
documented validator address, `0xaC7e5179C2C7f03f209136886c172eb34F161792`,
on the real Monad testnet RPC (chain ID `10143`) found:

- Real bytecode present at that address on Monad testnet, the contract
  genuinely exists there.
- `isRegistered(address)` returns a clean boolean, `false` for two
  candidate addresses tried, no revert.
- `complianceVerify(poolAddress, userAddress)` reverts for an unregistered
  pool, but with a decoded custom error, `PoolNotRegistered()` (confirmed
  by matching the reverted 4-byte selector against a locally computed
  `keccak256` of that exact signature), not a generic failure and not an
  absent contract.

Taken together, this means the validator is live and functioning on
Monad. The earlier `12026`/`12027` errors reflected the Cleanverse API's
own on-chain read path, not the validator contract itself being missing.
Nothing here has been deployed to Monad by us, this is a set of read-only
calls against Cleanverse's existing deployment; the earlier
attestor-only conclusion is superseded, and the architecture is a
**hybrid**, not an either/or:

- **Design A, on-chain gate.** `validator.complianceVerify(pool, user)`
  is intended as the live, synchronous `IComplianceGate.isCompliant`
  read wherever a pool is registered with the validator. No off-chain
  trust dependency for that specific check.
- **Design B, attestor.** The backend attestor remains required
  permanently, not as a stopgap, for two reasons. First, it is the
  **only** source of a borrower's actual tier number: `complianceVerify`
  returns a single pass/fail boolean, confirmed from Cleanverse's CCP
  integration guide's interface, never a tier value, and the on-chain
  rule a pool registers (`RuleV2`, a `minTier`/`minSubTier` threshold)
  is a pool-side configuration, not a per-user reading. Revoca's
  tier-as-risk-parameter design needs the number itself, which only
  `query_apass` (via the attestor) provides. Second, it serves as the
  **gate fallback**: where a pool is unregistered with the validator, or
  the on-chain read is otherwise unreachable, `ComplianceRegistry`'s
  attestor-derived `isCompliant` is what's actually enforced.

Both live behind the existing `IComplianceGate`/`ITierOracle` seam
(`contracts/src/interfaces/`), exactly as designed, adopting the on-chain
gate requires no changes to `LendingPool` or `RevocationGuardian`.

**Resolved, and built: `contracts/src/HybridComplianceGate.sol`.** The
registration signature blocker described below is resolved (see
docs/OPEN_QUESTIONS.md), and Design A is proven live on Monad testnet with
real transactions (see docs/DESIGN_A_SPIKE.md, gitignored, local). The
real hybrid `IComplianceGate` is now implemented: `HybridComplianceGate`
wraps a pool's gate mode as an EXPLICIT, owner-set configuration,
`ValidatorGated` (calls `validator.complianceVerify(pool, user)` directly,
on-chain, fails closed to `false` if that call reverts for any reason) or
`AttestorGated` (delegates to `ComplianceRegistry`). The mode is a
configuration decision made at setup, never inferred from a revert at call
time, doing so would let any cause of a validator failure silently
downgrade a `ValidatorGated` pool to the weaker attestor check. Tier
values still come from `ComplianceRegistry`'s `ITierOracle.tierOf`
always, independent of gate mode, since `complianceVerify` only ever
returns a pass/fail boolean. Covered by
`contracts/test/HybridComplianceGate.t.sol` (mock validator: true, false,
and revert-fails-closed) and
`contracts/test/HybridComplianceGateMonadFork.t.sol` (real integration
test against the real validator on live Monad testnet, using the
already-registered probe pool from docs/DESIGN_A_SPIKE.md, no mock data).
The real `LendingPool` has since been registered with the validator too
(real `validator/grant` + `validator/register`, real testnet deployment,
see docs/DESIGN_A_SPIKE.md's window-session findings), and a full real
position lifecycle, borrow, a real Cleanverse freeze, `complianceVerify`
flipping to `false`, flag, grace, self-cure, liquidation spillover,
resolution, has been driven through it end to end, all real transactions,
no mock data. That deployment remains PROVISIONAL (see ROADMAP.md for
what's still ahead of a hardened, non-provisional deploy), not the final
registered production deployment.

**A documented boundary divergence, worth knowing before ever setting a
real on-chain rule.** The CCP integration guide phrases the validator's
`RuleV2`/Rule-object `min_tier`/`min_sub_tier` fields as "a user is
allowed if the user's A-Pass tier/subTier is greater than this value"
(strictly greater), while `CompliancePolicy.isTierEligible` treats an
exact `tier == minTier` match together with `subTier >= minSubTier` as
eligible too, an inclusive boundary. This is irrelevant today, our
registered on-chain rule is `(min_tier: 0, min_sub_tier: 0)`, "no
restriction," so the boundary never gets exercised, but it's a real,
known divergence to account for if a non-zero on-chain rule is ever
configured to mirror `CompliancePolicy`'s own thresholds exactly.

**Formerly an open blocker, now resolved.** Registering a pool with the
validator, `POST /api/cooperate/validator/register`, had failed on Monad
with API code `0001`, "Invalid contract owner signature", for every
scheme tried so far by builders working against this validator, including
from a confirmed real on-chain owner. The exact signing scheme the API
expects was unconfirmed. Two candidates had been identified by comparing
Cleanverse's two integration documents: EIP-191 `personal_sign` of the
raw, lowercase `chain + contract_address` string (the originally
documented scheme, and what `backend/src/cleanverse/signature.ts`
implements), versus `personal_sign` of the pre-hashed
`keccak256(chain + contract_address)` (the more literal reading of the
newer integration guide's wording). A Cleanverse team member confirmed
the raw-string scheme is correct (see docs/OPEN_QUESTIONS.md), and this
session proved it end to end with a real `validator/grant` and
`validator/register` against Monad testnet (see docs/DESIGN_A_SPIKE.md
section 5). The attestor path (`contracts/src/ComplianceRegistry.sol`,
`backend/src/attestor/`) remains permanently required as the tier-value
source regardless.

**Chain scope.** Cleanverse deploys the validator at the same address on
every chain, so once the registration signature is resolved, this
architecture is chain-agnostic behind the seam and Monad is a
representative target, not a special case. There is no plan to deploy to
Base or any other chain as a workaround for Monad-specific validator
availability, that rationale no longer applies now that the validator is
confirmed live on Monad. A separate Base deployment could only ever be
useful as a diagnostic if Monad's registration problem ever turned out to
be chain-specific rather than a signature-scheme issue, and there's no
evidence of that today.

The two designs, for reference:

### Design A, On-chain read

The pool contract calls the Validator contract directly, on-chain, inside a
`borrow`/`withdraw` modifier (e.g. `require(validator.complianceVerify(pool, borrower))`).
Confirmed live and responding on Monad testnet (see above); blocked on
resolving the pool registration signature scheme, not on validator
availability. Simpler trust model for the gate check itself, no off-chain
component in that critical path, but still requires the attestor for tier
(see above).

### Design B, Attestor

Backend reads `query_apass` off-chain, then authorizes the on-chain
action via a signed EIP-712 attestation that the pool contract verifies
(a designated attestor key, replay and domain protected, freshness
bounded). Already built and tested (`contracts/src/ComplianceRegistry.sol`,
`backend/src/attestor/`), and permanently required as the tier-value
source regardless of Design A's registration status (see above). See
[docs/THREAT_MODEL.md](THREAT_MODEL.md) for the off-chain trust dependency
this introduces and its bounds.

## Pieces (regardless of A vs B)

- **LendingPool**, deposit / borrow / repay / liquidate, tier-scaled
  collateral ratios (fixed lookup table, not dynamic).
- **RevocationGuardian**, self-contained unwind logic, built and tested, see
  [docs/THREAT_MODEL.md](THREAT_MODEL.md) for the security analysis it's
  built against: `HEALTHY -> FLAGGED -> UNWINDING -> RESOLVED`, self-cure
  from the borrower's own collateral before any liquidator is ever
  involved, a grace window with full reinstatement, and residual
  collateral always returned once debt clears, even to a still-non-compliant
  borrower.
- **Backend keeper**, polls `query_apass` / `validator/verify` for open
  positions, and triggers `RevocationGuardian` when a borrower's status,
  tier, or expiration no longer satisfies the position's requirements.
- **Cleanverse client** (backend), wraps `api-id` header, AES
  encrypt/decrypt for encrypted endpoints, and owner-signature construction
  for `register`/`grant`.
- **React frontend** (`frontend/`, built): the landing page; a lending app
  at `/lend` with a borrower view (live standing, tier-scaled collateral
  ratio, post/borrow/repay/withdraw) and a lender view (deposit/withdraw,
  live pool utilization) behind one toggle, plus real onboarding for a
  wallet with no A-Pass; a live positions registry (`/positions`); the
  single-record view (`/positions/:address`); the pool's compliance-risk
  view (`/pool`); and the technical docs (`/docs`). Reads Monad testnet
  directly via viem; the backend is only in the path for the one action
  that needs a secret (onboarding's provisioning call).

## Data flow (text diagram)

```
                        ┌─────────────────────┐
                        │   Cleanverse UAT     │
                        │  (query_apass,       │
                        │   validator/verify)   │
                        └──────────┬───────────┘
                                   │ plain JSON (reads)
                                   │ AES-encrypted (writes: register/grant/rules)
                                   ▼
                  ┌────────────────────────────────┐
                  │   Backend (Node/TS)             │
                  │   - Cleanverse client            │
                  │   - Keeper (polls open positions)│
                  │   - Onboarding (deployable api/) │
                  └───────┬───────────────┬─────────┘
                          │               │
             (Design B)   │               │  RPC (read/write)
       signed attestation │               ▼
                          │      ┌──────────────────┐
                          └─────▶│  Monad testnet    │
                                 │  - LendingPool     │
                                 │  - RevocationGuard.│
                                 │  - HybridComplianceGate,│
                                 │    ValidatorGated,  │
                                 │    real Validator   │
                                 └────────┬───────────┘
                                          │ read state / events
                                          ▼
                                 ┌──────────────────┐
                                 │ React frontend    │
                                 │ (borrower/lender/  │
                                 │  registry/pool/docs)│
                                 └──────────────────┘
```

## Contracts tooling

Using **Foundry** for `contracts/`. *(If this changes to Hardhat mid-build,
update this section with the reason, e.g. tooling issue with Monad testnet
RPC compatibility.)*

## Frontend / backend split (standing constraint)

The frontend (`frontend/`) is fully runnable with `npm run dev` and never
depends on a locally-run backend process. It reads live testnet state
directly via viem wherever a read doesn't need a secret (positions,
guardian state, tier, ledger events, block height). Anything that needs a
secret (the Cleanverse API key, the attestor key, the deployer key, the
per-action calls typed in `frontend/src/api/backendContract.ts`, real
onboarding/provisioning today, freezing and driving an unwind planned)
goes through a backend built to be deployed as small, stateless,
serverless-friendly functions (`backend/api/`, each request carries the
address it acts on rather than relying on server session state), never a
process anyone runs on their own machine. Onboarding's provisioning
endpoint is implemented and tested against the real sandbox and real
Monad testnet (see `backend/DEPLOY.md` for deploying it); it has not yet
been deployed to a public URL. The now-removed
`backend/src/server/demoServer.ts` was a local-only stand-in for an
earlier single-record demo pass; its replacement is the deployed
backend, not another local server.
