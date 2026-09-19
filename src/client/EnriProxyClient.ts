/**
 * ENRIPROXY CLIENT
 *
 * Minimal HTTP client for EnriProxy endpoints used by EnriVision:
 * - POST   /v1/uploads
 * - HEAD   /v1/uploads/:id
 * - PATCH  /v1/uploads/:id
 * - DELETE /v1/uploads/:id
 * - POST   /v1/vision/analyze
 * - POST   /v1/vision/segments
 * - GET    /v1/account/models
 *
 * @module client/EnriProxyClient
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

import { buildClipWindowClampedWarning, optionalFraction, optionalInt, optionalNumber } from "../shared/validation.js";
import {
  AUDIO_KNOWN_KEYS,
  DOCUMENT_KNOWN_KEYS,
  IMAGES_KNOWN_KEYS,
  VIDEO_KNOWN_KEYS,
} from "../tools/AnalyzeMediaParamParser.js";

import {
  EnriProxyHttpError,
  extractServerErrorInsight,
  type ServerErrorInsight,
  type AnalyzeVisionElement,
  type AnalyzeVisionParams,
  type AnalyzeVisionResponse,
  type AppendUploadChunkParams,
  type CreateUploadSessionParams,
  type CreateUploadSessionResponse,
  type EnriProxyClientConfig,
  type EnriProxyHttpResult,
  type FetchSegmentPageParams,
  type SegmentPageResponse,
} from "./EnriProxyClientContract.js";

export { EnriProxyHttpError } from "./EnriProxyClientContract.js";
export type {
  AnalyzeVisionElement,
  AnalyzeVisionParams,
  AnalyzeVisionResponse,
  AppendUploadChunkParams,
  CreateUploadSessionParams,
  CreateUploadSessionResponse,
  FetchSegmentPageParams,
  EnriProxyAudioTuning,
  EnriProxyClientConfig,
  EnriProxyDocumentTuning,
  EnriProxyHttpResult,
  EnriProxyImageRegion,
  EnriProxyImagesTuning,
  EnriProxyVideoTuning,
  SegmentPageResponse,
} from "./EnriProxyClientContract.js";

/**
 * Maximum clip-window bound in seconds (0-86400, 24 h).
 *
 * @remarks
 * Mirrors `ANALYZE_MEDIA_LIMITS.maxClipSeconds` and the
 * `AnalyzeMediaParamParser` clip contract so the client never silently
 * coerces out-of-range windows: invalid values throw in Spanish instead.
 */
const MAX_CLIP_SECONDS: number = 86400;

/**
 * Maximum `source_url` characters the proxy ingests (EnriProxy
 * `VISION_MAX_SOURCE_URL_CHARS`): longer URLs fail in the client backstop,
 * before any byte travels, instead of failing at the server after cost.
 */
const MAX_SOURCE_URL_CHARS: number = 2048;

/**
 * Timeout for upload session creation (`POST /v1/uploads`, 60 s).
 *
 * @remarks
 * Mirrors EnriCode `VisionAnalyzeMediaUploadCoordinator` (60 s create
 * budget): session creation is a tiny metadata call, but it deserves more
 * headroom than offset probes. Capped by the operator timeout via `Math.min`.
 */
export const CREATE_CONTROL_TIMEOUT_MS: number = 60_000;

/**
 * Timeout for upload offset probes (`HEAD /v1/uploads/:id`, 15 s).
 *
 * @remarks
 * Mirrors EnriCode (15 s probe budget): offset queries are single-header
 * reads and must fail fast. Capped by the operator timeout via `Math.min`.
 */
export const PROBE_CONTROL_TIMEOUT_MS: number = 15_000;

/**
 * Budget for the fail-open vision-capability probe (`GET /v1/account/models`, 15 s).
 *
 * @remarks
 * Mirrors EnriCode `assertRemoteVisionCapable` and
 * `ANALYZE_MEDIA_LIMITS.visionProbeTimeoutMs` (pinned equal by tests): the
 * probe must never stall session creation.
 */
export const ACCOUNT_MODELS_PROBE_TIMEOUT_MS: number = 15_000;

/**
 * Timeout for best-effort orphan cleanup (`DELETE /v1/uploads/:id`).
 *
 * @remarks
 * The cleanup call runs on an independent signal (the caller may already be
 * cancelled), so it carries its own short budget and never blocks the
 * error path.
 */
