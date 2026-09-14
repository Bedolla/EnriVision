import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaExtractionSanitizer } from "../src/tools/AnalyzeMediaExtractionSanitizer.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";
import { EnriVisionServer } from "../src/server/EnriVisionServer.js";

const PNG_PATH = "C:\\Users\\User\\Downloads\\a.png";
const MP4_PATH = "C:\\Users\\User\\Downloads\\a.mp4";

afterEach(() => {
  delete process.env["ENRIVISION_MODEL"];
  delete process.env["ENRIVISION_DEFAULT_LANGUAGE"];
});

describe("Proxy-aligned knob ranges (auditoría Analyze Media R1)", () => {
  it("caps video/audio segments at 60 like VisionAnalysisHandler", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(
      parser.parseParams({ path: MP4_PATH, video: { max_segments: 60 } }).video?.maxSegments
    ).toBe(60);
    expect(() => parser.parseParams({ path: MP4_PATH, video: { max_segments: 61 } })).toThrow(
      /video\.max_segments.*1.*60/u
    );
    expect(() => parser.parseParams({ path: MP4_PATH, audio: { max_segments: 2000 } })).toThrow(
      /audio\.max_segments.*1.*60/u
    );
  });

  it("caps document and image-set knobs at the proxy values", () => {
    const parser = new AnalyzeMediaParamParser();
    const doc = parser.parseParams({
      path: "C:\\Users\\User\\Downloads\\a.pdf",
      document: {
        max_pages_total: 200,
        pages_per_batch: 200,
        max_images_per_batch: 0,
        scanned_text_threshold_chars: 5000
      }
    });
    expect(doc.document?.maxPagesTotal).toBe(200);
    expect(doc.document?.maxImagesPerBatch).toBe(0);
    expect(() =>
      parser.parseParams({ path: PNG_PATH, document: { max_pages_total: 201 } })
    ).toThrow(/document\.max_pages_total.*1.*200/u);
    expect(() =>
      parser.parseParams({ path: PNG_PATH, document: { scanned_text_threshold_chars: 5001 } })
    ).toThrow(/document\.scanned_text_threshold_chars.*0.*5000/u);
    expect(() =>
      parser.parseParams({ paths: [PNG_PATH], images: { max_images_total: 501 } })
    ).toThrow(/images\.max_images_total.*1.*500/u);
    expect(() =>
      parser.parseParams({ paths: [PNG_PATH], images: { images_per_batch: 21 } })
    ).toThrow(/images\.images_per_batch.*1.*20/u);
    expect(() =>
      parser.parseParams({ paths: [PNG_PATH], images: { max_dimension: 255 } })
    ).toThrow(/images\.max_dimension.*256.*4096/u);
  });
});

describe("Unknown nested keys (auditoría Analyze Media R1)", () => {
  it("rejects typos inside tuning objects instead of ignoring them", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(() =>
      parser.parseParams({ path: MP4_PATH, video: { segement_seconds: 60 } })
    ).toThrow(/video.*desconocidas.*segement_seconds/u);
    expect(() =>
      parser.parseParams({ path: PNG_PATH, document: { max_pages_totall: 10 } })
    ).toThrow(/document.*desconocidas.*max_pages_totall/u);
    expect(() => parser.parseParams({ path: MP4_PATH, audio: { foo: 1 } })).toThrow(
      /audio.*desconocidas/u
    );
    expect(() => parser.parseParams({ paths: [PNG_PATH], images: { bar: 1 } })).toThrow(
      /images.*desconocidas/u
    );
  });

  it("accepts every documented alias spelling", () => {
    const parser = new AnalyzeMediaParamParser();
    const params = parser.parseParams({
      path: "C:\\Users\\User\\Downloads\\a.pdf",
      document: { max_pages: 10, maxPages: undefined }
    });
    expect(params.document?.maxPagesTotal).toBe(10);
    const audio = parser.parseParams({ path: MP4_PATH, audioTimestamps: true });
    expect(audio.audio?.timestamps).toBe(true);
  });

  it("validates the optional model hint", () => {
    const parser = new AnalyzeMediaParamParser();
    expect(parser.parseParams({ path: PNG_PATH, model: "muse-spark" }).model).toBe("muse-spark");
    expect(parser.parseParams({ path: PNG_PATH }).model).toBeUndefined();
    expect(() => parser.parseParams({ path: PNG_PATH, model: 42 })).toThrow(/model.*auto-dispatch/u);
  });
});

