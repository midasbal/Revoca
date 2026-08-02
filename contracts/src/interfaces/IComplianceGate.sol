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
 *     A backend attestor calls `validator/verify`/`query_apass` off-chain
 *     and signs a time-boxed attestation (EIP-712, from a designated
 *     attestor key) that this contract verifies before recording
 *     `isCompliant` as true for a short window. Introduces an off-chain
 *     trust dependency, see docs/THREAT_MODEL.md item 9 (attestor trust)
 *     before implementing this path.
 *
 * `isCompliant` is a `view` function in both designs, Design A calls the
 * Validator's own view function; Design B reads a previously-recorded
 * attestation from storage rather than doing any off-chain work inline.
 * LendingPool must not assume anything about *how* the answer was produced,
 * only that a `true` result means "eligible right now."
 *
 * `isFresh` makes the staleness risk from docs/THREAT_MODEL.md item 1
 * (poll-latency race) an EXPLICIT, on-chain-enforced fact rather than an
 * assumption. Design A (a synchronous on-chain read, same transaction) has
 * no staleness at all, its `isFresh` can trivially always return `true`.
 * Design B / ComplianceRegistry (an attestor-attested cache) is only as fresh
 * as its last observation, bounded by a configurable max-staleness window.
 * Callers that gate risk-INCREASING actions (e.g. LendingPool.borrow) MUST
 * check `isFresh` in addition to `isCompliant`, a `true` compliance result
 * from data of unknown age is not the same as knowing the user is
 * compliant NOW. Risk-DECREASING actions (repay, liquidation, the
 * guardian's unwind) must never gate on this at all.
 */
interface IComplianceGate {
    /// @notice Returns true if `user` currently satisfies this pool's compliance rules.
    /// @dev Not a mutation, implementations must not change on-chain state here.
    function isCompliant(address user) external view returns (bool);

    /// @notice Returns true if the compliance signal for `user` is within the allowed staleness window.
    /// @dev Not a mutation. A `false` result means "don't trust isCompliant's
    /// current value for a risk-increasing decision", it says nothing about
    /// whether the underlying (possibly stale) result was true or false.
    function isFresh(address user) external view returns (bool);
}
