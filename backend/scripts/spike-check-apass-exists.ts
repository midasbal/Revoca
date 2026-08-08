import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError } from "../src/cleanverse/errors.js";

async function main() {
  const addr = process.argv[2];
  if (!addr) { console.error("usage: spike-check-apass-exists.ts <address>"); process.exitCode = 1; return; }
  const client = new CleanverseClient(loadConfig());
  try {
    const data = await client.queryApass({ chain: "monad", address: addr });
    console.log("EXISTS:", JSON.stringify(data));
  } catch (err) {
    if (err instanceof CleanverseApiError) {
      console.log(`NOT FOUND / error: code=${err.code} message=${JSON.stringify(err.apiMessage)}`);
    } else {
      console.log("error:", err);
    }
  }
}
main();
