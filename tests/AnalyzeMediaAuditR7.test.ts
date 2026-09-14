/**
 * Tests for the Analyze Media R7 audit round (EnriVision lanes F1-F23).
 *
 * Covers: English-first bilingual model surface + language policy (F1),
 * usage accounting preservation (F2), tar stuck-offset guard (F3), 50 MB
 * overflow rejection (F4), boundExtraction re-probe (F5), bounded scratch
 * (F6), 10/20 min analyze budgets (F7), fail-open vision probe (F8),
 * identity re-check cadence (F9), hyphenated secret keys (F10), error
 * structuredContent codes (F11), transcribe inapplicability warnings (F12),
 * remote advisory gates (F13), codepoint-safe labels + media_type bound
 * (F15), tar-overhead fail-fast estimate (F16), retry/timeout alignment pins
 * (F17), schema/parser coercion agreement (F18), shared clip warning (F19),
 * win32 strict-mode docs (F20), bearer/signing material stripping (F22), and
 * tool-description ergonomics (F23). F14 (dead guard) and F21 (dead branch)
 * are behavior-preserving deletions covered by the existing suites.
 */
import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCOUNT_MODELS_PROBE_TIMEOUT_MS,
  CREATE_CONTROL_TIMEOUT_MS,
  EnriProxyClient,
  EnriProxyHttpError,
  PROBE_CONTROL_TIMEOUT_MS,
} from "../src/client/EnriProxyClient.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";
import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import type { MediaUrlFetcher as MediaUrlFetcherType } from "../src/shared/mediaUrlFetcher.js";
import { ANALYZE_MEDIA_LIMITS } from "../src/tools/AnalyzeMediaContract.js";
import { estimateMediaSetTarBytes } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import {
  resolveChunkTimeoutMs,
  resolveScratchSize,
  resolveUploadDeadlineMs,
  shouldRecheckIdentity,
  AnalyzeMediaResumableUploader,
} from "../src/tools/AnalyzeMediaResumableUploader.js";
import { buildClipWindowClampedWarning } from "../src/shared/validation.js";

/**
 * Tool-definition accessor for schema assertions.
 */
interface ToolDefinitionReader {
  /**
   * Returns the `analyze_media` tool definition.
   */
  getAnalyzeMediaToolDefinition(): {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: { readonly properties: Record<string, unknown> };
    readonly outputSchema: { readonly properties: Record<string, unknown> };
  };
}

/**
 * Reads the tool definition from a throwaway server.
 *
 * @returns Tool definition.
 */
function readDefinition(): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly properties: Record<string, unknown> };
  readonly outputSchema: { readonly properties: Record<string, unknown> };
} {
  const server = new EnriVisionServer({
    name: "EnriVision",
    version: "0.0.0-test",
    analyzeMediaTool: {} as never,
  });
  return (server as unknown as ToolDefinitionReader).getAnalyzeMediaToolDefinition();
}

/**
 * Collects every `description` string in a tool definition.
 *
 * @param value - Definition subtree.
 * @param out - Collected descriptions.
 */
function collectDescriptions(value: unknown, out: string[]): void {
  if (typeof value === "string" || typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDescriptions(item, out);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description" && typeof child === "string") {
      out.push(child);
    } else {
      collectDescriptions(child, out);
    }
  }
}

/**
 * Creates one stub tool with controllable client behavior.
 *
 * @param clientOverrides - Partial client implementation.
 * @param fetcher - Optional URL fetcher override.
 * @returns Tool instance plus captured analyze calls.
 */
function createStubTool(
  clientOverrides: Record<string, unknown> = {},
  fetcher?: MediaUrlFetcherType,
): { readonly tool: AnalyzeMediaTool; readonly analyzeCalls: Array<Record<string, unknown>> } {
  const analyzeCalls: Array<Record<string, unknown>> = [];
  const tool = new AnalyzeMediaTool(
    {
      createClient: () =>
        ({
          createUploadSession: async () => ({
            upload_id: "upload_1",
            chunk_size_bytes: 1024,
            expires_at: Date.now() + 60_000,
          }),
          getUploadOffset: async () => 0,
          appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
            request.offset + request.chunk.length,
          deleteUploadSession: async () => undefined,
          analyze: async (request: Record<string, unknown>) => {
            analyzeCalls.push(request);
            return { analysis: "ok", media_type: "image", extraction: {} };
          },
          ...clientOverrides,
        }) as never,
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 30 * 60 * 1000,
    },
    fetcher,
  );
  return { tool, analyzeCalls };
}

