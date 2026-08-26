import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";

/**
 * Creates one fetch stub serving the given bytes for every request.
 *
 * @param bytes - Payload served for every request.
 * @param contentType - Reported content type.
 * @param status - Response status (default 200).
 * @param location - Optional Location header (for redirect stubs).
 * @returns Fetch-compatible function.
 */
function createFetchStub(
  bytes: Uint8Array,
  contentType: string,
  status = 200,
  location?: string
): typeof fetch {
  const headers: Record<string, string> = { "content-type": contentType };
  if (location) {
    headers["location"] = location;
  }
  return (async (): Promise<Response> => {
    return new Response(new Uint8Array(bytes), { status, headers });
  }) as unknown as typeof fetch;
}

/**
 * Creates one resolver stub resolving hostnames to the given addresses.
 *
 * @param addresses - Addresses returned for every hostname.
 * @returns Resolver function.
 */
function createResolverStub(addresses: readonly string[]): (hostname: string) => Promise<readonly string[]> {
  return async (): Promise<readonly string[]> => addresses;
}

describe("MediaUrlFetcher", () => {
  it("isHttpUrl detects http and https only", () => {
    expect(MediaUrlFetcher.isHttpUrl("https://example.test/a.png")).toBe(true);
    expect(MediaUrlFetcher.isHttpUrl("http://example.test/a.png")).toBe(true);
    expect(MediaUrlFetcher.isHttpUrl("ftp://example.test/a.png")).toBe(false);
    expect(MediaUrlFetcher.isHttpUrl("C:\\media\\a.png")).toBe(false);
    expect(MediaUrlFetcher.isHttpUrl("media/a.png")).toBe(false);
  });

  it("downloads a public image URL into a temporary file with cleanup", async () => {
    const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fetcher = new MediaUrlFetcher(
      createFetchStub(png, "image/png"),
      createResolverStub(["93.184.216.34"])
    );

    const result = await fetcher.fetch("https://example.test/pics/shot.png");

    expect(result.contentType).toBe("image/png");
    expect(result.localPath.endsWith("shot.png")).toBe(true);
    expect(existsSync(result.localPath)).toBe(true);
    const st = await stat(result.localPath);
    expect(st.size).toBe(png.byteLength);

    await result.cleanup();
    expect(existsSync(result.localPath)).toBe(false);
    expect(existsSync(join(result.localPath, ".."))).toBe(false);
  });

  it("rejects non-http inputs", async () => {
    const fetcher = new MediaUrlFetcher(
      createFetchStub(new Uint8Array([1]), "image/png"),
      createResolverStub(["93.184.216.34"])
    );
    await expect(fetcher.fetch("file:///etc/passwd")).rejects.toThrow(/http/u);
  });

  it("rejects literal loopback and private-network destinations without DNS", async () => {
    const fetcher = new MediaUrlFetcher(
      createFetchStub(new Uint8Array([1]), "image/png"),
      createResolverStub(["93.184.216.34"])
    );
    await expect(fetcher.fetch("http://127.0.0.1/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://192.168.1.5/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://10.0.0.5/x.png")).rejects.toThrow(/bloqueado/iu);
    await expect(fetcher.fetch("http://localhost/x.png")).rejects.toThrow(/bloqueado/iu);
  });

  it("rejects hostnames resolving to private addresses", async () => {
    const fetcher = new MediaUrlFetcher(
      createFetchStub(new Uint8Array([1]), "image/png"),
      createResolverStub(["10.0.0.5"])
    );
    await expect(fetcher.fetch("https://internal.example.test/x.png")).rejects.toThrow(/bloqueado/iu);
  });

  it("follows validated redirects and derives the filename from the final URL", async () => {
    const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/final/real-shot.png" }
        });
      }
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }) as unknown as typeof fetch;

    const fetcher = new MediaUrlFetcher(fetchImpl, createResolverStub(["93.184.216.34"]));
    const result = await fetcher.fetch("https://example.test/redirect-me");

    expect(result.localPath.endsWith("real-shot.png")).toBe(true);
    await result.cleanup();
  });

  it("rejects redirects pointing at private networks", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://192.168.0.1/inner.png" }
      });
    }) as unknown as typeof fetch;

    const fetcher = new MediaUrlFetcher(fetchImpl, createResolverStub(["93.184.216.34"]));
    await expect(fetcher.fetch("https://example.test/redirect-me")).rejects.toThrow(/bloqueado/iu);
  });

  it("rejects responses over the 64 MiB size limit", async () => {
    const oversized: Uint8Array = new Uint8Array(65 * 1024 * 1024);
    const fetcher = new MediaUrlFetcher(
      createFetchStub(oversized, "video/mp4"),
      createResolverStub(["93.184.216.34"])
    );
    await expect(fetcher.fetch("https://example.test/huge.mp4")).rejects.toThrow(/64 MiB/u);
  });

  it("rejects non-2xx final responses", async () => {
    const fetcher = new MediaUrlFetcher(
      createFetchStub(new Uint8Array(0), "text/plain", 404),
      createResolverStub(["93.184.216.34"])
    );
    await expect(fetcher.fetch("https://example.test/missing.png")).rejects.toThrow(/404/u);
  });
});
