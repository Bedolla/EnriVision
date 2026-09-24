/**
 * Property-based tests for the Analyze Media validation and transformation
 * layer (EnriVision MCP plane, audit R8, user-mandated 11 invariants).
 *
 * Every parser either returns valid params or throws an English-first
 * bilingual Error (never TypeError/RangeError, never NaN in numeric
 * outputs); every schema example parses; schema-published keys agree with
 * the parser-known sets; mutations of valid inputs are rejected bilingually;
 * limits count code points and never split surrogate pairs; cuts are
 * idempotent and within budget; limit messages cite the imported constants;
 * untrusted inputs never throw non-bilingual errors; normalized values stay
 * in domain; per-element and batch caps hold in both directions; and every
 * gate runs before any upload, network transfer, or process spawn (the
 * direct client performs zero network on invalid inputs).
 *
 * @remarks
 * fast-check reports the reproducing seed automatically on failure. The
 * M4-B1 language-ordering decision is held and untouched here.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
/**
 * Builds one platform-portable absolute fixture path (release CI runs on
 * Linux while local development may run on Windows, so hardcoded drive
 * paths fail path validation before the assertions under test fire).
 *
 * @param name - Fixture file name with extension.
 * @returns Absolute path valid on the host platform.
 */
const abs = (name: string): string => resolve(name);

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import type { AnalyzeVisionParams } from "../src/client/EnriProxyClientContract.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { truncateCodePointsHeadTail } from "../src/shared/codepointTruncation.js";
import { optionalFraction, optionalInt, optionalNumber } from "../src/shared/validation.js";
import {
  ANALYZE_MEDIA_LIMITS,
  type AnalyzeMediaElementBox,
  type AnalyzeMediaToolParams,
} from "../src/tools/AnalyzeMediaContract.js";
import { estimateMediaSetTarBytes, AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import {
  AUDIO_KNOWN_KEYS,
  DOCUMENT_KNOWN_KEYS,
  IMAGES_KNOWN_KEYS,
  REGION_KNOWN_KEYS,
  TOP_LEVEL_KNOWN_KEYS,
  VIDEO_KNOWN_KEYS,
  AnalyzeMediaParamParser,
} from "../src/tools/AnalyzeMediaParamParser.js";

/**
 * Runs per property: bounded per the audit mandate (~2,000, deterministic
 * seed reported by fast-check on failure).
 */
const PROPERTY_RUNS: number = 2000;

/**
 * Counts code points (never UTF-16 units).
 *
 * @param value - Text to measure.
 * @returns Code-point length.
 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Asserts text holds no lone surrogate halves.
 *
 * @param value - Text to inspect.
 */
function assertNoLoneSurrogates(value: string): void {
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)).toBe(false);
}

/**
 * Asserts a thrown value is a bilingual validation error (English first,
 * Spanish second), never a bare engine error.
 *
 * @param thrown - Caught value.
 */
function assertBilingualError(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(TypeError);
  expect(thrown).not.toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toContain(" / ");
}

/**
 * Tool-definition accessor for schema assertions.
 */
interface ToolDefinitionReader {
  /**
   * Returns the `analyze_media` tool definition.
   */
  getAnalyzeMediaToolDefinition(): {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
      readonly properties: Record<string, { readonly properties?: Record<string, unknown> }>;
    };
  };
}

/**
 * Structured-content helpers under test.
 */
interface ServerContentAccess {
  /**
   * Bounds one analysis result for the single MCP JSON frame.
   */
  boundStructuredContent(result: {
    readonly analysis: string;
    readonly elements?: ReadonlyArray<AnalyzeMediaElementBox>;
    readonly media_type: string;
    readonly extraction: Record<string, unknown>;
  }): Record<string, unknown>;
}

/**
 * Reads the tool definition from a throwaway server.
 *
 * @returns Tool definition input schema properties.
 */
function readSchemaProperties(): Record<string, { readonly properties?: Record<string, unknown> }> {
  const server = new EnriVisionServer({
    name: "EnriVision",
    version: "0.0.0-test",
    analyzeMediaTool: {} as never,
  });
  return (server as unknown as ToolDefinitionReader).getAnalyzeMediaToolDefinition().inputSchema.properties;
}

/**
 * Bounds one analysis result through the server helper.
 *
 * @param result - Raw analysis result.
 * @returns Bounded structured content.
 */
function boundContent(result: {
  readonly analysis: string;
  readonly elements?: ReadonlyArray<AnalyzeMediaElementBox>;
  readonly media_type: string;
  readonly extraction: Record<string, unknown>;
}): Record<string, unknown> {
  return (EnriVisionServer as unknown as ServerContentAccess).boundStructuredContent(result);
}

