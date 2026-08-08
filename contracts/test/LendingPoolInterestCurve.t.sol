// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {LendingPool} from "../src/LendingPool.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ICountrySource} from "../src/interfaces/ICountrySource.sol";
import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {TestComplianceGate} from "../src/test/TestComplianceGate.sol";
import {TestTierOracle} from "../src/test/TestTierOracle.sol";
import {TestCountrySource} from "../src/test/TestCountrySource.sol";
import {MockERC20} from "../src/test/MockERC20.sol";

/**
 * @notice Covers the utilization-based interest curve added to
 * LendingPool.sol (docs/ROADMAP.md's refinement backlog, "Interest model",
 * near-necessary). The curve: `currentInterestRateBpsPerSecond()` = a
 * two-slope function of `currentUtilizationBps()`, see LendingPool.sol's
 * header for the exact formula. This suite proves: the rate at 0%
 * utilization equals the base rate; the rate climbs correctly through the
 * pre-kink slope, at the kink boundary exactly, and through the post-kink
 * slope; the curve is monotonic in utilization; interest actually accrues
 * over real elapsed time (via `vm.warp`) at the rate the curve predicts;
 * and a kink of 100% collapses the model to a single slope, exactly as
 * documented. Existing LendingPool.t.sol / RevocationGuardian.t.sol tests
 * (unchanged) already prove the default (slope1=slope2=0) curve behaves
 * identically to the old flat-rate model, so that regression coverage is
 * not duplicated here.
 */
