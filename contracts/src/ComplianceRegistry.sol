// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {ITierOracle} from "./interfaces/ITierOracle.sol";
import {ICountrySource} from "./interfaces/ICountrySource.sol";
import {CompliancePolicy} from "./CompliancePolicy.sol";

/**
 * @title ComplianceRegistry
 * @notice The real Design B: an EIP-712 signed-attestation compliance
 * oracle. This is Phase 2b of docs/ROADMAP.md, the spine of the attestor
 * path, now our PRIMARY design (the on-chain Validator appears unavailable
 * on Monad in the sandbox; see docs/ROADMAP.md's Design A/B decision).
 *
 * CORE DESIGN PRINCIPLE, ATTEST FACTS, NEVER A VERDICT: the attestor signs
 * raw identity facts read from Cleanverse, `{user, tier, subTier, country,
 * apassStatus, expiry, issuedAt, nonce}`, and NOTHING ELSE. There is no
 * "compliant: bool" field in the signed data. Eligibility
 * (`isCompliant`/`isTierEligible`/`isCountryEligible`) is derived ON-CHAIN,
 * live, by evaluating those stored facts against `policy`
 * (CompliancePolicy) at query time. The attestor vouches only for "this is
 * what Cleanverse reported, as of `issuedAt`", what that earns a user is
 * entirely `policy`'s call, not the attestor's.
 *
 * CONSEQUENCE, DELIBERATE AND TESTED: if the owner tightens `policy` (e.g.
 * raises `minTier`) after a user was attested, that user's `isCompliant()`
 * flips immediately, with NO new attestation required and no attestor
 * action at all. The facts didn't change; what they're worth did. See
 * test/ComplianceRegistry.t.sol's policy-change-without-reattestation test.
 *
 * TRUST MODEL: this contract implements IComplianceGate + ITierOracle +
 * ICountrySource, the same seams LendingPool/RevocationGuardian already
 * depend on via TestComplianceGate/TestTierOracle/TestCountrySource in
 * unit tests. Wiring this contract in instead of the Test doubles is a
 * pure swap; no pool/guardian code changes for it. Any address may relay a
 * valid, signed attestation (`submitAttestation`), trust lives entirely in
 * the ECDSA signature over the EIP-712 digest, verified against an
 * `isAttestor`-authorized signer, not in who calls the function. See
 * docs/THREAT_MODEL.md for the attestor-key-compromise, replay,
 * malleability, domain-confusion, and relayer-griefing analysis.
 *
 * NOT BUILT HERE (deliberately, Phase 3 scope): wiring this contract to a
 * REAL Monad testnet deployment, or having the backend attestor sign based
 * on a LIVE production feed rather than a UAT sandbox read. This session
 * proves the on-chain verification path and the off-chain signing service
 * exclusively against local anvil + the UAT sandbox's read-only
 * `query_apass`, see backend/src/attestor/ and
 * backend/test/attestation-anvil-crosscheck.test.ts.
 */
