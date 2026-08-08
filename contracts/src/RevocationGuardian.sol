// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ComplianceRegistry} from "./ComplianceRegistry.sol";
import {LendingPool} from "./LendingPool.sol";
import {IUnwindStrategy} from "./interfaces/IUnwindStrategy.sol";

/**
 * @title RevocationGuardian
 * @notice Revoca's centerpiece: the compliance-reactive unwind engine. It
 * detects when a borrower's A-Pass becomes ineligible (frozen, expired,
 * blacklisted, or drops below the pool's tier-derived collateral ratio) and
 * drives their position through a safe, auditable, ORDERED unwind, self-cure
 * from their own collateral first, permissionless liquidation only if that's
 * insufficient. Every transition emits an event carrying enough data to
 * reconstruct the full unwind history off-chain; that log IS this project's
 * CCP-style audit trail.
 *
 * STATE MACHINE
 *
 * Per-position lifecycle, four on-chain states:
 *
 *   HEALTHY --flag()--> FLAGGED --startUnwind()--> UNWINDING --completeUnwind()--> RESOLVED
 *              ^                    |
 *              |                    |
 *              +----reinstate()-----+
 *
 * A NOTE ON "GRACE": the design brief this contract was built from describes
 * five labels, HEALTHY, FLAGGED, GRACE, UNWINDING, RESOLVED, with
 * `flag()` described as moving HEALTHY->FLAGGED AND starting the grace timer
 * in the same call. There is no separately-callable transition between
 * "being flagged" and "being in its grace window" anywhere in that
 * description, so on-chain they are ONE state: FLAGGED means "flagged, and
 * currently within its grace period", `graceEndsAt` is what subdivides that
 * single state into "still gracing" vs. "grace has elapsed, unwind may
 * start." This is a deliberate, documented simplification, not a silent
 * deviation, it avoids two enum values with no real transition between
 * them (and the wasted storage write that would imply).
 *
 * Grace duration is NOT this contract's own state, per docs/ROADMAP.md's
 * refinement backlog ("Pluggable unwind strategy"), it's read live from
 * `strategy` (`IUnwindStrategy`, see that interface's header), an
 * owner-settable, swappable strategy object rather than a single hardcoded
 * number. `flag()` reads `strategy.graceDuration()` fresh at flag-time, so
 * a strategy swap (or, for `GraceAndNotifyStrategy`, an owner change to
 * the underlying `CompliancePolicy.graceDuration()`) takes effect for the
 * NEXT flag, not retroactively for positions already in their grace window
 * (`graceEndsAt` is fixed at flag-time, per-position, exactly as before).
 * The strategy varies ONLY this parameter and a declared, install-time-
 * enforced guarantee (see `setStrategy` and `IUnwindStrategy`'s header),
 * it does not participate in the state machine's shape or in
 * `startUnwind`'s unconditional self-cure-then-liquidation mechanics
 * below, which are identical under every strategy.
 *
 * A FLAGGED position can return to HEALTHY via `reinstate()` if compliance
 * (and tier-derived health) is restored before grace elapses. Once
 * UNWINDING has begun, there is no path back, the unwind must complete.
 * RESOLVED positions can be flagged again later (a borrower can take out a
 * fresh loan after a prior unwind fully resolved; RESOLVED and HEALTHY are
 * both "nothing currently in progress" for the purposes of `flag()`).
 *
 * REASON INFERENCE
 *
 * `flag()` distinguishes exactly what this contract has visibility into:
 * - registry shows `compliant == false`: reason is whatever
 *   `registry.ineligibilityReason()` DERIVES live from the attestor's raw
 *   facts + CompliancePolicy (FROZEN/EXPIRED/INELIGIBLE, BLACKLISTED is
 *   defined but never derivable today, see ComplianceRegistry.sol's
 *   header; there is no keeper-supplied verdict anymore, per Phase 2b,
 *   the attestor signs facts only, never a reason).
 * - registry shows `compliant == true` but `pool.isHealthy(borrower) ==
 *   false`: TIER_DROP. This is NOT something the registry can determine,
 *   it's inherently pool-relative (this position's debt vs. its collateral
 *   at the CURRENT tier-derived ratio), so only this contract, which reads
 *   both the registry AND the pool, can infer it.
 *
 * SELF-CURE, THEN LIQUIDATION
 *
 * `startUnwind()` (callable once grace has elapsed) atomically: (1) moves
 * to UNWINDING, (2) applies as much of the borrower's OWN posted collateral
 * toward their OWN debt as covers it (via `pool.applyCollateralToDebt`,
 * guardian-only on the pool side), interest is accrued and settled exactly
 * at this moment via the pool's normal `_accrueInterest` path, not
 * approximated. If that fully clears the debt, the position resolves
 * immediately in the same transaction. If not (collateral was insufficient
 * to cover the debt at the current ratio), the position remains UNWINDING,
 * and now sits in whatever state `pool.liquidate()`, already fully
 * permissionless, requires: anyone can complete the liquidation directly
 * against the pool. `completeUnwind()` is a separate, permissionless
 * finalization step that checks the debt is actually gone and marks the
 * guardian's own bookkeeping RESOLVED; it doesn't perform the liquidation
 * itself, since `pool.liquidate` already works standalone.
 *
 * FAIRNESS: RESIDUAL COLLATERAL IS ALWAYS RECOVERABLE
 *
 * Once debt is fully cleared (whether via self-cure, direct repayment, or
 * liquidation), `LendingPool.withdrawCollateral` no longer gates on
 * compliance or freshness at all (see that function's header), a revoked,
 * still-non-compliant borrower can always withdraw their own residual
 * collateral. Revocation is not confiscation of value beyond what was
 * owed. See test/RevocationGuardian.t.sol for an explicit test of this.
 *
 * "FREEZE NEW BORROWING", WHY NO EXPLICIT CODE FOR THIS EXISTS
 *
 * The design brief asks for new borrowing to be frozen for a
 * flagged/unwinding user. This falls out of LendingPool's EXISTING ratio
 * math without any guardian-pool coupling: `borrow()` already requires
 * `newDebt * ratioBps <= collateral * BPS_DENOMINATOR`, recomputed live on
 * every call. A position that's flagged for TIER_DROP is, by construction,
 * already failing that inequality, and since adding more debt only makes
 * the inequality worse (collateral doesn't grow from borrowing), further
 * borrowing is structurally impossible once unhealthy. A position flagged
 * for a compliance failure (FROZEN/EXPIRED/INELIGIBLE) is separately
 * blocked because `borrow()` independently requires
 * `complianceGate.isCompliant() == true`. No additional cross-contract
 * "ask the guardian" check is needed, and none was added.
 */
