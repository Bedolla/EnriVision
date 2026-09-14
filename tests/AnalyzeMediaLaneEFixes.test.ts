import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { EnriProxyHttpError } from "../src/client/EnriProxyClientContract.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { truncateCodePointsHead, truncateCodePointsHeadTail } from "../src/shared/codepointTruncation.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { AnalyzeMediaExtractionSanitizer } from "../src/tools/AnalyzeMediaExtractionSanitizer.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import {
  retryAfterDelayMs,
  AnalyzeMediaResumableUploader,
} from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

/**
 * Absolute fixture path for the current platform.
 *
 * @param name - File name.
 * @returns Absolute path.
 */
function absFixture(name: string): string {
  return join(tmpdir(), name);
}

describe("Sanitizer secret and internal keys (laneE-A2)", () => {
  const sanitizer = new AnalyzeMediaExtractionSanitizer();

  it("strips prefixed secrets, bearer material, and internal routing ids", () => {
    const out = sanitizer.sanitize({
      client_secret: "shh",
      my_api_key: "key",
      authorization: "Bearer abc",
      session_id: "s",
      client_trace_id: "enrivision_x",
      upload_url: "http://x",
      nested: { trace_id: "t", user_password_hash: "h" },
      token_usage: { total: 3 },
      detected_media_type: "image",
    });
    expect(out).not.toHaveProperty("client_secret");
    expect(out).not.toHaveProperty("my_api_key");
    expect(out).not.toHaveProperty("authorization");
    expect(out).not.toHaveProperty("session_id");
    expect(out).not.toHaveProperty("client_trace_id");
    expect(out).not.toHaveProperty("upload_url");
    expect((out["nested"] as Record<string, unknown>)["trace_id"]).toBeUndefined();
    expect((out["nested"] as Record<string, unknown>)["user_password_hash"]).toBeUndefined();
    expect(out).toHaveProperty("token_usage");
    expect(out).toHaveProperty("detected_media_type");
  });
});

describe("Param parser strictness (laneE-B1/B2/B3/B10)", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = absFixture("lanee.png");

  it("rejects unknown top-level keys listing the valid keys", () => {
    expect(() => parser.parseParams({ path: img, max_frams: 5 })).toThrow(/desconocidas.*max_frames/iu);
  });

  it("rejects present non-string path with a type error", () => {
    for (const bad of [123, {}, null, true]) {
      expect(() => parser.parseParams({ path: bad })).toThrow(/path debe ser/iu);
    }
  });

  it("rejects non-string paths items with the offending index", () => {
    expect(() => parser.parseParams({ paths: [img, 123 as unknown as string] })).toThrow(/paths\[1\]/);
    expect(() => parser.parseParams({ paths: [null as unknown as string] })).toThrow(/paths\[0\]/);
  });

  it("still discards blank string entries", () => {
    const params = parser.parseParams({ paths: ["   ", img] });
    expect(params.paths).toEqual([img]);
  });

  it("allows region with a single-entry paths (B10)", () => {
    const params = parser.parseParams({
      paths: [img],
      question: "q",
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expect(params.region?.width).toBe(0.5);
  });

  it("still rejects region with multi-entry paths", () => {
    expect(() =>
      parser.parseParams({
        paths: [img, absFixture("lanee-b.png")],
        region: { x: 0, y: 0, width: 0.5, height: 0.5 },
      })
    ).toThrow(/una imagen individual/iu);
  });
});

describe("Flat segment knobs fan-out contract (laneE-B4)", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = absFixture("lanee.png");

  it("fans out to both sections when neither is explicit", () => {
    const params = parser.parseParams({ path: img, segmentSeconds: 60 });
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.audio?.segmentSeconds).toBe(60);
  });

  it("applies to the only explicit section", () => {
    const videoOnly = parser.parseParams({ path: img, segmentSeconds: 60, video: { max_segments: 2 } });
    expect(videoOnly.video?.segmentSeconds).toBe(60);
    expect(videoOnly.audio).toBeUndefined();
    const audioOnly = parser.parseParams({ path: img, maxSegments: 3, audio: { timestamps: true } });
    expect(audioOnly.audio?.maxSegments).toBe(3);
    expect(audioOnly.video).toBeUndefined();
  });

  it("lets flats win with both sections explicit (EnriCode parity R3)", () => {
    const params = parser.parseParams({ path: img, segmentSeconds: 60, video: {}, audio: {} });
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.audio?.segmentSeconds).toBe(60);
  });

  it("rejects differing nested values without a flat winner", () => {
    expect(() =>
      parser.parseParams({ path: img, video: { segment_seconds: 60 }, audio: { segment_seconds: 45 } })
    ).toThrow(/difieren sin un plano/iu);
  });
});

