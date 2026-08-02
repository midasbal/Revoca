// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {TestComplianceGate} from "../src/test/TestComplianceGate.sol";

contract TestComplianceGateTest is Test {
    TestComplianceGate gate;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        gate = new TestComplianceGate();
    }

    function test_DefaultsToNonCompliant() public view {
        assertFalse(gate.isCompliant(alice));
        assertFalse(gate.isCompliant(bob));
    }

    function test_OwnerCanToggleCompliance() public {
        gate.setCompliant(alice, true);
        assertTrue(gate.isCompliant(alice));
        assertFalse(gate.isCompliant(bob));

        gate.setCompliant(alice, false);
        assertFalse(gate.isCompliant(alice));
    }

    function test_BatchToggle() public {
        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;

        gate.setCompliantBatch(users, true);
        assertTrue(gate.isCompliant(alice));
        assertTrue(gate.isCompliant(bob));
    }

    function test_NonOwnerCannotToggle() public {
        vm.prank(alice);
        vm.expectRevert(TestComplianceGate.NotOwner.selector);
        gate.setCompliant(alice, true);
    }

    function test_ImplementsIComplianceGate() public view {
        // Compile-time + runtime check that the mock satisfies the interface
        // the real pool will depend on.
        IComplianceGate asInterface = gate;
        assertFalse(asInterface.isCompliant(alice));
    }
}
