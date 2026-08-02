// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IComplianceGate
 * @notice The compliance seam LendingPool depends on. Deliberately minimal
 * and deliberately deferred: we don't yet know whether Cleanverse's
 * Validator exposes an on-chain read on Monad testnet (see
 * docs/OPEN_QUESTIONS.md item 2), so LendingPool is written against this
 * interface and the concrete implementation is decided later without
 * touching pool code.
 *
 * Two candidate implementations (see docs/ARCHITECTURE.md for the full
 * writeup):
 *
 *   Design A, OnChainValidatorGate (preferred, if it exists):
 *     `isCompliant` calls the Cleanverse Validator contract directly
 *     on-chain (e.g. a view function equivalent to `validator/verify`),
 *     synchronously, in the same transaction as the pool action. No
 *     off-chain trust dependency. Requires Cleanverse to publish a
 *     Validator contract address + ABI for Monad testnet.
 *
 *   Design B, AttestorComplianceGate (fallback):
 *     A backend keeper calls `validator/verify` off-chain and submits a
 *     signed, time-boxed attestation that this contract verifies (e.g.
 *     EIP-712 signature from a designated attestor key) before recording
 *     `isCompliant` as true for a short window. Introduces an off-chain
 *     trust dependency, see docs/THREAT_MODEL.md item 7 (attestor trust)
 *     before implementing this path.
 *
 * `isCompliant` is a `view` function in both designs, Design A calls the
 * Validator's own view function; Design B reads a previously-recorded
 * attestation from storage rather than doing any off-chain work inline.
 * LendingPool must not assume anything about *how* the answer was produced,
 * only that a `true` result means "eligible right now" and that staleness
 * risk (see docs/THREAT_MODEL.md item 1, poll-latency race) is the
 * implementation's problem to manage, not the caller's.
 */
interface IComplianceGate {
    /// @notice Returns true if `user` currently satisfies this pool's compliance rules.
    /// @dev Not a mutation, implementations must not change on-chain state here.
    function isCompliant(address user) external view returns (bool);
}