describe("Extraction sanitizer coverage allowlist (auditoría Analyze Media R1)", () => {
  it("preserves multipass/coverage metadata and strips ids/secrets/provider", () => {
    const sanitizer = new AnalyzeMediaExtractionSanitizer();
    const sanitized = sanitizer.sanitize({
      upload_id: "upload_1",
      provider: "some-provider",
      api_key: "secret",
      detected_media_type: "video",
      analysis_mode_used: "multipass",
      multipass: { map: { models: ["m1"] } },
      models: ["m1"],
      warnings: ["w1"],
      frame_count: 3,
      timeline: { type: "video" },
      token_usage: { total: 5 }
    });
    expect(sanitized).not.toHaveProperty("upload_id");
    expect(sanitized).not.toHaveProperty("provider");
    expect(sanitized).not.toHaveProperty("api_key");
    expect(sanitized).toHaveProperty("detected_media_type", "video");
    expect(sanitized).toHaveProperty("analysis_mode_used", "multipass");
    expect(sanitized).toHaveProperty("multipass");
    expect(sanitized).toHaveProperty("models", ["m1"]);
    expect(sanitized).toHaveProperty("warnings", ["w1"]);
    expect(sanitized).toHaveProperty("timeline");
    expect(sanitized).toHaveProperty("token_usage");
  });
});

