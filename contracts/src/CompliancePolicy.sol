// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CompliancePolicy
 * @notice The single, first-class, owner-configurable, event-logged home
 * for every parameter that decides "is this borrower eligible, and how much
 * risk do we take on them", replacing what used to be scattered across
 * LendingPool (ratio bands, borrow caps), RevocationGuardian (grace
 * duration), and ComplianceRegistry (staleness tolerance).
 *
 * MOTIVATION: before this contract, "what is this pool's compliance
 * policy?" wasn't answerable as one query, and "what changed, and when?"
 * wasn't reconstructable as one event stream, each parameter lived on a
 * different contract with its own setter and event (or none). This
 * contract fixes both: `getPolicy()` snapshots the whole scalar policy in
 * one call, and every setter emits a specific, named event, so
 * docs/ROADMAP.md's Phase 2c audit-trail export can reconstruct "the
 * pool's policy at block N and every change since" purely from logs.
 *
 * MIRRORS CLEANVERSE'S OWN RULE SHAPE: the eligibility fields
 * (`minTier`/`minSubTier`/`allowedGroup`/`allowedSubGroup`/country rule)
 * are deliberately shaped like the Validator Compliance Rule object
 * Cleanverse's own API uses (see docs/CLEANVERSE_API.md's Rule object
 * section), `min_tier`/`min_sub_tier` (0 = no restriction),
 * `allowed_group`/`allowed_sub_group` (empty = no restriction), and
 * `countries` + `is_black_list` (empty + not-blacklist = no restriction).
 * Our on-chain policy is meant to be a faithful local mirror of that
 * shape, not a reinvention of it.
 *
 * ONE DELIBERATE DEVIATION FROM THE BUILD BRIEF THIS WAS WRITTEN FROM: the
 * brief that requested this contract described the country set as "ISO-3166
 * NUMERIC country codes." Cross-checked against docs/CLEANVERSE_API.md (and
 * docs/cleanverse.pdf), Cleanverse's actual Rule object uses ISO 3166-1
 * ALPHA-2 codes (2-letter strings like "US", "DE"), not the numeric standard
 * (e.g. 840 for the US). Mirroring "numeric" here would silently invent a
 * field format Cleanverse doesn't use, exactly what CLAUDE.md's "API is a
 * source of truth, not something to invent" rule exists to prevent. This
 * contract uses `bytes2` (the raw ASCII bytes of the 2-letter alpha-2 code,
 * e.g. "US" -> 0x5553) instead, faithful to the real API.
 *
 * SCOPE NOTE, allowedGroup/allowedSubGroup are STORED but NOT YET
 * ENFORCED: they exist here for structural parity with Cleanverse's Rule
 * object and for `getPolicy()` completeness, but no data seam exists yet to
 * supply a borrower's actual group/subGroup (unlike tier/subTier via
 * ITierOracle, or country via the new ICountrySource below), building that
 * seam wasn't asked for this session. Enforcing them is future work once a
 * group-data source exists.
 *
 * PER-TIER BORROW CAPS AND THE COUNTRY SET ARE NOT PART OF `getPolicy()`'s
 * RETURNED STRUCT: Solidity mappings cannot be struct members returned from
 * an external call. `getPolicy()` returns every SCALAR/array policy value;
 * per-tier caps are queried via `tierBorrowCap(tier)`, and the country set
 * is returned via `getPolicy()`'s `countries` array field (a dynamic array
 * CAN be a struct member, unlike a mapping).
 */
