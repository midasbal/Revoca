// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IComplianceGate} from "../src/interfaces/IComplianceGate.sol";
import {ITierOracle} from "../src/interfaces/ITierOracle.sol";
import {MockERC20} from "../src/test/MockERC20.sol";
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
 * LOCAL_KEEPER_PRIVATE_KEY (which the backend keeper uses to SIGN, this
 * script just needs to know the matching ADDRESS to authorize as a keeper
 * on the registry).
 *
 * Compliance source for this rehearsal: ComplianceRegistry, wired as BOTH
 * LendingPool's `complianceGate` and `tierOracle` (it implements both
 * interfaces, see ComplianceRegistry.sol's header). This is Design B's
 * placeholder, not TestComplianceGate/TestTierOracle, those remain
 * isolated-unit-test-only doubles (see contracts/test/), not part of this
 * wired end-to-end deployment, since the whole point here is to prove the
 * keeper's real on-chain WRITE path against a real keeper-gated registry,
 * which the Test doubles have no equivalent of.
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
    uint256 constant KEEPER_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
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
    // alone now takes several args, and Solidity's legacy codegen has a
    // limited number of simultaneously-reachable stack slots.
    struct Deployed {
        MockERC20 asset;
        ComplianceRegistry registry;
        LendingPool pool;
        RevocationGuardian guardian;
    }

    function run() external {
        address deployer = vm.addr(DEPLOYER_PK);

        vm.startBroadcast(DEPLOYER_PK);
        Deployed memory d = _deployCore(deployer);
        _setGuardianAndKeepers(d, deployer);
        _fundActors(d.asset);
        vm.stopBroadcast();

        vm.startBroadcast(LENDER_PK);
        d.asset.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(500_000e18);
        vm.stopBroadcast();

        _seedObservations(d);
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
        d.registry = new ComplianceRegistry(deployer, MAX_COMPLIANCE_STALENESS);
        d.pool = new LendingPool(
            IERC20(address(d.asset)),
            IComplianceGate(address(d.registry)),
            ITierOracle(address(d.registry)),
            deployer,
            INTEREST_RATE_BPS_PER_SECOND,
            LIQUIDATION_BONUS_BPS
        );
        d.guardian = new RevocationGuardian(d.registry, d.pool, deployer);
    }

    function _setGuardianAndKeepers(Deployed memory d, address deployer) internal {
        d.pool.setGuardian(address(d.guardian));
        // The real keeper (backend, signing with LOCAL_KEEPER_PRIVATE_KEY)
        // is the authorized writer. The deployer is ALSO authorized here
        // purely so this script can seed the initial compliant observation
        // below without needing the keeper's key inside a deploy script,
        // separates "infra deployment" from "ongoing keeper operation."
        d.registry.setKeeper(vm.addr(KEEPER_PK), true);
        d.registry.setKeeper(deployer, true);
    }

    function _fundActors(MockERC20 asset) internal {
        asset.mint(vm.addr(LENDER_PK), 1_000_000e18);
        asset.mint(vm.addr(BORROWER1_PK), 10_000e18);
        asset.mint(vm.addr(BORROWER2_PK), 10_000e18);
        asset.mint(vm.addr(BORROWER3_PK), 10_000e18);
        asset.mint(vm.addr(LIQUIDATOR_PK), 10_000e18);
    }

    // Seed all three borrowers with a compliant + fresh observation.
    // borrower1/borrower2 share an identical under-collateralized setup
    // (debt > collateral at the 80% ratio), Branch A (reinstatement) and
    // Branch B (unwind, self-cure insufficient) start identically and
    // diverge later based on what the keeper does after each is frozen.
    // borrower3 gets generous collateral instead, for the
    // self-cure-sufficient unwind variant, see
    // backend/test/e2e-local-rehearsal.test.ts.
    function _seedObservations(Deployed memory d) internal {
        vm.startBroadcast(DEPLOYER_PK);
        d.registry.observeCompliance(vm.addr(BORROWER1_PK), true, SEED_TIER, SEED_SUB_TIER, ComplianceRegistry.Reason.NONE);
        d.registry.observeCompliance(vm.addr(BORROWER2_PK), true, SEED_TIER, SEED_SUB_TIER, ComplianceRegistry.Reason.NONE);
        d.registry.observeCompliance(vm.addr(BORROWER3_PK), true, SEED_TIER, SEED_SUB_TIER, ComplianceRegistry.Reason.NONE);
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
        console.log("registry:  ", address(d.registry));
        console.log("pool:      ", address(d.pool));
        console.log("guardian:  ", address(d.guardian));
        console.log("deployer:  ", vm.addr(DEPLOYER_PK));
        console.log("lender:    ", vm.addr(LENDER_PK));
        console.log("borrower1: ", vm.addr(BORROWER1_PK));
        console.log("borrower2: ", vm.addr(BORROWER2_PK));
        console.log("borrower3: ", vm.addr(BORROWER3_PK));
        console.log("keeper:    ", vm.addr(KEEPER_PK));
        console.log("liquidator:", vm.addr(LIQUIDATOR_PK));

        string memory json = "deployment";
        vm.serializeAddress(json, "asset", address(d.asset));
        vm.serializeAddress(json, "registry", address(d.registry));
        vm.serializeAddress(json, "pool", address(d.pool));
        vm.serializeAddress(json, "guardian", address(d.guardian));
        vm.serializeAddress(json, "deployer", vm.addr(DEPLOYER_PK));
        vm.serializeAddress(json, "lender", vm.addr(LENDER_PK));
        vm.serializeAddress(json, "borrower1", vm.addr(BORROWER1_PK));
        vm.serializeAddress(json, "borrower2", vm.addr(BORROWER2_PK));
        vm.serializeAddress(json, "borrower3", vm.addr(BORROWER3_PK));
        vm.serializeAddress(json, "keeper", vm.addr(KEEPER_PK));
        string memory finalJson = vm.serializeAddress(json, "liquidator", vm.addr(LIQUIDATOR_PK));

        vm.writeJson(finalJson, "../deployments/local.json");
    }
}
