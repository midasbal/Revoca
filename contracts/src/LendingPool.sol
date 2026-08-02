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
import {CollateralRatioPolicy} from "./CollateralRatioPolicy.sol";

/**
 * @title LendingPool
 * @notice Single-asset, single-pool, tier-scaled under-collateralized
 * lending pool. Core mechanics only, see CLAUDE.md/docs/PROJECT.md for
 * Revoca's full scope. The compliance-triggered unwind (RevocationGuardian)
 * is deliberately NOT built here; this contract's mechanics (in particular
 * `liquidate`) are kept clean and permissionless so the guardian can call
 * into them next session without needing pool changes.
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
 * 3. Liquidation always requires the liquidator to repay the FULL
 *    outstanding debt (no partial liquidation). If a position's collateral
 *    has fallen below `debt + bonus` (e.g. a severe tier downgrade after
 *    heavy interest accrual), the liquidator receives only the collateral
 *    that exists and still pays full debt, the protocol does not currently
 *    socialize that shortfall. Real bad-debt handling is out of scope here;
 *    it's a candidate for the guardian or a future session.
 *
 * Safety: Ownable (via CollateralRatioPolicy) + Pausable + ReentrancyGuard +
 * SafeERC20 + custom errors (no string reverts). `pause()` blocks entry
 * (deposit, postCollateral, borrow) only, repay, withdraw,
 * withdrawCollateral, and liquidate remain callable while paused, so no
 * user or lender is ever trapped and the pool can still be de-risked during
 * an incident.
 */
