/**
 * Tests for the audit round-1 EnriVision fixes: continuation `limit`
 * exposure, stable error insight (`code`/`field`), code-based error
 * classification, effective-model projection, and schema/README contract
 * invariants (cursor in anyOf, integer-only offset, ENRIPROXY_API_KEY env
 * name).
 *
 * @module tests/EnriVisionAuditR1
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { extractServerErrorInsight, EnriProxyHttpError } from "../src/client/EnriProxyClientContract.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import type { AnalyzeVisionResponse } from "../src/client/EnriProxyClientContract.js";
import type { AnalyzeMediaToolParams } from "../src/tools/AnalyzeMediaContract.js";

describe("continuation limit parsing", (): void => {
  it("accepts integers 1-100 and rejects the rest", (): void => {
    const parser = new AnalyzeMediaParamParser();
    const ok: AnalyzeMediaToolParams = parser.parseParams({ cursor: "abc123", limit: 25 });
    expect(ok.continuationLimit).toBe(25);
    expect(parser.parseParams({ cursor: "abc123", limit: 1 }).continuationLimit).toBe(1);
    expect(parser.parseParams({ cursor: "abc123", limit: 100 }).continuationLimit).toBe(100);
    expect(() => parser.parseParams({ cursor: "abc123", limit: 0 })).toThrow(/limit/u);
    expect(() => parser.parseParams({ cursor: "abc123", limit: 101 })).toThrow(/limit/u);
    expect(() => parser.parseParams({ cursor: "abc123", limit: "20" })).toThrow(/limit/u);
    expect(parser.parseParams({ cursor: "abc123" }).continuationLimit).toBeUndefined();
  });
});

describe("extractServerErrorInsight", (): void => {
  it("parses nested code and field alongside the message", (): void => {
    const insight = extractServerErrorInsight(
      JSON.stringify({
        error: {
          message: "clip_duration_seconds debe ser > 0",
          code: "invalid_video",
          field: "video.clip_duration_seconds"
        }
      })
    );
    expect(insight.detail).toContain("clip_duration_seconds");
    expect(insight.code).toBe("invalid_video");
    expect(insight.field).toBe("video.clip_duration_seconds");
  });

  it("parses top-level code/field and degrades on plain text", (): void => {
    const top = extractServerErrorInsight(
      JSON.stringify({ message: "mala petición", code: "invalid_document", field: "document.max_pages_total" })
    );
    expect(top.code).toBe("invalid_document");
    expect(top.field).toBe("document.max_pages_total");
    const plain = extractServerErrorInsight("Gateway Timeout");
    expect(plain.detail).toBe("Gateway Timeout");
    expect(plain.code).toBeUndefined();
  });
});

describe("error classification by stable code", (): void => {
  it("maps invalid_* server codes to TOOL_INPUT_INVALID even without HTTP status", (): void => {
    const error = new EnriProxyHttpError(
      "fallo",
      0,
      {},
      JSON.stringify({
        error: { message: "knob inválido", code: "invalid_audio", field: "audio.segment_seconds" }
      }),
      "invalid_audio",
      "audio.segment_seconds"
    );
    const mapped: { structuredContent: { code: string; retryable: boolean } } =
      EnriVisionServer.mapToolError(error);
    expect(mapped.structuredContent.code).toBe("ENRICODE_ERR_TOOL_INPUT_INVALID");
    expect(mapped.structuredContent.retryable).toBe(false);
  });
});

describe("effective model projection", (): void => {
  it("carries model/request_id into the typed response contract", (): void => {
    const response: AnalyzeVisionResponse = {
      analysis: "ok",
      media_type: "image",
      model: "glm-4.6v",
      request_id: "req_123",
      extraction: { frames: 1 }
    };
    expect(response.model).toBe("glm-4.6v");
    expect(response.request_id).toBe("req_123");
  });
});

describe("schema and description contract invariants", (): void => {
  it("uses the real env name and documents cursor continuation", (): void => {
    const testDir: string = dirname(fileURLToPath(import.meta.url));
    const source: string = readFileSync(join(testDir, "..", "src", "server", "EnriVisionServer.ts"), "utf8");
    expect(source).toContain("env ENRIPROXY_API_KEY");
    expect(source).not.toContain("env ENRIVISION_API_KEY");
    expect(source).toContain('{ required: ["cursor"] }');
    expect(source).toContain('type: "integer"');
  });
});
