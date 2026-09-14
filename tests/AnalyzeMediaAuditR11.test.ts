/**
 * Analyze Media R11 regression tests (M4 EnriVision MCP lane).
 *
 * Pins the 8 M4 fixes reconciled in `Enri/.audits/analyze-media-r11/m4-enrivision.md`:
 * tar staged-identity gate, bounded envelope warnings/media-type/elements,
 * capped probe cache, pre-upload client guards, POSIX examples, honest
 * language logging, progress-log wording, and singular ceiling messages.
 *
 * @module tests/AnalyzeMediaAuditR11
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";

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
    warnings?: ReadonlyArray<string>;
    elements?: ReadonlyArray<{ label: string; box: { x: number; y: number; width: number; height: number } }>;
    extraction: Record<string, unknown>;
  }): Record<string, unknown>;
  getAnalyzeMediaToolDefinition?: undefined;
};

/** Builds one stub-backed tool for execute-level tests. */
function createTool(seen: { language?: string }): AnalyzeMediaTool {
  return new AnalyzeMediaTool({
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 5000,
    createClient: () =>
      ({
        createUploadSession: async () => ({ upload_id: "upload-1", chunk_size_bytes: 1024 * 1024 }),
        getUploadOffset: async () => 0,
        appendUploadChunk: async (params: { offset: number; chunk: Buffer }) =>
          params.offset + params.chunk.length,
        analyze: async (params: { language?: string }) => {
          seen.language = params.language;
          return { analysis: "ok", media_type: "image", extraction: {} };
        },
      }) as never,
  });
}

