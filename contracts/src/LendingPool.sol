// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {ITierOracle} from "./interfaces/ITierOracle.sol";
import {ICountrySource} from "./interfaces/ICountrySource.sol";
import {CompliancePolicy} from "./CompliancePolicy.sol";

/**
 * @title LendingPool
 * @notice Single-asset, single-pool, tier-scaled under-collateralized
 * lending pool. Core mechanics only, see CLAUDE.md/docs/PROJECT.md for
 * Revoca's full scope. The compliance-triggered unwind (RevocationGuardian)
 * is deliberately NOT built here; this contract's mechanics (in particular
 * `liquidate`) are kept clean and permissionless so the guardian can call
 * into them without needing pool changes.
 *
 * SIMPLIFICATIONS, DOCUMENTED (not hidden):
 *
 * 1. Collateral and the lent asset are the SAME ERC20 (`asset`). Real
 *    protocols post collateral in a different asset than what's borrowed,
 *    which introduces price risk requiring an oracle. Using one asset for
 *    both means there is NO price risk here at all, a position's health
 *    changes only via (a) interest accruing (debt grows) or (b) the
 *    borrower's tier changing (their required ratio changes). Two-asset
 *    support is an explicit non-goal (see docs/PROJECT.md).
 *
 * 2. Lender share pricing realizes interest only at repayment, not as it
 *    accrues. `totalPooledAssets() = idleLiquidity + totalPrincipalOutstanding`
 *    grows by exactly the interest portion of each `repay`/`liquidate` call,
 *    not continuously as each borrower's interest accrues on paper. A real
 *    protocol (Compound/Aave-style) tracks a global interest index so share
 *    price reflects unrealized interest continuously, that's meaningfully
 *    more complex and isn't needed for a single-pool hackathon demo. Net
 *    effect: a lender depositing or withdrawing immediately before a large
 *    repayment gets a slightly-off share of interest that was "in flight."
 *    Accepted as a known, documented simplification.
 *
 * 2b. UTILIZATION-BASED INTEREST, NOT TIME-WEIGHTED ACROSS RATE CHANGES.
 *    The per-second rate is a function of live utilization
 *    (`totalPrincipalOutstanding / totalPooledAssets()`), a standard
 *    two-slope curve (see `currentInterestRateBpsPerSecond` below), so it
 *    moves every time a borrow/repay/deposit/withdraw changes utilization.
 *    A position's pending interest since its last accrual checkpoint is
 *    still computed as `principal * elapsedSeconds * rate`, using the
 *    CURRENT rate at the moment accrual is realized, not a time-weighted
 *    average of whatever the rate was at each moment during the elapsed
 *    interval. This is the same lazy-realization style as simplification
 *    #2 above (interest is only ever realized at an interaction point, not
 *    continuously), extended to a rate that can itself move between
 *    interactions. Accepted as a known, documented simplification, not
 *    hidden: `backend/src/audit/reconstruct.ts`'s self-cross-check makes
 *    the identical approximation for the identical reason, see its
 *    `projectPendingInterest` comment.
 *
 * 3. Liquidation always requires the liquidator to repay the FULL
 *    outstanding debt (no partial liquidation). If a position's collateral
 *    has fallen below `debt + bonus` (e.g. a severe tier downgrade after
 *    heavy interest accrual), the liquidator receives only the collateral
 *    that exists and still pays full debt, the protocol does not currently
 *    socialize that shortfall. Real bad-debt handling is out of scope here;
 *    it's a candidate for the guardian or a future session.
 *
 * COMPLIANCE POLICY: min-tier/subTier eligibility, country eligibility,
 * collateral ratio bands, and borrow caps are NOT this contract's own
 * state, they live on `policy` (CompliancePolicy), a single, shared,
 * event-logged source of truth also read by anything else that needs to
 * answer "what is this pool's compliance policy" (see CompliancePolicy.sol
 * and docs/ROADMAP.md Phase 2a). This contract never duplicates a value
 * `policy` already holds.
 *
 * Safety: Ownable + Pausable + ReentrancyGuard + SafeERC20 + custom errors
 * (no string reverts). `pause()` blocks entry (deposit, postCollateral,
 * borrow) only, repay, withdraw, withdrawCollateral, and liquidate remain
 * callable while paused, so no user or lender is ever trapped and the pool
 * can still be de-risked during an incident.
 */
