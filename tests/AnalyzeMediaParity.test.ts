import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import {
  MediaUrlFetcher,
  type MediaUrlFetchResult,
} from "../src/shared/mediaUrlFetcher.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import {
  effectiveChunkSizeBytes,
  resolveChunkTimeoutMs,
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
 * Creates one fetch stub serving the given bytes for every request.
 *
 * @param bytes - Payload served for every request.
 * @returns Fetch-compatible function.
 */
function createFetchStub(bytes: Uint8Array): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;
}

describe("AnalyzeMedia camelCase and flat aliases", () => {
  it("accepts top-level camelCase spellings", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      maxFrames: 7,
      analysisMode: "single",
      transcriptionLanguage: "en",
    });

    expect(params.maxFrames).toBe(7);
    expect(params.analysisMode).toBe("single");
    expect(params.transcriptionLanguage).toBe("en");
  });

  it("prefers flat knobs over nested tuning", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      segmentSeconds: 100,
      maxSegments: 11,
      maxFramesPerSegment: 9,
      documentMaxPages: 33,
      clipStartSeconds: 10,
      clipDurationSeconds: 5,
      video: {
        segment_seconds: 60,
        max_segments: 5,
        max_frames_per_segment: 4,
        clip_start_seconds: 1,
        clip_duration_seconds: 2,
      },
      document: { max_pages_total: 10 },
    });

    expect(params.video?.segmentSeconds).toBe(100);
    expect(params.video?.maxSegments).toBe(11);
    expect(params.video?.maxFramesPerSegment).toBe(9);
    expect(params.video?.clipStartSeconds).toBe(10);
    expect(params.video?.clipDurationSeconds).toBe(5);
    expect(params.document?.maxPagesTotal).toBe(33);
  });

  it("lets flat segment knobs win over video and audio (EnriCode parity)", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      segmentSeconds: 100,
      video: { segment_seconds: 60 },
      audio: { segment_seconds: 45 },
    });
    expect(params.video?.segmentSeconds).toBe(100);
    expect(params.audio?.segmentSeconds).toBe(100);
  });

  it("rejects differing nested video/audio knobs without a flat winner", () => {
    const tool = createTool();
    expect(() =>
      tool.parseParams({
        path: "C:\\Users\\User\\Downloads\\clip.mp4",
        video: { segment_seconds: 60 },
        audio: { segment_seconds: 45 },
      })
    ).toThrow(/difieren sin un plano/u);
  });

  it("accepts nested camelCase spellings", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      video: { segmentSeconds: 30, maxSegments: 6, maxFramesPerSegment: 3 },
      audio: { segmentSeconds: 30, maxSegments: 6 },
      document: { maxPagesTotal: 7, pagesPerBatch: 3, maxImagesPerBatch: 2 },
      images: { maxImagesTotal: 9, imagesPerBatch: 4, maxDimension: 512 },
    });

    expect(params.video?.segmentSeconds).toBe(30);
    expect(params.video?.maxSegments).toBe(6);
    expect(params.video?.maxFramesPerSegment).toBe(3);
    expect(params.audio?.segmentSeconds).toBe(30);
    expect(params.document?.maxPagesTotal).toBe(7);
    expect(params.document?.pagesPerBatch).toBe(3);
    expect(params.images?.maxImagesTotal).toBe(9);
    expect(params.images?.maxDimension).toBe(512);
  });
});

describe("AnalyzeMedia clip_end_seconds", () => {
  it("derives duration as end minus start", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      video: { clip_start_seconds: 12, clip_end_seconds: 34 },
    });

    expect(params.video?.clipStartSeconds).toBe(12);
    expect(params.video?.clipDurationSeconds).toBe(22);
  });

  it("accepts flat clip aliases and synthesizes start 0 (EnriCode parity)", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      clipEndSeconds: 30,
    });

    expect(params.video?.clipStartSeconds).toBe(0);
    expect(params.video?.clipDurationSeconds).toBe(30);
  });

  it("rejects inverted windows and out-of-range bounds", () => {
    const tool = createTool();
    const base = "C:\\Users\\User\\Downloads\\clip.mp4";

    expect(() =>
      tool.parseParams({ path: base, video: { clip_start_seconds: 34, clip_end_seconds: 12 } }),
    ).toThrow(/clip_end_seconds.*inicio/u);
    expect(() =>
      tool.parseParams({ path: base, video: { clip_start_seconds: 10, clip_end_seconds: 10 } }),
    ).toThrow(/clip_end_seconds.*mayor que/u);
    expect(() => tool.parseParams({ path: base, video: { clip_end_seconds: 90000 } })).toThrow(
      /86400/u,
    );
    expect(() => tool.parseParams({ path: base, video: { clip_start_seconds: 90000 } })).toThrow(
      /86400/u,
    );
    expect(() => tool.parseParams({ path: base, video: { clip_duration_seconds: 90000 } })).toThrow(
      /86400/u,
    );
  });
});