contract CompliancePolicy is Ownable {
    // ---------------------------------------------------------------------
    // Shared constants
    // ---------------------------------------------------------------------

    /// @notice 10_000 basis points = 100% collateralization. A units convention, not a configurable policy value, see LendingPool.sol's identical constant for why it's intentionally duplicated rather than cross-referenced.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The most conservative ratio in the table, see RATIO_BANDS's header comment below for the full reasoning (migrated verbatim from the former CollateralRatioPolicy.sol).
    uint16 public constant SAFEST_RATIO_BPS = 15_000; // 150%

    // ---------------------------------------------------------------------
    // Eligibility rule (mirrors Cleanverse's Validator Compliance Rule)
    // ---------------------------------------------------------------------

    uint16 public minTier;
    uint16 public minSubTier;
    bytes2 public allowedGroup; // 0x0000 = any (not yet enforced, see header)
    bytes2 public allowedSubGroup; // 0x0000 = any (not yet enforced, see header)

    bool public isBlacklist; // country rule mode: true = deny listed, false = allow only listed
    mapping(bytes2 => bool) private _countrySet;
    bytes2[] private _countryList;

    // ---------------------------------------------------------------------
    // Risk policy: ratio bands, per-tier caps, global cap
    // ---------------------------------------------------------------------

    struct RatioBand {
        uint16 minTier;
        uint16 minSubTier;
        uint16 ratioBps;
    }

    RatioBand[] private _ratioBands;

    struct TierCap {
        bool isSet;
        uint256 cap;
    }

    mapping(uint16 => TierCap) private _tierCaps;

    /// @notice Cap applied to a tier with no explicit `setTierBorrowCap` override. `type(uint256).max` = no cap.
    uint256 public defaultBorrowCap;

    /// @notice Pool-wide cap on total principal outstanding across all borrowers. `type(uint256).max` = no cap.
    uint256 public maxTotalBorrow;

    // ---------------------------------------------------------------------
    // Lifecycle policy
    // ---------------------------------------------------------------------

    /// @notice Seconds between RevocationGuardian.flag() and the earliest startUnwind() call.
    uint256 public graceDuration;

    /// @notice Max age (seconds) a ComplianceRegistry observation may be before IComplianceGate.isFresh returns false.
    uint256 public maxComplianceStaleness;

    // ---------------------------------------------------------------------
    // Events, every setter emits one, with old/new values, feeding the
    // Phase 2c audit-trail export directly.
    // ---------------------------------------------------------------------

    event MinTierChanged(uint16 oldValue, uint16 newValue);
    event MinSubTierChanged(uint16 oldValue, uint16 newValue);
    event AllowedGroupChanged(bytes2 oldValue, bytes2 newValue);
    event AllowedSubGroupChanged(bytes2 oldValue, bytes2 newValue);
    event CountryRuleChanged(bytes2[] countries, bool isBlacklist);
    event RatioBandsChanged(RatioBand[] bands);
    event GraceDurationChanged(uint256 oldValue, uint256 newValue);
    event StalenessChanged(uint256 oldValue, uint256 newValue);
    event DefaultBorrowCapChanged(uint256 oldValue, uint256 newValue);
    event TierBorrowCapChanged(uint16 indexed tier, uint256 oldValue, uint256 newValue);
    event MaxTotalBorrowChanged(uint256 oldValue, uint256 newValue);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error EmptyRatioBands();
    error RatioBandsNotOrdered(uint256 index);
    error RatioBandsNotMonotonic(uint256 index);

    constructor(address initialOwner, uint256 graceDuration_, uint256 maxComplianceStaleness_)
        Ownable(initialOwner)
    {
        graceDuration = graceDuration_;
        maxComplianceStaleness = maxComplianceStaleness_;
        defaultBorrowCap = type(uint256).max;
        maxTotalBorrow = type(uint256).max;
        // minTier/minSubTier default to 0 (Solidity default) = no
        // restriction; allowedGroup/allowedSubGroup default to 0x0000 = any;
        // the country list starts empty with isBlacklist=false, which
        // isCountryEligible treats as "no restriction", all match the
        // pre-refactor behavior of never gating on these axes at all.

        RatioBand[] memory defaults = new RatioBand[](6);
        // Identical to backend/src/risk/tierRatios.ts's RATIO_BANDS, see
        // that file for the full data-driven justification against
        // docs/TIER_DISTRIBUTION.md's real tier distribution (tiers
        // 0/20/50, subTiers 0-80). Migrated verbatim from the former
        // CollateralRatioPolicy.sol; parity with the TS module is still
        // enforced by test/CollateralRatioPolicyParity.t.sol via `vm.ffi`.
        defaults[0] = RatioBand({minTier: 50, minSubTier: 80, ratioBps: 8_000}); // 80%
        defaults[1] = RatioBand({minTier: 50, minSubTier: 50, ratioBps: 9_000}); // 90%
        defaults[2] = RatioBand({minTier: 50, minSubTier: 20, ratioBps: 10_000}); // 100%
        defaults[3] = RatioBand({minTier: 50, minSubTier: 0, ratioBps: 11_000}); // 110%
        defaults[4] = RatioBand({minTier: 20, minSubTier: 0, ratioBps: 13_000}); // 130%
        defaults[5] = RatioBand({minTier: 0, minSubTier: 0, ratioBps: SAFEST_RATIO_BPS}); // 150%
        _setRatioBands(defaults);
    }

    // ---------------------------------------------------------------------
    // Setters, owner-only, one per parameter, each emits its own event.
    // ---------------------------------------------------------------------

    function setMinTier(uint16 newValue) external onlyOwner {
        emit MinTierChanged(minTier, newValue);
        minTier = newValue;
    }

    function setMinSubTier(uint16 newValue) external onlyOwner {
        emit MinSubTierChanged(minSubTier, newValue);
        minSubTier = newValue;
    }

    function setAllowedGroup(bytes2 newValue) external onlyOwner {
        emit AllowedGroupChanged(allowedGroup, newValue);
        allowedGroup = newValue;
    }

    function setAllowedSubGroup(bytes2 newValue) external onlyOwner {
        emit AllowedSubGroupChanged(allowedSubGroup, newValue);
        allowedSubGroup = newValue;
    }

    /// @notice Replaces the entire country set and blacklist/whitelist mode atomically.
    /// @dev Empty `countries` means "no country restriction" regardless of `isBlacklist_`, see `isCountryEligible`.
    function setCountryRule(bytes2[] calldata countries, bool isBlacklist_) external onlyOwner {
        for (uint256 i = 0; i < _countryList.length; i++) {
            delete _countrySet[_countryList[i]];
        }
        delete _countryList;

        for (uint256 i = 0; i < countries.length; i++) {
            if (!_countrySet[countries[i]]) {
                _countrySet[countries[i]] = true;
                _countryList.push(countries[i]);
            }
        }
        isBlacklist = isBlacklist_;

        emit CountryRuleChanged(countries, isBlacklist_);
    }

    /// @notice Owner-configurable: replace the entire ratio-band table.
    /// @dev Bands must be supplied strictly ordered most- to
    /// least-privileged, with non-decreasing ratioBps, enforced on every
    /// write, not just at construction time.
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

        emit RatioBandsChanged(bands);
    }

    function setGraceDuration(uint256 newValue) external onlyOwner {
        emit GraceDurationChanged(graceDuration, newValue);
        graceDuration = newValue;
    }

    function setMaxComplianceStaleness(uint256 newValue) external onlyOwner {
        emit StalenessChanged(maxComplianceStaleness, newValue);
        maxComplianceStaleness = newValue;
    }

    function setDefaultBorrowCap(uint256 newValue) external onlyOwner {
        emit DefaultBorrowCapChanged(defaultBorrowCap, newValue);
        defaultBorrowCap = newValue;
    }

    /// @notice Sets a tier-specific borrow cap override, replacing the `defaultBorrowCap` for that exact tier value.
    function setTierBorrowCap(uint16 tier, uint256 newValue) external onlyOwner {
        emit TierBorrowCapChanged(tier, tierBorrowCap(tier), newValue);
        _tierCaps[tier] = TierCap({isSet: true, cap: newValue});
    }

    function setMaxTotalBorrow(uint256 newValue) external onlyOwner {
        emit MaxTotalBorrowChanged(maxTotalBorrow, newValue);
        maxTotalBorrow = newValue;
    }

    // ---------------------------------------------------------------------
    // Pure/view evaluation helpers
    // ---------------------------------------------------------------------

    /// @notice Whether (tier, subTier) meets this policy's minimum tier threshold. Mirrors Cleanverse's min_tier/min_sub_tier semantics (0/0 = no restriction).
    function isTierEligible(uint16 tier, uint16 subTier) public view returns (bool) {
        if (tier > minTier) return true;
        if (tier == minTier && subTier >= minSubTier) return true;
        return false;
    }

    /// @notice Whether `country` is eligible under the configured country rule. Empty rule (no countries configured) always returns true, regardless of `isBlacklist`.
    function isCountryEligible(bytes2 country) public view returns (bool) {
        if (_countryList.length == 0) return true;
        bool inSet = _countrySet[country];
        return isBlacklist ? !inSet : inSet;
    }

    /// @notice Returns the required collateral ratio, in basis points (10_000 = 100%), for a borrower at the given tier/subTier.
    /// @dev Pure function of on-chain state (the configured bands), takes no external calls.
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

    /// @notice The borrow cap applicable to `tier`, its explicit override if one was set via `setTierBorrowCap`, else `defaultBorrowCap`.
    function tierBorrowCap(uint16 tier) public view returns (uint256) {
        TierCap storage tc = _tierCaps[tier];
        return tc.isSet ? tc.cap : defaultBorrowCap;
    }

    // ---------------------------------------------------------------------
    // Structural reads
    // ---------------------------------------------------------------------

    function ratioBandCount() external view returns (uint256) {
        return _ratioBands.length;
    }

    function ratioBandAt(uint256 index) external view returns (RatioBand memory) {
        return _ratioBands[index];
    }

    function countryList() external view returns (bytes2[] memory) {
        return _countryList;
    }

    /// @notice Full policy snapshot in one call, for a dashboard or audit tool to capture "the pool's compliance policy at block N." Excludes per-tier cap overrides (a mapping, can't be a struct member), query `tierBorrowCap(tier)` per tier instead.
    struct Policy {
        uint16 minTier;
        uint16 minSubTier;
        bytes2 allowedGroup;
        bytes2 allowedSubGroup;
        bool isBlacklist;
        bytes2[] countries;
        RatioBand[] ratioBands;
        uint256 graceDuration;
        uint256 maxComplianceStaleness;
        uint256 defaultBorrowCap;
        uint256 maxTotalBorrow;
    }

    function getPolicy() external view returns (Policy memory) {
        return Policy({
            minTier: minTier,
            minSubTier: minSubTier,
            allowedGroup: allowedGroup,
            allowedSubGroup: allowedSubGroup,
            isBlacklist: isBlacklist,
            countries: _countryList,
            ratioBands: _ratioBands,
            graceDuration: graceDuration,
            maxComplianceStaleness: maxComplianceStaleness,
            defaultBorrowCap: defaultBorrowCap,
            maxTotalBorrow: maxTotalBorrow
        });
    }
}
