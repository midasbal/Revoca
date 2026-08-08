// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUnwindStrategy} from "../interfaces/IUnwindStrategy.sol";

/**
 * @title ImmediateQuarantineStrategy
 * @notice A short, fixed grace period, set at construction rather than
 * read live from CompliancePolicy, so a pool that wants "quarantine fast"
 * behavior isn't coupled to whatever grace duration the policy happens to
 * be configured with for other purposes. "Immediate" refers to how
 * quickly the position is isolated, NOT to any weakening of fairness: new
 * borrowing is already structurally impossible for a flagged position
 * (see RevocationGuardian.sol's header, "freeze new draws" falls out of
 * LendingPool's existing compliance/ratio checks with no extra code
 * needed, true for every strategy, not something this contract adds),
 * self-cure still runs before any liquidation exposure, reinstatement is
 * still allowed for the (short) duration of the grace window, and
 * residual collateral is still always recoverable once debt clears. This
 * strategy is stricter on TIMING only.
 */
contract ImmediateQuarantineStrategy is IUnwindStrategy {
    /// @notice Fixed at construction, deliberately short and NOT read from CompliancePolicy, see this contract's header.
    uint256 public immutable graceDurationSeconds;

    constructor(uint256 graceDurationSeconds_) {
        graceDurationSeconds = graceDurationSeconds_;
    }

    /// @inheritdoc IUnwindStrategy
    function name() external pure returns (string memory) {
        return "ImmediateQuarantine";
    }

    /// @inheritdoc IUnwindStrategy
    function graceDuration() external view returns (uint256) {
        return graceDurationSeconds;
    }

    /// @inheritdoc IUnwindStrategy
    function unwindSequence() external pure returns (UnwindAction[] memory sequence) {
        sequence = new UnwindAction[](2);
        sequence[0] = UnwindAction.SELF_CURE;
        sequence[1] = UnwindAction.LIQUIDATE;
    }

    /// @inheritdoc IUnwindStrategy
    function reinstatementAllowed() external pure returns (bool) {
        return true;
    }
}
