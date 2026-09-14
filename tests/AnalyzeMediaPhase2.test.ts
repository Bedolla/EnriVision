/**
 * Tests for EnriVision analyze_media Phase 2 polish fixes (C1, C3-C7, C9,
 * C11-C14, C16 + net5).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import {
  assertNoForwardGap,
  resolveChunkTimeoutMs,
  UploadProgressLogger,
  type AnalyzeMediaResumableUploader,
} from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaResumableUploader as UploaderImpl } from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTarPackager } from "../src/tools/AnalyzeMediaTarPackager.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { resolveTimeoutMs } from "../src/shared/validation.js";

/**
 * Starts a temporary HTTP server.
 *
 * @param handler - Request handler.
 * @returns Server instance and base URL.
 */
async function startServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ readonly server: Server; readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, urls };
}

let server: Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["ENRIVISION_QUIET"];
  if (server) {
    const current = server;
    server = null;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
  }
});

describe("Forward offset gaps fail fast (C1/net5)", () => {
  it("rejects forward jumps and accepts exact or backward offsets", () => {
    expect(() => assertNoForwardGap(10, 0, 10)).not.toThrow();
    expect(() => assertNoForwardGap(4, 10, 10)).not.toThrow();
    expect(() => assertNoForwardGap(17, 0, 10)).toThrow(/adelantado/u);
  });

  it("fails single-file uploads when the server skips unsent bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-fwd-"));
    try {
      const file = join(dir, "a.bin");
      await writeFile(file, Buffer.alloc(64, 0x61));
      const uploader: AnalyzeMediaResumableUploader = new UploaderImpl();
      const fake = {
        getUploadOffset: async () => 0,
        appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
          request.offset + request.chunk.length + 7,
      } as never;
      await expect(
        uploader.uploadFileResumable(
          fake,
          file,
          64,
          { upload_id: "upload_1", chunk_size_bytes: 1024 } as never,
          1000,
        ),
      ).rejects.toThrow(/adelantado/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails tar uploads when the server skips unsent bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-fwdtar-"));
    try {
      const first = join(dir, "a.png");
      const second = join(dir, "b.png");
      await writeFile(first, Buffer.alloc(32, 0x61));
      await writeFile(second, Buffer.alloc(32, 0x62));
      const packager = new AnalyzeMediaTarPackager(new UploaderImpl());
      const fake = {
        createUploadSession: async () => ({ upload_id: "upload_9", chunk_size_bytes: 1024 }),
        getUploadOffset: async () => 0,
        appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
          request.offset + request.chunk.length + 100,
      } as never;
      await expect(
        packager.uploadImageSetAsMediaSetTar(
          fake,
          [
            { localPath: first, filename: "a.png", sizeBytes: 32, contentType: "image/png" },
            { localPath: second, filename: "b.png", sizeBytes: 32, contentType: "image/png" },
          ],
          1000,
          "trace-fwd",
        ),
      ).rejects.toThrow(/adelantado/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Client-side region validation (C3)", () => {
  /**
   * Creates a client that never reaches the network (validation throws first).
   *
   * @returns Client instance.
   */
  function createClient(): EnriProxyClient {
    return new EnriProxyClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k", timeoutMs: 500 });
  }

  it("rejects out-of-range region fractions in Spanish", async () => {
    await expect(
      createClient().analyze({ uploadId: "u", region: { x: 2, y: 0, width: 0.1, height: 0.1 } }),
    ).rejects.toThrow(/region\.x/u);
  });

  it("rejects regions overflowing the image", async () => {
    await expect(
      createClient().analyze({ uploadId: "u", region: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }),
    ).rejects.toThrow(/caber/u);
  });

  it("rejects zero-size regions in Spanish", async () => {
    await expect(
      createClient().analyze({ uploadId: "u", region: { x: 0, y: 0, width: 0, height: 0.5 } }),
    ).rejects.toThrow(/mayores que 0/u);
  });
});

describe("Strict Upload-Offset parsing (C4)", () => {
  it("rejects prefix-numeric offsets instead of resuming wrong", async () => {
    const started = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Upload-Offset", "12abc");
      res.end();
    });
    server = started.server;
    const client = new EnriProxyClient({ baseUrl: started.baseUrl, apiKey: "k", timeoutMs: 1000 });
    await expect(client.getUploadOffset("upload-1")).rejects.toThrow(/Upload-Offset inválido/u);
  });

  it("accepts padded numeric offsets", async () => {
    const started = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Upload-Offset", " 7 ");
      res.end();
    });
    server = started.server;
    const client = new EnriProxyClient({ baseUrl: started.baseUrl, apiKey: "k", timeoutMs: 1000 });
    await expect(client.getUploadOffset("upload-1")).resolves.toBe(7);
  });
});

