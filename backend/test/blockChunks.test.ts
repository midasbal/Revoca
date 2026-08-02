/**
 * Deterministic, RPC-free proof that computeBlockChunks (backend/src/shared/blockChunks.ts)
 * never drops the final partial chunk and never double-counts a boundary
 * block, the two failure modes that would corrupt the audit report's
 * completeness guarantee (see docs/AUDIT_REPORT.md and
 * backend/src/audit/reconstruct.ts's DEFAULT_LOG_CHUNK_BLOCKS). This is
 * intentionally independent of any real chain/log distribution, unlike
 * backend/test/audit-report.test.ts's end-to-end chunking test, whether a
 * given rehearsal run happens to place an event in the final chunk or on a
 * boundary block is incidental; these invariants must hold for every
 * (fromBlock, toBlock, chunkBlocks) combination, not just the ones the
 * rehearsal happens to exercise.
 */
import { describe, expect, it } from "vitest";
import { computeBlockChunks } from "../src/shared/blockChunks.js";

/** Every chunk covers exactly its own [fromBlock, toBlock], no gaps, no overlaps, first chunk starts at fromBlock, last chunk ends at toBlock. Equivalent to "the union of all chunks is exactly [fromBlock, toBlock] with each block counted exactly once." */
function assertGapFreeNonOverlappingFullCoverage(chunks: { fromBlock: bigint; toBlock: bigint }[], fromBlock: bigint, toBlock: bigint) {
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.fromBlock).toBe(fromBlock);
  expect(chunks[chunks.length - 1]!.toBlock).toBe(toBlock);

  let totalBlocksCovered = 0n;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    expect(chunk.toBlock).toBeGreaterThanOrEqual(chunk.fromBlock); // every chunk is non-empty and correctly ordered
    totalBlocksCovered += chunk.toBlock - chunk.fromBlock + 1n;

    if (i > 0) {
      const prev = chunks[i - 1]!;
      // No gap: this chunk starts exactly one block after the previous one ended.
      // No overlap/double-count: same check, a boundary block belongs to exactly one chunk.
      expect(chunk.fromBlock).toBe(prev.toBlock + 1n);
    }
  }

  // The sum of every chunk's width equals the total range width exactly,
  // this is only possible with neither a gap (missing blocks) nor an
  // overlap (a block counted in two chunks).
  expect(totalBlocksCovered).toBe(toBlock - fromBlock + 1n);
}

describe("computeBlockChunks", () => {
  it("a range that fits in one chunk returns a single, narrower-than-chunkBlocks chunk", () => {
    const chunks = computeBlockChunks(0n, 3n, 10n);
    expect(chunks).toEqual([{ fromBlock: 0n, toBlock: 3n }]);
  });

  it("a range exactly one chunkBlocks wide returns exactly one full chunk", () => {
    const chunks = computeBlockChunks(0n, 4n, 5n); // 5 blocks: 0,1,2,3,4
    expect(chunks).toEqual([{ fromBlock: 0n, toBlock: 4n }]);
  });

  it("a range that divides evenly into chunkBlocks returns only full chunks, no trailing empty chunk", () => {
    const chunks = computeBlockChunks(0n, 14n, 5n); // exactly 3 * 5 = 15 blocks
    expect(chunks).toEqual([
      { fromBlock: 0n, toBlock: 4n },
      { fromBlock: 5n, toBlock: 9n },
      { fromBlock: 10n, toBlock: 14n },
    ]);
    assertGapFreeNonOverlappingFullCoverage(chunks, 0n, 14n);
  });

  it("a range with a genuinely partial final chunk keeps it, does not drop or pad it", () => {
    const chunks = computeBlockChunks(0n, 12n, 5n); // 13 blocks: two full chunks + a 3-wide final one
    expect(chunks).toEqual([
      { fromBlock: 0n, toBlock: 4n },
      { fromBlock: 5n, toBlock: 9n },
      { fromBlock: 10n, toBlock: 12n },
    ]);
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.toBlock - lastChunk.fromBlock + 1n).toBeLessThan(5n); // confirms it's genuinely partial, not coincidentally full
    assertGapFreeNonOverlappingFullCoverage(chunks, 0n, 12n);
  });

  it("a single-block range returns exactly one single-block chunk", () => {
    const chunks = computeBlockChunks(7n, 7n, 5n);
    expect(chunks).toEqual([{ fromBlock: 7n, toBlock: 7n }]);
  });

  it("a non-zero fromBlock is preserved exactly as the first chunk's start", () => {
    const chunks = computeBlockChunks(100n, 111n, 5n);
    expect(chunks[0]!.fromBlock).toBe(100n);
    assertGapFreeNonOverlappingFullCoverage(chunks, 100n, 111n);
  });

  it("chunkBlocks of 1 returns one chunk per block, still gap-free and non-overlapping", () => {
    const chunks = computeBlockChunks(0n, 6n, 1n);
    expect(chunks).toHaveLength(7);
    assertGapFreeNonOverlappingFullCoverage(chunks, 0n, 6n);
  });

  it("rejects a non-positive chunkBlocks rather than looping forever", () => {
    expect(() => computeBlockChunks(0n, 10n, 0n)).toThrow();
    expect(() => computeBlockChunks(0n, 10n, -1n)).toThrow();
  });

  it("holds the gap-free/non-overlapping/full-coverage invariant across many (fromBlock, toBlock, chunkBlocks) combinations, proving the boundary math can neither drop a final partial chunk nor double-count a boundary block for any range shape", () => {
    const fromBlocks = [0n, 1n, 7n, 45n];
    const rangeWidths = [1n, 4n, 5n, 6n, 9n, 10n, 11n, 24n, 25n, 26n, 99n]; // spans narrower than, exactly, and wider than chunkBlocks, and both evenly-divisible and remainder cases
    const chunkSizes = [1n, 3n, 5n, 10n];

    for (const fromBlock of fromBlocks) {
      for (const width of rangeWidths) {
        const toBlock = fromBlock + width - 1n;
        for (const chunkBlocks of chunkSizes) {
          const chunks = computeBlockChunks(fromBlock, toBlock, chunkBlocks);
          assertGapFreeNonOverlappingFullCoverage(chunks, fromBlock, toBlock);
          // No chunk ever exceeds the requested width, the whole point of chunking.
          for (const chunk of chunks) {
            expect(chunk.toBlock - chunk.fromBlock + 1n).toBeLessThanOrEqual(chunkBlocks);
          }
        }
      }
    }
  });
});
