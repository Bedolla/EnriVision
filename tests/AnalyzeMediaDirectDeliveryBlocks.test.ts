/**
 * Direct-delivery coverage for the MCP success contract: when the analyze
 * tool returns `delivery: "direct"` with media blocks, the server must emit
 * MCP image content blocks (plus a Spanish note and the extracted text
 * blocks) instead of the describe-lane analysis text.
 *
 * @module tests/AnalyzeMediaDirectDeliveryBlocks
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import type { AnalyzeMediaTool, AnalyzeMediaToolResult } from "../src/tools/AnalyzeMediaContract.js";

/**
 * Builds a connected MCP client/server pair over in-memory transport with
 * a stubbed analyze tool returning a fixed direct-delivery result.
 *
 * @param result - Direct-delivery result served by the stub.
 * @returns Connected client.
 */
async function buildConnectedPair(result: AnalyzeMediaToolResult): Promise<Client> {
  const stubTool = {
    parseParams: (args: Record<string, unknown>): Record<string, unknown> => args,
    execute: async (): Promise<AnalyzeMediaToolResult> => result,
  } as unknown as AnalyzeMediaTool;
  const server = new EnriVisionServer({
    name: "EnriVision-test",
    version: "0.0.0-test",
    analyzeMediaTool: stubTool
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return client;
}

describe("AnalyzeMediaDirectDeliveryBlocks", (): void => {
  it("emits MCP image blocks plus note and text blocks on direct delivery", async (): Promise<void> => {
    const client = await buildConnectedPair({
      analysis: "",
      delivery: "direct",
      media_blocks: [
        { mimeType: "image/png", dataUrl: "data:image/png;base64,AAAB" },
        { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,CCDD" }
      ],
      text_blocks: ["[Transcripción del audio]\nhola mundo"],
      media_type: "video",
      extraction: {}
    });

    const result = await client.callTool({
      name: "analyze_media",
      arguments: { path: "C:/does/not/matter.mp4" }
    });

    expect(result.isError).toBe(false);
    const content = Array.isArray(result.content) ? result.content : [];
    expect(content.length).toBe(3);
    const first = content[0] as { type: string; text?: unknown };
    expect(first.type).toBe("text");
    expect(String(first.text)).toContain("Media entregada directamente");
    expect(String(first.text)).toContain("hola mundo");
    const second = content[1] as { type: string; data?: string; mimeType?: string };
    expect(second.type).toBe("image");
    expect(second.data).toBe("AAAB");
    expect(second.mimeType).toBe("image/png");
    const third = content[2] as { type: string; data?: string; mimeType?: string };
    expect(third.type).toBe("image");
    expect(third.data).toBe("CCDD");
    expect(third.mimeType).toBe("image/jpeg");
  });

  it("skips empty data URLs and still emits the honest note", async (): Promise<void> => {
    const client = await buildConnectedPair({
      analysis: "",
      delivery: "direct",
      media_blocks: [{ mimeType: "image/png", dataUrl: "data:image/png;base64," }],
      media_type: "image",
      extraction: {}
    });

    const result = await client.callTool({
      name: "analyze_media",
      arguments: { path: "C:/does/not/matter.png" }
    });

    expect(result.isError).toBe(false);
    const content = Array.isArray(result.content) ? result.content : [];
    expect(content.length).toBe(1);
    const first = content[0] as { type: string; text?: unknown };
    expect(first.type).toBe("text");
    expect(String(first.text)).toContain("0 bloques de imagen");
  });

  it("keeps the describe-lane text format for analysis delivery", async (): Promise<void> => {
    const client = await buildConnectedPair({
      analysis: "descripción lateral clásica",
      media_type: "image",
      extraction: {}
    });

    const result = await client.callTool({
      name: "analyze_media",
      arguments: { path: "C:/does/not/matter.png" }
    });

    expect(result.isError).toBe(false);
    const content = Array.isArray(result.content) ? result.content : [];
    expect(content.length).toBe(1);
    const first = content[0] as { type: string; text?: unknown };
    expect(first.type).toBe("text");
    expect(String(first.text)).toContain("descripción lateral clásica");
  });
});