contract LendingPool is CollateralRatioPolicy, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutables, seams, not swappable post-deployment this session (see
    // docs/ARCHITECTURE.md; a real Design A/B gate and tier attestor are
    // future work, not this contract's concern).
    // ---------------------------------------------------------------------

    IERC20 public immutable asset;
    IComplianceGate public immutable complianceGate;
    ITierOracle public immutable tierOracle;

    // ---------------------------------------------------------------------
    // Owner-settable parameters
    // ---------------------------------------------------------------------

    /// @notice Simple linear interest: basis points of PRINCIPAL accrued per second.
    /// @dev Applied only to principal (never to already-accrued interest),
    /// so interest is genuinely linear/non-compounding within a position's
    /// life, matching the "simple linear interest" requirement exactly.
    uint256 public interestRateBpsPerSecond;

    /// @notice Bonus (in bps of debt repaid) a liquidator receives on top of debt value, from the seized collateral.
    uint256 public liquidationBonusBps;

    /// @notice Max principal a single borrower may have outstanding at once. `type(uint256).max` = no cap.
    uint256 public maxBorrowPerUser;

    /// @notice Max total principal outstanding across all borrowers. `type(uint256).max` = no cap.
    uint256 public maxTotalBorrow;

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

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAmount();
    error NotCompliant(address user);
    error InsufficientCollateralForBorrow(uint256 attemptedDebt, uint256 collateral, uint16 ratioBps);
    error ExceedsUserBorrowCap(uint256 attempted, uint256 cap);
    error ExceedsPoolBorrowCap(uint256 attempted, uint256 cap);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientShareValue(uint256 requested, uint256 available);
    error InsufficientCollateralBalance(uint256 requested, uint256 available);
    error WithdrawalWouldUnderCollateralize(uint256 remainingDebt, uint256 remainingCollateral, uint16 ratioBps);
    error PositionHealthy(address borrower);
    error NoDebt(address borrower);

    constructor(
        IERC20 asset_,
        IComplianceGate complianceGate_,
        ITierOracle tierOracle_,
        address initialOwner,
        uint256 interestRateBpsPerSecond_,
        uint256 liquidationBonusBps_
    ) CollateralRatioPolicy(initialOwner) {
        asset = asset_;
        complianceGate = complianceGate_;
        tierOracle = tierOracle_;
        interestRateBpsPerSecond = interestRateBpsPerSecond_;
        liquidationBonusBps = liquidationBonusBps_;
        maxBorrowPerUser = type(uint256).max;
        maxTotalBorrow = type(uint256).max;
    }

    // ---------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setInterestRateBpsPerSecond(uint256 newRate) external onlyOwner {
        emit ParamChanged("interestRateBpsPerSecond", interestRateBpsPerSecond, newRate);
        interestRateBpsPerSecond = newRate;
    }

    function setLiquidationBonusBps(uint256 newBonus) external onlyOwner {
        emit ParamChanged("liquidationBonusBps", liquidationBonusBps, newBonus);
        liquidationBonusBps = newBonus;
    }

    function setMaxBorrowPerUser(uint256 newCap) external onlyOwner {
        emit ParamChanged("maxBorrowPerUser", maxBorrowPerUser, newCap);
        maxBorrowPerUser = newCap;
    }

    function setMaxTotalBorrow(uint256 newCap) external onlyOwner {
        emit ParamChanged("maxTotalBorrow", maxTotalBorrow, newCap);
        maxTotalBorrow = newCap;
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

    /// @notice Current tier-derived ratio (bps) for `borrower`, per the live ITierOracle + this pool's CollateralRatioPolicy.
    function currentRatioBps(address borrower) public view returns (uint16) {
        (uint16 tier, uint16 subTier) = tierOracle.tierOf(borrower);
        return collateralRatioBps(tier, subTier);
    }

    /// @notice `borrower`'s principal + interest accrued since their last accrual checkpoint, without mutating state.
    function currentDebt(address borrower) public view returns (uint256) {
        BorrowerPosition storage pos = positions[borrower];
        return pos.principal + pos.accruedInterest + _pendingInterest(pos);
    }

    function _pendingInterest(BorrowerPosition storage pos) private view returns (uint256) {
        if (pos.principal == 0) return 0;
        uint256 elapsed = block.timestamp - pos.lastAccrualTimestamp;
        return Math.mulDiv(pos.principal * elapsed, interestRateBpsPerSecond, BPS_DENOMINATOR);
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
     * @notice Borrow against posted collateral. Requires the caller to be
     * currently compliant (live `complianceGate.isCompliant` check, never
     * cached) and the resulting debt to stay within the tier-derived
     * collateral ratio, the per-user cap, the per-pool cap, and available
     * idle liquidity.
     */
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (!complianceGate.isCompliant(msg.sender)) revert NotCompliant(msg.sender);
        if (amount > idleLiquidity) revert InsufficientLiquidity(amount, idleLiquidity);

        _accrueInterest(msg.sender);

        BorrowerPosition storage pos = positions[msg.sender];
        uint256 newPrincipal = pos.principal + amount;
        uint256 newDebt = newPrincipal + pos.accruedInterest;

        uint16 ratioBps = currentRatioBps(msg.sender);
        if (newDebt * ratioBps > pos.collateral * BPS_DENOMINATOR) {
            revert InsufficientCollateralForBorrow(newDebt, pos.collateral, ratioBps);
        }

        if (newPrincipal > maxBorrowPerUser) revert ExceedsUserBorrowCap(newPrincipal, maxBorrowPerUser);
        uint256 newTotalPrincipal = totalPrincipalOutstanding + amount;
        if (newTotalPrincipal > maxTotalBorrow) revert ExceedsPoolBorrowCap(newTotalPrincipal, maxTotalBorrow);

        pos.principal = newPrincipal;
        totalPrincipalOutstanding = newTotalPrincipal;
        idleLiquidity -= amount;

        asset.safeTransfer(msg.sender, amount);

        (uint16 tier, uint16 subTier) = tierOracle.tierOf(msg.sender);
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

    /// @notice Withdraw collateral, but only down to the amount still required to back current debt at the live tier-derived ratio.
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _accrueInterest(msg.sender);
        BorrowerPosition storage pos = positions[msg.sender];

        if (amount > pos.collateral) revert InsufficientCollateralBalance(amount, pos.collateral);

        uint256 remainingCollateral = pos.collateral - amount;
        uint256 debt = pos.principal + pos.accruedInterest;

        if (debt > 0) {
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

        pos.principal = 0;
        pos.accruedInterest = 0;
        totalPrincipalOutstanding -= (pos.principal >= debt ? debt : pos.principal); // principal portion only; see note below
        uint256 remainingCollateral = pos.collateral - collateralSeized;
        pos.collateral = remainingCollateral;
        totalCollateral -= collateralSeized;
        idleLiquidity += debt;

        asset.safeTransferFrom(msg.sender, address(this), debt);
        asset.safeTransfer(msg.sender, collateralSeized);

        emit Liquidate(borrower, msg.sender, debt, collateralSeized, remainingCollateral);
    }
}
