// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ICountrySource
 * @notice The country-reporting seam LendingPool depends on to evaluate
 * CompliancePolicy's country eligibility rule. Kept as its OWN interface,
 * separate from ITierOracle/IComplianceGate, deliberately: adding country
 * support this session must not touch ComplianceRegistry.sol or
 * ITierOracle.sol at all, both are Phase 3 concerns (the real
 * Cleanverse-backed attestor), and this seam is explicitly a
 * seam-with-test-double for now (see TestCountrySource.sol). Cleanverse's
 * `query_apass`/`query_apass_list` already return a `countries` array per
 * A-Pass (see docs/CLEANVERSE_API.md), the real Phase 3 implementation of
 * this interface will read from there, most likely by extending
 * ComplianceRegistry's observation to also carry country data, but that
 * wiring is deliberately deferred, not decided here.
 *
 * bytes2 encodes an ISO 3166-1 ALPHA-2 code as raw ASCII bytes (e.g. "US"
 * -> 0x5553), see CompliancePolicy.sol's header for why alpha-2 (not
 * numeric) is the faithful choice, cross-checked against
 * docs/CLEANVERSE_API.md's Rule object (`countries`, documented as ISO
 * 3166-1 alpha-2). 0x0000 = unknown/unset.
 */
interface ICountrySource {
    /// @notice Returns `user`'s country as a packed ISO 3166-1 alpha-2 code. 0x0000 = unknown/unset.
    /// @dev Not a mutation, implementations must not change on-chain state here.
    function countryOf(address user) external view returns (bytes2 country);
}
