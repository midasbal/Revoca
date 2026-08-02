/**
 * Thin CLI wrapper around collateralRatioBps, so the Solidity parity test
 * (contracts/test/CompliancePolicyRatioParity.t.sol) can shell out via
 * Forge's `vm.ffi` and compare the on-chain CompliancePolicy's ratio-band
 * output directly against this TS module's real runtime output, not a
 * hand-copied "expected value" table that could itself drift from either
 * source of truth.
 *
 * Usage: tsx collateral-ratio-cli.ts <tier> <subTier>
 *
 * Prints a 0x-prefixed, 32-byte (64 hex char) ABI-encoded uint256 to
 * stdout, i.e. exactly what `abi.decode(result, (uint256))` expects on the
 * Solidity side. NOT a plain decimal string: Forge's `vm.ffi` auto-detects
 * hex-looking stdout and decodes it as raw bytes rather than text, which
 * silently corrupts plain-decimal output for any value that happens to look
 * like valid hex (e.g. "8000" and "9000" are valid 2-byte hex, so a naive
 * `console.log(8000)` gets misinterpreted). Emitting an explicit,
 * unambiguous ABI-encoded word sidesteps that entirely.
 */
import { collateralRatioBps } from "../src/risk/tierRatios.js";

const [tierArg, subTierArg] = process.argv.slice(2);

if (tierArg === undefined || subTierArg === undefined) {
  console.error("usage: collateral-ratio-cli.ts <tier> <subTier>");
  process.exit(1);
}

const tier = Number(tierArg);
const subTier = Number(subTierArg);

const ratio = collateralRatioBps(tier, subTier);
const hex = ratio.toString(16).padStart(64, "0");
process.stdout.write(`0x${hex}`);
