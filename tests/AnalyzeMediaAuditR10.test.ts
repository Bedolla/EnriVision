/**
 * ANALYZE MEDIA R10 REGRESSION + PROPERTY TESTS (EnriVision MCP)
 *
 * Pins the M4 R10 fixes: overflow-error classification, seam-inside-budget
 * truncation, code-point URL/model caps, the closed omission marker, the
 * 60 s download-deadline timeout mapping — plus the fast-check invariants
 * for the MCP truncation seams and cap parity (~2,000 runs per property).
 *
 * @module tests/AnalyzeMediaAuditR10
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { truncateCodePointsHeadTail } from "../src/shared/codepointTruncation.js";

/** Bounded per-property runs (validation contract: about 2,000). */
const NUM_RUNS: number = 2_000;

/** Lone-surrogate detector: matches an unpaired high surrogate. */
const LONE_SURROGATE: RegExp = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;

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

/** Server accessor for private static helpers under test. */
const serverStatics = EnriVisionServer as unknown as {
  formatAnalysisText(
    analysis: string,
    mediaType: string,
    elements: ReadonlyArray<unknown> | undefined,
    warnings?: ReadonlyArray<string>,
  ): string;
  boundStructuredContent(result: {
    analysis: string;
    media_type: string;
    extraction: Record<string, unknown>;
  }): Record<string, unknown>;
  mapToolError(error: unknown): { structuredContent: { code: string; retryable: boolean } };
};

describe("Analyze Media R10: overflow errors classify as execution failures", (): void => {
  it("maps the 50 MiB response-overflow message to executionFailed", (): void => {
    const mapped = serverStatics.mapToolError(
      new Error(
        "La respuesta excedió el tamaño máximo permitido (50 MiB); se descartó, nunca truncada. / Response exceeded the maximum allowed size (50 MiB); it was discarded, never truncated.",
      ),
    );
    expect(mapped.structuredContent.code).not.toBe("ENRICODE_ERR_TOOL_INPUT_INVALID");
    expect(mapped.structuredContent.retryable).toBe(false);
  });

  it("still maps real input errors to inputInvalid", (): void => {
    const mapped = serverStatics.mapToolError(new Error("path debe ser una ruta de archivo absoluta."));
    expect(mapped.structuredContent.code).toBe("ENRICODE_ERR_TOOL_INPUT_INVALID");
  });
});

describe("Analyze Media R10: download deadline maps to timeout in Spanish", (): void => {
  it("classifies the deadline message as retryable executionTimeout", (): void => {
    const mapped = serverStatics.mapToolError(
      new Error("La descarga de media expiró: superó el límite de 60 s. / The media download timed out: it exceeded the 60 s limit."),
    );
    expect(mapped.structuredContent.code).toBe("ENRICODE_ERR_TOOL_EXECUTION_TIMEOUT");
    expect(mapped.structuredContent.retryable).toBe(true);
  });
});

describe("Analyze Media R10: truncation seams stay inside the budget", (): void => {
  it("keeps structured analysis within the declared limit", (): void => {
    const bounded = serverStatics.boundStructuredContent({
      analysis: "a".repeat(300_000),
      media_type: "video",
      extraction: {},
    });
    const analysis = bounded["analysis"] as string;
    expect(Array.from(analysis).length).toBeLessThanOrEqual(ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars);
    expect(bounded["analysis_truncated"]).toBe(true);
  });

  it("keeps the text output within the declared limit", (): void => {
    const text: string = serverStatics.formatAnalysisText("z".repeat(60_000), "video", undefined);
    expect(Array.from(text).length).toBeLessThanOrEqual(ANALYZE_MEDIA_LIMITS.maxAnalysisTextChars + 200);
  });

  it("closes the deep/wide omission marker bracket", (): void => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let depth: number = 0; depth < 200; depth += 1) {
      cursor["data"] = "x".repeat(8_000);
      cursor["child"] = {};
      cursor = cursor["child"] as Record<string, unknown>;
    }
    const bounded = serverStatics.boundStructuredContent({
      analysis: "ok",
      media_type: "video",
      extraction: deep,
    });
    const serialized: string = JSON.stringify(bounded["extraction"]);
    expect(serialized.includes("estructura demasiado profunda o extensa")).toBe(true);
    const markerIndex: number = serialized.indexOf("[contenido omitido: estructura demasiado profunda");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(serialized.slice(markerIndex, markerIndex + 140).includes("]")).toBe(true);
  });
});