describe("Uploader 409 and Retry-After (laneE-B8/B9)", () => {
  it("probes the offset once on same-offset 409 then fails fast", async () => {
    const uploader = new AnalyzeMediaResumableUploader();
    let probes = 0;
    const client = {
      appendUploadChunk: async (): Promise<number> => {
        throw new EnriProxyHttpError("conflict", 409, {}, "");
      },
      getUploadOffset: async (): Promise<number> => {
        probes += 1;
        return 0;
      },
    };
    await expect(
      uploader.uploadChunkWithRetry(client as never, "u", 0, Buffer.from([1]), 1000, undefined)
    ).rejects.toThrow(/sin avanzar el offset/iu);
    expect(probes).toBe(1);
  });

  it("reads Retry-After in any capitalization", () => {
    expect(retryAfterDelayMs(new EnriProxyHttpError("slow", 429, { "RETRY-AFTER": "2" }, ""))).toBe(2000);
    expect(retryAfterDelayMs(new EnriProxyHttpError("slow", 429, { "Retry-After": "1" }, ""))).toBe(1000);
    expect(retryAfterDelayMs(new EnriProxyHttpError("slow", 429, { "retry-after": "1" }, ""))).toBe(1000);
  });
});

describe("Input resolver fail-fast (laneE-B5/B14/C6)", () => {
  it("rejects local non-media files before any upload", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "lanee-resolver-"));
    try {
      const exe: string = join(dir, "setup.exe");
      await writeFile(exe, new Uint8Array([1, 2, 3]));
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      await expect(resolver.resolve({ path: exe })).rejects.toThrow(/no es media analizable/iu);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps missing files to Archivo no encontrado", async () => {
    const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
    await expect(
      resolver.resolve({ path: join(tmpdir(), "lanee-definitivamente-ausente.bin") })
    ).rejects.toThrow(/Archivo no encontrado/);
  });

  it("fails an image set on the first non-image entry without downloading the rest", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "lanee-set-"));
    try {
      const video: string = join(dir, "clip.mp4");
      const image: string = join(dir, "shot.png");
      await writeFile(video, new Uint8Array([1]));
      await writeFile(image, new Uint8Array([2]));
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      await expect(resolver.resolve({ paths: [video, image] })).rejects.toThrow(/sólo archivos de imagen/iu);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Fetcher fragment and SSRF ranges (laneE-B13/C5)", () => {
  const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);

  it("strips the URL fragment before deriving the file name", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchImpl, async () => ["93.184.216.34"]);
    const result = await fetcher.fetch("https://example.test/foto.png#seccion");
    expect(result.localPath.endsWith("foto.png")).toBe(true);
    await result.cleanup();
  });

  it("blocks CGNAT, benchmark, IETF, and IPv6 multicast ranges", async () => {
    for (const address of ["100.64.0.1", "198.19.0.1", "192.0.0.1", "ff02::1"]) {
      const fetcher = new MediaUrlFetcher(
        (async (): Promise<Response> => new Response(null, { status: 500 })) as unknown as typeof fetch,
        async () => [address]
      );
      await expect(fetcher.fetch("https://example.test/x.png")).rejects.toThrow(/bloqueado/iu);
    }
  });

  it("keeps documentation TEST-NET ranges allowed", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchImpl, async () => ["192.0.2.1"]);
    const result = await fetcher.fetch("https://example.test/x.png");
    await result.cleanup();
  });
});

describe("Single-pass code-point truncation (laneE-A3)", () => {
  it("matches Array.from semantics on emoji with head and tail", () => {
    const text: string = `a😀b${"x".repeat(100)}c😀d`;
    const cut = truncateCodePointsHeadTail(text, 3, 3);
    const points: string[] = Array.from(text);
    expect(cut.totalChars).toBe(points.length);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe(`${points.slice(0, 3).join("")}${points.slice(points.length - 3).join("")}`);
    expect(cut.head + cut.tail).toBe(cut.text);
  });

  it("passes small inputs through untouched", () => {
    const cut = truncateCodePointsHead("abc", 10);
    expect(cut.truncated).toBe(false);
    expect(cut.text).toBe("abc");
    expect(cut.totalChars).toBe(3);
  });
});

describe("Server schema publishes model and aliases (laneE-B6/B7/C3)", () => {
  interface ToolDefinitionReader {
    getAnalyzeMediaToolDefinition(): {
      readonly description: string;
      readonly inputSchema: { readonly properties: Record<string, unknown> };
      readonly outputSchema: { readonly properties: Record<string, { readonly description?: string }> };
    };
  }

  it("exposes model plus alias and truncation notes", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
    });
    const server = new EnriVisionServer({ name: "t", version: "0", analyzeMediaTool: tool });
    const definition = (server as unknown as ToolDefinitionReader).getAnalyzeMediaToolDefinition();
    expect(definition.inputSchema.properties).toHaveProperty("model");
    expect(definition.description).toMatch(/ENRIVISION_MODEL/);
    const video = definition.inputSchema.properties["video"] as { readonly description?: string };
    expect(video.description).toMatch(/camelCase/);
    const extraction = definition.outputSchema.properties["extraction"];
    expect(extraction?.description).toMatch(/truncado/iu);
  });
});

