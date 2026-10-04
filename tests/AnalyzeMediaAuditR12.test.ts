import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import type { AnalyzeMediaToolParams } from "../src/tools/AnalyzeMediaContract.js";
import type { EnriProxyClient } from "../src/client/EnriProxyClient.js";

/**
 * Round 12 audit fixes: JSONL local/URL acceptance, honest delivery=auto
 * degradation warning, and accurate non-media rejection wording.
 */
describe("AnalyzeMediaAuditR12", (): void => {
  it("accepts a local .jsonl file through the media gate", async (): Promise<void> => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r12-"));
    const filePath: string = join(dir, "events.jsonl");
    await writeFile(filePath, '{"a":1}\n{"a":2}\n', "utf8");

    const resolver: AnalyzeMediaInputResolver = new AnalyzeMediaInputResolver(
      undefined,
      new MediaUrlFetcher(),
    );
    const resolved = await resolver.resolve({ path: filePath, paths: undefined, signal: undefined });
    expect(resolved.inputs).toHaveLength(1);
    expect(resolved.inputs[0]?.contentType).toBe("application/jsonl");
  });

  it("accepts a local .ndjson file through the media gate", async (): Promise<void> => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r12-"));
    const filePath: string = join(dir, "events.ndjson");
    await writeFile(filePath, '{"a":1}\n', "utf8");

    const resolver: AnalyzeMediaInputResolver = new AnalyzeMediaInputResolver(
      undefined,
      new MediaUrlFetcher(),
    );
    const resolved = await resolver.resolve({ path: filePath, paths: undefined, signal: undefined });
    expect(resolved.inputs[0]?.contentType).toBe("application/jsonl");
  });

  it("allows application/jsonl and application/x-ndjson content types", (): void => {
    expect(MediaUrlFetcher.isAllowedMediaContentType("application/jsonl")).toBe(true);
    expect(MediaUrlFetcher.isAllowedMediaContentType("application/x-ndjson")).toBe(true);
    expect(MediaUrlFetcher.isAllowedMediaContentType("application/json")).toBe(false);
  });

  it("recognizes .jsonl and .ndjson URL extensions as media", (): void => {
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.com/logs.jsonl")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.com/logs.ndjson?x=1")).toBe(true);
    expect(MediaUrlFetcher.hasKnownMediaExtension("https://example.com/logs.exe")).toBe(false);
  });

  it("rejects a non-media local file with the accurate accepted-formats wording", async (): Promise<void> => {
    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r12-"));
    const filePath: string = join(dir, "payload.zzz");
    await writeFile(filePath, "bytes", "utf8");

    const resolver: AnalyzeMediaInputResolver = new AnalyzeMediaInputResolver(
      undefined,
      new MediaUrlFetcher(),
    );
    await expect(
      resolver.resolve({ path: filePath, paths: undefined, signal: undefined }),
    ).rejects.toThrow(/archivos de texto \(txt, csv, rtf, jsonl\)/u);
  });

  it("warns when delivery=auto degrades to the describe lane", async (): Promise<void> => {
    const analysisResponse = {
      analysis: "texto del carril describe",
      delivery: "analysis",
      media_type: "image",
      request_id: "req-r12",
      warnings: [],
    };
    const stubClient = {
      createUploadSession: async (): Promise<{ uploadId: string }> => ({ uploadId: "u1" }),
      getUploadOffset: async (): Promise<number> => 0,
      appendUploadChunk: async (params: { chunk: Buffer }): Promise<number> => params.chunk.byteLength,
      analyze: async (): Promise<typeof analysisResponse> => analysisResponse,
      deleteUploadSession: async (): Promise<boolean> => true,
    };
    const tool: AnalyzeMediaTool = new AnalyzeMediaTool({
      createClient: (): unknown => stubClient,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 5_000,
    });

    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r12-"));
    const pngPath: string = join(dir, "img.png");
    const pngHeader: Buffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    await writeFile(pngPath, pngHeader);

    const result = await tool.execute(
      { path: pngPath, delivery: "auto" } as AnalyzeMediaToolParams,
      { signal: undefined },
    );
    expect(result.delivery).toBeUndefined();
    expect(result.warnings?.some((warning: string): boolean => warning.includes("delivery=auto"))).toBe(true);
  });

  it("does not warn on delivery=auto when the server delivers directly", async (): Promise<void> => {
    const directResponse = {
      analysis: "",
      delivery: "direct",
      media_type: "image",
      request_id: "req-r12-direct",
      media_blocks: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,aGk=" }],
      warnings: [],
    };
    const stubClient = {
      createUploadSession: async (): Promise<{ uploadId: string }> => ({ uploadId: "u1" }),
      getUploadOffset: async (): Promise<number> => 0,
      appendUploadChunk: async (params: { chunk: Buffer }): Promise<number> => params.chunk.byteLength,
      analyze: async (): Promise<typeof directResponse> => directResponse,
      deleteUploadSession: async (): Promise<boolean> => true,
    };
    const tool: AnalyzeMediaTool = new AnalyzeMediaTool({
      createClient: (): unknown => stubClient,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 5_000,
    });

    const dir: string = await mkdtemp(join(tmpdir(), "enrivision-r12-"));
    const pngPath: string = join(dir, "img.png");
    const pngHeader: Buffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    await writeFile(pngPath, pngHeader);

    const result = await tool.execute(
      { path: pngPath, delivery: "auto" } as AnalyzeMediaToolParams,
      { signal: undefined },
    );
    expect(result.delivery).toBe("direct");
    expect(result.warnings?.some((warning: string): boolean => warning.includes("delivery=auto")) ?? false).toBe(false);
  });
});
