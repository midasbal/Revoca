# Roadmap

Testnet-proven, not yet production. Revoca's core loop, tier-scaled lending,
the compliance gate, the graduated unwind, is real and proven end to end on
live Monad testnet transactions (see [README.md](README.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). This is what actually stands
between that and production, grounded in the code as it exists today, not
aspiration. One honest reason per item, no padding.

This file is the public path-to-production roadmap, also rendered at
`/roadmap` in the app, and the only roadmap tracked in this repository.

## Near-term

Scoped, buildable directly against the code as it stands today.

- **Partial, proportional liquidation.** `LendingPool.liquidate()` requires
  repaying a position's full debt to unwind it at all today; a partial-repay
  path that restores health without full seizure is a direct fix to that
  documented limitation, not a new idea grafted on.
- **Compliance policies that use the facts already attested.**
  `ComplianceRegistry` already stores and can check a borrower's country and
  expiry, the deployed pool's validator-gated mode just doesn't use them
  yet; wiring those already-attested facts into live eligibility deepens
  the compliance-reactive thesis instead of stopping at pass or fail.

## Next

Larger in scope, still bounded to testnet.

- **Distinct collateral and borrow assets, real markets.** Collateral and
  the lent asset are the same token today, an explicit simplification;
  separating them, and supporting more than one market, is the natural next
  step toward pricing genuinely different assets against a verified
  standing.
- **A keeper that runs, not one you invoke.** The keeper that drives the
  unwind is proven correct in dry-run and local rehearsal, but it isn't yet
  a standing, monitored service; production-grade reactivity needs it
  running continuously, not by hand.

## Longer-term

What production, not just a working demo, actually requires.

- **More than one attestor.** `ComplianceRegistry` already supports
  multiple simultaneous authorized signers, but only one attestor process
  actually runs today; moving to a real multi-attestor or threshold model
  shrinks the single-key trust assumption `docs/THREAT_MODEL.md` names
  directly, not a hypothetical risk.
- **A hardened, audited mainnet deployment.** Every deployment so far,
  including this one, is explicit test infrastructure; real value needs a
  non-provisional deploy and an independent security audit first, the
  literal, unglamorous distance between testnet-proven and
  production-ready.

## Deliberately not here

Cross-pool revocation propagation, a native token, ZK identity, on-chain
governance. Each would scatter the compliance-reactive thesis rather than
deepen it, worth revisiting only once everything above is real.
