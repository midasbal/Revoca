// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUnwindStrategy} from "../interfaces/IUnwindStrategy.sol";

/**
 * @title ForcedUnwindStrategy
 * @notice The most aggressive strategy: zero grace, `startUnwind` becomes
 * callable in the very same block `flag()` was called. No constructor
 * parameters, no configuration, that IS this strategy's identity, unlike
 * ImmediateQuarantineStrategy's owner-chosen short duration. Still, and
 * non-negotiably, self-cure before liquidation and full reinstatement
 * eligibility for whatever instant the FLAGGED state technically exists
 * (a zero-length window still passes through the same `reinstate()` gate
 * as every other strategy, it's just very unlikely to be exercised before
 * `startUnwind` is called). "Forced" means speed, never confiscation:
 * this strategy still self-cures first, still returns residual
 * collateral once debt clears, and never blocks repay or collateral
 * withdrawal, those are RevocationGuardian/LendingPool mechanics this
 * strategy has no power to alter.
 */
contract ForcedUnwindStrategy is IUnwindStrategy {
    /// @inheritdoc IUnwindStrategy
    function name() external pure returns (string memory) {
        return "ForcedUnwind";
    }

    /// @inheritdoc IUnwindStrategy
    function graceDuration() external pure returns (uint256) {
        return 0;
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
