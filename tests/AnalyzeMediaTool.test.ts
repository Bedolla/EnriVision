import { describe, expect, it, vi } from "vitest";
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

import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import type { MediaUrlFetchResult, MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";

describe("AnalyzeMediaTool.parseParams", () => {
  it("rejects non-absolute paths", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    expect(() => tool.parseParams({ path: "relative.mp4" })).toThrow(/absoluta|absolute/i);
  });

  it("maps snake_case fields to params", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({
      path: abs("clip.mp4"),
      context: "video",
      question: "What is happening?",
      language: "es",
      max_frames: "7",
      transcribe: false,
      transcription_language: "auto",
      analysis_mode: "multipass",
      video: {
        clip_start_seconds: "12.5",
        clip_duration_seconds: "30",
        segment_seconds: "60",
        max_segments: "60",
        max_frames_per_segment: "8"
      },
      document: {
        max_pages_total: "150",
        pages_per_batch: "25",
        max_images_per_batch: "6",
        scanned_text_threshold_chars: "40"
      },
      audio: {
        timestamps: true,
        segment_seconds: "60",
        max_segments: "60"
      }
    });

    expect(params.path).toContain("clip.mp4");
    expect(params.context).toBe("video");
    expect(params.question).toBe("What is happening?");
    expect(params.language).toBe("es");
    expect(params.maxFrames).toBe(7);
    expect(params.transcribe).toBe(false);
    expect(params.transcriptionLanguage).toBe("auto");
    expect(params.analysisMode).toBe("multipass");
    expect(params.video?.clipStartSeconds).toBe(12.5);
    expect(params.video?.clipDurationSeconds).toBe(30);
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.video?.maxSegments).toBe(60);
    expect(params.video?.maxFramesPerSegment).toBe(8);
    expect(params.document?.maxPagesTotal).toBe(150);
    expect(params.document?.pagesPerBatch).toBe(25);
    expect(params.document?.maxImagesPerBatch).toBe(6);
    expect(params.document?.scannedTextThresholdChars).toBe(40);
    expect(params.audio?.timestamps).toBe(true);
    expect(params.audio?.segmentSeconds).toBe(60);
    expect(params.audio?.maxSegments).toBe(60);
  });

  it("accepts non-absolute paths when they are http(s) URLs", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({ path: "https://example.test/pic.png" });
    expect(params.path).toBe("https://example.test/pic.png");

    const multi = tool.parseParams({
      paths: ["https://example.test/a.png", abs("b.png")]
    });
    expect(multi.paths).toEqual(["https://example.test/a.png", abs("b.png")]);
  });

  it("rejects invalid analysis_mode values", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    expect(() =>
      tool.parseParams({
        path: abs("clip.mp4"),
        analysis_mode: "invalid"
      })
    ).toThrow(/analysis_mode/i);
  });

  it("accepts paths[] for multi-image analysis", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({
      paths: [abs("a.png"), abs("b.png")],
      language: "es",
      images: {
        max_images_total: "200",
        images_per_batch: "6",
        max_dimension: "2048"
      }
    });

    expect(params.paths?.length).toBe(2);
    expect(params.language).toBe("es");
    expect(params.images?.maxImagesTotal).toBe(200);
    expect(params.images?.imagesPerBatch).toBe(6);
    expect(params.images?.maxDimension).toBe(2048);
  });

  it("parses and validates relative image regions with echo coaching", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({
      path: abs("shot.png"),
      question: "¿qué dice el botón?",
      region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }
    });

    expect(params.region).toEqual({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 });

    expect(() =>
      tool.parseParams({
        path: abs("shot.png"),
        question: "q",
        region: { x: 1.5, y: 0, width: 0.5, height: 0.5 }
      })
    ).toThrow(/region\.x.*elements/u);

    expect(() =>
      tool.parseParams({
        path: abs("shot.png"),
        question: "q",
        region: { x: 0, y: 0, width: 0, height: 0.5 }
      })
    ).toThrow(/mayores que 0/u);

    const plain = tool.parseParams({ path: abs("shot.png"), question: "q" });
    expect(plain.region).toBeUndefined();
  });

  it("forwards region to the analyze call and returns elements", async () => {
    const analyzeCalls: Array<Record<string, unknown>> = [];
    const tool = new AnalyzeMediaTool({
      createClient: () =>
        ({
          createUploadSession: async () => ({
            upload_id: "upload_1",
            chunk_size_bytes: 1024 * 1024,
            expires_at: Date.now() + 60_000
          }),
          getUploadOffset: async () => 0,
          appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
            request.offset + request.chunk.length,
          analyze: async (request: Record<string, unknown>) => {
            analyzeCalls.push(request);
            return {
              analysis: "El botón dice 'Guardar cambios'.",
              elements: [
                { label: "botón Guardar cambios", box: { x: 0.5, y: 0.5, width: 0.25, height: 0.1 } }
              ],
              media_type: "image",
              extraction: { upload_id: "upload_1" }
            };
          }
        }) as never,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-region-"));
    try {
      const imagePath = join(temporaryDirectory, "shot.png");
      await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

      const result = await tool.execute({
        path: imagePath,
        question: "¿qué dice el botón?",
        region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }
      });

      expect(result.analysis).toBe("El botón dice 'Guardar cambios'.");
      expect(result.elements?.[0]?.label).toBe("botón Guardar cambios");
      expect(result.elements?.[0]?.box).toEqual({ x: 0.5, y: 0.5, width: 0.25, height: 0.1 });
      expect(analyzeCalls[0]?.["region"]).toEqual({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
      expect(result.extraction).not.toHaveProperty("upload_id");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("AnalyzeMediaTool output sanitization", () => {
  it("preserves server coverage metadata while stripping routing internals", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const rawExtraction = {
      filename: "A.mp4",
      content_type: "video/mp4",
      upload_id: "upload_123",
      detected_media_type: "video",
      analysis_mode_used: "multipass",
      multipass: {
        map: { models: ["Some-Internal-Model"] },
        reduce: { model: "Some-Internal-Model" }
      },
      timeline: { type: "video", duration_seconds: 90.37 },
      segment_summaries: [
        {
          start_seconds: 0,
          end_seconds: 60,
          summary: "ok"
        }
      ],
      nested: {
        model: "Some-Internal-Model"
      }
    };

    const sanitized = (tool as unknown as {
      stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
    }).stripInternalExtractionFields(rawExtraction as unknown as Record<string, unknown>);
    expect(sanitized).toHaveProperty("filename", "A.mp4");
    expect(sanitized).toHaveProperty("timeline");
    expect(sanitized).toHaveProperty("segment_summaries");
    expect(sanitized).not.toHaveProperty("upload_id");
    expect(sanitized).toHaveProperty("detected_media_type", "video");
    expect(sanitized).toHaveProperty("analysis_mode_used", "multipass");
    expect(sanitized).toHaveProperty("multipass");
    const multipass = (sanitized as Record<string, unknown>)["multipass"] as Record<string, unknown>;
    expect((multipass["reduce"] as Record<string, unknown>)["model"]).toBe("Some-Internal-Model");
    expect(sanitized).toHaveProperty("nested");
    const nested = (sanitized as Record<string, unknown>)["nested"];
    expect(nested).toBeTypeOf("object");
    expect(nested as Record<string, unknown>).toHaveProperty("model", "Some-Internal-Model");
  });
});

describe("AnalyzeMediaTool URL execution", () => {
  /**
   * Creates stub EnriProxy client deps recording upload session inputs.
   *
   * @param sessions - Mutable array receiving every created upload session.
   * @returns Deps bundle with a stub client factory.
   */
  function createStubDeps(
    sessions: Array<{ filename: string; contentType: string; sizeBytes: number }>
  ): {
    createClient: () => unknown;
    defaultServerUrl: string;
    defaultApiKey: string;
    defaultTimeoutMs: number;
  } {
    return {
      createClient: () =>
        ({
          createUploadSession: async (request: { filename: string; contentType: string; sizeBytes: number }) => {
            sessions.push({ filename: request.filename, contentType: request.contentType, sizeBytes: request.sizeBytes });
            return { upload_id: "upload_1", chunk_size_bytes: 1024 * 1024, expires_at: Date.now() + 60_000 };
          },
          getUploadOffset: async () => 0,
          appendUploadChunk: async (request: { offset: number; chunk: Buffer }) => request.offset + request.chunk.length,
          analyze: async () => ({ analysis: "ok", media_type: "image", extraction: { upload_id: "upload_1" } })
        }) as unknown as never,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    };
  }

  it("materializes a URL path, prefers the server content type for unknown extensions, and cleans up", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tool-"));
    const sessions: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
    const bytes = new Uint8Array([1, 2, 3, 4]);
    try {
      const downloadedPath = join(temporaryDirectory, "remote-media.bin");
      await writeFile(downloadedPath, bytes);
      const cleanup = vi.fn();

      const stubFetcher = {
        fetch: vi.fn(async (): Promise<MediaUrlFetchResult> => ({
          localPath: downloadedPath,
          contentType: "image/webp",
          extensionSynthesized: false,
          cleanup
        }))
      } as unknown as MediaUrlFetcher;

      const tool = new AnalyzeMediaTool(createStubDeps(sessions) as never, stubFetcher);
      const result = await tool.execute({ path: "https://example.test/media/remote-media" });

      expect(result.analysis).toBe("ok");
      expect(result.media_type).toBe("image");
      expect(result.extraction).not.toHaveProperty("upload_id");
      expect(stubFetcher.fetch).toHaveBeenCalledWith("https://example.test/media/remote-media", {
        signal: undefined
      });
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.filename).toBe("remote-media.bin");
      expect(sessions[0]?.contentType).toBe("image/webp");
      expect(sessions[0]?.sizeBytes).toBe(bytes.byteLength);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("prefers the server content type when the download extension was synthesized", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tool-"));
    const sessions: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    try {
      // Simulates a URL without extension serving webp: the fetcher
      // synthesized a generic `.png` name, which must not win over webp.
      const downloadedPath = join(temporaryDirectory, "media.png");
      await writeFile(downloadedPath, bytes);
      const cleanup = vi.fn();

      const stubFetcher = {
        fetch: vi.fn(async (): Promise<MediaUrlFetchResult> => ({
          localPath: downloadedPath,
          contentType: "image/webp",
          extensionSynthesized: true,
          cleanup
        }))
      } as unknown as MediaUrlFetcher;

      const tool = new AnalyzeMediaTool(createStubDeps(sessions) as never, stubFetcher);
      const result = await tool.execute({ path: "https://example.test/media/photo" });

      expect(result.analysis).toBe("ok");
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.contentType).toBe("image/webp");
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("materializes multiple URL paths and cleans up every download", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tool-"));
    const sessions: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
    try {
      const cleanups = [vi.fn(), vi.fn()];
      const downloadedPaths = [join(temporaryDirectory, "1.png"), join(temporaryDirectory, "2.png")];
      await writeFile(downloadedPaths[0]!, new Uint8Array([1]));
      await writeFile(downloadedPaths[1]!, new Uint8Array([2]));

      let callIndex = 0;
      const stubFetcher = {
        fetch: vi.fn(async (): Promise<MediaUrlFetchResult> => {
          const index = callIndex;
          callIndex += 1;
          return {
            localPath: downloadedPaths[index]!,
            contentType: "image/png",
            extensionSynthesized: false,
            cleanup: cleanups[index]!
          };
        })
      } as unknown as MediaUrlFetcher;

      const tool = new AnalyzeMediaTool(createStubDeps(sessions) as never, stubFetcher);
      const result = await tool.execute({
        paths: ["https://example.test/a.png", "https://example.test/b.png"],
        images: { imagesPerBatch: 2 }
      });

      expect(result.media_type).toBe("image");
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.filename).toBe("enrivision-image-set.tar");
      expect(sessions[0]?.contentType).toBe("application/vnd.enrivision.media-set+tar");
      expect(cleanups[0]).toHaveBeenCalledTimes(1);
      expect(cleanups[1]).toHaveBeenCalledTimes(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("AnalyzeMediaTool knob validation", () => {
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
      defaultTimeoutMs: 1000
    });
  }

  it("rejects out-of-range knobs with Spanish errors", () => {
    const tool = createTool();
    const base = abs("clip.mp4");

    expect(() => tool.parseParams({ path: base, max_frames: 0 })).toThrow(/max_frames.*1.*20/u);
    expect(() => tool.parseParams({ path: base, max_frames: 21 })).toThrow(/max_frames.*1.*20/u);
    expect(() => tool.parseParams({ path: base, max_frames: "abc" })).toThrow(/max_frames.*1.*20/u);
    expect(() =>
      tool.parseParams({ path: base, video: { segment_seconds: 4 } })
    ).toThrow(/video\.segment_seconds.*5.*600/u);
    expect(() =>
      tool.parseParams({ path: base, video: { segment_seconds: 601 } })
    ).toThrow(/video\.segment_seconds.*5.*600/u);
    expect(() =>
      tool.parseParams({ path: base, video: { max_segments: 0 } })
    ).toThrow(/video\.max_segments.*1.*60/u);
    expect(() =>
      tool.parseParams({ path: base, video: { max_frames_per_segment: 21 } })
    ).toThrow(/video\.max_frames_per_segment.*1.*20/u);
    expect(() =>
      tool.parseParams({ path: base, video: { clip_duration_seconds: -5 } })
    ).toThrow(/video\.clip_duration_seconds.*mayor que 0/u);
    expect(() =>
      tool.parseParams({ path: base, document: { max_pages_total: 2001 } })
    ).toThrow(/document\.max_pages_total.*1.*200/u);
    expect(() =>
      tool.parseParams({ path: base, audio: { segment_seconds: 1 } })
    ).toThrow(/audio\.segment_seconds.*5.*600/u);
    expect(() =>
      tool.parseParams({ path: base, audio: { max_segments: 2001 } })
    ).toThrow(/audio\.max_segments.*1.*60/u);
    expect(() =>
      tool.parseParams({ path: base, audio: { timestamps: "yes" } })
    ).toThrow(/audio\.timestamps.*booleano/u);
  });

  it("accepts boundary knob values", () => {
    const tool = createTool();
    const params = tool.parseParams({
      path: abs("clip.mp4"),
      max_frames: 20,
      video: {
        clip_start_seconds: 0,
        clip_duration_seconds: 0.5,
        segment_seconds: 5,
        max_segments: 60,
        max_frames_per_segment: 1
      },
      document: { max_pages_total: 1 },
      audio: { segment_seconds: 5, max_segments: 60 }
    });

    expect(params.maxFrames).toBe(20);
    expect(params.video?.segmentSeconds).toBe(5);
    expect(params.video?.maxSegments).toBe(60);
    expect(params.video?.maxFramesPerSegment).toBe(1);
    expect(params.document?.maxPagesTotal).toBe(1);
    expect(params.audio?.segmentSeconds).toBe(5);
  });
});

describe("AnalyzeMediaTool cancellation", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const createClient = vi.fn(() => {
      throw new Error("must not be called");
    });
    const tool = new AnalyzeMediaTool({
      createClient: createClient as never,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute({ path: abs("clip.mp4") }, { signal: controller.signal })
    ).rejects.toThrow(/cancelada/u);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("forwards the signal to URL downloads and the analyze call", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tool-"));
    try {
      const downloadedPath = join(temporaryDirectory, "shot.png");
      await writeFile(downloadedPath, new Uint8Array([1, 2, 3]));

      const seenSignals: Array<AbortSignal | undefined> = [];
      const stubFetcher = {
        fetch: vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => {
          seenSignals.push(options?.signal);
          return {
            localPath: downloadedPath,
            contentType: "image/png",
            extensionSynthesized: false,
            cleanup: vi.fn()
          };
        })
      } as unknown as MediaUrlFetcher;

      let analyzeSignal: AbortSignal | undefined | null = null;
      const tool = new AnalyzeMediaTool(
        {
          createClient: () =>
            ({
              createUploadSession: async () => ({
                upload_id: "upload_1",
                chunk_size_bytes: 1024 * 1024,
                expires_at: Date.now() + 60_000
              }),
              getUploadOffset: async () => 0,
              appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
                request.offset + request.chunk.length,
              analyze: async (request: { signal?: AbortSignal }) => {
                analyzeSignal = request.signal ?? null;
                return { analysis: "ok", media_type: "image", extraction: {} };
              }
            }) as never,
          defaultServerUrl: "http://127.0.0.1:8787",
          defaultApiKey: "test",
          defaultTimeoutMs: 1000
        },
        stubFetcher
      );

      const controller = new AbortController();
      const result = await tool.execute(
        { path: "https://example.test/shot" },
        { signal: controller.signal }
      );

      expect(result.analysis).toBe("ok");
      expect(seenSignals[0]).toBe(controller.signal);
      expect(analyzeSignal).toBe(controller.signal);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