describe("Analyze Media R11 M4-B1: tar staging rejects same-size swaps", (): void => {
  it("compares the staged identity before packing", async (): Promise<void> => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r11-b1-"));
    try {
      const first: string = join(dir, "a.png");
      const second: string = join(dir, "b.png");
      await writeFile(first, Buffer.from([137, 80, 78, 71, 1]));
      await writeFile(second, Buffer.from([137, 80, 78, 71, 2]));
      const tool = createTool({});
      const params = tool.parseParams({ paths: [first, second] });
      const resolved = await (
        tool as unknown as {
          inputResolver: {
            resolve(params: unknown): Promise<{ readonly inputs: ReadonlyArray<Record<string, unknown>> }>;
          };
        }
      ).inputResolver.resolve(params);
      expect(resolved.inputs).toHaveLength(2);
      const tampered = resolved.inputs.map((input: Record<string, unknown>) => ({
        ...input,
        stagedIdentity: "ino:0:size:0:mtime:0:birthtime:0:nlink:0",
      }));
      const packager = (
        tool as unknown as {
          tarPackager: {
            uploadImageSetAsMediaSetTar(
              client: unknown,
              inputs: readonly unknown[],
              timeoutMs: number,
              traceId: string,
            ): Promise<string>;
          };
        }
      ).tarPackager;
      await expect(
        packager.uploadImageSetAsMediaSetTar({} as never, tampered, 1000, "trace-r11-b1"),
      ).rejects.toThrow("cambió antes de la subida");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Analyze Media R11 M4-B2: envelopes bound server-controlled fields", (): void => {
  it("caps warnings, sanitizes media_type, and caps elements in structured content", (): void => {
    const bounded = serverStatics.boundStructuredContent({
      analysis: "ok",
      media_type: "video/mp4\ninyectado: x".repeat(20),
      warnings: Array.from({ length: 25 }, (_, index: number) => `w${index} `.repeat(300)),
      elements: Array.from({ length: 150 }, (_, index: number) => ({
        label: `box-${index}`,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      })),
      extraction: {},
    });
    const warnings = bounded["warnings"] as ReadonlyArray<string>;
    expect(warnings).toHaveLength(20);
    expect(String(bounded["media_type"])).not.toContain("\n");
    expect(Array.from(String(bounded["media_type"])).length).toBeLessThanOrEqual(128);
    expect((bounded["elements"] as ReadonlyArray<unknown>)).toHaveLength(100);
  });

  it("caps warnings and elements in the text envelope", (): void => {
    const text: string = serverStatics.formatAnalysisText(
      "corto",
      "image",
      Array.from({ length: 150 }, (_, index: number) => ({
        label: `box-${index}`,
        box: { x: 0, y: 0, width: 1, height: 1 },
      })),
      Array.from({ length: 25 }, (_, index: number) => `aviso-${index} `),
    );
    expect(text).toContain("avisos / warnings:");
    expect((text.match(/- aviso-/gu) ?? []).length).toBe(20);
    expect((text.match(/- box-/gu) ?? []).length).toBe(100);
  });
});

describe("Analyze Media R11 M4-B3: probe cache stays bounded", (): void => {
  it("evicts oldest-first past 100 entries", (): void => {
    const tool = createTool({});
    const remember = (
      tool as unknown as {
        rememberVisionProbe(cacheKey: string, verdict: boolean, now: number): void;
        visionProbeCache: Map<string, { readonly verdict: boolean; readonly expiresAt: number }>;
      }
    ).rememberVisionProbe.bind(tool);
    for (let index: number = 0; index < 150; index += 1) {
      remember(`http://127.0.0.1:8787::model-${index}`, true, 1_000_000);
    }
    const cache = (
      tool as unknown as { visionProbeCache: Map<string, { readonly verdict: boolean }> }
    ).visionProbeCache;
    expect(cache.size).toBeLessThanOrEqual(100);
    expect(cache.has("http://127.0.0.1:8787::model-149")).toBe(true);
    expect(cache.has("http://127.0.0.1:8787::model-0")).toBe(false);
  });
});

describe("Analyze Media R11 M4-B4: direct-client guards mirror the parser", (): void => {
  it("rejects bad enums, bad languages, unknown section keys, and non-string prompts", (): void => {
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ analysisMode: "turbo" } as never),
    ).toThrow("analysis_mode debe ser uno de");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ language: "!!! " } as never),
    ).toThrow("language debe ser un código de idioma");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ video: { clip_start_seconds: 1, bogus_knob: 2 } } as never),
    ).toThrow("video tiene claves desconocidas");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ images: { max_images_totall: 5 } } as never),
    ).toThrow("images tiene claves desconocidas");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ analysisMode: "auto", language: "es" } as never),
    ).not.toThrow();
  });

  it("rejects non-string prompts before any upload", async (): Promise<void> => {
    const client = new EnriProxyClient({
      baseUrl: "http://127.0.0.1:8787",
      apiKey: "test",
      timeoutMs: 1000,
    });
    await expect(
      client.analyze({ uploadId: "u1", question: 42 } as never),
    ).rejects.toThrow("question debe ser una cadena de texto");
  });
});

