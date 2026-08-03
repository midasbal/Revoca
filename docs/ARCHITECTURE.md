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

**Open blocker.** Registering a pool with the validator, `POST
/api/cooperate/validator/register`, currently fails on Monad with API
code `0001`, "Invalid contract owner signature", for every scheme tried
so far by builders working against this validator, including from a
confirmed real on-chain owner. The exact signing scheme the API expects
is unconfirmed. Two candidates have been identified by comparing
Cleanverse's two integration documents: EIP-191 `personal_sign` of the
raw, lowercase `chain + contract_address` string (the originally
documented scheme, and what this repo currently implements in
`backend/src/cleanverse/signature.ts`), versus `personal_sign` of the
pre-hashed `keccak256(chain + contract_address)` (the more literal
reading of the newer integration guide's wording). Resolving this is the
first Design A task in the build window. Until it's resolved, the
attestor path is what actually runs, it is already built and tested, see
`contracts/src/ComplianceRegistry.sol` and `backend/src/attestor/`.

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
- **RevocationGuardian**, self-contained unwind logic. Given a position whose
  borrower has failed a compliance re-check, resolves it to a defined,
  auditable outcome (repay-from-collateral, liquidate, grace period, etc.,
  design TBD, see [docs/THREAT_MODEL.md](THREAT_MODEL.md)).
- **Backend keeper**, polls `query_apass` / `validator/verify` for open
  positions, and triggers `RevocationGuardian` when a borrower's status,
  tier, or expiration no longer satisfies the position's requirements.
- **Cleanverse client** (backend), wraps `api-id` header, AES
  encrypt/decrypt for encrypted endpoints, and owner-signature construction
  for `register`/`grant`.
- **React dashboard**, borrower view (position, collateral ratio, A-Pass
  status) and lender view (pool health, outstanding positions, unwind
  events).

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
                  └───────┬───────────────┬─────────┘
                          │               │
             (Design B)   │               │  RPC (read/write)
       signed attestation │               ▼
                          │      ┌──────────────────┐
                          └─────▶│  Monad testnet    │
                                 │  - LendingPool     │
                                 │  - RevocationGuard.│
                                 │  - Validator (if   │
                                 │    on-chain, Des. A)│
                                 └────────┬───────────┘
                                          │ read state / events
                                          ▼
                                 ┌──────────────────┐
                                 │ React dashboard   │
                                 │ (borrower/lender) │
                                 └──────────────────┘
```

## Contracts tooling

Using **Foundry** for `contracts/`. *(If this changes to Hardhat mid-build,
update this section with the reason, e.g. tooling issue with Monad testnet
RPC compatibility.)*