/**
 * Sanitizes one extraction payload through the tool.
 *
 * @param tool - Tool instance.
 * @param extraction - Raw extraction object.
 * @returns Sanitized extraction object.
 */
function sanitizeThroughTool(
  tool: AnalyzeMediaTool,
  extraction: Record<string, unknown>,
): Record<string, unknown> {
  return (
    tool as unknown as {
      stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
    }
  ).stripInternalExtractionFields(extraction);
}

describe("F1 language policy: Spanish-first bilingual model surface", () => {
  it("starts every schema description in Spanish with an English second half", () => {
    const definition = readDefinition();
    const descriptions: string[] = [];
    collectDescriptions(definition, descriptions);
    expect(descriptions.length).toBeGreaterThan(40);
    for (const text of descriptions) {
      expect(text, `missing EN half: ${text.slice(0, 60)}`).toContain(" / ");
    }
    // No description may LEAD in English: the English halves ship second.
    const serialized: string = JSON.stringify(definition);
    for (const lead of [
      '"description":"Upload',
      '"description":"When to use',
      '"description":"Rules:',
      '"description":"Absolute',
      '"description":"One image',
      '"description":"Optional',
      '"description":"Preferred',
      '"description":"Also accepts',
      '"description":"Alias of',
      '"description":"Legacy alias',
      '"description":"Relative',
      '"description":"Whether',
      '"description":"Analysis budgets',
      '"description":"Video clip',
      '"description":"Strict integers',
      '"description":"Errors:',
      '"description":"Minimal',
      '"description":"UI-screenshot',
      '"description":"Max ',
      '"description":"Maximum',
      '"description":"Segment duration',
      '"description":"Number',
      '"description":"Pages per',
      '"description":"Min extracted',
      '"description":"Images per',
      '"description":"Total chars',
      '"description":"Flag that',
      '"description":"Flat ',
      '"description":"Text analysis',
      '"description":"Detected',
      '"description":"Honesty warnings',
      '"description":"Extraction metadata',
    ]) {
      expect(serialized, `English-first lead surviving: ${lead}`).not.toContain(lead);
    }
    // Order pin: Spanish leads, English follows on the same string.
    expect(serialized.indexOf("Sube y analiza un archivo")).toBeLessThan(
      serialized.indexOf("Upload and analyze a media file"),
    );
    expect(serialized).toContain("Sube y analiza un archivo");
    expect(serialized).toContain("Upload and analyze a media file");
  });

  it("carries no English-only lead token in the definition output", () => {
    const definition = readDefinition();
    const serialized: string = JSON.stringify(definition);
    for (const lead of [
      '"description":"Upload',
      '"description":"When to use',
      '"description":"Rules:',
      '"description":"Absolute',
      '"description":"One image',
      '"description":"Optional',
      '"description":"Preferred',
      '"description":"Also accepts',
      '"description":"Alias of',
      '"description":"Legacy alias',
      '"description":"Relative',
      '"description":"Whether',
      '"description":"Analysis budgets',
      '"description":"Video clip',
      '"description":"Strict integers',
      '"description":"Errors:',
      '"description":"Minimal',
      '"description":"UI-screenshot',
      '"description":"Max ',
      '"description":"Maximum',
      '"description":"Segment duration',
      '"description":"Number',
      '"description":"Pages per',
      '"description":"Min extracted',
      '"description":"Images per',
      '"description":"Total chars',
      '"description":"Flag that',
      '"description":"Flat ',
      '"description":"Text analysis',
      '"description":"Detected',
      '"description":"Honesty warnings',
      '"description":"Extraction metadata',
    ]) {
      expect(serialized, `English-first lead surviving: ${lead}`).not.toContain(lead);
    }
    // EN parity: the English halves still ship on the wire, second.
    expect(serialized).toContain("When `paths` carries at least one valid entry, `path` is ignored");
    expect(serialized).toContain("se ignora");
  });

  it("keeps isError text, seams, and warnings Spanish-first with English parity", () => {
    const { tool } = createStubTool();
    const failure = (() => {
      try {
        tool.parseParams({});
        return null;
      } catch (error: unknown) {
        return error as Error;
      }
    })();
    expect(failure).not.toBeNull();
    expect(failure?.message).toMatch(/^Proporcione 'path'/u);
    expect(failure?.message).toContain("Provide 'path'");

    const clamped = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      video: { clip_start_seconds: 86300, clip_duration_seconds: 200 },
    });
    expect(clamped.warnings?.[0]).toMatch(/^La ventana pedida/u);
    expect(clamped.warnings?.[0]).toContain("Requested clip window");
  });

  it("orders truncation seams Spanish before English", () => {
    const bound = (
      EnriVisionServer as unknown as {
        boundStructuredContent(result: {
          readonly analysis: string;
          readonly media_type: string;
          readonly extraction: Record<string, unknown>;
        }): Record<string, unknown>;
      }
    ).boundStructuredContent({
      analysis: "z".repeat(300000),
      media_type: "video",
      extraction: {},
    });
    const text = String(bound["analysis"]);
    expect(text.indexOf("truncado:")).toBeLessThan(text.indexOf("truncated:"));
    const headed = (
      EnriVisionServer as unknown as {
        formatAnalysisText(analysis: string, mediaType: string, elements: undefined): string;
      }
    ).formatAnalysisText("hola", "image", undefined);
    expect(headed.startsWith("ANÁLISIS (image) / ANALYSIS (image):")).toBe(true);
  });
});