describe("Content-type exact matching (auditoría Analyze Media R1)", () => {
  it("rejects substring-spoofed office types and accepts the exact set", () => {
    expect(
      MediaUrlFetcher.isAllowedMediaContentType("application/x-wordprocessing-evil")
    ).toBe(false);
    expect(MediaUrlFetcher.isAllowedMediaContentType("application/vnd.evil-spreadsheet-foo")).toBe(
      false
    );
    expect(
      MediaUrlFetcher.isAllowedMediaContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe(true);
    expect(
      MediaUrlFetcher.isAllowedMediaContentType("application/vnd.oasis.opendocument.text")
    ).toBe(true);
    expect(MediaUrlFetcher.isAllowedMediaContentType("image/png")).toBe(true);
  });
});

describe("Redirect budget parity (auditoría Analyze Media R1)", () => {
  it("follows a 4-hop chain like EnriCode", async () => {
    const png: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const hops: readonly string[] = [
      "https://example.test/r0.png",
      "https://example.test/r1.png",
      "https://example.test/r2.png",
      "https://example.test/r3.png",
      "https://example.test/final.png"
    ];
    const stub = (async (url: unknown): Promise<Response> => {
      const index: number = hops.indexOf(String(url));
      if (index >= 0 && index < hops.length - 1) {
        return new Response(new Uint8Array([]), {
          status: 302,
          headers: { location: hops[index + 1]! }
        });
      }
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }) as unknown as typeof fetch;
    const fetcher = new MediaUrlFetcher(stub, async () => ["93.184.216.34"]);
    const result = await fetcher.fetch("https://example.test/r0.png");
    expect(result.contentType).toBe("image/png");
    await result.cleanup();
  });
});

/**
 * Creates stub client deps capturing every analyze call.
 *
 * @param analyzeCalls - Mutable array receiving analyze payloads.
 * @returns Deps bundle with a stub client factory.
 */
function createCapturingDeps(analyzeCalls: unknown[]): {
  createClient: () => unknown;
  defaultServerUrl: string;
  defaultApiKey: string;
  defaultTimeoutMs: number;
} {
  return {
    createClient: () =>
      ({
        createUploadSession: async () => ({
          upload_id: "upload_1",
          chunk_size_bytes: 1024 * 1024,
          expires_at: Date.now() + 60_000
        }),
        getUploadOffset: async () => 0,
        appendUploadChunk: async (request: { offset: number; chunk: Buffer }) =>
          request.offset + request.chunk.length,
        analyze: async (params: unknown) => {
          analyzeCalls.push(params);
          return { analysis: "ok", media_type: "image", extraction: {} };
        }
      }) as unknown as never,
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 30 * 60 * 1000
  };
}

describe("Model affinity and language env (auditoría Analyze Media R1)", () => {
  it("sends explicit model, falls back to ENRIVISION_MODEL, then omits", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r1-"));
    try {
      const filePath = join(temporaryDirectory, "a.png");
      await writeFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const analyzeCalls: unknown[] = [];
      const tool = new AnalyzeMediaTool(createCapturingDeps(analyzeCalls) as never);

      await tool.execute({ path: filePath, model: "explicit-model" });
      expect((analyzeCalls[0] as Record<string, unknown>)["model"]).toBe("explicit-model");

      process.env["ENRIVISION_MODEL"] = "env-model";
      await tool.execute({ path: filePath });
      expect((analyzeCalls[1] as Record<string, unknown>)["model"]).toBe("env-model");

      delete process.env["ENRIVISION_MODEL"];
      await tool.execute({ path: filePath });
      expect("model" in ((analyzeCalls[2] as Record<string, unknown>) ?? {})).toBe(false);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("ignores invalid ENRIVISION_DEFAULT_LANGUAGE and honors explicit language", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r1-"));
    try {
      const filePath = join(temporaryDirectory, "a.png");
      await writeFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const analyzeCalls: unknown[] = [];
      const tool = new AnalyzeMediaTool(createCapturingDeps(analyzeCalls) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      process.env["ENRIVISION_DEFAULT_LANGUAGE"] = "!!!no-es-idioma!!!";
      await tool.execute({ path: filePath });
      expect((analyzeCalls[0] as Record<string, unknown>)["language"]).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();

      process.env["ENRIVISION_DEFAULT_LANGUAGE"] = "es";
      await tool.execute({ path: filePath, language: "en" });
      expect((analyzeCalls[1] as Record<string, unknown>)["language"]).toBe("en");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("scales the analyze timeout by mode (single 10 min, multipass/auto 20 min)", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r1-"));
    try {
      const filePath = join(temporaryDirectory, "a.png");
      await writeFile(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const analyzeCalls: unknown[] = [];
      const tool = new AnalyzeMediaTool(createCapturingDeps(analyzeCalls) as never);

      await tool.execute({ path: filePath, analysisMode: "single" });
      await tool.execute({ path: filePath, analysisMode: "multipass" });
      await tool.execute({ path: filePath });
      expect((analyzeCalls[0] as Record<string, unknown>)["timeoutMs"]).toBe(10 * 60 * 1000);
      expect((analyzeCalls[1] as Record<string, unknown>)["timeoutMs"]).toBe(20 * 60 * 1000);
      expect((analyzeCalls[2] as Record<string, unknown>)["timeoutMs"]).toBe(20 * 60 * 1000);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("Running upload-ceiling pre-check (auditoría Analyze Media R1)", () => {
  it("fails before uploading once resolved bytes exceed 4 GiB", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "enrivision-r1-"));
    try {
      const first = join(temporaryDirectory, "big1.png");
      const second = join(temporaryDirectory, "big2.png");
      await writeFile(first, new Uint8Array([1]));
      await writeFile(second, new Uint8Array([2]));
      await truncate(first, 3 * 1024 * 1024 * 1024);
      await truncate(second, 3 * 1024 * 1024 * 1024);
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      await expect(resolver.resolve({ paths: [first, second] })).rejects.toThrow(/4 GiB/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("Structured-content prototype guard (auditoría Analyze Media R1)", () => {
  it("drops __proto__ keys while bounding long strings", () => {
    const reader = EnriVisionServer as unknown as {
      cutLongStrings(value: unknown, perString: number): unknown;
    };
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"note":" nota "}'
    ) as Record<string, unknown>;
    const bounded = reader.cutLongStrings(payload, 4) as Record<string, unknown>;
    expect(Object.hasOwn(bounded, "__proto__")).toBe(false);
    expect((globalThis as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(typeof bounded["note"]).toBe("string");
  });
});
