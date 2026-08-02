// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {ICountrySource} from "../src/interfaces/ICountrySource.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
import {TestCountrySource} from "../src/test/TestCountrySource.sol";
import {CompliancePolicy} from "../src/CompliancePolicy.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {RevocationGuardian} from "../src/RevocationGuardian.sol";

/**
 * @title DeployLocal
 * @notice Deploys Revoca's full on-chain stack to a local anvil instance for
 * the end-to-end rehearsal (see backend/test/e2e-local-rehearsal.test.ts).
 * This is NOT a testnet/mainnet deployment script, it hardcodes anvil's
 * well-known default dev accounts (the standard "test test test ... junk"
 * mnemonic, printed by every `anvil` invocation, holding no real value) as
 * the deployer/lender/borrower/keeper roles, so the rehearsal is fully
 * deterministic and reproducible without any .env wiring beyond
 * ATTESTOR_PRIVATE_KEY (which the backend attestor service uses to SIGN,
 * this script just needs to know the matching ADDRESS to authorize via
 * `setAttestor` on the registry).
 *
 * Compliance source for this rehearsal: ComplianceRegistry, wired as BOTH
 * LendingPool's `complianceGate` and `tierOracle` (it implements both
 * interfaces, see ComplianceRegistry.sol's header). This is Design B's real
 * implementation (Phase 2b, docs/ROADMAP.md), not TestComplianceGate/
 * TestTierOracle, those remain isolated-unit-test-only doubles (see
 * contracts/test/), not part of this wired end-to-end deployment, since the
 * whole point here is to prove the EIP-712 attestation WRITE path against a
 * real signature-gated registry, which the Test doubles have no equivalent
 * of. Seeding uses this same script's ATTESTOR_PK to sign+submit real
 * ComplianceAttestations via `vm.sign`, NOT a live Monad relay (that's
 * Phase 3); everything here runs against local anvil only.
 *
 * CompliancePolicy (docs/ROADMAP.md Phase 2a) is deployed first and wired
 * into both the registry (staleness tolerance) and the pool (eligibility
 * rules, ratio bands, borrow caps), the single source of truth every
 * other piece reads from. Country eligibility uses TestCountrySource
 * (seam-with-test-double, per CompliancePolicy.sol's header, no real
 * Cleanverse-backed country source exists yet); the default policy has an
 * empty country rule, so this doesn't change the rehearsal's existing
 * behavior unless the script explicitly configures a country restriction.
 *
 * Run with (from contracts/):
 *   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract DeployLocal is Script {
    // Anvil's default accounts (mnemonic "test test test ... junk"), public,
    // well-known, hold no real value. Never used for anything but local anvil.
    uint256 constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant LENDER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant BORROWER1_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    // Renamed from KEEPER_PK (Phase 2a/pre-2b): this anvil account now signs
    // ComplianceAttestations as the registry's authorized attestor, per
    // Phase 2b's Design-B rework, it is no longer a "keeper" permission at
    // all (flag/reinstate/startUnwind/completeUnwind are permissionless).
    uint256 constant ATTESTOR_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant BORROWER2_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant LIQUIDATOR_PK = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
    uint256 constant BORROWER3_PK = 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e;

    uint256 constant MAX_COMPLIANCE_STALENESS = 1800; // 30 min
    uint256 constant GRACE_PERIOD = 60; // 1 min, short deliberately, so the rehearsal can fast-forward past it quickly
    uint256 constant INTEREST_RATE_BPS_PER_SECOND = 1;
    uint256 constant LIQUIDATION_BONUS_BPS = 500;

    // Seed position (borrower1, borrower2): tier 50 / subTier 80 -> 80%
    // ratio -> genuinely under-collateralized (debt > collateral), per
    // Part 3 step 1's requirement to prove under-collateralization works.
    // Both borrower1 (Branch A: reinstatement) and borrower2 (Branch B:
    // unwind, self-cure insufficient -> spills to liquidation) share this
    // setup, since `applyCollateralToDebt` always drains ALL collateral
    // when it can't fully cover debt, meaning that branch necessarily
    // ends with ZERO residual (there's nothing left for liquidation to
    // seize either). That's correct, expected behavior, not a bug.
    uint256 constant SEED_COLLATERAL = 1000e18;
    uint256 constant SEED_BORROW = 1200e18;
    uint16 constant SEED_TIER = 50;
    uint16 constant SEED_SUB_TIER = 80;

    // Seed position (borrower3): same tier, but collateral generously
    // exceeds debt, so self-cure alone fully resolves the unwind with a
    // genuine residual left over, this is what demonstrates the fairness
    // property (a still-non-compliant borrower recovering residual
    // collateral) with a NONZERO amount, which borrower2's scenario above
    // structurally cannot show.
    uint256 constant BORROWER3_COLLATERAL = 2000e18;
    uint256 constant BORROWER3_BORROW = 1000e18;

    // Grouped into a struct (rather than many run()-local variables) to
    // avoid a "stack too deep" compile error, LendingPool's constructor
    // alone now takes 8 args, and Solidity's legacy codegen has a limited
    // number of simultaneously-reachable stack slots.
    struct Deployed {
        MockERC20 asset;
        CompliancePolicy policy;
        ComplianceRegistry registry;
        TestCountrySource countrySource;
        LendingPool pool;
        RevocationGuardian guardian;
    }

    function run() external {
        address deployer = vm.addr(DEPLOYER_PK);

        vm.startBroadcast(DEPLOYER_PK);
        Deployed memory d = _deployCore(deployer);
        _setGuardianAndAttestor(d, deployer);
        _fundActors(d.asset);
        vm.stopBroadcast();

        vm.startBroadcast(LENDER_PK);
        d.asset.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(500_000e18);
        vm.stopBroadcast();

        _seedAttestations(d);
        _seedBorrower(d, BORROWER1_PK, SEED_COLLATERAL, SEED_BORROW);
        _seedBorrower(d, BORROWER2_PK, SEED_COLLATERAL, SEED_BORROW);
        _seedBorrower(d, BORROWER3_PK, BORROWER3_COLLATERAL, BORROWER3_BORROW);

        vm.startBroadcast(LIQUIDATOR_PK);
        d.asset.approve(address(d.pool), type(uint256).max);
        vm.stopBroadcast();

        _logAndWrite(d);
    }

    function _deployCore(address deployer) internal returns (Deployed memory d) {
        d.asset = new MockERC20("Revoca Rehearsal USD", "rrUSD");
        d.policy = new CompliancePolicy(deployer, GRACE_PERIOD, MAX_COMPLIANCE_STALENESS);
        d.registry = new ComplianceRegistry(deployer, d.policy);
        d.countrySource = new TestCountrySource();
        d.pool = new LendingPool(
            IERC20(address(d.asset)),
            IComplianceGate(address(d.registry)),
            ITierOracle(address(d.registry)),
            ICountrySource(address(d.countrySource)),
            d.policy,
            deployer,
            INTEREST_RATE_BPS_PER_SECOND,
            LIQUIDATION_BONUS_BPS
        );
        d.guardian = new RevocationGuardian(d.registry, d.pool, deployer);
    }

    function _setGuardianAndAttestor(Deployed memory d, address deployer) internal {
        d.pool.setGuardian(address(d.guardian));
        // The real attestation service (backend, signing with
        // ATTESTOR_PRIVATE_KEY) is the authorized signer going forward.
        // ATTESTOR_PK is also what THIS script uses to sign the seed
        // attestations below (see `_seedAttestations`), so only one
        // authorization is actually required, `deployer` is not authorized,
        // unlike the old keeper-gated design, since attestations are signed
        // off-chain and relayed permissionlessly (trust is in the signature,
        // not the submitting/authorizing address).
        d.registry.setAttestor(vm.addr(ATTESTOR_PK), true);
    }

    function _fundActors(MockERC20 asset) internal {
        asset.mint(vm.addr(LENDER_PK), 1_000_000e18);
        asset.mint(vm.addr(BORROWER1_PK), 10_000e18);
        asset.mint(vm.addr(BORROWER2_PK), 10_000e18);
        asset.mint(vm.addr(BORROWER3_PK), 10_000e18);
        asset.mint(vm.addr(LIQUIDATOR_PK), 10_000e18);
    }

    /// @dev Builds an EIP-712 struct hash for `a` using the DEPLOYED
    /// registry's own typehash, mirrors contracts/test/helpers/
    /// EIP712TestUtils.sol's `_structHash`, duplicated here rather than
    /// imported since scripts (forge-std Script) and tests (forge-std Test)
    /// are separate base contracts.
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

    function _signAttestation(ComplianceRegistry registry, ComplianceRegistry.ComplianceAttestation memory a)
        internal
        returns (bytes memory signature)
    {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), _structHash(registry, a)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR_PK, digest);
        signature = abi.encodePacked(r, s, v);
    }

    // Seed all three borrowers with a compliant, freshly-signed attestation.
    // borrower1/borrower2 share an identical under-collateralized setup
    // (debt > collateral at the 80% ratio), Branch A (reinstatement) and
    // Branch B (unwind, self-cure insufficient) start identically and
    // diverge later based on what the keeper does after each is frozen.
    // borrower3 gets generous collateral instead, for the
    // self-cure-sufficient unwind variant, see
    // backend/test/e2e-local-rehearsal.test.ts. Any address may relay a
    // valid attestation, so these are broadcast from DEPLOYER_PK purely as
    // the transaction sender, the trust is entirely in the ATTESTOR_PK
    // signature over each ComplianceAttestation.
    function _seedAttestations(Deployed memory d) internal {
        address[3] memory borrowers = [vm.addr(BORROWER1_PK), vm.addr(BORROWER2_PK), vm.addr(BORROWER3_PK)];

        vm.startBroadcast(DEPLOYER_PK);
        for (uint256 i = 0; i < borrowers.length; i++) {
            ComplianceRegistry.ComplianceAttestation memory a = ComplianceRegistry.ComplianceAttestation({
                user: borrowers[i],
                tier: SEED_TIER,
                subTier: SEED_SUB_TIER,
                country: bytes2("US"),
                apassStatus: d.registry.APASS_STATUS_ACTIVE(),
                expiry: block.timestamp + 365 days,
                issuedAt: block.timestamp,
                nonce: d.registry.lastNonce(borrowers[i]) + 1
            });
            d.registry.submitAttestation(a, _signAttestation(d.registry, a));
        }
        vm.stopBroadcast();
    }

    function _seedBorrower(Deployed memory d, uint256 borrowerPk, uint256 collateralAmount, uint256 borrowAmount)
        internal
    {
        vm.startBroadcast(borrowerPk);
        d.asset.approve(address(d.pool), type(uint256).max);
        d.pool.postCollateral(collateralAmount);
        d.pool.borrow(borrowAmount);
        vm.stopBroadcast();
    }

    function _logAndWrite(Deployed memory d) internal {
        console.log("asset:     ", address(d.asset));
        console.log("policy:    ", address(d.policy));
        console.log("registry:  ", address(d.registry));
        console.log("pool:      ", address(d.pool));
        console.log("guardian:  ", address(d.guardian));
        console.log("deployer:  ", vm.addr(DEPLOYER_PK));
        console.log("lender:    ", vm.addr(LENDER_PK));
        console.log("borrower1: ", vm.addr(BORROWER1_PK));
        console.log("borrower2: ", vm.addr(BORROWER2_PK));
        console.log("borrower3: ", vm.addr(BORROWER3_PK));
        console.log("attestor:  ", vm.addr(ATTESTOR_PK));
        console.log("liquidator:", vm.addr(LIQUIDATOR_PK));

        string memory json = "deployment";
        vm.serializeAddress(json, "asset", address(d.asset));
        vm.serializeAddress(json, "policy", address(d.policy));
        vm.serializeAddress(json, "registry", address(d.registry));
        vm.serializeAddress(json, "pool", address(d.pool));
        vm.serializeAddress(json, "guardian", address(d.guardian));
        vm.serializeAddress(json, "deployer", vm.addr(DEPLOYER_PK));
        vm.serializeAddress(json, "lender", vm.addr(LENDER_PK));
        vm.serializeAddress(json, "borrower1", vm.addr(BORROWER1_PK));
        vm.serializeAddress(json, "borrower2", vm.addr(BORROWER2_PK));
        vm.serializeAddress(json, "borrower3", vm.addr(BORROWER3_PK));
        vm.serializeAddress(json, "attestor", vm.addr(ATTESTOR_PK));
        string memory finalJson = vm.serializeAddress(json, "liquidator", vm.addr(LIQUIDATOR_PK));

        vm.writeJson(finalJson, "../deployments/local.json");
    }
}
