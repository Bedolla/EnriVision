/**
 * ANALYZE MEDIA CONTRACT
 *
 * Public parameter, result, and dependency contracts for the
 * `analyze_media` MCP tool. The facade (`AnalyzeMediaTool`) re-exports
 * these types so external import sites keep working.
 *
 * @module tools/AnalyzeMediaContract
 */

import type { EnriProxyClient } from "../client/EnriProxyClient.js";

/**
 * Shared upload and batching limits for the `analyze_media` MCP tool.
 *
 * @remarks
 * Parity note vs EnriCode `vision.analyze_media` (single-file tool):
 * - EnriCode-only (no MCP equivalent, by design): `attachmentIndex`,
 *   `attachmentId`, and the required-`question` rule. EnriVision accepts
 *   `path`/`paths` only and `question` stays optional.
 * - EnriVision extras (intentional, not bugs): `paths[]` multi-image sets
 *   packed as one `application/vnd.enrivision.media-set+tar` archive for
 *   server-side batching + reduce, `images.*` tuning, and the
 *   `document.pages_per_batch/max_images_per_batch/scanned_text_threshold_chars`
 *   multipass knobs beyond EnriCode.
 * - EnriVision validates strictly with Spanish-first bilingual errors (ES first,
 *   EN second) and fails (EnriCode coerces
 *   and clamps silently); flat aliases (camelCase plus snake_case) are
 *   accepted with flat-over-nested precedence, mirroring EnriCode. Flat
 *   `segmentSeconds`/`maxSegments` win over nested `video`/`audio` values;
 *   differing nested `video` vs `audio` values without a flat fail locally.
 *   Nested `document.documentMaxPages` and `audio.audioTimestamps` (plus
 *   `audio_timestamps`) are accepted like EnriCode; exponents (`"1e3"`)
 *   are rejected on all three surfaces.
 */
export const ANALYZE_MEDIA_LIMITS = {
  /**
   * Maximum accepted upload size in bytes (4 GiB, mirrors EnriProxy).
   */
  maxUploadBytes: 4 * 1024 * 1024 * 1024,
  /**
   * Maximum chunk size in bytes per upload request (server value capped).
   *
   * @remarks
   * 16 MiB mirrors EnriProxy (`UploadSessionService` default) and EnriCode
   * `MAX_CHUNK_SIZE_BYTES`: 4 GiB needs ~256 PATCH instead of ~512.
   */
  maxChunkBytes: 16 * 1024 * 1024,
  /**
   * Maximum entries accepted in `paths[]` before materializing downloads.
   */
  maxPathsCount: 100,
  /**
   * Maximum prompt characters accepted for `question`/`context` (mirrors
   * EnriProxy `VISION_MAX_QUESTION_CHARS`/`VISION_MAX_CONTEXT_CHARS`):
   * oversized prompts fail fast here, before any byte is uploaded.
   */
  maxPromptChars: 2000,
  /**
   * Maximum clip-window bound in seconds (0-86400, 24 h).
   */
  maxClipSeconds: 86400,
  /**
   * Maximum characters of server analysis text forwarded to the model.
   */
  maxAnalysisTextChars: 30000,
  /**
   * Maximum characters of analysis text kept inside `structuredContent`.
   *
   * @remarks
   * MCP delivers the whole result in one JSON frame, so the full payload is
   * truncated here too (with `analysis_truncated` + `analysis_total_chars`):
   * small clients pay parse/memory cost regardless of text truncation.
   * Budgeted in code points (not UTF-8 bytes) on purpose: MCP hosts parse
   * JSON into UTF-16 strings, and seam-safe slicing must never split
   * surrogate pairs. This diverges knowingly from EnriCode's 256 KiB byte
   * envelope: astral-heavy analyses ship more wire bytes here, but never
   * more characters, and `analysis_total_chars` keeps the cut honest.
   */
  maxStructuredContentAnalysisChars: 262144,
  /**
   * Code points of the structured analysis budget kept at the start.
   *
   * @remarks
   * The remainder (`maxStructuredContentAnalysisChars` minus this head)
   * is kept at the end: conclusions live at the tail of long analyses,
   * so head-only truncation would drop exactly what small models need.
   */
  maxStructuredContentAnalysisHeadChars: 200000,
  /**
   * Maximum serialized characters of `extraction` kept inside
   * `structuredContent` (512 KiB).
   *
   * @remarks
   * Multipass timelines can grow without bound; past this cap long strings
   * are head+tail cut (shape preserved) instead of shipping megabytes of
   * metadata to small MCP clients. Code points, like the analysis budget
   * above; the 32768 per-string cap stays wider than EnriCode's 16 KiB
   * field cap because MCP has no separate byte envelope to absorb the
   * remainder (the shape-preserving cut is the only bound).
   */
  maxStructuredContentExtractionChars: 524288,
  /**
   * Maximum characters kept per string when bounding `extraction`.
   */
  maxBoundExtractionStringChars: 32768,
  /**
   * Unary analyze timeout for `analysis_mode: "single"` (10 min, mirrors
   * EnriCode `ANALYZE_TIMEOUT_MS` and the EnriProxy single-pass stage budget).
   *
   * @remarks
   * The operator `ENRIVISION_TIMEOUT_MS` still caps it via `Math.min`.
   */
  singleAnalyzeTimeoutMs: 10 * 60 * 1000,
  /**
   * Unary analyze timeout for `analysis_mode: "multipass"` and `"auto"`
   * (20 min, mirrors EnriCode `MULTIPASS_ANALYZE_TIMEOUT_MS` and the server
   * multipass wall-clock budget).
   *
   * @remarks
   * `auto` shares the multipass budget because the server may escalate to
   * multipass (long videos, scanned PDFs over the page threshold) and the
   * client cannot know upfront. The operator `ENRIVISION_TIMEOUT_MS` still
   * caps it via `Math.min`.
   */
  multipassAnalyzeTimeoutMs: 20 * 60 * 1000,
  /**
   * Budget for the fail-open vision-capability probe (`GET
   * `/v1/account/models`, 15 s, mirrors EnriCode).
   */
  visionProbeTimeoutMs: 15_000,
  /**
   * Time-to-live for cached vision-capability verdicts (5 min, mirrors EnriCode
   * `PROBE_CACHE_TTL_MS`).
   */
  visionProbeCacheTtlMs: 5 * 60 * 1000,
} as const;

