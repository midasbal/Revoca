# backend

Node/TS: the Cleanverse API client, the EIP-712 attestor, the compliance
keeper, the audit-trail exporter, and the deployable API (`api/`) the
frontend calls for anything that needs a secret.

Nothing here runs as a process anyone starts locally to serve the app, see
docs/ARCHITECTURE.md's frontend/backend split. `api/` is a set of small,
stateless serverless functions, meant to be deployed (Vercel today, see
DEPLOY.md), and `src/` is the shared logic they (and the scripts, and the
tests) all import from.

## Layout

- `src/cleanverse/`, the Cleanverse UAT sandbox API client.
- `src/attestor/`, signs and relays real EIP-712 compliance attestations.
- `src/keeper/`, polls A-Pass status for open positions.
- `src/onboarding/`, real borrower onboarding: provisions a real A-Pass,
  attests it on chain, funds testnet gas + rtUSD. See DEPLOY.md.
- `src/audit/`, reconstructs a position's full lifecycle from on-chain events.
- `src/risk/`, the tier-to-collateral-ratio table.
- `api/`, the deployable serverless functions, thin HTTP wrappers around
  `src/onboarding/` (and, in a future session, the positions actions).
- `scripts/`, one-off real-sandbox/real-testnet scripts (deploys,
  generators, the onboarding end-to-end test). Every script here does real
  things against real infrastructure, not a mock harness.

## Local commands (for building/testing THIS package, never for serving the app)

```
npm run build   # tsc --noEmit
npm test        # vitest
npm run tier-distribution / probe / keeper:dry-run / audit  # see scripts/
npx tsx scripts/testnet-onboarding-e2e.ts  # real onboarding end-to-end check
```

See [DEPLOY.md](DEPLOY.md) for deploying `api/` so the app works without
anyone's machine running anything.
