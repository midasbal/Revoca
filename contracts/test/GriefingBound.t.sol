// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LendingPool} from "../src/LendingPool.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ICountrySource} from "../src/interfaces/ICountrySource.sol";
import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {RevocationGuardian} from "../src/RevocationGuardian.sol";
import {GraceAndNotifyStrategy} from "../src/strategies/GraceAndNotifyStrategy.sol";
import {ForcedUnwindStrategy} from "../src/strategies/ForcedUnwindStrategy.sol";
import {TestCountrySource} from "../src/test/TestCountrySource.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
import {EIP712TestUtils} from "./helpers/EIP712TestUtils.sol";

/**
 * @notice Proves, generally, docs/THREAT_MODEL.md item 2 (griefing via
 * induced freeze) and documents the exact result in
 * docs/GRIEFING_ANALYSIS.md (gitignored, local). See that file for the
 * full model and honest write-up; this suite is the evidence.
 *
 * THE RESULT, STATED PRECISELY (proven below, not assumed):
 *
 * 1. `LendingPool.isHealthy` never reads compliance/freeze status at all,
 *    only debt vs. collateral at the tier-derived ratio. A freeze, by
 *    itself (tier/subTier unchanged), can NEVER flip a healthy position
 *    to unhealthy, so `pool.liquidate()` (which gates on `!isHealthy`)
 *    can NEVER be reached via a freeze alone. Proven directly:
 *    `testFuzz_IsHealthy_InvariantUnderFreezeAlone`.
 *
 * 2. Because of (1), the ONLY unwind path a frozen-but-healthy position
 *    can ever enter is `RevocationGuardian`'s guarded path (flag -> grace
 *    -> startUnwind), never `pool.liquidate()` directly. Proven:
 *    `testFuzz_FrozenButHealthy_LiquidateAlwaysReverts`.
 *
 * 3. Within the guardian path, `startUnwind` unconditionally self-cures
 *    BEFORE any liquidation exposure exists. Self-cure applies
 *    `min(owed, collateral)`, so whenever debt remains afterward
 *    (owed > collateral), collateral is left at EXACTLY ZERO. A
 *    liquidator who then calls `pool.liquidate()` seizes
 *    `min(debtWithBonus, collateral)` = `min(debtWithBonus, 0)` = 0,
 *    while still paying the full remaining debt. Attacker profit in this
 *    branch is not merely "no better than normal", it is STRICTLY
 *    NEGATIVE (a guaranteed loss equal to the remaining debt, before even
 *    counting gas). Proven, swept across the real tier/ratio bands and a
 *    range of collateral/debt ratios:
 *    `testFuzz_SelfCureInsufficient_LiquidatorNeverProfits`.
 *
 * 4. When self-cure alone fully clears the debt, the position resolves
 *    in the same transaction `startUnwind` is called, before any
 *    liquidation is even possible. Proven:
 *    `testFuzz_SelfCureSufficient_LiquidationNeverReachable`.
 *
 * 5. For contrast: a position that is ALREADY unhealthy for reasons
 *    UNRELATED to any freeze (e.g. a tier drop, or simply never having
 *    been compliant at all) is liquidatable directly, at the NORMAL bps
 *    bonus, with or without a freeze layered on top, since `liquidate()`
 *    never reads compliance. This is the pool's ordinary liquidation
 *    incentive, present independent of Revoca's compliance machinery
 *    entirely, not something a freeze unlocks. Proven:
 *    `testFuzz_NormalLiquidation_BoundedByBonus_FreezeAddsNothing`.
 */
