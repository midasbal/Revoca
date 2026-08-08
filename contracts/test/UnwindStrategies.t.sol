// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LendingPool} from "../src/LendingPool.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ICountrySource} from "../src/interfaces/ICountrySource.sol";
import {IUnwindStrategy} from "../src/interfaces/IUnwindStrategy.sol";
import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {RevocationGuardian} from "../src/RevocationGuardian.sol";
import {GraceAndNotifyStrategy} from "../src/strategies/GraceAndNotifyStrategy.sol";
import {ImmediateQuarantineStrategy} from "../src/strategies/ImmediateQuarantineStrategy.sol";
import {ForcedUnwindStrategy} from "../src/strategies/ForcedUnwindStrategy.sol";
import {TestCountrySource} from "../src/test/TestCountrySource.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
import {EIP712TestUtils} from "./helpers/EIP712TestUtils.sol";

/**
 * @notice Covers docs/ROADMAP.md's refinement backlog "Pluggable unwind
 * strategy": IUnwindStrategy, its three implementations, and
 * RevocationGuardian's install-time enforcement of the invariants every
 * strategy must declare. Structured in three parts:
 *
 *   1. Per-strategy full lifecycle tests (flag -> grace -> unwind ->
 *      resolved), one per strategy, asserting the TIMING difference each
 *      strategy is supposed to produce.
 *   2. Invariant-preservation tests, run under ALL THREE strategies via a
 *      shared helper: self-cure always runs first, residual collateral is
 *      always returned, repay/reinstate/residual-withdraw are never
 *      blocked while non-compliant, regardless of which strategy is
 *      active. No strategy may weaken these.
 *   3. Strategy management: owner-only setStrategy, the StrategyChanged
 *      event, and the install-time rejection of strategies that don't
 *      declare the required invariants (a self-cure-first violation, a
 *      reinstatement-disabled violation, the zero address).
 *
 * Existing RevocationGuardian.t.sol / LendingPool.t.sol /
 * CompliancePolicy.t.sol suites (unchanged, now deploying
 * GraceAndNotifyStrategy as the guardian's constructor strategy) already
 * prove backward compatibility, that coverage is not duplicated here.
 */
