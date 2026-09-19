/**
 * ENRIPROXY CLIENT CONTRACT
 *
 * Public parameter, response, and error contracts for the EnriProxy HTTP
 * endpoints used by EnriVision. The client facade (`EnriProxyClient`)
 * re-exports these types so external import sites keep working.
 *
 * @module client/EnriProxyClientContract
 */

import { truncateCodePointsHeadTail } from "../shared/codepointTruncation.js";

/**
 * Connection configuration for the EnriProxy client.
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
   * Server-advertised upload ceiling in bytes, when the proxy reports it.
   *
   * @remarks
   * Mirrors `POST /v1/uploads` `max_file_size_bytes`: callers fail fast in
   * Spanish before sending bytes when the payload exceeds this ceiling.
   */
  readonly max_file_size_bytes?: number;

  /**
   * Expiration timestamp in ms since epoch.
   */
  readonly expires_at: number;
}

/**
 * One grounded element box returned by an image analysis.
 */
export interface AnalyzeVisionElement {
  /**
   * Short label naming the grounded element.
   */
  readonly label: string;

  /**
   * Original-relative [0,1] box.
   */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
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
   * Client-side honesty warnings (for example, a clamped clip window on
   * the direct-client path, which has no parser warning channel).
   */
  readonly warnings?: ReadonlyArray<string>;

  /**
   * Grounded element boxes for image analyses (original-relative [0,1]).
   */
  readonly elements?: ReadonlyArray<AnalyzeVisionElement>;

  /**
   * Detected media type.
   */
  readonly media_type: string;

  /**
   * Model id that effectively served the analysis (server-side dispatch),
   * when the server reports one.
   */
  readonly model?: string;

  /**
   * Server-side request id for correlation, when the server reports one.
   */
  readonly request_id?: string;

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
   * Stable machine-readable error code parsed from the body (`invalid_*`
   * knob codes), when the server sent one.
   */
  public readonly serverCode?: string;

  /**
   * Dotted request field carrying the invalid value, when the server sent
   * one.
   */
  public readonly serverField?: string;

  /**
   * Creates a new {@link EnriProxyHttpError}.
   *
   * @param message - Error message
   * @param status - HTTP status code
   * @param headers - Response headers
   * @param body - Response body
   * @param serverCode - Stable machine-readable error code, when parsed
   * @param serverField - Dotted invalid-value field, when parsed
   */
  public constructor(
    message: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
    body: string,
    serverCode?: string,
    serverField?: string
  ) {
    super(message);
    this.name = "EnriProxyHttpError";
    this.status = status;
    this.headers = headers;
    this.body = body;
    this.serverCode = serverCode;
    this.serverField = serverField;
  }
}

/**
 * Result of a simple HTTP request.
 */
export interface EnriProxyHttpResult {
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
 * Relative image region for native-resolution zoom (images only).
 */
export interface EnriProxyImageRegion {
  /**
   * Relative horizontal coordinate of the top-left corner.
   */
  readonly x: number;

  /**
   * Relative vertical coordinate of the top-left corner.
   */
  readonly y: number;

  /**
   * Relative width.
   */
  readonly width: number;

  /**
   * Relative height.
   */
  readonly height: number;
}

/**
 * Video multipass tuning for POST `/v1/vision/analyze`.
 */
export interface EnriProxyVideoTuning {
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
}

/**
 * Document multipass tuning (PDF) for POST `/v1/vision/analyze`.
 */
export interface EnriProxyDocumentTuning {
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
}

/**
 * Audio multipass tuning for POST `/v1/vision/analyze`.
 */
export interface EnriProxyAudioTuning {
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
}

/**
 * Image-set multipass tuning for POST `/v1/vision/analyze`.
 */
export interface EnriProxyImagesTuning {
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
}

/**
 * Parameters for creating an upload session.
 */
export interface CreateUploadSessionParams {
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

  /**
   * Optional cancellation signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * Parameters for appending a chunk to an upload session.
 */
export interface AppendUploadChunkParams {
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

  /**
   * Optional cancellation signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * Parameters for triggering server-side vision analysis.
 */
export interface AnalyzeVisionParams {
  /**
   * Upload session id (exactly one of `uploadId` / `sourceUrl`).
   */
  readonly uploadId?: string;

  /**
   * Remote http(s) URL for server-side ingest (exactly one of
   * `uploadId` / `sourceUrl`). Skips the client download + upload round
   * trip for media over the 64 MiB client cap.
   */
  readonly sourceUrl?: string;

  /**
   * Optional requested model id preserved for server-side dispatch affinity
   * (e.g., Muse Spark image-count reroute). Omitted when absent (auto-dispatch).
   */
  readonly model?: string;

  /**
   * Optional per-call timeout override for the unary analyze request
   * (defaults to the client timeout; callers scale it by analysis mode).
   */
  readonly timeoutMs?: number;

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
   * Optional relative image region for native-resolution zoom (images only).
   */
  readonly region?: EnriProxyImageRegion;

  /**
   * Optional video multipass tuning.
   */
  readonly video?: EnriProxyVideoTuning;

