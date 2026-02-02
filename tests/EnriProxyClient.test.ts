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
});