/**
 * Machine-readable error codes surfaced in `structuredContent` on MCP tool errors.
 *
 * @remarks
 * Reuses the EnriCode `VisionAnalyzeMediaErrorMapper` vocabulary so OpenAI-compatible
 * third-party clients can branch programmatically (retryable 429/5xx and timeouts vs
 * terminal input/auth errors vs aborts) instead of parsing human text.
 */
export const ANALYZE_MEDIA_ERROR_CODES = {
  /**
   * Caller-side argument or tuning error (400/422 from the proxy included): never retry unchanged.
   */
  inputInvalid: "ENRICODE_ERR_TOOL_INPUT_INVALID",
  /**
   * Server-side or transport execution failure: retry only when `retryable` is true.
   */
  executionFailed: "ENRICODE_ERR_TOOL_EXECUTION_FAILED",
  /**
   * Analysis or upload deadline exceeded: retry with a smaller scope once.
   */
  executionTimeout: "ENRICODE_ERR_TOOL_EXECUTION_TIMEOUT",
  /**
   * Caller-cancelled request: do not retry automatically.
   */
  executionAborted: "ENRICODE_ERR_TOOL_EXECUTION_ABORTED",
} as const;

/**
 * One machine-readable MCP error code (see {@link ANALYZE_MEDIA_ERROR_CODES}).
 */
export type AnalyzeMediaErrorCode =
  (typeof ANALYZE_MEDIA_ERROR_CODES)[keyof typeof ANALYZE_MEDIA_ERROR_CODES];

/**
 * Relative image region for native-resolution zoom (images only).
 */
export interface ImageRegion {
  /**
   * Relative horizontal coordinate of the top-left corner (0 = left edge).
   */
  readonly x: number;

  /**
   * Relative vertical coordinate of the top-left corner (0 = top edge).
   */
  readonly y: number;

  /**
   * Relative width (1 = full width).
   */
  readonly width: number;

  /**
   * Relative height (1 = full height).
   */
  readonly height: number;
}

