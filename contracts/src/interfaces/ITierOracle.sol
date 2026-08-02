// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ITierOracle
 * @notice The tier-reporting seam LendingPool depends on to look up a
 * borrower's A-Pass tier/subTier for collateral-ratio purposes. Kept
 * separate from IComplianceGate deliberately: `validator/verify` (the
 * on-chain-adjacent compliance check both Design A and B are built on)
 * returns only a boolean `valid`, it does not return `tier`/`subTier` at
 * all (see docs/CLEANVERSE_API.md's validator/verify section). Tier data
 * only exists in `query_apass`/`query_apass_list`, which are plain
 * off-chain REST reads with no on-chain equivalent documented anywhere in
 * docs/cleanverse.pdf.
 *
 * Real implementation (NOT built this session): a backend attestor reads
 * `query_apass` for a specific address, singular, not `query_apass_list`;
 * see docs/OPEN_QUESTIONS.md item 7, which found `query_apass_list`'s
 * tier/subTier can be stale relative to the singular per-address lookup,
 * and reports the result on-chain via a signed attestation (mirroring the
 * attestor shape considered for Design B's compliance gate, see
 * docs/ARCHITECTURE.md and docs/THREAT_MODEL.md item 7 on attestor trust,
 * which applies equally here). Whether that attestation is pushed
 * (attestor submits a tx) or pulled (pool verifies a signature passed in by
 * the caller) is an implementation decision for that later session, not
 * fixed by this interface.
 *
 * uint16 is sized generously above the observed real range (tiers 0/20/50,
 * subTiers 0-80 per docs/TIER_DISTRIBUTION.md) and the documented 0-99
 * scale for `min_tier`/`min_sub_tier` in the Validator Compliance Rule
 * object, plenty of headroom without inviting a wraparound bug.
 */
interface ITierOracle {
    /// @notice Returns `user`'s current A-Pass tier and subTier.
    /// @dev Not a mutation, implementations must not change on-chain state here.
    function tierOf(address user) external view returns (uint16 tier, uint16 subTier);
}
