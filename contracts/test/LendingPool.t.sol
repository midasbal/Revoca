// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
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

contract LendingPoolTest is Test {
    LendingPool pool;
    MockERC20 asset;
    TestComplianceGate complianceGate;
    TestTierOracle tierOracle;
    TestCountrySource countrySource;
    CompliancePolicy policy;

    address owner = address(this);
    address lender1 = address(0x1EA1);
    address lender2 = address(0x1EA2);
    address alice = address(0xA11CE); // borrower
    address bob = address(0xB0B); // borrower
    address liquidator = address(0x11D1D);

    // 1 bps of principal per second, deliberately fast so short warps
    // produce clean, easily-hand-checked numbers in tests.
    uint256 constant RATE_BPS_PER_SECOND = 1;
    uint256 constant LIQUIDATION_BONUS_BPS = 500; // 5%
    uint256 constant GRACE_DURATION = 3600; // arbitrary, irrelevant to pool-only tests
    uint256 constant MAX_STALENESS = 1800; // arbitrary, irrelevant to pool-only tests (uses TestComplianceGate, not the registry)

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
            RATE_BPS_PER_SECOND,
            LIQUIDATION_BONUS_BPS
        );

        address[5] memory users = [lender1, lender2, alice, bob, liquidator];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }
    }

    // -------------------------------------------------------------------
    // Lender deposit/withdraw + share accounting
    // -------------------------------------------------------------------

    function test_Deposit_FirstDepositMintsSharesOneToOne() public {
        vm.prank(lender1);
        pool.deposit(1000e18);

        assertEq(pool.sharesOf(lender1), 1000e18);
        assertEq(pool.totalShares(), 1000e18);
        assertEq(pool.idleLiquidity(), 1000e18);
        assertEq(asset.balanceOf(address(pool)), 1000e18);
    }

    function test_Deposit_SecondDepositMintsProportionalShares() public {
        vm.prank(lender1);
        pool.deposit(1000e18);

        vm.prank(lender2);
        pool.deposit(500e18);

        // Pool value was 1000e18 before lender2's deposit, 1:1 with shares
        // at that point, so 500e18 deposited mints 500e18 shares.
        assertEq(pool.sharesOf(lender2), 500e18);
        assertEq(pool.totalShares(), 1500e18);
    }

    function test_Withdraw_BurnsSharesAndReturnsAsset() public {
        vm.prank(lender1);
        pool.deposit(1000e18);

        uint256 balBefore = asset.balanceOf(lender1);
        vm.prank(lender1);
        pool.withdraw(400e18);

        assertEq(asset.balanceOf(lender1), balBefore + 400e18);
        assertEq(pool.sharesOf(lender1), 600e18);
        assertEq(pool.idleLiquidity(), 600e18);
    }

    function test_Withdraw_RevertsAboveShareValue() public {
        vm.prank(lender1);
        pool.deposit(1000e18);

        vm.prank(lender1);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.InsufficientShareValue.selector, 1001e18, 1000e18));
        pool.withdraw(1001e18);
    }

    function test_Withdraw_RevertsAboveIdleLiquidityEvenIfShareValueCovers() public {
        vm.prank(lender1);
        pool.deposit(1000e18);

        // Make alice compliant/high-tier and borrow out most of the liquidity.
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80); // 80% ratio -> can borrow more than collateral
        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(900e18);

        // lender1's share value is still 1000e18 (repayment hasn't happened,
        // totalPooledAssets = idle(100e18) + principalOutstanding(900e18) = 1000e18),
        // but idle liquidity is only 100e18.
        vm.prank(lender1);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.InsufficientLiquidity.selector, 500e18, 100e18));
        pool.withdraw(500e18);
    }

    // -------------------------------------------------------------------
    // Compliance gating
    // -------------------------------------------------------------------

    function test_Borrow_RevertsForNonCompliantBorrower() public {
        _seedLiquidity(100_000e18);

        complianceGate.setCompliant(bob, false); // explicit, though this is the default
        vm.prank(bob);
        pool.postCollateral(1000e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.NotCompliant.selector, bob));
        pool.borrow(100e18);
    }

    function test_Borrow_SucceedsForCompliantBorrower() public {
        _seedLiquidity(100_000e18);

        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0); // 130% ratio

        vm.prank(alice);
        pool.postCollateral(1300e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        assertEq(pool.currentDebt(alice), 1000e18);
    }

    // -------------------------------------------------------------------
    // Tier-derived ratio enforcement
    // -------------------------------------------------------------------

    function test_RatioEnforcement_NullTierGetsSafestRatio() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        // alice's tier is left at TestTierOracle's default (0, 0) -> SAFEST_RATIO_BPS (150%).

        uint256 collateral = 1000e18;
        vm.prank(alice);
        pool.postCollateral(collateral);

        uint16 ratio = pool.currentRatioBps(alice);
        assertEq(ratio, policy.SAFEST_RATIO_BPS());

        uint256 maxDebt = (collateral * pool.BPS_DENOMINATOR()) / ratio;

        vm.prank(alice);
        pool.borrow(maxDebt);
        assertEq(pool.currentDebt(alice), maxDebt);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LendingPool.InsufficientCollateralForBorrow.selector, maxDebt + 1, collateral, ratio)
        );
        pool.borrow(1);
    }

    function test_RatioEnforcement_Tier50SubTier80Gets80PercentRatio() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        uint16 ratio = pool.currentRatioBps(alice);
        assertEq(ratio, 8000);
    }

    function test_UnderCollateralizedBorrow_OnlyForQualifyingTier() public {
        _seedLiquidity(100_000e18);

        // Tier 50 / subTier 80 -> 80% ratio -> borrowing MORE than collateral succeeds.
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);
        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1100e18); // > collateral, allowed at 80% ratio (max is 1250e18)
        assertEq(pool.currentDebt(alice), 1100e18);

        // Tier 0 (null-equivalent) -> 150% ratio -> the SAME borrow amount must fail.
        complianceGate.setCompliant(bob, true);
        // bob left at default tier (0,0).
        vm.prank(bob);
        pool.postCollateral(1000e18);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(LendingPool.InsufficientCollateralForBorrow.selector, 1100e18, 1000e18, 15000)
        );
        pool.borrow(1100e18);
    }

    // -------------------------------------------------------------------
    // Interest accrual
    // -------------------------------------------------------------------

    function test_InterestAccruesLinearlyOverTime() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        pool.borrow(10_000e18);

        assertEq(pool.currentDebt(alice), 10_000e18);

        // 1000 seconds at 1 bps/second on 10_000e18 principal:
        // interest = 10_000e18 * 1000 * 1 / 10000 = 1_000e18.
        vm.warp(block.timestamp + 1000);
        assertEq(pool.currentDebt(alice), 11_000e18);

        // Warping again should compound on PRINCIPAL only (linear, not
        // compounding on the already-accrued interest), another 1000
        // seconds adds another exactly 1_000e18, not more.
        vm.warp(block.timestamp + 1000);
        assertEq(pool.currentDebt(alice), 12_000e18);
    }

    function test_InterestAccrualCheckpointsOnInteraction() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        pool.borrow(10_000e18);

        vm.warp(block.timestamp + 1000);
        // Any interaction realizes pending interest into accruedInterest.
        vm.prank(alice);
        pool.repay(1); // trivial repay, just to trigger accrual + checkpoint

        (, uint256 principal, uint256 accruedInterest, uint256 lastAccrual) = pool.positions(alice);
        assertEq(lastAccrual, block.timestamp);
        assertEq(principal + accruedInterest, 10_000e18 + 1_000e18 - 1);
    }

    // -------------------------------------------------------------------
    // Repay
    // -------------------------------------------------------------------

    function test_Repay_ClearsDebtFully() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        pool.borrow(10_000e18);

        vm.warp(block.timestamp + 1000); // +1_000e18 interest

        vm.prank(alice);
        pool.repay(type(uint256).max); // sentinel: repay everything owed

        assertEq(pool.currentDebt(alice), 0);
        (, uint256 principal, uint256 accruedInterest,) = pool.positions(alice);
        assertEq(principal, 0);
        assertEq(accruedInterest, 0);
    }

    function test_Repay_PartialPaysInterestBeforePrincipal() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        pool.borrow(10_000e18);

        vm.warp(block.timestamp + 1000); // +1_000e18 interest, debt = 11_000e18

        vm.prank(alice);
        pool.repay(500e18); // less than accrued interest

        (, uint256 principal, uint256 accruedInterest,) = pool.positions(alice);
        assertEq(accruedInterest, 500e18); // interest partially paid, principal untouched
        assertEq(principal, 10_000e18);
    }

    function test_Repay_RevertsWithNoDebt() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.NoDebt.selector, alice));
        pool.repay(1);
    }

    // -------------------------------------------------------------------
    // Collateral withdrawal
    // -------------------------------------------------------------------

    function test_WithdrawCollateral_BlockedWhileBackingDebt() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0); // 130%

        vm.prank(alice);
        pool.postCollateral(1300e18);
        vm.prank(alice);
        pool.borrow(1000e18); // exactly at the 130% limit

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LendingPool.WithdrawalWouldUnderCollateralize.selector, 1000e18, 1299e18, 13000)
        );
        pool.withdrawCollateral(1e18);
    }

    function test_WithdrawCollateral_SucceedsWhenSurplusExists() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0); // 130%

        vm.prank(alice);
        pool.postCollateral(2000e18); // well above the 1300e18 required for a 1000e18 loan
        vm.prank(alice);
        pool.borrow(1000e18);

        vm.prank(alice);
        pool.withdrawCollateral(500e18); // 1500e18 remaining, still >= 1300e18 required

        (uint256 collateral,,,) = pool.positions(alice);
        assertEq(collateral, 1500e18);
    }

    function test_WithdrawCollateral_FullyAllowedOnceDebtRepaid() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0);

        vm.prank(alice);
        pool.postCollateral(1300e18);
        vm.prank(alice);
        pool.borrow(1000e18);
        vm.prank(alice);
        pool.repay(type(uint256).max);

        vm.prank(alice);
        pool.withdrawCollateral(1300e18);

        (uint256 collateral,,,) = pool.positions(alice);
        assertEq(collateral, 0);
    }

    // -------------------------------------------------------------------
    // Liquidation
    // -------------------------------------------------------------------

    function test_Liquidate_RevertsWhenPositionHealthy() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(100e18); // well within limits

        vm.expectRevert(abi.encodeWithSelector(LendingPool.PositionHealthy.selector, alice));
        pool.liquidate(alice);
    }

    function test_Liquidate_UnhealthyPositionAfterTierDowngrade() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80); // 80% ratio

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1200e18); // near the 1250e18 max at 80%

        assertTrue(pool.isHealthy(alice));

        // Tier downgrade (mid-loan compliance/tier change), no price moved,
        // no time passed. Ratio requirement jumps to 150%, position is now
        // massively under-collateralized purely from the tier change.
        tierOracle.setTier(alice, 0, 0);
        assertFalse(pool.isHealthy(alice));

        uint256 debt = pool.currentDebt(alice); // 1200e18
        uint256 expectedSeize = (debt * 10_500) / 10_000; // debt + 5% bonus = 1260e18, but capped at posted collateral (1000e18)
        expectedSeize = expectedSeize > 1000e18 ? 1000e18 : expectedSeize;

        uint256 liquidatorAssetBefore = asset.balanceOf(liquidator);
        vm.prank(liquidator);
        pool.liquidate(alice);

        assertEq(pool.currentDebt(alice), 0);
        (uint256 remainingCollateral,,,) = pool.positions(alice);
        assertEq(remainingCollateral, 1000e18 - expectedSeize);
        assertEq(asset.balanceOf(liquidator), liquidatorAssetBefore - debt + expectedSeize);
    }

    function test_Liquidate_RevertsWithNoDebt() public {
        vm.expectRevert(abi.encodeWithSelector(LendingPool.NoDebt.selector, alice));
        pool.liquidate(alice);
    }

    // -------------------------------------------------------------------
    // Caps
    // -------------------------------------------------------------------

    function test_MaxBorrowPerUserCap() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        // Borrow caps live on CompliancePolicy now (docs/ROADMAP.md Phase 2a)
        //, setDefaultBorrowCap applies to every tier with no explicit
        // per-tier override, equivalent to the old flat maxBorrowPerUser.
        policy.setDefaultBorrowCap(500e18);

        vm.prank(alice);
        pool.postCollateral(10_000e18); // plenty of collateral, cap is the binding constraint

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ExceedsUserBorrowCap.selector, 501e18, 500e18));
        pool.borrow(501e18);

        vm.prank(alice);
        pool.borrow(500e18); // exactly at cap succeeds
        assertEq(pool.currentDebt(alice), 500e18);
    }

    function test_TierBorrowCap_OverridesDefaultForThatTierOnly() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        complianceGate.setCompliant(bob, true);
        tierOracle.setTier(alice, 50, 80);
        tierOracle.setTier(bob, 20, 0);

        policy.setDefaultBorrowCap(10_000e18);
        policy.setTierBorrowCap(50, 300e18); // tier 50 gets a tighter override

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ExceedsUserBorrowCap.selector, 301e18, 300e18));
        pool.borrow(301e18);

        // bob (tier 20, no override) still gets the default cap.
        vm.prank(bob);
        pool.postCollateral(10_000e18);
        vm.prank(bob);
        pool.borrow(5000e18); // well above alice's tier-50 override, fine under the default
        assertEq(pool.currentDebt(bob), 5000e18);
    }

    function test_MaxTotalBorrowCap() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        complianceGate.setCompliant(bob, true);
        tierOracle.setTier(alice, 50, 80);
        tierOracle.setTier(bob, 50, 80);

        policy.setMaxTotalBorrow(1500e18);

        vm.prank(alice);
        pool.postCollateral(10_000e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        vm.prank(bob);
        pool.postCollateral(10_000e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.ExceedsPoolBorrowCap.selector, 1501e18, 1500e18));
        pool.borrow(501e18);

        vm.prank(bob);
        pool.borrow(500e18); // exactly at the pool-wide cap succeeds
        assertEq(pool.totalPrincipalOutstanding(), 1500e18);
    }

    function test_OnlyOwnerCanSetCaps() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        policy.setDefaultBorrowCap(1);
    }

    // -------------------------------------------------------------------
    // Pause
    // -------------------------------------------------------------------

    function test_Pause_BlocksEntryFunctions() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        pool.pause();

        vm.prank(lender1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.deposit(1e18);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.postCollateral(1e18);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.borrow(1e18);
    }

    function test_Pause_DoesNotBlockExitFunctions() public {
        _seedLiquidity(100_000e18);
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(500e18);

        pool.pause();

        // repay, withdrawCollateral (down to a safe amount), and lender
        // withdraw must all still work while paused.
        vm.prank(alice);
        pool.repay(100e18);

        vm.prank(lender1);
        pool.withdraw(1e18);

        // liquidate also must still work while paused (not exercised as
        // unhealthy here, but confirm it doesn't revert due to Pausable by
        // checking it reverts with PositionHealthy, not EnforcedPause).
        vm.expectRevert(abi.encodeWithSelector(LendingPool.PositionHealthy.selector, alice));
        pool.liquidate(alice);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _seedLiquidity(uint256 amount) internal {
        vm.prank(lender1);
        pool.deposit(amount);
    }
}
