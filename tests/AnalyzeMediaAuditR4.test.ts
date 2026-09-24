import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

/**
 * Creates one tool instance with an unused client factory (parse-only tests).
 *
 * @returns Tool instance.
 */
function createParseTool(): AnalyzeMediaTool {
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
 * Creates one fetch stub serving the given bytes with the given headers.
 *
 * @param bytes - Payload served for every request.
 * @param headers - Response headers.
 * @returns Fetch-compatible function.
 */
function createFetchStub(bytes: Uint8Array, headers: Record<string, string>): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  }) as unknown as typeof fetch;
}

/**
 * Creates one resolver stub resolving hostnames to public test addresses.
 *
 * @returns Resolver function.
 */
function createPublicResolver(): (hostname: string) => Promise<readonly string[]> {
  return async (): Promise<readonly string[]> => ["93.184.216.34"];
}

describe("AnalyzeMedia R4 clip start synthesis (EV-B1)", () => {
  it("synthesizes clip_start_seconds 0 for end-only windows", () => {
    const tool = createParseTool();
    const params = tool.parseParams({
      path: abs("clip.mp4"),
      video: { clip_end_seconds: 60 },
    });

    expect(params.video?.clipStartSeconds).toBe(0);
    expect(params.video?.clipDurationSeconds).toBe(60);
  });

  it("synthesizes clip_start_seconds 0 for duration-only windows", () => {
    const tool = createParseTool();
    const params = tool.parseParams({
      path: abs("clip.mp4"),
      video: { clip_duration_seconds: 30 },
    });

    expect(params.video?.clipStartSeconds).toBe(0);
    expect(params.video?.clipDurationSeconds).toBe(30);
  });

  it("keeps the section absent when no clip knob exists", () => {
    const tool = createParseTool();
    const params = tool.parseParams({
      path: abs("clip.mp4"),
      video: { segment_seconds: 60 },
    });

    expect(params.video?.clipStartSeconds).toBeUndefined();
    expect(params.video?.clipDurationSeconds).toBeUndefined();
  });

  it("clamps start + duration windows ending past 86400 with a Spanish warning", () => {
    const tool = createParseTool();
    const base = abs("clip.mp4");

    // R3 parity arbitration: overflowing windows clamp to the 24 h range
    // (mirroring EnriCode and the proxy timeline trim) instead of failing.
    const nested = tool.parseParams({
      path: base,
      video: { clip_start_seconds: 80000, clip_duration_seconds: 10000 },
    });
    expect(nested.video?.clipStartSeconds).toBe(80000);
    expect(nested.video?.clipDurationSeconds).toBe(6400);
    expect(nested.warnings?.join(" ")).toMatch(/recortó la duración a 6400/u);

    const flat = tool.parseParams({
      path: base,
      clipStartSeconds: 86300,
      clipDurationSeconds: 200,
    });
    expect(flat.video?.clipStartSeconds).toBe(86300);
    expect(flat.video?.clipDurationSeconds).toBe(100);
    expect(flat.warnings?.join(" ")).toMatch(/recortó la duración a 100/u);
  });
});

describe("AnalyzeMedia R4 batch-over-total guards (EV-C2)", () => {
  it("rejects pages_per_batch above max_pages_total", () => {
    const tool = createParseTool();
    const base = abs("doc.pdf");

    expect(() =>
      tool.parseParams({ path: base, document: { max_pages_total: 10, pages_per_batch: 20 } }),
    ).toThrow(/pages_per_batch.*max_pages_total/u);
    expect(() =>
      tool.parseParams({ path: base, documentMaxPages: 5, document: { pages_per_batch: 6 } }),
    ).toThrow(/pages_per_batch.*max_pages_total/u);
  });

  it("accepts batches within the total", () => {
    const tool = createParseTool();
    const params = tool.parseParams({
      path: abs("doc.pdf"),
      document: { max_pages_total: 10, pages_per_batch: 10 },
    });

    expect(params.document?.pagesPerBatch).toBe(10);
  });

  it("rejects images_per_batch above max_images_total", () => {
    const tool = createParseTool();
    const base = abs("a.png");

    expect(() =>
      tool.parseParams({
        paths: [base],
        images: { max_images_total: 4, images_per_batch: 10 },
      }),
    ).toThrow(/images_per_batch.*max_images_total/u);
  });
});

describe("AnalyzeMedia R4 region unknown keys (EV-C1)", () => {
  it("rejects region typos instead of zooming the wrong area", () => {
    const tool = createParseTool();
    const base = abs("shot.png");

    expect(() =>
      tool.parseParams({
        path: base,
        region: { x: 0, y: 0, width: 0.5, height: 0.5, widh: 0.1 },
      }),
    ).toThrow(/desconocidas/u);
  });
});