describe("Base subpath preservation (C5)", () => {
  it("keeps the base subpath when building endpoint URLs", async () => {
    const started = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ upload_id: "upload_1", chunk_size_bytes: 1024 }));
    });
    server = started.server;
    const client = new EnriProxyClient({
      baseUrl: `${started.baseUrl}/proxy`,
      apiKey: "k",
      timeoutMs: 1000,
    });
    await client.createUploadSession({ filename: "a.png", sizeBytes: 10, contentType: "image/png" });
    expect(started.urls).toEqual(["/proxy/v1/uploads"]);
  });
});

describe("Strict string knobs (C6)", () => {
  const parser = new AnalyzeMediaParamParser();

  it("fails in Spanish when language/context/question exist without strings", () => {
    expect(() => parser.parseParams({ path: "/tmp/x.mp4", language: 5 })).toThrow(/language/u);
    expect(() => parser.parseParams({ path: "/tmp/x.mp4", context: {} })).toThrow(/context/u);
    expect(() => parser.parseParams({ path: "/tmp/x.mp4", question: ["q"] })).toThrow(/question/u);
    expect(() =>
      parser.parseParams({ path: "/tmp/x.mp4", transcription_language: 42 }),
    ).toThrow(/transcription_language/u);
  });

  it("still accepts absent or blank string knobs", () => {
    expect(parser.parseParams({ path: "/tmp/x.mp4" }).language).toBeUndefined();
    expect(parser.parseParams({ path: "/tmp/x.mp4", question: "  " }).question).toBeUndefined();
  });
});

describe("Local region rejection for non-images (C7)", () => {
  it("fails before creating any upload session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-region-"));
    try {
      const audio = join(dir, "clip.mp3");
      await writeFile(audio, Buffer.alloc(128, 0x61));
      let sessions = 0;
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => {
              sessions += 1;
              return { upload_id: "upload_1", chunk_size_bytes: 1024 };
            },
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async () => ({ analysis: "ok", media_type: "audio", extraction: {} }),
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 1000,
      });
      await expect(
        tool.execute({ path: audio, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }),
      ).rejects.toThrow(/sólo aplica a imágenes/u);
      expect(sessions).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Strict timeout env parsing (C9)", () => {
  it("accepts empty or clean values and warns on garbage", () => {
    expect(resolveTimeoutMs("", "ENRIVISION_TIMEOUT_MS", 100)).toEqual({
      timeoutMs: 100,
      warning: null,
    });
    expect(resolveTimeoutMs("5000", "ENRIVISION_TIMEOUT_MS", 100)).toEqual({
      timeoutMs: 5000,
      warning: null,
    });
    const dirty = resolveTimeoutMs("30s", "ENRIVISION_TIMEOUT_MS", 100);
    expect(dirty.timeoutMs).toBe(100);
    expect(dirty.warning).toMatch(/inválido/u);
    expect(resolveTimeoutMs("0", "ENRIVISION_TIMEOUT_MS", 100).warning).toMatch(/inválido/u);
  });
});

