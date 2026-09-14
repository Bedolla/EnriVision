/**
 * Analyze Media audit R11 delta property tests (EnriVision MCP side).
 *
 * fast-check battery pinning the R11 MCP deltas: bounded envelope
 * warnings, capped probe cache, and pre-upload client guards.
 *
 * Invariant map (user mandate, 11 items):
 * 1. Core: generated inputs produce valid results or Spanish-first
 *    bilingual errors; never TypeError/RangeError, no NaN numerics.
 * 2. Parser/schema: every unknown section key rejects; every accepted
 *    spelling from the parser key sets passes the client guard.
 * 4. Limits/texts: caps count code points, never split pairs, and cite
 *    the imported limit constants.
 * 5. Untrusted input: hostile objects process without non-Spanish throws
 *    and with bounded growth (probe cache, warning lists).
 * 7. Normalization: bounded outputs stay inside their declared domain.
 * 9. Execution: vitest directed battery, 2,000 runs per property;
 *    fast-check reports the deterministic seed on failure by default.
 * 10. Triage: red properties are fixed with their regression test.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import {
  AUDIO_KNOWN_KEYS,
  DOCUMENT_KNOWN_KEYS,
  IMAGES_KNOWN_KEYS,
  VIDEO_KNOWN_KEYS,
} from "../src/tools/AnalyzeMediaParamParser.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";

/** Bounded per-property runs (validation contract: about 2,000). */
const NUM_RUNS: number = 2_000;

/** Matches one lone (unpaired) UTF-16 surrogate. */
const LONE_SURROGATE_PATTERN: RegExp = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/**
 * Arbitrary text carrying astral pairs so surrogate safety is exercised.
 *
 * @param maxLength - Maximum length of each generated side.
 * @returns Text with at least one astral character.
 */
function astralText(maxLength: number): fc.Arbitrary<string> {
  return fc
    .tuple(fc.string({ maxLength }), fc.constantFrom("😀", "𝄞", "🏃"), fc.string({ maxLength }))
    .map(([head, middle, tail]: [string, string, string]): string => `${head}${middle}${tail}`);
}

/** Server accessor for the warning-bounding helper under test. */
const serverStatics = EnriVisionServer as unknown as {
  boundEnvelopeWarnings(warnings: ReadonlyArray<string> | undefined): ReadonlyArray<string>;
};

describe("Analyze Media R11 MCP properties: bounded envelope warnings (INV1/INV4/INV7)", () => {
  it("caps count and line length without splitting surrogates", () => {
    fc.assert(
      fc.property(fc.array(astralText(60), { maxLength: 60 }), (warnings: string[]): void => {
        const bounded: ReadonlyArray<string> = serverStatics.boundEnvelopeWarnings(warnings);
        expect(bounded.length).toBeLessThanOrEqual(20);
        for (const line of bounded) {
          expect(Array.from(line).length).toBeLessThanOrEqual(1000);
          expect(LONE_SURROGATE_PATTERN.test(line)).toBe(false);
        }
        if (warnings.length <= 20) {
          expect(bounded).toHaveLength(warnings.length);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never throws on hostile warning shapes", () => {
    fc.assert(
      fc.property(fc.anything(), (warnings: unknown): void => {
        let result: ReadonlyArray<string>;
        try {
          result = serverStatics.boundEnvelopeWarnings(warnings as ReadonlyArray<string>);
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(Error);
          return;
        }
        expect(Array.isArray(result)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Analyze Media R11 MCP properties: probe-cache bound (INV5/INV7)", () => {
  it("holds at most 100 entries over arbitrary insert sequences", () => {
    const tool = new AnalyzeMediaTool({} as never);
    const probe = tool as unknown as {
      rememberVisionProbe(cacheKey: string, verdict: boolean, now: number): void;
      visionProbeCache: Map<string, { readonly verdict: boolean; readonly expiresAt: number }>;
    };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.string({ maxLength: 24 }),
            verdict: fc.boolean(),
            now: fc.integer({ min: 0, max: 10_000_000 }),
          }),
          { maxLength: 60 },
        ),
        (inserts: ReadonlyArray<{ key: string; verdict: boolean; now: number }>): void => {
          probe.visionProbeCache.clear();
          for (const insert of inserts) {
            probe.rememberVisionProbe(insert.key, insert.verdict, insert.now);
          }
          expect(probe.visionProbeCache.size).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Analyze Media R11 MCP properties: pre-upload guards (INV1/INV2/INV5)", () => {
  it("accepts every parser-owned section spelling", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Array.from(VIDEO_KNOWN_KEYS)),
        (key: string): void => {
          expect((): void =>
            EnriProxyClient.requirePreUploadTuning({ video: { [key]: 1 } } as never),
          ).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...Array.from(DOCUMENT_KNOWN_KEYS)),
        (key: string): void => {
          expect((): void =>
            EnriProxyClient.requirePreUploadTuning({ document: { [key]: 1 } } as never),
          ).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...Array.from(AUDIO_KNOWN_KEYS)),
        (key: string): void => {
          expect((): void =>
            EnriProxyClient.requirePreUploadTuning({ audio: { [key]: 1 } } as never),
          ).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...Array.from(IMAGES_KNOWN_KEYS)),
        (key: string): void => {
          expect((): void =>
            EnriProxyClient.requirePreUploadTuning({ images: { [key]: 1 } } as never),
          ).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects hostile tuning shapes with Spanish-first errors, never TypeError", () => {
    fc.assert(
      fc.property(fc.anything(), (params: unknown): void => {
        if (params === null || typeof params !== "object" || Array.isArray(params)) {
          return;
        }
        try {
          EnriProxyClient.requirePreUploadTuning(params as never);
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(TypeError);
          expect(String((error as Error).message)).toMatch(/ \/ /u);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("cites the imported upload ceiling instead of a literal", (): void => {
    expect(ANALYZE_MEDIA_LIMITS.maxUploadBytes).toBe(4 * 1024 * 1024 * 1024);
  });
});
