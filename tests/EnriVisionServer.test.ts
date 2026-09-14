import { describe, expect, it } from "vitest";

import { EnriVisionServer } from "../src/server/EnriVisionServer.js";

/**
 * Shape of the tool definition accessor used for schema assertions.
 */
interface ToolDefinitionReader {
  /**
   * Returns the `analyze_media` tool definition.
   */
  getAnalyzeMediaToolDefinition(): {
    readonly name: string;
    readonly outputSchema?: {
      readonly type: string;
      readonly required?: ReadonlyArray<string>;
      readonly properties?: Record<string, unknown>;
    };
  };
}

describe("EnriVisionServer tool definition", () => {
  it("exposes an outputSchema for strict structuredContent clients", () => {
    const server = new EnriVisionServer({
      name: "EnriVision",
      version: "0.0.0-test",
      analyzeMediaTool: {} as never
    });

    const definition = (server as unknown as ToolDefinitionReader).getAnalyzeMediaToolDefinition();

    expect(definition.name).toBe("analyze_media");
    expect(definition.outputSchema?.type).toBe("object");
    expect(definition.outputSchema?.required).toEqual(["analysis", "media_type", "extraction"]);
    expect(definition.outputSchema?.properties).toHaveProperty("analysis");
    expect(definition.outputSchema?.properties).toHaveProperty("elements");
    expect(definition.outputSchema?.properties).toHaveProperty("media_type");
    expect(definition.outputSchema?.properties).toHaveProperty("extraction");
  });
});
