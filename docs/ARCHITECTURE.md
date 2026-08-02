# Architecture

## Enforcement design, Design B (attestor) is now PRIMARY

**Update, see [docs/ROADMAP.md](ROADMAP.md) for the full writeup and the
evidence behind this call.** A competitor's report of `12026` ("Validator
address not configured for chain: monad") on `/validator/grant`, plus our
own `12027` on `validator/verify`/`is_register`, both point the same way:
the on-chain Validator does not appear to be deployed on Monad in the
sandbox. Design B (backend attestor) is the primary path being built now
(Phase 2b/3a in the roadmap); Design A stays available behind the
`IComplianceGate`/`ITierOracle` seam only if Cleanverse confirms real Monad
on-chain support via the two open Telegram questions.

The two designs, for reference:

### Design A, On-chain read (preferred)

The pool contract calls the Validator contract directly, on-chain, inside a
`borrow`/`withdraw` modifier (e.g. `require(validator.verify(borrower))`).

**Preferred if** the Validator exposes an on-chain read on Monad testnet
(contract address + ABI available). Simpler trust model, no off-chain
component in the critical path, no attestor key to manage.

### Design B, Attestor (fallback)

Backend calls `validator/verify` off-chain, then authorizes the on-chain
action via a signed attestation that the pool contract verifies (e.g. EIP-712
signature from a designated attestor key, with a short expiry).

**Fallback if** no on-chain Validator read exists on Monad testnet. Introduces
an off-chain trust dependency, see
[docs/THREAT_MODEL.md](THREAT_MODEL.md) for the risks this adds.

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
