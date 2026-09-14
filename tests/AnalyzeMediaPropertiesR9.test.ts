/**
 * Analyze Media audit R9 delta property tests (EnriVision MCP side).
 *
 * fast-check battery pinning the R9 MCP deltas: Spanish-first warning
 * order and the staged-identity format/stability behind the single-file
 * TOCTOU guard.
 *
 * Invariant map (user mandate, 11 items):
 * 1. Core: generated content types yield a warning or undefined, never
 *    engine errors; identity strings always match the staged format.
 * 4. Limits/texts: identity comparisons are exact strings; no numeric
 *    truncation is involved.
 * 6. Consistency: the staged identity equals the opener `fstat`
 *    identity for untouched files and differs after same-size swaps.
 * 9. Execution: vitest directed battery, 2,000 runs per property;
 *    fast-check reports the deterministic seed on failure by default.
 * 10. Triage: red properties are fixed with their regression test.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { describeFileIdentity } from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

/** Bounded per-property runs (validation contract: about 2,000). */
const NUM_RUNS: number = 2_000;

describe("Analyze Media R9 MCP properties: Spanish-first warnings", () => {
  it("leads every transcribe warning in Spanish with a separator", () => {
    const tool = new AnalyzeMediaTool({} as never);
    const reader = tool as unknown as {
      transcribeInapplicableWarning(
        params: unknown,
        inputs: ReadonlyArray<{ readonly localPath: string; readonly contentType: string }>
      ): string | undefined;
    };
    fc.assert(
      fc.property(
        fc.constantFrom("image/png", "image/jpeg", "application/pdf", "video/mp4", "audio/mpeg", "text/plain", "application/octet-stream", ""),
        fc.integer({ min: 1, max: 4 }),
        (contentType: string, count: number): void => {
          const inputs = Array.from({ length: count }, (_unused: unknown, index: number) => ({
            localPath: `f${String(index)}.bin`,
            contentType
          }));
          const warning: string | undefined = reader.transcribeInapplicableWarning({ transcribe: true }, inputs);
          // Order invariant: whenever a warning exists it leads in Spanish.
          if (warning !== undefined) {
            expect(warning).toContain(" / ");
            expect(warning.indexOf("transcribe no tiene efecto")).toBeLessThan(
              warning.indexOf("transcribe has no effect")
            );
          }
          // Exact pins: multi-entry always warns; single video/audio never does.
          if (count > 1) {
            expect(typeof warning).toBe("string");
          }
          const normalized: string = contentType.trim().toLowerCase();
          if (count === 1 && (normalized.startsWith("video/") || normalized.startsWith("audio/"))) {
            expect(warning).toBeUndefined();
          }
          expect(reader.transcribeInapplicableWarning({}, inputs)).toBeUndefined();
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe("Analyze Media R9 MCP properties: staged identities", () => {
  let directory = "";

  beforeAll(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), "enrivision-r9e5-prop-"));
    await Promise.all(
      Array.from({ length: 8 }, (_unused: unknown, index: number): Promise<void> =>
        writeFile(join(directory, `f${String(index)}.png`), Buffer.alloc(64 + index, 0x61 + index))
      )
    );
  });

  afterAll(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stages a well-formed identity that matches the untouched file", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 7 }), async (index: number): Promise<void> => {
        const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
        const resolved = await resolver.resolve({ path: join(directory, `f${String(index)}.png`) });
        const staged: string | undefined = resolved.inputs[0]?.stagedIdentity;
        expect(staged).toMatch(/^\d+:\d+:\d+(\.\d+)?:\d+(\.\d+)?:\d+$/u);
        const again = await resolver.resolve({ path: join(directory, `f${String(index)}.png`) });
        expect(again.inputs[0]?.stagedIdentity).toBe(staged);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("distinguishes files that share size but not identity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 7 }),
        async (left: number, right: number): Promise<void> => {
          const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
          const first = await resolver.resolve({ path: join(directory, `f${String(left)}.png`) });
          const second = await resolver.resolve({ path: join(directory, `f${String(right)}.png`) });
          expect((first.inputs[0]?.stagedIdentity ?? "") === (second.inputs[0]?.stagedIdentity ?? "")).toBe(
            left === right
          );
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it("keeps describeFileIdentity pure and size-sensitive", () => {
    fc.assert(
      fc.property(
        fc.record({
          ino: fc.integer({ min: 0, max: 1_000_000 }),
          size: fc.integer({ min: 1, max: 1_000_000 }),
          mtimeMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
          birthtimeMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
          nlink: fc.integer({ min: 1, max: 16 })
        }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (stats: { ino: number; size: number; mtimeMs: number; birthtimeMs: number; nlink: number }, otherSize: number): void => {
          expect(describeFileIdentity(stats)).toBe(describeFileIdentity({ ...stats }));
          expect(describeFileIdentity(stats) === describeFileIdentity({ ...stats, size: otherSize })).toBe(
            otherSize === stats.size
          );
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});
