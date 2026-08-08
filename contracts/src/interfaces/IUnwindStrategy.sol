// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUnwindStrategy
 * @notice The seam that turns "what happens once a position becomes
 * ineligible" from a single hardcoded path into a selectable strategy,
 * per docs/ROADMAP.md's refinement backlog ("Pluggable unwind strategy").
 * `RevocationGuardian` consults a strategy for two things ONLY: how long a
 * FLAGGED position's grace window lasts, and a declared, asserted-at-set-time
 * guarantee that the strategy never abandons Revoca's fairness invariants.
 * It does NOT hand the strategy control of the state machine itself,
 * `RevocationGuardian`'s HEALTHY -> FLAGGED -> UNWINDING -> RESOLVED shape,
 * and the unconditional self-cure-then-liquidate mechanics inside
 * `startUnwind`, are unchanged by which strategy is installed. A strategy
 * varies TIMING AND AGGRESSIVENESS, never the shape or the fail-safes.
 *
 * NON-NEGOTIABLE INVARIANTS, ENFORCED, NOT JUST DOCUMENTED
 *
 * `RevocationGuardian.setStrategy` (and its constructor) calls
 * `unwindSequence()` and `reinstatementAllowed()` on any proposed strategy
 * and REVERTS if either check fails, see `RevocationGuardian.sol`'s
 * `InvalidStrategy` error. A strategy that doesn't declare self-cure first
 * or that disables reinstatement cannot be installed, full stop. This is
 * belt-and-suspenders: `RevocationGuardian.startUnwind` already
 * unconditionally self-cures before any liquidation exposure exists
 * (calling `LendingPool.applyCollateralToDebt` regardless of which
 * strategy is active), and `LendingPool.repay` /
 * `RevocationGuardian.reinstate` / `LendingPool.withdrawCollateral` (once
 * debt is zero) are never gated by strategy at all, they're guardian/pool
 * mechanics untouched by this seam. The interface-level declaration and
 * the guardian's install-time check exist so a FUTURE strategy cannot
 * silently ship without these guarantees, not because today's guardian
 * code would otherwise behave differently.
 *
 * A strategy may make the position's window shorter or longer
 * (`graceDuration`), never remove the borrower's ability to exit
 * (`reinstatementAllowed` while FLAGGED, and risk-decreasing pool actions,
 * which this seam has no say over regardless), and never skip self-cure
 * or seize beyond what's owed.
 */
interface IUnwindStrategy {
    /// @notice Ordered unwind actions once a FLAGGED position's grace elapses. LIQUIDATE (already fully permissionless on LendingPool, see LendingPool.sol's liquidate()) is the only escalation path when self-cure alone can't clear the debt, never a step that seizes more than owed debt.
    enum UnwindAction {
        SELF_CURE,
        LIQUIDATE
    }

    /// @notice Short, human-readable name for events, dashboards, and audit reports.
    function name() external pure returns (string memory);

    /// @notice Seconds between flag() and the earliest permitted startUnwind() call for a position flagged under this strategy. 0 is valid (unwind may begin in the same block flag() was called), reinstate() and every risk-decreasing pool action remain callable regardless of how short this is, see this interface's header.
    function graceDuration() external view returns (uint256);

    /// @notice The ordered unwind steps this strategy prescribes. MUST have length >= 1 and start with SELF_CURE, enforced by RevocationGuardian.setStrategy/constructor (see this interface's header), not merely documented.
    function unwindSequence() external pure returns (UnwindAction[] memory);

    /// @notice Whether a FLAGGED position may still return to HEALTHY via reinstate() during its grace window. MUST be true, Revoca never traps a borrower's exit from a reversible state; enforced by RevocationGuardian.setStrategy/constructor, not merely documented.
    function reinstatementAllowed() external pure returns (bool);
}