/**
 * Tool parameters for `analyze_media`.
 */
export interface AnalyzeMediaToolParams {
  /**
   * Absolute local filesystem path on the MCP host, or one http(s) URL to
   * download (bounded, temporary) and analyze.
   *
   * @remarks
   * Use `paths` to analyze multiple images in a single call. When `paths`
   * carries at least one valid entry, `path` is ignored.
   */
  readonly path?: string;

  /**
   * Absolute local filesystem paths or http(s) URLs on the MCP host.
   *
   * @remarks
   * When provided, EnriVision uploads the files as a single media-set archive
   * (resumable, up to 4GB) and triggers server-side batching + reduce.
   *
   * This is intended for many UI screenshots / photo sets. Blank entries are
   * discarded; when at least one valid entry remains, `path` is ignored.
   */
  readonly paths?: ReadonlyArray<string>;

  /**
   * Optional analysis hint (ui, diagram, chart, error, code, meeting, tutorial, photo).
   */
  readonly context?: string;

  /**
   * Optional explicit user question.
   */
  readonly question?: string;

  /**
   * Preferred response language code (e.g., "es", "en").
   */
  readonly language?: string;

  /**
   * Optional max frames override for videos (integer 1-20, default 20).
   */
  readonly maxFrames?: number;

  /**
   * Optional override for transcription on videos.
   */
  readonly transcribe?: boolean;

  /**
   * Optional transcription language hint for Whisper.
   */
  readonly transcriptionLanguage?: string;

  /**
   * Optional analysis mode selector (auto|single|multipass).
   */
  readonly analysisMode?: "auto" | "single" | "multipass";

  /**
   * Optional video multipass tuning.
   */
  readonly video?: {
    /**
     * Optional clip start offset in seconds for targeted video analysis.
     *
     * @remarks
     * Use this when the question references a specific timestamp to avoid
     * scanning the full timeline.
     */
    readonly clipStartSeconds?: number;

    /**
     * Optional clip duration in seconds for targeted video analysis.
     *
     * @remarks
     * Use together with {@link clipStartSeconds} to analyze only a time window.
     */
    readonly clipDurationSeconds?: number;

    /**
     * Segment duration in seconds (5-600, default 60).
     */
    readonly segmentSeconds?: number;

    /**
     * Maximum number of segments to analyze (integer 1-60, mirrors EnriProxy).
     */
    readonly maxSegments?: number;

    /**
     * Maximum frames per segment (integer 1-20, default 8).
     */
    readonly maxFramesPerSegment?: number;
  };

  /**
   * Optional document multipass tuning (PDF).
   */
  readonly document?: {
    /**
     * Maximum pages to analyze in total (integer 1-200, default 20, mirrors EnriProxy).
     */
    readonly maxPagesTotal?: number;

    /**
     * Pages per batch (integer 1-200, mirrors EnriProxy).
     */
    readonly pagesPerBatch?: number;

    /**
     * Maximum rendered pages per batch (integer 0-20, 0 = no render, mirrors EnriProxy).
     */
    readonly maxImagesPerBatch?: number;

    /**
     * Minimum extracted text length to treat a page as textual (integer 0-5000, mirrors EnriProxy).
     */
    readonly scannedTextThresholdChars?: number;
  };

  /**
   * Optional audio multipass tuning.
   */
  readonly audio?: {
    /**
     * Whether to include timestamped segments in audio extraction.
     */
    readonly timestamps?: boolean;

    /**
     * Segment duration in seconds for audio multipass (5-600, default 60).
     */
    readonly segmentSeconds?: number;

    /**
     * Maximum number of audio segments to analyze (integer 1-60, mirrors EnriProxy).
     */
    readonly maxSegments?: number;
  };

  /**
   * Optional image-set multipass tuning.
   *
   * @remarks
   * Used only when analyzing multiple images via `paths`.
   */
  readonly images?: {
    /**
     * Maximum number of images to analyze in total (integer 1-500, mirrors EnriProxy).
     */
    readonly maxImagesTotal?: number;

    /**
     * Images per batch for multipass map calls (integer 1-20, mirrors EnriProxy).
     */
    readonly imagesPerBatch?: number;

    /**
     * Maximum dimension for images (width/height, integer 256-4096, mirrors EnriProxy).
     */
    readonly maxDimension?: number;
  };

