/**
 * ENRIPROXY CLIENT
 *
 * Minimal HTTP client for EnriProxy endpoints used by EnriVision:
 * - POST  /v1/uploads
 * - HEAD  /v1/uploads/:id
 * - PATCH /v1/uploads/:id
 * - POST  /v1/vision/analyze
 *
 * @module client/EnriProxyClient
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

/**
 * Connection configuration for {@link EnriProxyClient}.
 */
export interface EnriProxyClientConfig {
  /**
   * EnriProxy base URL (e.g., https://proxy.example.com).
   */
  readonly baseUrl: string;

  /**
   * EnriProxy API key (sent as Authorization: Bearer ...).
   */
  readonly apiKey: string;

  /**
   * Default request timeout in milliseconds.
   */
  readonly timeoutMs: number;
}

/**
 * Response from POST `/v1/uploads`.
 */
export interface CreateUploadSessionResponse {
  /**
   * Upload session identifier.
   */
  readonly upload_id: string;

  /**
   * Recommended chunk size in bytes.
   */
  readonly chunk_size_bytes: number;

  /**
   * Expiration timestamp in ms since epoch.
   */
  readonly expires_at: number;
}

/**
 * Response from POST `/v1/vision/analyze`.
 */
export interface AnalyzeVisionResponse {
  /**
   * Text analysis.
   */
  readonly analysis: string;

  /**
   * Detected media type.
   */
  readonly media_type: string;

  /**
   * Extraction metadata.
   */
  readonly extraction: Record<string, unknown>;
}

/**
 * Error thrown when EnriProxy returns a non-2xx HTTP response.
 */
export class EnriProxyHttpError extends Error {
  /**
   * HTTP status code returned by the server.
   */
  public readonly status: number;

  /**
   * Response headers returned by the server.
   */
  public readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Response body returned by the server (best-effort UTF-8).
   */
  public readonly body: string;