describe("AnalyzeMedia R4 URL extension fallback (EV-B2)", () => {
  it("maps known media extensions through the canonical table", () => {
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/pics/foto.jpg")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/v/clip.mp4?token=abc")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/a/audio.ogg#t=3")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/d/doc.pdf")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/run/tool.exe")).toBe(false);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.test/download/file")).toBe(false);
  });

  it("accepts media served without content-type when the URL extension is known", async () => {
    const bytes: Uint8Array = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const fetcher = new MediaUrlFetcher(createFetchStub(bytes, {}), createPublicResolver());

    const result = await fetcher.fetch("https://example.test/pics/foto.jpg");

    expect(result.contentType).toBe("");
    expect(result.localPath.endsWith("foto.jpg")).toBe(true);
    await result.cleanup();
  });

  it("still rejects unknown payloads when both signals fail", async () => {
    const bytes: Uint8Array = new Uint8Array([1, 2, 3]);
    const fetcher = new MediaUrlFetcher(createFetchStub(bytes, {}), createPublicResolver());

    await expect(fetcher.fetch("https://example.test/download/file")).rejects.toThrow(
      /no sirvió un archivo de media válido/u,
    );
  });
});

describe("AnalyzeMedia R4 media-agnostic maxFrames (EV-B3)", () => {
  it("forwards top-level maxFrames on images without a mismatch error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r4-maxframes-"));
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

      const result = await tool.execute({ path: file, maxFrames: 5 });

      expect(sessions).toBe(1);
      expect(result.media_type).toBe("image");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("AnalyzeMedia R4 bounded extraction walk (EV-C4)", () => {
  it("bounds hostile deep nesting with a Spanish marker instead of overflowing", () => {
    const server = EnriVisionServer as unknown as {
      cutLongStrings(value: unknown, perString: number): unknown;
    };
    let leaf: unknown = "fin";
    for (let depth = 0; depth < 100; depth += 1) {
      leaf = { child: leaf };
    }

    const bounded = server.cutLongStrings(leaf, 16);

    expect(JSON.stringify(bounded)).toContain("omitido");
  });

  it("bounds hostile wide payloads past the node budget", () => {
    const server = EnriVisionServer as unknown as {
      cutLongStrings(value: unknown, perString: number): unknown;
    };
    const wide: ReadonlyArray<unknown> = Array.from(
      { length: 21000 },
      (_unused: unknown, index: number): unknown => ({ n: index }),
    );

    const bounded = server.cutLongStrings(wide, 16) as ReadonlyArray<unknown>;

    expect(Array.isArray(bounded)).toBe(true);
    expect(bounded.length).toBe(21000);
    expect(JSON.stringify(bounded.slice(0, 10))).toContain("\"n\":0");
    expect(JSON.stringify(bounded)).toContain("omitido");
  });

  it("keeps within-budget extractions by reference and cuts long strings head+tail", () => {
    const server = EnriVisionServer as unknown as {
      boundExtraction(extraction: Record<string, unknown>): Record<string, unknown>;
    };
    const small: Record<string, unknown> = { pages: 3 };

    expect(server.boundExtraction(small)).toBe(small);

    const big: Record<string, unknown> = { text: "x".repeat(600_000) };
    const bounded = server.boundExtraction(big);

    expect(bounded).not.toBe(big);
    expect(typeof bounded["text"]).toBe("string");
    expect(JSON.stringify(bounded)).toContain("truncado");
  });
});

describe("AnalyzeMedia R4 client clip synthesis (EV-B1)", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        server?.close(() => resolve());
      } catch {
        resolve();
      }
    });
    server = null;
  });

  /**
   * Starts one capture server returning a fixed analyze response.
   *
   * @param onBody - Body observer.
   * @returns Server instance and base URL.
   */
  const startCaptureServer = async (
    onBody: (body: Record<string, unknown>) => void,
  ): Promise<string> => {
    const instance = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      onBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
    });
    await new Promise<void>((resolve) => {
      instance.listen(0, "127.0.0.1", () => resolve());
    });
    server = instance;
    return `http://127.0.0.1:${String((instance.address() as AddressInfo).port)}`;
  };

  it("sends clip_start_seconds 0 for duration-only windows", async () => {
    let observed: Record<string, unknown> = {};
    const baseUrl = await startCaptureServer((body: Record<string, unknown>): void => {
      observed = body;
    });
    const client = new EnriProxyClient({ baseUrl, apiKey: "test-key", timeoutMs: 1000 });

    await client.analyze({ uploadId: "upload-123", video: { clipDurationSeconds: 30 } });

    const video = observed["video"] as Record<string, unknown>;
    expect(video["clip_start_seconds"]).toBe(0);
    expect(video["clip_duration_seconds"]).toBe(30);
  });

  it("clamps client windows ending past 86400 (parser warns on the tool path)", async () => {
    let observed: Record<string, unknown> = {};
    const baseUrl = await startCaptureServer((body: Record<string, unknown>): void => {
      observed = body;
    });
    const client = new EnriProxyClient({ baseUrl, apiKey: "test-key", timeoutMs: 1000 });

    // R3 parity arbitration: the direct-client backstop clamps like the
    // parser (the Spanish warning travels on the tool path, not here).
    await client.analyze({
      uploadId: "upload-123",
      video: { clipStartSeconds: 80000, clipDurationSeconds: 10000 },
    });
    const video = observed["video"] as Record<string, unknown>;
    expect(video["clip_start_seconds"]).toBe(80000);
    expect(video["clip_duration_seconds"]).toBe(6400);
  });
});
