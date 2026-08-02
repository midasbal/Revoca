// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {EIP712TestUtils} from "./helpers/EIP712TestUtils.sol";

contract ComplianceRegistryTest is EIP712TestUtils {
    ComplianceRegistry registry;
    CompliancePolicy policy;

    address owner = address(this);
    uint256 constant ATTESTOR_PK = 0xA11CE5;
    address attestor;
    uint256 constant OTHER_PK = 0xB0B5;
    address other;
    address alice = address(0xA11CE);

    uint256 constant MAX_STALENESS = 3600; // 1 hour
    uint256 constant GRACE_DURATION = 3600; // arbitrary, irrelevant to these tests

    function setUp() public {
        attestor = vm.addr(ATTESTOR_PK);
        other = vm.addr(OTHER_PK);
        policy = new CompliancePolicy(owner, GRACE_DURATION, MAX_STALENESS);
        registry = new ComplianceRegistry(owner, policy);
        registry.setAttestor(attestor, true);
    }

    function _fact(uint256 nonce) internal view returns (ComplianceRegistry.ComplianceAttestation memory) {
        return ComplianceRegistry.ComplianceAttestation({
            user: alice,
            tier: 50,
            subTier: 80,
            country: bytes2("US"),
            apassStatus: registry.APASS_STATUS_ACTIVE(),
            expiry: block.timestamp + 365 days,
            issuedAt: block.timestamp,
            nonce: nonce
        });
    }

    // -------------------------------------------------------------------
    // Attestor management
    // -------------------------------------------------------------------

    function test_SetAttestor_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setAttestor(alice, true);
    }

    function test_SetAttestor_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ComplianceRegistry.AttestorSet(other, true);
        registry.setAttestor(other, true);
        assertTrue(registry.isAttestor(other));
    }

    // -------------------------------------------------------------------
    // submitAttestation, happy path
    // -------------------------------------------------------------------

    function test_SubmitAttestation_ValidFromAuthorizedAttestor_StoresFactsAndEmits() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        vm.expectEmit(true, true, false, true);
        emit ComplianceRegistry.ComplianceAttested(
            alice, a.tier, a.subTier, a.country, a.apassStatus, a.expiry, a.issuedAt, a.nonce, attestor
        );
        registry.submitAttestation(a, sig);

        (uint16 tier, uint16 subTier, bytes2 country, uint8 apassStatus, uint256 expiry, uint256 issuedAt) =
            registry.attestationOf(alice);
        assertEq(tier, 50);
        assertEq(subTier, 80);
        assertEq(country, bytes2("US"));
        assertEq(apassStatus, registry.APASS_STATUS_ACTIVE());
        assertEq(expiry, a.expiry);
        assertEq(issuedAt, a.issuedAt);
        assertEq(registry.lastNonce(alice), 1);
    }

    function test_SubmitAttestation_PermissionlessRelay_AnyoneCanSubmit() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        // Relayed by a totally unrelated address, not the attestor and not alice.
        vm.prank(address(0xBADA55));
        registry.submitAttestation(a, sig);

        assertTrue(registry.isCompliant(alice));
    }

    // -------------------------------------------------------------------
    // Rejection matrix
    // -------------------------------------------------------------------

    function test_SubmitAttestation_RevertsForUnauthorizedAttestor() public {
        // `other` is a real, self-consistent keypair, just never authorized.
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes memory sig = _sign(OTHER_PK, registry, a);

        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NotAuthorizedAttestor.selector, other));
        registry.submitAttestation(a, sig);
    }

    function test_SubmitAttestation_RevertsForWrongSigner_TamperedAfterSigning() public {
        // Attestor signs one set of facts; a tampered attestation (different
        // tier) is submitted with that same signature, recovery yields a
        // signer that isn't `attestor`, since the signed digest no longer
        // matches the tampered struct.
        ComplianceRegistry.ComplianceAttestation memory original = _fact(1);
        bytes memory sig = _sign(ATTESTOR_PK, registry, original);

        ComplianceRegistry.ComplianceAttestation memory tampered = original;
        tampered.tier = 99;

        vm.expectRevert(); // recovered signer will not equal `attestor`; exact address is unpredictable, just confirm it reverts with NotAuthorizedAttestor-shaped error
        registry.submitAttestation(tampered, sig);
    }

    function test_SubmitAttestation_RevertsForReplayedNonce() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);
        registry.submitAttestation(a, sig);

        // Exact same attestation + signature, replayed.
        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NonceNotIncreasing.selector, 1, 1));
        registry.submitAttestation(a, sig);
    }

    function test_SubmitAttestation_RevertsForNonIncreasingNonce() public {
        ComplianceRegistry.ComplianceAttestation memory first = _fact(5);
        registry.submitAttestation(first, _sign(ATTESTOR_PK, registry, first));

        ComplianceRegistry.ComplianceAttestation memory second = _fact(5); // same nonce, new signature
        bytes memory sig2 = _sign(ATTESTOR_PK, registry, second);

        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NonceNotIncreasing.selector, 5, 5));
        registry.submitAttestation(second, sig2);

        ComplianceRegistry.ComplianceAttestation memory lower = _fact(4); // lower than lastNonce
        bytes memory sig3 = _sign(ATTESTOR_PK, registry, lower);
        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.NonceNotIncreasing.selector, 4, 5));
        registry.submitAttestation(lower, sig3);
    }

    function test_SubmitAttestation_RevertsForStaleIssuedAt() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.issuedAt = block.timestamp; // fine now...
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        vm.warp(block.timestamp + MAX_STALENESS + 1); // ...but time has moved past staleness by submission time

        vm.expectRevert(abi.encodeWithSelector(ComplianceRegistry.AttestationStale.selector, a.issuedAt, block.timestamp));
        registry.submitAttestation(a, sig);
    }

    function test_SubmitAttestation_AcceptsIssuedAtExactlyAtStalenessBoundary() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        vm.warp(block.timestamp + MAX_STALENESS); // exactly at the boundary, must still be accepted
        registry.submitAttestation(a, sig);
        assertTrue(registry.isCompliant(alice));
    }

    function test_SubmitAttestation_RevertsForFutureIssuedAtBeyondSkew() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.issuedAt = block.timestamp + registry.MAX_FUTURE_SKEW() + 1;
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        vm.expectRevert(
            abi.encodeWithSelector(ComplianceRegistry.AttestationFromFuture.selector, a.issuedAt, block.timestamp)
        );
        registry.submitAttestation(a, sig);
    }

    function test_SubmitAttestation_AcceptsFutureIssuedAtWithinSkew() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.issuedAt = block.timestamp + registry.MAX_FUTURE_SKEW(); // exactly at the boundary
        bytes memory sig = _sign(ATTESTOR_PK, registry, a);

        registry.submitAttestation(a, sig);
        assertTrue(registry.isCompliant(alice));
    }

    function test_SubmitAttestation_RevertsForWrongChainIdDomain() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes32 wrongDomain = _domainSeparator(block.chainid + 1, address(registry));
        bytes32 digest = _digestWithDomain(wrongDomain, registry, a);
        bytes memory sig = _signDigest(ATTESTOR_PK, digest);

        // Recovery against the CORRECT (contract-expected) domain won't
        // match `attestor`, since the signature was produced over a
        // different digest entirely.
        vm.expectRevert();
        registry.submitAttestation(a, sig);
    }

    function test_SubmitAttestation_RevertsForWrongVerifyingContractDomain() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        bytes32 wrongDomain = _domainSeparator(block.chainid, address(0xDEAD));
        bytes32 digest = _digestWithDomain(wrongDomain, registry, a);
        bytes memory sig = _signDigest(ATTESTOR_PK, digest);

        vm.expectRevert();
        registry.submitAttestation(a, sig);
    }

    // -------------------------------------------------------------------
    // isFresh
    // -------------------------------------------------------------------

    function test_IsFresh_FalseWhenNeverAttested() public view {
        assertFalse(registry.isFresh(alice));
    }

    function test_IsFresh_TrueImmediatelyAfterAttestation() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
        assertTrue(registry.isFresh(alice));
    }

    function test_IsFresh_FalseAfterStalenessWindowElapses() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        vm.warp(block.timestamp + MAX_STALENESS + 1);
        assertFalse(registry.isFresh(alice));
    }

    // -------------------------------------------------------------------
    // isCompliant, eligibility derivation matrix
    // -------------------------------------------------------------------

    function test_IsCompliant_FrozenStatus_NotCompliant() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.apassStatus = registry.APASS_STATUS_FROZEN();
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertFalse(registry.isCompliant(alice));
    }

    function test_IsCompliant_ExpiredApass_NotCompliant() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.expiry = block.timestamp + 100;
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
        assertTrue(registry.isCompliant(alice)); // not expired yet

        vm.warp(block.timestamp + 101);
        assertFalse(registry.isCompliant(alice)); // now expired
    }

    function test_IsCompliant_NoExpirationWhenZero() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.expiry = 0; // 0 = no expiration
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        vm.warp(block.timestamp + 100 days);
        assertTrue(registry.isCompliant(alice));
    }

    function test_IsCompliant_TierBelowPolicy_NotCompliant() public {
        policy.setMinTier(60); // above alice's attested tier (50)

        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertFalse(registry.isCompliant(alice));
    }

    function test_IsCompliant_DisallowedCountry_NotCompliant() public {
        bytes2[] memory allowed = new bytes2[](1);
        allowed[0] = bytes2("DE");
        policy.setCountryRule(allowed, false); // allowlist: only DE

        ComplianceRegistry.ComplianceAttestation memory a = _fact(1); // country = "US"
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertFalse(registry.isCompliant(alice));
    }

    function test_IsCompliant_AllPass_Compliant() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertTrue(registry.isCompliant(alice));
    }

    // -------------------------------------------------------------------
    // THE headline consequence: policy change flips eligibility with NO
    // new attestation, proves the fact/policy separation is real, not
    // just described in comments.
    // -------------------------------------------------------------------

    function test_PolicyChangeWithoutReattestation_FlipsComplianceFromTrueToFalse() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1); // tier 50
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
        assertTrue(registry.isCompliant(alice));

        uint256 nonceBefore = registry.lastNonce(alice);
        uint256 issuedAtBefore = registry.issuedAtOf(alice);

        // Owner raises the tier floor above alice's ALREADY-attested tier,
        // no new attestation, no attestor involvement at all.
        policy.setMinTier(60);

        assertFalse(registry.isCompliant(alice));
        // The underlying facts are untouched, same nonce, same issuedAt,
        // same tier, only what those facts are WORTH changed.
        assertEq(registry.lastNonce(alice), nonceBefore);
        assertEq(registry.issuedAtOf(alice), issuedAtBefore);
        (uint16 tier,,,,,) = registry.attestationOf(alice);
        assertEq(tier, 50);
    }

    function test_PolicyChangeWithoutReattestation_FlipsComplianceFromFalseToTrue() public {
        policy.setMinTier(60);

        ComplianceRegistry.ComplianceAttestation memory a = _fact(1); // tier 50, fails the floor
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));
        assertFalse(registry.isCompliant(alice));

        // Owner LOWERS the floor back down, same facts, now compliant,
        // still with no new attestation.
        policy.setMinTier(20);
        assertTrue(registry.isCompliant(alice));
    }

    // -------------------------------------------------------------------
    // ITierOracle / ICountrySource reads
    // -------------------------------------------------------------------

    function test_TierOf_And_CountryOf_ReturnAttestedFacts() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        (uint16 tier, uint16 subTier) = registry.tierOf(alice);
        assertEq(tier, 50);
        assertEq(subTier, 80);
        assertEq(registry.countryOf(alice), bytes2("US"));
    }

    // -------------------------------------------------------------------
    // ineligibilityReason
    // -------------------------------------------------------------------

    function test_IneligibilityReason_Frozen() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.apassStatus = registry.APASS_STATUS_FROZEN();
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertEq(uint8(registry.ineligibilityReason(alice)), uint8(ComplianceRegistry.Reason.FROZEN));
    }

    function test_IneligibilityReason_Expired() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        a.expiry = block.timestamp + 1;
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        vm.warp(block.timestamp + 2);
        assertEq(uint8(registry.ineligibilityReason(alice)), uint8(ComplianceRegistry.Reason.EXPIRED));
    }

    function test_IneligibilityReason_TierIneligible() public {
        policy.setMinTier(60);
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertEq(uint8(registry.ineligibilityReason(alice)), uint8(ComplianceRegistry.Reason.INELIGIBLE));
    }

    function test_IneligibilityReason_NoneWhenCompliant() public {
        ComplianceRegistry.ComplianceAttestation memory a = _fact(1);
        registry.submitAttestation(a, _sign(ATTESTOR_PK, registry, a));

        assertEq(uint8(registry.ineligibilityReason(alice)), uint8(ComplianceRegistry.Reason.NONE));
    }

    function test_IneligibilityReason_NeverAttested() public view {
        assertEq(uint8(registry.ineligibilityReason(alice)), uint8(ComplianceRegistry.Reason.INELIGIBLE));
    }
}
