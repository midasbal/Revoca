# Threat model

Portfolio-grade, treat this seriously, not as a checkbox. Each item below
needs a real design answer before or during the build, not just an
acknowledgment.

## 1. Poll-latency race between a freeze and detection

The keeper polls `query_apass` / `validator/verify` on an interval; it is not
subscribed to real-time freeze events. Between the moment an A-Pass is frozen
and the moment the keeper's next poll detects it, the borrower's on-chain
position is stale-compliant.

- What can happen in that window? (e.g. borrower withdraws more collateral,
  interacts with the pool in ways that assume good standing)
- Does poll interval need to be bounded by a worst-case loss the pool can
  absorb?
- Is there a cheaper on-chain check (e.g. re-verify at every state-changing
  call, not just relying on the keeper) that shrinks or eliminates this
  window?

## 2. Griefing, inducing a freeze to trigger a profitable liquidation

If any party (not just the borrower) can cause an A-Pass to be frozen or
downgraded (e.g. by reporting the borrower, or via some Cleanverse-side
process we don't fully control), could someone induce a freeze on a
borrower's A-Pass specifically to trigger a liquidation they profit from?

- What's the liquidation incentive structure, and who can claim it?
- Does the unwind path need a delay/grace period specifically to blunt this,
  separate from any grace period for false positives?

## 3. Reentrancy on the unwind path

`RevocationGuardian`'s unwind likely moves collateral and/or debt state in
one transaction, possibly interacting with external calls (token transfers,
oracle reads, Validator calls).

- Standard checks-effects-interactions and reentrancy guards apply, call
  this out explicitly in the contract, don't assume it away.
- Does the unwind ever call back into `LendingPool` in a way that could be
  re-entered mid-unwind?

## 4. Who bears the loss on a mid-loan revocation?

If a position is unwound because the borrower's A-Pass status changed (not
because of a market/price liquidation), the collateral value and debt may not
line up cleanly.

- If collateral > debt: does the borrower get the surplus back, or does it go
  to the pool?
- If collateral < debt at time of unwind: who eats the shortfall, the pool,
  the lender(s), a protocol reserve?
- Is this the same liquidation path as an under-collateralization event, or a
  distinct one with different economics? (Scope says "single pool", decide
  explicitly rather than let the code decide by default.)

## 5. Owner-signature registration risks

`validator/register` and `validator/grant` require an `owner_signature`, an
EIP-191 `personal_sign` by the address that is `Ownable.owner()` of the pool
contract, over `lowercase(chain) + lowercase(address)` with no separator.

- Where is the owner private key held during the hackathon, and is it ever
  the same key as `DEPLOYER_PRIVATE_KEY`? (If so, that's a single point of
  failure worth naming explicitly, even if accepted for the hackathon.)
- Is there any replay risk with this signature scheme across chains or
  contracts (the signed message doesn't include the contract address
  itself, only chain + address, confirm exactly what "address" refers to:
  owner address or contract address, against the PDF, don't assume).

## 6. AES key handling and exposure

`CLEANVERSE_API_KEY` is a local AES key, never transmitted.

- Confirm no code path logs it (including uncaught exception handlers,
  request/response logging middleware, or error messages that dump request
  context).
- Confirm it's read only in the backend process, never passed to the
  frontend bundle, never included in any RPC/tx payload.
- What's the blast radius if it leaks? (It's used to decrypt Cleanverse
  responses and encrypt requests, leakage lets an attacker read/forge
  encrypted payloads, but does not by itself grant on-chain authority.)

## 7. Attestor trust (Design B only)

If we fall back to the attestor design (see
[docs/ARCHITECTURE.md](ARCHITECTURE.md)), the pool trusts a backend-signed
attestation instead of an on-chain Validator read.

- What can a compromised or buggy attestor key do? (Likely: falsely attest
  compliance for an ineligible address, or falsely attest non-compliance to
  grief a legitimate borrower.)
- Attestation expiry, how short, and what happens on backend downtime?
- Is the attestor key different from the deployer/owner key? Should be.

## 8. Tier-downgrade timing

Tier (not just active/frozen status) affects collateral requirements. A
borrower's tier can drop without their A-Pass being frozen, they're still
"active" but no longer meet the pool's minimum tier for their existing
position's collateral ratio.

- Does a tier downgrade trigger the same unwind path as a freeze, or a
  softer one (e.g. requiring the borrower to post more collateral before a
  hard unwind)?
- How is this distinguished from a freeze/expiration/blacklist in
  `RevocationGuardian`'s logic, same function, different severity, or
  entirely separate handling?

## 9. EIP-712 attestation path (Phase 2b, implemented)