describe("F23 tool-description ergonomics", () => {
  it("documents budgets, contract, error shape, and three minimal examples", () => {
    const definition = readDefinition();
    const text: string = definition.description;
    expect(text).toMatch(/^Sube y analiza/u);
    expect(text).toContain("una imagen");
    expect(text).toContain("12:34");
    expect(text).toContain("754");
    expect(text).toContain("multipass");
    expect(text).toContain("se ignora");
    expect(text).toContain("10 min");
    expect(text).toContain("20 min");
    expect(text).toContain("structuredContent");
    expect(text).toContain("ENRICODE_ERR_TOOL_INPUT_INVALID");
    expect(text).toContain("oneOf");
    // Per-knob ranges/defaults travel on the knobs themselves.
    const video = definition.inputSchema.properties["video"] as {
      readonly properties: Record<string, { readonly description?: string }>;
    };
    expect(video.properties["segment_seconds"]?.description).toMatch(/5-600.*60/u);
    expect(video.properties["max_segments"]?.description).toMatch(/1-60/u);
  });
});

describe("F2 usage accounting survives sanitization", () => {
  it("preserves the OpenAI usage block plus hyphenated and prefixed variants", () => {
    const { tool } = createStubTool();
    const sanitized = sanitizeThroughTool(tool, {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        input_tokens: 11,
        output_tokens: 21,
        reasoning_tokens: 5,
        cache_tokens: 2,
        "prompt-tokens": 12,
        response_input_tokens: 13,
        token_usage: 1,
        tokens_used: 2,
        token_count: 3,
      },
      api_key: "secret",
      "access-token": "secret",
    });
    const usage = sanitized["usage"] as Record<string, unknown>;
    expect(usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      input_tokens: 11,
      output_tokens: 21,
      reasoning_tokens: 5,
      cache_tokens: 2,
      "prompt-tokens": 12,
      response_input_tokens: 13,
    });
    expect(sanitized).not.toHaveProperty("api_key");
    expect(sanitized).not.toHaveProperty("access-token");
  });
});

describe("F10/F22 secret-key normalization", () => {
  it("strips hyphenated secrets and bearer/signing material, keeps lookalikes", () => {
    const { tool } = createStubTool();
    const sanitized = sanitizeThroughTool(tool, {
      "api-key": "secret",
      "access-token": "secret",
      "refresh-token": "secret",
      "provider-id": "internal",
      "client-secret": "secret",
      "upload-ids": ["u1"],
      "upload-url": "https://internal.test/x",
      jwt: "secret",
      JWK: "secret",
      client_nonce: "secret",
      body_signature: "secret",
      nested: { "id-token": "secret", "jwt_token": "secret" },
      monkey: "banana",
      "mock-jwt-tracker": "counter",
      timeline: { duration_seconds: 3 },
    });
    for (const key of [
      "api-key",
      "access-token",
      "refresh-token",
      "provider-id",
      "client-secret",
      "upload-ids",
      "upload-url",
      "jwt",
      "JWK",
      "client_nonce",
      "body_signature",
    ]) {
      expect(sanitized, `leaked ${key}`).not.toHaveProperty(key);
    }
    expect((sanitized["nested"] as Record<string, unknown>) ?? {}).toEqual({});
    expect(sanitized).toHaveProperty("monkey", "banana");
    expect(sanitized).toHaveProperty("mock-jwt-tracker", "counter");
    expect(sanitized).toHaveProperty("timeline");
  });
});