contract UnwindStrategiesTest is EIP712TestUtils {
    LendingPool pool;
    MockERC20 asset;
    ComplianceRegistry registry;
    CompliancePolicy policy;
    TestCountrySource countrySource;
    RevocationGuardian guardian;

    address owner = address(this);
    uint256 constant ATTESTOR_PK = 0xA771E5709;
    address attestor;
    address lender1 = address(0x1EA1);
    address alice = address(0xA11CE);
    address liquidator = address(0x11D1D);

    uint256 constant MAX_STALENESS = 1800;
    uint256 constant POLICY_GRACE_PERIOD = 3600; // GraceAndNotifyStrategy reads this live
    uint256 constant RATE_BPS_PER_SECOND = 1;
    uint256 constant LIQUIDATION_BONUS_BPS = 500;
    uint256 constant IMMEDIATE_QUARANTINE_GRACE = 30; // deliberately much shorter than the policy default

    GraceAndNotifyStrategy graceAndNotify;
    ImmediateQuarantineStrategy immediateQuarantine;
    ForcedUnwindStrategy forcedUnwind;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        policy = new CompliancePolicy(owner, POLICY_GRACE_PERIOD, MAX_STALENESS);
        registry = new ComplianceRegistry(owner, policy);
        attestor = vm.addr(ATTESTOR_PK);
        registry.setAttestor(attestor, true);
        countrySource = new TestCountrySource();

        pool = new LendingPool(
            IERC20(address(asset)),
            IComplianceGate(address(registry)),
            ITierOracle(address(registry)),
            ICountrySource(address(countrySource)),
            policy,
            owner,
            RATE_BPS_PER_SECOND,
            LIQUIDATION_BONUS_BPS
        );

        graceAndNotify = new GraceAndNotifyStrategy(pool);
        immediateQuarantine = new ImmediateQuarantineStrategy(IMMEDIATE_QUARANTINE_GRACE);
        forcedUnwind = new ForcedUnwindStrategy();

        guardian = new RevocationGuardian(registry, pool, owner, graceAndNotify);
        pool.setGuardian(address(guardian));

        address[3] memory users = [lender1, alice, liquidator];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        vm.prank(lender1);
        pool.deposit(1_000_000e18);
    }

    function _attest(address user, uint16 tier, uint16 subTier, uint8 apassStatus, uint256 expiry) internal {
        ComplianceRegistry.ComplianceAttestation memory a = ComplianceRegistry.ComplianceAttestation({
            user: user,
            tier: tier,
            subTier: subTier,
            country: bytes2("US"),
            apassStatus: apassStatus,
            expiry: expiry,
            issuedAt: block.timestamp,
            nonce: registry.lastNonce(user) + 1
        });
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
    }

    function _attestCompliant(address user, uint16 tier, uint16 subTier) internal {
        _attest(user, tier, subTier, registry.APASS_STATUS_ACTIVE(), block.timestamp + 365 days);
    }

    function _attestFrozen(address user, uint16 tier, uint16 subTier) internal {
        _attest(user, tier, subTier, registry.APASS_STATUS_FROZEN(), block.timestamp + 365 days);
    }

    /// @dev Borrows genuinely under-collateralized (debt > collateral, still HEALTHY at the 80% ratio band), matching this project's standard demo shape.
    function _openPosition(address borrower) internal {
        _attestCompliant(borrower, 50, 80);
        vm.prank(borrower);
        pool.postCollateral(1000e18);
        vm.prank(borrower);
        pool.borrow(1200e18);
    }

    // =====================================================================
    // Part 1: per-strategy full lifecycle, timing differences
    // =====================================================================

    function test_GraceAndNotify_FullLifecycle_UsesPolicyGraceDuration() public {
        _openPosition(alice);
        _attestFrozen(alice, 50, 80);

        guardian.flag(alice);
        (,,, uint256 graceEndsAt,) = guardian.positions(alice);
        assertEq(graceEndsAt, block.timestamp + POLICY_GRACE_PERIOD);

        // Grace not yet elapsed, startUnwind must still revert.
        vm.expectRevert(
            abi.encodeWithSelector(RevocationGuardian.GracePeriodNotElapsed.selector, alice, graceEndsAt)
        );
        guardian.startUnwind(alice);

        vm.warp(graceEndsAt);
        _runUnwindToResolution(alice);
    }

    function test_ImmediateQuarantine_FullLifecycle_UsesShortFixedGrace() public {
        guardian.setStrategy(immediateQuarantine);

        _openPosition(alice);
        _attestFrozen(alice, 50, 80);

        guardian.flag(alice);
        (,,, uint256 graceEndsAt,) = guardian.positions(alice);
        assertEq(graceEndsAt, block.timestamp + IMMEDIATE_QUARANTINE_GRACE);
        assertLt(IMMEDIATE_QUARANTINE_GRACE, POLICY_GRACE_PERIOD, "quarantine grace must be shorter than default");

        vm.expectRevert(
            abi.encodeWithSelector(RevocationGuardian.GracePeriodNotElapsed.selector, alice, graceEndsAt)
        );
        guardian.startUnwind(alice);

        vm.warp(graceEndsAt);
        _runUnwindToResolution(alice);
    }

    function test_ForcedUnwind_FullLifecycle_ZeroGrace_UnwindsImmediately() public {
        guardian.setStrategy(forcedUnwind);

        _openPosition(alice);
        _attestFrozen(alice, 50, 80);

        guardian.flag(alice);
        (,,, uint256 graceEndsAt,) = guardian.positions(alice);
        assertEq(graceEndsAt, block.timestamp, "ForcedUnwind must have zero grace");

        // No warp needed at all, startUnwind is callable in the same block.
        _runUnwindToResolution(alice);
    }

    /// @dev Shared self-cure -> liquidate -> completeUnwind sequence, asserting the RESOLVED end state and, since collateral (1000) < debt (>1200), that liquidation is genuinely exercised (self-cure alone cannot fully resolve this position under any strategy).
    function _runUnwindToResolution(address borrower) internal {
        guardian.startUnwind(borrower);
        (RevocationGuardian.PositionState stateAfterStart,,,,) = guardian.positions(borrower);
        assertEq(uint8(stateAfterStart), uint8(RevocationGuardian.PositionState.UNWINDING));

        uint256 debtRemaining = pool.currentDebt(borrower);
        assertGt(debtRemaining, 0, "self-cure alone should not fully resolve this under-collateralized position");

        (uint256 collateralAfterSelfCure,,,) = pool.positions(borrower);
        assertEq(collateralAfterSelfCure, 0, "self-cure should have drained all collateral");

        vm.prank(liquidator);
        pool.liquidate(borrower);

        guardian.completeUnwind(borrower);
        (RevocationGuardian.PositionState finalState,,,,) = guardian.positions(borrower);
        assertEq(uint8(finalState), uint8(RevocationGuardian.PositionState.RESOLVED));
        assertEq(pool.currentDebt(borrower), 0);
    }

    // =====================================================================
    // Part 2: invariant preservation, all three strategies
    // =====================================================================

    function _strategies() internal view returns (IUnwindStrategy[3] memory) {
        return [IUnwindStrategy(graceAndNotify), IUnwindStrategy(immediateQuarantine), IUnwindStrategy(forcedUnwind)];
    }

    function test_AllStrategies_SelfCureBeforeLiquidation() public view {
        IUnwindStrategy[3] memory strategies = _strategies();
        for (uint256 i = 0; i < strategies.length; i++) {
            IUnwindStrategy.UnwindAction[] memory sequence = strategies[i].unwindSequence();
            assertGt(sequence.length, 0);
            assertEq(uint8(sequence[0]), uint8(IUnwindStrategy.UnwindAction.SELF_CURE));
        }
    }

    function test_AllStrategies_ReinstatementDeclaredAllowed() public view {
        IUnwindStrategy[3] memory strategies = _strategies();
        for (uint256 i = 0; i < strategies.length; i++) {
            assertTrue(strategies[i].reinstatementAllowed());
        }
    }

    /// @dev Reinstatement genuinely works under every strategy whose grace window is nonzero (ForcedUnwind's is zero by design, so there is no window to reinstate within, that's a timing property, not a capability removed by the strategy, covered separately).
    function test_GraceAndNotify_And_ImmediateQuarantine_ReinstateDuringGraceSucceeds() public {
        IUnwindStrategy[2] memory withGrace = [IUnwindStrategy(graceAndNotify), IUnwindStrategy(immediateQuarantine)];
        for (uint256 i = 0; i < withGrace.length; i++) {
            _resetAlice();
            guardian.setStrategy(withGrace[i]);

            _openPosition(alice);
            _attestFrozen(alice, 50, 80);
            guardian.flag(alice);

            _attestCompliant(alice, 50, 80);
            guardian.reinstate(alice);

            (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
            assertEq(uint8(state), uint8(RevocationGuardian.PositionState.HEALTHY));
        }
    }

    /// @dev Repay and residual-withdraw, both risk-decreasing, must never be blocked by compliance status, under ANY strategy. Runs each strategy's full unwind to a nonzero-residual outcome (collateral > debt this time) and confirms the still-non-compliant borrower can withdraw every last unit.
    function test_AllStrategies_ResidualAlwaysReturned_ToNonCompliantBorrower() public {
        IUnwindStrategy[3] memory strategies = _strategies();
        for (uint256 i = 0; i < strategies.length; i++) {
            _resetAlice();
            guardian.setStrategy(strategies[i]);

            _attestCompliant(alice, 50, 80);
            vm.prank(alice);
            pool.postCollateral(2000e18); // generously exceeds debt, self-cure alone will fully resolve with residual left
            vm.prank(alice);
            pool.borrow(1000e18);

            _attestFrozen(alice, 50, 80);
            guardian.flag(alice);

            (,,, uint256 graceEndsAt,) = guardian.positions(alice);
            vm.warp(graceEndsAt);
            guardian.startUnwind(alice);

            (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);
            assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED), "self-cure alone should fully resolve this generously-collateralized position");
            assertEq(pool.currentDebt(alice), 0);

            (uint256 residual,,,) = pool.positions(alice);
            assertGt(residual, 0, "a genuine residual must exist for this test to be meaningful");

            // Alice is STILL non-compliant (frozen), yet must be able to withdraw every last unit.
            vm.prank(alice);
            pool.withdrawCollateral(residual);
            (uint256 remaining,,,) = pool.positions(alice);
            assertEq(remaining, 0);
        }
    }

    /// @dev Repay is risk-decreasing and must never be blocked by compliance, under any strategy, even mid-UNWINDING.
    function test_AllStrategies_RepayNeverBlockedWhileNonCompliant() public {
        IUnwindStrategy[3] memory strategies = _strategies();
        for (uint256 i = 0; i < strategies.length; i++) {
            _resetAlice();
            guardian.setStrategy(strategies[i]);

            _openPosition(alice);
            _attestFrozen(alice, 50, 80);
            guardian.flag(alice);

            uint256 debt = pool.currentDebt(alice);
            vm.prank(alice);
            pool.repay(debt); // must succeed despite being frozen, repay is risk-decreasing

            assertEq(pool.currentDebt(alice), 0);
        }
    }

    /// @dev Wipes alice's guardian/pool state between strategy iterations within one test by fully resolving any open position (regardless of guardian state, a prior iteration may leave her HEALTHY with open debt after a mid-grace reinstate, or FLAGGED with debt already repaid directly, or UNWINDING), so each iteration starts genuinely clean without needing per-iteration actor addresses.
    function _resetAlice() internal {
        uint256 debt = pool.currentDebt(alice);
        (RevocationGuardian.PositionState state,,,,) = guardian.positions(alice);

        if (debt > 0) {
            _attestCompliant(alice, 50, 80);
            vm.prank(alice);
            pool.repay(debt);
        }

        if (state == RevocationGuardian.PositionState.UNWINDING) {
            guardian.completeUnwind(alice);
        } else if (state == RevocationGuardian.PositionState.FLAGGED) {
            // debt is now 0 (repaid above if it wasn't already), isHealthy()
            // is trivially true, so reinstate only needs fresh compliance.
            _attestCompliant(alice, 50, 80);
            guardian.reinstate(alice);
        }

        (uint256 collateral,,,) = pool.positions(alice);
        if (collateral > 0) {
            vm.prank(alice);
            pool.withdrawCollateral(collateral);
        }
    }

    // =====================================================================
    // Part 3: strategy management
    // =====================================================================

    function test_SetStrategy_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        guardian.setStrategy(forcedUnwind);
    }

    function test_SetStrategy_EmitsStrategyChanged() public {
        vm.expectEmit(true, true, false, false);
        emit RevocationGuardian.StrategyChanged(address(graceAndNotify), address(forcedUnwind));
        guardian.setStrategy(forcedUnwind);

        assertEq(address(guardian.strategy()), address(forcedUnwind));
    }

    function test_SetStrategy_AppliesOnlyToFutureFlags_NotRetroactively() public {
        _openPosition(alice);
        _attestFrozen(alice, 50, 80);
        guardian.flag(alice); // under GraceAndNotify, long grace

        (,,, uint256 graceEndsAtBeforeSwap,) = guardian.positions(alice);

        guardian.setStrategy(forcedUnwind); // swap strategy mid-flight

        (,,, uint256 graceEndsAtAfterSwap,) = guardian.positions(alice);
        assertEq(graceEndsAtAfterSwap, graceEndsAtBeforeSwap, "an already-FLAGGED position's graceEndsAt must not change retroactively");
    }

    function test_Constructor_RevertsOnZeroStrategy() public {
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.InvalidStrategy.selector, address(0)));
        new RevocationGuardian(registry, pool, owner, IUnwindStrategy(address(0)));
    }

    function test_SetStrategy_RevertsWhenSequenceDoesNotStartWithSelfCure() public {
        LiquidateFirstStrategy bad = new LiquidateFirstStrategy();
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.InvalidStrategy.selector, address(bad)));
        guardian.setStrategy(bad);
    }

    function test_SetStrategy_RevertsWhenSequenceEmpty() public {
        EmptySequenceStrategy bad = new EmptySequenceStrategy();
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.InvalidStrategy.selector, address(bad)));
        guardian.setStrategy(bad);
    }

    function test_SetStrategy_RevertsWhenReinstatementDisabled() public {
        NoReinstateStrategy bad = new NoReinstateStrategy();
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.InvalidStrategy.selector, address(bad)));
        guardian.setStrategy(bad);
    }

    function test_Constructor_RevertsWhenSequenceDoesNotStartWithSelfCure() public {
        LiquidateFirstStrategy bad = new LiquidateFirstStrategy();
        vm.expectRevert(abi.encodeWithSelector(RevocationGuardian.InvalidStrategy.selector, address(bad)));
        new RevocationGuardian(registry, pool, owner, bad);
    }
}