describe("AnalyzeMedia strict coercion", () => {
  it("rejects fractional integers and non-boolean transcribe", () => {
    const tool = createTool();
    const base = "C:\\Users\\User\\Downloads\\clip.mp4";

    expect(() => tool.parseParams({ path: base, max_frames: 7.9 })).toThrow(/max_frames/u);
    expect(() => tool.parseParams({ path: base, max_frames: "7.9" })).toThrow(/max_frames/u);
    expect(tool.parseParams({ path: base, transcribe: "true" }).transcribe).toBe(true);
    expect(tool.parseParams({ path: base, transcribe: " False " }).transcribe).toBe(false);
    expect(() => tool.parseParams({ path: base, transcribe: 1 })).toThrow(/booleano/u);
    expect(() => tool.parseParams({ path: base, transcribe: "yes" })).toThrow(/booleano/u);
  });

  it("rejects non-numeric region fractions and overflowing boxes", () => {
    const tool = createTool();
    const base = "C:\\Users\\User\\Downloads\\shot.png";

    expect(() =>
      tool.parseParams({ path: base, region: { x: true, y: 0, width: 0.5, height: 0.5 } }),
    ).toThrow(/region\.x/u);
    expect(() =>
      tool.parseParams({ path: base, region: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }),
    ).toThrow(/caber/u);
    expect(() =>
      tool.parseParams({ path: base, region: { x: 0, y: 0.9, width: 0.5, height: 0.5 } }),
    ).toThrow(/caber/u);
  });

  it("accepts complete numeric strings in region", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\shot.png",
      region: { x: "0.1", y: 0.2, width: 0.5, height: 0.5 },
    });

    expect(params.region).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
  });

  it("rejects paths[] over the count cap", () => {
    const tool = createTool();
    const entries: string[] = Array.from(
      { length: ANALYZE_MEDIA_LIMITS.maxPathsCount + 1 },
      (_unused: unknown, index: number): string => `C:\\Users\\User\\Downloads\\${String(index)}.png`,
    );

    expect(() => tool.parseParams({ paths: entries })).toThrow(/máximo 100/u);
  });
});

describe("AnalyzeMedia SSRF non-canonical literals", () => {
  it("blocks decimal, hex, octal, and mapped IPv6 loopbacks", async () => {
    const fetcher = new MediaUrlFetcher(
      createFetchStub(new Uint8Array([1])),
      async () => ["93.184.216.34"],
    );

    await expect(fetcher.fetch("http://2130706433/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://0x7f.0.0.1/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://0177.0.0.1/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://[::ffff:7f00:1]/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://[::ffff:127.0.0.1]/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://[0:0:0:0:0:ffff:127.0.0.1]/x.png")).rejects.toThrow(
      /bloqueado/iu,
    );
  });
});