contract LendingPool is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 10_000 basis points = 100%. A units convention shared with CompliancePolicy, intentionally duplicated (not a configurable policy value, so it isn't subject to the "single source of truth" rule; see CompliancePolicy.sol's identical constant).
    uint16 public constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Immutables, seams, not swappable post-deployment this session (see
    // docs/ARCHITECTURE.md; a real Design A/B gate and tier attestor are
    // future work, not this contract's concern).
    // ---------------------------------------------------------------------

    IERC20 public immutable asset;
    IComplianceGate public immutable complianceGate;
    ITierOracle public immutable tierOracle;
    ICountrySource public immutable countrySource;
    CompliancePolicy public immutable policy;

    // ---------------------------------------------------------------------
    // Owner-settable parameters (pool-economic, NOT compliance policy, see
    // this contract's header on why these stay here rather than moving to
    // CompliancePolicy).
    // ---------------------------------------------------------------------

    /**
     * @notice Utilization-based interest curve, a standard two-slope
     * (Aave/Compound-style) model, replacing the former flat rate.
     * `currentInterestRateBpsPerSecond()` is the live per-second bps rate
     * applied to PRINCIPAL only (never to already-accrued interest, so
     * interest stays linear/non-compounding within a position's life,
     * exactly as before), as a function of `currentUtilizationBps()`:
     *
     *   - utilization <= kinkUtilizationBps:
     *       rate = baseRateBpsPerSecond
     *            + slope1BpsPerSecond * utilization / kinkUtilizationBps
     *   - utilization > kinkUtilizationBps:
     *       rate = baseRateBpsPerSecond + slope1BpsPerSecond
     *            + slope2BpsPerSecond * (utilization - kinkUtilizationBps)
     *              / (BPS_DENOMINATOR - kinkUtilizationBps)
     *
     * `baseRateBpsPerSecond` is the rate at 0% utilization (a pool with no
     * borrows still costs lenders nothing extra, but also earns nothing).
     * `slope1BpsPerSecond` ramps the rate up to `baseRateBpsPerSecond +
     * slope1BpsPerSecond` exactly at the kink, the "normal" operating
     * range. `slope2BpsPerSecond` ramps steeper beyond the kink, an
     * incentive for lenders to add liquidity (and borrowers to repay)
     * before the pool runs dry. Setting `kinkUtilizationBps ==
     * BPS_DENOMINATOR` (100%) disables the second segment entirely (it's
     * never reached, since utilization is capped at 100% by construction,
     * see `currentUtilizationBps`), collapsing this to a single-slope
     * model, the kink is genuinely optional. Both segments are
     * non-negative and utilization is monotonic in both principal
     * outstanding and idle liquidity, so the curve itself is monotonic:
     * more borrowing relative to pool size never lowers the rate.
     */
    uint256 public baseRateBpsPerSecond;
    uint256 public slope1BpsPerSecond;
    uint256 public slope2BpsPerSecond;

    /// @notice Utilization (bps of BPS_DENOMINATOR) at which slope2 starts applying. Must be in (0, BPS_DENOMINATOR].
    uint16 public kinkUtilizationBps;

    /// @notice Bonus (in bps of debt repaid) a liquidator receives on top of debt value, from the seized collateral.
    uint256 public liquidationBonusBps;

    // ---------------------------------------------------------------------
    // Pool accounting
    // ---------------------------------------------------------------------

    /// @notice Asset held for lending purposes, available to withdraw or lend out. Excludes collateral.
    uint256 public idleLiquidity;

    /// @notice Sum of all borrowers' outstanding principal (lent out, not held by the contract).
    uint256 public totalPrincipalOutstanding;

    /// @notice Sum of all borrowers' posted collateral held by the contract. Tracked separately from lending liquidity even though it's the same token.
    uint256 public totalCollateral;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    struct BorrowerPosition {
        uint256 collateral;
        uint256 principal;
        uint256 accruedInterest;
        uint256 lastAccrualTimestamp;
    }

    mapping(address => BorrowerPosition) public positions;

    // ---------------------------------------------------------------------
    // Events, one per state change, with enough data for a dashboard/audit trail.
    // ---------------------------------------------------------------------

    event Deposit(address indexed lender, uint256 amount, uint256 sharesMinted, uint256 totalShares);
    event Withdraw(address indexed lender, uint256 amount, uint256 sharesBurned, uint256 totalShares);
    event CollateralPosted(address indexed borrower, uint256 amount, uint256 newCollateralBalance);
    event Borrow(
        address indexed borrower,
        uint256 amount,
        uint256 newPrincipal,
        uint256 newDebt,
        uint16 tier,
        uint16 subTier,
        uint16 ratioBps
    );
    event Repay(address indexed borrower, uint256 amount, uint256 principalPaid, uint256 interestPaid, uint256 remainingDebt);
    event CollateralWithdrawn(address indexed borrower, uint256 amount, uint256 newCollateralBalance);
    event Liquidate(
        address indexed borrower,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 remainingCollateral
    );
    event ParamChanged(string name, uint256 oldValue, uint256 newValue);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event CollateralAppliedToDebt(
        address indexed borrower,
        uint256 amountApplied,
        uint256 principalPaid,
        uint256 interestPaid,
        uint256 remainingDebt,
        uint256 remainingCollateral
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAmount();
    error NotCompliant(address user);
    error StaleCompliance(address user);
    error TierNotEligible(address user, uint16 tier, uint16 subTier);
    error CountryNotEligible(address user, bytes2 country);
    error InsufficientCollateralForBorrow(uint256 attemptedDebt, uint256 collateral, uint16 ratioBps);
    error ExceedsUserBorrowCap(uint256 attempted, uint256 cap);
    error ExceedsPoolBorrowCap(uint256 attempted, uint256 cap);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientShareValue(uint256 requested, uint256 available);
    error InsufficientCollateralBalance(uint256 requested, uint256 available);
    error WithdrawalWouldUnderCollateralize(uint256 remainingDebt, uint256 remainingCollateral, uint16 ratioBps);
    error PositionHealthy(address borrower);
    error NoDebt(address borrower);
    error NotGuardian(address caller);
    error InvalidKinkUtilization(uint16 kinkUtilizationBps);

    /// @notice The RevocationGuardian authorized to call `applyCollateralToDebt`. Owner-settable post-deployment since the guardian is deployed after (and needs) this pool's address.
    address public guardian;

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    constructor(
        IERC20 asset_,
        IComplianceGate complianceGate_,
        ITierOracle tierOracle_,
        ICountrySource countrySource_,
        CompliancePolicy policy_,
        address initialOwner,
        uint256 baseRateBpsPerSecond_,
        uint256 liquidationBonusBps_
    ) Ownable(initialOwner) {
        asset = asset_;
        complianceGate = complianceGate_;
        tierOracle = tierOracle_;
        countrySource = countrySource_;
        policy = policy_;
        baseRateBpsPerSecond = baseRateBpsPerSecond_;
        liquidationBonusBps = liquidationBonusBps_;
        // slope1BpsPerSecond/slope2BpsPerSecond default to 0 (Solidity
        // default), so a freshly-deployed pool behaves as a flat-rate pool
        // at baseRateBpsPerSecond until the owner opts into a curve via
        // the setters below, matching the exact prior flat-rate behavior
        // out of the box.
        kinkUtilizationBps = BPS_DENOMINATOR; // 100%, i.e. no slope2 segment until configured otherwise
    }

    // ---------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------

    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Wires the RevocationGuardian contract authorized to call `applyCollateralToDebt`. Set once after both contracts are deployed.
    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setBaseRateBpsPerSecond(uint256 newRate) external onlyOwner {
        emit ParamChanged("baseRateBpsPerSecond", baseRateBpsPerSecond, newRate);
        baseRateBpsPerSecond = newRate;
    }

    function setSlope1BpsPerSecond(uint256 newSlope) external onlyOwner {
        emit ParamChanged("slope1BpsPerSecond", slope1BpsPerSecond, newSlope);
        slope1BpsPerSecond = newSlope;
    }

    function setSlope2BpsPerSecond(uint256 newSlope) external onlyOwner {
        emit ParamChanged("slope2BpsPerSecond", slope2BpsPerSecond, newSlope);
        slope2BpsPerSecond = newSlope;
    }

    /// @notice Owner-configurable, must be in (0, BPS_DENOMINATOR]. BPS_DENOMINATOR (100%) disables the slope2 segment, see this contract's curve header.
    function setKinkUtilizationBps(uint16 newKink) external onlyOwner {
        if (newKink == 0 || newKink > BPS_DENOMINATOR) revert InvalidKinkUtilization(newKink);
        emit ParamChanged("kinkUtilizationBps", kinkUtilizationBps, newKink);
        kinkUtilizationBps = newKink;
    }

    function setLiquidationBonusBps(uint256 newBonus) external onlyOwner {
        emit ParamChanged("liquidationBonusBps", liquidationBonusBps, newBonus);
        liquidationBonusBps = newBonus;
    }

    // ---------------------------------------------------------------------
    // Lender functions
    // ---------------------------------------------------------------------

    /// @notice The pool's total asset value backing lender shares. See simplification #2 in this contract's header.
    function totalPooledAssets() public view returns (uint256) {
        return idleLiquidity + totalPrincipalOutstanding;
    }

    /// @notice Supply liquidity, receive shares proportional to the pool's current value.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 poolValueBefore = totalPooledAssets();
        uint256 sharesMinted =
            totalShares == 0 ? amount : Math.mulDiv(amount, totalShares, poolValueBefore, Math.Rounding.Floor);

        asset.safeTransferFrom(msg.sender, address(this), amount);

        idleLiquidity += amount;
        totalShares += sharesMinted;
        sharesOf[msg.sender] += sharesMinted;

        emit Deposit(msg.sender, amount, sharesMinted, totalShares);
    }

    /// @notice The asset value of `lender`'s shares at the current pool value (their theoretical max withdrawable, ignoring idle-liquidity limits).
    function shareValue(address lender) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return Math.mulDiv(sharesOf[lender], totalPooledAssets(), totalShares, Math.Rounding.Floor);
    }

    /// @notice Withdraw up to the available idle liquidity, capped by the lender's own share value.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 maxByShares = shareValue(msg.sender);
        if (amount > maxByShares) revert InsufficientShareValue(amount, maxByShares);
        if (amount > idleLiquidity) revert InsufficientLiquidity(amount, idleLiquidity);

        // Round UP the shares burned for a given withdrawal amount, so a
        // lender can never extract more asset value than their shares
        // represent due to rounding, the dust rounds in the pool's favor.
        uint256 sharesBurned = Math.mulDiv(amount, totalShares, totalPooledAssets(), Math.Rounding.Ceil);
        if (sharesBurned > sharesOf[msg.sender]) sharesBurned = sharesOf[msg.sender];

        sharesOf[msg.sender] -= sharesBurned;
        totalShares -= sharesBurned;
        idleLiquidity -= amount;

        asset.safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, amount, sharesBurned, totalShares);
    }

    // ---------------------------------------------------------------------
    // Borrower functions
    // ---------------------------------------------------------------------

    /// @notice Post collateral. Does not itself require compliance, it creates no debt/risk on its own; only `borrow` gates on compliance.
    function postCollateral(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), amount);

        positions[msg.sender].collateral += amount;
        totalCollateral += amount;

        emit CollateralPosted(msg.sender, amount, positions[msg.sender].collateral);
    }

    /// @notice Current tier-derived ratio (bps) for `borrower`, per the live ITierOracle + `policy`'s ratio bands.
    function currentRatioBps(address borrower) public view returns (uint16) {
        (uint16 tier, uint16 subTier) = tierOracle.tierOf(borrower);
        return policy.collateralRatioBps(tier, subTier);
    }

    /// @notice `borrower`'s principal + interest accrued since their last accrual checkpoint, without mutating state.
    function currentDebt(address borrower) public view returns (uint256) {
        BorrowerPosition storage pos = positions[borrower];
        return pos.principal + pos.accruedInterest + _pendingInterest(pos);
    }

    /// @notice Live pool utilization in bps: borrowed principal as a share of total pooled assets. 0 if the pool holds no assets at all (never borrowed against, never deposited into).
    function currentUtilizationBps() public view returns (uint16) {
        uint256 pooled = totalPooledAssets();
        if (pooled == 0) return 0;
        // totalPrincipalOutstanding <= totalPooledAssets always, by
        // construction (totalPooledAssets = idleLiquidity +
        // totalPrincipalOutstanding, idleLiquidity >= 0), so this is
        // always <= BPS_DENOMINATOR, no clamping needed.
        return uint16(Math.mulDiv(totalPrincipalOutstanding, BPS_DENOMINATOR, pooled));
    }

    /// @notice The live per-second bps interest rate at current utilization, see this contract's curve header for the formula.
    function currentInterestRateBpsPerSecond() public view returns (uint256) {
        uint16 utilizationBps = currentUtilizationBps();

        if (utilizationBps <= kinkUtilizationBps) {
            return baseRateBpsPerSecond + Math.mulDiv(slope1BpsPerSecond, utilizationBps, kinkUtilizationBps);
        }

        uint256 rateAtKink = baseRateBpsPerSecond + slope1BpsPerSecond;
        uint256 excessUtilizationBps = utilizationBps - kinkUtilizationBps;
        uint256 slope2Range = BPS_DENOMINATOR - kinkUtilizationBps;
        return rateAtKink + Math.mulDiv(slope2BpsPerSecond, excessUtilizationBps, slope2Range);
    }

    function _pendingInterest(BorrowerPosition storage pos) private view returns (uint256) {
        if (pos.principal == 0) return 0;
        uint256 elapsed = block.timestamp - pos.lastAccrualTimestamp;
        // `elapsed * rate` first (both realistically small, seconds
        // elapsed and a bps-per-second rate, so this can't meaningfully
        // overflow), then let mulDiv's 512-bit intermediate handle
        // `pos.principal * (that product)` safely, rather than
        // pre-multiplying pos.principal (potentially large) by elapsed
        // ourselves and losing mulDiv's overflow protection entirely. Uses
        // the CURRENT rate for the WHOLE elapsed interval, see this
        // contract's header, simplification #2b.
        uint256 rate = currentInterestRateBpsPerSecond();
        return Math.mulDiv(pos.principal, elapsed * rate, BPS_DENOMINATOR);
    }

    /// @dev Realizes pending interest into `accruedInterest` and resets the accrual checkpoint. Called at the start of every state-changing borrower function.
    function _accrueInterest(address borrower) private {
        BorrowerPosition storage pos = positions[borrower];
        pos.accruedInterest += _pendingInterest(pos);
        pos.lastAccrualTimestamp = block.timestamp;
    }

    /// @notice Whether `borrower`'s position currently satisfies its live tier-derived ratio.
    function isHealthy(address borrower) public view returns (bool) {
        uint256 debt = currentDebt(borrower);
        if (debt == 0) return true;
        uint16 ratioBps = currentRatioBps(borrower);
        return debt * ratioBps <= positions[borrower].collateral * BPS_DENOMINATOR;
    }

    /**
     * @notice Borrow against posted collateral. Borrowing is risk-increasing,
     * so it requires: the caller's compliance signal to be both FRESH
     * (`complianceGate.isFresh`, data of unknown age is not the same as
     * knowing they're compliant now, see IComplianceGate.sol) and currently
     * `true`; their tier/subTier and country to satisfy `policy`'s
     * eligibility rules; and the resulting debt to stay within the
     * tier-derived collateral ratio, the tier's borrow cap, the pool-wide
     * cap, and available idle liquidity.
     */
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (!complianceGate.isFresh(msg.sender)) revert StaleCompliance(msg.sender);
        if (!complianceGate.isCompliant(msg.sender)) revert NotCompliant(msg.sender);

        (uint16 tier, uint16 subTier) = tierOracle.tierOf(msg.sender);
        if (!policy.isTierEligible(tier, subTier)) revert TierNotEligible(msg.sender, tier, subTier);

        bytes2 country = countrySource.countryOf(msg.sender);
        if (!policy.isCountryEligible(country)) revert CountryNotEligible(msg.sender, country);

        if (amount > idleLiquidity) revert InsufficientLiquidity(amount, idleLiquidity);

        _accrueInterest(msg.sender);

        BorrowerPosition storage pos = positions[msg.sender];
        uint256 newPrincipal = pos.principal + amount;
        uint256 newDebt = newPrincipal + pos.accruedInterest;

        uint16 ratioBps = policy.collateralRatioBps(tier, subTier);
        if (newDebt * ratioBps > pos.collateral * BPS_DENOMINATOR) {
            revert InsufficientCollateralForBorrow(newDebt, pos.collateral, ratioBps);
        }

        uint256 userCap = policy.tierBorrowCap(tier);
        if (newPrincipal > userCap) revert ExceedsUserBorrowCap(newPrincipal, userCap);
        uint256 newTotalPrincipal = totalPrincipalOutstanding + amount;
        uint256 poolCap = policy.maxTotalBorrow();
        if (newTotalPrincipal > poolCap) revert ExceedsPoolBorrowCap(newTotalPrincipal, poolCap);

        pos.principal = newPrincipal;
        totalPrincipalOutstanding = newTotalPrincipal;
        idleLiquidity -= amount;

        asset.safeTransfer(msg.sender, amount);

        emit Borrow(msg.sender, amount, newPrincipal, newDebt, tier, subTier, ratioBps);
    }

    /**
     * @notice Repay principal + accrued interest. Pass `type(uint256).max`
     * (or any amount at/above current debt) to repay in full, the actual
     * amount pulled is clamped to the outstanding debt, so overpaying by
     * accident is impossible.
     */
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _accrueInterest(msg.sender);
        BorrowerPosition storage pos = positions[msg.sender];

        uint256 owed = pos.principal + pos.accruedInterest;
        if (owed == 0) revert NoDebt(msg.sender);

        uint256 actualRepay = amount > owed ? owed : amount;
        uint256 interestPaid = actualRepay > pos.accruedInterest ? pos.accruedInterest : actualRepay;
        uint256 principalPaid = actualRepay - interestPaid;

        pos.accruedInterest -= interestPaid;
        pos.principal -= principalPaid;
        totalPrincipalOutstanding -= principalPaid;
        idleLiquidity += actualRepay;

        asset.safeTransferFrom(msg.sender, address(this), actualRepay);

        emit Repay(msg.sender, actualRepay, principalPaid, interestPaid, pos.principal + pos.accruedInterest);
    }

    /**
     * @notice Withdraw collateral, but only down to the amount still
     * required to back current debt at the live tier-derived ratio.
     *
     * Compliance/freshness gating applies ONLY while `debt > 0`, that's
     * the genuinely risk-increasing case (reducing the cushion behind
     * outstanding debt). Once debt is fully cleared, withdrawing the
     * remaining collateral is risk-DECREASING (the borrower is just taking
     * back their own money with zero liability to the pool) and must never
     * be blocked by compliance or staleness, see this contract's header
     * and RevocationGuardian.sol's fairness property: a revoked borrower
     * must still be able to recover residual collateral once their debt is
     * resolved.
     */
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _accrueInterest(msg.sender);
        BorrowerPosition storage pos = positions[msg.sender];

        if (amount > pos.collateral) revert InsufficientCollateralBalance(amount, pos.collateral);

        uint256 remainingCollateral = pos.collateral - amount;
        uint256 debt = pos.principal + pos.accruedInterest;

        if (debt > 0) {
            if (!complianceGate.isFresh(msg.sender)) revert StaleCompliance(msg.sender);
            if (!complianceGate.isCompliant(msg.sender)) revert NotCompliant(msg.sender);

            uint16 ratioBps = currentRatioBps(msg.sender);
            if (debt * ratioBps > remainingCollateral * BPS_DENOMINATOR) {
                revert WithdrawalWouldUnderCollateralize(debt, remainingCollateral, ratioBps);
            }
        }

        pos.collateral = remainingCollateral;
        totalCollateral -= amount;

        asset.safeTransfer(msg.sender, amount);

        emit CollateralWithdrawn(msg.sender, amount, remainingCollateral);
    }

    /**
     * @notice Guardian-only: applies up to `amount` of `borrower`'s own
     * posted collateral toward their own debt (interest first, then
     * principal, identical ordering to `repay`), WITHOUT any external
     * token transfer, since the collateral is already held by this
     * contract. This is the "self-cure" step of RevocationGuardian's
     * unwind: prefer using the borrower's own collateral to cover debt
     * before exposing the position to permissionless liquidation.
     *
     * Interest is accrued up to the moment of this call via the same
     * `_accrueInterest` path every other borrower function uses, the
     * unwind settles interest exactly, not approximately, at the point it
     * acts.
     *
     * @param amount Amount to attempt to apply; pass `type(uint256).max` to
     * apply as much as possible. The actual amount applied is capped at
     * both the borrower's collateral balance and their outstanding debt,
     * and returned to the caller.
     */
    function applyCollateralToDebt(address borrower, uint256 amount)
        external
        onlyGuardian
        nonReentrant
        returns (uint256 applied)
    {
        _accrueInterest(borrower);
        BorrowerPosition storage pos = positions[borrower];

        uint256 owed = pos.principal + pos.accruedInterest;
        uint256 maxApplicable = owed < pos.collateral ? owed : pos.collateral;
        applied = amount > maxApplicable ? maxApplicable : amount;

        if (applied == 0) {
            emit CollateralAppliedToDebt(borrower, 0, 0, 0, owed, pos.collateral);
            return 0;
        }

        uint256 interestPaid = applied > pos.accruedInterest ? pos.accruedInterest : applied;
        uint256 principalPaid = applied - interestPaid;

        pos.accruedInterest -= interestPaid;
        pos.principal -= principalPaid;
        totalPrincipalOutstanding -= principalPaid;

        pos.collateral -= applied;
        totalCollateral -= applied;
        idleLiquidity += applied;

        emit CollateralAppliedToDebt(
            borrower, applied, principalPaid, interestPaid, pos.principal + pos.accruedInterest, pos.collateral
        );
    }

    /**
     * @notice Liquidate an unhealthy position. Permissionless, anyone
     * (including a future RevocationGuardian) may call this. The liquidator
     * repays the borrower's FULL outstanding debt and receives their
     * collateral up to `debt * (1 + liquidationBonusBps)`, capped at
     * whatever collateral the borrower actually posted (see simplification
     * #3 in this contract's header for the bad-debt edge case).
     */
    function liquidate(address borrower) external nonReentrant {
        _accrueInterest(borrower);
        BorrowerPosition storage pos = positions[borrower];

        uint256 debt = pos.principal + pos.accruedInterest;
        if (debt == 0) revert NoDebt(borrower);
        if (isHealthy(borrower)) revert PositionHealthy(borrower);

        uint256 collateralWithBonus = Math.mulDiv(debt, BPS_DENOMINATOR + liquidationBonusBps, BPS_DENOMINATOR);
        uint256 collateralSeized = collateralWithBonus > pos.collateral ? pos.collateral : collateralWithBonus;

        // Capture principal before clearing it, totalPrincipalOutstanding
        // only tracks the principal portion of debt, not accrued interest.
        uint256 principalPortion = pos.principal;
        pos.principal = 0;
        pos.accruedInterest = 0;
        totalPrincipalOutstanding -= principalPortion;
        uint256 remainingCollateral = pos.collateral - collateralSeized;
        pos.collateral = remainingCollateral;
        totalCollateral -= collateralSeized;
        idleLiquidity += debt;

        asset.safeTransferFrom(msg.sender, address(this), debt);
        asset.safeTransfer(msg.sender, collateralSeized);

        emit Liquidate(borrower, msg.sender, debt, collateralSeized, remainingCollateral);
    }
}