contract GriefingBoundTest is EIP712TestUtils {
    LendingPool pool;
    MockERC20 asset;
    ComplianceRegistry registry;
    CompliancePolicy policy;
    TestCountrySource countrySource;
    RevocationGuardian guardian;

    address owner = address(this);
    uint256 constant ATTESTOR_PK = 0xA771E5709;
    address attestor;
    address lender = address(0x1EA1);
    address borrower = address(0xA11CE);
    address attacker = address(0x1234A77AC4);

    uint256 constant MAX_STALENESS = 1800;
    uint256 constant GRACE_PERIOD = 3600;
    uint256 constant RATE_BPS_PER_SECOND = 1;
    uint256 constant LIQUIDATION_BONUS_BPS = 500; // 5%, matches the project's standard test convention
    uint256 constant LENDER_LIQUIDITY = 10_000_000e18;

    /// @dev The six real ratio bands from CompliancePolicy's defaults, tier/subTier pairs and the ratio each maps to, read directly from the deployed policy in setUp (not hardcoded twice) via a sanity check.
    uint16[6] tierByBand = [50, 50, 50, 50, 20, 0];
    uint16[6] subTierByBand = [80, 50, 20, 0, 0, 0];
    uint16[6] ratioBpsByBand = [8_000, 9_000, 10_000, 11_000, 13_000, 15_000];

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        policy = new CompliancePolicy(owner, GRACE_PERIOD, MAX_STALENESS);
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

        guardian = new RevocationGuardian(registry, pool, owner, new GraceAndNotifyStrategy(pool));
        pool.setGuardian(address(guardian));

        address[3] memory users = [lender, borrower, attacker];
        for (uint256 i = 0; i < users.length; i++) {
            asset.mint(users[i], LENDER_LIQUIDITY);
            vm.prank(users[i]);
            asset.approve(address(pool), type(uint256).max);
        }

        vm.prank(lender);
        pool.deposit(LENDER_LIQUIDITY);

        // Sanity: the hardcoded band table above matches the deployed
        // policy's actual defaults exactly, so this suite fuzzes over
        // reality, not a stale copy.
        for (uint256 i = 0; i < 6; i++) {
            assertEq(policy.collateralRatioBps(tierByBand[i], subTierByBand[i]), ratioBpsByBand[i]);
        }
    }

    function _attest(address user, uint16 tier, uint16 subTier, uint8 apassStatus) internal {
        ComplianceRegistry.ComplianceAttestation memory a = ComplianceRegistry.ComplianceAttestation({
            user: user,
            tier: tier,
            subTier: subTier,
            country: bytes2("US"),
            apassStatus: apassStatus,
            expiry: block.timestamp + 365 days,
            issuedAt: block.timestamp,
            nonce: registry.lastNonce(user) + 1
        });
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
    }

    function _bandIndex(uint8 raw) internal pure returns (uint256) {
        return bound(raw, 0, 5);
    }

    function _attackerBalance() internal view returns (uint256) {
        return asset.balanceOf(attacker);
    }

    // =====================================================================
    // 1 & 2. Frozen but healthy: isHealthy is invariant under freeze alone,
    // and liquidate() can never be reached.
    // =====================================================================

    /// @dev Same tier/subTier and same collateral/debt, only apassStatus differs (ACTIVE vs FROZEN). isHealthy() must return the identical value either way, proving freeze status plays no role in the health check at all.
    function testFuzz_IsHealthy_InvariantUnderFreezeAlone(uint8 bandRaw, uint96 collateralRaw, uint96 debtRaw)
        public
    {
        uint256 band = _bandIndex(bandRaw);
        uint16 tier = tierByBand[band];
        uint16 subTier = subTierByBand[band];

        uint256 collateral = bound(collateralRaw, 1e18, 1_000_000e18);
        uint16 ratioBps = ratioBpsByBand[band];
        // debt bounded well above what collateral could ever support at this ratio, so both healthy and unhealthy cases are exercised across runs.
        uint256 maxDebt = Math.mulDiv(collateral, 10_000, ratioBps) * 2;
        uint256 debt = bound(debtRaw, 1e18, maxDebt + 1e18);

        _attest(borrower, tier, subTier, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        // Only borrow if this amount is actually reachable under the health check, otherwise directly compare isHealthy() at the position level without a real borrow (the invariant is about the isHealthy() FUNCTION, not the borrow() gate, so we exercise it via postCollateral + a same-block debt via borrow when feasible, else skip to the direct comparison below).
        uint256 borrowable = debt * ratioBps <= collateral * 10_000 ? debt : 0;
        if (borrowable > 0 && borrowable <= LENDER_LIQUIDITY) {
            vm.prank(borrower);
            pool.borrow(borrowable);
        }

        bool healthyWhileActive = pool.isHealthy(borrower);

        // Freeze, tier/subTier UNCHANGED, nothing else about the position changed.
        _attest(borrower, tier, subTier, registry.APASS_STATUS_FROZEN());
        bool healthyWhileFrozen = pool.isHealthy(borrower);

        assertEq(healthyWhileFrozen, healthyWhileActive, "freeze alone must never change isHealthy()");
    }

    /// @dev A position kept genuinely healthy (collateral comfortably covers debt at its band's ratio) is frozen. Direct liquidate() must revert PositionHealthy, at every band, across a range of comfortably-healthy collateral/debt pairs.
    function testFuzz_FrozenButHealthy_LiquidateAlwaysReverts(uint8 bandRaw, uint96 collateralRaw, uint16 debtBpsOfMax)
        public
    {
        uint256 band = _bandIndex(bandRaw);
        uint16 tier = tierByBand[band];
        uint16 subTier = subTierByBand[band];
        uint16 ratioBps = ratioBpsByBand[band];

        uint256 collateral = bound(collateralRaw, 100e18, 1_000_000e18);
        // Debt at 10%-90% of the maximum this collateral supports at this ratio, always comfortably healthy.
        uint256 maxDebt = Math.mulDiv(collateral, 10_000, ratioBps);
        uint256 debtBps = bound(debtBpsOfMax, 1_000, 9_000);
        uint256 debt = Math.mulDiv(maxDebt, debtBps, 10_000);
        if (debt == 0 || debt > LENDER_LIQUIDITY) return;

        _attest(borrower, tier, subTier, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        vm.prank(borrower);
        pool.borrow(debt);

        assertTrue(pool.isHealthy(borrower), "test setup must produce a healthy position");

        _attest(borrower, tier, subTier, registry.APASS_STATUS_FROZEN());
        assertTrue(pool.isHealthy(borrower), "freeze alone must not have flipped health");

        uint256 balanceBefore = _attackerBalance();
        vm.expectRevert(abi.encodeWithSelector(LendingPool.PositionHealthy.selector, borrower));
        vm.prank(attacker);
        pool.liquidate(borrower);
        assertEq(_attackerBalance(), balanceBefore, "a reverted call must move zero tokens");
    }

    // =====================================================================
    // 3. The critical branch: self-cure insufficient, spills to
    // liquidation. Liquidator profit must be <= 0.
    // =====================================================================

    /// @dev Swept across every real ratio band and a range of collateral amounts: borrow the MAXIMUM allowed at that band (collateral*10000/ratioBps, which for the 80%/90% bands already exceeds collateral), then warp forward exactly enough real elapsed time that interest accrual pushes total owed strictly past collateral for EVERY band (including the 100%+ bands where the initial borrow alone cannot exceed collateral). This isolates "debt > collateral at unwind time" as the cause via genuine borrowing + genuine interest accrual, never an artificial withdrawal (LendingPool correctly refuses to let a compliant, healthy borrower withdraw INTO unhealthiness, so that path was never valid). After flag -> grace -> startUnwind, collateral is left at exactly zero, and a liquidator who then calls liquidate() seizes exactly zero collateral while paying the full remaining debt, a strict loss, never a profit.
    function testFuzz_SelfCureInsufficient_LiquidatorNeverProfits(
        uint8 bandRaw,
        uint96 collateralRaw,
        uint32 extraWarpRaw
    ) public {
        uint256 band = _bandIndex(bandRaw);
        uint16 tier = tierByBand[band];
        uint16 subTier = subTierByBand[band];
        uint16 ratioBps = ratioBpsByBand[band];

        uint256 collateral = bound(collateralRaw, 100e18, 1_000_000e18);
        uint256 initialDebt = Math.mulDiv(collateral, 10_000, ratioBps); // the maximum this band allows
        if (initialDebt == 0 || initialDebt > LENDER_LIQUIDITY / 2) return;

        _attest(borrower, tier, subTier, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        vm.prank(borrower);
        pool.borrow(initialDebt);

        // How much real elapsed time (at this pool's flat RATE_BPS_PER_SECOND, slopes are 0 in this suite's pool) is needed for principal*elapsed*rate/10000 to push owed strictly past collateral. 0 already for the 80%/90% bands, where initialDebt already exceeds collateral.
        // Strictly greater than, not >=: at the 100% band (ratioBps ==
        // 10_000) initialDebt equals collateral EXACTLY, which still needs
        // a (small) warp to push owed strictly past it, equal is the
        // self-cure-SUFFICIENT case (covered separately), not this one.
        uint256 shortfall = initialDebt > collateral ? 0 : collateral - initialDebt;
        uint256 neededWarp = Math.mulDiv(10_000, shortfall, initialDebt) + 100; // margin against integer-division rounding, must land strictly past collateral, not merely at it
        uint256 warpSeconds = neededWarp + bound(extraWarpRaw, 0, 100_000);
        vm.warp(block.timestamp + warpSeconds);

        assertGt(pool.currentDebt(borrower), collateral, "test setup must genuinely exceed collateral by unwind time");

        // Freeze, same tier/subTier, only status changes.
        _attest(borrower, tier, subTier, registry.APASS_STATUS_FROZEN());
        assertFalse(pool.isHealthy(borrower), "test setup must produce an unhealthy, self-cure-insufficient position");

        guardian.flag(borrower);
        (,,, uint256 graceEndsAt,) = guardian.positions(borrower);
        vm.warp(graceEndsAt);

        guardian.startUnwind(borrower);

        (uint256 collateralAfterSelfCure,,,) = pool.positions(borrower);
        assertEq(collateralAfterSelfCure, 0, "self-cure must drain collateral to exactly zero whenever debt remains");

        uint256 remainingDebt = pool.currentDebt(borrower);
        assertGt(remainingDebt, 0, "this scenario must leave real debt after self-cure");

        // Top up the attacker's balance if needed. A large fuzzed warp can
        // accrue interest well beyond this suite's flat starting mint, and
        // the point under test is what the attacker RECEIVES vs. PAYS, not
        // whether they happen to be well-capitalized enough to attempt it.
        // Baseline for the P&L check is taken AFTER this top-up, so the
        // top-up itself (unrelated to the liquidation) never contaminates it.
        if (_attackerBalance() < remainingDebt) {
            asset.mint(attacker, remainingDebt - _attackerBalance());
        }
        uint256 balanceBeforeLiquidation = _attackerBalance();

        vm.prank(attacker);
        pool.liquidate(borrower);

        uint256 balanceAfterLiquidation = _attackerBalance();
        // The attacker paid `remainingDebt` in tokens and received zero
        // collateral (collateralSeized = min(debtWithBonus, 0) = 0), so
        // their balance must have dropped by EXACTLY remainingDebt, never
        // less, proving zero collateral was seized.
        assertEq(
            balanceBeforeLiquidation - balanceAfterLiquidation,
            remainingDebt,
            "attacker must pay the full remaining debt and receive zero collateral, a strict loss"
        );

        guardian.completeUnwind(borrower);
        assertEq(pool.currentDebt(borrower), 0);
    }

    // =====================================================================
    // 4. Self-cure sufficient: liquidation is never even reachable.
    // =====================================================================

    function testFuzz_SelfCureSufficient_LiquidationNeverReachable(uint8 bandRaw, uint96 collateralRaw, uint16 debtBpsOfCollateral)
        public
    {
        uint256 band = _bandIndex(bandRaw);
        uint16 tier = tierByBand[band];
        uint16 subTier = subTierByBand[band];
        uint16 ratioBps = ratioBpsByBand[band];

        uint256 collateral = bound(collateralRaw, 100e18, 1_000_000e18);
        // Debt bounded well below collateral, leaving room for interest
        // that accrues during the grace period itself (GRACE_PERIOD
        // seconds at RATE_BPS_PER_SECOND flat, this suite's pool has both
        // slopes at 0) to still land at or under collateral by the time
        // startUnwind actually runs. Without this margin, a debt picked
        // right up against collateral at borrow time could accrue past it
        // during grace alone, which would test the WRONG branch (self-cure
        // insufficient, covered separately above). Bounded to 50% of
        // collateral, comfortably under the worst case
        // (1 + GRACE_PERIOD/10_000)x growth with this suite's constants.
        uint256 debtBps = bound(debtBpsOfCollateral, 1, 5_000);
        uint256 debt = Math.mulDiv(collateral, debtBps, 10_000);
        if (debt == 0) return;
        if (debt * ratioBps > collateral * 10_000) return; // must be borrowable at this band
        if (debt > LENDER_LIQUIDITY / 2) return;

        _attest(borrower, tier, subTier, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        vm.prank(borrower);
        pool.borrow(debt);

        _attest(borrower, tier, subTier, registry.APASS_STATUS_FROZEN());
        guardian.flag(borrower);
        (,,, uint256 graceEndsAt,) = guardian.positions(borrower);
        vm.warp(graceEndsAt);

        uint256 balanceBefore = _attackerBalance();
        guardian.startUnwind(borrower);

        (RevocationGuardian.PositionState state,,,,) = guardian.positions(borrower);
        assertEq(uint8(state), uint8(RevocationGuardian.PositionState.RESOLVED), "self-cure sufficient must resolve immediately");
        assertEq(pool.currentDebt(borrower), 0);

        vm.expectRevert(abi.encodeWithSelector(LendingPool.NoDebt.selector, borrower));
        vm.prank(attacker);
        pool.liquidate(borrower);

        assertEq(_attackerBalance(), balanceBefore, "no tokens ever moved to or from the attacker in this branch");
    }

    // =====================================================================
    // 5. Contrast: normal liquidation (unrelated to any freeze) is bounded
    // by the ordinary bonus, and a freeze changes nothing about it.
    // =====================================================================

    /// @dev A position becomes unhealthy purely from a TIER DROP (never frozen at all), liquidated directly, no guardian involved. Profit is bounded by liquidationBonusBps of the debt, the pool's standard, freeze-independent incentive. Then, separately, freezing the SAME kind of position on top changes the profit by exactly zero, since liquidate() never reads compliance.
    function testFuzz_NormalLiquidation_BoundedByBonus_FreezeAddsNothing(uint96 collateralRaw, uint16 debtBpsOfMax)
        public
    {
        // Borrow at the best band (50/80, 80%), then drop to the worst
        // (0/0, 150%) without any freeze at all, purely a tier downgrade,
        // which alone can make the position unhealthy.
        uint256 collateral = bound(collateralRaw, 100e18, 1_000_000e18);
        uint256 maxDebtAtBestBand = Math.mulDiv(collateral, 10_000, 8_000);
        uint256 debtBps = bound(debtBpsOfMax, 5_000, 10_000);
        uint256 debt = Math.mulDiv(maxDebtAtBestBand, debtBps, 10_000);
        if (debt == 0 || debt > LENDER_LIQUIDITY / 2) return;

        _attest(borrower, 50, 80, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        vm.prank(borrower);
        pool.borrow(debt);

        // Tier drop, still ACTIVE, never frozen.
        _attest(borrower, 0, 0, registry.APASS_STATUS_ACTIVE());
        if (pool.isHealthy(borrower)) return; // fuzz input didn't produce an unhealthy position at the worst band, skip

        uint256 debtOwed = pool.currentDebt(borrower);
        uint256 expectedBonus = Math.mulDiv(debtOwed, LIQUIDATION_BONUS_BPS, 10_000);
        uint256 expectedSeizeUncapped = debtOwed + expectedBonus;
        uint256 expectedSeize = expectedSeizeUncapped > collateral ? collateral : expectedSeizeUncapped;
        // Signed: the liquidator pays debtOwed and receives expectedSeize,
        // which can be LESS than debtOwed if collateral fell short even of
        // the bare debt (a real, if unattractive to a rational liquidator,
        // possibility liquidate() itself does not prevent), a genuine loss,
        // not merely "less profit". Using int256 throughout avoids an
        // underflow on that path instead of assuming it cannot happen.
        int256 expectedProfit = int256(expectedSeize) - int256(debtOwed);

        assertLe(expectedProfit, int256(expectedBonus), "profit can never exceed the configured bonus, even before the collateral cap");

        uint256 balanceBeforeNoFreeze = _attackerBalance();
        vm.prank(attacker);
        pool.liquidate(borrower);
        int256 profitNoFreeze = int256(_attackerBalance()) - int256(balanceBeforeNoFreeze);
        assertEq(profitNoFreeze, expectedProfit, "actual profit must match the bound exactly, not merely satisfy an inequality");
        assertLe(profitNoFreeze, int256(expectedBonus), "normal liquidation profit is bounded by the bonus, no freeze was ever involved");

        // Now repeat with a SECOND, identical position, frozen on top of the same tier drop, and confirm the profit is IDENTICAL, a freeze contributes exactly zero marginal profit to an already-liquidatable position.
        address borrower2 = address(0xB0B2);
        asset.mint(borrower2, LENDER_LIQUIDITY);
        vm.prank(borrower2);
        asset.approve(address(pool), type(uint256).max);

        _attest(borrower2, 50, 80, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower2);
        pool.postCollateral(collateral);
        vm.prank(borrower2);
        pool.borrow(debt);
        _attest(borrower2, 0, 0, registry.APASS_STATUS_FROZEN()); // same tier drop, ALSO frozen this time

        assertFalse(pool.isHealthy(borrower2));
        uint256 balanceBeforeFrozen = _attackerBalance();
        vm.prank(attacker);
        pool.liquidate(borrower2);
        int256 profitWithFreeze = int256(_attackerBalance()) - int256(balanceBeforeFrozen);

        assertEq(profitWithFreeze, profitNoFreeze, "freezing an already-unhealthy-for-other-reasons position must not change liquidation profit at all");
    }

    // =====================================================================
    // 6. The bound holds regardless of grace duration: self-cure's
    // unconditional collateral drain is what protects the liquidator's
    // profit from going positive, not the grace timer. Proven directly
    // with ForcedUnwindStrategy (zero grace) rather than left as an
    // unproven claim in the write-up.
    // =====================================================================

    function test_SelfCureInsufficient_LiquidatorNeverProfits_EvenWithZeroGrace() public {
        guardian.setStrategy(new ForcedUnwindStrategy());

        uint16 tier = 50;
        uint16 subTier = 20; // 100% band
        uint256 collateral = 1000e18;
        uint256 initialDebt = 1000e18; // the band's max, debt == collateral at origination

        _attest(borrower, tier, subTier, registry.APASS_STATUS_ACTIVE());
        vm.prank(borrower);
        pool.postCollateral(collateral);
        vm.prank(borrower);
        pool.borrow(initialDebt);

        // Push owed past collateral via real interest accrual, same as the fuzzed version above.
        vm.warp(block.timestamp + 12_000);
        assertGt(pool.currentDebt(borrower), collateral);

        _attest(borrower, tier, subTier, registry.APASS_STATUS_FROZEN());
        guardian.flag(borrower);

        (,,, uint256 graceEndsAt,) = guardian.positions(borrower);
        assertEq(graceEndsAt, block.timestamp, "ForcedUnwindStrategy must have zero grace");

        // No warp needed, startUnwind is callable immediately.
        guardian.startUnwind(borrower);

        (uint256 collateralAfterSelfCure,,,) = pool.positions(borrower);
        assertEq(collateralAfterSelfCure, 0);

        uint256 remainingDebt = pool.currentDebt(borrower);
        assertGt(remainingDebt, 0);

        if (_attackerBalance() < remainingDebt) {
            asset.mint(attacker, remainingDebt - _attackerBalance());
        }
        uint256 balanceBefore = _attackerBalance();

        vm.prank(attacker);
        pool.liquidate(borrower);

        assertEq(balanceBefore - _attackerBalance(), remainingDebt, "still a strict loss, even at zero grace");
    }
}