contract RevocationGuardian is Ownable, ReentrancyGuard {
    enum PositionState {
        HEALTHY,
        FLAGGED,
        UNWINDING,
        RESOLVED
    }

    struct GuardianPosition {
        PositionState state;
        ComplianceRegistry.Reason reason;
        uint256 flaggedAt;
        uint256 graceEndsAt;
        uint256 unwindStartedAt;
    }

    ComplianceRegistry public immutable registry;
    LendingPool public immutable pool;

    /// @notice The active unwind strategy, see IUnwindStrategy.sol's header. Owner-settable via setStrategy, defaults to whatever the deployer passes at construction (this session's deploy scripts default to GraceAndNotifyStrategy, preserving pre-strategy behavior exactly out of the box).
    IUnwindStrategy public strategy;

    mapping(address => GuardianPosition) public positions;

    event PositionFlagged(address indexed borrower, ComplianceRegistry.Reason reason, uint256 graceEndsAt);
    event PositionReinstated(address indexed borrower);
    event UnwindStarted(address indexed borrower, uint256 debtAtStart, uint256 collateralAtStart);
    event UnwindStep(address indexed borrower, string step, uint256 amount, uint256 remainingDebt);
    event UnwindCompleted(address indexed borrower, uint256 residualCollateral);
    event StrategyChanged(address indexed oldStrategy, address indexed newStrategy);

    error NotEligibleToFlag(address borrower, PositionState currentState);
    error PositionNotFlaggable(address borrower);
    error NotFlagged(address borrower);
    error NotUnwinding(address borrower);
    error GracePeriodNotElapsed(address borrower, uint256 graceEndsAt);
    error UnwindNotComplete(address borrower, uint256 remainingDebt);
    error StaleCompliance(address borrower);
    error StillNonCompliant(address borrower);
    error StillUnhealthy(address borrower);
    /// @notice Reverted by setStrategy/the constructor when a proposed strategy fails to declare Revoca's non-negotiable invariants, see IUnwindStrategy.sol's header.
    error InvalidStrategy(address strategy);

    constructor(ComplianceRegistry registry_, LendingPool pool_, address initialOwner, IUnwindStrategy strategy_)
        Ownable(initialOwner)
    {
        registry = registry_;
        pool = pool_;
        _setStrategy(strategy_);
    }

    /**
     * @notice Owner-only, swaps the active unwind strategy. Reverts with
     * InvalidStrategy if the proposed strategy doesn't declare
     * self-cure-first and reinstatement-allowed, see IUnwindStrategy.sol's
     * header for why this is enforced here rather than only documented.
     * Takes effect for the NEXT flag() only, positions already FLAGGED
     * keep the graceEndsAt fixed when they were flagged, exactly as an
     * owner changing CompliancePolicy.graceDuration already worked before
     * strategies existed.
     */
    function setStrategy(IUnwindStrategy newStrategy) external onlyOwner {
        _setStrategy(newStrategy);
    }

    function _setStrategy(IUnwindStrategy newStrategy) internal {
        if (address(newStrategy) == address(0)) revert InvalidStrategy(address(newStrategy));

        IUnwindStrategy.UnwindAction[] memory sequence = newStrategy.unwindSequence();
        bool startsWithSelfCure = sequence.length > 0 && sequence[0] == IUnwindStrategy.UnwindAction.SELF_CURE;
        if (!startsWithSelfCure || !newStrategy.reinstatementAllowed()) {
            revert InvalidStrategy(address(newStrategy));
        }

        emit StrategyChanged(address(strategy), address(newStrategy));
        strategy = newStrategy;
    }

    /**
     * @notice Flags `borrower` for unwind. Callable when the registry shows
     * a fresh, non-compliant observation, OR when the registry shows
     * compliant but the pool considers the position unhealthy (tier drop).
     * Only callable from HEALTHY or RESOLVED (see this contract's header on
     * why RESOLVED is flaggable again).
     */
    function flag(address borrower) external nonReentrant {
        GuardianPosition storage p = positions[borrower];
        if (p.state != PositionState.HEALTHY && p.state != PositionState.RESOLVED) {
            revert NotEligibleToFlag(borrower, p.state);
        }
        if (!registry.isFresh(borrower)) revert StaleCompliance(borrower);

        ComplianceRegistry.Reason reason;
        if (!registry.isCompliant(borrower)) {
            reason = registry.ineligibilityReason(borrower);
            if (reason == ComplianceRegistry.Reason.NONE) {
                reason = ComplianceRegistry.Reason.INELIGIBLE;
            }
        } else if (!pool.isHealthy(borrower)) {
            reason = ComplianceRegistry.Reason.TIER_DROP;
        } else {
            revert PositionNotFlaggable(borrower);
        }

        p.state = PositionState.FLAGGED;
        p.reason = reason;
        p.flaggedAt = block.timestamp;
        p.graceEndsAt = block.timestamp + strategy.graceDuration();
        p.unwindStartedAt = 0;

        emit PositionFlagged(borrower, reason, p.graceEndsAt);
    }

    /**
     * @notice Reinstates `borrower` to HEALTHY if, before grace elapses,
     * their compliance signal is fresh and true AND the pool now considers
     * them healthy again (covers both the compliance-failure and
     * tier-drop flag reasons). Only callable while FLAGGED, once
     * UNWINDING has begun there is no reinstatement path (see this
     * contract's header).
     */
    function reinstate(address borrower) external nonReentrant {
        GuardianPosition storage p = positions[borrower];
        if (p.state != PositionState.FLAGGED) revert NotFlagged(borrower);
        if (!registry.isFresh(borrower)) revert StaleCompliance(borrower);
        if (!registry.isCompliant(borrower)) revert StillNonCompliant(borrower);
        if (!pool.isHealthy(borrower)) revert StillUnhealthy(borrower);

        p.state = PositionState.HEALTHY;
        p.reason = ComplianceRegistry.Reason.NONE;
        p.flaggedAt = 0;
        p.graceEndsAt = 0;

        emit PositionReinstated(borrower);
    }

    /**
     * @notice Once grace has elapsed on a FLAGGED position, begins the
     * unwind: moves to UNWINDING, then immediately attempts self-cure
     * (applying the borrower's own collateral to their own debt). If that
     * fully clears the debt, resolves immediately in this same
     * transaction. Otherwise the position remains UNWINDING, exposed to
     * `pool.liquidate` (already permissionless) until `completeUnwind` is
     * called. Permissionless, anyone may trigger this once grace elapses.
     */
    function startUnwind(address borrower) external nonReentrant {
        GuardianPosition storage p = positions[borrower];
        if (p.state != PositionState.FLAGGED) revert NotFlagged(borrower);
        if (block.timestamp < p.graceEndsAt) revert GracePeriodNotElapsed(borrower, p.graceEndsAt);

        p.state = PositionState.UNWINDING;
        p.unwindStartedAt = block.timestamp;

        uint256 debtBefore = pool.currentDebt(borrower);
        (uint256 collateralBefore,,,) = pool.positions(borrower);
        emit UnwindStarted(borrower, debtBefore, collateralBefore);

        uint256 applied = pool.applyCollateralToDebt(borrower, type(uint256).max);
        uint256 debtAfter = pool.currentDebt(borrower);
        emit UnwindStep(borrower, "self-cure", applied, debtAfter);

        if (debtAfter == 0) {
            p.state = PositionState.RESOLVED;
            (uint256 residual,,,) = pool.positions(borrower);
            emit UnwindCompleted(borrower, residual);
        }
    }

    /**
     * @notice Finalizes an UNWINDING position once its debt has actually
     * reached zero (via self-cure alone, a direct repayment, or a
     * permissionless `pool.liquidate` call by anyone), marks it RESOLVED.
     * Permissionless. Reverts if debt remains, since resolution isn't a
     * decision this contract can force; it can only recognize when the
     * pool's own mechanics have already achieved it.
     */
    function completeUnwind(address borrower) external nonReentrant {
        GuardianPosition storage p = positions[borrower];
        if (p.state != PositionState.UNWINDING) revert NotUnwinding(borrower);

        uint256 remainingDebt = pool.currentDebt(borrower);
        if (remainingDebt > 0) revert UnwindNotComplete(borrower, remainingDebt);

        p.state = PositionState.RESOLVED;
        (uint256 residual,,,) = pool.positions(borrower);
        emit UnwindCompleted(borrower, residual);
    }
}