describe("F3 tar stuck-offset guard", () => {
  it("fails fast after consecutive no-advance uploads instead of spinning", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r7-stuck-"));
    try {
      const first = join(temporaryDirectory, "a.png");
      const second = join(temporaryDirectory, "b.png");
      await writeFile(first, Buffer.from([137, 80, 78, 71, 1]));
      await writeFile(second, Buffer.from([137, 80, 78, 71, 2]));
      let chunkCalls = 0;
      const { tool } = createStubTool({
        appendUploadChunk: async (request: { offset: number }) => {
          chunkCalls += 1;
          return request.offset;
        },
      });
      await expect(tool.execute({ paths: [first, second] })).rejects.toThrow(
        /inconsistent upload protocol|protocolo de subida inconsistente/u,
      );
      expect(chunkCalls).toBeLessThanOrEqual(3);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("F4 50 MB response guard", () => {
  it("rejects (never resolves truncated) when two data events exceed the cap", async () => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(Buffer.alloc(26 * 1024 * 1024, 0x61));
        res.write(Buffer.alloc(26 * 1024 * 1024, 0x62));
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address() as AddressInfo;
      const client = new EnriProxyClient({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        apiKey: "k",
        timeoutMs: 60000,
      });
      await expect(client.analyze({ uploadId: "upload_1" })).rejects.toThrow(
        /maximum allowed size|tamaño máximo/u,
      );
    } finally {
      server.close();
    }
  });
});

describe("F5 boundExtraction re-probe", () => {
  it("keeps serialized output within budget for a wide-object fixture", () => {
    const extraction: Record<string, unknown> = {};
    for (let index = 0; index < 400; index += 1) {
      extraction[`field_${String(index)}`] = "v".repeat(4000);
    }
    const bounded = (
      EnriVisionServer as unknown as {
        boundExtraction(value: Record<string, unknown>): Record<string, unknown>;
      }
    ).boundExtraction(extraction);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars,
    );
    expect(Object.keys(bounded)).toHaveLength(400);
  });

  it("falls back to the omission marker when tightening cannot fit", () => {
    const extraction: Record<string, unknown> = {};
    for (let index = 0; index < 20000; index += 1) {
      extraction[`k_${String(index)}`] = "v".repeat(100);
    }
    const bounded = (
      EnriVisionServer as unknown as {
        boundExtraction(value: Record<string, unknown>): Record<string, unknown>;
      }
    ).boundExtraction(extraction);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars,
    );
    expect(JSON.stringify(bounded)).toMatch(/omitida|omitted/u);
  });
});

