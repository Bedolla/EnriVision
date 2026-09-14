/**
 * AUDIT R5 TESTS (second-pass delta: T1.4.7 + T1.4.8 remainder).
 *
 * Covers the retry-audit fixes: IPv6 unspecified/loopback/compatible bypass
 * closures in the URL fetcher, the strict-mode symlink TOCTOU gate, the
 * explicit `transcribe` default in the analyze payload, the 256 KiB chunk
 * fallback, the redirect allowlist, and tar per-chunk scratch safety.
 *
 * @module tests/AnalyzeMediaAuditR5
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, symlink, writeFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { TarStream, type TarEntry } from "../src/shared/tar.js";
import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import {
  DEFAULT_CHUNK_BYTES,
  effectiveChunkSizeBytes,
} from "../src/tools/AnalyzeMediaResumableUploader.js";

/**
 * Creates one fetch stub serving fixed bytes with the given content type.
 *
 * @param bytes - Payload served for every request.
 * @param contentType - Reported content type.
 * @returns Fetch-compatible function.
 */
function createFetchStub(bytes: Uint8Array, contentType: string): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
}

/**
 * Creates one resolver stub resolving every hostname to the given addresses.
 *
 * @param addresses - Addresses returned for every hostname.
 * @returns Resolver function.
 */
function createResolverStub(addresses: readonly string[]): (hostname: string) => Promise<readonly string[]> {
  return async (): Promise<readonly string[]> => addresses;
}

/**
 * Starts one temporary HTTP capture server.
 *
 * @param handler - Request handler.
 * @returns Server instance and base URL.
 */
async function startCaptureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address: AddressInfo = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Audit R5 A: IPv6 unspecified/loopback/compatible bypasses are blocked", () => {
  const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it.each([
    ["compact loopback", "http://[::1]/x.png"],
    ["compact unspecified", "http://[::]/x.png"],
    ["expanded loopback", "http://[0:0:0:0:0:0:0:1]/x.png"],
    ["expanded unspecified", "http://[0:0:0:0:0:0:0:0]/x.png"],
    ["leading-zero loopback", "http://[::01]/x.png"],
    ["compatible dotted loopback", "http://[::127.0.0.1]/x.png"],
    ["compatible expanded dotted loopback", "http://[0:0:0:0:0:0:127.0.0.1]/x.png"],
    ["compatible hex loopback", "http://[::7f00:1]/x.png"],
    ["compatible expanded hex loopback", "http://[0:0:0:0:0:0:7f00:1]/x.png"],
    ["compatible private", "http://[::0a00:1]/x.png"],
    ["uppercase compatible hex loopback", "http://[0:0:0:0:0:0:7F00:1]/UPPER.PNG"],
  ])("rejects %s without reaching the network", async (_label: string, url: string) => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const fetcher: MediaUrlFetcher = new MediaUrlFetcher(fetchImpl, createResolverStub(["93.184.216.34"]));
    await expect(fetcher.fetch(url)).rejects.toThrow(/bloqueado/iu);
    expect(calls).toBe(0);
  });

  it("still allows a public IPv6 literal", async () => {
    const fetcher: MediaUrlFetcher = new MediaUrlFetcher(
      createFetchStub(png, "image/png"),
      createResolverStub(["2606:4700:4700::1111"])
    );
    const result = await fetcher.fetch("http://[2606:4700:4700::1111]/pics/shot.png");
    expect(result.contentType).toBe("image/png");
    await result.cleanup();
  });
});

describe("Audit R5 A: strict-mode symlink gate validates the opened handle", () => {
  const previousFlag: string | undefined = process.env["ENRIVISION_DENY_SYMLINKS"];

  afterEach(() => {
    if (typeof previousFlag === "undefined") {
      delete process.env["ENRIVISION_DENY_SYMLINKS"];
    } else {
      process.env["ENRIVISION_DENY_SYMLINKS"] = previousFlag;
    }
  });

  it("rejects symlinked inputs and accepts the real file", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-symlink-"));
    try {
      const realPath: string = join(dir, "shot.png");
      await writeFile(realPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const linkPath: string = join(dir, "link.png");
      await symlink(realPath, linkPath);

      const fetcher: MediaUrlFetcher = new MediaUrlFetcher(
        createFetchStub(new Uint8Array([1]), "image/png"),
        createResolverStub(["93.184.216.34"])
      );
      const resolver: AnalyzeMediaInputResolver = new AnalyzeMediaInputResolver(fetcher);

      process.env["ENRIVISION_DENY_SYMLINKS"] = "1";
      await expect(resolver.resolve({ path: linkPath })).rejects.toThrow(/enlaces simbólicos/iu);

      const resolved = await resolver.resolve({ path: realPath });
      expect(resolved.inputs).toHaveLength(1);
      expect(resolved.inputs[0]!.localPath).toBe(realPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Audit R5 B: analyze payload carries an explicit transcribe default", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server === null) {
      return;
    }
    const closing: Server = server;
    server = null;
    await new Promise<void>((resolve) => {
      try {
        closing.close(() => resolve());
      } catch {
        resolve();
      }
    });
  });

  /**
   * Runs one analyze call against a capture server.
   *
   * @param params - Analyze parameters.
   * @returns Captured request body.
   */
  async function captureAnalyzeBody(params: Parameters<EnriProxyClient["analyze"]>[0]): Promise<Record<string, unknown>> {
    let recorded: Record<string, unknown> | null = null;
    const started = await startCaptureServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const raw: string = Buffer.concat(chunks).toString("utf8");
      recorded = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "image", extraction: {} }));
    });
    server = started.server;
    const client: EnriProxyClient = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 5000,
    });
    await client.analyze(params);
    if (recorded === null) {
      throw new Error("No request was captured.");
    }
    return recorded;
  }

  it("defaults omitted transcribe to true (EnriCode parity)", async () => {
    const body: Record<string, unknown> = await captureAnalyzeBody({ uploadId: "upload-1" });
    expect(body["transcribe"]).toBe(true);
  });

  it("keeps an explicit transcribe:false", async () => {
    const body: Record<string, unknown> = await captureAnalyzeBody({ uploadId: "upload-1", transcribe: false });
    expect(body["transcribe"]).toBe(false);
  });
});

