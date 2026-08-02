// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CollateralRatioPolicy
 * @notice On-chain, owner-configurable mirror of
 * backend/src/risk/tierRatios.ts. The collateral ratio a borrower must post
 * is POOL POLICY, not something the tier oracle (ITierOracle) or the
 * compliance gate (IComplianceGate) get to decide, both of those seams
 * only report facts (a tier, a compliance boolean); this contract is what
 * turns "tier 50, subTier 80" into "post 80% collateral."
 *
 * Band shape and reasoning are identical to tierRatios.ts (see that file's
 * header for the full data-driven justification against
 * docs/TIER_DISTRIBUTION.md's real tier distribution: tiers 0/20/50,
 * subTiers 0 through 80). See
 * contracts/test/CollateralRatioPolicyParity.t.sol, which shells out to the
 * TS module via `vm.ffi` and asserts this contract's output matches it
 * exactly for every (tier, subTier) combination observed in the real data,
 * not a hand-copied expected-value table, so the two sources of truth
 * cannot silently drift apart.
 *
 * Bands are checked most-privileged first (highest minTier, then highest
 * minSubTier within a tier); the first band a (tier, subTier) pair
 * qualifies for wins. A pair matching no band falls back to
 * SAFEST_RATIO_BPS.
 */
abstract contract CollateralRatioPolicy is Ownable {
    /// @notice 10_000 basis points = 100% collateralization.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /**
     * @notice The most conservative ratio in the table. Used for tier 0
     * (the lowest real tier observed) AND as the fallback for any
     * (tier, subTier) that matches no configured band, see
     * tierRatios.ts's SAFEST_RATIO_BPS for why these are the same value but
     * conceptually distinct cases.
     */
    uint16 public constant SAFEST_RATIO_BPS = 15_000; // 150%

    struct RatioBand {
        uint16 minTier;
        uint16 minSubTier;
        uint16 ratioBps;
    }

    RatioBand[] private _ratioBands;

    event RatioBandsSet(RatioBand[] bands);

    error EmptyRatioBands();
    error RatioBandsNotOrdered(uint256 index);
    error RatioBandsNotMonotonic(uint256 index);

    constructor() {
        RatioBand[] memory defaults = new RatioBand[](6);
        // Identical to tierRatios.ts's RATIO_BANDS, see that file for the
        // per-band reasoning against the real tier distribution.
        defaults[0] = RatioBand({minTier: 50, minSubTier: 80, ratioBps: 8_000}); // 80%
        defaults[1] = RatioBand({minTier: 50, minSubTier: 50, ratioBps: 9_000}); // 90%
        defaults[2] = RatioBand({minTier: 50, minSubTier: 20, ratioBps: 10_000}); // 100%
        defaults[3] = RatioBand({minTier: 50, minSubTier: 0, ratioBps: 11_000}); // 110%
        defaults[4] = RatioBand({minTier: 20, minSubTier: 0, ratioBps: 13_000}); // 130%
        defaults[5] = RatioBand({minTier: 0, minSubTier: 0, ratioBps: SAFEST_RATIO_BPS}); // 150%
        _setRatioBands(defaults);
    }

    /// @notice Owner-configurable: replace the entire ratio-band table.
    /// @dev Bands must be supplied strictly ordered most- to
    /// least-privileged, with non-decreasing ratioBps, mirrors
    /// tierRatios.ts's assertBandsWellFormed, enforced here on every
    /// write rather than just at construction time.
    function setRatioBands(RatioBand[] calldata bands) external onlyOwner {
        _setRatioBands(bands);
    }

    function _setRatioBands(RatioBand[] memory bands) internal {
        if (bands.length == 0) revert EmptyRatioBands();

        for (uint256 i = 1; i < bands.length; i++) {
            RatioBand memory prev = bands[i - 1];
            RatioBand memory curr = bands[i];

            bool lessOrEquallyPrivileged =
                curr.minTier < prev.minTier || (curr.minTier == prev.minTier && curr.minSubTier < prev.minSubTier);
            if (!lessOrEquallyPrivileged) revert RatioBandsNotOrdered(i);
            if (curr.ratioBps < prev.ratioBps) revert RatioBandsNotMonotonic(i);
        }

        delete _ratioBands;
        for (uint256 i = 0; i < bands.length; i++) {
            _ratioBands.push(bands[i]);
        }

        emit RatioBandsSet(bands);
    }

    /// @notice Number of configured ratio bands.
    function ratioBandCount() external view returns (uint256) {
        return _ratioBands.length;
    }

    /// @notice Returns the band at `index` (0 = most privileged).
    function ratioBandAt(uint256 index) external view returns (RatioBand memory) {
        return _ratioBands[index];
    }

    /**
     * @notice Returns the required collateral ratio, in basis points
     * (10_000 = 100%), for a borrower at the given tier/subTier.
     * @dev Pure function of on-chain state (the configured bands), takes
     * no external calls, so it cannot be a source of reentrancy or
     * unexpected gas cost from a misbehaving oracle.
     */
    function collateralRatioBps(uint16 tier, uint16 subTier) public view returns (uint16) {
        uint256 len = _ratioBands.length;
        for (uint256 i = 0; i < len; i++) {
            RatioBand memory band = _ratioBands[i];
            if (tier > band.minTier || (tier == band.minTier && subTier >= band.minSubTier)) {
                return band.ratioBps;
            }
        }
        return SAFEST_RATIO_BPS;
    }
}