contract LendingPoolInterestCurveTest is Test {
    LendingPool pool;
    MockERC20 asset;
    TestComplianceGate complianceGate;
    TestTierOracle tierOracle;
    TestCountrySource countrySource;
    CompliancePolicy policy;

    address owner = address(this);
    address lender = address(0x1EA1);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant BASE_RATE = 1; // 1 bps/sec at 0% utilization
    uint256 constant SLOPE1 = 9; // ramps to 10 bps/sec at the kink
    uint256 constant SLOPE2 = 190; // ramps steeply beyond the kink, up to 200 bps/sec at 100%
    uint16 constant KINK_BPS = 8_000; // 80%
    uint256 constant LIQUIDATION_BONUS_BPS = 500;
    uint256 constant GRACE_DURATION = 3600;
    uint256 constant MAX_STALENESS = 1800;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        complianceGate = new TestComplianceGate();
        tierOracle = new TestTierOracle();
        countrySource = new TestCountrySource();
        policy = new CompliancePolicy(owner, GRACE_DURATION, MAX_STALENESS);

        pool = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(complianceGate)),
            ITierOracle(address(tierOracle)),
            ICountrySource(address(countrySource)),
            policy,
            owner,
            BASE_RATE,
            LIQUIDATION_BONUS_BPS
        );

        pool.setSlope1BpsPerSecond(SLOPE1);
        pool.setSlope2BpsPerSecond(SLOPE2);
        pool.setKinkUtilizationBps(KINK_BPS);

        address[3] memory users = [lender, alice, bob];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 10_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        complianceGate.setCompliant(alice, true);
        complianceGate.setCompliant(bob, true);
        tierOracle.setTier(alice, 50, 80); // 80% ratio band, comfortably under-collateralized-friendly
        tierOracle.setTier(bob, 50, 80);
    }

    function _borrowToUtilization(address borrower, uint256 collateral, uint256 borrowAmount) internal {
        vm.startPrank(borrower);
        pool.postCollateral(collateral);
        pool.borrow(borrowAmount);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------
    // Rate at fixed utilization points
    // -------------------------------------------------------------------

    function test_Rate_AtZeroUtilization_EqualsBaseRate() public view {
        assertEq(pool.currentUtilizationBps(), 0);
        assertEq(pool.currentInterestRateBpsPerSecond(), BASE_RATE);
    }

    function test_Rate_AtZeroUtilization_EvenWithIdleLiquidity() public {
        // Liquidity with nothing borrowed against it is still 0% utilization.
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        assertEq(pool.currentUtilizationBps(), 0);
        assertEq(pool.currentInterestRateBpsPerSecond(), BASE_RATE);
    }

    function test_Rate_ExactlyAtKink_EqualsBasePlusSlope1() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        // Borrow exactly 80% of pooled assets, landing utilization exactly at the kink.
        _borrowToUtilization(alice, 10_000_000e18, 800_000e18);

        assertEq(pool.currentUtilizationBps(), KINK_BPS);
        assertEq(pool.currentInterestRateBpsPerSecond(), BASE_RATE + SLOPE1);
    }

    function test_Rate_MidPreKinkUtilization_InterpolatesLinearly() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        // 40% utilization, exactly half of the 80% kink.
        _borrowToUtilization(alice, 10_000_000e18, 400_000e18);

        assertEq(pool.currentUtilizationBps(), 4_000);
        // rate = base + slope1 * (4000/8000) = 1 + 9*0.5 = 1 + 4 = 5 (integer floor)
        assertEq(pool.currentInterestRateBpsPerSecond(), BASE_RATE + (SLOPE1 * 4_000) / KINK_BPS);
    }

    function test_Rate_PostKinkUtilization_UsesSteeperSlope2() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        // 90% utilization, 10 points past the 80% kink.
        _borrowToUtilization(alice, 10_000_000e18, 900_000e18);

        assertEq(pool.currentUtilizationBps(), 9_000);
        uint256 rateAtKink = BASE_RATE + SLOPE1;
        uint256 expected = rateAtKink + (SLOPE2 * 1_000) / (10_000 - KINK_BPS);
        assertEq(pool.currentInterestRateBpsPerSecond(), expected);
    }

    function test_Rate_AtFullUtilization_EqualsBasePlusSlope1PlusSlope2() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        _borrowToUtilization(alice, 10_000_000e18, 1_000_000e18);

        assertEq(pool.currentUtilizationBps(), 10_000);
        assertEq(pool.currentInterestRateBpsPerSecond(), BASE_RATE + SLOPE1 + SLOPE2);
    }

    // -------------------------------------------------------------------
    // Monotonicity
    // -------------------------------------------------------------------

    function test_Rate_IsMonotonicNonDecreasing_AcrossIncreasingUtilization() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);

        vm.prank(alice);
        pool.postCollateral(10_000_000e18);

        uint256 previousRate = pool.currentInterestRateBpsPerSecond();
        // Increments, not cumulative totals, summing to 900_000e18 (90% of
        // the 1_000_000e18 deposit), well within the pool's liquidity.
        uint256[6] memory borrowSteps = [uint256(50_000e18), 100_000e18, 150_000e18, 200_000e18, 200_000e18, 200_000e18];

        for (uint256 i = 0; i < borrowSteps.length; i++) {
            vm.prank(alice);
            pool.borrow(borrowSteps[i]);

            uint256 newRate = pool.currentInterestRateBpsPerSecond();
            assertGe(newRate, previousRate, "rate must never decrease as utilization increases");
            previousRate = newRate;
        }
    }

    function test_Rate_DecreasesWhenUtilizationDropsViaRepay() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);
        _borrowToUtilization(alice, 10_000_000e18, 900_000e18);

        uint256 rateBeforeRepay = pool.currentInterestRateBpsPerSecond();

        vm.prank(alice);
        pool.repay(500_000e18);

        uint256 rateAfterRepay = pool.currentInterestRateBpsPerSecond();
        assertLt(rateAfterRepay, rateBeforeRepay, "repaying should lower utilization and the rate with it");
    }

    // -------------------------------------------------------------------
    // Real accrual over elapsed time, via vm.warp
    // -------------------------------------------------------------------

    function test_InterestAccrues_AtCurrentRate_OverElapsedTime() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);
        _borrowToUtilization(alice, 10_000_000e18, 400_000e18); // 40% utilization, pre-kink

        uint256 rate = pool.currentInterestRateBpsPerSecond();
        uint256 principalBefore = 400_000e18;

        vm.warp(block.timestamp + 1000);

        uint256 expectedPending = (principalBefore * 1000 * rate) / 10_000;
        assertEq(pool.currentDebt(alice), principalBefore + expectedPending);
    }

    function test_InterestAccrual_UsesRateAtRealizationTime_NotAtBorrowTime() public {
        vm.prank(lender);
        pool.deposit(1_000_000e18);
        _borrowToUtilization(alice, 10_000_000e18, 400_000e18); // 40% utilization

        uint256 rateAtBorrow = pool.currentInterestRateBpsPerSecond();

        // A second borrower pushes utilization up before any time passes
        // for alice's own position, changing the rate her NEXT accrual
        // will use, per this contract's documented "current rate at
        // realization time" simplification (see LendingPool.sol header,
        // simplification #2b).
        _borrowToUtilization(bob, 10_000_000e18, 500_000e18); // total utilization now 90%
        uint256 rateAfterBobBorrows = pool.currentInterestRateBpsPerSecond();
        assertGt(rateAfterBobBorrows, rateAtBorrow, "bob's borrow should have raised utilization and the rate");

        vm.warp(block.timestamp + 500);

        uint256 expectedPending = (400_000e18 * 500 * rateAfterBobBorrows) / 10_000;
        assertEq(pool.currentDebt(alice), 400_000e18 + expectedPending, "alice's pending interest uses the rate live at realization, not at her own borrow time");
    }

    function test_InterestAccrual_MatchesFlatRateBehavior_WhenUtilizationConstant() public {
        // With slopes zeroed and a single borrower whose utilization never
        // changes between accruals, this must match the old flat-rate
        // formula exactly, principal * elapsed * baseRate / 10_000.
        pool.setSlope1BpsPerSecond(0);
        pool.setSlope2BpsPerSecond(0);

        vm.prank(lender);
        pool.deposit(1_000_000e18);
        _borrowToUtilization(alice, 10_000_000e18, 250_000e18);

        vm.warp(block.timestamp + 3600);

        uint256 expected = 250_000e18 + (250_000e18 * 3600 * BASE_RATE) / 10_000;
        assertEq(pool.currentDebt(alice), expected);
    }

    // -------------------------------------------------------------------
    // Kink at 100% disables slope2 (single-slope mode)
    // -------------------------------------------------------------------

    function test_KinkAtFullUtilization_DisablesSlope2Segment() public {
        pool.setKinkUtilizationBps(10_000); // 100%, per this contract's documented "optional kink"

        vm.prank(lender);
        pool.deposit(1_000_000e18);
        _borrowToUtilization(alice, 10_000_000e18, 990_000e18); // 99% utilization, would be post-kink at 80%

        assertEq(pool.currentUtilizationBps(), 9_900);
        // Entirely within the slope1 segment now, since kink is 100%.
        uint256 expected = BASE_RATE + (SLOPE1 * 9_900) / 10_000;
        assertEq(pool.currentInterestRateBpsPerSecond(), expected);
    }

    // -------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------

    function test_SetBaseRate_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setBaseRateBpsPerSecond(5);
    }

    function test_SetSlope1_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setSlope1BpsPerSecond(5);
    }

    function test_SetSlope2_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setSlope2BpsPerSecond(5);
    }

    function test_SetKink_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pool.setKinkUtilizationBps(5_000);
    }

    function test_SetKink_RevertsOnZero() public {
        vm.expectRevert(abi.encodeWithSelector(LendingPool.InvalidKinkUtilization.selector, uint16(0)));
        pool.setKinkUtilizationBps(0);
    }

    function test_SetKink_RevertsAboveDenominator() public {
        vm.expectRevert(abi.encodeWithSelector(LendingPool.InvalidKinkUtilization.selector, uint16(10_001)));
        pool.setKinkUtilizationBps(10_001);
    }
}