describe("F6/F9 uploader bounds and cadence", () => {
  it("bounds scratch by file size", () => {
    expect(resolveScratchSize(16 * 1024 * 1024, 1)).toBe(1);
    expect(resolveScratchSize(16 * 1024 * 1024, 16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    expect(resolveScratchSize(256 * 1024, 10 * 1024 * 1024)).toBe(256 * 1024);
  });

  it("re-checks identity every 16 chunks or 5 s", () => {
    const now = 1_000_000;
    expect(shouldRecheckIdentity(16, now, now)).toBe(true);
    expect(shouldRecheckIdentity(15, now, now)).toBe(false);
    expect(shouldRecheckIdentity(0, now, now - 5000)).toBe(true);
    expect(shouldRecheckIdentity(0, now, now - 4999)).toBe(false);
  });
});

describe("F7 analyze budgets", () => {
  it("caps the operator umbrella at 10/20 min by mode", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r7-budgets-"));
    try {
      const file = join(temporaryDirectory, "a.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71]));
      const seen: number[] = [];
      const tool = new AnalyzeMediaTool({
        createClient: () =>
          ({
            createUploadSession: async () => ({
              upload_id: "upload_1",
              chunk_size_bytes: 1024,
              expires_at: Date.now() + 60_000,
            }),
            getUploadOffset: async () => 0,
            appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
              request.offset + request.chunk.length,
            analyze: async (request: { timeoutMs?: number }) => {
              seen.push(request.timeoutMs ?? 0);
              return { analysis: "ok", media_type: "image", extraction: {} };
            },
          }) as never,
        defaultServerUrl: "http://127.0.0.1:8787",
        defaultApiKey: "test",
        defaultTimeoutMs: 5 * 60 * 1000,
      });
      await tool.execute({ path: file, analysisMode: "single" });
      await tool.execute({ path: file, analysisMode: "multipass" });
      // Operator budgets below the mode budget still win via Math.min.
      expect(seen[0]).toBe(5 * 60 * 1000);
      expect(seen[1]).toBe(5 * 60 * 1000);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("F8 fail-open vision probe", () => {
  it("rejects an explicit vision=false model before any session", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r7-probe-"));
    try {
      const file = join(temporaryDirectory, "a.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71]));
      let sessions = 0;
      let probes = 0;
      const { tool } = createStubTool({
        getAccountModels: async () => {
          probes += 1;
          return { data: [{ id: "no-vision", vision: false }] };
        },
        createUploadSession: async () => {
          sessions += 1;
          return { upload_id: "upload_1", chunk_size_bytes: 1024, expires_at: Date.now() + 60_000 };
        },
      });
      await expect(tool.execute({ path: file, model: "no-vision" })).rejects.toThrow(
        /no vision capability|no tiene capacidad de visi/u,
      );
      expect(probes).toBe(1);
      expect(sessions).toBe(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("stays fail-open on probe failures and unknown models, caching verdicts", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r7-probe-"));
    try {
      const file = join(temporaryDirectory, "a.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71]));
      let probes = 0;
      const { tool, analyzeCalls } = createStubTool({
        getAccountModels: async () => {
          probes += 1;
          throw new Error("network down");
        },
      });
      await tool.execute({ path: file, model: "ghost" });
      expect(analyzeCalls).toHaveLength(1);

      let cachedProbes = 0;
      const cached = createStubTool({
        getAccountModels: async () => {
          cachedProbes += 1;
          return { data: [{ id: "seer", requestModelId: "seer", vision: true }] };
        },
      });
      await cached.tool.execute({ path: file, model: "seer" });
      await cached.tool.execute({ path: file, model: "seer" });
      expect(cachedProbes).toBe(1);
      expect(cached.analyzeCalls).toHaveLength(2);
      expect(probes).toBe(1);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("F11 machine-readable error shape", () => {
  it("maps input, retryable, timeout, and abort failures to EnriCode codes", () => {
    const input = EnriVisionServer.mapToolError(
      new Error("max_frames must be an integer between 1 and 20. / max_frames debe ser un entero entre 1 y 20."),
    );
    expect(input.structuredContent).toEqual({
      code: "ENRICODE_ERR_TOOL_INPUT_INVALID",
      retryable: false,
    });

    const throttled = EnriVisionServer.mapToolError(new EnriProxyHttpError("limited", 429, {}, "{}"));
    expect(throttled.structuredContent).toEqual({
      code: "ENRICODE_ERR_TOOL_EXECUTION_FAILED",
      retryable: true,
      httpStatus: 429,
    });

    const missing = EnriVisionServer.mapToolError(new EnriProxyHttpError("gone", 404, {}, "{}"));
    expect(missing.structuredContent.retryable).toBe(false);
    expect(missing.structuredContent.httpStatus).toBe(404);

    const badRequest = EnriVisionServer.mapToolError(new EnriProxyHttpError("bad", 400, {}, "{}"));
    expect(badRequest.structuredContent.code).toBe("ENRICODE_ERR_TOOL_INPUT_INVALID");

    const timedOut = EnriVisionServer.mapToolError(
      new Error("Request timed out after 60000ms. / La petición expiró después de 60000ms"),
    );
    expect(timedOut.structuredContent).toEqual({
      code: "ENRICODE_ERR_TOOL_EXECUTION_TIMEOUT",
      retryable: true,
    });

    const aborted = EnriVisionServer.mapToolError(
      new Error("Request cancelled by the client. / La solicitud fue cancelada por el cliente."),
    );
    expect(aborted.structuredContent).toEqual({
      code: "ENRICODE_ERR_TOOL_EXECUTION_ABORTED",
      retryable: false,
    });

    const generic = EnriVisionServer.mapToolError(new Error("boom"));
    expect(generic.structuredContent.code).toBe("ENRICODE_ERR_TOOL_EXECUTION_FAILED");
    expect(generic.structuredContent.retryable).toBe(false);
    expect(generic.text).toBe("boom");
  });
});

describe("F12 transcribe inapplicability warnings", () => {
  it("warns for image sets, single images, and documents — never for video", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r7-transcribe-"));
    try {
      const first = join(temporaryDirectory, "a.png");
      const second = join(temporaryDirectory, "b.png");
      const doc = join(temporaryDirectory, "nota.pdf");
      const video = join(temporaryDirectory, "clip.mp4");
      await writeFile(first, Buffer.from([137, 80, 78, 71]));
      await writeFile(second, Buffer.from([137, 80, 78, 71]));
      await writeFile(doc, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      await writeFile(video, Buffer.from([0, 0, 0, 1]));
      const { tool } = createStubTool();

      const setResult = await tool.execute({ paths: [first, second], transcribe: true });
      expect(setResult.warnings?.join(" ")).toMatch(/no effect on multi-image sets|no tiene efecto/u);

      const imageResult = await tool.execute({ path: first, transcribe: true });
      expect(imageResult.warnings?.join(" ")).toMatch(/no effect on images|no tiene efecto/u);

      const docResult = await tool.execute({ path: doc, transcribe: true });
      expect(docResult.warnings?.join(" ")).toMatch(/no effect on documents|no tiene efecto/u);

      const videoResult = await tool.execute({ path: video, transcribe: false });
      expect(videoResult.warnings).toBeUndefined();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("F13 remote advisory gates", () => {
  it("warns (never fails) on extension-guessed mismatches; stays silent otherwise", async () => {
    const sizeCapFetcher = {
      fetch: async (): Promise<never> => {
        throw new Error(
          `${MediaUrlFetcher.URL_SIZE_CAP_MARKER} Remote file exceeds the 64 MiB limit. / El archivo remoto excede el límite de 64 MiB.`,
        );
      },
    } as unknown as MediaUrlFetcherType;
    const { tool, analyzeCalls } = createStubTool({}, sizeCapFetcher);

    const warned = await tool.execute({
      path: "https://example.test/movie.mp4",
      document: { maxPagesTotal: 5 },
    });
    expect(analyzeCalls[0]).toMatchObject({ sourceUrl: "https://example.test/movie.mp4" });
    expect(warned.warnings?.join(" ")).toMatch(/advisory.*server decides/u);

    const silent = await tool.execute({ path: "https://example.test/download" });
    expect(silent.warnings).toBeUndefined();
  });
});

describe("F15 codepoint-safe labels and bounded media_type", () => {
  it("never splits surrogate pairs and flattens hostile media types", () => {
    const format = (
      EnriVisionServer as unknown as {
        formatAnalysisText(
          analysis: string,
          mediaType: string,
          elements: ReadonlyArray<{ readonly label: string; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }>,
        ): string;
      }
    ).formatAnalysisText;
    const astral = "😀".repeat(300);
    const text = format("ok", "image", [
      { label: astral, box: { x: 0, y: 0, width: 1, height: 1 } },
    ]);
    const labelLine: string = text.split("\n").find((line: string): boolean => line.startsWith("- ")) ?? "";
    const labelText: string = labelLine.slice(2).split(" [")[0] ?? "";
    expect(Array.from(labelText).length).toBeLessThanOrEqual(200);
    expect(labelText).not.toMatch(/�/u);

    const hostile = format("ok", "video\r\ninjected: x", undefined);
    expect(hostile.split("\n")[0]).toBe("ANÁLISIS (video injected: x) / ANALYSIS (video injected: x):");
  });
});

describe("F16 tar-overhead fail-fast estimate", () => {
  it("estimates raw + headers + manifest + padding + end marker", () => {
    // R8: the manifest term budgets 256 B of envelope plus 512 B per entry
    // (worst case: 255 B basenames), so (256 + 2 * 512) pads to 1536.
    expect(estimateMediaSetTarBytes(1000, 2)).toBe(1000 + 2 * 512 + 512 + 1536 + 2 * 511 + 1024);
    const nearCeiling: number = ANALYZE_MEDIA_LIMITS.maxUploadBytes - 10000;
    expect(estimateMediaSetTarBytes(nearCeiling, 100)).toBeGreaterThan(
      ANALYZE_MEDIA_LIMITS.maxUploadBytes,
    );
    expect(estimateMediaSetTarBytes(0, 0)).toBe(512 + 512 + 1024);
  });
});

describe("F17 retry/timeout alignment pins", () => {
  it("uses 3 chunk attempts with 60 s create / 15 s probe budgets and the 125000 divisor", async () => {
    expect(CREATE_CONTROL_TIMEOUT_MS).toBe(60_000);
    expect(PROBE_CONTROL_TIMEOUT_MS).toBe(15_000);
    expect(ACCOUNT_MODELS_PROBE_TIMEOUT_MS).toBe(ANALYZE_MEDIA_LIMITS.visionProbeTimeoutMs);
    expect(resolveChunkTimeoutMs(8 * 1024 * 1024, 600000)).toBe(68000);
    expect(resolveUploadDeadlineMs(125000)).toBe(61000);

    let calls = 0;
    const uploader = new AnalyzeMediaResumableUploader();
    const failing = {
      getUploadOffset: async (): Promise<number> => 0,
      appendUploadChunk: async (): Promise<never> => {
        calls += 1;
        throw new EnriProxyHttpError("busy", 500, {}, "busy");
      },
    };
    await expect(
      uploader.uploadChunkWithRetry(failing as never, "upload-1", 0, Buffer.from("xy"), 1000),
    ).rejects.toThrow(/busy/u);
    expect(calls).toBe(3);
  });
});

describe("F18 schema/parser coercion agreement", () => {
  it("declares string forms for every knob the parser coerces", () => {
    const definition = readDefinition();
    const properties = definition.inputSchema.properties as Record<
      string,
      { readonly type?: string | ReadonlyArray<string> }
    >;
    const asSet = (type: string | ReadonlyArray<string> | undefined): Set<string> =>
      new Set(Array.isArray(type) ? [...type] : [type]);
    expect(asSet(properties["max_frames"]?.type).has("string")).toBe(true);
    expect(asSet(properties["max_frames"]?.type).has("integer")).toBe(true);
    expect(asSet(properties["maxSegments"]?.type).has("string")).toBe(true);
    expect(asSet(properties["transcribe"]?.type).has("boolean")).toBe(true);
    expect(asSet(properties["transcribe"]?.type).has("string")).toBe(true);
    expect(asSet(properties["clip_start_seconds"]?.type).has("number")).toBe(true);
    expect(asSet(properties["clip_start_seconds"]?.type).has("string")).toBe(true);
    const video = properties["video"] as {
      readonly properties: Record<string, { readonly type?: string | ReadonlyArray<string> }>;
    };
    expect(asSet(video.properties["max_segments"]?.type).has("string")).toBe(true);
    // Round trip: the parser accepts the declared string form.
    const { tool } = createStubTool();
    expect(
      tool.parseParams({ path: "C:\\Users\\User\\Downloads\\clip.mp4", max_frames: "8" }).maxFrames,
    ).toBe(8);
  });
});

describe("F19 shared clip-clamp warning", () => {
  it("emits identical Spanish-first warnings on the parser and client paths", async () => {
    const { tool } = createStubTool();
    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      video: { clip_start_seconds: 86300, clip_duration_seconds: 200 },
    });
    const direct: string = buildClipWindowClampedWarning(86300, 200, 100, 86400);
    expect(params.warnings?.[0]).toBe(direct);
    expect(direct).toMatch(/^La ventana pedida/u);
    expect(direct).toContain("Requested clip window (start 86300 s");

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address() as AddressInfo;
      const client = new EnriProxyClient({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        apiKey: "k",
        timeoutMs: 5000,
      });
      const response = await client.analyze({
        uploadId: "upload_1",
        video: { clipStartSeconds: 86300, clipDurationSeconds: 200 },
      });
      expect(response.warnings?.[0]).toBe(direct);
    } finally {
      server.close();
    }
  });
});

describe("F20 win32 strict-mode documentation", () => {
  it("documents the advisory O_NOFOLLOW limit in the operator README", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme: string = await readFile("README.md", "utf8");
    expect(readme).toContain("O_NOFOLLOW");
    expect(readme).toMatch(/Windows|win32/u);
  });
});
