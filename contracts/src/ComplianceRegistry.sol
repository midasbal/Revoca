// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {ITierOracle} from "./interfaces/ITierOracle.sol";

/**
 * @title ComplianceRegistry
 * @notice On-chain cache of the most recent compliance/tier observation
 * per user, written by an authorized off-chain keeper. This is the
 * concrete piece Part 1 of the RevocationGuardian build asked for: a
 * staleness-aware store, NOT the real Cleanverse-backed gate/oracle.
 *
 * What this IS: a keeper-gated write of (compliant, tier, subTier, reason)
 * plus the block timestamp it was observed at, with an owner-configurable
 * maximum staleness window. It implements both IComplianceGate and
 * ITierOracle so it can be wired into LendingPool exactly like the
 * TestComplianceGate/TestTierOracle doubles are, same seam, same code
 * path, per this project's design principle that callers must not care
 * whether the signal originates on-chain (Design A) or from an attestor
 * (Design B).
 *
 * What this is NOT: `observeCompliance` is gated by a simple
 * `msg.sender`-is-an-authorized-keeper check, there is no cryptographic
 * attestation (EIP-712 signature from a Cleanverse-controlled key,
 * on-chain proof the observation matches a real `query_apass` response,
 * etc). That's explicitly future work, see IComplianceGate.sol and
 * ITierOracle.sol's headers ("the real signed-attestation version comes
 * with the oracle"). Today, trusting this registry means trusting whoever
 * holds a keeper key, which in practice is us. This is a deliberate,
 * documented placeholder, not a silent shortcut.
 */
contract ComplianceRegistry is IComplianceGate, ITierOracle, Ownable {
    /// @notice Best-effort reason for a non-compliant observation. Set by
    /// the keeper for FROZEN/EXPIRED/INELIGIBLE/BLACKLISTED (see
    /// backend/src/keeper's eligibility logic for exactly which of these it
    /// can currently distinguish, BLACKLISTED is defined here for
    /// forward-compatibility but the keeper never emits it today, since
    /// `query_apass`'s response has no field indicating blacklist status;
    /// see docs/OPEN_QUESTIONS.md item 5). TIER_DROP is never written by
    /// the keeper, it's a pool-relative concept (this position's debt vs.
    /// its collateral ratio at the CURRENT tier), which only
    /// RevocationGuardian can determine, since the registry has no
    /// visibility into any pool's debt/collateral.
    enum Reason {
        NONE,
        FROZEN,
        EXPIRED,
        BLACKLISTED,
        INELIGIBLE,
        TIER_DROP
    }

    struct Observation {
        bool compliant;
        uint16 tier;
        uint16 subTier;
        uint64 lastVerifiedAt;
        Reason reason;
    }

    mapping(address => Observation) private _observations;
    mapping(address => bool) public isKeeper;

    /// @notice Max age (seconds) an observation may be before `isFresh` returns false.
    uint256 public maxComplianceStaleness;

    event ComplianceObserved(
        address indexed user, bool compliant, uint16 tier, uint16 subTier, uint256 timestamp, Reason reason
    );
    event KeeperUpdated(address indexed keeper, bool authorized);
    event MaxStalenessChanged(uint256 oldValue, uint256 newValue);

    error NotKeeper(address caller);

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper(msg.sender);
        _;
    }

    constructor(address initialOwner, uint256 maxComplianceStaleness_) Ownable(initialOwner) {
        maxComplianceStaleness = maxComplianceStaleness_;
    }

    // ---------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------

    function setKeeper(address keeper, bool authorized) external onlyOwner {
        isKeeper[keeper] = authorized;
        emit KeeperUpdated(keeper, authorized);
    }

    function setMaxComplianceStaleness(uint256 newValue) external onlyOwner {
        emit MaxStalenessChanged(maxComplianceStaleness, newValue);
        maxComplianceStaleness = newValue;
    }

    // ---------------------------------------------------------------------
    // Keeper write
    // ---------------------------------------------------------------------

    /**
     * @notice Records a single observation of `user`'s compliance/tier
     * state, timestamped `block.timestamp`. Overwrites any prior
     * observation entirely, there is no history kept on-chain beyond the
     * most recent one (the audit trail lives in the `ComplianceObserved`
     * event log, not in storage).
     */
    function observeCompliance(address user, bool compliant, uint16 tier, uint16 subTier, Reason reason)
        external
        onlyKeeper
    {
        _observations[user] =
            Observation({compliant: compliant, tier: tier, subTier: subTier, lastVerifiedAt: uint64(block.timestamp), reason: reason});

        emit ComplianceObserved(user, compliant, tier, subTier, block.timestamp, reason);
    }

    // ---------------------------------------------------------------------
    // IComplianceGate
    // ---------------------------------------------------------------------

    /// @inheritdoc IComplianceGate
    function isCompliant(address user) external view returns (bool) {
        return _observations[user].compliant;
    }

    /// @inheritdoc IComplianceGate
    function isFresh(address user) public view returns (bool) {
        uint256 lastVerifiedAt = _observations[user].lastVerifiedAt;
        // A user with no observation at all (lastVerifiedAt == 0) is never
        // fresh, "never observed" must not be conflated with "observed
        // long ago," both of which would otherwise trip the same
        // block.timestamp - lastVerifiedAt > maxStaleness check, but the
        // former deserves a definitely-not-fresh answer even if
        // maxComplianceStaleness were ever set absurdly high.
        if (lastVerifiedAt == 0) return false;
        return block.timestamp - lastVerifiedAt <= maxComplianceStaleness;
    }

    // ---------------------------------------------------------------------
    // ITierOracle
    // ---------------------------------------------------------------------

    /// @inheritdoc ITierOracle
    function tierOf(address user) external view returns (uint16 tier, uint16 subTier) {
        Observation storage obs = _observations[user];
        return (obs.tier, obs.subTier);
    }

    // ---------------------------------------------------------------------
    // Registry-specific reads (beyond the minimal IComplianceGate/ITierOracle
    // surface), used directly by RevocationGuardian, which needs richer
    // data (freshness, reason, raw timestamp) than the pool's simpler
    // borrow-time checks do.
    // ---------------------------------------------------------------------

    function lastVerifiedAt(address user) external view returns (uint256) {
        return _observations[user].lastVerifiedAt;
    }

    function lastReason(address user) external view returns (Reason) {
        return _observations[user].reason;
    }

    /// @notice Full observation in one call, for dashboards/keepers that want everything at once.
    function observationOf(address user)
        external
        view
        returns (bool compliant, uint16 tier, uint16 subTier, uint256 lastVerifiedAt_, Reason reason)
    {
        Observation storage obs = _observations[user];
        return (obs.compliant, obs.tier, obs.subTier, obs.lastVerifiedAt, obs.reason);
    }
}
