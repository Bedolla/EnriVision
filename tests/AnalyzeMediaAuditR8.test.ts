/**
 * Tests for the Analyze Media R8 audit round (EnriVision lane V1, 12 fixes).
 *
 * Covers: protocol-error classification exemptions (B2), published schema
 * aliases plus schema-parser agreement (B3), direct-client range gates plus
 * region unknown-key rejection (B4), codepoint-safe server detail (C1),
 * documented prompt caps (C2), source_url length gates (C3), remote region
 * and transcribe advisories (C4), bounded structured labels (C5), empty-file
 * rejection (C6), interpolated omission budget (C7), worst-case tar estimate
 * (C8), and lone-start-at-cap forwarding (C9). M4-B1 (language policy) is
 * held for a product decision and untouched here.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
/**
 * Builds one platform-portable absolute fixture path (release CI runs on
 * Linux while local development may run on Windows, so hardcoded drive
 * paths fail path validation before the assertions under test fire).
 *
 * @param name - Fixture file name with extension.
 * @returns Absolute path valid on the host platform.
 */
const abs = (name: string): string => resolve(name);

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { extractServerErrorDetail } from "../src/client/EnriProxyClientContract.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import type { MediaUrlFetcher as MediaUrlFetcherType } from "../src/shared/mediaUrlFetcher.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { estimateMediaSetTarBytes } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
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
 * Reads the tool definition from a throwaway server.
 *
 * @returns Tool definition.
 */
function readDefinition(): {
  readonly inputSchema: {
    readonly properties: Record<string, { readonly properties?: Record<string, unknown> }>;
  };
} {
  const server = new EnriVisionServer({
    name: "EnriVision",
    version: "0.0.0-test",
    analyzeMediaTool: {} as never,
  });
  return (server as unknown as ToolDefinitionReader).getAnalyzeMediaToolDefinition();
}

/**
 * Builds a stub tool whose remote branch escalates to `source_url`.
 *
 * @returns Stub tool plus recorded analyze calls.
 */
function createRemoteStubTool(): {
  readonly tool: AnalyzeMediaTool;
  readonly analyzeCalls: Array<Record<string, unknown>>;
} {
  const analyzeCalls: Array<Record<string, unknown>> = [];
  const sizeCapFetcher = {
    fetch: async (): Promise<never> => {
      throw new Error(
        `${MediaUrlFetcher.URL_SIZE_CAP_MARKER} Remote file exceeds the 64 MiB limit. / El archivo remoto excede el límite de 64 MiB.`,
      );
    },
  } as unknown as MediaUrlFetcherType;
  const tool = new AnalyzeMediaTool(
    {
      createClient: () =>
        ({
          createUploadSession: async () => ({
            upload_id: "upload_1",
            chunk_size_bytes: 1024,
            expires_at: Date.now() + 60_000,
          }),
          getUploadOffset: async () => 0,
          appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
            request.offset + request.chunk.length,
          deleteUploadSession: async () => undefined,
          analyze: async (request: Record<string, unknown>) => {
            analyzeCalls.push(request);
            return { analysis: "ok", media_type: "video", extraction: {} };
          },
        }) as never,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 30 * 60 * 1000,
    },
    sizeCapFetcher,
  );
  return { tool, analyzeCalls };
}

/**
 * Reports whether a string holds no lone surrogates (every code point is a
 * valid scalar value).
 *
 * @param value - String to inspect.
 * @returns True when no UTF-16 unit is an unpaired surrogate.
 */