const CLEANUP_TIMEOUT_MS: number = 15_000;

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
   * @throws Error with the parsed server detail when creation fails, or when the success body is not valid JSON.
   */
  public async createUploadSession(
    params: CreateUploadSessionParams,
  ): Promise<CreateUploadSessionResponse> {
    const url = this.buildUrl("/v1/uploads");
    const payload = {
      filename: params.filename,
      size_bytes: params.sizeBytes,
      content_type: params.contentType,
      client_trace_id: params.clientTraceId
    };

    const result = await this.requestJson(
      "POST",
      url,
      payload,
      this.createControlTimeoutMs(),
      params.signal,
    );
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `Falló la creación de la sesión de subida (HTTP ${result.status}). / Upload session creation failed (HTTP ${result.status}).`,
        result,
      );
    }

    return EnriProxyClient.parseJsonBody<CreateUploadSessionResponse>(result.body, result.status);
  }

  /**
   * Queries the current upload offset for a session.
   *
   * @param uploadId - Upload id
   * @param signal - Optional cancellation signal.
   * @returns Offset in bytes
   * @throws Error with the parsed server detail when the query fails.
   */
  public async getUploadOffset(uploadId: string, signal?: AbortSignal): Promise<number> {
    const url = this.buildUrl(`/v1/uploads/${encodeURIComponent(uploadId)}`);
    const result = await this.requestRaw(
      "HEAD",
      url,
      undefined,
      undefined,
      this.probeControlTimeoutMs(),
      signal,
    );
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `Falló la consulta del offset de subida (HTTP ${result.status}). / Upload offset query failed (HTTP ${result.status}).`,
        result,
      );
    }

    return this.parseUploadOffsetHeader(result.headers);
  }

  /**
   * Deletes an upload session and its stored bytes (best-effort orphan cleanup).
   *
   * @remarks
   * Mirrors `DELETE /v1/uploads/:id` on EnriProxy. Callers must invoke this
   * with an independent timeout signal (never the already-cancelled caller
   * signal) and swallow failures: cleanup must never mask the original
   * upload/analysis error.
   *
   * @param uploadId - Upload id to delete.
   * @param signal - Optional cancellation signal (prefer an independent timeout).
   * @throws Error with an Spanish-first bilingual message when the server rejects the deletion.
   */
  public async deleteUploadSession(uploadId: string, signal?: AbortSignal): Promise<void> {
    const url = this.buildUrl(`/v1/uploads/${encodeURIComponent(uploadId)}`);
    const result = await this.requestRaw("DELETE", url, undefined, undefined, CLEANUP_TIMEOUT_MS, signal);
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `Falló la eliminación de la sesión de subida (HTTP ${result.status}). / Upload session deletion failed (HTTP ${result.status}).`,
        result,
      );
    }
  }

  /**
   * Fetches the account model catalog for the fail-open vision probe.
   *
   * @remarks
   * Thin `GET /v1/account/models` reader for `AnalyzeMediaTool` (mirrors
   * EnriCode `assertRemoteVisionCapable`): callers treat every failure as
   * fail-open (proceed with the upload) and only reject on an explicit
   * `vision === false` match, so a stale discovery snapshot never blocks a
   * valid upload. Non-2xx responses throw {@link EnriProxyHttpError} (the
   * caller uses the status to invalidate cached verdicts on 401/404);
   * non-JSON 2xx bodies throw an Spanish-first bilingual error.
   *
   * @param signal - Optional cancellation signal.
   * @returns Parsed response body.
   * @throws Error with an Spanish-first bilingual message when the probe request fails.
   */
  public async getAccountModels(signal?: AbortSignal): Promise<unknown> {
    const url = this.buildUrl("/v1/account/models");
    const timeoutMs: number = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
      ? Math.min(this.timeoutMs, ACCOUNT_MODELS_PROBE_TIMEOUT_MS)
      : ACCOUNT_MODELS_PROBE_TIMEOUT_MS;
    const result = await this.requestRaw("GET", url, undefined, undefined, timeoutMs, signal);
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `Falló la consulta de modelos de la cuenta (HTTP ${result.status}). / Account models query failed (HTTP ${result.status}).`,
        result,
      );
    }
    try {
      return JSON.parse(result.body) as unknown;
    } catch {
      throw new Error(`La respuesta del servidor no es JSON válido (HTTP ${String(result.status)}). / Server response is not valid JSON (HTTP ${String(result.status)}).`);
    }
  }

  /**
   * Appends a chunk to an upload session.
   *
   * @param params - Chunk parameters
   * @returns New upload offset in bytes
   */
  public async appendUploadChunk(
    params: AppendUploadChunkParams,
  ): Promise<number> {
    const url = this.buildUrl(`/v1/uploads/${encodeURIComponent(params.uploadId)}`);
    const timeoutMs = params.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": String(params.offset),
      "Content-Length": String(params.chunk.length)
    };

    const result = await this.requestRaw("PATCH", url, headers, params.chunk, timeoutMs, params.signal);
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `Falló la subida del fragmento (HTTP ${result.status}). / Chunk upload failed (HTTP ${result.status}).`,
        result,
      );
    }

    const offsetHeader = this.getHeaderValue(result.headers, "upload-offset");
    if (!offsetHeader) {
      throw new Error("Falta el encabezado Upload-Offset en la respuesta del servidor. / Missing Upload-Offset header in the server response.");
    }

    return this.parseUploadOffsetHeader(result.headers);
  }

  /**
   * Triggers server-side vision analysis for an uploaded file.
   *
   * @param params - Analysis parameters
   * @returns Analysis response
   * @throws Error with the parsed server detail when analysis fails, or when the success body is not valid JSON.
   */
  public async analyze(params: AnalyzeVisionParams): Promise<AnalyzeVisionResponse> {
    const url = this.buildUrl("/v1/vision/analyze");
    const localWarnings: string[] = [];
    // Pre-upload guards mirroring AnalyzeMediaParamParser: typos must fail
    // here, not after paying a full-file upload plus server analysis.
    EnriProxyClient.requirePreUploadTuning(params);
    const uploadId: string | undefined =
      typeof params.uploadId === "string" && params.uploadId.trim().length > 0 ? params.uploadId.trim() : undefined;
    const sourceUrl: string | undefined =
      typeof params.sourceUrl === "string" && params.sourceUrl.trim().length > 0 ? params.sourceUrl.trim() : undefined;
    if ((uploadId === undefined) === (sourceUrl === undefined)) {
      throw new Error("Proporcione exactamente uno de 'uploadId' o 'sourceUrl'. / Provide exactly one of 'uploadId' or 'sourceUrl'.");
    }
    if (typeof sourceUrl === "string" && Array.from(sourceUrl).length > MAX_SOURCE_URL_CHARS) {
      throw new Error(
        `sourceUrl excede el límite de ingesta del servidor de ${String(MAX_SOURCE_URL_CHARS)} caracteres (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use una URL más corta. / sourceUrl exceeds the ${String(MAX_SOURCE_URL_CHARS)}-char server ingest limit (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use a shorter URL.`
      );
    }
    // Fail fast on prompt budgets the server 400s after upload cost
    // (mirrors AnalyzeMediaParamParser + EnriCode request records).
    EnriProxyClient.requireBoundedPromptText(params.question, "question");
    EnriProxyClient.requireBoundedPromptText(params.context, "context");
    if (typeof params.model === "string" && Array.from(params.model.trim()).length > 128) {
      throw new Error("model excede el máximo de 128 caracteres. / model exceeds the 128-char maximum.");
    }
    const payload: Record<string, unknown> = uploadId !== undefined ? { upload_id: uploadId } : { source_url: sourceUrl };
    if (typeof params.model === "string" && params.model.trim()) {
      payload["model"] = params.model.trim();
    }

    if (typeof params.context === "string" && params.context.trim()) payload["context"] = params.context.trim();
    if (typeof params.question === "string" && params.question.trim()) payload["question"] = params.question.trim();
    if (typeof params.language === "string" && params.language.trim()) payload["language"] = params.language.trim();
    const maxFrames: number | undefined = EnriProxyClient.requireOptionalInt(params.maxFrames, "max_frames", 1, 20);
    if (typeof maxFrames !== "undefined") {
      payload["max_frames"] = maxFrames;
    }
    // EnriCode always sends an explicit `request.transcribe ?? true`: omitting
    // the knob would defer to the operator's server-side `transcribe_by_default`
    // (default true, configurable), making MCP behavior diverge from EnriCode
    // on hardened servers. Defaulting here keeps both clients identical.
    payload["transcribe"] = EnriProxyClient.requireTranscribe(params.transcribe);
    if (typeof params.transcriptionLanguage === "string" && params.transcriptionLanguage.trim()) {
      payload["transcription_language"] = params.transcriptionLanguage.trim();
    }

    if (typeof params.analysisMode === "string" && params.analysisMode.trim()) {
      payload["analysis_mode"] = params.analysisMode.trim();
    }
    if (typeof params.region === "object" && params.region !== null) {
      payload["region"] = EnriProxyClient.requireValidRegion(params.region);
    }

    if (params.video && typeof params.video === "object") {
      const videoPayload: Record<string, unknown> = {};
      const requestedClipDuration = requireClipDuration(params.video.clipDurationSeconds);
      let clipDurationSeconds: number | undefined = requestedClipDuration;
      // A window anchored only by duration still starts at 0: synthesize
      // it so the server never defaults the offset. Mirrors EnriCode
      // VisionAnalyzeMediaRequestRecords (clip_start_seconds travels even
      // when 0 while a window exists) and AnalyzeMediaParamParser.
      const clipStartRaw = requireClipBound(params.video.clipStartSeconds, "video.clip_start_seconds");
      const clipStartSeconds: number | undefined = typeof clipStartRaw !== "undefined"
        ? clipStartRaw
        : (typeof clipDurationSeconds !== "undefined" ? 0 : undefined);
      if (typeof clipStartSeconds !== "undefined") {
        videoPayload["clip_start_seconds"] = clipStartSeconds;
      }
      // Parity clamp backstop (the tool parser already clamps with a
      // Spanish warning): an overflowing direct-client window is clamped
      // to the 24 h range instead of failing, mirroring the proxy trim.
      if (
        typeof clipStartSeconds !== "undefined"
        && typeof clipDurationSeconds !== "undefined"
        && clipStartSeconds + clipDurationSeconds > MAX_CLIP_SECONDS
      ) {
        if (clipStartSeconds >= MAX_CLIP_SECONDS) {
          throw new Error(
            `video.clip_start_seconds (${String(clipStartSeconds)}) ya llegó al límite de ${String(MAX_CLIP_SECONDS)} segundos (24 h): baje el inicio para dejar una ventana analizable. / video.clip_start_seconds (${String(clipStartSeconds)}) already reached the ${String(MAX_CLIP_SECONDS)} s limit (24 h): lower the start to leave an analyzable window.`
          );
        }
        clipDurationSeconds = MAX_CLIP_SECONDS - clipStartSeconds;
        localWarnings.push(
          buildClipWindowClampedWarning(
            clipStartSeconds,
            requestedClipDuration ?? clipDurationSeconds,
            clipDurationSeconds,
            MAX_CLIP_SECONDS,
          )
        );
      }
      if (typeof clipDurationSeconds !== "undefined") {
        videoPayload["clip_duration_seconds"] = clipDurationSeconds;
      }
      const segmentSeconds: number | undefined = EnriProxyClient.requireOptionalNumber(
        params.video.segmentSeconds,
        "video.segment_seconds",
        5,
        600,
      );
      if (typeof segmentSeconds !== "undefined") {
        videoPayload["segment_seconds"] = segmentSeconds;
      }
      const maxSegments: number | undefined = EnriProxyClient.requireOptionalInt(
        params.video.maxSegments,
        "video.max_segments",
        1,
        60,
      );
      if (typeof maxSegments !== "undefined") {
        videoPayload["max_segments"] = maxSegments;
      }
      const maxFramesPerSegment: number | undefined = EnriProxyClient.requireOptionalInt(
        params.video.maxFramesPerSegment,
        "video.max_frames_per_segment",
        1,
        20,
      );
      if (typeof maxFramesPerSegment !== "undefined") {
        videoPayload["max_frames_per_segment"] = maxFramesPerSegment;
      }
      if (Object.keys(videoPayload).length > 0) {
        payload["video"] = videoPayload;
      }
    }

    if (params.document && typeof params.document === "object") {
      const documentPayload: Record<string, unknown> = {};
      const maxPagesTotal: number | undefined = EnriProxyClient.requireOptionalInt(
        params.document.maxPagesTotal,
        "document.max_pages_total",
        1,
        200,
      );
      if (typeof maxPagesTotal !== "undefined") {
        documentPayload["max_pages_total"] = maxPagesTotal;
      }
      const pagesPerBatch: number | undefined = EnriProxyClient.requireOptionalInt(
        params.document.pagesPerBatch,
        "document.pages_per_batch",
        1,
        200,
      );
      if (typeof pagesPerBatch !== "undefined") {
        documentPayload["pages_per_batch"] = pagesPerBatch;
      }
      EnriProxyClient.throwOnBatchExceedingTotal(pagesPerBatch, maxPagesTotal, "document");
      const maxImagesPerBatch: number | undefined = EnriProxyClient.requireOptionalInt(
        params.document.maxImagesPerBatch,
        "document.max_images_per_batch",
        0,
        20,
      );
      if (typeof maxImagesPerBatch !== "undefined") {
        documentPayload["max_images_per_batch"] = maxImagesPerBatch;
      }
      const scannedTextThresholdChars: number | undefined = EnriProxyClient.requireOptionalInt(
        params.document.scannedTextThresholdChars,
        "document.scanned_text_threshold_chars",
        0,
        5000,
      );
      if (typeof scannedTextThresholdChars !== "undefined") {
        documentPayload["scanned_text_threshold_chars"] = scannedTextThresholdChars;
      }
      if (Object.keys(documentPayload).length > 0) {
        payload["document"] = documentPayload;
      }
    }

    if (params.audio && typeof params.audio === "object") {
      const audioPayload: Record<string, unknown> = {};
      const timestamps: boolean | undefined = EnriProxyClient.requireOptionalBoolean(
        params.audio.timestamps,
        "audio.timestamps",
      );
      if (typeof timestamps !== "undefined") {
        audioPayload["timestamps"] = timestamps;
      }
      const audioSegmentSeconds: number | undefined = EnriProxyClient.requireOptionalNumber(
        params.audio.segmentSeconds,
        "audio.segment_seconds",
        5,
        600,
      );
      if (typeof audioSegmentSeconds !== "undefined") {
        audioPayload["segment_seconds"] = audioSegmentSeconds;
      }
      const audioMaxSegments: number | undefined = EnriProxyClient.requireOptionalInt(
        params.audio.maxSegments,
        "audio.max_segments",
        1,
        60,
      );
      if (typeof audioMaxSegments !== "undefined") {
        audioPayload["max_segments"] = audioMaxSegments;
      }
      if (Object.keys(audioPayload).length > 0) {
        payload["audio"] = audioPayload;
      }
    }

    if (params.images && typeof params.images === "object") {
      const imagesPayload: Record<string, unknown> = {};
      const maxImagesTotal: number | undefined = EnriProxyClient.requireOptionalInt(
        params.images.maxImagesTotal,
        "images.max_images_total",
        1,
        500,
      );
      if (typeof maxImagesTotal !== "undefined") {
        imagesPayload["max_images_total"] = maxImagesTotal;
      }
      const imagesPerBatch: number | undefined = EnriProxyClient.requireOptionalInt(
        params.images.imagesPerBatch,
        "images.images_per_batch",
        1,
        20,
      );
      if (typeof imagesPerBatch !== "undefined") {
        imagesPayload["images_per_batch"] = imagesPerBatch;
      }
      EnriProxyClient.throwOnBatchExceedingTotal(imagesPerBatch, maxImagesTotal, "images");
      const maxDimension: number | undefined = EnriProxyClient.requireOptionalInt(
        params.images.maxDimension,
        "images.max_dimension",
        256,
        4096,
      );
      if (typeof maxDimension !== "undefined") {
        imagesPayload["max_dimension"] = maxDimension;
      }
      if (Object.keys(imagesPayload).length > 0) {
        payload["images"] = imagesPayload;
      }
    }

    const analyzeTimeoutMs: number =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? Math.floor(params.timeoutMs)
        : this.timeoutMs;
    const result = await this.requestJson("POST", url, payload, analyzeTimeoutMs, params.signal);
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `El análisis de visión falló (HTTP ${result.status}). / Vision analysis failed (HTTP ${result.status}).`,
        result,
      );
    }

    return EnriProxyClient.requireValidAnalyzeResponse(
      EnriProxyClient.parseJsonBody<unknown>(result.body, result.status),
      localWarnings,
    );
  }

  /**
   * Reads one continuation window over a truncated media list.
   *
   * @param params - Cursor plus optional offset/limit.
   * @returns Page entries with totals and continuation state.
   * @throws Error with a Spanish-first bilingual message on invalid
   * cursors, expired cursors, or malformed responses.
   */
  public async fetchSegmentPage(params: FetchSegmentPageParams): Promise<SegmentPageResponse> {
    const source: Record<string, unknown> = (params ?? {}) as unknown as Record<string, unknown>;
    const cursor: unknown = source["cursor"];
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) {
      throw new Error("cursor debe ser el cursor opaco devuelto en una respuesta truncada. / cursor must be the opaque cursor from a truncated response.");
    }
    const offset: unknown = source["offset"];
    if (typeof offset !== "undefined" && (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0)) {
      throw new Error("offset debe ser un entero mayor o igual que 0. / offset must be an integer greater than or equal to 0.");
    }
    const limit: unknown = source["limit"];
    if (typeof limit !== "undefined" && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)) {
      throw new Error("limit debe ser un entero mayor o igual que 1. / limit must be an integer greater than or equal to 1.");
    }
    const url = this.buildUrl("/v1/vision/segments");
    const payload: Record<string, unknown> = { cursor };
    if (typeof offset !== "undefined") {
      payload["offset"] = Math.floor(offset);
    }
    if (typeof limit !== "undefined") {
      payload["limit"] = Math.floor(limit);
    }
    const timeoutMs: number =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? Math.floor(params.timeoutMs)
        : this.timeoutMs;
    const result = await this.requestJson("POST", url, payload, timeoutMs, params.signal);
    if (result.status < 200 || result.status >= 300) {
      throw EnriProxyClient.buildHttpError(
        `La lectura de continuación falló (HTTP ${result.status}). / Continuation read failed (HTTP ${result.status}).`,
        result,
      );
    }
    return EnriProxyClient.requireValidSegmentPage(EnriProxyClient.parseJsonBody<unknown>(result.body, result.status));
  }

  /**
   * Validates one continuation page body.
   *
   * @param raw - Parsed response body.
   * @returns Validated page.
   * @throws Error with a Spanish-first bilingual message when the body
   * carries no usable page.
   */
  private static requireValidSegmentPage(raw: unknown): SegmentPageResponse {
    const record: Record<string, unknown> =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (!Array.isArray(record["entries"])) {
      throw new Error("La respuesta de continuación no trae entries. / Continuation response carries no entries.");
    }
    const total: unknown = record["total"];
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      throw new Error("La respuesta de continuación no trae total. / Continuation response carries no total.");
    }
    const nextOffset: unknown = record["next_offset"];
    if (typeof nextOffset !== "number" || !Number.isFinite(nextOffset) || nextOffset < 0) {
      throw new Error("La respuesta de continuación no trae next_offset. / Continuation response carries no next_offset.");
    }
    return {
      entries: record["entries"] as ReadonlyArray<unknown>,
      total: Math.floor(total),
      hasMore: record["has_more"] === true,
      nextOffset: Math.floor(nextOffset),
      cursor: typeof record["cursor"] === "string" ? (record["cursor"] as string) : "",
    };
  }

  /**
   * Rejects oversized prompt text before any byte is uploaded.
   *
   * @remarks
   * Mirrors the parser gate (2000 chars): the server 400s after upload cost.
   *
   * @param value - Optional prompt text.
   * @param fieldName - `question` or `context`.
   * @throws Error in Spanish naming the 2000-character cap.
   */
  private static requireBoundedPromptText(value: unknown, fieldName: string): void {
    if (typeof value === "undefined") {
      return;
    }
    // Strict like the tool parser: a non-string prompt is a caller bug,
    // not an empty prompt.
    if (typeof value !== "string") {
      throw new Error(`${fieldName} debe ser una cadena de texto. / ${fieldName} must be a string.`);
    }
    if (Array.from(value).length > 2000) {
      throw new Error(
        `${fieldName} excede el máximo de 2000 caracteres. Acorte el texto y reintente: el servidor rechaza este mismo tope después de cobrar el upload. / ${fieldName} exceeds the 2000-char maximum. Shorten the text and retry: the server rejects this same cap after charging the upload.`
      );
    }
  }

  /**
   * Rejects mistyped tuning before any upload cost on the direct-client path.
   *
   * @remarks
   * Mirrors `AnalyzeMediaParamParser` (enum, language pattern, section
   * key closure): direct callers bypass the tool parser, and a typo would
   * otherwise analyze the whole file at full cost. Exposed for reuse and
   * unit-pinned against the parser key sets.
   *
   * @param params - Analysis parameters about to travel.
   * @throws Error with a Spanish-first bilingual message on the first defect.
   */
  public static requirePreUploadTuning(params: AnalyzeVisionParams): void {
    if (typeof params.analysisMode === "string" && params.analysisMode.trim()) {
      const mode: string = params.analysisMode.trim();
      if (mode !== "auto" && mode !== "single" && mode !== "multipass") {
        throw new Error("analysis_mode debe ser uno de: auto|single|multipass. / analysis_mode must be one of: auto|single|multipass.");
      }
    }
    EnriProxyClient.requireLanguageHint(params.language, "language");
    EnriProxyClient.requireLanguageHint(params.transcriptionLanguage, "transcription_language");
    EnriProxyClient.requireKnownSectionKeys(params.video, VIDEO_KNOWN_KEYS, "video");
    EnriProxyClient.requireKnownSectionKeys(params.document, DOCUMENT_KNOWN_KEYS, "document");
    EnriProxyClient.requireKnownSectionKeys(params.audio, AUDIO_KNOWN_KEYS, "audio");
    EnriProxyClient.requireKnownSectionKeys(params.images, IMAGES_KNOWN_KEYS, "images");
  }

  /**
   * Validates one language hint against the parser pattern.
   *
   * @param value - Candidate hint.
   * @param fieldName - Dotted field name for error messages.
   * @returns Nothing.
   * @throws Error with a Spanish-first bilingual message on mismatch.
   */
  private static requireLanguageHint(value: unknown, fieldName: string): void {
    if (typeof value === "undefined") {
      return;
    }
    if (typeof value !== "string") {
      throw new Error(`${fieldName} debe ser una cadena de texto. / ${fieldName} must be a string.`);
    }
    const trimmed: string = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed.length > 32 || !/^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,2}$/.test(trimmed)) {
      throw new Error(`${fieldName} debe ser un código de idioma como 'es', 'en' o 'auto' (máximo 32 caracteres). / ${fieldName} must be a language code like 'es', 'en', or 'auto' (max 32 chars).`);
    }
  }

  /**
   * Rejects unknown keys inside one tuning section.
   *
   * @param section - Candidate section object.
   * @param knownKeys - Parser-owned accepted spellings.
   * @param sectionName - Section name for error messages.
   * @returns Nothing.
   * @throws Error with a Spanish-first bilingual message on unknown keys.
   */
  private static requireKnownSectionKeys(
    section: unknown,
    knownKeys: ReadonlySet<string>,
    sectionName: string,
  ): void {
    if (typeof section === "undefined") {
      return;
    }
    if (section === null || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(`${sectionName} debe ser un objeto. / ${sectionName} must be an object.`);
    }
    const unknown: string[] = Object.keys(section).filter((key: string): boolean => !knownKeys.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${sectionName} tiene claves desconocidas (${unknown.join(", ")}): revise la escritura. / ${sectionName} has unknown keys (${unknown.join(", ")}): check the spelling.`
      );
    }
  }

  /**
   * Rejects per-batch sizes exceeding their totals on the direct-client path.
   *
   * @remarks
   * The tool parser already guards this; direct callers bypass it, and the
   * server would truncate after paid multipass work.
   *
   * @param perBatch - Per-batch value, or undefined when absent.
   * @param total - Total value, or undefined when absent.
   * @param family - `document` or `images`.
   * @throws Error with an Spanish-first bilingual message when the batch exceeds the total.
   */
  private static throwOnBatchExceedingTotal(
    perBatch: number | undefined,
    total: number | undefined,
    family: string,
  ): void {
    if (typeof perBatch !== "undefined" && typeof total !== "undefined" && perBatch > total) {
      const batchField: string = family === "document" ? "pages_per_batch" : "images_per_batch";
      const totalField: string = family === "document" ? "max_pages_total" : "max_images_total";
      throw new Error(
        `${family}.${batchField} supera a ${totalField} (${String(perBatch)} > ${String(total)}): el lote no puede ser mayor que el total. / ${family}.${batchField} exceeds ${totalField} (${String(perBatch)} > ${String(total)}): a batch cannot be greater than the total.`
      );
    }
  }

  /**
   * Coerces an optional integer tuning knob, failing loudly on garbage.
   *
   * @remarks
   * Parity with `AnalyzeMediaParamParser` (`optionalInt` accepts `"60"`):
   * integers and complete integer strings travel floored; any other present
   * value throws bilingually instead of being silently dropped (a dropped
   * knob would analyze the whole file at full cost with default tuning).
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @param min - Inclusive minimum (shares the parser range table so direct
   * callers fail pre-upload like parser-gated calls).
   * @param max - Inclusive maximum (shares the parser range table).
   * @returns Floored integer, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not an integer within range.
   */
  private static requireOptionalInt(raw: unknown, fieldName: string, min?: number, max?: number): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined = optionalInt(raw);
    if (typeof parsed === "undefined" || !Number.isFinite(parsed)) {
      throw new Error(`${fieldName} debe ser un entero (también vale su forma string como "60"). / ${fieldName} must be an integer (its string form like "60" also works).`);
    }
    const floored: number = Math.floor(parsed);
    if (typeof min === "number" && typeof max === "number" && (floored < min || floored > max)) {
      throw new Error(`${fieldName} debe ser un entero entre ${String(min)} y ${String(max)} (se recibió ${String(floored)}). / ${fieldName} must be an integer between ${String(min)} and ${String(max)} (got ${String(floored)}).`);
    }
    return floored;
  }

  /**
   * Coerces an optional float tuning knob, failing loudly on garbage.
   *
   * @remarks
   * Parity with `AnalyzeMediaParamParser` (`optionalNumber` accepts
   * `"12.5"`): numbers and complete numeric strings travel; any other
   * present value throws bilingually instead of being silently dropped.
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @param min - Inclusive minimum (shares the parser range table).
   * @param max - Inclusive maximum (shares the parser range table).
   * @returns Finite number, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not a number within range.
   */
  private static requireOptionalNumber(raw: unknown, fieldName: string, min?: number, max?: number): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined =
      typeof raw === "number" && Number.isFinite(raw) ? raw : optionalNumber(raw);
    if (typeof parsed === "undefined" || !Number.isFinite(parsed)) {
      throw new Error(`${fieldName} debe ser un número (también vale su forma string como "12.5"). / ${fieldName} must be a number (its string form like "12.5" also works).`);
    }
    if (typeof min === "number" && typeof max === "number" && (parsed < min || parsed > max)) {
      throw new Error(`${fieldName} debe ser un número entre ${String(min)} y ${String(max)} (se recibió ${String(parsed)}). / ${fieldName} must be a number between ${String(min)} and ${String(max)} (got ${String(parsed)}).`);
    }
    return parsed;
  }

  /**
   * Coerces an optional boolean tuning knob, failing loudly on garbage.
   *
   * @remarks
   * Parity with `AnalyzeMediaParamParser` (`assertOptionalBoolean` accepts
   * `"true"`/`"false"`): booleans and true/false strings travel; any
   * other present value throws bilingually instead of being silently dropped.
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @returns Boolean, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not a boolean.
   */
  private static requireOptionalBoolean(raw: unknown, fieldName: string): boolean | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (typeof raw === "boolean") {
      return raw;
    }
    if (typeof raw === "string") {
      const normalized: string = raw.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    throw new Error(`${fieldName} debe ser un booleano (true o false; también vale "true"/"false"). / ${fieldName} must be a boolean (true or false; "true"/"false" also work).`);
  }

  /**
   * Resolves the `transcribe` knob, defaulting to true like EnriCode.
   *
   * @remarks
   * A `"false"` string must never collapse to the `true` default (that
   * would pay a full transcription the caller explicitly disabled):
   * true/false strings coerce, anything else present throws in Spanish.
   *
   * @param raw - Raw transcribe value.
   * @returns Resolved transcribe flag.
   * @throws Error with an Spanish-first bilingual message when present but not a boolean nor a true/false string.
   */
  private static requireTranscribe(raw: unknown): boolean {
    if (typeof raw === "undefined") {
      return true;
    }
    const parsed: boolean | undefined = EnriProxyClient.requireOptionalBoolean(raw, "transcribe");
    return parsed ?? true;
  }

  /**
   * Validates a `POST /v1/vision/analyze` response body for third-party callers.
   *
   * @remarks
   * A malformed 200 body (`{}`, `analysis: 123`, missing `media_type`)
   * must surface as a Spanish coaching error, never as an English
   * `TypeError` from downstream formatters (model-facing text is always
   * Spanish). Malformed `elements` entries are sanitized (dropped), not
   * fatal: partial grounding still analyzes.
   *
   * @param raw - Parsed response body.
   * @returns Validated analysis response.
   * @throws Error with an Spanish-first bilingual message when the body shape is invalid.
   */
  private static requireValidAnalyzeResponse(raw: unknown, localWarnings?: ReadonlyArray<string>): AnalyzeVisionResponse {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("La respuesta del servidor es inválida: se esperaba un objeto JSON con 'analysis', 'media_type' y 'extraction'. / Server response is invalid: expected a JSON object with 'analysis', 'media_type', and 'extraction'.");
    }
    const record = raw as Record<string, unknown>;
    const analysis: unknown = record["analysis"];
    if (typeof analysis !== "string" || analysis.trim().length === 0) {
      throw new Error("La respuesta del servidor es inválida: 'analysis' debe ser texto no vacío. / Server response is invalid: 'analysis' must be non-empty text.");
    }
    const mediaType: unknown = record["media_type"];
    if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
      throw new Error("La respuesta del servidor es inválida: 'media_type' debe ser texto no vacío. / Server response is invalid: 'media_type' must be non-empty text.");
    }
    const extraction: unknown = record["extraction"];
    if (typeof extraction !== "undefined" && (typeof extraction !== "object" || extraction === null || Array.isArray(extraction))) {
      throw new Error("La respuesta del servidor es inválida: 'extraction' debe ser un objeto. / Server response is invalid: 'extraction' must be an object.");
    }
    const elements: unknown = record["elements"];
    if (typeof elements !== "undefined" && !Array.isArray(elements)) {
      throw new Error("La respuesta del servidor es inválida: 'elements' debe ser un arreglo de cajas. / Server response is invalid: 'elements' must be an array of boxes.");
    }
    return {
      analysis,
      media_type: mediaType,
      extraction: (extraction ?? {}) as Record<string, unknown>,
      ...(typeof elements !== "undefined"
        ? { elements: EnriProxyClient.sanitizeAnalyzeElements(elements) }
        : {}),
      ...(typeof localWarnings !== "undefined" && localWarnings.length > 0 ? { warnings: [...localWarnings] } : {}),
    };
  }

  /**
   * Keeps only well-formed grounded element boxes.
   *
   * @remarks
   * Malformed entries (non-string label, non-finite box coordinates) are
   * dropped so one bad box never fails the whole analysis; downstream
   * formatters can assume `{label, box: {x, y, width, height}}`.
   *
   * @param elements - Raw elements array from the server.
   * @returns Sanitized element boxes.
   */
  private static sanitizeAnalyzeElements(elements: readonly unknown[]): ReadonlyArray<AnalyzeVisionElement> {
    const kept: AnalyzeVisionElement[] = [];
    for (const candidate of elements) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        continue;
      }
      const record = candidate as Record<string, unknown>;
      if (typeof record["label"] !== "string") {
        continue;
      }
      const box: unknown = record["box"];
      if (typeof box !== "object" || box === null || Array.isArray(box)) {
        continue;
      }
      const boxRecord = box as Record<string, unknown>;
      const coords: readonly unknown[] = [boxRecord["x"], boxRecord["y"], boxRecord["width"], boxRecord["height"]];
      if (!coords.every((coord: unknown): boolean => typeof coord === "number" && Number.isFinite(coord))) {
        continue;
      }
      kept.push({
        label: record["label"] as string,
        box: {
          x: boxRecord["x"] as number,
          y: boxRecord["y"] as number,
          width: boxRecord["width"] as number,
          height: boxRecord["height"] as number,
        },
      });
    }
    return kept;
  }

  /**
   * Builds an {@link EnriProxyHttpError} embedding the parsed server detail.
   *
   * @param baseMessage - Base message naming the failed operation with its HTTP status.
   * @param result - Raw HTTP result carrying headers and body.
   * @returns HTTP error preserving status, headers, and body.
   */
  private static buildHttpError(baseMessage: string, result: EnriProxyHttpResult): EnriProxyHttpError {
    const insight: ServerErrorInsight = extractServerErrorInsight(result.body);
    const fieldSuffix: string = insight.field !== undefined ? ` [campo/field: ${insight.field}]` : "";
    const message: string =
      insight.detail !== null ? `${baseMessage} Detalle del servidor: ${insight.detail}${fieldSuffix}` : baseMessage;
    return new EnriProxyHttpError(
      message,
      result.status,
      result.headers,
      result.body,
      insight.code,
      insight.field
    );
  }

  /**
   * Parses a 2xx JSON body with a bilingual guard for non-JSON payloads.
   *
   * @param body - Raw response body.
   * @param status - HTTP status code (reported in the error).
   * @returns Parsed body.
   * @throws Error with an Spanish-first bilingual message when the body is not valid JSON.
   */
  private static parseJsonBody<T>(body: string, status: number): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`La respuesta del servidor no es JSON válido (HTTP ${String(status)}). / Server response is not valid JSON (HTTP ${String(status)}).`);
    }
  }

  /**
   * Builds an absolute URL relative to the configured base URL.
   *
   * @remarks
   * The base subpath is preserved (`http://host/proxy` + `/v1/uploads` =
   * `http://host/proxy/v1/uploads`): `new URL(path, base)` alone would
   * discard it. A root base keeps working exactly as before.
   *
   * @param pathname - Pathname to append (must start with `/`).
   * @returns URL instance
   * @throws Error with an Spanish-first bilingual message when the configured base URL is malformed.
   */
  private buildUrl(pathname: string): URL {
    try {
      return new URL(`${this.baseUrl}${pathname}`);
    } catch {
      throw new Error(`ENRIPROXY_URL inválida: '${this.baseUrl}'. Use una URL http(s) completa. / Invalid ENRIPROXY_URL: '${this.baseUrl}'. Use a complete http(s) URL.`);
    }
  }

  /**
   * Parses a strict `Upload-Offset` response header.
   *
   * @remarks
   * Strict by design: only `^\d+$` (after trimming) is accepted, so
   * `"12abc"` or `"1.5"` fail bilingually instead of being prefix-parsed
   * (`parseInt("12abc") === 12`) and resuming at a wrong offset.
   *
   * @param headers - Response headers.
   * @returns Offset in bytes.
   * @throws Error with an Spanish-first bilingual message when the header is missing or malformed.
   */
  private parseUploadOffsetHeader(
    headers: Record<string, string | string[] | undefined>,
  ): number {
    const offsetHeader = this.getHeaderValue(headers, "upload-offset");
    if (!offsetHeader) {
      throw new Error("Falta el encabezado Upload-Offset en la respuesta del servidor. / Missing Upload-Offset header in the server response.");
    }
    const trimmed: string = offsetHeader.trim();
    if (!/^\d+$/u.test(trimmed)) {
      throw new Error(`Encabezado Upload-Offset inválido: ${offsetHeader} / Invalid Upload-Offset header: ${offsetHeader}.`);
    }
    return Number.parseInt(trimmed, 10);
  }

  /**
   * Validates a relative image region for native-resolution zoom.
   *
   * @remarks
   * Mirrors the `AnalyzeMediaParamParser` region contract (`[0,1]` bounds,
   * positive size, `x+width<=1`/`y+height<=1`, complete numeric strings
   * coerced via `optionalFraction`) so direct client callers get the same
   * Spanish coaching instead of a late server rejection.
   *
   * @param region - Raw region value.
   * @returns Validated region payload.
   * @throws Error with an Spanish-first bilingual message when the region is malformed or out of range.
   */
  private static requireValidRegion(region: {
    readonly x: unknown;
    readonly y: unknown;
    readonly width: unknown;
    readonly height: unknown;
  }): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
    const unknownKeys: string[] = Object.keys(region).filter(
      (key: string): boolean => key !== "x" && key !== "y" && key !== "width" && key !== "height",
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `region trae claves desconocidas (${unknownKeys.join(", ")}): se rechazan. Claves válidas: x, y, width, height. / region has unknown keys (${unknownKeys.join(", ")}): they are rejected. Valid keys: x, y, width, height.`
      );
    }
    const readFraction = (value: unknown, fieldName: string): number => {
      const parsed: number | undefined =
        typeof value === "number" && Number.isFinite(value) ? value : optionalFraction(value);
      if (typeof parsed === "undefined" || parsed < 0 || parsed > 1) {
        throw new Error(
          `region.${fieldName} debe ser un número entre 0 y 1 (coordenadas relativas a la imagen original). / region.${fieldName} must be a number between 0 and 1 (coords relative to the original image).`
        );
      }
      return parsed;
    };
    const valid = {
      x: readFraction(region.x, "x"),
      y: readFraction(region.y, "y"),
      width: readFraction(region.width, "width"),
      height: readFraction(region.height, "height"),
    };
    if (valid.width <= 0 || valid.height <= 0) {
      throw new Error("region.width y region.height deben ser mayores que 0. / region.width and region.height must be greater than 0.");
    }
    if (valid.x + valid.width > 1 || valid.y + valid.height > 1) {
      throw new Error("region debe caber en la imagen original: x+width y y+height no pueden exceder 1. / region must fit inside the original image: x+width and y+height cannot exceed 1.");
    }
    return valid;
  }

  /**
   * Resolves the session-creation control timeout (60 s, mirrors EnriCode).
   *
   * @returns Control timeout in milliseconds (never above 60 s).
   */
  private createControlTimeoutMs(): number {
    if (Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
      return Math.min(this.timeoutMs, CREATE_CONTROL_TIMEOUT_MS);
    }
    return CREATE_CONTROL_TIMEOUT_MS;
  }

  /**
   * Resolves the offset-probe control timeout (15 s, mirrors EnriCode).
   *
   * @returns Control timeout in milliseconds (never above 15 s).
   */
  private probeControlTimeoutMs(): number {
    if (Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
      return Math.min(this.timeoutMs, PROBE_CONTROL_TIMEOUT_MS);
    }
    return PROBE_CONTROL_TIMEOUT_MS;
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
   * @param signal - Optional cancellation signal.
   * @returns HTTP result
   */
  private async requestJson(
    method: "POST" | "PUT",
    url: URL,
    jsonBody: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<EnriProxyHttpResult> {
    const body = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    };
    return await this.requestRaw(method, url, headers, Buffer.from(body, "utf8"), timeoutMs, signal);
  }

  /**
   * Sends an HTTP request with optional headers and body.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param headers - Request headers
   * @param body - Request body
   * @param timeoutMs - Timeout in milliseconds
   * @param signal - Optional cancellation signal; aborts with a Spanish error.
   * @returns HTTP result
   */
  private async requestRaw(
    method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT",
    url: URL,
    headers: Record<string, string> | undefined,
    body: Buffer | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<EnriProxyHttpResult> {
    if (signal?.aborted) {
      throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
    }
    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(headers ?? {})
    };

    return await new Promise<EnriProxyHttpResult>((resolve, reject) => {
      const req = reqFn(
        url,
        {
          method,
          headers: requestHeaders
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          // Settles exactly once: the overflow path rejects inline (destroy
          // events are unreliable once the socket teardown starts) while a
          // buffered socket may still emit `end` (which would resolve with
          // truncated bytes). The flag plus the overflow marker below make
          // oversize bodies always reject.
          let settled = false;
          let overflowed = false;
          const maxResponseBytes = 50 * 1024 * 1024; // 50MB safeguard
          const overflowError = (): Error =>
            new Error(
              "La respuesta excedió el tamaño máximo permitido (50 MiB); se descartó, nunca truncada. / Response exceeded the maximum allowed size (50 MiB); it was discarded, never truncated."
            );

          res.on("data", (chunk: Buffer) => {
            if (settled) {
              return;
            }
            received += chunk.length;
            if (received > maxResponseBytes) {
              // Reject inline: destroying the request/response does not
              // reliably surface another event (the socket teardown can
              // swallow the destroy error), so the promise must settle here.
              // The `end` handler below keeps the overflowed backstop for
              // the same-tick race where `end` wins regardless.
              overflowed = true;
              settled = true;
              try {
                res.destroy();
              } catch {
                // Best-effort: the inline rejection below carries the error.
              }
              try {
                req.destroy();
              } catch {
                // Best-effort: the inline rejection below carries the error.
              }
              reject(overflowError());
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            signal?.removeEventListener("abort", onAbort);
            req.setTimeout(0);
            if (settled) {
              return;
            }
            settled = true;
            if (overflowed) {
              reject(overflowError());
              return;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });

          res.on("error", (error: Error) => {
            signal?.removeEventListener("abort", onAbort);
            req.setTimeout(0);
            if (settled) {
              return;
            }
            settled = true;
            reject(error);
          });
        }
      );

      const onAbort = (): void => {
        req.destroy(new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      req.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        req.setTimeout(0);
        reject(error);
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`La petición expiró después de ${timeoutMs}ms / Request timed out after ${timeoutMs}ms.`));
      });

      if (body && body.length > 0 && method !== "HEAD") {
        req.write(body);
      }
      req.end();
    });
  }
}

