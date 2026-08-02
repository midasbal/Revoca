// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
 * @notice Part 1 of the RevocationGuardian build: the on-chain staleness
 * guard. These tests exercise exactly the three behaviors that build asked
 * for: fresh+compliant allows borrow; stale blocks borrow even when the
 * last known result was compliant; staleness never blocks risk-decreasing
 * actions (repay, liquidation), plus the withdrawCollateral nuance (gated
 * only while debt > 0).
 */
contract LendingPoolStalenessTest is Test {
    LendingPool pool;
    MockERC20 asset;
    TestComplianceGate complianceGate;
    TestTierOracle tierOracle;
    TestCountrySource countrySource;
    CompliancePolicy policy;

    address owner = address(this);
    address lender1 = address(0x1EA1);
    address alice = address(0xA11CE);
    address liquidator = address(0x11D1D);

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        complianceGate = new TestComplianceGate();
        tierOracle = new TestTierOracle();
        countrySource = new TestCountrySource();
        policy = new CompliancePolicy(owner, 3600, 1800);

        pool = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(complianceGate)),
            ITierOracle(address(tierOracle)),
            ICountrySource(address(countrySource)),
            policy,
            owner,
            1,
            500
        );

        address[3] memory users = [lender1, alice, liquidator];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        vm.prank(lender1);
        pool.deposit(100_000e18);
    }

    function test_Borrow_SucceedsWhenFreshAndCompliant() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);
        // TestComplianceGate defaults every address to fresh=true.

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(500e18);

        assertEq(pool.currentDebt(alice), 500e18);
    }

    function test_Borrow_RevertsWhenStale_EvenIfLastResultWasCompliant() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);
        complianceGate.setStale(alice, true); // last known result IS true, but data is stale

        vm.prank(alice);
        pool.postCollateral(1000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.StaleCompliance.selector, alice));
        pool.borrow(500e18);
    }

    function test_WithdrawCollateral_RevertsWhenStaleAndDebtOutstanding() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0); // 130%

        vm.prank(alice);
        pool.postCollateral(1300e18);
        vm.prank(alice);
        pool.borrow(1000e18);

        complianceGate.setStale(alice, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LendingPool.StaleCompliance.selector, alice));
        pool.withdrawCollateral(1e18);
    }

    function test_WithdrawCollateral_NeverBlockedByStalenessWhenDebtIsZero() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 20, 0);

        vm.prank(alice);
        pool.postCollateral(1000e18); // no borrow at all -> debt == 0

        complianceGate.setStale(alice, true);
        complianceGate.setCompliant(alice, false); // even non-compliant

        // Risk-decreasing (no debt to protect) -> must succeed regardless.
        vm.prank(alice);
        pool.withdrawCollateral(1000e18);

        (uint256 collateral,,,) = pool.positions(alice);
        assertEq(collateral, 0);
    }

    function test_Repay_NeverBlockedByStaleness() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(500e18);

        // Now go stale AND non-compliant, repay must still work.
        complianceGate.setStale(alice, true);
        complianceGate.setCompliant(alice, false);

        vm.prank(alice);
        pool.repay(type(uint256).max);

        assertEq(pool.currentDebt(alice), 0);
    }

    function test_Liquidate_NeverBlockedByStaleness() public {
        complianceGate.setCompliant(alice, true);
        tierOracle.setTier(alice, 50, 80);

        vm.prank(alice);
        pool.postCollateral(1000e18);
        vm.prank(alice);
        pool.borrow(1200e18); // near the 1250e18 max at 80%

        // Tier downgrade makes the position unhealthy.
        tierOracle.setTier(alice, 0, 0);
        assertFalse(pool.isHealthy(alice));

        // Stale AND non-compliant registry data must not block liquidation.
        complianceGate.setStale(alice, true);
        complianceGate.setCompliant(alice, false);

        vm.prank(liquidator);
        pool.liquidate(alice);

        assertEq(pool.currentDebt(alice), 0);
    }

    function test_NeverObserved_IsNotStaleSpecific_ButDefaultsFreshForTestDouble() public view {
        // TestComplianceGate's default (fresh=true for every address) is
        // intentional, see its header. This is the ONE place that default
        // diverges from ComplianceRegistry's real behavior (which treats
        // "never observed" as definitely-not-fresh), documented there.
        assertTrue(complianceGate.isFresh(address(0xDEAD)));
    }
}