  /**
   * Optional document multipass tuning (PDF).
   */
  readonly document?: EnriProxyDocumentTuning;

  /**
   * Optional audio multipass tuning.
   */
  readonly audio?: EnriProxyAudioTuning;

  /**
   * Optional image-set multipass tuning.
   */
  readonly images?: EnriProxyImagesTuning;

  /**
   * Optional cancellation signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * Parameters for one truncated-list continuation read.
 */
export interface FetchSegmentPageParams {
  /**
   * Opaque cursor from a truncated analyze response
   * (`segment_summaries_cursor` or `transcription_segments_cursor`).
   */
  readonly cursor: string;

  /**
   * Start index (defaults to the response `next_offset`).
   */
  readonly offset?: number;

  /**
   * Entries wanted (server-clamped to its per-read ceiling).
   */
  readonly limit?: number;

  /**
   * Optional per-call timeout override.
   */
  readonly timeoutMs?: number;

  /**
   * Optional cancellation signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * One truncated-list continuation window.
 */
export interface SegmentPageResponse {
  /**
   * Entries for the requested window.
   */
  readonly entries: ReadonlyArray<unknown>;

  /**
   * True upstream total.
   */
  readonly total: number;

  /**
   * Whether entries remain past this window.
   */
  readonly hasMore: boolean;

  /**
   * Delivered count where a follow-up read continues.
   */
  readonly nextOffset: number;

  /**
   * Echoed cursor for chained reads.
   */
  readonly cursor: string;
}

/**
 * Maximum characters of server-provided detail embedded in thrown errors.
 */
const MAX_SERVER_DETAIL_CHARS = 300;

/**
 * Stable machine-readable insight parsed from one non-2xx proxy body.
 */
export interface ServerErrorInsight {
  /**
   * Human-readable server detail, or null when none is recognizable.
   */
  readonly detail: string | null;

  /**
   * Stable machine-readable error code emitted by the proxy (for example
   * `invalid_video`), when present.
   */
  readonly code?: string;

  /**
   * Dotted request field carrying the invalid value (for example
   * `video.clip_duration_seconds`), when present.
   */
  readonly field?: string;
}

/**
 * Extracts a human-readable error detail from a non-2xx response body.
 *
 * @param body - Raw response body (best-effort UTF-8).
 * @returns Spanish-ready server detail, or null when none is recognizable.
 */
export function extractServerErrorDetail(body: string): string | null {
  return extractServerErrorInsight(body).detail;
}

/**
 * Extracts the full stable insight (detail + machine code + field) from one
 * non-2xx proxy body.
 *
 * @remarks
 * EnriProxy knob-validation errors carry `code` (`invalid_<root>`) and a
 * dotted `field` alongside the message so EnriVision/EnriCode can match on
 * codes instead of Spanish prose; unknown shapes degrade to detail-only.
 *
 * @param body - Raw response body (best-effort UTF-8).
 * @returns Parsed insight with optional stable code/field.
 */
export function extractServerErrorInsight(body: string): ServerErrorInsight {
  const trimmed: string = body.trim();
  if (!trimmed) {
    return { detail: null };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record: Record<string, unknown> = parsed as Record<string, unknown>;
      const nested: unknown = record["error"];
      if (typeof nested === "string" && nested.trim()) {
        return { detail: truncateCodePointsHeadTail(nested.trim(), MAX_SERVER_DETAIL_CHARS, 0).text };
      }
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const nestedRecord: Record<string, unknown> = nested as Record<string, unknown>;
        const nestedMessage: unknown = nestedRecord["message"];
        const code: unknown = nestedRecord["code"] ?? record["code"];
        const field: unknown = nestedRecord["field"] ?? record["field"];
        if (typeof nestedMessage === "string" && nestedMessage.trim()) {
          return {
            detail: truncateCodePointsHeadTail(nestedMessage.trim(), MAX_SERVER_DETAIL_CHARS, 0).text,
            ...(typeof code === "string" && code.trim() ? { code: code.trim() } : {}),
            ...(typeof field === "string" && field.trim() ? { field: field.trim() } : {}),
          };
        }
      }
      const message: unknown = record["message"];
      const code: unknown = record["code"];
      const field: unknown = record["field"];
      if (typeof message === "string" && message.trim()) {
        return {
          detail: truncateCodePointsHeadTail(message.trim(), MAX_SERVER_DETAIL_CHARS, 0).text,
          ...(typeof code === "string" && code.trim() ? { code: code.trim() } : {}),
          ...(typeof field === "string" && field.trim() ? { field: field.trim() } : {}),
        };
      }
      // Code-only bodies (no message) still carry the stable classification.
      if (typeof code === "string" && code.trim()) {
        return {
          detail: null,
          code: code.trim(),
          ...(typeof field === "string" && field.trim() ? { field: field.trim() } : {}),
        };
      }
    }
  } catch {
    // Not JSON: fall through to the plain-text handling below.
  }
  if (trimmed.startsWith("<")) {
    return { detail: null };
  }
  return { detail: truncateCodePointsHeadTail(trimmed, MAX_SERVER_DETAIL_CHARS, 0).text };
}
