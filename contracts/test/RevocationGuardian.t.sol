// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LendingPool} from "../src/LendingPool.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {RevocationGuardian} from "../src/RevocationGuardian.sol";
import {MockERC20} from "../src/test/MockERC20.sol";

contract RevocationGuardianTest is Test {
    LendingPool pool;
    MockERC20 asset;
    ComplianceRegistry registry;
    RevocationGuardian guardian;

    address owner = address(this);
    address keeper = address(0x1CEE7E4);
    address lender1 = address(0x1EA1);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address liquidator = address(0x11D1D);
    address rando = address(0x1234);

    uint256 constant MAX_STALENESS = 1800; // 30 min
    uint256 constant GRACE_PERIOD = 3600; // 1 hour
    uint256 constant RATE_BPS_PER_SECOND = 1;
    uint256 constant LIQUIDATION_BONUS_BPS = 500;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        registry = new ComplianceRegistry(owner, MAX_STALENESS);
        registry.setKeeper(keeper, true);

        pool = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(registry)),
            ITierOracle(address(registry)),
            owner,
            RATE_BPS_PER_SECOND,
            LIQUIDATION_BONUS_BPS
        );

        guardian = new RevocationGuardian(registry, pool, owner, GRACE_PERIOD);
        pool.setGuardian(address(guardian));

        address[4] memory users = [lender1, alice, bob, liquidator];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        vm.prank(lender1);
        pool.deposit(1_000_000e18);
    }

    function _observe(address user, bool compliant, uint16 tier, uint16 subTier, ComplianceRegistry.Reason reason)
        internal
    {
        vm.prank(keeper);
        registry.observeCompliance(user, compliant, tier, subTier, reason);
    }

    // -------------------------------------------------------------------
    // flag()
    // -------------------------------------------------------------------

    function test_Flag_RevertsWhenStale() public {
        // Never observed at all -> isFresh() is false on ComplianceRegistry.
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.StaleCompliance.selector, alice));
        guardian.flag(alice);
    }

    function test_Flag_RevertsWhenCompliantAndHealthy() public {
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
        // No pool position at all -> isHealthy() is trivially true (debt == 0).
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.PositionNotFlaggable.selector, alice));
        guardian.flag(alice);
    }

    function test_Flag_FrozenReason() public {
        _observe(alice, false, 50, 80, ComplianceRegistry.Reason.FROZEN);

        vm.expectEmit(true, false, false, true);
        emit RevocationGuardian.PositionFlagged(alice, ComplianceRegistry.Reason.FROZEN, block.timestamp + GRACE_PERIOD);
        guardian.flag(alice);

        (RevocationGuardian.PositionState state, ComplianceRegistry.Reason reason, uint256 flaggedAt, uint256 graceEndsAt,) =
            guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.FLAGGED));
        assertEq(uint8(reason), uint8(ComplianceRegistry.Reason.FROZEN));
        assertEq(flaggedAt, block.timestamp);
        assertEq(graceEndsAt, block.timestamp + GRACE_PERIOD);
    }

    function test_Flag_DefaultsToIneligibleWhenKeeperGaveNoReason() public {
        _observe(alice, false, 50, 80, ComplianceRegistry.Reason.NONE);
        guardian.flag(alice);

        (, ComplianceRegistry.Reason reason,,,) = guardian.positions(alice);
        assertEq(uint8(reason), uint8(ComplianceRegistry.Reason.INELIGIBLE));
    }

    function test_Flag_TierDropReason() public {
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1200e18); // near the 80% max

        // Tier downgrade -> compliant still true, but pool now unhealthy.
        _observe(alice, true, 0, 0, ComplianceRegistry.Reason.NONE);
        assertFalse(pool.isHealthy(alice));

        guardian.flag(alice);

        (, ComplianceRegistry.Reason reason,,,) = guardian.positions(alice);
        assertEq(uint8(reason), uint8(ComplianceRegistry.Reason.TIER_DROP));
    }

    function test_Flag_RevertsWhenAlreadyFlagged() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        vm.expectRevert(
            abi.encodeWithSelector(
                RevocationGuardian.NotEligibleToFlag.selector, alice, RevocationGuardian.PositionState.FLAGGED
            )
        );
        guardian.flag(alice);
    }

    function test_Flag_PermissionlessCallableByAnyone() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        vm.prank(rando);
        guardian.flag(alice); // no revert -> anyone may call
    }

    // -------------------------------------------------------------------
    // reinstate()
    // -------------------------------------------------------------------

    function test_Reinstate_DuringGrace_ReturnsToHealthy() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        // Compliance restored, well before grace elapses.
        vm.warp(block.timestamp + 100);
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        vm.expectEmit(true, false, false, true);
        emit RevocationGuardian.PositionReinstated(alice);
        guardian.reinstate(alice);

        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.HEALTHY));
    }

    function test_Reinstate_RevertsIfStillNonCompliant() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN); // refresh but still non-compliant

        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.StillNonCompliant.selector, alice));
        guardian.reinstate(alice);
    }

    function test_Reinstate_RevertsIfStale() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        vm.warp(block.timestamp + MAX_STALENESS + 1); // observation now stale, never refreshed

        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.StaleCompliance.selector, alice));
        guardian.reinstate(alice);
    }

    function test_Reinstate_RevertsIfTierStillUnhealthy() public {
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1200e18);

        _observe(alice, true, 0, 0, ComplianceRegistry.Reason.NONE); // tier drop
        guardian.flag(alice);

        // Compliance is "true" but tier is still bad -> pool remains unhealthy.
        _observe(alice, true, 0, 0, ComplianceRegistry.Reason.NONE);

        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.StillUnhealthy.selector, alice));
        guardian.reinstate(alice);
    }

    function test_Reinstate_RevertsIfNotFlagged() public {
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.NotFlagged.selector, alice));
        guardian.reinstate(alice);
    }

    // -------------------------------------------------------------------
    // startUnwind()
    // -------------------------------------------------------------------

    function test_StartUnwind_RevertsBeforeGraceElapses() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        vm.expectRevert(
            abi.encodeWithSelector(RevocationGuardian.GracePeriodNotElapsed.selector, alice, block.timestamp + GRACE_PERIOD)
        );
        guardian.startUnwind(alice);
    }

    function test_StartUnwind_RevertsIfNotFlagged() public {
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.NotFlagged.selector, alice));
        guardian.startUnwind(alice);
    }

    function test_StartUnwind_SelfCureFullyResolves_WhenCollateralCoversDebt() public {
        _observe(alice, true, 20, 0, ComplianceRegistry.Reason.NONE); // 130% ratio
        // Collateral (2000e18) deliberately well above the 1300e18 minimum
        // the 130% ratio requires for 1000e18 principal, the extra
        // headroom is what covers the interest that accrues DURING the
        // grace period (1000e18 * 3600s * 1bps/s = 360e18), so self-cure
        // can still fully clear principal + interest, not just principal.
        vm.prank(alice);
        pool.postCollateral(2000e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        // Freeze -> flag -> grace elapses.
        _observe(alice, false, 20, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);
        vm.warp(block.timestamp + GRACE_PERIOD);

        uint256 debtBefore = pool.currentDebt(alice);
        (uint256 collateralBefore,,,) = pool.positions(alice);

        vm.expectEmit(true, false, false, true);
        emit RevocationGuardian.UnwindStarted(alice, debtBefore, collateralBefore);
        guardian.startUnwind(alice);

        assertEq(pool.currentDebt(alice), 0);
        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED));

        // Residual collateral: posted collateral minus principal+interest applied.
        (uint256 residual,,,) = pool.positions(alice);
        assertEq(residual, collateralBefore - debtBefore);
    }

    function test_StartUnwind_SelfCureInsufficient_SpillsToLiquidation_ThenCompletesUnwind() public {
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE); // 80% ratio -> under-collateralized borrow allowed
        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1200e18); // debt (1200e18) > collateral (1000e18)

        _observe(alice, false, 50, 80, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);
        vm.warp(block.timestamp + GRACE_PERIOD);

        guardian.startUnwind(alice);

        // Self-cure could only apply up to the collateral amount; debt remains.
        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.UNWINDING));
        uint256 remainingDebt = pool.currentDebt(alice);
        assertGt(remainingDebt, 0);
        (uint256 remainingCollateral,,,) = pool.positions(alice);
        assertEq(remainingCollateral, 0); // fully consumed by self-cure

        // completeUnwind must revert while debt remains.
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.UnwindNotComplete.selector, alice, remainingDebt));
        guardian.completeUnwind(alice);

        // Anyone can now permissionlessly liquidate what's left directly against the pool.
        assertFalse(pool.isHealthy(alice));
        vm.prank(liquidator);
        pool.liquidate(alice);
        assertEq(pool.currentDebt(alice), 0);

        // Finalize the guardian's own bookkeeping.
        guardian.completeUnwind(alice);
        (state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED));
    }

    function test_StartUnwind_PermissionlessCallableByAnyone() public {
        _observe(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);
        vm.warp(block.timestamp + GRACE_PERIOD);

        vm.prank(rando);
        guardian.startUnwind(alice); // no revert
    }

    // -------------------------------------------------------------------
    // Interest correctness across the unwind
    // -------------------------------------------------------------------

    function test_InterestAccruesExactlyUpToUnwindMoment() public {
        _observe(alice, true, 20, 0, ComplianceRegistry.Reason.NONE);
        vm.prank(alice);
        pool.postCollateral(2000e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        _observe(alice, false, 20, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);

        // Warp additional time WITHIN the grace period and beyond, and
        // confirm the debt self-cured equals EXACTLY principal + linear
        // interest accrued for the total elapsed time (1 bps/sec on
        // 1000e18 principal), no more, no less, no compounding.
        uint256 totalElapsed = GRACE_PERIOD + 500;
        vm.warp(block.timestamp + totalElapsed);

        uint256 expectedDebt = 1000e18 + (1000e18 * totalElapsed * RATE_BPS_PER_SECOND) / 10_000;
        assertEq(pool.currentDebt(alice), expectedDebt);

        guardian.startUnwind(alice);

        // Self-cure applied exactly expectedDebt (collateral of 2000e18 covers it).
        (uint256 residual,,,) = pool.positions(alice);
        assertEq(residual, 2000e18 - expectedDebt);
        assertEq(pool.currentDebt(alice), 0);
    }

    // -------------------------------------------------------------------
    // completeUnwind()
    // -------------------------------------------------------------------

    function test_CompleteUnwind_RevertsIfNotUnwinding() public {
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.NotUnwinding.selector, alice));
        guardian.completeUnwind(alice);
    }

    // -------------------------------------------------------------------
    // Fairness: residual collateral recoverable even while non-compliant
    // -------------------------------------------------------------------

    function test_ResidualCollateralRecoverable_ByNonCompliantBorrower_AfterResolution() public {
        _observe(alice, true, 20, 0, ComplianceRegistry.Reason.NONE);
        // Extra headroom above the 1300e18 minimum so self-cure covers the
        // interest accrued during grace too (see the identical note in
        // test_StartUnwind_SelfCureFullyResolves_WhenCollateralCoversDebt).
        vm.prank(alice);
        pool.postCollateral(2000e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        _observe(alice, false, 20, 0, ComplianceRegistry.Reason.FROZEN);
        guardian.flag(alice);
        vm.warp(block.timestamp + GRACE_PERIOD);
        guardian.startUnwind(alice); // fully self-cures, resolves

        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED));

        // alice is STILL non-compliant per the registry (never re-observed
        // as compliant), and even stale now if time passed, but debt is 0,
        // so withdrawal must succeed regardless.
        vm.warp(block.timestamp + MAX_STALENESS + 1);
        assertFalse(registry.isCompliant(alice));
        assertFalse(registry.isFresh(alice));

        (uint256 residual,,,) = pool.positions(alice);
        assertGt(residual, 0);

        vm.prank(alice);
        pool.withdrawCollateral(residual);

        (uint256 afterWithdraw,,,) = pool.positions(alice);
        assertEq(afterWithdraw, 0);
    }

    // -------------------------------------------------------------------
    // Full lifecycle, end to end
    // -------------------------------------------------------------------

    function test_FullLifecycle_HealthyToFlaggedToUnwindingToResolved() public {
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.HEALTHY)); // default / never touched

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(500e18);

        _observe(alice, false, 50, 80, ComplianceRegistry.Reason.EXPIRED);
        guardian.flag(alice);
        (state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.FLAGGED));

        vm.warp(block.timestamp + GRACE_PERIOD);
        guardian.startUnwind(alice);
        (state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED)); // self-cure sufficient here

        // Second cycle: borrower can be flagged again after resolution.
        // Re-observe as compliant first, the last observation (FROZEN) is
        // now stale after the warp, and borrow() correctly requires fresh
        // data (see LendingPoolStaleness.t.sol).
        _observe(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(500e18);

        _observe(alice, false, 50, 80, ComplianceRegistry.Reason.BLACKLISTED);
        guardian.flag(alice); // must not revert even though state was RESOLVED
        (state,,,,) = guardian.positions(alice);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.FLAGGED));
    }

    // -------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------

    function test_SetGracePeriod_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        guardian.setGracePeriod(1);

        guardian.setGracePeriod(7200);
        assertEq(guardian.gracePeriod(), 7200);
    }
}