describe("Client region coercion (laneE-C1)", () => {
  it("coerces complete numeric strings like the parser", () => {
    const checked = (EnriProxyClient as unknown as {
      requireValidRegion(region: unknown): { readonly x: number };
    }).requireValidRegion({ x: "0.1", y: 0, width: 0.5, height: 0.5 });
    expect(checked.x).toBeCloseTo(0.1);
  });

  it("still rejects partial numerics", () => {
    const call = (): unknown =>
      (EnriProxyClient as unknown as { requireValidRegion(region: unknown): unknown }).requireValidRegion({
        x: "0.1x",
        y: 0,
        width: 0.5,
        height: 0.5,
      });
    expect(call).toThrow(/region\.x/);
  });
});

describe("Tool temp cleanup and frozen boxes (laneE-A1/C8)", () => {
  it("cleans materialized downloads when region is rejected", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "lanee-a1-"));
    let cleanups = 0;
    try {
      const video: string = join(dir, "clip.mp4");
      await writeFile(video, new Uint8Array([1, 2, 3]));
      const fakeFetcher = {
        fetch: async (): Promise<unknown> => ({
          localPath: video,
          contentType: "video/mp4",
          extensionSynthesized: false,
          cleanup: async (): Promise<void> => {
            cleanups += 1;
          },
        }),
      };
      const tool = new AnalyzeMediaTool(
        {
          createClient: () => ({}) as never,
          defaultServerUrl: "http://127.0.0.1:8787",
          defaultApiKey: "test",
          defaultTimeoutMs: 1000,
        },
        fakeFetcher as unknown as MediaUrlFetcher
      );
      const params = tool.parseParams({
        path: "https://example.test/clip.mp4",
        question: "q",
        region: { x: 0, y: 0, width: 0.5, height: 0.5 },
      });
      await expect(tool.execute(params)).rejects.toThrow(/sólo aplica a imágenes/iu);
      expect(cleanups).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deep-freezes returned element boxes", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "lanee-exec-"));
    try {
      const image: string = join(dir, "shot.png");
      await writeFile(image, new Uint8Array([0x89, 0x50]));
      const box = { x: 0, y: 0, width: 0.5, height: 0.5 };
      const clientStub = {
        createUploadSession: async (): Promise<unknown> => ({ upload_id: "u", chunk_size_bytes: 1024, expires_at: 1 }),
        getUploadOffset: async (): Promise<number> => 2,
        appendUploadChunk: async (): Promise<number> => 2,
        analyze: async (): Promise<unknown> => ({
          analysis: "ok",
          elements: [{ label: "l", box }],
          media_type: "image",
          extraction: {},
        }),
      };
      const tool = new AnalyzeMediaTool({
        createClient: () => clientStub as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 1000,
      });
      const result = await tool.execute(tool.parseParams({ path: image, question: "q" }));
      expect(Object.isFrozen(result.elements?.[0])).toBe(true);
      expect(Object.isFrozen(result.elements?.[0]?.box)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Round-2 repair (r2-vision)", () => {
  it("strips private keys, credentials, and prefixed token keys (N1)", () => {
    const sanitizer = new AnalyzeMediaExtractionSanitizer();
    const out = sanitizer.sanitize({
      private_key: "k",
      encryptionPrivateKey: "k",
      db_credentials: "c",
      userCredentials: "c",
      my_token: "t",
      session_token: "t",
      refresh_token: "t",
      nested: { csrf_token: "t", apiToken: "t" },
      token_usage: { total: 3 },
      tokens_used: 3,
      token_count: 3,
    });
    for (const key of [
      "private_key",
      "encryptionPrivateKey",
      "db_credentials",
      "userCredentials",
      "my_token",
      "session_token",
      "refresh_token",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
    const nested = out["nested"] as Record<string, unknown>;
    expect(nested["csrf_token"]).toBeUndefined();
    expect(nested["apiToken"]).toBeUndefined();
    expect(out).toHaveProperty("token_usage");
    expect(out).toHaveProperty("tokens_used");
    expect(out).toHaveProperty("token_count");
  });

  it("keeps head and tail of huge structured analyses (N2)", () => {
    const peer = EnriVisionServer as unknown as {
      boundStructuredContent: (result: {
        readonly analysis: string;
        readonly media_type: string;
        readonly extraction: Record<string, unknown>;
      }) => Record<string, unknown>;
    };
    const analysis = `INICIO-${"a".repeat(219993)}-MITAD-${"b".repeat(80007)}-FINAL`;
    const bounded = peer.boundStructuredContent({
      analysis,
      media_type: "video",
      extraction: {},
    });
    const text = bounded["analysis"] as string;
    expect(bounded["analysis_truncated"]).toBe(true);
    expect(bounded["analysis_total_chars"]).toBe(Array.from(analysis).length);
    expect(text).toContain("INICIO-");
    expect(text).toContain("-FINAL");
    expect(text).not.toContain("-MITAD-");
    expect(text).toMatch(/truncado: se muestran principio.*y fin.*de \d+ caracteres/u);
    expect(Array.from(text).length).toBeLessThanOrEqual(262144 + 200);
  });
});