  /**
   * Optional requested model id for server-side dispatch affinity.
   *
   * @remarks
   * Mirrors EnriCode `requestedModelId`: EnriProxy preserves the active
   * model before fallbacks (including the Muse Spark image-count reroute).
   * Omitted (or `ENRIVISION_MODEL`) means auto-dispatch. Unknown keys
   * inside tuning objects are rejected, never ignored.
   */
  readonly model?: string;

  /**
   * Optional relative region of the analyzed image for native-resolution zoom.
   *
   * @remarks
   * Normalized [0,1] coordinates over the original image (0,0 = top-left
   * corner). Use the boxes returned in `elements` of a previous analysis of
   * the same image; never invent coordinates.
   */
  readonly region?: ImageRegion;

  /**
   * Opaque continuation cursor from a truncated response
   * (`segment_summaries_cursor` or `transcription_segments_cursor`).
   *
   * @remarks
   * Continuation mode: no file is uploaded or analyzed; the call only
   * reads the next window of a previously truncated list. `path`/`paths`
   * are ignored while `cursor` is present.
   */
  readonly cursor?: string;

  /**
   * Start index for a continuation read (defaults to the response
   * `next_offset`).
   */
  readonly offset?: number;

  /**
   * Parser-generated honesty notes (Spanish-first bilingual, e.g., a clamped clip window).
   *
   * @remarks
   * Present only when parsing adjusted a requested value: `execute` copies
   * these into the result so the model always sees what changed instead of
   * analyzing a silently different window.
   */
  readonly warnings?: ReadonlyArray<string>;
}

/**
 * One grounded element box returned by an image analysis.
 */
export interface AnalyzeMediaElementBox {
  /**
   * Short label naming the grounded element.
   */
  readonly label: string;

  /**
   * Original-relative [0,1] box that can be echoed back as `region`.
   */
  readonly box: ImageRegion;
}

/**
 * Structured result for `analyze_media`.
 */
export interface AnalyzeMediaToolResult extends Record<string, unknown> {
  /**
   * Text analysis produced by EnriProxy.
   */
  readonly analysis: string;

  /**
   * Grounded element boxes for image analyses (original-relative [0,1]).
   */
  readonly elements?: ReadonlyArray<AnalyzeMediaElementBox>;

  /**
   * Detected media type.
   */
  readonly media_type: string;

  /**
   * Parser-generated honesty notes (Spanish-first bilingual, e.g., a clamped clip window).
   *
   * @remarks
   * Copied from the validated params by `execute`: adjustments made before
   * any upload stay visible to the model in both the text output and the
   * structured content.
   */
  readonly warnings?: ReadonlyArray<string>;

  /**
   * Extraction metadata returned by the server.
   *
   * @remarks
   * This metadata is intended for debugging and transparency (e.g., duration,
   * selected frames, warnings). Internal identifiers like upload ids are
   * stripped to avoid leaking implementation details into the model context.
   */
  readonly extraction: Record<string, unknown>;
}

/**
 * Execution options for {@link AnalyzeMediaTool.execute}.
 */
export interface AnalyzeMediaExecutionOptions {
  /**
   * Cancellation signal (e.g., the MCP request `extra.signal`); aborts URL
   * downloads, uploads, and the analysis request with a Spanish error.
   */
  readonly signal?: AbortSignal;
}

/**
 * Dependencies for {@link AnalyzeMediaTool}.
 */
export interface AnalyzeMediaToolDeps {
  /**
   * Creates an EnriProxy client with a base URL, API key, and timeout.
   *
   * @param serverUrl - EnriProxy URL.
   * @param apiKey - EnriProxy API key.
   * @param timeoutMs - Timeout in milliseconds.
   * @returns Client instance.
   */
  readonly createClient: (serverUrl: string, apiKey: string, timeoutMs: number) => EnriProxyClient;

  /**
   * Default EnriProxy server URL.
   */
  readonly defaultServerUrl: string;

  /**
   * Default EnriProxy API key.
   */
  readonly defaultApiKey: string;

  /**
   * Default timeout in milliseconds.
   */
  readonly defaultTimeoutMs: number;
}
