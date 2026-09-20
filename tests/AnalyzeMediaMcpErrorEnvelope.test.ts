/**
 * Regression coverage for the MCP error-envelope schema contract: error
 * results from `analyze_media` must NOT carry structuredContent, because the
 * tool's outputSchema describes the SUCCESS shape (analysis/media_type/
 * extraction) and strict clients (OpenCode) validate any present
 * structuredContent against it, rejecting error envelopes with -32602. The
 * machine classification (error-code/retryable) rides the text instead.
 *
 * @module tests/AnalyzeMediaMcpErrorEnvelope
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import type { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

/**
 * Builds a connected MCP client/server pair over in-memory transport with a
 * stubbed analyze tool whose execute throws on demand.
 *
 * @param executeError - Error the stubbed tool throws.
 * @returns Connected client plus the server instance.
 */
async function buildConnectedPair(
  executeError: Error,
): Promise<{ readonly client: Client; readonly server: EnriVisionServer }> {
  const stubTool = {
    parseParams: (args: Record<string, unknown>): Record<string, unknown> => args,
    execute: async (): Promise<never> => {
      throw executeError;
    },
  } as unknown as AnalyzeMediaTool;
  const server = new EnriVisionServer({
    name: "EnriVision-test",
    version: "0.0.0-test",
    analyzeMediaTool: stubTool
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return { client, server };
}

describe("AnalyzeMediaMcpErrorEnvelope", (): void => {
  it("error results carry no structuredContent and embed the machine classification in text", async (): Promise<void> => {
    const { client } = await buildConnectedPair(
      new Error("Request timed out after 60000ms. / La petición expiró después de 60000ms"),
    );

    const result = await client.callTool({
      name: "analyze_media",
      arguments: { path: "C:/does/not/matter.jpg" }
    });

    expect(result.isError).toBe(true);
    expect("structuredContent" in result).toBe(false);
    const firstBlock = Array.isArray(result.content) ? result.content[0] : undefined;
    const text: string = typeof firstBlock === "object" && firstBlock !== null && "text" in firstBlock
      ? String((firstBlock as { text: unknown }).text)
      : "";
    expect(text).toContain("error-code: ENRICODE_ERR_TOOL_EXECUTION_TIMEOUT");
    expect(text).toContain("retryable: true");
  });

  it("unknown tools follow the same no-structuredContent contract", async (): Promise<void> => {
    const { client } = await buildConnectedPair(new Error("unused"));

    const result = await client.callTool({ name: "not_analyze_media", arguments: {} });

    expect(result.isError).toBe(true);
    expect("structuredContent" in result).toBe(false);
    const firstBlock = Array.isArray(result.content) ? result.content[0] : undefined;
    const text: string = typeof firstBlock === "object" && firstBlock !== null && "text" in firstBlock
      ? String((firstBlock as { text: unknown }).text)
      : "";
    expect(text).toContain("error-code:");
  });
});
