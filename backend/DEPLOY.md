# Deploying the backend

`backend/api/` is a set of small, stateless Node serverless functions.
Nobody should ever run this as a local server to serve the live app, see
docs/ARCHITECTURE.md's frontend/backend split, the standing constraint
this repo works under. Deploy it once, point the frontend at the deployed
URL, done.

## What's live today

- `POST /api/onboarding/provision`, real: generates a real Cleanverse
  A-Pass for a connected address, verifies it took, signs and submits a
  real on-chain compliance attestation, funds real testnet gas + rtUSD.
  Synchronous, responds once the whole sequence actually completes.
  Measured ~5.2-5.9s end to end against the real sandbox + real Monad
  testnet for a brand-new address (the slowest real case, a re-provision
  of an already-provisioned address is faster since it skips
  `generate_apass`'s creation path); see "Function duration" below.
  Rate-limited: 1 attempt per address per 5 minutes, 5 per caller IP per
  10 minutes, see `src/onboarding/rateLimit.ts`.
- `POST /api/onboarding/fund`, real: tops up gas + rtUSD for an address
  that already has standing. The requested `amount` is capped at 2,000
  rtUSD server-side regardless of what a caller asks for, this is a
  public, unauthenticated endpoint, the amount is untrusted input, not
  passed straight into `mint`. Rate-limited: 1 attempt per address per 2
  minutes, 5 per caller IP per 10 minutes.
- `POST /api/onboarding/fund-gas`, real: tops up testnet gas only (no
  rtUSD mint), for any connected wallet, not just ones that went through
  borrower onboarding, drawn from the separate `FAUCET_PRIVATE_KEY`
  wallet, never the deployer. Rate-limited: 1 attempt per address per 2
  minutes, 10 per caller IP per 10 minutes.
- `POST /api/positions/:address/strike`, `POST /api/positions/:address/advance`,
  `GET /api/positions/:address/last-error`: declared in
  `frontend/src/api/backendContract.ts`, not yet implemented as serverless
  functions (near-term roadmap item, see docs/ROADMAP.md).

All three live endpoints are guarded by an in-memory, per-serverless-
instance rate limiter (`src/onboarding/rateLimit.ts`), deliberately not
backed by Redis/KV, the goal is "a bored caller can't loop the faucet dry
during judging," not distributed rate limiting infrastructure. A tripped
limit returns 429 with an honest retry-time message, never a silent no-op.

## Deploy to Vercel

This repo deploys as **two separate Vercel projects** from the same
GitHub repo: one rooted at `frontend/` (a static Vite build), one rooted
at `backend/` (Node serverless functions only, no build step of its own).
They have different framework presets and build behavior, a single
project trying to serve both would need a much more complex `vercel.json`
for no real benefit, see the frontend/backend split this repo already
works under.

1. From the Vercel dashboard, "Add New Project", import this repo.
2. Set **Root Directory** to `backend`. **Framework Preset**: "Other".
   **Build Command**: leave on Vercel's default (`backend/vercel.json`,
   committed, sets `buildCommand: ""`, which takes precedence and skips
   the build step entirely; don't manually override it to anything else
   in the dashboard). **Output Directory**: leave default/blank, none is
   needed. **Install Command**: leave default (`npm install`). Vercel's
   own zero-config detection picks up `api/*.ts` as Node serverless
   functions independent of any of this; `backend/vercel.json` also sets
   each function's `maxDuration`.

   Why `buildCommand: ""` matters: `package.json`'s `build` script is
   `tsc --noEmit`, a local/CI typecheck with no output files. Left to its
   default, Vercel (Framework Preset "Other") auto-runs that script as
   the Build Command, then looks for a static Output Directory to serve
   afterward (defaulting to `public`), and fails with "No Output
   Directory named 'public' found" since a pure typecheck produces
   nothing there. This project has no static output at all, only
   serverless functions, which Vercel's `@vercel/node` builder compiles
   per-function at deploy time regardless of any repo-level build step.
   `buildCommand: ""` tells Vercel to skip the build phase (and therefore
   the output-directory check) entirely; `npm run build` still works
   fine locally/in CI, untouched.
3. Set these **Environment Variables** (Production, and Preview if you
   want PR previews to work), values from your own `.env`, never commit
   them:
   - `CLEANVERSE_API_ID`
   - `CLEANVERSE_API_KEY`
   - `CLEANVERSE_SANDBOX_URL` (`https://uatapi.cleanverse.com/api/cooperate`)
   - `MONAD_TESTNET_RPC`
   - `DEPLOYER_PRIVATE_KEY` (funds gas + mints rtUSD for `/provision` and
     `/fund`, needs a real MON balance)
   - `ATTESTOR_PRIVATE_KEY` (must already be authorized via
     `ComplianceRegistry.setAttestor`, it already is for the current
     deployment, see backend/scripts/testnet-deploy.ts's output)
   - `FAUCET_PRIVATE_KEY` (funds gas only for `/fund-gas`, a separate,
     small, replenishable wallet, never the deployer key, see
     `src/onboarding/faucetConfig.ts`)
   - `COMPLIANCE_REGISTRY_ADDRESS` (optional, defaults to the current
     deployment's registry if unset, see `src/onboarding/deployment.ts`)
4. Deploy. Vercel gives you a URL (this project's current deployment:
   `https://revoca-iota.vercel.app`).
5. Set `VITE_BACKEND_URL` to that URL, no trailing slash (e.g.
   `VITE_BACKEND_URL=https://revoca-iota.vercel.app`), on the frontend
   project (its own env config, not this package), then redeploy the
   frontend, Vite bakes `import.meta.env` values in at build time, not
   runtime. Onboarding and the fund actions light up as soon as that's
   set and redeployed, nothing else changes.

### Function duration

`backend/vercel.json` sets `maxDuration: 10` for all three onboarding
functions, matching Vercel's Hobby plan hard cap (Hobby enforces 10s
regardless of what a function requests; a higher value in `vercel.json`
can fail the deploy outright on Hobby rather than silently clamping, so
this repo is committed at the safe value). Each handler's own exported
`config = { maxDuration }` is a harmless legacy annotation kept in sync
with the same number, `vercel.json` is what Vercel actually enforces for
a plain Node function outside a framework like Next.js.

`/provision` is the only endpoint with real margin pressure: measured
~5.2-5.9s end to end against the real sandbox + real Monad testnet for a
brand-new address (three samples, this session, real infrastructure, no
mock data), after two latency optimizations (`src/onboarding/provision.ts`
skips a redundant `query_apass` re-fetch inside the attestation step, and
broadcasts the gas top-up and rtUSD mint transactions back to back instead
of waiting for one's confirmation before sending the other). That leaves
real but not huge headroom under the 10s cap once Vercel's own cold-start
and network overhead are added. `/fund` and `/fund-gas` are a single
transaction each and comfortably clear 10s. If `/provision` is ever seen
timing out in practice, the fix is to move off synchronous
request/response, e.g. a "start" call plus a poll, the original
`ProvisionResponse` shape in an earlier version of
`frontend/src/api/backendContract.ts` sketched exactly that pattern,
before this session settled on synchronous since it measured comfortably
fast enough to be worth the simpler UX. That is a real behavior change
(the frontend's onboarding flow currently expects one synchronous
response), not something to make silently, upgrading to a Pro plan is the
simpler fix if it comes up.

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
