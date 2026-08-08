import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";

async function main() {
  const client = new CleanverseClient(loadConfig());
  const data = await client.queryApass({ chain: "monad", address: "0xd4D9F9787557Df143e962F1A42B2adA38687355A" });
  console.log(JSON.stringify(data));
}

main();
