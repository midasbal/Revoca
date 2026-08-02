// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ComplianceRegistry} from "../../src/ComplianceRegistry.sol";

/**
 * @notice Shared EIP-712 signing helpers for Solidity-side tests of
 * ComplianceRegistry.submitAttestation. Uses `vm.sign` (Forge's ECDSA
 * signing cheatcode) over a digest built the same way the contract builds
 * it, this exercises the CONTRACT's own verification logic faithfully,
 * which is what these Solidity tests are for.
 *
 * This is NOT the interoperability proof, that's
 * backend/test/attestation-anvil-crosscheck.test.ts (Part 4), which signs
 * with viem, constructing the domain/types independently in TypeScript
 * with no help from the contract at all. This helper deliberately fetches
 * the typehash and (for the "correct domain" case) the domain separator
 * FROM the deployed registry, since these tests are about the contract's
 * verification logic, not about cross-stack interoperability.
 */
abstract contract EIP712TestUtils is Test {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _structHash(ComplianceRegistry registry, ComplianceRegistry.ComplianceAttestation memory a)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                registry.COMPLIANCE_ATTESTATION_TYPEHASH(),
                a.user,
                a.tier,
                a.subTier,
                a.country,
                a.apassStatus,
                a.expiry,
                a.issuedAt,
                a.nonce
            )
        );
    }

    /// @notice The digest a correctly-configured off-chain signer would produce, fetching the domain separator directly from the deployed registry.
    function _digest(ComplianceRegistry registry, ComplianceRegistry.ComplianceAttestation memory a)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), _structHash(registry, a)));
    }

    /// @notice Builds a digest against an EXPLICIT (possibly wrong) domain separator, for constructing domain-confusion test cases (wrong chainId / wrong verifyingContract).
    function _digestWithDomain(bytes32 domainSeparator, ComplianceRegistry registry, ComplianceRegistry.ComplianceAttestation memory a)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, _structHash(registry, a)));
    }

    function _domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Revoca")), keccak256(bytes("1")), chainId, verifyingContract
            )
        );
    }

    function _sign(uint256 signerPk, ComplianceRegistry registry, ComplianceRegistry.ComplianceAttestation memory a)
        internal
        view
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, _digest(registry, a));
        signature = abi.encodePacked(r, s, v);
    }

    function _signDigest(uint256 signerPk, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
