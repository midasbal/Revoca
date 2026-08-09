# Deploying the backend

`backend/api/` is a set of small, stateless Node serverless functions.
Nobody should ever run this as a local server to serve the live app, see
docs/ARCHITECTURE.md's frontend/backend split, the standing constraint
this repo works under. Deploy it once, point the frontend at the deployed
URL, done.

## What's live today (session 1: borrower + onboarding)

- `POST /api/onboarding/provision`, real: generates a real Cleanverse
  A-Pass for a connected address, verifies it took, signs and submits a
  real on-chain compliance attestation, funds real testnet gas + rtUSD.
  Synchronous, responds once the whole sequence actually completes
  (measured ~6-10s end to end against the real sandbox + real Monad
  testnet in this session's own testing).
- `POST /api/onboarding/fund`, real: tops up gas + rtUSD for an address
  that already has standing.
- `POST /api/positions/:address/strike`, `POST /api/positions/:address/advance`,
  `GET /api/positions/:address/last-error`: declared in
  `frontend/src/api/backendContract.ts`, not yet implemented as serverless
  functions this session (the record view's strike/advance demo actions
  predate this session and are out of this session's scope, borrower +
  onboarding only, see the session's own framing).

## Deploy to Vercel

1. From the Vercel dashboard, "Add New Project", import this repo.
2. Set **Root Directory** to `backend`. Vercel auto-detects `api/*.ts` as
   Node serverless functions, no build command needed (there's no
   frontend to build here, `package.json`'s `build` script is only the
   typecheck used in CI/local verification, Vercel doesn't need to run it).
3. Set these **Environment Variables** (Production, and Preview if you
   want PR previews to work), values from your own `.env`, never commit
   them:
   - `CLEANVERSE_API_ID`
   - `CLEANVERSE_API_KEY`
   - `CLEANVERSE_SANDBOX_URL` (`https://uatapi.cleanverse.com/api/cooperate`)
   - `MONAD_TESTNET_RPC`
   - `DEPLOYER_PRIVATE_KEY` (funds gas + mints rtUSD, needs a real MON balance)
   - `ATTESTOR_PRIVATE_KEY` (must already be authorized via
     `ComplianceRegistry.setAttestor`, it already is for the current
     deployment, see backend/scripts/testnet-deploy.ts's output)
   - `COMPLIANCE_REGISTRY_ADDRESS` (optional, defaults to the current
     deployment's registry if unset, see `src/onboarding/deployment.ts`)
4. Deploy. Vercel gives you a URL like `https://revoca-backend.vercel.app`.
5. Set `VITE_BACKEND_URL=https://revoca-backend.vercel.app` wherever the
   frontend is deployed (its own env config, not this package). Onboarding
   and the record view's actions light up as soon as that's set, nothing
   else changes.

### Function duration

`api/onboarding/provision.ts` exports `config = { maxDuration: 60 }`. The
real sequence measured well under that (6-10s) in this session's testing,
but Vercel's Hobby plan caps Node function duration at 10s regardless of
what a function requests; the 60s ceiling only actually applies on a Pro
plan or higher. If onboarding times out on Hobby, either upgrade the plan
or split provisioning into a "start" call plus a poll (the original
`ProvisionResponse` shape in an earlier version of
`frontend/src/api/backendContract.ts` sketched exactly that pattern,
before this session settled on synchronous since it measured comfortably
fast enough to be worth the simpler UX).

## Verifying a deployment

```
curl -X POST https://<your-backend>/api/onboarding/provision \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x000000000000000000000000000000000000dEaD","subTier":"50"}'
```

A real response looks like the shape in
`frontend/src/api/backendContract.ts`'s `ProvisionResponse`, including a
real `attestationTxHash` and `mintTxHash`, both checkable on
`https://testnet.monadscan.com`. Don't run this against an address you
care about repeatedly without reason, it's a real sandbox mutation and a
real transaction every time.

## Testing without deploying (what this session actually did)

Every backend module here is plain TypeScript with no serverless-specific
API surface, `backend/src/onboarding/provision.ts` and `fund.ts` are
tested directly (`npx tsx scripts/testnet-onboarding-e2e.ts`), and the
`api/` handlers are thin wrappers with no logic of their own, see
`api/_http.ts`. This was verified against the real Cleanverse sandbox and
real Monad testnet this session, including a full click-through of the
actual frontend UI against a temporary local HTTP wrapper (not committed,
not for anyone to run), not just the underlying script. Results are in
this session's own report, not reproduced here since they'll go stale;
re-run the e2e script for a fresh real result.
