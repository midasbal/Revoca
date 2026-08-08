// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {HybridComplianceGate} from "../src/HybridComplianceGate.sol";
import {IAPassComplianceValidator} from "../src/interfaces/IAPassComplianceValidator.sol";
import {TestComplianceGate} from "../src/test/TestComplianceGate.sol";

/**
 * @notice REAL integration coverage against the REAL Cleanverse CVI
 * Compliance Validator on the REAL Monad testnet, no mock data, per
 * CLAUDE.md's "no mock data for compliance" rule. Forks live Monad testnet
 * state (read-only, no transaction sent, no private key needed) and checks
 * HybridComplianceGate's ValidatorGated mode against the already-registered
 * probe pool proven live in docs/DESIGN_A_SPIKE.md section 5
 * (`MinimalRegistrationProbe`, deployed and registered this session, real tx
 * hashes recorded there). This is deliberately the SAME probe pool the spike
 * already proved, not a new registration, see this session's scoping
 * decision: real pool registration for the actual LendingPool is a later
 * deploy step, not this session's.
 *
 * Requires MONAD_TESTNET_RPC in .env (real, live sandbox reads, never
 * faked). Skips automatically, rather than failing, when it isn't set,
 * matching backend/test/e2e-local-rehearsal.test.ts's convention for tests
 * that need real external infrastructure.
 *
 * Addresses below are all real, recorded in docs/DESIGN_A_SPIKE.md section
 * 5 (gitignored, local), not invented: the validator's documented address
 * (same on every chain), the probe pool this session registered, and two
 * known real active A-Passes plus one known real no-A-Pass address, all
 * independently confirmed against complianceVerify this session.
 */
contract HybridComplianceGateMonadForkTest is Test {
    address constant VALIDATOR_ADDRESS = 0xaC7e5179C2C7f03f209136886c172eb34F161792;
    address constant PROBE_POOL = 0x5601aE44ED6F89BE7C708fe82e1D9863CBD4110c;

    address constant NO_APASS_DEPLOYER = 0xe78733A6228A70Df75F0974b168076F17D8baF89;
    address constant KNOWN_ACTIVE_APASS_1 = 0xA5d56A6a4451d339ed68cc3302bc0bDbb214F0Fa;
    address constant KNOWN_ACTIVE_APASS_2 = 0x676CBD5978FdeBa8C9e55Bf122B366F9a1734019;

    HybridComplianceGate gate;

    function setUp() public {
        string memory rpcUrl = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "MONAD_TESTNET_RPC not set, skipping real Monad testnet fork test");
            return;
        }
        vm.createSelectFork(rpcUrl);

        // AttestorGated fallback wired but irrelevant to these assertions,
        // this test exercises ValidatorGated mode exclusively; a fresh
        // TestComplianceGate is enough to satisfy the constructor's
        // non-zero check.
        TestComplianceGate attestorGate = new TestComplianceGate();

        gate = new HybridComplianceGate(
            address(this),
            IAPassComplianceValidator(VALIDATOR_ADDRESS),
            PROBE_POOL,
            attestorGate,
            HybridComplianceGate.Mode.ValidatorGated
        );
    }

    function test_RealValidator_ReturnsFalse_ForAddressWithNoApass() public view {
        if (address(gate) == address(0)) return; // skipped in setUp
        assertFalse(gate.isCompliant(NO_APASS_DEPLOYER));
    }

    function test_RealValidator_ReturnsTrue_ForKnownActiveApass_1() public view {
        if (address(gate) == address(0)) return; // skipped in setUp
        assertTrue(gate.isCompliant(KNOWN_ACTIVE_APASS_1));
    }

    function test_RealValidator_ReturnsTrue_ForKnownActiveApass_2() public view {
        if (address(gate) == address(0)) return; // skipped in setUp
        assertTrue(gate.isCompliant(KNOWN_ACTIVE_APASS_2));
    }

    function test_RealValidator_IsAlwaysFresh() public view {
        if (address(gate) == address(0)) return; // skipped in setUp
        assertTrue(gate.isFresh(KNOWN_ACTIVE_APASS_1));
    }
}
