import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";

/**
 * Starts one JSON stub server for direct-client tests.
 *
 * @param responder - Builds the next response.
 * @returns Server plus base URL.
 */
async function startJsonServer(
  responder: () => { status: number; body: string }
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const next = responder();
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
 * Analyze Media audit fixes: NAT64 guard, prompt caps, batch guards,
 * clip warnings, and the `source_url` escalation branch.
 */
describe("Analyze Media audit fixes", (): void => {
  it("blocks NAT64 literals embedding private IPv4", async (): Promise<void> => {
    const fetchStub = (async (): Promise<Response> =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    for (const url of ["http://[64:ff9b::7f00:1]/x.png", "http://[64:ff9b::a00:1]/x.png"]) {
      const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
      await expect(fetcher.fetch(url)).rejects.toThrow(/Destino bloqueado/u);
    }
  });

  it("keeps allowing public documentation fixtures", async (): Promise<void> => {
    const fetchStub = (async (): Promise<Response> =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "1" },
      })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
    const result = await fetcher.fetch("http://[2001:db8::1]/x.png");
    await result.cleanup();
  });

  it("rejects question/context over 2000 chars before any session", (): void => {
    expect(() =>
      new AnalyzeMediaParamParser().parseParams({ path: "/tmp/a.png", question: "x".repeat(2001) })
    ).toThrow(/question excede el máximo de 2000 caracteres/u);
    expect(() =>
      new AnalyzeMediaParamParser().parseParams({ path: "/tmp/a.png", context: "y".repeat(2001) })
    ).toThrow(/context excede el máximo de 2000 caracteres/u);
  });

  it("detects size-cap failures through the stable marker", (): void => {
    expect(
      MediaUrlFetcher.isSizeCapError(new Error(`${MediaUrlFetcher.URL_SIZE_CAP_MARKER} El archivo remoto excede.`))
    ).toBe(true);
    expect(MediaUrlFetcher.isSizeCapError(new Error("El archivo remoto excede el límite de 64 MiB."))).toBe(false);
  });

  it("throws a Spanish no-Location error on bare redirects", async (): Promise<void> => {
    const fetchStub = (async (): Promise<Response> =>
      new Response(new Uint8Array([1]), { status: 302 })) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(fetchStub, async () => ["93.184.216.34"]);
    await expect(fetcher.fetch("https://example.test/stuck.png")).rejects.toThrow(/no incluyó Location/u);
  });

  it("rejects batch-over-total on the direct client", async (): Promise<void> => {
    const client = new EnriProxyClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 1000 });
    await expect(
      client.analyze({ uploadId: "u", document: { maxPagesTotal: 10, pagesPerBatch: 20 } })
    ).rejects.toThrow(/pages_per_batch/u);
    await expect(
      client.analyze({ uploadId: "u", images: { maxImagesTotal: 5, imagesPerBatch: 10 } })
    ).rejects.toThrow(/images\.images_per_batch supera a max_images_total/u);
  });

  it("fails fast on oversized prompts on the direct client", async (): Promise<void> => {
    const client = new EnriProxyClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 1000 });
    await expect(client.analyze({ uploadId: "u", question: "z".repeat(2001) })).rejects.toThrow(
      /question excede el máximo de 2000/u
    );
  });

  it("requires exactly one of uploadId/sourceUrl", async (): Promise<void> => {
    const client = new EnriProxyClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 1000 });
    await expect(client.analyze({} as never)).rejects.toThrow(/exactamente uno/u);
    await expect(client.analyze({ uploadId: "u", sourceUrl: "http://x/y" })).rejects.toThrow(
      /exactamente uno/u
    );
  });

  it("surfaces a clip-clamp warning on the direct client", async (): Promise<void> => {
    let seenBody: string = "";
    const { server, baseUrl } = await startJsonServer(() => {
      return {
        status: 200,
        body: JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }),
      };
    });
    // Capture the request body through a wrapping fetch is unavailable here;
    // assert on the response warning channel instead.
    const client = new EnriProxyClient({ baseUrl, apiKey: "k", timeoutMs: 5000 });
    try {
      const response = await client.analyze({
        uploadId: "u",
        video: { clipStartSeconds: 86000, clipDurationSeconds: 1000 },
      });
      expect(response.analysis).toBe("ok");
      expect(response.warnings?.join(" ")).toMatch(/recortó/u);
      seenBody = "checked";
    } finally {
      server.close();
    }
    expect(seenBody).toBe("checked");
  });

  it("sends source_url instead of upload_id when requested", async (): Promise<void> => {
    let seenBody: string = "";
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const client = new EnriProxyClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "k",
      timeoutMs: 5000,
    });
    try {
      await client.analyze({ sourceUrl: "http://93.184.216.34/big.mp4" });
    } finally {
      server.close();
    }
    expect(seenBody).toContain("source_url");
    expect(seenBody).not.toContain("upload_id");
  });
});
