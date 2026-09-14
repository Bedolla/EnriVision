import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import {
  describeFileIdentity,
  effectiveChunkSizeBytes,
  resolveChunkTimeoutMs,
  resolveUploadDeadlineMs,
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
 * Bounds one analysis through the private server helper.
 *
 * @param analysis - Raw analysis text.
 * @returns Bounded payload.
 */
function boundStructured(analysis: string): Record<string, unknown> {
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

describe("Audit R3 A1: success deletes the upload session", () => {
  it("calls deleteUploadSession on the success path with an independent signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r3-a1-"));
    try {
      const file = join(dir, "shot.png");
      await writeFile(file, Buffer.alloc(16, 7));
      const deleted: string[] = [];
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => ({
              upload_id: "upload_ok",
              chunk_size_bytes: 1024 * 1024,
              expires_at: Date.now() + 60_000,
            }),
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async () => ({ analysis: "ok", media_type: "image", extraction: {} }),
            deleteUploadSession: async (uploadId: string) => {
              deleted.push(uploadId);
            },
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 5000,
      });
      const result = await tool.execute({ path: file });
      expect(result.analysis).toBe("ok");
      expect(deleted).toEqual(["upload_ok"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Audit R3 A2: global upload deadline", () => {
  it("caps small files with headroom and large files at 20 min", () => {
    expect(resolveUploadDeadlineMs(0)).toBe(60_000);
    expect(resolveUploadDeadlineMs(125_000)).toBe(61_000);
    expect(resolveUploadDeadlineMs(4 * 1024 * 1024 * 1024)).toBe(20 * 60 * 1000);
  });
});

describe("Audit R3 B1: boolean strings", () => {
  it("accepts true/false strings for transcribe and audio.timestamps", () => {
    const tool = createTool();
    const base = "C:\\Users\\User\\Downloads\\clip.mp4";
    expect(tool.parseParams({ path: base, transcribe: "true" }).transcribe).toBe(true);
    expect(tool.parseParams({ path: base, transcribe: " False " }).transcribe).toBe(false);
    const audio = tool.parseParams({
      path: base,
      audio: { audioTimestamps: "true" },
    });
    expect(audio.audio?.timestamps).toBe(true);
    const audioSnake = tool.parseParams({
      path: base,
      audio: { audio_timestamps: "false" },
    });
    expect(audioSnake.audio?.timestamps).toBe(false);
  });
});

describe("Audit R3 B2: flat-wins precedence", () => {
  it("lets flat win and rejects differing nested without flat", () => {
    const tool = createTool();
    const base = "C:\\Users\\User\\Downloads\\clip.mp4";
    const won = tool.parseParams({
      path: base,
      segmentSeconds: 100,
      maxSegments: 11,
      video: { segment_seconds: 60, max_segments: 5 },
      audio: { segment_seconds: 45, max_segments: 6 },
    });
    expect(won.video?.segmentSeconds).toBe(100);
    expect(won.audio?.segmentSeconds).toBe(100);
    expect(won.video?.maxSegments).toBe(11);
    expect(won.audio?.maxSegments).toBe(11);
    expect(() =>
      tool.parseParams({
        path: base,
        video: { segment_seconds: 60 },
        audio: { segment_seconds: 45 },
      }),
    ).toThrow(/difieren sin un plano/u);
  });
});

describe("Audit R3 B3: nested spellings and no exponents", () => {
  it("accepts nested documentMaxPages and audioTimestamps, rejects 1e3", () => {
    const tool = createTool();
    const doc = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\a.pdf",
      document: { documentMaxPages: 33 },
    });
    expect(doc.document?.maxPagesTotal).toBe(33);
    expect(() =>
      tool.parseParams({
        path: "C:\\Users\\User\\Downloads\\clip.mp4",
        video: { segment_seconds: "1e3" },
      }),
    ).toThrow(/video\.segment_seconds/u);
  });
});

describe("Audit R3 B4: tuning-vs-contentType gates", () => {
  it("rejects video tuning for images before any upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r3-b4-"));
    try {
      const file = join(dir, "shot.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      let sessions = 0;
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => {
              sessions += 1;
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
      await expect(
        tool.execute({ path: file, video: { segmentSeconds: 60 } }),
      ).rejects.toThrow(/solo aplica a video/u);
      expect(sessions).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects document tuning for video before any upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r3-b4b-"));
    try {
      const file = join(dir, "clip.mp4");
      await writeFile(file, Buffer.alloc(32, 1));
      let sessions = 0;
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => {
              sessions += 1;
              return { upload_id: "upload_1", chunk_size_bytes: 1024, expires_at: 0 };
            },
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async () => ({ analysis: "ok", media_type: "video", extraction: {} }),
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 1000,
      });
      await expect(
        tool.execute({ path: file, document: { maxPagesTotal: 5 } }),
      ).rejects.toThrow(/document.*solo aplica/u);
      expect(sessions).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Audit R3 B5: structuredContent inline seam", () => {
  it("inserts a Spanish seam with head/tail/total counts within the budget", () => {
    const big = boundStructured("z".repeat(300000));
    const text = big["analysis"] as string;
    expect(big["analysis_truncated"]).toBe(true);
    // Head stays at the configured budget; the tail shrinks by exactly the
    // seam's code points so the whole string stays within the limit.
    expect(text).toMatch(/truncado: se muestran principio \(200000\) y fin \(\d+\) de 300000 caracteres/u);
    expect(Array.from(text).length).toBeLessThanOrEqual(ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars);
  });
});

describe("Audit R3 B6: full file identity", () => {
  it("distinguishes same-size files by mtime", () => {
    const left = { ino: 7, size: 64, mtimeMs: 1000, birthtimeMs: 500, nlink: 1 };
    const right = { ino: 7, size: 64, mtimeMs: 2000, birthtimeMs: 500, nlink: 1 };
    expect(describeFileIdentity(left)).not.toBe(describeFileIdentity(right));
  });
});

describe("Audit R3 B7: operator timeout caps, 30 s floor always wins", () => {
  it("returns max(30s, min(operator, derived)) with the 125000 B/s divisor", () => {
    expect(resolveChunkTimeoutMs(512, 5000)).toBe(30000);
    expect(resolveChunkTimeoutMs(8 * 1024 * 1024, 600000)).toBe(68000);
  });
});

describe("Audit R3 B8: server max_file_size_bytes fast-fail", () => {
  it("deletes the session and fails in Spanish when over the server ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r3-b8-"));
    try {
      const file = join(dir, "shot.png");
      await writeFile(file, Buffer.alloc(64, 3));
      const deleted: string[] = [];
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => ({
              upload_id: "upload_small",
              chunk_size_bytes: 1024,
              max_file_size_bytes: 8,
              expires_at: 0,
            }),
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async () => ({ analysis: "ok", media_type: "image", extraction: {} }),
            deleteUploadSession: async (uploadId: string) => {
              deleted.push(uploadId);
            },
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 1000,
      });
      await expect(tool.execute({ path: file })).rejects.toThrow(/tamaño máximo del servidor/u);
      expect(deleted).toEqual(["upload_small"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Audit R3 C1: 16 MiB chunk cap", () => {
  it("caps at 16 MiB and keeps the 4 KiB floor", () => {
    expect(ANALYZE_MEDIA_LIMITS.maxChunkBytes).toBe(16 * 1024 * 1024);
    expect(effectiveChunkSizeBytes(1024 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    expect(effectiveChunkSizeBytes(1024)).toBe(4096);
  });
});