describe("Bounded text envelope and extraction (C11)", () => {
  const peer = EnriVisionServer as unknown as {
    formatAnalysisText(analysis: string, mediaType: string, elements: undefined): string;
    boundStructuredContent(result: {
      readonly analysis: string;
      readonly media_type: string;
      readonly extraction: Record<string, unknown>;
    }): Record<string, unknown>;
  };

  it("keeps head and tail with a Spanish notice", () => {
    const analysis = `INICIO-${"a".repeat(20000)}-MITAD-${"b".repeat(20000)}-FINAL`;
    const text = peer.formatAnalysisText(analysis, "video", undefined);
    expect(text).toContain("INICIO-");
    expect(text).toContain("-FINAL");
    expect(text).toMatch(/principio.*fin/u);
    expect(text.length).toBeLessThan(analysis.length);
  });

  it("caps huge extractions preserving shape and passes small ones through", () => {
    const small: Record<string, unknown> = { timeline: { duration_seconds: 3 } };
    const boundedSmall = peer.boundStructuredContent({
      analysis: "ok",
      media_type: "video",
      extraction: small,
    });
    expect(boundedSmall["extraction"]).toBe(small);
    expect(boundedSmall).not.toHaveProperty("analysis_truncated");

    const boundedBig = peer.boundStructuredContent({
      analysis: "ok",
      media_type: "video",
      extraction: { blob: "z".repeat(600000), keep: 1 },
    });
    const extraction = boundedBig["extraction"] as Record<string, unknown>;
    expect(extraction).toHaveProperty("blob");
    expect(extraction).toHaveProperty("keep");
    expect(String(extraction["blob"])).toMatch(/truncado/u);
    expect(String(extraction["blob"]).length).toBeLessThan(600000);
  });
});

describe("Single-file size revalidation (C12)", () => {
  it("fails when the file changed between resolve and upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-restat-"));
    try {
      const file = join(dir, "a.bin");
      await writeFile(file, Buffer.alloc(100, 0x61));
      const uploader: AnalyzeMediaResumableUploader = new UploaderImpl();
      const fake = {
        getUploadOffset: async () => 0,
        appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
          request.offset + request.chunk.length,
      } as never;
      await expect(
        uploader.uploadFileResumable(
          fake,
          file,
          90,
          { upload_id: "upload_1", chunk_size_bytes: 1024 } as never,
          1000,
        ),
      ).rejects.toThrow(/cambió/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Shared upload progress logger (C13)", () => {
  it("reports 10% steps and honors quiet mode", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    const logger = new UploadProgressLogger(100);
    logger.report(10);
    logger.report(15);
    logger.report(100);
    expect(errors.length).toBe(2);
    expect(errors[0]).toMatch(/10%/u);
    expect(errors[1]).toMatch(/100%/u);
    spy.mockRestore();
  });

  it("stays silent when ENRIVISION_QUIET=1", () => {
    process.env["ENRIVISION_QUIET"] = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    new UploadProgressLogger(100).report(50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("Schema item hints and chunk floor (C14/C16)", () => {
  it("documents every paths entry with size and SSRF bounds", () => {
    const serverInstance = new EnriVisionServer({
      name: "EnriVision",
      version: "0.0.0-test",
      analyzeMediaTool: {} as never,
    });
    const definition = (
      serverInstance as unknown as {
        getAnalyzeMediaToolDefinition(): {
          readonly inputSchema: {
            readonly properties: Record<string, { readonly items?: { readonly description?: string } }>;
          };
        };
      }
    ).getAnalyzeMediaToolDefinition();
    const items = definition.inputSchema.properties["paths"]?.items;
    expect(items?.description).toMatch(/64 MiB/u);
    expect(items?.description).toMatch(/privadas/u);
  });

  it("floors chunk timeouts at 30 s even under a smaller operator timeout", () => {
    expect(resolveChunkTimeoutMs(512, 5000)).toBe(30000);
  });
});