function hasNoLoneSurrogates(value: string): boolean {
  for (const char of value) {
    const codePoint: number = char.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Builds a direct client that never touches the network in these tests
 * (every assertion rejects before the first request).
 *
 * @returns Test client.
 */
function createDirectClient(): EnriProxyClient {
  return new EnriProxyClient({
    baseUrl: "http://127.0.0.1:8787",
    apiKey: "test-key",
    timeoutMs: 1000,
  });
}

describe("R8-B2 protocol faults never classify as input errors", () => {
  it("maps Upload-Offset and invalid-response faults to EXECUTION_FAILED", () => {
    for (const message of [
      "Missing Upload-Offset header in response. / Falta el encabezado Upload-Offset en la respuesta.",
      "Invalid Upload-Offset header 'abc'. / Upload-Offset inválido 'abc'.",
      "Invalid server offset for the upload. / Offset inválido del servidor para la subida.",
      "Server response is invalid: analysis must be a string. / La respuesta del servidor es inválida: analysis debe ser string.",
    ]) {
      const mapped = EnriVisionServer.mapToolError(new Error(message));
      expect(mapped.structuredContent.code).toBe("ENRICODE_ERR_TOOL_EXECUTION_FAILED");
      expect(mapped.structuredContent.retryable).toBe(false);
    }
  });

  it("keeps genuine caller errors as inputInvalid", () => {
    const mapped = EnriVisionServer.mapToolError(
      new Error("max_frames must be an integer between 1 and 20. / max_frames debe ser un entero entre 1 y 20."),
    );
    expect(mapped.structuredContent.code).toBe("ENRICODE_ERR_TOOL_INPUT_INVALID");
  });
});

describe("R8-B3 schema publishes every accepted alias", () => {
  it("declares all top-level and nested known keys as properties", () => {
    const properties = readDefinition().inputSchema.properties;
    for (const key of TOP_LEVEL_KNOWN_KEYS) {
      expect(properties[key], `top-level key ${key}`).toBeDefined();
    }
    const sections: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
      ["video", VIDEO_KNOWN_KEYS],
      ["document", DOCUMENT_KNOWN_KEYS],
      ["audio", AUDIO_KNOWN_KEYS],
      ["images", IMAGES_KNOWN_KEYS],
      ["region", REGION_KNOWN_KEYS],
    ];
    for (const [section, keys] of sections) {
      const nested = properties[section]?.properties ?? {};
      for (const key of keys) {
        expect(nested[key], `${section}.${key}`).toBeDefined();
      }
    }
  });

  it("parses representative alias spellings", () => {
    const parsed = new AnalyzeMediaParamParser().parseParams({
      path: abs("a.mp4"),
      maxFrames: 6,
      transcriptionLanguage: "es",
      analysisMode: "single",
      video: { clipStartSeconds: 10, segmentSeconds: 60 },
      document: { maxPages: 5 },
      audio: { audioTimestamps: true },
    });
    expect(parsed.maxFrames).toBe(6);
    expect(parsed.video?.segmentSeconds).toBe(60);
    expect(parsed.document?.maxPagesTotal).toBe(5);
    expect(parsed.audio?.timestamps).toBe(true);
  });
});

describe("R8-B4 direct client enforces parser ranges pre-upload", () => {
  it("rejects out-of-range knobs in Spanish before any request", async () => {
    const client = createDirectClient();
    await expect(
      client.analyze({ uploadId: "u", video: { segmentSeconds: 601 } } as never),
    ).rejects.toThrow(/entre 5 y 600/u);
    await expect(
      client.analyze({ uploadId: "u", maxFrames: 21 } as never),
    ).rejects.toThrow(/entre 1 y 20/u);
    await expect(
      client.analyze({ uploadId: "u", images: { maxDimension: 100 } } as never),
    ).rejects.toThrow(/entre 256 y 4096/u);
    await expect(
      client.analyze({ uploadId: "u", document: { maxImagesPerBatch: 21 } } as never),
    ).rejects.toThrow(/entre 0 y 20/u);
  });

  it("rejects unknown region keys", async () => {
    const client = createDirectClient();
    await expect(
      client.analyze({
        uploadId: "u",
        region: { x: 0, y: 0, width: 0.5, height: 0.5, widh: 0.5 },
      } as never),
    ).rejects.toThrow(/claves desconocidas.*widh/u);
  });
});

describe("R8-C1 server detail never splits surrogate pairs", () => {
  it("cuts astral text straddling the 300-char budget codepoint-wise", () => {
    const astral = `detail ${"😀".repeat(400)} end`;
    const detail = extractServerErrorDetail(JSON.stringify({ error: astral }));
    expect(detail).not.toBeNull();
    expect(Array.from(detail as string).length).toBeLessThanOrEqual(300);
    expect(hasNoLoneSurrogates(detail as string)).toBe(true);
  });
});

describe("R8-C2 prompt caps documented in the schema", () => {
  it("names the 2000-char cap on question and context", () => {
    const properties = readDefinition().inputSchema.properties;
    const question = properties["question"] as { readonly description?: string };
    const context = properties["context"] as { readonly description?: string };
    expect(question.description).toMatch(/2000/u);
    expect(context.description).toMatch(/2000/u);
  });
});

describe("R8-C3 source_url length gates fail before any byte", () => {
  it("rejects oversized URLs in the parser and the direct client", async () => {
    const longUrl = `https://example.test/${"a".repeat(2048)}.mp4`;
    expect(() =>
      new AnalyzeMediaParamParser().parseParams({ path: longUrl }),
    ).toThrow(/2048/u);
    expect(() =>
      new AnalyzeMediaParamParser().parseParams({ paths: [longUrl] }),
    ).toThrow(/2048/u);
    const client = createDirectClient();
    await expect(client.analyze({ sourceUrl: longUrl })).rejects.toThrow(/2048/u);
  });
});

describe("R8-C4 remote branch advises on region and transcribe", () => {
  it("warns on region for a guessed video URL and transcribe for a guessed image URL", async () => {
    const { tool } = createRemoteStubTool();
    const region = await tool.execute({
      path: "https://example.test/movie.mp4",
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(region.warnings?.join(" ")).toMatch(/region/u);
    const transcribe = await tool.execute({
      path: "https://example.test/shot.png",
      transcribe: true,
    });
    expect(transcribe.warnings?.join(" ")).toMatch(/transcribe/u);
  });
});

describe("R8-C5 structured labels stay bounded", () => {
  it("caps element labels at 200 code points in structuredContent", () => {
    const bound = (
      EnriVisionServer as unknown as {
        boundStructuredContent(result: {
          readonly analysis: string;
          readonly elements?: ReadonlyArray<{
            readonly label: string;
            readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
          }>;
          readonly media_type: string;
          readonly extraction: Record<string, unknown>;
        }): Record<string, unknown>;
      }
    ).boundStructuredContent;
    const out = bound({
      analysis: "ok",
      media_type: "image",
      extraction: {},
      elements: [{ label: "😀".repeat(300), box: { x: 0, y: 0, width: 1, height: 1 } }],
    }) as { readonly elements?: ReadonlyArray<{ readonly label: string }> };
    const label: string = out.elements?.[0]?.label ?? "";
    expect(Array.from(label).length).toBeLessThanOrEqual(200);
    expect(hasNoLoneSurrogates(label)).toBe(true);
  });
});

describe("R8-C6 empty files fail before any session", () => {
  it("rejects 0-byte files in Spanish", () => {
    const check = (
      AnalyzeMediaInputResolver.prototype as unknown as {
        checkFileStat(filePath: string, size: number, isFile: boolean): number;
      }
    ).checkFileStat;
    expect(() => check.call({}, "empty.png", 0, true)).toThrow(/vacío.*0 bytes/u);
  });
});

describe("R8-C7 omission marker cites the imported budget", () => {
  it("degrades hostile payloads to a marker naming the live constant", () => {
    const bound = (
      EnriVisionServer as unknown as {
        boundExtraction(extraction: Record<string, unknown>): Record<string, unknown>;
      }
    ).boundExtraction;
    const wide: Record<string, unknown> = {
      rows: Array.from({ length: 60000 }, (_: unknown, index: number) => ({ n: index })),
    };
    const out = bound(wide) as { readonly _omitted?: string };
    expect(out._omitted).toContain(String(ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars));
  });
});

describe("R8-C8 tar estimate budgets worst-case basenames", () => {
  it("sizes the manifest term for 255-byte names", () => {
    expect(estimateMediaSetTarBytes(1000, 2)).toBe(1000 + 2 * 512 + 512 + 1536 + 2 * 511 + 1024);
    expect(estimateMediaSetTarBytes(0, 100)).toBeGreaterThan(256 + 100 * 512);
  });
});

describe("R8-C9 lone start at the cap forwards server-decides", () => {
  it("keeps clip_start_seconds 86400 with no clamp warning", () => {
    const parsed = new AnalyzeMediaParamParser().parseParams({
      path: abs("a.mp4"),
      video: { clip_start_seconds: 86400 },
    });
    expect(parsed.video?.clipStartSeconds).toBe(86400);
    expect(parsed.video?.clipDurationSeconds).toBeUndefined();
    const warnings = (parsed as { readonly warnings?: ReadonlyArray<string> }).warnings ?? [];
    expect(warnings.join(" ")).not.toMatch(/recort|clamp|trim/u);
  });
});
