/**
 * Tests for the analyze_media R3 audit fixes (D lane).
 *
 * Covers: proxy response validation (D-A1), clip clamp + warnings (D-A2),
 * served-type blanking (D-B1), flat knobs in the tool schema (D-B2),
 * cross-section tuning gates (D-B3), redirect coaching (D-B4), tar file
 * identity checks (D-B5), and client tuning coercion (D-C1).
 */
import { describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import type { MediaUrlFetchResult, MediaUrlFetcher as MediaUrlFetcherType } from "../src/shared/mediaUrlFetcher.js";
import { TarStream } from "../src/shared/tar.js";
import { describeFileIdentity } from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";

/**
 * Starts a temporary HTTP server with a mutable responder.
 */
async function startJsonServer(
  responder: () => { status: number; body: string }
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const next = responder();
    // Drain the request body before answering.
    req.resume();
    req.on("end", () => {
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/**
 * Creates an analyze_media tool with a stub upload client.
 */
function createStubTool(analyzeImpl?: (request: Record<string, unknown>) => Promise<unknown>): AnalyzeMediaTool {
  const calls: Array<Record<string, unknown>> = [];
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
          calls.push(request);
          if (analyzeImpl) {
            return analyzeImpl(request);
          }
          return { analysis: "ok", media_type: "image", extraction: {} };
        }
      }) as never,
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000
  });
  return tool;
}

describe("D-A1 proxy response validation", () => {
  it("rejects malformed 200 bodies in Spanish", async () => {
    let next: { status: number; body: string } = { status: 200, body: "{}" };
    const { server, baseUrl } = await startJsonServer(() => next);
    try {
      const client = new EnriProxyClient({ baseUrl, apiKey: "k", timeoutMs: 5000 });
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /respuesta del servidor es inválida.*analysis/
      );
      next = { status: 200, body: JSON.stringify({ analysis: 123, media_type: "video", extraction: {} }) };
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /respuesta del servidor es inválida.*analysis/
      );
      next = { status: 200, body: JSON.stringify({ analysis: "ok", extraction: {} }) };
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /respuesta del servidor es inválida.*media_type/
      );
      next = {
        status: 200,
        body: JSON.stringify({ analysis: "ok", media_type: "video", extraction: "nope" })
      };
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /respuesta del servidor es inválida.*extraction/
      );
      next = {
        status: 200,
        body: JSON.stringify({ analysis: "ok", media_type: "video", extraction: {}, elements: { label: 1 } })
      };
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /respuesta del servidor es inválida.*elements/
      );
    } finally {
      server.close();
    }
  });

  it("sanitizes malformed element boxes instead of throwing English TypeErrors", async () => {
    let next: { status: number; body: string } = {
      status: 200,
      body: JSON.stringify({
        analysis: "hay un botón",
        media_type: "image",
        extraction: {},
        elements: [
          { label: "botón", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
          { label: 123, box: { x: 0, y: 0, width: 1, height: 1 } },
          { label: "sin caja" },
          { label: "infinito", box: { x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1 } },
          "texto suelto"
        ]
      })
    };
    const { server, baseUrl } = await startJsonServer(() => next);
    try {
      const client = new EnriProxyClient({ baseUrl, apiKey: "k", timeoutMs: 5000 });
      const response = await client.analyze({ uploadId: "upload_1" });
      expect(response.analysis).toBe("hay un botón");
      expect(response.elements).toHaveLength(1);
      expect(response.elements?.[0]?.label).toBe("botón");
    } finally {
      server.close();
    }
  });
});

