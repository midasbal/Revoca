# Revoca frontend

The borrower-facing "record" view: a single live lending position read
directly from the deployed Monad testnet contracts, shown as a standing
record that can be struck when a freeze lands and watched unwind in real
time.

This is pass 1: one view (the money-shot), not the full dashboard.

## Run it

Two processes, both local only.

1. Demo action server (needs the repo root `.env`, never touches the browser):

```bash
cd backend
npx tsx src/server/demoServer.ts
```

2. Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`). Every value on
the page is a live read against Monad testnet, no mock data. "Strike this
record" and "Advance/Complete the unwind" call the local demo server, which
holds the secrets (Cleanverse API key, attestor and deployer keys) and
performs real transactions; the frontend itself never sees them.

## Stack

React + TypeScript + Vite, viem for direct chain reads (no wallet connect,
this view is read plus server-triggered actions), Framer Motion for the
struck transition, hand-written CSS with no component library.