  /**
   * Creates a new {@link EnriProxyHttpError}.
   *
   * @param message - Error message
   * @param status - HTTP status code
   * @param headers - Response headers
   * @param body - Response body
   */
  public constructor(
    message: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
    body: string
  ) {
    super(message);
    this.name = "EnriProxyHttpError";
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * Result of a simple HTTP request.
 */
interface HttpResult {
  /**
   * HTTP status code.
   */
  readonly status: number;

  /**
   * Response headers.
   */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Response body as string.
   */
  readonly body: string;
}

/**
 * Minimal client for EnriProxy HTTP endpoints.
 */
export class EnriProxyClient {
  /**
   * EnriProxy base URL.
   */
  private readonly baseUrl: string;

  /**
   * API key for Authorization header.
   */
  private readonly apiKey: string;

  /**
   * Default timeout for requests.
   */
  private readonly timeoutMs: number;

  /**
   * Creates a new {@link EnriProxyClient}.
   *
   * @param config - Client configuration
   */
  public constructor(config: EnriProxyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Creates an upload session on the server.
   *
   * @param params - Session parameters
   * @returns Session response
   */
  public async createUploadSession(params: {
    /**
     * Original filename.
     */
    readonly filename: string;

    /**
     * Total file size in bytes.
     */
    readonly sizeBytes: number;

    /**
     * MIME type.
     */
    readonly contentType: string;

    /**
     * Optional client trace id.
     */
    readonly clientTraceId?: string;
  }): Promise<CreateUploadSessionResponse> {
    const url = this.buildUrl("/v1/uploads");
    const payload = {
      filename: params.filename,
      size_bytes: params.sizeBytes,
      content_type: params.contentType,
      client_trace_id: params.clientTraceId
    };

    const result = await this.requestJson("POST", url, payload, this.timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `Failed to create upload session (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    const parsed = JSON.parse(result.body) as CreateUploadSessionResponse;
    return parsed;
  }

  /**
   * Queries the current upload offset for a session.
   *
   * @param uploadId - Upload id
   * @returns Offset in bytes
   */
  public async getUploadOffset(uploadId: string): Promise<number> {
    const url = this.buildUrl(`/v1/uploads/${encodeURIComponent(uploadId)}`);
    const result = await this.requestRaw("HEAD", url, undefined, undefined, this.timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `Failed to query upload offset (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    const offsetHeader = this.getHeaderValue(result.headers, "upload-offset");
    if (!offsetHeader) {
      throw new Error("Missing Upload-Offset header in server response.");
    }

    const offset = Number.parseInt(offsetHeader, 10);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error(`Invalid Upload-Offset header: ${offsetHeader}`);
    }

    return offset;
  }

  /**
   * Appends a chunk to an upload session.
   *
   * @param params - Chunk parameters
   * @returns New upload offset in bytes
   */
  public async appendUploadChunk(params: {
    /**
     * Upload session id.
     */
    readonly uploadId: string;

    /**
     * Expected offset in bytes.
     */
    readonly offset: number;

    /**
     * Chunk bytes.
     */
    readonly chunk: Buffer;

    /**
     * Optional timeout override in milliseconds.
     */
    readonly timeoutMs?: number;
  }): Promise<number> {
    const url = this.buildUrl(`/v1/uploads/${encodeURIComponent(params.uploadId)}`);
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": String(params.offset),
      "Content-Length": String(params.chunk.length)
    };

    const result = await this.requestRaw("PATCH", url, headers, params.chunk, timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `Failed to upload chunk (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    const offsetHeader = this.getHeaderValue(result.headers, "upload-offset");
    if (!offsetHeader) {
      throw new Error("Missing Upload-Offset header in server response.");
    }

    const newOffset = Number.parseInt(offsetHeader, 10);
    if (!Number.isFinite(newOffset) || newOffset < 0) {
      throw new Error(`Invalid Upload-Offset header: ${offsetHeader}`);
    }

    return newOffset;
  }

  /**
   * Triggers server-side vision analysis for an uploaded file.
   *
   * @param params - Analysis parameters
   * @returns Analysis response
   */
  public async analyze(params: {
    /**
     * Upload session id.
     */
    readonly uploadId: string;

    /**
     * Optional analysis context hint.
     */
    readonly context?: string;

    /**
     * Optional explicit question.
     */
    readonly question?: string;

    /**
     * Preferred response language.
     */
    readonly language?: string;

    /**
     * Optional max frames override for videos.
     */
    readonly maxFrames?: number;

    /**
     * Optional override for transcription on videos.
     */
    readonly transcribe?: boolean;

    /**
     * Optional transcription language hint.
     */
    readonly transcriptionLanguage?: string;

    /**
     * Optional analysis mode selector.
     */
    readonly analysisMode?: "auto" | "single" | "multipass";

    /**
     * Optional video multipass tuning.
     */
    readonly video?: {
      /**
       * Clip start offset in seconds for targeted analysis.
       */
      readonly clipStartSeconds?: number;

      /**
       * Clip duration in seconds for targeted analysis.
       */
      readonly clipDurationSeconds?: number;

      /**
       * Segment duration in seconds.
       */
      readonly segmentSeconds?: number;

      /**
       * Maximum number of segments to analyze.
       */
      readonly maxSegments?: number;

      /**
       * Maximum frames per segment.
       */
      readonly maxFramesPerSegment?: number;
    };

    /**
     * Optional document multipass tuning (PDF).
     */
    readonly document?: {
      /**
       * Maximum pages to analyze in total.
       */
      readonly maxPagesTotal?: number;

      /**
       * Pages per batch.
       */
      readonly pagesPerBatch?: number;

      /**
       * Maximum rendered pages per batch.
       */
      readonly maxImagesPerBatch?: number;

      /**
       * Minimum extracted text length to treat a page as textual.
       */
      readonly scannedTextThresholdChars?: number;
    };

    /**
     * Optional audio multipass tuning.
     */
    readonly audio?: {
      /**
       * Whether to include timestamped segments in the extracted transcript.
       */
      readonly timestamps?: boolean;

      /**
       * Segment duration in seconds for audio multipass.
       */
      readonly segmentSeconds?: number;

      /**
       * Maximum number of audio segments to analyze.
       */
      readonly maxSegments?: number;
    };

    /**
     * Optional image-set multipass tuning.
     */
    readonly images?: {
      /**
       * Maximum number of images to analyze in total.
       */
      readonly maxImagesTotal?: number;

      /**
       * Images per batch for multipass map calls.
       */
      readonly imagesPerBatch?: number;

      /**
       * Maximum dimension for images (width/height).
       */
      readonly maxDimension?: number;
    };
  }): Promise<AnalyzeVisionResponse> {
    const url = this.buildUrl("/v1/vision/analyze");
    const payload: Record<string, unknown> = {
      upload_id: params.uploadId
    };

    if (typeof params.context === "string" && params.context.trim()) payload["context"] = params.context.trim();
    if (typeof params.question === "string" && params.question.trim()) payload["question"] = params.question.trim();
    if (typeof params.language === "string" && params.language.trim()) payload["language"] = params.language.trim();
    if (typeof params.maxFrames === "number" && Number.isFinite(params.maxFrames)) payload["max_frames"] = params.maxFrames;
    if (typeof params.transcribe === "boolean") payload["transcribe"] = params.transcribe;
    if (typeof params.transcriptionLanguage === "string" && params.transcriptionLanguage.trim()) {
      payload["transcription_language"] = params.transcriptionLanguage.trim();
    }

    if (typeof params.analysisMode === "string" && params.analysisMode.trim()) {
      payload["analysis_mode"] = params.analysisMode.trim();
    }

    if (params.video && typeof params.video === "object") {
      const videoPayload: Record<string, unknown> = {};
      if (typeof params.video.clipStartSeconds === "number" && Number.isFinite(params.video.clipStartSeconds)) {
        videoPayload["clip_start_seconds"] = Math.max(0, params.video.clipStartSeconds);
      }
      if (
        typeof params.video.clipDurationSeconds === "number" &&
        Number.isFinite(params.video.clipDurationSeconds) &&
        params.video.clipDurationSeconds > 0
      ) {
        videoPayload["clip_duration_seconds"] = params.video.clipDurationSeconds;
      }
      if (typeof params.video.segmentSeconds === "number" && Number.isFinite(params.video.segmentSeconds)) {
        videoPayload["segment_seconds"] = params.video.segmentSeconds;
      }
      if (typeof params.video.maxSegments === "number" && Number.isFinite(params.video.maxSegments)) {
        videoPayload["max_segments"] = Math.floor(params.video.maxSegments);
      }
      if (typeof params.video.maxFramesPerSegment === "number" && Number.isFinite(params.video.maxFramesPerSegment)) {
        videoPayload["max_frames_per_segment"] = Math.floor(params.video.maxFramesPerSegment);
      }
      if (Object.keys(videoPayload).length > 0) {
        payload["video"] = videoPayload;
      }
    }

    if (params.document && typeof params.document === "object") {
      const documentPayload: Record<string, unknown> = {};
      if (typeof params.document.maxPagesTotal === "number" && Number.isFinite(params.document.maxPagesTotal)) {
        documentPayload["max_pages_total"] = Math.floor(params.document.maxPagesTotal);
      }
      if (typeof params.document.pagesPerBatch === "number" && Number.isFinite(params.document.pagesPerBatch)) {
        documentPayload["pages_per_batch"] = Math.floor(params.document.pagesPerBatch);
      }
      if (typeof params.document.maxImagesPerBatch === "number" && Number.isFinite(params.document.maxImagesPerBatch)) {
        documentPayload["max_images_per_batch"] = Math.floor(params.document.maxImagesPerBatch);
      }
      if (
        typeof params.document.scannedTextThresholdChars === "number" &&
        Number.isFinite(params.document.scannedTextThresholdChars)
      ) {
        documentPayload["scanned_text_threshold_chars"] = Math.floor(params.document.scannedTextThresholdChars);
      }
      if (Object.keys(documentPayload).length > 0) {
        payload["document"] = documentPayload;
      }
    }

    if (params.audio && typeof params.audio === "object") {
      const audioPayload: Record<string, unknown> = {};
      if (typeof params.audio.timestamps === "boolean") {
        audioPayload["timestamps"] = params.audio.timestamps;
      }
      if (typeof params.audio.segmentSeconds === "number" && Number.isFinite(params.audio.segmentSeconds)) {
        audioPayload["segment_seconds"] = params.audio.segmentSeconds;
      }
      if (typeof params.audio.maxSegments === "number" && Number.isFinite(params.audio.maxSegments)) {
        audioPayload["max_segments"] = Math.floor(params.audio.maxSegments);
      }
      if (Object.keys(audioPayload).length > 0) {
        payload["audio"] = audioPayload;
      }
    }

    if (params.images && typeof params.images === "object") {
      const imagesPayload: Record<string, unknown> = {};
      if (typeof params.images.maxImagesTotal === "number" && Number.isFinite(params.images.maxImagesTotal)) {
        imagesPayload["max_images_total"] = Math.floor(params.images.maxImagesTotal);
      }
      if (typeof params.images.imagesPerBatch === "number" && Number.isFinite(params.images.imagesPerBatch)) {
        imagesPayload["images_per_batch"] = Math.floor(params.images.imagesPerBatch);
      }
      if (typeof params.images.maxDimension === "number" && Number.isFinite(params.images.maxDimension)) {
        imagesPayload["max_dimension"] = Math.floor(params.images.maxDimension);
      }
      if (Object.keys(imagesPayload).length > 0) {
        payload["images"] = imagesPayload;
      }
    }

    const result = await this.requestJson("POST", url, payload, this.timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `Vision analysis failed (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    const parsed = JSON.parse(result.body) as AnalyzeVisionResponse;
    return parsed;
  }

  /**
   * Builds an absolute URL relative to the configured base URL.
   *
   * @param pathname - Pathname to append
   * @returns URL instance
   */
  private buildUrl(pathname: string): URL {
    return new URL(pathname, this.baseUrl);
  }

  /**
   * Extracts a response header as a single string.
   *
   * @param headers - Response headers
   * @param name - Header name (case-insensitive)
   * @returns Header value when present, otherwise undefined
   */
  private getHeaderValue(
    headers: Record<string, string | string[] | undefined>,
    name: string
  ): string | undefined {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== target) {
        continue;
      }
      if (Array.isArray(value)) {
        return value[0];
      }
      return value;
    }
    return undefined;
  }

  /**
   * Sends a JSON request and returns the response.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param jsonBody - JSON payload
   * @param timeoutMs - Timeout in milliseconds
   * @returns HTTP result
   */
  private async requestJson(
    method: "POST" | "PUT",
    url: URL,
    jsonBody: Record<string, unknown>,
    timeoutMs: number
  ): Promise<HttpResult> {
    const body = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    };
    return await this.requestRaw(method, url, headers, Buffer.from(body, "utf8"), timeoutMs);
  }

  /**
   * Sends an HTTP request with optional headers and body.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param headers - Request headers
   * @param body - Request body
   * @param timeoutMs - Timeout in milliseconds
   * @returns HTTP result
   */
  private async requestRaw(
    method: "HEAD" | "PATCH" | "POST" | "PUT",
    url: URL,
    headers: Record<string, string> | undefined,
    body: Buffer | undefined,
    timeoutMs: number
  ): Promise<HttpResult> {
    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(headers ?? {})
    };

    return await new Promise<HttpResult>((resolve, reject) => {
      const req = reqFn(
        url,
        {
          method,
          headers: requestHeaders
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          const maxResponseBytes = 50 * 1024 * 1024; // 50MB safeguard

          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              req.destroy(new Error("Response exceeded maximum allowed size."));
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        }
      );

      req.on("error", (error) => reject(error));

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });

      if (body && body.length > 0 && method !== "HEAD") {
        req.write(body);
      }
      req.end();
    });
  }
}