contract ComplianceRegistry is IComplianceGate, ITierOracle, ICountrySource, EIP712, Ownable {
    /// @notice Raw A-Pass status codes, matching Cleanverse's query_apass `status` field exactly (1 = active, 2 = frozen) plus 0 for "unknown" (e.g. a null status, see docs/TIER_DISTRIBUTION.md's finding that ~92% of query_apass_list records have status:null; the singular endpoint used here is more reliable, but 0 exists so an attestor never has to lie about an unexpected value).
    uint8 public constant APASS_STATUS_UNKNOWN = 0;
    uint8 public constant APASS_STATUS_ACTIVE = 1;
    uint8 public constant APASS_STATUS_FROZEN = 2;

    /// @notice Best-effort reason for ineligibility, DERIVED live from stored facts + policy (never stored, see `ineligibilityReason`). BLACKLISTED is defined for forward-compatibility but never derivable today: query_apass's response has no field indicating blacklist status (see docs/OPEN_QUESTIONS.md item 5). TIER_DROP is never derived here either, it's pool-relative (this position's debt vs. its collateral at the CURRENT tier-derived ratio), which only RevocationGuardian can determine, since this contract has no visibility into any pool's debt/collateral.
    enum Reason {
        NONE,
        FROZEN,
        EXPIRED,
        BLACKLISTED,
        INELIGIBLE,
        TIER_DROP
    }

    /// @dev Only the raw facts an attestor vouches for, no derived/verdict field.
    struct Attestation {
        uint16 tier;
        uint16 subTier;
        bytes2 country;
        uint8 apassStatus;
        uint256 expiry; // A-Pass expirationTime, unix seconds; 0 = no expiration
        uint256 issuedAt; // when the attestor read/signed these facts, unix seconds
    }

    /// @notice The EIP-712 typed struct submitted to `submitAttestation`. Field order/types here MUST match `COMPLIANCE_ATTESTATION_TYPEHASH`'s type string exactly, and the backend's viem `types` definition (backend/src/attestor/types.ts) exactly, see Part 4's off-chain/on-chain cross-check test.
    struct ComplianceAttestation {
        address user;
        uint16 tier;
        uint16 subTier;
        bytes2 country;
        uint8 apassStatus;
        uint256 expiry;
        uint256 issuedAt;
        uint256 nonce;
    }

    /// @notice keccak256("ComplianceAttestation(address user,uint16 tier,uint16 subTier,bytes2 country,uint8 apassStatus,uint256 expiry,uint256 issuedAt,uint256 nonce)")
    bytes32 public constant COMPLIANCE_ATTESTATION_TYPEHASH =
        keccak256(
            "ComplianceAttestation(address user,uint16 tier,uint16 subTier,bytes2 country,uint8 apassStatus,uint256 expiry,uint256 issuedAt,uint256 nonce)"
        );

    /// @notice Tolerance for an attestation's `issuedAt` being ahead of this chain's clock (small clock skew between the attestor's machine and the block timestamp it lands in), beyond this, treated as suspicious rather than "slightly early."
    uint256 public constant MAX_FUTURE_SKEW = 5 minutes;

    mapping(address => Attestation) private _attestations;
    mapping(address => uint256) public lastNonce;
    mapping(address => bool) public isAttestor;

    /// @notice The single source of truth for staleness tolerance, tier eligibility, and country eligibility, see CompliancePolicy.sol.
    CompliancePolicy public immutable policy;

    event ComplianceAttested(
        address indexed user,
        uint16 tier,
        uint16 subTier,
        bytes2 country,
        uint8 apassStatus,
        uint256 expiry,
        uint256 issuedAt,
        uint256 nonce,
        address indexed attestor
    );
    event AttestorSet(address indexed attestor, bool authorized);

    error NotAuthorizedAttestor(address signer);
    error AttestationStale(uint256 issuedAt, uint256 currentTime);
    error AttestationFromFuture(uint256 issuedAt, uint256 currentTime);
    error NonceNotIncreasing(uint256 providedNonce, uint256 lastNonce);

    constructor(address initialOwner, CompliancePolicy policy_) EIP712("Revoca", "1") Ownable(initialOwner) {
        policy = policy_;
    }

    // ---------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------

    /// @notice Authorizes (or revokes) an address as a valid attestation signer. Supports rotation and multiple simultaneous attestors, never hardcode a key.
    function setAttestor(address attestor, bool authorized) external onlyOwner {
        isAttestor[attestor] = authorized;
        emit AttestorSet(attestor, authorized);
    }

    // ---------------------------------------------------------------------
    // Attestation submission, permissionless relay, trust is in the signature
    // ---------------------------------------------------------------------

    /**
     * @notice Verifies `signature` over `attestation` (EIP-712, domain
     * "Revoca"/"1"/this chain/this contract), requires the recovered
     * signer to be an authorized attestor, requires `attestation.issuedAt`
     * to be within `policy.maxComplianceStaleness()` of now (and not more
     * than `MAX_FUTURE_SKEW` in the future), requires
     * `attestation.nonce > lastNonce[attestation.user]` (strictly
     * increasing, replay protection), then stores the facts and bumps the
     * nonce. ANYONE may call this, the trust is entirely in the
     * signature, not the caller. Reverts on any check failure; never
     * partially applies.
     */
    function submitAttestation(ComplianceAttestation calldata attestation, bytes calldata signature) external {
        address signer = _recoverAttestor(attestation, signature);
        _checkFreshness(attestation.issuedAt);
        _checkAndBumpNonce(attestation.user, attestation.nonce);
        _storeAndEmit(attestation, signer);
    }

    function _recoverAttestor(ComplianceAttestation calldata attestation, bytes calldata signature)
        internal
        view
        returns (address signer)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                COMPLIANCE_ATTESTATION_TYPEHASH,
                attestation.user,
                attestation.tier,
                attestation.subTier,
                attestation.country,
                attestation.apassStatus,
                attestation.expiry,
                attestation.issuedAt,
                attestation.nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        signer = ECDSA.recover(digest, signature);
        if (!isAttestor[signer]) revert NotAuthorizedAttestor(signer);
    }

    function _checkFreshness(uint256 issuedAt) internal view {
        if (issuedAt + policy.maxComplianceStaleness() < block.timestamp) {
            revert AttestationStale(issuedAt, block.timestamp);
        }
        if (issuedAt > block.timestamp + MAX_FUTURE_SKEW) {
            revert AttestationFromFuture(issuedAt, block.timestamp);
        }
    }

    function _checkAndBumpNonce(address user, uint256 nonce) internal {
        uint256 previousNonce = lastNonce[user];
        if (nonce <= previousNonce) revert NonceNotIncreasing(nonce, previousNonce);
        lastNonce[user] = nonce;
    }

    function _storeAndEmit(ComplianceAttestation calldata attestation, address signer) internal {
        _attestations[attestation.user] = Attestation({
            tier: attestation.tier,
            subTier: attestation.subTier,
            country: attestation.country,
            apassStatus: attestation.apassStatus,
            expiry: attestation.expiry,
            issuedAt: attestation.issuedAt
        });

        emit ComplianceAttested(
            attestation.user,
            attestation.tier,
            attestation.subTier,
            attestation.country,
            attestation.apassStatus,
            attestation.expiry,
            attestation.issuedAt,
            attestation.nonce,
            signer
        );
    }

    /// @notice The EIP-712 domain separator for this contract/chain, exposed so off-chain signers (and tests) can independently verify their computed digest matches what this contract expects, without needing to trust this contract's own signing.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------
    // IComplianceGate, derived from stored facts + policy, NOT stored directly
    // ---------------------------------------------------------------------

    /**
     * @inheritdoc IComplianceGate
     * @dev Deliberately does NOT check `isFresh`, see this contract's
     * header and IComplianceGate.sol: staleness and compliance are
     * separate questions, and callers that need both (e.g.
     * LendingPool.borrow) check both explicitly.
     */
    function isCompliant(address user) external view returns (bool) {
        Attestation storage a = _attestations[user];
        if (a.issuedAt == 0) return false; // never attested
        if (a.apassStatus != APASS_STATUS_ACTIVE) return false;
        if (a.expiry != 0 && a.expiry <= block.timestamp) return false; // 0 = no expiration
        if (!policy.isTierEligible(a.tier, a.subTier)) return false;
        if (!policy.isCountryEligible(a.country)) return false;
        return true;
    }

    /// @inheritdoc IComplianceGate
    function isFresh(address user) public view returns (bool) {
        uint256 issuedAt = _attestations[user].issuedAt;
        // Never-attested is never fresh, independent of how large
        // maxComplianceStaleness is, mirrors the prior keeper-based
        // registry's identical "observedAt == 0 -> not fresh" rule.
        if (issuedAt == 0) return false;
        return block.timestamp - issuedAt <= policy.maxComplianceStaleness();
    }

    // ---------------------------------------------------------------------
    // ITierOracle / ICountrySource, also derived from stored facts
    // ---------------------------------------------------------------------

    /// @inheritdoc ITierOracle
    function tierOf(address user) external view returns (uint16 tier, uint16 subTier) {
        Attestation storage a = _attestations[user];
        return (a.tier, a.subTier);
    }

    /// @inheritdoc ICountrySource
    function countryOf(address user) external view returns (bytes2 country) {
        return _attestations[user].country;
    }

    // ---------------------------------------------------------------------
    // Registry-specific reads, used by RevocationGuardian, dashboards, keepers
    // ---------------------------------------------------------------------

    /// @notice The unix-seconds timestamp the current attestation claims to have been issued at (attestor-chosen, not block.timestamp-of-submission).
    function issuedAtOf(address user) external view returns (uint256) {
        return _attestations[user].issuedAt;
    }

    /**
     * @notice Best-effort reason `user` currently fails eligibility,
     * derived live from stored facts + policy (see this contract's
     * header). Returns `Reason.NONE` if currently compliant. Used by
     * RevocationGuardian.flag() instead of a keeper-supplied verdict,
     * there is no such thing anymore; every reason is computed, not
     * stored.
     */
    function ineligibilityReason(address user) external view returns (Reason) {
        Attestation storage a = _attestations[user];
        if (a.issuedAt == 0) return Reason.INELIGIBLE; // never attested, generic bucket, nothing more specific to say
        if (a.apassStatus == APASS_STATUS_FROZEN) return Reason.FROZEN;
        if (a.apassStatus != APASS_STATUS_ACTIVE) return Reason.INELIGIBLE; // e.g. APASS_STATUS_UNKNOWN, not frozen, but not a live A-Pass either
        if (a.expiry != 0 && a.expiry <= block.timestamp) return Reason.EXPIRED;
        if (!policy.isTierEligible(a.tier, a.subTier)) return Reason.INELIGIBLE;
        if (!policy.isCountryEligible(a.country)) return Reason.INELIGIBLE;
        return Reason.NONE;
    }

    /// @notice Full stored attestation facts in one call, for dashboards/keepers that want everything at once.
    function attestationOf(address user)
        external
        view
        returns (uint16 tier, uint16 subTier, bytes2 country, uint8 apassStatus, uint256 expiry, uint256 issuedAt)
    {
        Attestation storage a = _attestations[user];
        return (a.tier, a.subTier, a.country, a.apassStatus, a.expiry, a.issuedAt);
    }
}
