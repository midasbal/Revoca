/**
 * Pure block-range chunking math, shared by backend/src/audit/reconstruct.ts
 * and backend/src/keeper/onchain.ts, both of which page `eth_getLogs`
 * requests to stay under real RPC providers' block-range/response-size
 * caps (see either module's DEFAULT_LOG_CHUNK_BLOCKS for the full
 * rationale). Kept pure and RPC-agnostic on purpose, so the boundary math
 * itself is directly, exhaustively unit-testable (backend/test/blockChunks.test.ts)
 * without spinning up a chain, no incidental log distribution to rely on.
 */

export interface BlockChunk {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Splits [fromBlock, toBlock] (both inclusive) into contiguous,
 * non-overlapping, gap-free chunks of at most `chunkBlocks` width each,
 * oldest first. The final chunk is narrower than `chunkBlocks` whenever the
 * range doesn't divide evenly, never dropped, never merged into the
 * previous chunk.
 */
export function computeBlockChunks(fromBlock: bigint, toBlock: bigint, chunkBlocks: bigint): BlockChunk[] {
  if (chunkBlocks <= 0n) {
    throw new Error(`chunkBlocks must be positive, got ${chunkBlocks}`);
  }

  const chunks: BlockChunk[] = [];
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += chunkBlocks) {
    const chunkEndCandidate = chunkStart + chunkBlocks - 1n;
    const chunkEnd = chunkEndCandidate > toBlock ? toBlock : chunkEndCandidate;
    chunks.push({ fromBlock: chunkStart, toBlock: chunkEnd });
  }
  return chunks;
}
