# contracts

Foundry project (see docs/ARCHITECTURE.md if this becomes Hardhat instead).

## Layout

- `src/interfaces/IComplianceGate.sol`, the compliance seam `LendingPool`
  depends on. Defers Design A (on-chain Validator read) vs Design B
  (attestor), see docs/ARCHITECTURE.md and docs/OPEN_QUESTIONS.md item 2.
- `src/interfaces/ITierOracle.sol`, the tier-reporting seam `LendingPool`
  depends on for collateral-ratio purposes. Real implementation is a
  backend attestor reading `query_apass` per-address (not built yet, see
  the interface's header and docs/OPEN_QUESTIONS.md item 7).
- `src/CollateralRatioPolicy.sol`, on-chain, owner-configurable mirror of
  `backend/src/risk/tierRatios.ts`. Parity between the two is enforced by
  `test/CollateralRatioPolicyParity.t.sol`, which shells out to the real TS
  module via `vm.ffi` rather than a hand-copied expected-value table.
- `src/LendingPool.sol`, the core pool: deposit/withdraw (lenders),
  postCollateral/borrow/repay/withdrawCollateral/liquidate (borrowers). See
  the contract's header for documented simplifications (same-asset
  collateral, interest realized at repayment not continuously, full-only
  liquidation).
- `src/test/TestComplianceGate.sol`, `src/test/TestTierOracle.sol`,
  `src/test/MockERC20.sol`, **TEST ONLY** doubles for unit-testing pool
  mechanics before the real gate/oracle/asset are wired in. Never used for
  real compliance decisions.
- `test/`, Forge tests.

Planned next session (once Design A vs B is locked): `RevocationGuardian`
(compliance-triggered unwind), then wiring the real `IComplianceGate` and
`ITierOracle` implementations.

## Setup

`lib/` (forge-std, openzeppelin-contracts) is gitignored, a fresh clone
needs to fetch both once:

```shell
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
```

The `CollateralRatioPolicyParity` test requires `ffi = true` (already set in
foundry.toml) and a working `tsx` install in `backend/` (`npm install` there
first if it fails with a "No such file or directory").

## Commands

```shell
forge build
forge test
```
