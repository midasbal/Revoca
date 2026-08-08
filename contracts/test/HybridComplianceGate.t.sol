// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {HybridComplianceGate} from "../src/HybridComplianceGate.sol";
import {IAPassComplianceValidator} from "../src/interfaces/IAPassComplianceValidator.sol";
import {MockValidator} from "../src/test/MockValidator.sol";
import {TestComplianceGate} from "../src/test/TestComplianceGate.sol";

/**
 * @notice Offline, deterministic coverage of HybridComplianceGate's mode
 * dispatch and fail-closed behavior, per docs/ARCHITECTURE.md's hybrid
 * design and the mode-is-explicit-config decision recorded in this
 * contract's own header. Uses MockValidator (never the real validator) so
 * "validator returns true", "validator returns false", and "validator call
 * reverts" are all provable without a live Monad RPC. The real validator is
 * separately covered by HybridComplianceGateMonadFork.t.sol.
 */
contract HybridComplianceGateTest is Test {
    HybridComplianceGate gate;
    MockValidator validator;
    TestComplianceGate attestorGate;

    address owner = address(this);
    address alice = address(0xA11CE);
    address validatorPool = address(0xF001);

    function setUp() public {
        validator = new MockValidator();
        attestorGate = new TestComplianceGate();
        gate = new HybridComplianceGate(
            owner,
            IAPassComplianceValidator(address(validator)),
            validatorPool,
            attestorGate,
            HybridComplianceGate.Mode.ValidatorGated
        );
    }

    // -------------------------------------------------------------------
    // ValidatorGated mode
    // -------------------------------------------------------------------

    function test_ValidatorGated_ReturnsTrue_WhenValidatorReturnsTrue() public {
        validator.setResult(validatorPool, alice, true);
        assertTrue(gate.isCompliant(alice));
    }

    function test_ValidatorGated_ReturnsFalse_WhenValidatorReturnsFalse() public {
        validator.setResult(validatorPool, alice, false);
        assertFalse(gate.isCompliant(alice));
    }

    function test_ValidatorGated_FailsClosed_WhenValidatorReverts() public {
        // Simulates PoolNotRegistered() or any other on-chain failure, per
        // docs/DESIGN_A_SPIKE.md objective 2. Must be treated as "not
        // compliant", never as "fall back to the attestor".
        validator.setReverts(validatorPool, true);
        // Even if the attestor gate WOULD say yes, ValidatorGated mode must
        // still fail closed rather than silently downgrading to it.
        attestorGate.setCompliant(alice, true);

        assertFalse(gate.isCompliant(alice));
    }

    function test_ValidatorGated_IsAlwaysFresh() public view {
        // Synchronous on-chain read, no staleness concept, per
        // IComplianceGate.sol's header.
        assertTrue(gate.isFresh(alice));
    }

    function test_ValidatorGated_IsFresh_EvenWhenValidatorReverts() public {
        validator.setReverts(validatorPool, true);
        assertTrue(gate.isFresh(alice));
    }

    // -------------------------------------------------------------------
    // AttestorGated mode
    // -------------------------------------------------------------------

    function test_AttestorGated_DelegatesIsCompliant() public {
        gate.setMode(HybridComplianceGate.Mode.AttestorGated);

        assertFalse(gate.isCompliant(alice));
        attestorGate.setCompliant(alice, true);
        assertTrue(gate.isCompliant(alice));
    }

    function test_AttestorGated_DelegatesIsFresh() public {
        gate.setMode(HybridComplianceGate.Mode.AttestorGated);

        assertTrue(gate.isFresh(alice)); // TestComplianceGate defaults fresh
        attestorGate.setStale(alice, true);
        assertFalse(gate.isFresh(alice));
    }

    function test_AttestorGated_IgnoresValidatorEntirely() public {
        // Even if the validator would say yes, AttestorGated mode must
        // never consult it.
        gate.setMode(HybridComplianceGate.Mode.AttestorGated);
        validator.setResult(validatorPool, alice, true);

        assertFalse(gate.isCompliant(alice)); // attestor gate defaults non-compliant
    }

    // -------------------------------------------------------------------
    // Mode switching, ownership, construction
    // -------------------------------------------------------------------

    function test_SetMode_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gate.setMode(HybridComplianceGate.Mode.AttestorGated);
    }

    function test_SetMode_SwitchesBackAndForth() public {
        validator.setResult(validatorPool, alice, true);
        attestorGate.setCompliant(alice, false);
        assertTrue(gate.isCompliant(alice)); // ValidatorGated, sees the validator's true

        gate.setMode(HybridComplianceGate.Mode.AttestorGated);
        assertFalse(gate.isCompliant(alice)); // AttestorGated, sees the attestor's false

        gate.setMode(HybridComplianceGate.Mode.ValidatorGated);
        assertTrue(gate.isCompliant(alice)); // back to ValidatorGated
    }

    function test_Constructor_RevertsOnZeroValidator() public {
        vm.expectRevert(bytes("validator=0"));
        new HybridComplianceGate(
            owner,
            IAPassComplianceValidator(address(0)),
            validatorPool,
            attestorGate,
            HybridComplianceGate.Mode.ValidatorGated
        );
    }

    function test_Constructor_RevertsOnZeroValidatorPool() public {
        vm.expectRevert(bytes("validatorPool=0"));
        new HybridComplianceGate(
            owner,
            IAPassComplianceValidator(address(validator)),
            address(0),
            attestorGate,
            HybridComplianceGate.Mode.ValidatorGated
        );
    }

    function test_Constructor_RevertsOnZeroAttestorGate() public {
        vm.expectRevert(bytes("attestorGate=0"));
        new HybridComplianceGate(
            owner,
            IAPassComplianceValidator(address(validator)),
            validatorPool,
            TestComplianceGate(address(0)),
            HybridComplianceGate.Mode.ValidatorGated
        );
    }
}