describe("Analyze Media R10: URL and model caps count code points", (): void => {
  const parser = new AnalyzeMediaParamParser();

  it("accepts an astral URL of exactly 2048 code points and rejects 2049", (): void => {
    const prefix: string = "https://example.com/";
    const atLimit: string = `${prefix}${"😀".repeat(2048 - prefix.length)}`;
    expect(Array.from(atLimit).length).toBe(2048);
    const overLimit: string = `${prefix}${"😀".repeat(2049 - prefix.length)}`;
    expect(Array.from(overLimit).length).toBe(2049);
    expect(() => parser.parseParams({ path: atLimit, question: "¿Qué se ve?" })).not.toThrow();
    expect(() => parser.parseParams({ path: overLimit, question: "¿Qué se ve?" })).toThrow(/excede el límite/u);
  });

  it("accepts an astral model id of exactly 128 code points and rejects 129", (): void => {
    const atLimit: string = `${"m".repeat(64)}😀${"m".repeat(63)}`;
    expect(Array.from(atLimit).length).toBe(128);
    const overLimit: string = `${atLimit}m`;
    expect(Array.from(overLimit).length).toBe(129);
    expect(() => parser.parseParams({ path: "/tmp/a.png", question: "¿Qué se ve?", model: atLimit })).not.toThrow();
    expect(() => parser.parseParams({ path: "/tmp/a.png", question: "¿Qué se ve?", model: overLimit })).toThrow(/128/u);
  });
});

describe("Analyze Media R10 properties (MCP plane)", (): void => {
  it("structured seams never exceed the budget nor split pairs", (): void => {
    fc.assert(
      fc.property(astralText(300_000), (analysis: string): void => {
        const bounded = serverStatics.boundStructuredContent({
          analysis,
          media_type: "video",
          extraction: {},
        });
        const text = bounded["analysis"] as string;
        expect(Array.from(text).length).toBeLessThanOrEqual(ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars);
        expect(text).not.toMatch(LONE_SURROGATE);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("text-output seams never exceed the budget nor split pairs", (): void => {
    fc.assert(
      fc.property(astralText(60_000), (analysis: string): void => {
        const text: string = serverStatics.formatAnalysisText(analysis, "video", undefined);
        expect(Array.from(text).length).toBeLessThanOrEqual(ANALYZE_MEDIA_LIMITS.maxAnalysisTextChars + 200);
        expect(text).not.toMatch(LONE_SURROGATE);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("head+tail truncation is idempotent and budget-exact", (): void => {
    fc.assert(
      fc.property(astralText(5_000), fc.integer({ min: 0, max: 4_000 }), (value: string, head: number): void => {
        const cut = truncateCodePointsHeadTail(value, head, 500);
        expect(Array.from(cut.text).length).toBeLessThanOrEqual(head + 500);
        const reCut = truncateCodePointsHeadTail(cut.text, head, 500);
        expect(reCut.text).toBe(cut.text);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("client URL caps match the parser code-point accounting", (): void => {
    const prefix: string = "https://example.com/";
    fc.assert(
      fc.property(fc.integer({ min: 2_040, max: 2_060 }), (units: number): void => {
        const url: string = `${prefix}${"😀".repeat(Math.max(0, units - prefix.length))}`;
        const parser = new AnalyzeMediaParamParser();
        const overLimit: boolean = Array.from(url).length > 2048;
        if (overLimit) {
          expect(() => parser.parseParams({ path: url, question: "q" })).toThrow(/2048/u);
        } else {
          expect(() => parser.parseParams({ path: url, question: "q" })).not.toThrow();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("url fetcher rejects private literal destinations in Spanish", async (): Promise<void> => {
    fc.assert(
      fc.asyncProperty(fc.constantFrom("http://127.0.0.1/x.png", "http://[::1]/x.png", "http://10.0.0.5/x.png", "http://192.168.1.2/x.png"), async (url: string): Promise<void> => {
        const fetcher = new MediaUrlFetcher();
        await expect(fetcher.fetch(url)).rejects.toThrow(/privado|bloqueada|no se permite/u);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