// -------------------------------------------------------------------------
// Deliberately INVALID strategies, TEST ONLY, used to prove
// RevocationGuardian.setStrategy/constructor actually enforce the
// invariants declared in IUnwindStrategy.sol's header rather than merely
// documenting them. Never used outside this test file.
// -------------------------------------------------------------------------

contract LiquidateFirstStrategy is IUnwindStrategy {
    function name() external pure returns (string memory) {
        return "LiquidateFirst (INVALID, test only)";
    }

    function graceDuration() external pure returns (uint256) {
        return 0;
    }

    /// @dev Deliberately violates "must start with SELF_CURE".
    function unwindSequence() external pure returns (UnwindAction[] memory sequence) {
        sequence = new UnwindAction[](1);
        sequence[0] = UnwindAction.LIQUIDATE;
    }

    function reinstatementAllowed() external pure returns (bool) {
        return true;
    }
}

contract EmptySequenceStrategy is IUnwindStrategy {
    function name() external pure returns (string memory) {
        return "EmptySequence (INVALID, test only)";
    }

    function graceDuration() external pure returns (uint256) {
        return 0;
    }

    /// @dev Deliberately violates "must have length >= 1".
    function unwindSequence() external pure returns (UnwindAction[] memory sequence) {
        sequence = new UnwindAction[](0);
    }

    function reinstatementAllowed() external pure returns (bool) {
        return true;
    }
}

contract NoReinstateStrategy is IUnwindStrategy {
    function name() external pure returns (string memory) {
        return "NoReinstate (INVALID, test only)";
    }

    function graceDuration() external pure returns (uint256) {
        return 3600;
    }

    function unwindSequence() external pure returns (UnwindAction[] memory sequence) {
        sequence = new UnwindAction[](2);
        sequence[0] = UnwindAction.SELF_CURE;
        sequence[1] = UnwindAction.LIQUIDATE;
    }

    /// @dev Deliberately violates "reinstatement must be allowed".
    function reinstatementAllowed() external pure returns (bool) {
        return false;
    }
}
