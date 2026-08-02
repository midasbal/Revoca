// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITierOracle} from "../interfaces/ITierOracle.sol";

/**
 * @title TestTierOracle
 * @notice TEST ONLY. Owner-settable ITierOracle mock for unit-testing
 * LendingPool's tier-derived collateral-ratio logic in isolation from the
 * real attestor (not built this session, see ITierOracle's header).
 *
 * NEVER deploy this to any network the pool actually uses for real funds,
 * see CLAUDE.md's "no mock data for compliance" rule, which applies here
 * too since tier feeds directly into how much collateral a real borrower
 * would be required to post.
 *
 * Defaults to (0, 0) for any address never explicitly set, the safest
 * (lowest-tier) assumption, consistent with backend/src/risk/tierRatios.ts
 * treating unknown tier as the most conservative case.
 */
contract TestTierOracle is ITierOracle {
    address public immutable owner;

    struct Tier {
        uint16 tier;
        uint16 subTier;
    }

    mapping(address => Tier) private _tiers;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice TEST ONLY. Sets the (tier, subTier) reported for `user`.
    function setTier(address user, uint16 tier, uint16 subTier) external onlyOwner {
        _tiers[user] = Tier(tier, subTier);
    }

    /// @inheritdoc ITierOracle
    function tierOf(address user) external view returns (uint16 tier, uint16 subTier) {
        Tier storage t = _tiers[user];
        return (t.tier, t.subTier);
    }
}