describe("Audit R5 C: invalid chunk advertisements fall back to 256 KiB", () => {
  it("exposes the 256 KiB EnriCode-parity default", () => {
    expect(DEFAULT_CHUNK_BYTES).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(Number.NaN)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(0)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(-5)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(Number.POSITIVE_INFINITY)).toBe(256 * 1024);
  });

  it("keeps the valid range behavior (4 KiB floor, 16 MiB ceiling, passthrough)", () => {
    expect(effectiveChunkSizeBytes(256 * 1024)).toBe(256 * 1024);
    expect(effectiveChunkSizeBytes(1024)).toBe(4096);
    expect(effectiveChunkSizeBytes(1024 * 1024 * 1024)).toBe(16 * 1024 * 1024);
  });
});

describe("Audit R5 C: only Location-carrying redirect statuses start a new hop", () => {
  const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);

  it.each([304, 305, 306])("treats HTTP %i as terminal (no new hop)", async (status: number) => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response(null, { status, headers: { location: "https://cdn.example.test/elsewhere/a.png" } });
    }) as unknown as typeof fetch;
    const fetcher: MediaUrlFetcher = new MediaUrlFetcher(fetchImpl, createResolverStub(["93.184.216.34"]));
    await expect(fetcher.fetch("https://example.test/start")).rejects.toThrow(/HTTP 30[456]/u);
    expect(calls).toBe(1);
  });

  it.each([301, 303, 307, 308])("still follows HTTP %i", async (status: number) => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status,
          headers: { location: "https://cdn.example.test/final/real-shot.png" },
        });
      }
      return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const fetcher: MediaUrlFetcher = new MediaUrlFetcher(fetchImpl, createResolverStub(["93.184.216.34"]));
    const result = await fetcher.fetch("https://example.test/redirect-me");
    expect(calls).toBe(2);
    expect(result.localPath.endsWith("real-shot.png")).toBe(true);
    await result.cleanup();
  });
});

describe("Audit R5 C: tar per-chunk scratch stays byte-correct and iteration-local", () => {
  it("streams identical bytes and isolates retained chunks", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-tar-r5-"));
    try {
      const fileA: string = join(dir, "a.bin");
      const fileB: string = join(dir, "b.bin");
      const bytesA: Buffer = Buffer.from("hello world, scratch reuse", "utf8");
      const bytesB: Buffer = Buffer.alloc(3000, 0xab);
      await writeFile(fileA, bytesA);
      await writeFile(fileB, bytesB);
      const stA = await stat(fileA);
      const stB = await stat(fileB);
      const nowSeconds: number = Math.floor(Date.now() / 1000);
      const entries: TarEntry[] = [
        { name: "000001.bin", source: { type: "file", path: fileA, sizeBytes: stA.size }, mtimeSeconds: nowSeconds },
        { name: "000002.bin", source: { type: "file", path: fileB, sizeBytes: stB.size }, mtimeSeconds: nowSeconds },
      ];
      const tar: TarStream = new TarStream(entries);

      const parts: Buffer[] = [];
      for await (const chunk of tar.iterateChunks(0, 100)) {
        parts.push(chunk);
      }
      // Mutating one retained chunk must not disturb the others: every
      // iteration owns a fresh scratch.
      const probe: number = parts[1]![0]!;
      parts[0]![0] = (parts[0]![0]! + 1) % 256;
      expect(parts[1]![0]).toBe(probe);

      const fresh: Buffer[] = [];
      for await (const chunk of tar.iterateChunks(0, 100)) {
        fresh.push(chunk);
      }
      expect(Buffer.concat(fresh).length).toBe(tar.getSizeBytes());
      expect(Buffer.concat(parts).length).toBe(tar.getSizeBytes());
      parts[0]![0] = (parts[0]![0]! + 255) % 256;
      expect(Buffer.concat(parts)).toEqual(Buffer.concat(fresh));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