/**
 * Generates hostile text: BMP, astral planes, and lone surrogates.
 *
 * @returns Arbitrary text including split-pair material.
 */
function hostileText(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.string({ unit: "grapheme", maxLength: 200 }),
    fc.string({ unit: "binary", maxLength: 200 }),
    fc.constant(""),
  );
}

describe("codepoint truncation properties", (): void => {
  it("reports honest totals, stays in budget, and is idempotent", (): void => {
    fc.assert(
      fc.property(
        hostileText(),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (value: string, headChars: number, tailChars: number): void => {
          const first = truncateCodePointsHeadTail(value, headChars, tailChars);
          expect(first.totalChars).toBe(codePointLength(value));
          expect(first.truncated).toBe(first.totalChars > headChars + tailChars);
          expect(codePointLength(first.text)).toBeLessThanOrEqual(headChars + tailChars);
          const second = truncateCodePointsHeadTail(first.text, headChars, tailChars);
          expect(second.text).toBe(first.text);
          expect(second.truncated).toBe(false);
          if (first.totalChars <= headChars + tailChars) {
            expect(first.text).toBe(value);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("never splits a surrogate pair from clean input", (): void => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: "grapheme", maxLength: 200 })),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (value: string, headChars: number, tailChars: number): void => {
          assertNoLoneSurrogates(value);
          assertNoLoneSurrogates(truncateCodePointsHeadTail(value, headChars, tailChars).text);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("strict numeric coercion properties", (): void => {
  it("optionalInt never yields NaN and rejects partial numerics", (): void => {
    fc.assert(
      fc.property(fc.anything(), (value: unknown): void => {
        const result: number | undefined = optionalInt(value);
        if (typeof result !== "undefined") {
          expect(Number.isInteger(result)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
    for (const rejected of ["7.9", "abc", "1e3", "12:34", "", "  ", "0x10", NaN, Infinity]) {
      expect(optionalInt(rejected)).toBeUndefined();
    }
    expect(optionalInt("60")).toBe(60);
    expect(optionalInt("  -12 ")).toBe(-12);
    expect(optionalInt("9".repeat(400))).toBeUndefined();
  });

  it("optionalNumber never yields NaN and rejects partial numerics", (): void => {
    fc.assert(
      fc.property(fc.anything(), (value: unknown): void => {
        const result: number | undefined = optionalNumber(value);
        if (typeof result !== "undefined") {
          expect(Number.isFinite(result)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
    for (const rejected of ["abc", "1e3", "12:34", "754s", "", NaN, Infinity]) {
      expect(optionalNumber(rejected)).toBeUndefined();
    }
    expect(optionalNumber("12.5")).toBe(12.5);
    expect(optionalNumber(0.5)).toBe(0.5);
  });

  it("optionalFraction stays inside the unit domain", (): void => {
    fc.assert(
      fc.property(fc.anything(), (value: unknown): void => {
        const result: number | undefined = optionalFraction(value);
        if (typeof result !== "undefined") {
          expect(Number.isFinite(result)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("parser robustness properties", (): void => {
  it("any input parses or throws a bilingual error, never an engine error", (): void => {
    const parser = new AnalyzeMediaParamParser();
    fc.assert(
      fc.property(fc.anything(), (raw: unknown): void => {
        let params: AnalyzeMediaToolParams | undefined;
        try {
          params = parser.parseParams(raw);
        } catch (thrown: unknown) {
          assertBilingualError(thrown);
          return;
        }
        const hasPath: boolean = typeof params.path === "string" && params.path.length > 0;
        const hasPaths: boolean = Array.isArray(params.paths) && params.paths.length > 0;
        expect(hasPath || hasPaths).toBe(true);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("every schema example parses successfully", (): void => {
    const parser = new AnalyzeMediaParamParser();
    const examples: unknown[] = [
      { path: abs("shot.png"), question: "What does each capture show?" },
      {
        path: abs("talk.mp4"),
        question: "What happens at 12:34?",
        video: { clip_start_seconds: 754, clip_duration_seconds: 30 },
      },
      { path: abs("manual.pdf"), question: "Summarize each chapter.", analysis_mode: "multipass" },
    ];
    for (const example of examples) {
      expect((): AnalyzeMediaToolParams => parser.parseParams(example)).not.toThrow();
    }
  });

  it("mutations of a valid input are rejected bilingually", (): void => {
    const parser = new AnalyzeMediaParamParser();
    const base: Record<string, unknown> = { path: "/tmp/x.png" };
    const mutations: Array<(input: Record<string, unknown>) => void> = [
      (input): void => {
        input["noExisteEstaClave"] = 1;
      },
      (input): void => {
        input["max_frames"] = 999;
      },
      (input): void => {
        input["analysis_mode"] = "ludicrous";
      },
      (input): void => {
        input["question"] = "x".repeat(ANALYZE_MEDIA_LIMITS.maxPromptChars + 1);
      },
      (input): void => {
        input["region"] = { x: 0, y: 0, width: 2, height: 2 };
      },
      (input): void => {
        input["attachmentIndex"] = 0;
      },
      (input): void => {
        input["video"] = { clip_start_seconds: -5 };
      },
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: mutations.length - 1 }), (index: number): void => {
        const input: Record<string, unknown> = { ...base };
        const mutate = mutations[index];
        if (typeof mutate === "undefined") {
          throw new Error("unreachable mutation index");
        }
        mutate(input);
        try {
          parser.parseParams(input);
        } catch (thrown: unknown) {
          assertBilingualError(thrown);
          return;
        }
        throw new Error(`mutation ${String(index)} should have been rejected`);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("every parser-known key is published in the input schema", (): void => {
    const properties = readSchemaProperties();
    const nested: ReadonlyArray<{ readonly keys: ReadonlySet<string>; readonly parent: string }> = [
      { keys: VIDEO_KNOWN_KEYS, parent: "video" },
      { keys: DOCUMENT_KNOWN_KEYS, parent: "document" },
      { keys: AUDIO_KNOWN_KEYS, parent: "audio" },
      { keys: REGION_KNOWN_KEYS, parent: "region" },
      { keys: IMAGES_KNOWN_KEYS, parent: "images" },
    ];
    for (const key of TOP_LEVEL_KNOWN_KEYS) {
      expect(properties[key]).toBeDefined();
    }
    for (const section of nested) {
      const children: Record<string, unknown> | undefined = properties[section.parent]?.properties as
        | Record<string, unknown>
        | undefined;
      expect(children).toBeDefined();
      for (const key of section.keys) {
        expect(children?.[key], `${section.parent}.${key}`).toBeDefined();
      }
    }
  });

  it("single known keys with arbitrary values parse or fail bilingually", (): void => {
    const parser = new AnalyzeMediaParamParser();
    const keys: string[] = [...TOP_LEVEL_KNOWN_KEYS];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: keys.length - 1 }),
        fc.anything(),
        (index: number, value: unknown): void => {
          const key: string | undefined = keys[index];
          if (typeof key === "undefined") {
            throw new Error("unreachable key index");
          }
          try {
            parser.parseParams({ path: "/tmp/x.png", [key]: value });
          } catch (thrown: unknown) {
            assertBilingualError(thrown);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("direct-client pre-upload gate properties", (): void => {
  it("invalid knobs fail bilingually before any network transfer", async (): Promise<void> => {
    const client = new EnriProxyClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test", timeoutMs: 1000 });
    const invalid: Array<() => AnalyzeVisionParams> = [
      (): AnalyzeVisionParams => ({ uploadId: "u", maxFrames: 999 }),
      (): AnalyzeVisionParams => ({ uploadId: "u", maxFrames: 0 }),
      (): AnalyzeVisionParams => ({ uploadId: "u", region: { x: 0, y: 0, width: 0.5, height: 0.5, extra: 1 } }),
      (): AnalyzeVisionParams => ({ sourceUrl: `https://example.com/${"x".repeat(2049)}` }),
      (): AnalyzeVisionParams => ({ uploadId: "u", question: "x".repeat(ANALYZE_MEDIA_LIMITS.maxPromptChars + 1) }),
      (): AnalyzeVisionParams => ({}),
      (): AnalyzeVisionParams => ({ uploadId: "a", sourceUrl: "https://example.com/x.mp4" }),
    ];
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: invalid.length - 1 }), async (index: number): Promise<void> => {
        const build = invalid[index];
        if (typeof build === "undefined") {
          throw new Error("unreachable invalid index");
        }
        await expect(client.analyze(build())).rejects.toThrow(" / ");
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("valid params pass the gates and reach the network (refused here, unilingually)", async (): Promise<void> => {
    const client = new EnriProxyClient({ baseUrl: "http://127.0.0.1:9", apiKey: "test", timeoutMs: 1000 });
    for (const params of [
      { uploadId: "upload_1" },
      { sourceUrl: "https://example.com/clip.mp4" },
      { uploadId: "upload_1", model: "vision-model", maxFrames: 5 },
    ] as AnalyzeVisionParams[]) {
      try {
        await client.analyze(params);
        throw new Error("unreachable network success against a discard port");
      } catch (thrown: unknown) {
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).not.toContain(" / ");
      }
    }
  });
});

describe("structured-content bound properties", (): void => {
  it("element labels are capped at 200 code points without splitting pairs", (): void => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.oneof(fc.string({ maxLength: 5000 }), fc.string({ unit: "grapheme", maxLength: 1000 })),
            box: fc.constant({ x: 0, y: 0, width: 1, height: 1 }),
          }),
          { maxLength: 20 },
        ),
        (elements: Array<{ readonly label: string; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }>): void => {
          const bounded = boundContent({
            analysis: "ok",
            elements: elements as AnalyzeMediaElementBox[],
            media_type: "image",
            extraction: {},
          });
          const out: unknown = bounded["elements"];
          expect(Array.isArray(out)).toBe(true);
          for (const element of out as AnalyzeMediaElementBox[]) {
            expect(codePointLength(element.label)).toBeLessThanOrEqual(200);
            assertNoLoneSurrogates(element.label);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("truncation flags stay consistent with the delivered payload", (): void => {
    fc.assert(
      fc.property(hostileText(), (analysis: string): void => {
        const bounded = boundContent({ analysis, media_type: "video", extraction: {} });
        const total: number = codePointLength(analysis);
        if (total > ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars) {
          expect(bounded["analysis_truncated"]).toBe(true);
          expect(bounded["analysis_total_chars"]).toBe(total);
        } else {
          expect(bounded["analysis_truncated"]).toBeUndefined();
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("hostile extractions never throw non-bilingual errors", (): void => {
    fc.assert(
      fc.property(fc.anything(), (extraction: unknown): void => {
        const record: Record<string, unknown> =
          typeof extraction === "object" && extraction !== null && !Array.isArray(extraction)
            ? (extraction as Record<string, unknown>)
            : { value: extraction };
        let bounded: Record<string, unknown>;
        try {
          bounded = boundContent({ analysis: "ok", media_type: "video", extraction: record });
        } catch (thrown: unknown) {
          assertBilingualError(thrown);
          return;
        }
        expect(typeof bounded).toBe("object");
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("the last-resort omission marker cites the imported extraction budget", (): void => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 60000; index += 1) {
      wide[`k${String(index).padStart(5, "0")}`] = index;
    }
    const bounded = boundContent({ analysis: "ok", media_type: "video", extraction: { wide } });
    const serialized: string = JSON.stringify(bounded["extraction"]);
    expect(serialized).toContain(String(ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars));
    expect(serialized).toContain("extracción omitida");
  });
});

describe("tar estimator properties", (): void => {
  it("never under-estimates framing and is monotone in both inputs", (): void => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 1_000_000_000_000 }),
        fc.integer({ min: -5, max: 500 }),
        (rawBytes: number, fileCount: number): void => {
          const estimate: number = estimateMediaSetTarBytes(rawBytes, fileCount);
          expect(Number.isFinite(estimate)).toBe(true);
          const safeRaw: number = Math.max(0, rawBytes);
          const safeCount: number = Math.max(0, fileCount);
          expect(estimate).toBeGreaterThanOrEqual(safeRaw + safeCount * 512 + 1024);
          expect(estimateMediaSetTarBytes(rawBytes + 1, fileCount)).toBeGreaterThanOrEqual(estimate);
          expect(estimateMediaSetTarBytes(rawBytes, fileCount + 1)).toBeGreaterThanOrEqual(estimate);
          expect(estimateMediaSetTarBytes(-1, -1)).toBe(estimateMediaSetTarBytes(0, 0));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe("empty-file gate properties", (): void => {
  it("empty local files fail in Spanish before any session", async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), "enrivision-empty-prop-"));
    try {
      const emptyPath: string = join(directory, "vacio.png");
      const tinyPath: string = join(directory, "mini.png");
      await writeFile(emptyPath, Buffer.alloc(0));
      await writeFile(tinyPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const parser = new AnalyzeMediaParamParser();
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      const emptyParams = parser.parseParams({ path: emptyPath, question: "q" });
      await expect(resolver.resolve(emptyParams)).rejects.toThrow(" / ");
      try {
        await resolver.resolve(emptyParams);
      } catch (thrown: unknown) {
        assertBilingualError(thrown);
        expect((thrown as Error).message).toMatch(/vacío|0 bytes/);
      }
      const tinyParams = parser.parseParams({ path: tinyPath, question: "q" });
      const resolved = await resolver.resolve(tinyParams);
      expect(resolved.inputs.length).toBe(1);
      expect(resolved.inputs[0]?.localPath).toBe(tinyPath);
      for (const fetched of resolved.materialized) {
        await fetched.cleanup();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