describe("D-A2 clip clamp with warnings", () => {
  it("clamps an overflowing window and warns in Spanish", () => {
    const tool = createStubTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      video: { clip_start_seconds: 86300, clip_duration_seconds: 200 }
    });
    expect(params.video?.clipStartSeconds).toBe(86300);
    expect(params.video?.clipDurationSeconds).toBe(100);
    expect(params.warnings).toHaveLength(1);
    expect(params.warnings?.[0]).toMatch(/recortó la duración a 100/);
  });

  it("still fails when the start is already at the limit", () => {
    const tool = createStubTool();
    expect(() =>
      tool.parseParams({
        path: "C:\\Users\\User\\Downloads\\clip.mp4",
        video: { clip_start_seconds: 86400, clip_duration_seconds: 200 }
      })
    ).toThrow(/baje el inicio/);
  });

  it("propagates parser warnings into the tool result", async () => {
    const tool = createStubTool();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-warnings-"));
    try {
      const videoPath = join(temporaryDirectory, "clip.mp4");
      await writeFile(videoPath, new Uint8Array([1, 2, 3, 4]));
      const result = await tool.execute({
        path: videoPath,
        video: { clipStartSeconds: 86300, clipDurationSeconds: 100 },
        warnings: ["La ventana pedida se recortó."]
      });
      expect(result.warnings).toEqual(["La ventana pedida se recortó."]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("renders warnings in the server text output", () => {
    const text = (
      EnriVisionServer as unknown as {
        formatAnalysisText(
          analysis: string,
          mediaType: string,
          elements: undefined,
          warnings: ReadonlyArray<string>
        ): string;
      }
    ).formatAnalysisText("análisis", "video", undefined, ["La ventana pedida se recortó."]);
    expect(text).toMatch(/avisos \/ warnings:/);
    expect(text).toMatch(/recortó/);
  });
});

describe("D-B1 served-type blanking", () => {
  it("blanks a disallowed served type rescued by the URL extension", async () => {
    const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fetchStub = (async (): Promise<Response> =>
      new Response(new Uint8Array(png), {
        status: 200,
        headers: { "content-type": "text/html" }
      })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
    const result = await fetcher.fetch("https://example.test/pics/shot.png");
    try {
      expect(result.contentType).toBe("");
      expect(result.localPath.endsWith(".png")).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  it("fails before upload when a download resolves to non-media", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-nonmedia-"));
    try {
      const binPath = join(temporaryDirectory, "payload.bin");
      await writeFile(binPath, new Uint8Array([1, 2, 3]));
      const stubFetcher = {
        fetch: vi.fn(async (): Promise<MediaUrlFetchResult> => ({
          localPath: binPath,
          contentType: "",
          extensionSynthesized: true,
          cleanup: vi.fn()
        }))
      } as unknown as MediaUrlFetcherType;
      // NOTE: the tool builds its upload client before resolving inputs, so
      // the stub client must work: the assertion is that resolution fails
      // before any upload session is created (no session recorded).
      const sessions: Array<unknown> = [];
      const tool = new AnalyzeMediaTool(
        {
          createClient: () =>
            ({
              createUploadSession: async (request: unknown) => {
                sessions.push(request);
                return { upload_id: "upload_1", chunk_size_bytes: 1024 * 1024, expires_at: Date.now() + 60_000 };
              },
              getUploadOffset: async () => 0,
              appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
                request.offset + request.chunk.length,
              analyze: async () => ({ analysis: "ok", media_type: "image", extraction: {} })
            }) as never,
          defaultServerUrl: "http://127.0.0.1:8787",
          defaultApiKey: "test",
          defaultTimeoutMs: 1000
        } as never,
        stubFetcher
      );
      await expect(tool.execute({ path: "https://example.test/files/payload" })).rejects.toThrow(
        /no sirvió un archivo de media válido/
      );
      expect(sessions).toHaveLength(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("D-B2 flat knobs in the tool schema", () => {
  it("publishes every accepted flat alias as a top-level property", () => {
    const server = new EnriVisionServer({
      name: "EnriVision",
      version: "0.0.0-test",
      analyzeMediaTool: {} as never
    });
    const definition = (
      server as unknown as {
        getAnalyzeMediaToolDefinition(): {
          readonly inputSchema: { readonly properties: Record<string, unknown> };
        };
      }
    ).getAnalyzeMediaToolDefinition();
    const properties = definition.inputSchema.properties;
    for (const flat of [
      "segmentSeconds",
      "segment_seconds",
      "maxSegments",
      "max_segments",
      "maxFramesPerSegment",
      "max_frames_per_segment",
      "audioTimestamps",
      "audio_timestamps",
      "documentMaxPages",
      "document_max_pages",
      "clipStartSeconds",
      "clip_start_seconds",
      "clipEndSeconds",
      "clip_end_seconds",
      "clipDurationSeconds",
      "clip_duration_seconds"
    ]) {
      expect(properties, `missing flat ${flat}`).toHaveProperty(flat);
    }
  });

  it("declares warnings in the output schema", () => {
    const server = new EnriVisionServer({
      name: "EnriVision",
      version: "0.0.0-test",
      analyzeMediaTool: {} as never
    });
    const definition = (
      server as unknown as {
        getAnalyzeMediaToolDefinition(): {
          readonly outputSchema: { readonly properties: Record<string, unknown> };
        };
      }
    ).getAnalyzeMediaToolDefinition();
    expect(definition.outputSchema.properties).toHaveProperty("warnings");
  });
});

describe("D-B3 cross-section scalar gates", () => {
  it("rejects video segment tuning on audio inputs", async () => {
    const tool = createStubTool();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-gate-"));
    try {
      const audioPath = join(temporaryDirectory, "nota.mp3");
      await writeFile(audioPath, new Uint8Array([1, 2, 3, 4]));
      await expect(
        tool.execute({ path: audioPath, video: { segmentSeconds: 60 } })
      ).rejects.toThrow(/video\.segment_seconds.*no aplica a audio/);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects audio segment tuning on video inputs", async () => {
    const tool = createStubTool();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-gate-"));
    try {
      const videoPath = join(temporaryDirectory, "clip.mp4");
      await writeFile(videoPath, new Uint8Array([1, 2, 3, 4]));
      await expect(
        tool.execute({ path: videoPath, audio: { maxSegments: 3 } })
      ).rejects.toThrow(/max_segments no aplica a video/);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("lets the shared-flat fan-out through (server applies the matching one)", async () => {
    const tool = createStubTool();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-gate-"));
    try {
      const videoPath = join(temporaryDirectory, "clip.mp4");
      await writeFile(videoPath, new Uint8Array([1, 2, 3, 4]));
      const result = await tool.execute({
        path: videoPath,
        video: { segmentSeconds: 60 },
        audio: { segmentSeconds: 60 }
      });
      expect(result.analysis).toBe("ok");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("D-B4 redirect exhaustion coaching", () => {
  it("reports an exhausted redirect chain in Spanish", async () => {
    let calls = 0;
    const fetchStub = (async (): Promise<Response> => {
      calls += 1;
      return new Response(new Uint8Array([1]), {
        status: 302,
        headers: { location: "https://example.test/hop" }
      });
    }) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
    await expect(fetcher.fetch("https://example.test/start.png")).rejects.toThrow(
      /excede el máximo de 5 redirecciones/
    );
    expect(calls).toBe(6);
  });

  it("coaches a redirect without Location instead of a bare HTTP 3xx", async () => {
    const fetchStub = (async (): Promise<Response> =>
      new Response(new Uint8Array([1]), { status: 301 })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
    await expect(fetcher.fetch("https://example.test/stuck.png")).rejects.toThrow(
      /no incluyó Location/
    );
  });
});

describe("D-B5 tar file identity checks", () => {
  it("streams when the opened handle matches the staged identity", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tar-"));
    try {
      const filePath = join(temporaryDirectory, "a.png");
      await writeFile(filePath, new Uint8Array([9, 8, 7, 6]));
      const fileStat = await stat(filePath);
      const tar = new TarStream(
        [
          {
            name: "000001.png",
            source: {
              type: "file",
              path: filePath,
              sizeBytes: fileStat.size,
              expectedIdentity: describeFileIdentity(fileStat)
            },
            mtimeSeconds: 0
          }
        ],
        { describeIdentity: describeFileIdentity }
      );
      const chunks: Buffer[] = [];
      for await (const chunk of tar.iterateChunks(0, 64 * 1024)) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      expect(body.length).toBe(tar.getSizeBytes());
      expect(body.includes(Buffer.from([9, 8, 7, 6]))).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("fails loudly on a same-size identity mismatch", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-tar-"));
    try {
      const filePath = join(temporaryDirectory, "a.png");
      await writeFile(filePath, new Uint8Array([9, 8, 7, 6]));
      const fileStat = await stat(filePath);
      const tar = new TarStream(
        [
          {
            name: "000001.png",
            source: {
              type: "file",
              path: filePath,
              sizeBytes: fileStat.size,
              expectedIdentity: "1:4:2:3:4"
            },
            mtimeSeconds: 0
          }
        ],
        { describeIdentity: describeFileIdentity }
      );
      await expect((async () => {
        for await (const chunk of tar.iterateChunks(0, 64 * 1024)) {
          void chunk;
        }
      })()).rejects.toThrow(/cambió mientras se subía/);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("D-C1 client tuning coercion", () => {
  it("coerces numeric/boolean strings instead of dropping them", async () => {
    const next: { status: number; body: string } = {
      status: 200,
      body: JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} })
    };
    const { server, baseUrl } = await startJsonServer(() => next);
    const requests: Array<Record<string, unknown>> = [];
    const capturing = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(next.body);
      });
    });
    await new Promise<void>((resolve) => {
      capturing.listen(0, "127.0.0.1", () => resolve());
    });
    const captureUrl = `http://127.0.0.1:${String((capturing.address() as AddressInfo).port)}`;
    try {
      const client = new EnriProxyClient({ baseUrl: captureUrl, apiKey: "k", timeoutMs: 5000 });
      await client.analyze({
        uploadId: "upload_1",
        maxFrames: "8" as unknown as number,
        transcribe: "false" as unknown as boolean,
        video: {
          segmentSeconds: "60" as unknown as number,
          maxSegments: "8" as unknown as number,
          maxFramesPerSegment: "4" as unknown as number
        },
        document: { maxPagesTotal: "150" as unknown as number },
        audio: { timestamps: "true" as unknown as boolean },
        images: { maxDimension: "1024" as unknown as number }
      });
      const payload = requests[0]!;
      expect(payload["max_frames"]).toBe(8);
      expect(payload["transcribe"]).toBe(false);
      expect((payload["video"] as Record<string, unknown>)["segment_seconds"]).toBe(60);
      expect((payload["video"] as Record<string, unknown>)["max_segments"]).toBe(8);
      expect((payload["video"] as Record<string, unknown>)["max_frames_per_segment"]).toBe(4);
      expect((payload["document"] as Record<string, unknown>)["max_pages_total"]).toBe(150);
      expect((payload["audio"] as Record<string, unknown>)["timestamps"]).toBe(true);
      expect((payload["images"] as Record<string, unknown>)["max_dimension"]).toBe(1024);
    } finally {
      capturing.close();
      server.close();
    }
  });

  it("throws in Spanish on garbage tunings instead of dropping them", async () => {
    const { server, baseUrl } = await startJsonServer(() => ({
      status: 200,
      body: JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} })
    }));
    try {
      const client = new EnriProxyClient({ baseUrl, apiKey: "k", timeoutMs: 5000 });
      await expect(
        client.analyze({ uploadId: "upload_1", video: { segmentSeconds: "abc" as unknown as number } })
      ).rejects.toThrow(/video\.segment_seconds debe ser un número/);
      await expect(
        client.analyze({ uploadId: "upload_1", maxFrames: "x" as unknown as number })
      ).rejects.toThrow(/max_frames debe ser un entero/);
      await expect(
        client.analyze({ uploadId: "upload_1", transcribe: "yes" as unknown as boolean })
      ).rejects.toThrow(/transcribe debe ser un booleano/);
    } finally {
      server.close();
    }
  });
});
