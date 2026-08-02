// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";

contract ComplianceRegistryTest is Test {
    ComplianceRegistry registry;
    address owner = address(this);
    address keeper = address(0x1CEE7E4);
    address nonKeeper = address(0xBAD);
    address alice = address(0xA11CE);

    uint256 constant MAX_STALENESS = 3600; // 1 hour

    function setUp() public {
        registry = new ComplianceRegistry(owner, MAX_STALENESS);
        registry.setKeeper(keeper, true);
    }

    function test_OnlyKeeperCanObserve() public {
        vm.prank(nonKeeper);
        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NotKeeper.selector, nonKeeper));
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
    }

    function test_OnlyOwnerCanSetKeeper() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setKeeper(alice, true);
    }

    function test_ObserveCompliance_StoresAndEmits() public {
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit ComplianceRegistry.ComplianceObserved(alice, true, 50, 80, block.timestamp, ComplianceRegistry.Reason.NONE);
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        assertTrue(registry.isCompliant(alice));
        (uint16 tier, uint16 subTier) = registry.tierOf(alice);
        assertEq(tier, 50);
        assertEq(subTier, 80);
        assertEq(registry.lastVerifiedAt(alice), block.timestamp);
    }

    function test_IsFresh_FalseWhenNeverObserved() public view {
        assertFalse(registry.isFresh(alice));
    }

    function test_IsFresh_TrueImmediatelyAfterObservation() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
        assertTrue(registry.isFresh(alice));
    }

    function test_IsFresh_FalseAfterStalenessWindowElapses() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        vm.warp(block.timestamp + MAX_STALENESS + 1);
        assertFalse(registry.isFresh(alice));
    }

    function test_IsFresh_TrueExactlyAtStalenessBoundary() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        vm.warp(block.timestamp + MAX_STALENESS);
        assertTrue(registry.isFresh(alice));
    }

    function test_ReObserving_OverwritesPreviousObservationAndResetsFreshness() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, false, 0, 0, ComplianceRegistry.Reason.FROZEN);

        vm.warp(block.timestamp + MAX_STALENESS + 1);
        assertFalse(registry.isFresh(alice));

        vm.prank(keeper);
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);

        assertTrue(registry.isFresh(alice));
        assertTrue(registry.isCompliant(alice));
        assertEq(uint8(registry.lastReason(alice)), uint8(ComplianceRegistry.Reason.NONE));
    }

    function test_LastReason_TracksKeeperSuppliedReason() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, false, 50, 80, ComplianceRegistry.Reason.FROZEN);
        assertEq(uint8(registry.lastReason(alice)), uint8(ComplianceRegistry.Reason.FROZEN));
    }

    function test_ObservationOf_ReturnsFullTuple() public {
        vm.prank(keeper);
        registry.observeCompliance(alice, false, 20, 30, ComplianceRegistry.Reason.EXPIRED);

        (bool compliant, uint16 tier, uint16 subTier, uint256 lastVerifiedAt_, ComplianceRegistry.Reason reason) =
            registry.observationOf(alice);

        assertFalse(compliant);
        assertEq(tier, 20);
        assertEq(subTier, 30);
        assertEq(lastVerifiedAt_, block.timestamp);
        assertEq(uint8(reason), uint8(ComplianceRegistry.Reason.EXPIRED));
    }

    function test_RevokedKeeperCannotObserve() public {
        registry.setKeeper(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NotKeeper.selector, keeper));
        registry.observeCompliance(alice, true, 50, 80, ComplianceRegistry.Reason.NONE);
    }
}
