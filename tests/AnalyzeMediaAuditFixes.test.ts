import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
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

import { EnriProxyHttpError } from "../src/client/EnriProxyClientContract.js";
import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { TarStream, type TarEntry } from "../src/shared/tar.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { optionalNumber } from "../src/shared/validation.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { AnalyzeMediaTarPackager } from "../src/tools/AnalyzeMediaTarPackager.js";
import {
  AnalyzeMediaResumableUploader,
  isProgressQuiet,
  retryAfterDelayMs,
  withResumableRetry,
} from "../src/tools/AnalyzeMediaResumableUploader.js";

/**
 * Creates one tool instance with an unused client factory.
 *
 * @returns Tool instance.
 */
function createTool(): AnalyzeMediaTool {
  return new AnalyzeMediaTool({
    createClient: () => {
      throw new Error("not used");
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
  });
}

/**
 * Restores process environment keys touched by a test.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe("TarStream truncated-file integrity (MCP-A1)", () => {
  it("fails loudly in Spanish instead of zero-filling truncated files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-tar-trunc-"));
    try {
      const file = join(dir, "a.bin");
      await writeFile(file, Buffer.alloc(4096, 0x61));
      const nowSeconds = Math.floor(Date.now() / 1000);
      const entries: TarEntry[] = [
        {
          name: "000001.bin",
          source: { type: "file", path: file, sizeBytes: 4096 },
          mtimeSeconds: nowSeconds,
        },
      ];
      const tar = new TarStream(entries);
      // Concurrent writer truncates after the layout snapshot.
      await truncate(file, 100);
      await expect(
        (async (): Promise<void> => {
          for await (const _chunk of tar.iterateChunks(512, 1024)) {
            // Drain; the short read must throw.
          }
        })(),
      ).rejects.toThrow(/cambió durante la subida/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TarPackager stage-time snapshot (MCP-A1)", () => {
  it("fails fast when a staged file changed before session creation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-tar-stage-"));
    try {
      const fileA = join(dir, "a.png");
      const fileB = join(dir, "b.png");
      await writeFile(fileA, Buffer.alloc(64, 0x61));
      await writeFile(fileB, Buffer.alloc(64, 0x62));
      const packager = new AnalyzeMediaTarPackager(new AnalyzeMediaResumableUploader());
      const failingClient = {
        createUploadSession: async (): Promise<never> => {
          throw new Error("must not be called");
        },
      };
      await expect(
        packager.uploadImageSetAsMediaSetTar(
          failingClient as never,
          [
            {
              localPath: fileA,
              filename: "a.png",
              sizeBytes: 999999,
              contentType: "image/png",
              extensionSynthesized: false,
            },
            {
              localPath: fileB,
              filename: "b.png",
              sizeBytes: 64,
              contentType: "image/png",
              extensionSynthesized: false,
            },
          ],
          1000,
          "trace-test",
        ),
      ).rejects.toThrow(/cambió antes de la subida/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Param parser parity traps (MCP-B3/B7/C4)", () => {
  it("rejects EnriCode-only attachment selectors with a redirect", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(() =>
      parser.parseParams({ path: abs("a.png"), attachmentIndex: 0 }),
    ).toThrow(/attachmentIndex/);
    expect(() =>
      parser.parseParams({ path: abs("a.png"), attachmentId: "abc" }),
    ).toThrow(/attachmentIndex|attachmentId/);
  });

  it("keeps question optional", () => {
    const params = new AnalyzeMediaParamParser().parseParams({ path: abs("a.png") });
    expect(params.question).toBeUndefined();
  });

  it("rejects region together with paths", () => {
    expect(() =>
      new AnalyzeMediaParamParser().parseParams({
        path: abs("a.png"),
        paths: [abs("a.png"), abs("b.png")],
        region: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ).toThrow(/sólo aplica a una imagen individual/);
  });

  it("mentions URLs in the non-array paths error", () => {
    expect(() => new AnalyzeMediaParamParser().parseParams({ paths: "nope" })).toThrow(
      /URLs http/,
    );
  });
});

describe("Extraction sanitizer accounting keys (MCP-B5)", () => {
  it("keeps token_usage-style keys and strips secret-bearing token keys", () => {
    const tool = createTool();
    const sanitized = (
      tool as unknown as {
        stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
      }
    ).stripInternalExtractionFields({
      token_usage: { total: 5 },
      tokens_used: 5,
      token_count: 5,
      api_key: "secret",
      refresh_token: "secret",
      access_token: "secret",
      auth_token: "secret",
      id_token: "secret",
      secret: "secret",
      token: "secret",
    });
    expect(sanitized).toHaveProperty("token_usage");
    expect(sanitized).toHaveProperty("tokens_used");
    expect(sanitized).toHaveProperty("token_count");
    expect(sanitized).not.toHaveProperty("api_key");
    expect(sanitized).not.toHaveProperty("refresh_token");
    expect(sanitized).not.toHaveProperty("access_token");
    expect(sanitized).not.toHaveProperty("auth_token");
    expect(sanitized).not.toHaveProperty("id_token");
    expect(sanitized).not.toHaveProperty("secret");
    expect(sanitized).not.toHaveProperty("token");
  });
});

describe("Structured content bound (MCP-B6)", () => {
  /**
   * Calls the private payload bounding helper.
   *
   * @param analysis - Raw analysis text.
   * @returns Bounded payload.
   */
  function bound(analysis: string): Record<string, unknown> {
    return (
      EnriVisionServer as unknown as {
        boundStructuredContent: (result: {
          readonly analysis: string;
          readonly media_type: string;
          readonly extraction: Record<string, unknown>;
        }) => Record<string, unknown>;
      }
    ).boundStructuredContent({ analysis, media_type: "video", extraction: {} });
  }

  it("truncates huge analyses with flags and keeps small ones intact", () => {
    const big = bound("a".repeat(300000));
    expect(big["analysis_truncated"]).toBe(true);
    expect(big["analysis_total_chars"]).toBe(300000);
    expect(big["analysis"] as string).toMatch(/truncado: se muestran principio.*y fin.*de 300000 caracteres/u);
    // The seam counts against the budget: the delivered analysis never
    // exceeds the declared structured-content limit (code points).
    expect(Array.from(big["analysis"] as string).length).toBeLessThanOrEqual(
      ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars,
    );
    const small = bound("ok");
    expect(small["analysis"]).toBe("ok");
    expect(small).not.toHaveProperty("analysis_truncated");
  });

  it("never splits surrogate pairs when truncating", () => {
    const big = bound("😀".repeat(300000));
    const text = big["analysis"] as string;
    expect(Array.from(text).length).toBeLessThanOrEqual(
      ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars,
    );
    expect(Array.from(text).length).toBeGreaterThan(
      ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisHeadChars,
    );
    expect(text).toMatch(/truncado/u);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("Resumable retry helper (MCP-C1)", () => {
  it("retries transient failures and returns the success value", async () => {
    let calls = 0;
    const out = await withResumableRetry(async (): Promise<string> => {
      calls += 1;
      if (calls < 3) {
        throw new Error("boom 503");
      }
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry client errors", async () => {
    let calls = 0;
    await expect(
      withResumableRetry(async (): Promise<string> => {
        calls += 1;
        throw new EnriProxyHttpError("bad", 404, {}, "missing");
      }),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });
});

describe("Chunk 409 handling (MCP-C2)", () => {
  it("fails fast in Spanish when the server rejects bytes without advancing", async () => {
    const uploader = new AnalyzeMediaResumableUploader();
    const stuckClient = {
      getUploadOffset: async (): Promise<number> => 0,
      appendUploadChunk: async (): Promise<never> => {
        throw new EnriProxyHttpError("conflict", 409, {}, "stuck");
      },
    };
    await expect(
      uploader.uploadChunkWithRetry(stuckClient as never, "upload-1", 0, Buffer.from("xy"), 1000),
    ).rejects.toThrow(/sin avanzar el offset/);
  });

  it("still resyncs when the server advanced the offset", async () => {
    const uploader = new AnalyzeMediaResumableUploader();
    const resyncClient = {
      getUploadOffset: async (): Promise<number> => 5,
      appendUploadChunk: async (): Promise<never> => {
        throw new EnriProxyHttpError("conflict", 409, {}, "moved");
      },
    };
    await expect(
      uploader.uploadChunkWithRetry(
        resyncClient as never,
        "upload-1",
        0,
        Buffer.from("xy"),
        1000,
      ),
    ).resolves.toBe(5);
  });
});

describe("Default language precedence (MCP-B4)", () => {
  it("explicit language wins; env default applies otherwise with a stderr note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-lang-"));
    const previous = process.env["ENRIVISION_DEFAULT_LANGUAGE"];
    process.env["ENRIVISION_DEFAULT_LANGUAGE"] = "es";
    const errors: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]): void => {
        errors.push(String(args[0]));
      });
    try {
      const file = join(dir, "a.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const seenLanguages: Array<string | undefined> = [];
      const tool = new AnalyzeMediaTool({
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 5000,
        createClient: () =>
          ({
            createUploadSession: async () => ({
              upload_id: "upload-1",
              chunk_size_bytes: 1024 * 1024,
            }),
            getUploadOffset: async () => 0,
            appendUploadChunk: async (params: { offset: number; chunk: Buffer }) =>
              params.offset + params.chunk.length,
            analyze: async (params: { language?: string }) => {
              seenLanguages.push(params.language);
              return { analysis: "ok", media_type: "image", extraction: {} };
            },
          }) as never,
      });
      await tool.execute(tool.parseParams({ path: file, language: "en" }));
      expect(seenLanguages[0]).toBe("en");
      await tool.execute(tool.parseParams({ path: file }));
      expect(seenLanguages[1]).toBe("es");
      expect(errors.some((message) => message.includes("ENRIVISION_DEFAULT_LANGUAGE"))).toBe(true);
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

describe("Progress quiet mode (MCP-C5)", () => {
  it("reports quiet only when ENRIVISION_QUIET is exactly 1", () => {
    const previous = process.env["ENRIVISION_QUIET"];
    try {
      delete process.env["ENRIVISION_QUIET"];
      expect(isProgressQuiet()).toBe(false);
      process.env["ENRIVISION_QUIET"] = "1";
      expect(isProgressQuiet()).toBe(true);
      process.env["ENRIVISION_QUIET"] = "0";
      expect(isProgressQuiet()).toBe(false);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env["ENRIVISION_QUIET"];
      } else {
        process.env["ENRIVISION_QUIET"] = previous;
      }
    }
  });
});

describe("Symlink handling (MCP-C3)", () => {
  it("follows symlinks by default and rejects them in strict mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-symlink-"));
    const previous = process.env["ENRIVISION_DENY_SYMLINKS"];
    try {
      const target = join(dir, "target.png");
      const link = join(dir, "link.png");
      await writeFile(target, Buffer.from("data"));
      try {
        await symlink(target, link);
      } catch {
        // Windows hosts without symlink privilege cannot exercise this path.
        return;
      }
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      delete process.env["ENRIVISION_DENY_SYMLINKS"];
      const followed = await resolver.resolve({ path: link });
      expect(followed.inputs[0]?.localPath).toBe(link);
      process.env["ENRIVISION_DENY_SYMLINKS"] = "1";
      await expect(resolver.resolve({ path: link })).rejects.toThrow(/simbólicos/);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env["ENRIVISION_DENY_SYMLINKS"];
      } else {
        process.env["ENRIVISION_DENY_SYMLINKS"] = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Strict optionalNumber (lote 8/B1)", () => {
  it("rejects partial numerics instead of parsing a prefix", () => {
    expect(optionalNumber("12:34")).toBeUndefined();
    expect(optionalNumber("30s")).toBeUndefined();
    expect(optionalNumber("754abc")).toBeUndefined();
    expect(optionalNumber("")).toBeUndefined();
  });

  it("accepts complete numerics", () => {
    expect(optionalNumber("754")).toBe(754);
    expect(optionalNumber(" 12.5 ")).toBe(12.5);
    expect(optionalNumber("1e3")).toBeUndefined();
    expect(optionalNumber(12.5)).toBe(12.5);
  });

  it("fails clip windows with suffixed numbers in Spanish", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(() =>
      parser.parseParams({
        path: abs("a.mp4"),
        video: { clip_start_seconds: "12:34" },
      })
    ).toThrow(/video\.clip_start_seconds.*número/u);
  });
});

describe("Proxy-aligned knob bounds (lote 8/B2)", () => {
  it("rejects MCP-only ranges that the proxy would refuse late", () => {
    const parser = new AnalyzeMediaParamParser();
    const base = abs("a.png");
    expect(() => parser.parseParams({ paths: [base], images: { images_per_batch: 500 } })).toThrow(
      /images\.images_per_batch.*1.*20/u
    );
    expect(() => parser.parseParams({ paths: [base], images: { max_dimension: 8192 } })).toThrow(
      /images\.max_dimension.*256.*4096/u
    );
    expect(() => parser.parseParams({ path: base, document: { pages_per_batch: 500 } })).toThrow(
      /document\.pages_per_batch.*1.*200/u
    );
    expect(() =>
      parser.parseParams({ path: base, document: { scanned_text_threshold_chars: 100000 } })
    ).toThrow(/document\.scanned_text_threshold_chars.*0.*5000/u);
  });

  it("accepts the proxy boundary values", () => {
    const parser = new AnalyzeMediaParamParser();
    const params = parser.parseParams({
      paths: [abs("a.png")],
      images: { max_images_total: 500, images_per_batch: 20, max_dimension: 4096 },
      document: undefined,
    });
    expect(params.images?.maxImagesTotal).toBe(500);
    expect(params.images?.imagesPerBatch).toBe(20);
    expect(params.images?.maxDimension).toBe(4096);
    const doc = parser.parseParams({
      path: abs("a.pdf"),
      document: {
        max_pages_total: 200,
        pages_per_batch: 200,
        max_images_per_batch: 20,
        scanned_text_threshold_chars: 5000,
      },
    });
    expect(doc.document?.maxPagesTotal).toBe(200);
    expect(doc.document?.scannedTextThresholdChars).toBe(5000);
  });
});

describe("Flat segment-knob conflict (lote 8/B5, paridad EnriCode R3)", () => {
  it("lets a flat maxSegments win over divergent nested video/audio values", () => {
    const parser = new AnalyzeMediaParamParser();
    const params = parser.parseParams({
      path: abs("a.mp4"),
      maxSegments: 60,
      video: { max_segments: 30 },
      audio: { max_segments: 90 },
    });
    expect(params.video?.maxSegments).toBe(60);
    expect(params.audio?.maxSegments).toBe(60);
  });

  it("rejects divergent nested video/audio values without a flat winner", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(() =>
      parser.parseParams({
        path: abs("a.mp4"),
        video: { max_segments: 30 },
        audio: { max_segments: 40 },
      })
    ).toThrow(/difieren sin un plano/u);
  });
});

describe("Orphan upload cleanup (lote 8/B3/C10)", () => {
  it("deletes the upload best-effort when analysis fails and keeps the original error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-cleanup-"));
    try {
      const file = join(dir, "shot.png");
      await writeFile(file, Buffer.alloc(16, 2));
      const deleted: string[] = [];
      const failingCleanup = vi.fn(async () => {
        throw new Error("boom limpieza");
      });
      const stubFetcher = {
        fetch: vi.fn(async () => ({
          localPath: file,
          contentType: "image/png",
          extensionSynthesized: false,
          cleanup: failingCleanup,
        })),
      } as unknown as MediaUrlFetcher;
      const tool = new AnalyzeMediaTool(
        {
          createClient: () =>
            ({
              createUploadSession: async () => ({
                upload_id: "upload_9",
                chunk_size_bytes: 1024 * 1024,
                expires_at: Date.now() + 60_000,
              }),
              getUploadOffset: async () => 0,
              appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
                request.offset + request.chunk.length,
              analyze: async () => {
                throw new Error("falló el análisis");
              },
              deleteUploadSession: async (uploadId: string) => {
                deleted.push(uploadId);
              },
            }) as never,
          defaultServerUrl: "http://127.0.0.1:8787",
          defaultApiKey: "test",
          defaultTimeoutMs: 1000,
        },
        stubFetcher
      );
      await expect(tool.execute({ path: "https://example.test/shot.png" })).rejects.toThrow(
        /falló el análisis/
      );
      expect(deleted).toEqual(["upload_9"]);
      expect(failingCleanup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Spanish malformed URLs (lote 8/C8)", () => {
  it("wraps URL parse failures in Spanish instead of TypeError", async () => {
    const fetcher = new MediaUrlFetcher();
    await expect(fetcher.fetch("http://exa mple.test/a.png")).rejects.toThrow(/URL inválida/u);
  });

  it("rejects a malformed proxy base URL in Spanish", async () => {
    const client = new EnriProxyClient({ baseUrl: "::::", apiKey: "k", timeoutMs: 1000 });
    await expect(
      client.createUploadSession({ filename: "a.png", sizeBytes: 1, contentType: "image/png" })
    ).rejects.toThrow(/ENRIPROXY_URL inválida/u);
  });
});

describe("Retry-After aware retries (lote 8/C2)", () => {
  it("honors Retry-After only for 408/429", () => {
    const retry429 = new EnriProxyHttpError("límite", 429, { "retry-after": "2" }, "x");
    expect(retryAfterDelayMs(retry429)).toBe(2000);
    const retry408 = new EnriProxyHttpError("timeout", 408, { "retry-after": "0" }, "x");
    expect(retry408).toBeInstanceOf(EnriProxyHttpError);
    expect(retryAfterDelayMs(retry408)).toBe(0);
    const bad400 = new EnriProxyHttpError("mala", 400, { "retry-after": "5" }, "x");
    expect(retryAfterDelayMs(bad400)).toBeNull();
    expect(retryAfterDelayMs(new Error("red"))).toBeNull();
  });

  it("retries 429 with Retry-After and still fails fast on 403", async () => {
    let calls = 0;
    const result = await withResumableRetry(async () => {
      calls += 1;
      if (calls < 3) {
        throw new EnriProxyHttpError("límite", 429, { "retry-after": "0" }, "x");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    await expect(
      withResumableRetry(async () => {
        throw new EnriProxyHttpError("prohibido", 403, {}, "x");
      })
    ).rejects.toThrow(/prohibido/);
  });
});
