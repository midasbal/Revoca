# Revoca

A tier-scaled, under-collateralized lending pool on Monad testnet, built on the
Cleanverse Validator. Its defining feature: a safe, auditable unwind of an
existing loan position when a borrower's A-Pass is frozen, expires, is
blacklisted, or drops below the pool's minimum tier mid-loan.

Built for the **Cleanverse Build: Trusted Assets Hackathon** (Aug 8–9 UTC,
2026), DeFi track.

## Why

Cleanverse's Validator already answers "is this address eligible right now"
at entry (`validator/verify`), and A-Token transfers are gated on A-Pass
status. Nobody handles what happens to an **existing** position when
eligibility flips mid-loan, `verify` starts returning false and the loan,
collateral, and accrued interest are just stuck. Revoca is that missing exit,
and it uses A-Pass tier as a live risk parameter (higher tier → lower
collateral requirement).

See [docs/PROJECT.md](docs/PROJECT.md) for full scope and non-goals.

## Repo layout

```
contracts/   Foundry project, LendingPool, RevocationGuardian
backend/     Node/TS keeper + Cleanverse API client
frontend/    React dashboard (borrower + lender views)
docs/        Project docs, read CLAUDE.md first
```

## Start here

1. [CLAUDE.md](CLAUDE.md), hard constraints (testnet-only, no mock
   compliance data, secrets handling). Read before touching anything.
2. [docs/ROADMAP.md](docs/ROADMAP.md), the single source of truth for the
   plan: what's done, in progress, buildable now, and blocked on the Aug
   8–9 window, plus the Design A/B decision.
3. [docs/PROJECT.md](docs/PROJECT.md), what we're building and why.
4. [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md), the day-one spike
   results (run during prep, see ROADMAP.md on commit timing).

## Setup

Copy `.env.example` to `.env` and fill in real values locally (never commit
`.env`):

```bash
cp .env.example .env
```