/**
 * Validates an optional clip-window start bound.
 *
 * @remarks
 * Mirrors `AnalyzeMediaParamParser` float semantics (`0-86400`): only
 * `undefined` is omitted; numbers and complete numeric strings inside the
 * range travel, otherwise it throws bilingually instead of being coerced.
 *
 * @param raw - Raw bound value.
 * @param fieldName - Dotted field name for error messages.
 * @returns Validated bound, or undefined when absent.
 * @throws Error with an Spanish-first bilingual message when present but not a number within range.
 */
function requireClipBound(raw: unknown, fieldName: string): number | undefined {
  if (typeof raw === "undefined") {
    return undefined;
  }
  const parsed: number | undefined =
    typeof raw === "number" && Number.isFinite(raw) ? raw : optionalNumber(raw);
  if (typeof parsed === "undefined" || !Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CLIP_SECONDS) {
    throw new Error(`${fieldName} debe ser un número entre 0 y ${String(MAX_CLIP_SECONDS)} (segundos). / ${fieldName} must be a number between 0 and ${String(MAX_CLIP_SECONDS)} (seconds).`);
  }
  return parsed;
}

/**
 * Validates an optional clip-window duration.
 *
 * @remarks
 * Mirrors `AnalyzeMediaParamParser` duration semantics (`(0, 86400]`):
 * only `undefined` is omitted; numbers and complete numeric strings in
 * range travel, otherwise it throws bilingually instead of being silently
 * dropped.
 *
 * @param raw - Raw duration value.
 * @returns Validated duration, or undefined when absent.
 * @throws Error with an Spanish-first bilingual message when present but not a positive number within range.
 */
function requireClipDuration(raw: unknown): number | undefined {
  if (typeof raw === "undefined") {
    return undefined;
  }
  const parsed: number | undefined =
    typeof raw === "number" && Number.isFinite(raw) ? raw : optionalNumber(raw);
  if (
    typeof parsed === "undefined"
    || !Number.isFinite(parsed)
    || parsed <= 0
    || parsed > MAX_CLIP_SECONDS
  ) {
    throw new Error(
      `video.clip_duration_seconds debe ser un número mayor que 0 y menor o igual que ${String(MAX_CLIP_SECONDS)} (segundos). / video.clip_duration_seconds must be a number greater than 0 and at most ${String(MAX_CLIP_SECONDS)} (seconds).`
    );
  }
  return parsed;
}
