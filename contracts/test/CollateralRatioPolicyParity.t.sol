// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CollateralRatioPolicy} from "../src/CollateralRatioPolicy.sol";

/// @notice Deployable harness, CollateralRatioPolicy is abstract (it
/// inherits Ownable, whose constructor needs an initial owner) so it can't
/// be deployed directly in a test.
contract CollateralRatioPolicyHarness is CollateralRatioPolicy {
    constructor(address initialOwner) Ownable(initialOwner) {}
}

/**
 * @notice Asserts CollateralRatioPolicy.collateralRatioBps produces the
 * EXACT SAME output as backend/src/risk/tierRatios.ts's collateralRatioBps,
 * for every (tier, subTier) combination that appears in the real sandbox
 * data (docs/TIER_DISTRIBUTION.md: tiers 0/20/50, subTiers 0/1/9/10/20/30/50/80).
 *
 * Uses `vm.ffi` to shell out to the actual TS module at test time (via
 * backend/scripts/collateral-ratio-cli.ts) rather than hardcoding an
 * "expected value" table in Solidity, a hardcoded table could itself
 * silently drift from tierRatios.ts if only one file were edited later.
 * Shelling out to the real runtime output means editing either file's band
 * table without updating the other fails this test immediately.
 *
 * Requires `ffi = true` in foundry.toml (see that file's comment) and a
 * working `tsx` install in backend/node_modules, run `npm install` in
 * backend/ first if this test fails with a "No such file or directory".
 */
contract CollateralRatioPolicyParityTest is Test {
    CollateralRatioPolicyHarness policy;

    // Real tiers/subTiers observed in docs/TIER_DISTRIBUTION.md.
    uint16[3] TIERS = [0, 20, 50];
    uint16[8] SUB_TIERS = [0, 1, 9, 10, 20, 30, 50, 80];

    function setUp() public {
        policy = new CollateralRatioPolicyHarness(address(this));
    }

    function _tsCollateralRatioBps(uint16 tier, uint16 subTier) internal returns (uint256) {
        string[] memory cmd = new string[](4);
        cmd[0] = "../backend/node_modules/.bin/tsx";
        cmd[1] = "../backend/scripts/collateral-ratio-cli.ts";
        cmd[2] = vm.toString(uint256(tier));
        cmd[3] = vm.toString(uint256(subTier));
        bytes memory result = vm.ffi(cmd);
        return abi.decode(result, (uint256));
    }

    function test_ParityAcrossAllRealTierSubTierCombinations() public {
        for (uint256 t = 0; t < TIERS.length; t++) {
            for (uint256 s = 0; s < SUB_TIERS.length; s++) {
                uint16 tier = TIERS[t];
                uint16 subTier = SUB_TIERS[s];

                uint256 onChain = policy.collateralRatioBps(tier, subTier);
                uint256 offChain = _tsCollateralRatioBps(tier, subTier);

                assertEq(
                    onChain,
                    offChain,
                    string.concat(
                        "parity mismatch at tier=",
                        vm.toString(uint256(tier)),
                        " subTier=",
                        vm.toString(uint256(subTier))
                    )
                );
            }
        }
    }

    function test_ParityAtBandBoundaries() public {
        // Exact boundary values, mirroring test/tierRatios.test.ts's boundary tests.
        assertEq(policy.collateralRatioBps(50, 80), _tsCollateralRatioBps(50, 80));
        assertEq(policy.collateralRatioBps(50, 79), _tsCollateralRatioBps(50, 79));
        assertEq(policy.collateralRatioBps(50, 20), _tsCollateralRatioBps(50, 20));
        assertEq(policy.collateralRatioBps(50, 19), _tsCollateralRatioBps(50, 19));
    }

    function test_ParityForUnobservedIntermediateTier() public {
        // tier 35 has no dedicated band in either implementation, both
        // must fall through to tier 20's band identically.
        assertEq(policy.collateralRatioBps(35, 80), _tsCollateralRatioBps(35, 80));
    }

    function test_ParityForTierAboveHighestObserved() public {
        assertEq(policy.collateralRatioBps(99, 80), _tsCollateralRatioBps(99, 80));
    }
}
