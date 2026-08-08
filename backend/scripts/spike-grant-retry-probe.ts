import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { Address, Hex } from "viem";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError } from "../src/cleanverse/errors.js";
import { ownerSignature, accountFromPrivateKey } from "../src/cleanverse/signature.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

async function main() {
  const probeAddress = "0x5601aE44ED6F89BE7C708fe82e1D9863CBD4110c" as Address;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const account = accountFromPrivateKey(deployerPk);
  const client = new CleanverseClient(loadConfig());
  const sig = await ownerSignature("monad", probeAddress, account);
  try {
    const result = await client.validatorGrant({ chain: "monad", address: probeAddress, owner_signature: sig });
    console.log("SUCCESS", JSON.stringify(result));
  } catch (err) {
    if (err instanceof CleanverseApiError) {
      console.log(`API ERROR code=${err.code} message=${JSON.stringify(err.apiMessage)} request-id=${err.requestId}`);
    } else {
      console.log("error", err);
    }
  }
}
main();