describe("Analyze Media R11 M4-B5/C1: honest examples and language logging", (): void => {
  it("shows POSIX examples with a Windows-host note", (): void => {
    const tool = createTool({});
    const server = new EnriVisionServer({
      name: "test",
      version: "0.0.0-test",
      analyzeMediaTool: tool,
    });
    const definition = (
      server as unknown as { getAnalyzeMediaToolDefinition(): { description: string } }
    ).getAnalyzeMediaToolDefinition();
    expect(definition.description).toContain("/tmp/shot.png");
    expect(definition.description).not.toContain("C:/pics");
    expect(definition.description).toContain("Windows");
  });

  it("does not claim an effective language from an invalid default", async (): Promise<void> => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r11-c1-"));
    const previous: string | undefined = process.env["ENRIVISION_DEFAULT_LANGUAGE"];
    process.env["ENRIVISION_DEFAULT_LANGUAGE"] = "!!!invalid!!!";
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]): void => {
      errors.push(String(args[0]));
    });
    try {
      const file: string = join(dir, "a.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const seen: { language?: string } = {};
      const tool: AnalyzeMediaTool = createTool(seen);
      await tool.execute(tool.parseParams({ path: file }));
      expect(seen.language).toBeUndefined();
      expect(errors.filter((message) => message.includes("invalid ENRIVISION_DEFAULT_LANGUAGE"))).toHaveLength(1);
      expect(errors.some((message) => message.includes("effective response language"))).toBe(false);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env["ENRIVISION_DEFAULT_LANGUAGE"];
      } else {
        process.env["ENRIVISION_DEFAULT_LANGUAGE"] = previous;
      }
      errorSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Analyze Media R11 M4-C3: singular ceiling message plus finite offset guard", (): void => {
  it("uses the singular message for single files", (): void => {
    const resolver = new AnalyzeMediaInputResolver({} as never);
    const gauge = (
      resolver as unknown as {
        throwOnUploadCeilingExceeded(resolvedBytes: number, entryCount: number, isImageSet: boolean): void;
      }
    ).throwOnUploadCeilingExceeded.bind(resolver);
    expect((): void =>
      gauge(ANALYZE_MEDIA_LIMITS.maxUploadBytes + 1, 1, false),
    ).toThrow("El archivo excede el límite de subida");
    expect((): void =>
      gauge(ANALYZE_MEDIA_LIMITS.maxUploadBytes + 1, 2, true),
    ).toThrow("El conjunto de archivos excede");
  });
});

describe("Analyze Media R12 continuation: MCP cursor mode", (): void => {
  it("parses cursor reads and rejects cursor+path combos", (): void => {
    const tool = createTool({});
    const params = tool.parseParams({ cursor: "vs_abc123", offset: 20 });
    expect(params.cursor).toBe("vs_abc123");
    expect(params.offset).toBe(20);
    expect((): void => {
      tool.parseParams({ cursor: "vs_abc123", path: "/tmp/a.png" });
    }).toThrow("no se combina");
    expect((): void => {
      tool.parseParams({ cursor: "../x" });
    }).toThrow("cursor debe ser");
    expect((): void => {
      tool.parseParams({ cursor: "vs_abc123", offset: -1 });
    }).toThrow("offset debe ser");
  });

  it("reads continuation windows without touching the filesystem", async (): Promise<void> => {
    const seen: { language?: string } = {};
    const fetchCalls: unknown[] = [];
    const tool = new AnalyzeMediaTool({
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 5000,
      createClient: () =>
        ({
          fetchSegmentPage: async (params: { cursor: string; offset?: number }) => {
            fetchCalls.push(params);
            return {
              entries: [{ summary: "seg-20" }, { summary: "seg-21" }],
              total: 60,
              hasMore: true,
              nextOffset: 22,
              cursor: params.cursor,
            };
          },
        }) as never,
    });
    const result = await tool.execute(tool.parseParams({ cursor: "vs_abc123" }));
    expect(fetchCalls).toHaveLength(1);
    expect(result.analysis).toContain("20-22 de 60");
    expect(result.analysis).toContain("offset 22");
    expect(result.extraction["has_more"]).toBe(true);
    expect(result.extraction["cursor"]).toBe("vs_abc123");
    expect(seen).toBeDefined();
  });

  it("declares the end of the list on the final window", async (): Promise<void> => {
    const tool = new AnalyzeMediaTool({
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 5000,
      createClient: () =>
        ({
          fetchSegmentPage: async () => ({
            entries: [{ summary: "seg-59" }],
            total: 60,
            hasMore: false,
            nextOffset: 60,
            cursor: "vs_abc123",
          }),
        }) as never,
    });
    const result = await tool.execute(tool.parseParams({ cursor: "vs_abc123", offset: 59 }));
    expect(result.analysis).toContain("No quedan más entradas");
    expect(result.extraction["has_more"]).toBe(false);
  });
});