Item 7 above was written before Design B had a real implementation. Now that
`ComplianceRegistry.submitAttestation` (contracts/src/ComplianceRegistry.sol)
and `backend/src/attestor` exist, here's the concrete analysis of the actual
mechanism, not the earlier open question.

**Attestor key compromise.** The attestor's key
(`ATTESTOR_PRIVATE_KEY`, distinct from `KEEPER_PRIVATE_KEY` and
`DEPLOYER_PRIVATE_KEY`, see `.env.example`) can sign *any* facts for *any*
address once authorized via `setAttestor`. A compromised key can falsely
attest an ineligible address as tier-eligible/active, or falsely attest a
legitimate borrower as frozen. Blast radius is bounded by two things:
`isTierEligible`/`isCountryEligible` still gate on `CompliancePolicy`, so a
malicious attestation can't grant eligibility the policy itself forbids
outright at the tier axis Cleanverse doesn't control; and `maxComplianceStaleness`
bounds how long a forged attestation stays usable before it must be
refreshed. **Mitigation: rotation.** `setAttestor(old, false)` +
`setAttestor(new, true)` is owner-only and takes effect immediately,
already-stored facts from the compromised key remain live until they go
stale or are overwritten, so rotation alone doesn't retroactively invalidate
prior damage; pairing rotation with a policy tightening (e.g. temporarily
raising `minTier`) is the faster way to neutralize an in-flight bad
attestation pool-wide. `isAttestor` supports multiple simultaneous signers,
so rotation never requires downtime.

**Replay.** Prevented by the per-user monotonic nonce
(`nonce > lastNonce[user]`, enforced in `submitAttestation`, see
`NonceNotIncreasing`). A captured, previously-valid signature can never be
resubmitted, even resubmitting the IDENTICAL facts requires a strictly
higher nonce, which requires a new signature from the attestor.

**Signature malleability.** `submitAttestation` recovers the signer via
OpenZeppelin's `ECDSA.recover`, which rejects non-canonical (high-`s`)
signatures and malformed lengths with its own typed errors
(`ECDSAInvalidSignatureS`, `ECDSAInvalidSignatureLength`) rather than
silently accepting a malleable second valid signature for the same digest.
This closes the classic "flip `s`, resubmit, double-count" class of bug,
combined with the nonce check above, a malleable variant of an already-used
signature is also a replay and would fail the nonce check even if the
malleability check somehow didn't catch it first.

**Domain confusion.** The EIP-712 domain (`name: "Revoca"`, `version: "1"`,
`chainId`, `verifyingContract: <this registry>`) is baked into
`_hashTypedDataV4`'s digest per OpenZeppelin's `EIP712`. An attestation
signed for a different chain ID or a different registry deployment recovers
to a *different* signer address for THIS registry's domain, it doesn't
partially validate or accidentally apply to the wrong contract. Verified
directly: `contracts/test/ComplianceRegistry.t.sol`'s
`test_SubmitAttestation_RevertsForWrongChainIdDomain`/
`RevertsForWrongVerifyingContractDomain`, and
`backend/test/attestation-anvil-crosscheck.test.ts`'s hand-computed domain
separator check (independently re-derives the domain separator off-chain
and asserts byte-for-byte equality with the deployed contract's own).

**Relayer front-running/griefing.** `submitAttestation` is deliberately
permissionless, "trust is in the signature, not the sender", so anyone
can relay a valid attestation, including front-running the attestor's own
relay with the identical (attestation, signature) pair. This is harmless by
design: the facts and nonce are fixed by the SIGNATURE, not the relayer,
so front-running only changes who pays gas, never what gets stored. A
griefer could also relay a *stale* old signature before the attestor
refreshes it, but that's just today's already-current state re-submitted,
not an attack surface, since `nonce` still only accepts strictly-increasing
values and the facts a griefer could re-relay are ones the attestor already
signed and intended to be true at the time.

**Stale-fact risk.** An attestation is a snapshot as of `issuedAt`, not a
live feed. Between attestations, a borrower's real A-Pass state can change
(e.g. get frozen) without the registry reflecting it yet, the same
poll-latency race as item 1, now bounded on the registry side by
`maxComplianceStaleness`: `isFresh()` (checked by `LendingPool` for every
risk-increasing action) goes false once an attestation ages past that
window, forcing a fresh attestation before the borrower can borrow/increase
exposure further. Note deliberately: `isCompliant()` does NOT fold in
freshness (see `ComplianceRegistry.sol`'s header), a stale-but-once-valid
attestation still reports `isCompliant() == true`, it just also reports
`isFresh() == false`, and the pool is the one that combines both. Repay,
liquidate, unwind, and zero-debt collateral withdrawal are never gated on
freshness, a stale attestation can never trap a borrower's exit.
