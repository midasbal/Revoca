// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICountrySource} from "../interfaces/ICountrySource.sol";

/**
 * @title TestCountrySource
 * @notice TEST ONLY. Owner-settable ICountrySource mock for unit-testing
 * CompliancePolicy's country-eligibility enforcement in LendingPool without
 * a real Cleanverse-backed country data source (not built this session,
 * see ICountrySource.sol's header).
 *
 * NEVER deploy this to any network the pool actually uses for real funds,
 * see CLAUDE.md's "no mock data for compliance" rule, which applies here
 * too since country feeds directly into whether a real borrower is allowed
 * to borrow at all.
 *
 * Defaults to 0x0000 (unknown/unset) for any address never explicitly set.
 */
contract TestCountrySource is ICountrySource {
    address public immutable owner;
    mapping(address => bytes2) private _countries;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice TEST ONLY. Sets the country reported for `user`.
    function setCountry(address user, bytes2 country) external onlyOwner {
        _countries[user] = country;
    }

    /// @inheritdoc ICountrySource
    function countryOf(address user) external view returns (bytes2 country) {
        return _countries[user];
    }
}
