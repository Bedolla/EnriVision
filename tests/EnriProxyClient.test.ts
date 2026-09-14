/**
 * Tests for EnriVision EnriProxyClient request payloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";

/**
 * Recorded HTTP request payload for assertions.
 */
interface RecordedRequest {
  /**
   * Request URL.
   */
  readonly url: string;

  /**
   * HTTP method.
   */
  readonly method: string;

  /**
   * Request headers.
   */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Parsed JSON body.
   */
  readonly body: Record<string, unknown>;
}

/**
 * Reads and parses a JSON request body.
 *
 * @param req - Incoming HTTP request
 * @returns Parsed JSON object
 */
const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

/**
 * Starts a temporary HTTP server for request capture.
 *
 * @param handler - Request handler
 * @returns Server instance and base URL
 */
const startServer = async (
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ readonly server: Server; readonly baseUrl: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

describe("EnriProxyClient request payloads", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        server?.close(() => resolve());
      } catch {
        resolve();
      }
    });
    server = null;
  });

  it("sends clip window fields for analyze requests", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.analyze({
      uploadId: "upload-123",
      analysisMode: "multipass",
      maxFrames: 6,
      transcribe: false,
      transcriptionLanguage: "es",
      video: {
        clipStartSeconds: 12.5,
        clipDurationSeconds: 30,
        segmentSeconds: 60,
        maxSegments: 3,
        maxFramesPerSegment: 8
      },
      audio: {
        timestamps: true,
        segmentSeconds: 15,
        maxSegments: 10
      }
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.url).toBe("/v1/vision/analyze");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe("Bearer test-key");
    expect(recorded?.body).toMatchObject({
      upload_id: "upload-123",
      analysis_mode: "multipass",
      max_frames: 6,
      transcribe: false,
      transcription_language: "es",
      video: {
        clip_start_seconds: 12.5,
        clip_duration_seconds: 30,
        segment_seconds: 60,
        max_segments: 3,
        max_frames_per_segment: 8
      },
      audio: {
        timestamps: true,
        segment_seconds: 15,
        max_segments: 10
      }
    });
  });

  it("rejects invalid clip windows in Spanish instead of coercing them", async () => {
    const started = await startServer(async (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await expect(
      client.analyze({ uploadId: "upload-123", video: { clipStartSeconds: -5 } })
    ).rejects.toThrow("video.clip_start_seconds debe ser un número entre 0 y 86400 (segundos).");
    await expect(
      client.analyze({ uploadId: "upload-123", video: { clipDurationSeconds: 0 } })
    ).rejects.toThrow("video.clip_duration_seconds debe ser un número mayor que 0");
    await expect(
      client.analyze({ uploadId: "upload-123", video: { clipDurationSeconds: -3 } })
    ).rejects.toThrow("video.clip_duration_seconds debe ser un número mayor que 0");
    await expect(
      client.analyze({ uploadId: "upload-123", video: { clipStartSeconds: Number.NaN } })
    ).rejects.toThrow("video.clip_start_seconds debe ser un número entre 0 y 86400 (segundos).");
  });

  it("forwards parser-derived end-minus-start windows verbatim", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    // Parity with AnalyzeMediaParamParser: clip_start_seconds 12 + clip_end_seconds 34
    // derives clipDurationSeconds 22, which the client must forward untouched.
    await client.analyze({ uploadId: "upload-123", video: { clipStartSeconds: 12, clipDurationSeconds: 22 } });

    const video = recorded?.body["video"] as Record<string, unknown> | undefined;
    expect(video?.["clip_start_seconds"]).toBe(12);
    expect(video?.["clip_duration_seconds"]).toBe(22);
  });

  it("omits the clip window when both bounds are undefined", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ analysis: "ok", media_type: "video", extraction: {} }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.analyze({ uploadId: "upload-123", video: { segmentSeconds: 60 } });

    const video = recorded?.body["video"] as Record<string, unknown> | undefined;
    expect(video).toMatchObject({ segment_seconds: 60 });
    expect(video?.["clip_start_seconds"]).toBeUndefined();
    expect(video?.["clip_duration_seconds"]).toBeUndefined();
  });

  it("sends upload session payload with correct keys", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ upload_id: "up-1", chunk_size_bytes: 1024, expires_at: 123456789 }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 123,
      contentType: "video/mp4",
      clientTraceId: "trace-1"
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.url).toBe("/v1/uploads");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe("Bearer test-key");
    expect(recorded?.body).toMatchObject({
      filename: "clip.mp4",
      size_bytes: 123,
      content_type: "video/mp4",
      client_trace_id: "trace-1"
    });
  });

  it("embeds the parsed Spanish server detail in HTTP errors", async () => {
    const started = await startServer(async (_req, res) => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "La cuota de análisis se agotó.", code: "quota" } }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    const failure = await client
      .createUploadSession({ filename: "clip.mp4", sizeBytes: 10, contentType: "video/mp4" })
      .then(
        () => null,
        (error: unknown) => error as { message: string; status: number; body: string }
      );

    expect(failure).not.toBeNull();
    expect(failure?.status).toBe(400);
    expect(failure?.message).toMatch(/HTTP 400/u);
    expect(failure?.message).toMatch(/La cuota de análisis se agotó/u);
    expect(failure?.body).toContain("cuota");
  });

  it("reports non-JSON success bodies with a Spanish error", async () => {
    const started = await startServer(async (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end("<html><body>proxy caído</body></html>");
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await expect(client.analyze({ uploadId: "upload-123" })).rejects.toThrow(
      /no es JSON válido.*HTTP 200/u
    );
    await expect(client.analyze({ uploadId: "upload-123" })).rejects.not.toThrow(/Unexpected token/u);
  });

  it("reports missing or invalid Upload-Offset headers in Spanish", async () => {
    const missing = await startServer(async (_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    server = missing.server;

    const client = new EnriProxyClient({
      baseUrl: missing.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await expect(client.getUploadOffset("upload-123")).rejects.toThrow(/Upload-Offset/u);
  });
});