describe("AnalyzeMedia MIME mismatch", () => {
  it("prefers the server content type over a mismatched authored extension", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-mime-"));
    const sessions: Array<{ contentType: string }> = [];
    try {
      const downloadedPath = join(temporaryDirectory, "a.png");
      await writeFile(downloadedPath, new Uint8Array([1, 2, 3]));
      const stubFetcher = {
        fetch: vi.fn(async (): Promise<MediaUrlFetchResult> => ({
          localPath: downloadedPath,
          contentType: "image/webp",
          extensionSynthesized: false,
          cleanup: vi.fn(),
        })),
      };
      const tool = new AnalyzeMediaTool(
        {
          createClient: () =>
            ({
              createUploadSession: async (request: { contentType: string }) => {
                sessions.push({ contentType: request.contentType });
                return { upload_id: "upload_1", chunk_size_bytes: 1024, expires_at: 0 };
              },
              getUploadOffset: async () => 0,
              appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
                request.offset + request.chunk.length,
              analyze: async () => ({ analysis: "ok", media_type: "image", extraction: {} }),
            }) as never,
          defaultServerUrl: "http://127.0.0.1:8787",
          defaultApiKey: "test",
          defaultTimeoutMs: 1000,
        },
        stubFetcher as never,
      );

      await tool.execute({ path: "https://example.test/a.png" });

      expect(sessions[0]?.contentType).toBe("image/webp");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("AnalyzeMedia sanitizer hardening", () => {
  it("drops prototype keys and provider/secret variants, keeps model identity", () => {
    const tool = createTool();
    const sanitized = (
      tool as unknown as {
        stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
      }
    ).stripInternalExtractionFields({
      __proto__: { polluted: true },
      filename: "a.mp4",
      model_name: "internal-model",
      provider: "internal-provider",
      api_key: "secret",
      nested: { token: "secret", timeline: { duration_seconds: 3 } },
    } as unknown as Record<string, unknown>);

    expect(sanitized).toHaveProperty("filename", "a.mp4");
    expect(sanitized).toHaveProperty("model_name", "internal-model");
    expect(sanitized).not.toHaveProperty("provider");
    expect(sanitized).not.toHaveProperty("api_key");
    const nested = sanitized["nested"] as Record<string, unknown>;
    expect(nested).not.toHaveProperty("token");
    expect(nested).toHaveProperty("timeline");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("keeps multipass/model/analysis-mode coverage, drops provider/secret/token variants", () => {
    const tool = createTool();
    const sanitized = (
      tool as unknown as {
        stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
      }
    ).stripInternalExtractionFields({
      filename: "a.mp4",
      multipass_stats: { segments: 4 },
      model_version: "internal-7",
      provider_name: "internal-provider",
      refresh_token: "secret",
      secret_key: "secret",
      analysis_mode_details: "internal",
      timeline: { duration_seconds: 3 },
    } as unknown as Record<string, unknown>);

    expect(sanitized).toHaveProperty("filename", "a.mp4");
    expect(sanitized).toHaveProperty("timeline");
    expect(sanitized).toHaveProperty("multipass_stats");
    expect(sanitized).toHaveProperty("model_version", "internal-7");
    expect(sanitized).not.toHaveProperty("provider_name");
    expect(sanitized).not.toHaveProperty("refresh_token");
    expect(sanitized).not.toHaveProperty("secret_key");
    expect(sanitized).toHaveProperty("analysis_mode_details", "internal");
  });
});

describe("AnalyzeMedia upload bounds", () => {
  it("caps server chunk sizes and derives bounded chunk timeouts", () => {
    expect(effectiveChunkSizeBytes(1024 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    expect(effectiveChunkSizeBytes(256 * 1024)).toBe(256 * 1024);
    // Invalid advertisements fall back to the 256 KiB default (EnriCode parity),
    // not the 16 MiB ceiling.
    expect(effectiveChunkSizeBytes(Number.NaN)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(0)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(-5)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(Number.POSITIVE_INFINITY)).toBe(256 * 1024);
    expect(resolveChunkTimeoutMs(1024, 120000)).toBe(30000);
    expect(resolveChunkTimeoutMs(8 * 1024 * 1024, 600000)).toBe(68000);
    expect(resolveChunkTimeoutMs(8 * 1024 * 1024, 60000)).toBe(60000);
    expect(resolveChunkTimeoutMs(1024 * 1024 * 1024, 10 ** 9)).toBe(300000);
    // Operator budgets below the 30 s floor no longer win (EnriCode parity:
    // tight single-chunk budgets fail on slow links where 30 s still works).
    expect(resolveChunkTimeoutMs(1024, 1000)).toBe(30000);
  });

  it("clamps tiny server chunk sizes up to the 4 KiB floor", () => {
    expect(effectiveChunkSizeBytes(1024)).toBe(4096);
    expect(effectiveChunkSizeBytes(4096)).toBe(4096);
  });

  it("fails fast on local files over 4 GiB", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-4gib-"));
    try {
      const hugePath = join(temporaryDirectory, "huge.bin");
      await writeFile(hugePath, new Uint8Array([1]));
      await truncate(hugePath, 5 * 1024 * 1024 * 1024);
      const sessions: string[] = [];
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => {
              sessions.push("upload");
              return { upload_id: "upload_1", chunk_size_bytes: 1024, expires_at: 0 };
            },
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async () => ({ analysis: "ok", media_type: "image", extraction: {} }),
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 1000,
      });

      await expect(tool.execute({ path: hugePath })).rejects.toThrow(/4 GiB/u);
      expect(sessions.length).toBe(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("AnalyzeMedia text envelope", () => {
  it("uses the Spanish-first ANÁLISIS header with EN parity, bilingual elementos, and truncates with notice", () => {
    const formatter = EnriVisionServer as unknown as {
      formatAnalysisText: (
        analysis: string,
        mediaType: string,
        elements: undefined,
      ) => string;
    };

    const headed: string = formatter.formatAnalysisText("hola", "image", undefined);
    expect(headed.startsWith("ANÁLISIS (image) / ANALYSIS (image):")).toBe(true);
    // EN parity: the English envelope survives as the second half.
    expect(headed).toContain("ANALYSIS (image):");

    const long: string = formatter.formatAnalysisText("x".repeat(40000), "video", undefined);
    expect(long).toMatch(/truncated text by size/u);
    expect(long).toMatch(/truncado/u);
    expect(long.length).toBeLessThan(40000);
  });
});
