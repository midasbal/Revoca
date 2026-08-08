// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUnwindStrategy} from "../interfaces/IUnwindStrategy.sol";
import {LendingPool} from "../LendingPool.sol";

/**
 * @title GraceAndNotifyStrategy
 * @notice The default strategy, and Revoca's original, only behavior
 * before pluggable strategies existed: a grace period (read LIVE from
 * `pool.policy().graceDuration()`, exactly as `RevocationGuardian` itself
 * used to read it directly, see docs/ROADMAP.md's refinement backlog),
 * then self-cure before liquidation, with reinstatement allowed at any
 * point during grace. Deliberately reads the policy live rather than
 * snapshotting a value at construction, so an owner's
 * `CompliancePolicy.setGraceDuration` call keeps taking effect for the
 * NEXT flag exactly as before, this strategy changes NOTHING about
 * existing behavior, it only relocates where the guardian gets the
 * number from.
 */
contract GraceAndNotifyStrategy is IUnwindStrategy {
    LendingPool public immutable pool;

    constructor(LendingPool pool_) {
        pool = pool_;
    }

    /// @inheritdoc IUnwindStrategy
    function name() external pure returns (string memory) {
        return "GraceAndNotify";
    }

    /// @inheritdoc IUnwindStrategy
    function graceDuration() external view returns (uint256) {
        return pool.policy().graceDuration();
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
