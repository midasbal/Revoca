// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {IAPassComplianceValidator} from "./interfaces/IAPassComplianceValidator.sol";

/**
 * @title HybridComplianceGate
 * @notice The real Design A/B hybrid IComplianceGate, per docs/ARCHITECTURE.md
 * and docs/DESIGN_A_SPIKE.md section 4. Wraps a pool's compliance gate mode
 * as an EXPLICIT, owner-set configuration, `ValidatorGated` (Design A, an
 * on-chain read against Cleanverse's real CVI Compliance Validator) or
 * `AttestorGated` (Design B, delegates to ComplianceRegistry's
 * attestor-derived `isCompliant`/`isFresh`).
 *
 * WHY MODE IS EXPLICIT CONFIG, NOT INFERRED AT CALL TIME: whether a pool is
 * validator-registered is a fact the owner already knows at setup, not
 * something to detect from a revert. Inferring it from
 * `complianceVerify` reverting would conflate "this pool was never
 * registered" with "the validator call genuinely failed right now" (an RPC
 * hiccup, the validator paused, a griefer forcing a revert somehow), and
 * would let ANY cause of a validator revert silently downgrade a
 * ValidatorGated pool to the weaker attestor check. A fallback must never be
 * easier to satisfy than the primary, so there is no automatic fallback:
 * a `ValidatorGated` pool that can't get a clean answer from the validator
 * fails closed, it never silently becomes an `AttestorGated` pool for that
 * call.
 *
 * FAIL CLOSED ON REVERT: in `ValidatorGated` mode, `isCompliant` wraps
 * `validator.complianceVerify` in try/catch. ANY revert (a decoded
 * `PoolNotRegistered()`, per docs/DESIGN_A_SPIKE.md objective 2, a raw RPC
 * failure, or anything else) is treated as `false`, not compliant. This is
 * the only compliance-safe default: "cannot confirm eligibility right now"
 * must mean "no", never "assume yes" or "ask someone else instead."
 *
 * WHAT THIS DOES NOT DO: it never becomes the source of a borrower's tier
 * number. `complianceVerify` returns only a pass/fail boolean (confirmed
 * from Cleanverse's CCP integration guide and docs/DESIGN_A_SPIKE.md's live
 * probe), so Revoca's tier-as-risk-parameter design is served by
 * ComplianceRegistry's `ITierOracle.tierOf` directly, always, independent of
 * this gate's mode; LendingPool is constructed with `tierOracle_` pointed at
 * ComplianceRegistry regardless of which mode this gate is in. This
 * contract intentionally implements ONLY `IComplianceGate`, not
 * `ITierOracle`.
 *
 * STALENESS: `ValidatorGated` mode is a synchronous, same-transaction
 * on-chain read, per IComplianceGate.sol's header there is no staleness
 * concept for it at all, so `isFresh` trivially returns `true`.
 * `AttestorGated` mode delegates `isFresh` to the wrapped attestor gate,
 * exactly as ComplianceRegistry itself defines it.
 *
 * SEAM DISCIPLINE: this contract is deployed as a pool's `complianceGate_`
 * constructor argument (see LendingPool.sol), a pure implementation of the
 * existing `IComplianceGate` seam. LendingPool and RevocationGuardian
 * require zero code changes to adopt it, that is the whole point of the
 * seam, see docs/ARCHITECTURE.md.
 *
 * NOT DONE HERE (deliberately, this session, see docs/ROADMAP.md Phase 3):
 * registering the real LendingPool with the validator. `validatorPool` may
 * point at any already-registered pool address (including
 * `MinimalRegistrationProbe`'s deployed spike instance,
 * 0x5601ae44ed6f89be7c708fe82e1d9863cbd4110c on Monad testnet, per
 * docs/DESIGN_A_SPIKE.md section 5); registering the real LendingPool
 * itself is a later deploy step once the pool contract is stable
 * post-refinements (interest model, pluggable unwind).
 */
contract HybridComplianceGate is IComplianceGate, Ownable {
    enum Mode {
        AttestorGated,
        ValidatorGated
    }

    IAPassComplianceValidator public immutable validator;

    /// @notice The pool address checked against the validator, i.e. the first argument to `validator.complianceVerify`. Not necessarily `address(this)` or the LendingPool that consumes this gate, see this contract's header for why it may point at an already-registered probe pool this session.
    address public immutable validatorPool;

    /// @notice The Design B fallback/alternate gate, ComplianceRegistry in practice. Also always the ITierOracle tier source, independent of this contract, see this contract's header.
    IComplianceGate public immutable attestorGate;

    Mode public mode;

    event ModeSet(Mode mode);

    constructor(
        address initialOwner,
        IAPassComplianceValidator validator_,
        address validatorPool_,
        IComplianceGate attestorGate_,
        Mode initialMode
    ) Ownable(initialOwner) {
        require(address(validator_) != address(0), "validator=0");
        require(validatorPool_ != address(0), "validatorPool=0");
        require(address(attestorGate_) != address(0), "attestorGate=0");
        validator = validator_;
        validatorPool = validatorPool_;
        attestorGate = attestorGate_;
        mode = initialMode;
        emit ModeSet(initialMode);
    }

    /// @notice Owner-only, switches this gate's mode between ValidatorGated and AttestorGated. A configuration decision, not something inferred at call time, see this contract's header.
    function setMode(Mode mode_) external onlyOwner {
        mode = mode_;
        emit ModeSet(mode_);
    }

    /// @inheritdoc IComplianceGate
    function isCompliant(address user) external view returns (bool) {
        if (mode == Mode.ValidatorGated) {
            try validator.complianceVerify(validatorPool, user) returns (bool ok) {
                return ok;
            } catch {
                return false; // fail closed, see this contract's header
            }
        }
        return attestorGate.isCompliant(user);
    }

    /// @inheritdoc IComplianceGate
    function isFresh(address user) external view returns (bool) {
        if (mode == Mode.ValidatorGated) {
            return true; // synchronous on-chain read, no staleness concept
        }
        return attestorGate.isFresh(user);
    }
}
