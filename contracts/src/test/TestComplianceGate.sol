// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IComplianceGate} from "../interfaces/IComplianceGate.sol";

/**
 * @title TestComplianceGate
 * @notice TEST ONLY. Owner-toggleable IComplianceGate mock for unit-testing
 * LendingPool/RevocationGuardian mechanics (deposit/borrow/repay/unwind
 * logic) in isolation from the real compliance seam.
 *
 * NEVER deploy this to any network the pool actually uses for real funds,
 * and NEVER wire it up as a pool's live compliance gate, see CLAUDE.md's
 * "no mock data for compliance" rule. It exists purely so pool-mechanics
 * tests don't need a live Cleanverse call or a real Design A/B
 * implementation to run.
 *
 * Default result for an address that was never explicitly set is `false`
 * (fail closed), matching the safest assumption before compliance is
 * proven, tests must opt an address into compliance explicitly.
 *
 * Freshness defaults to `true` (fresh) for every address, unlike compliance
 *, this preserves the behavior of every existing LendingPool test written
 * before staleness gating existed, none of which exercise staleness, so
 * none of them needed to change. Tests that DO want to exercise staleness
 * call `setStale` explicitly.
 */
contract TestComplianceGate is IComplianceGate {
    address public immutable owner;
    mapping(address => bool) private _compliant;
    mapping(address => bool) private _stale;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice TEST ONLY. Sets whether `user` should be treated as compliant.
    function setCompliant(address user, bool compliant) external onlyOwner {
        _compliant[user] = compliant;
    }

    /// @notice TEST ONLY. Sets compliance for multiple addresses in one call.
    function setCompliantBatch(address[] calldata users, bool compliant) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            _compliant[users[i]] = compliant;
        }
    }

    /// @notice TEST ONLY. Sets whether `user`'s compliance signal should be treated as stale.
    function setStale(address user, bool stale) external onlyOwner {
        _stale[user] = stale;
    }

    /// @inheritdoc IComplianceGate
    function isCompliant(address user) external view returns (bool) {
        return _compliant[user];
    }

    /// @inheritdoc IComplianceGate
    function isFresh(address user) external view returns (bool) {
        return !_stale[user];
    }
}
