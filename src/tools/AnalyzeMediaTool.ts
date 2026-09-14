/**
 * ANALYZE MEDIA TOOL
 *
 * Facade for the `analyze_media` MCP tool:
 * - Validates local file paths or http(s) URLs (param parser)
 * - Materializes URL inputs via bounded downloads (input resolver)
 * - Uploads single files or multi-image tar sets through resumable
 *   EnriProxy sessions (uploader + tar packager)
 * - Triggers server-side analysis and returns sanitized text-only results
 *
 * @module tools/AnalyzeMediaTool
 */

import { randomUUID } from "node:crypto";

import { lookup as mimeLookup } from "mime-types";

import { assertHttpUrl, assertNonEmptyString } from "../shared/validation.js";
import { MediaUrlFetcher } from "../shared/mediaUrlFetcher.js";
import { EnriProxyHttpError } from "../client/EnriProxyClient.js";
import type { EnriProxyClient } from "../client/EnriProxyClient.js";
import { AnalyzeMediaExtractionSanitizer } from "./AnalyzeMediaExtractionSanitizer.js";
import { AnalyzeMediaInputResolver } from "./AnalyzeMediaInputResolver.js";
import { AnalyzeMediaParamParser } from "./AnalyzeMediaParamParser.js";
import { AnalyzeMediaResumableUploader } from "./AnalyzeMediaResumableUploader.js";
import { isProgressQuiet, withResumableRetry } from "./AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTarPackager } from "./AnalyzeMediaTarPackager.js";
import type {
  AnalyzeMediaElementBox,
  AnalyzeMediaExecutionOptions,
  AnalyzeMediaToolDeps,
  AnalyzeMediaToolParams,
  AnalyzeMediaToolResult,
  ImageRegion,
} from "./AnalyzeMediaContract.js";
import { ANALYZE_MEDIA_LIMITS } from "./AnalyzeMediaContract.js";

export type {
  AnalyzeMediaElementBox,
  AnalyzeMediaExecutionOptions,
  AnalyzeMediaToolDeps,
  AnalyzeMediaToolParams,
  AnalyzeMediaToolResult,
  ImageRegion,
};

/**
 * MCP tool that uploads and analyzes local or http(s) URL media.
 */
export class AnalyzeMediaTool {
  /**
   * Tool dependencies.
   */
  private readonly deps: AnalyzeMediaToolDeps;

  /**
   * Raw argument validator.
   */
  private readonly paramParser: AnalyzeMediaParamParser;

  /**
   * Local/URL input materializer.
   */
  private readonly inputResolver: AnalyzeMediaInputResolver;

  /**
   * Resumable chunk uploader.
   */
  private readonly uploader: AnalyzeMediaResumableUploader;

  /**
   * Multi-image tar set packager.
   */
  private readonly tarPackager: AnalyzeMediaTarPackager;

  /**
   * Extraction output sanitizer.
   */
  private readonly sanitizer: AnalyzeMediaExtractionSanitizer;

  /**
   * Cached vision-capability verdicts keyed by endpoint + model.
   *
   * @remarks
   * `execute` builds a fresh client per call, so instance-keyed caching
   * would never hit: the key is `serverUrl + model` (one account per
   * endpoint). Entries live for `ANALYZE_MEDIA_LIMITS.visionProbeCacheTtlMs`
   * (mirrors EnriCode `PROBE_CACHE_TTL_MS` and its per-client scoping).
   */
  private readonly visionProbeCache: Map<string, { readonly verdict: boolean; readonly expiresAt: number }> =
    new Map();

  /**
   * Creates a new {@link AnalyzeMediaTool}.
   *
   * @param deps - Tool dependencies.
   * @param urlFetcher - Optional URL fetcher override for tests.
   */
  public constructor(deps: AnalyzeMediaToolDeps, urlFetcher: MediaUrlFetcher = new MediaUrlFetcher()) {
    this.deps = deps;
    this.paramParser = new AnalyzeMediaParamParser();
    this.inputResolver = new AnalyzeMediaInputResolver(urlFetcher);
    this.uploader = new AnalyzeMediaResumableUploader();
    this.tarPackager = new AnalyzeMediaTarPackager(this.uploader);
    this.sanitizer = new AnalyzeMediaExtractionSanitizer();
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments.
   * @returns Validated parameters.
   * @throws Error with an Spanish-first bilingual message when arguments are missing or out of range.
   */
  public parseParams(raw: unknown): AnalyzeMediaToolParams {
    return this.paramParser.parseParams(raw);
  }

  /**
   * Executes the tool.
   *
   * @param params - Validated parameters.
   * @param options - Optional execution options (cancellation signal).
   * @returns Tool result.
   * @throws Error with an Spanish-first bilingual message when configuration, upload, or analysis fails.
   */
  public async execute(
    params: AnalyzeMediaToolParams,
    options?: AnalyzeMediaExecutionOptions,
  ): Promise<AnalyzeMediaToolResult> {
    const signal: AbortSignal | undefined = options?.signal;
    if (signal?.aborted) {
      throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
    }

    const serverUrl: string = assertHttpUrl(this.deps.defaultServerUrl, "ENRIPROXY_URL");
    const apiKey: string = assertNonEmptyString(this.deps.defaultApiKey, "ENRIPROXY_API_KEY");
    const timeoutMs: number = this.deps.defaultTimeoutMs;

    const clientTraceId: string = `enrivision_${randomUUID()}`;
    const client = this.deps.createClient(serverUrl, apiKey, timeoutMs);

    // Continuation mode: no upload, no analysis, no filesystem touch — only
    // the next window of a previously truncated list.
    if (typeof params.cursor === "string") {
      return await this.executeContinuation(client, params.cursor, params.offset, signal);
    }

    const resolved = await this.inputResolver.resolve(params, signal);
    let uploadId: string | null = null;
    try {
      // Inside the try so the finally below always releases materialized
      // URL downloads, even when the region check throws (A1).
      this.rejectRegionForNonImage(params.region, resolved.inputs);
      this.rejectMismatchedTuning(params, resolved.inputs);
      // Fail-open vision probe (mirrors EnriCode `assertRemoteVisionCapable`):
      // with an explicit visionless model, fail before any session or byte
      // instead of uploading up to 4 GiB first. Only `vision === false`
      // rejects; unknown models and probe failures proceed (fail-open).
      await this.assertVisionCapable(client, this.resolveRequestedModel(params), signal);
      // Advisory mismatch warnings for the remote (`source_url`) branch: the
      // local gates above no-op on the empty input list by design (the server,
      // which sees the served type, decides applicability), but when the URL
      // extension guesses a known media type, likely-ignored tuning is
      // declared as warnings instead of failing.
      const remoteUrl: string | undefined = resolved.remoteUrl;
      const remoteAdvisoryWarnings: ReadonlyArray<string> =
        remoteUrl !== undefined ? this.advisoryRemoteTuningWarnings(params, remoteUrl) : [];
      const transcribeWarning: string | undefined = this.transcribeInapplicableWarning(
        params,
        resolved.inputs,
      );
      // Oversized lone URLs skip upload entirely: the server ingests
      // `source_url` directly (SSRF guards already passed client-side).
      if (remoteUrl === undefined && resolved.inputs.length > 1) {
        uploadId = await this.tarPackager.uploadImageSetAsMediaSetTar(
          client,
          resolved.inputs,
          timeoutMs,
          clientTraceId,
          signal,
        );
      } else if (remoteUrl === undefined) {
        const single = resolved.inputs[0]!;
        const session = await withResumableRetry(
          () =>
            client.createUploadSession({
              filename: single.filename,
              sizeBytes: single.sizeBytes,
              contentType: single.contentType,
              clientTraceId,
              signal,
            }),
          signal,
        );
        const serverMaxBytes: number | null =
          typeof session.max_file_size_bytes === "number"
          && Number.isFinite(session.max_file_size_bytes)
          && session.max_file_size_bytes > 0
            ? Math.floor(session.max_file_size_bytes)
            : null;
        if (serverMaxBytes !== null && single.sizeBytes > serverMaxBytes) {
          try {
            await client.deleteUploadSession(session.upload_id, AbortSignal.timeout(15_000));
          } catch {
            // Best-effort: the size error always wins.
          }
          throw new Error(
            `El archivo excede el tamaño máximo del servidor (${String(serverMaxBytes)} bytes); use un archivo más pequeño. / File exceeds the server maximum size (${String(serverMaxBytes)} bytes); use a smaller file.`
          );
        }

        const finalOffset: number = await this.uploader.uploadFileResumable(
          client,
          single.localPath,
          single.sizeBytes,
          session,
          timeoutMs,
          signal,
          single.stagedIdentity,
        );
        if (finalOffset !== single.sizeBytes) {
          throw new Error(
            `Subida incompleta: se enviaron ${finalOffset} de ${single.sizeBytes} bytes. / Incomplete upload: sent ${finalOffset} of ${single.sizeBytes} bytes.`,
          );
        }

        uploadId = session.upload_id;
      }

      const defaultLanguageRaw: string =
        typeof process.env["ENRIVISION_DEFAULT_LANGUAGE"] === "string"
          ? process.env["ENRIVISION_DEFAULT_LANGUAGE"].trim()
          : "";
      const defaultLanguageValid: boolean =
        defaultLanguageRaw.length > 0
        && defaultLanguageRaw.length <= 32
        && /^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,2}$/.test(defaultLanguageRaw);
      if (defaultLanguageRaw && !defaultLanguageValid && !isProgressQuiet()) {
        console.error(
          `enrivision: invalid ENRIVISION_DEFAULT_LANGUAGE ('${defaultLanguageRaw}'); ignoring it and using the server default. Use a code like 'es', 'en' or 'auto'.`
        );
      }
      const explicitLanguage: string =
        typeof params.language === "string" ? params.language.trim() : "";
      // Precedence: explicit `language` > ENRIVISION_DEFAULT_LANGUAGE > server default.
      const language: string | undefined = explicitLanguage
        ? explicitLanguage
        : defaultLanguageValid
          ? defaultLanguageRaw
          : undefined;
      if (!explicitLanguage && defaultLanguageRaw && defaultLanguageValid && !isProgressQuiet()) {
        console.error(
          `enrivision: effective response language '${defaultLanguageRaw}' (ENRIVISION_DEFAULT_LANGUAGE; the explicit 'language' parameter wins).`
        );
      }

      const envModelRaw: string =
        typeof process.env["ENRIVISION_MODEL"] === "string"
          ? process.env["ENRIVISION_MODEL"].trim()
          : "";
      const envModelValid: boolean = envModelRaw.length > 0 && envModelRaw.length <= 128;
      if (envModelRaw && !envModelValid && !isProgressQuiet()) {
        console.error(
          `enrivision: invalid ENRIVISION_MODEL (128 characters max); ignoring it and using auto-dispatch.`
        );
      }
      const requestedModel: string | undefined =
        typeof params.model === "string" && params.model.trim()
          ? params.model.trim()
          : envModelValid
            ? envModelRaw
            : undefined;
      // Scale the unary analyze timeout by mode (mirrors EnriCode single 10 min
      // / multipass+auto 20 min, matching the server wall-clock budgets): a
      // single image must not retain a 30 min umbrella, while `auto` shares
      // the multipass budget because the server may escalate to multipass and
      // the client cannot know upfront. Explicit operator timeouts cap via
      // Math.min.
      const analyzeTimeoutMs: number =
        params.analysisMode === "single"
          ? Math.min(timeoutMs, ANALYZE_MEDIA_LIMITS.singleAnalyzeTimeoutMs)
          : Math.min(timeoutMs, ANALYZE_MEDIA_LIMITS.multipassAnalyzeTimeoutMs);
      const analysis = await client.analyze({
        ...(uploadId !== null ? { uploadId } : { sourceUrl: remoteUrl as string }),
        ...(requestedModel ? { model: requestedModel } : {}),
        timeoutMs: analyzeTimeoutMs,
        context: params.context,
        question: params.question,
        language,
        maxFrames: params.maxFrames,
        transcribe: params.transcribe,
        transcriptionLanguage: params.transcriptionLanguage,
        analysisMode: params.analysisMode,
        region: params.region,
        video: params.video,
        document: params.document,
        audio: params.audio,
        images: params.images,
        signal,
      });

      const extraction: Record<string, unknown> = this.stripInternalExtractionFields(
        analysis.extraction,
      );

      const result: AnalyzeMediaToolResult = {
        analysis: analysis.analysis,
        ...(Array.isArray(analysis.elements) && analysis.elements.length > 0
          ? {
              elements: Object.freeze(
                analysis.elements.map((element) =>
                  Object.freeze({ ...element, box: Object.freeze({ ...element.box }) }),
                ),
              ),
            }
          : {}),
        media_type: analysis.media_type,
        ...((params.warnings && params.warnings.length > 0) || transcribeWarning || remoteAdvisoryWarnings.length > 0 || (analysis.warnings && analysis.warnings.length > 0)
          ? {
              warnings: [
                ...(params.warnings ?? []),
                ...(transcribeWarning ? [transcribeWarning] : []),
                ...remoteAdvisoryWarnings,
                ...(analysis.warnings ?? []),
              ],
            }
          : {}),
        extraction,
      };
      // Release server bytes on success too: upload sessions live ~3 h and
      // count against the per-key quota, so a successful analysis must not
      // leak its session (mirrors EnriCode bestEffortDeleteUploadSession).
      await this.deleteUploadedBytesBestEffort(client, uploadId);
      return result;
    } catch (error: unknown) {
      await this.deleteUploadedBytesBestEffort(client, uploadId);
      throw error;
    } finally {
      for (const fetched of resolved.materialized) {
        try {
          await fetched.cleanup();
        } catch (cleanupError: unknown) {
          if (!isProgressQuiet()) {
            console.error(
              `enrivision: temp cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
            );
          }
        }
      }
    }
  }

  /**
   * Rejects a `region` zoom against non-image inputs before any upload.
   *
   * @remarks
   * `region` zooms one image at native resolution: sending it with video,
   * audio, PDF, or a tar set wastes an upload plus a server rejection (or
   * a silent ignore). Fail locally in Spanish using the resolved effective
   * content type (server-reported type wins, mirroring the resolver).
   *
   * @param region - Validated region, or undefined when absent.
   * @param inputs - Resolved upload-ready inputs.
   * @throws Error with an Spanish-first bilingual message when `region` targets non-image media.
   */
  private rejectRegionForNonImage(
    region: ImageRegion | undefined,
    inputs: readonly { readonly localPath: string; readonly contentType: string }[],
  ): void {
    if (!region || inputs.length !== 1) {
      return;
    }
    const single = inputs[0]!;
    if (!single.contentType.toLowerCase().startsWith("image/")) {
      throw new Error(
        `region sólo aplica a imágenes; el archivo es ${single.contentType} (${single.localPath}). Omita 'region' para video, audio o documentos. / region only applies to images; the file is ${single.contentType} (${single.localPath}). Omit 'region' for video, audio, or documents.`
      );
    }
  }

  /**
   * Rejects tuning knobs that the resolved content type would silently ignore.
   *
   * @remarks
   * Pre-upload gate mirroring EnriCode `VisionAnalyzeMediaRequestRecords`:
   * `video.*` tuning only applies to video, `images.*` only to images
   * and documents (PDF page-image sets on the remote route), `document.*`
   * only to PDF/Office/TXT/CSV, clip/`maxFramesPerSegment` never to audio,
   * `video.segment_seconds`/`max_segments` never to audio without an audio
   * section, and `audio.segment_seconds`/`max_segments` never to video
   * without a video section (shared flats fan out to both sections by
   * design and are exempt). Multi-image sets only accept `images.*`. The top-level
   * `maxFrames` knob is media-agnostic by design (EnriCode declares
   * `max_frames` "sin efecto en imágenes fijas o audio"): it never
   * triggers a mismatch gate and is forwarded for the server to apply or
   * ignore. Unknown content types (`application/octet-stream` included)
   * skip every gate by design so the server (not this gate) decides
   * applicability, mirroring EnriCode `VisionAnalyzeMediaRequestRecords`.
   * Failing here saves the
   * full upload plus a late server rejection.
   *
   * @param params - Validated tool parameters.
   * @param inputs - Resolved upload-ready inputs.
   * @throws Error with an Spanish-first bilingual message when tuning mismatches the content type.
   */
  private rejectMismatchedTuning(
    params: AnalyzeMediaToolParams,
    inputs: readonly { readonly localPath: string; readonly contentType: string }[],
  ): void {
    // Top-level `maxFrames` is media-agnostic (EnriCode `max_frames` is
    // "sin efecto en imágenes fijas o audio"): only the `video` section
    // participates in the video-only gate.
    const hasVideoTuning: boolean = typeof params.video !== "undefined";
    const hasDocumentTuning: boolean = typeof params.document !== "undefined";
    const hasImagesTuning: boolean = typeof params.images !== "undefined";
    const hasAudioTuning: boolean = typeof params.audio !== "undefined";
    if (!hasVideoTuning && !hasDocumentTuning && !hasImagesTuning && !hasAudioTuning) {
      return;
    }
    if (inputs.length > 1) {
      if (hasVideoTuning || hasDocumentTuning || hasAudioTuning) {
        throw new Error(
          "El afinado video/document/audio solo aplica a archivos individuales y se habría ignorado en el conjunto de imágenes: quite esos parámetros o use images.* para conjuntos. / video/document/audio tuning only applies to single files and would have been ignored on the image set: drop those params or use images.* for sets."
        );
      }
      return;
    }
    const single = inputs[0];
    if (!single) {
      return;
    }
    const normalized: string = single.contentType.trim().toLowerCase();
    const isImage: boolean = normalized.startsWith("image/");
    const isVideo: boolean = normalized.startsWith("video/");
    const isAudio: boolean = normalized.startsWith("audio/");
    const isDocument: boolean = isDocumentContentType(normalized);
    // Unknown content types (empty, `application/octet-stream`, or any
    // non-media guess) skip every mismatch gate by design: the server (not
    // this gate) decides applicability. Mirrors EnriCode
    // `VisionAnalyzeMediaRequestRecords` ("Unknown content types ...
    // forward guarded knobs untouched ... so the server decides").
    if (normalized === "" || (!isImage && !isVideo && !isAudio && !isDocument)) {
      return;
    }
    if (hasDocumentTuning && !isDocument) {
      throw new Error(
        `El afinado 'document.*' solo aplica a PDF y documentos de Office/TXT/CSV y se habría ignorado en silencio: quite esos parámetros o use un documento (el archivo es ${single.contentType}). / 'document.*' tuning only applies to PDF and Office/TXT/CSV documents and would have been silently ignored: drop those params or use a document (the file is ${single.contentType}).`
      );
    }
    if (hasImagesTuning && (isVideo || isAudio)) {
      throw new Error(
        `El afinado 'images.*' solo aplica a imágenes y documentos y se habría ignorado en silencio: quite esos parámetros o use un archivo de imagen o documento (el archivo es ${single.contentType}). / 'images.*' tuning only applies to images and documents and would have been silently ignored: drop those params or use an image or document file (the file is ${single.contentType}).`
      );
    }
    if (hasVideoTuning && (isImage || isDocument)) {
      throw new Error(
        `El afinado de video (clip, segmentSeconds, maxSegments, maxFramesPerSegment) solo aplica a video y se habría ignorado en silencio: quite esos parámetros o use un archivo de video (el archivo es ${single.contentType}). / Video tuning (clip, segmentSeconds, maxSegments, maxFramesPerSegment) only applies to video and would have been silently ignored: drop those params or use a video file (the file is ${single.contentType}).`
      );
    }
    // Wrong-section scalar knobs are only rejected when the matching section
    // is absent: shared top-level flats fan out to BOTH sections by design
    // (the server applies the media-matching one), so a video+audio pair
    // with equal segment values is the flat fan-out, never a silent drop.
    if (isAudio && typeof params.video !== "undefined") {
      const video = params.video;
      const audioSegmentActive: boolean
        = typeof params.audio?.segmentSeconds !== "undefined"
        || typeof params.audio?.maxSegments !== "undefined";
      if (
        typeof video.clipStartSeconds !== "undefined"
        || typeof video.clipDurationSeconds !== "undefined"
        || typeof video.maxFramesPerSegment !== "undefined"
      ) {
        throw new Error(
          `El afinado de video (clip o maxFramesPerSegment) no aplica a audio y se habría ignorado en silencio: quite clip/maxFramesPerSegment o use un archivo de video (el archivo es ${single.contentType}). / Video tuning (clip or maxFramesPerSegment) does not apply to audio and would have been silently ignored: drop clip/maxFramesPerSegment or use a video file (the file is ${single.contentType}).`
        );
      }
      if (
        !audioSegmentActive
        && (typeof video.segmentSeconds !== "undefined" || typeof video.maxSegments !== "undefined")
      ) {
        throw new Error(
          `El afinado video.segment_seconds/max_segments no aplica a audio y se habría ignorado en silencio: use audio.segment_seconds/max_segments o los planos segmentSeconds/maxSegments (el archivo es ${single.contentType}). / video.segment_seconds/max_segments tuning does not apply to audio and would have been silently ignored: use audio.segment_seconds/max_segments or the flat segmentSeconds/maxSegments (the file is ${single.contentType}).`
        );
      }
    }
    if (isVideo && typeof params.audio !== "undefined") {
      const audio = params.audio;
      const videoSegmentActive: boolean
        = typeof params.video?.segmentSeconds !== "undefined"
        || typeof params.video?.maxSegments !== "undefined";
      if (
        !videoSegmentActive
        && (typeof audio.segmentSeconds !== "undefined" || typeof audio.maxSegments !== "undefined")
      ) {
        throw new Error(
          `El afinado audio.segment_seconds/max_segments no aplica a video y se habría ignorado en silencio: use video.segment_seconds/max_segments o los planos segmentSeconds/maxSegments (el archivo es ${single.contentType}). / audio.segment_seconds/max_segments tuning does not apply to video and would have been silently ignored: use video.segment_seconds/max_segments or the flat segmentSeconds/maxSegments (the file is ${single.contentType}).`
        );
      }
    }
  }

  /**
   * Resolves the requested server-side model id for dispatch affinity.
   *
   * @remarks
   * Pure read of `params.model` plus the validated `ENRIVISION_MODEL` env
   * fallback (no operator logging): used by the pre-upload vision probe,
   * which runs before the main model-resolution block in `execute`.
   *
   * @param params - Validated tool parameters.
   * @returns Trimmed model id, or undefined for auto-dispatch.
   */
  private resolveRequestedModel(params: AnalyzeMediaToolParams): string | undefined {
    if (typeof params.model === "string" && params.model.trim()) {
      return params.model.trim();
    }
    const envModelRaw: string =
      typeof process.env["ENRIVISION_MODEL"] === "string"
        ? process.env["ENRIVISION_MODEL"].trim()
        : "";
    if (envModelRaw.length > 0 && envModelRaw.length <= 128) {
      return envModelRaw;
    }
    return undefined;
  }

  /**
   * Fails fast when the requested model explicitly lacks vision, before any byte.
   *
   * @remarks
   * Mirrors EnriCode `assertRemoteVisionCapable`: probes `GET
   * `/v1/account/models` (15 s budget inside the client) and matches the
   * requested model by `id`, `requestModelId`, or canonical ids. Only an
   * explicit `vision === false` rejects; unknown models, missing flags, and
   * probe failures stay fail-open so a stale discovery snapshot never blocks
   * a valid upload. Verdicts are cached per client for 5 min; 401/404 probe
   * failures invalidate the entry so revoked keys never ride a stale verdict.
   * Clients without `getAccountModels` (older stubs) skip the probe entirely.
   *
   * @param client - EnriProxy client used for the upload.
   * @param requestedModel - Trimmed model id, or undefined for auto-dispatch.
   * @param signal - Optional cancellation signal.
   * @throws Error with an Spanish-first bilingual message when the model explicitly lacks vision.
   */
  private async assertVisionCapable(
    client: EnriProxyClient,
    requestedModel: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const modelId: string = typeof requestedModel === "string" ? requestedModel.trim() : "";
    if (!modelId || signal?.aborted) {
      return;
    }
    const probe = client as Partial<Pick<EnriProxyClient, "getAccountModels">>;
    if (typeof probe.getAccountModels !== "function") {
      return;
    }
    const now: number = Date.now();
    const cacheKey: string = `${this.deps.defaultServerUrl}::${modelId}`;
    const cached = this.visionProbeCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      if (!cached.verdict) {
        throw AnalyzeMediaTool.buildVisionlessModelError(modelId);
      }
      return;
    }
    if (cached !== undefined) {
      this.visionProbeCache.delete(cacheKey);
    }
    let payload: unknown;
    try {
      payload = await (probe.getAccountModels as (signal?: AbortSignal) => Promise<unknown>).call(
        client,
        signal,
      );
    } catch (error: unknown) {
      if (
        error instanceof EnriProxyHttpError && (error.status === 401 || error.status === 404)
      ) {
        this.visionProbeCache.delete(cacheKey);
      }
      return;
    }
    const entry = findAccountModelEntry(payload, modelId);
    if (entry === null) {
      return;
    }
    if (entry.vision === false) {
      this.rememberVisionProbe(cacheKey, false, now);
      throw AnalyzeMediaTool.buildVisionlessModelError(modelId);
    }
    this.rememberVisionProbe(cacheKey, true, now);
  }

  /**
   * Maximum vision-probe cache entries (model ids are caller-controlled).
   */
  private static readonly MAX_VISION_PROBE_ENTRIES: number = 100;

  /**
   * Remembers one vision-probe verdict, purging expired entries and
   * evicting oldest-first past the cap so long-lived tool instances
   * cannot leak one entry per distinct model id.
   *
   * @param cacheKey - Server plus model cache key.
   * @param verdict - Whether the model has vision.
   * @param now - Current epoch milliseconds.
   * @returns Nothing.
   */
  private rememberVisionProbe(cacheKey: string, verdict: boolean, now: number): void {
    for (const [key, entry] of this.visionProbeCache) {
      if (entry.expiresAt <= now) {
        this.visionProbeCache.delete(key);
      }
    }
    while (this.visionProbeCache.size >= AnalyzeMediaTool.MAX_VISION_PROBE_ENTRIES) {
      const oldest: string | undefined = this.visionProbeCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.visionProbeCache.delete(oldest);
    }
    this.visionProbeCache.set(cacheKey, { verdict, expiresAt: now + ANALYZE_MEDIA_LIMITS.visionProbeCacheTtlMs });
  }

  /**
   * Builds the visionless-model rejection error.
   *
   * @param modelId - Requested model id.
   * @returns Spanish-first bilingual error (no byte was uploaded).
   */
  private static buildVisionlessModelError(modelId: string): Error {
    return new Error(
      `El modelo ${modelId} no tiene capacidad de visión (vision=false en /v1/account/models). Elige un modelo con visión o usa la ruta local; no se subió ningún byte. / Model ${modelId} has no vision capability (vision=false in /v1/account/models). Pick a vision-capable model or use the local route; no bytes were uploaded.`
    );
  }

  /**
   * Executes one truncated-list continuation read (no upload, no analysis).
   *
   * @param client - EnriProxy client.
   * @param cursor - Opaque cursor from a truncated response.
   * @param offset - Start index, or undefined for the stored next offset.
   * @param signal - Optional cancellation signal.
   * @returns Tool result carrying the page plus chaining state.
   */
  private async executeContinuation(
    client: ReturnType<AnalyzeMediaToolDeps["createClient"]>,
    cursor: string,
    offset: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AnalyzeMediaToolResult> {
    const page = await client.fetchSegmentPage({
      cursor,
      ...(typeof offset === "number" ? { offset } : {}),
      ...(typeof signal !== "undefined" ? { signal } : {}),
    });
    const lines: string[] = page.entries.map((entry: unknown): string => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return `- ${String(entry ?? "")}`;
      }
      const record = entry as Record<string, unknown>;
      const text: unknown = record["summary"] ?? record["text"];
      const start: unknown = record["start_seconds"] ?? record["start"];
      const end: unknown = record["end_seconds"] ?? record["end"];
      const span: string =
        typeof start === "number" && typeof end === "number"
          ? ` [${start.toFixed(2)}-${end.toFixed(2)}s]`
          : "";
      return `- ${String(text ?? JSON.stringify(entry) ?? "")}${span}`;
    });
    const end: number = page.nextOffset;
    const start: number = Math.max(0, end - lines.length);
    const header: string =
      `Continuación: entradas ${start}-${end} de ${page.total} / Continuation: entries ${start}-${end} of ${page.total}.`;
    const tail: string = page.hasMore
      ? `Quedan ${page.total - end} entradas: pide más con cursor "${page.cursor}" y offset ${end}. / ${page.total - end} entries remain: ask for more with cursor "${page.cursor}" and offset ${end}.`
      : `No quedan más entradas. / No more entries.`;
    return {
      analysis: `${header}\n${lines.join("\n")}\n${tail}`,
      media_type: "continuation",
      warnings: [],
      extraction: {
        continuation: true,
        total: page.total,
        has_more: page.hasMore,
        next_offset: page.nextOffset,
        cursor: page.cursor,
      },
    };
  }

  /**
   * Warns when `transcribe` is set for media it cannot affect.
   *
   * @remarks
   * Mirrors EnriCode `LocalMediaAnalysisService` (transcribe is inapplicable
   * for images and documents): instead of failing, the knob is forwarded
   * and declared as a bilingual honesty warning so the model never assumes
   * audio was transcribed. Videos and audio files never warn.
   *
   * @param params - Validated tool parameters.
   * @param inputs - Resolved upload-ready inputs.
   * @returns Bilingual warning, or undefined when `transcribe` may apply.
   */
  private transcribeInapplicableWarning(
    params: AnalyzeMediaToolParams,
    inputs: readonly { readonly localPath: string; readonly contentType: string }[],
  ): string | undefined {
    if (typeof params.transcribe === "undefined") {
      return undefined;
    }
    if (inputs.length > 1) {
      return (
        "transcribe no tiene efecto en conjuntos de varias imágenes y se ignora. / " +
        "transcribe has no effect on multi-image sets and is ignored."
      );
    }
    const single = inputs[0];
    if (!single) {
      return undefined;
    }
    const normalized: string = single.contentType.trim().toLowerCase();
    if (normalized.startsWith("image/")) {
      return (
        "transcribe no tiene efecto en imágenes y se ignora. / " +
        "transcribe has no effect on images and is ignored."
      );
    }
    if (isDocumentContentType(normalized)) {
      return (
        "transcribe no tiene efecto en documentos y se ignora. / " +
        "transcribe has no effect on documents and is ignored."
      );
    }
    return undefined;
  }

  /**
   * Runs the mismatch gates on the remote (`source_url`) branch as advisories.
   *
   * @remarks
   * The local gates no-op on the empty remote input list by design (the
   * server, which sees the served type, decides applicability). When the URL
   * extension guesses a known media type, the same gates run against the
   * guess and likely-ignored tuning is declared as bilingual warnings
   * instead of errors; URLs with no usable extension stay server-decides
   * with no warnings.
   *
   * @param params - Validated tool parameters.
   * @param remoteUrl - Remote http(s) URL the server will ingest.
   * @returns Advisory warnings (empty when nothing looks mismatched).
   */
  private advisoryRemoteTuningWarnings(
    params: AnalyzeMediaToolParams,
    remoteUrl: string,
  ): ReadonlyArray<string> {
    const guessed: string | false = mimeLookup(remoteUrl.split(/[?#]/)[0] ?? remoteUrl);
    if (typeof guessed !== "string") {
      return [];
    }
    const contentType: string = guessed.trim().toLowerCase();
    if (!MediaUrlFetcher.isAllowedMediaContentType(contentType)) {
      return [];
    }
    const advisories: string[] = [];
    const wrapAdvisory = (detail: string): string =>
      `La URL remota parece ${contentType} por extensión, así que el servidor podría ignorar este afinado (solo aviso; el servidor decide): ${detail} / ` +
      `Remote URL looks like ${contentType} by extension, so this tuning may be ignored by the server (advisory only; the server decides): ${detail}`;
    try {
      this.rejectMismatchedTuning(params, [{ localPath: remoteUrl, contentType }]);
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      advisories.push(wrapAdvisory(detail));
    }
    try {
      this.rejectRegionForNonImage(params.region, [{ localPath: remoteUrl, contentType }]);
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      advisories.push(wrapAdvisory(detail));
    }
    const transcribeWarning: string | undefined = this.transcribeInapplicableWarning(
      params,
      [{ localPath: remoteUrl, contentType }],
    );
    if (typeof transcribeWarning !== "undefined") {
      advisories.push(wrapAdvisory(transcribeWarning));
    }
    return advisories;
  }

  /**
   * Releases uploaded bytes when the analysis fails or is cancelled.
   *
   * @remarks
   * Best-effort by design: it runs on an independent 15 s signal (the
   * caller signal may already be cancelled) and never throws, so the
   * original upload/analysis error always reaches the model unchanged.
   *
   * @param client - EnriProxy client used for the upload.
   * @param uploadId - Upload id to release, or null when nothing was uploaded.
   */
  private async deleteUploadedBytesBestEffort(
    client: { deleteUploadSession?: (uploadId: string, signal?: AbortSignal) => Promise<void> },
    uploadId: string | null,
  ): Promise<void> {
    if (!uploadId || typeof client.deleteUploadSession !== "function") {
      return;
    }
    try {
      await client.deleteUploadSession(uploadId, AbortSignal.timeout(15_000));
    } catch (cleanupError: unknown) {
      // A second delete after an already-handled deadline/identity branch
      // 404s: that is the expected terminal state, not noise.
      const status: unknown = (cleanupError as { readonly status?: unknown })?.status;
      const message: string = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (status === 404 || /HTTP 404/u.test(message)) {
        return;
      }
      if (!isProgressQuiet()) {
        console.error(
          `enrivision: could not release upload ${uploadId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }

  /**
   * Removes internal identifiers from the extraction payload.
   *
   * @param extraction - Raw extraction object returned by EnriProxy.
   * @returns Sanitized extraction object.
   */
  private stripInternalExtractionFields(
    extraction: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.sanitizer.sanitize(extraction);
  }
}

/**
 * Reports whether one normalized content type is a document type.
 *
 * @remarks
 * Shared by the mismatch gate and the `transcribe` inapplicability warning
 * so both agree on what counts as a document (PDF, Office, TXT/CSV, RTF).
 *
 * @param normalizedContentType - Lowercased content type.
 * @returns True for document types.
 */
function isDocumentContentType(normalizedContentType: string): boolean {
  return (
    normalizedContentType === "application/pdf"
    || normalizedContentType.includes("wordprocessing")
    || normalizedContentType.includes("msword")
    || normalizedContentType.includes("spreadsheet")
    || normalizedContentType.includes("excel")
    || normalizedContentType.includes("presentation")
    || normalizedContentType.includes("powerpoint")
    || normalizedContentType.includes("oasis.opendocument")
    || normalizedContentType === "text/plain"
    || normalizedContentType === "text/csv"
    || normalizedContentType.includes("rtf")
  );
}

/**
 * One account-model catalog entry relevant to the vision probe.
 */
interface AccountModelVisionEntry {
  /**
   * Explicit vision flag when the catalog carries one.
   */
  readonly vision: boolean | undefined;
}

/**
 * Finds one account-model entry matching a requested model id.
 *
 * @remarks
 * Mirrors EnriCode `assertRemoteVisionCapable` matching: the entry matches
 * on `id`, `requestModelId`/`request_model_id`, or any canonical id
 * (`canonicalIds`/`canonical_ids`). Non-object payloads, missing `data`,
 * and non-array `data` yield null (fail-open: the caller proceeds).
 *
 * @param payload - Parsed `/v1/account/models` body.
 * @param modelId - Trimmed requested model id.
 * @returns Matched entry, or null when no entry matches.
 */
function findAccountModelEntry(payload: unknown, modelId: string): AccountModelVisionEntry | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const data: unknown = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) {
    return null;
  }
  for (const candidate of data) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const ids: unknown[] = [
      record["id"],
      record["requestModelId"],
      record["request_model_id"],
    ];
    const canonical: unknown = record["canonicalIds"] ?? record["canonical_ids"];
    if (Array.isArray(canonical)) {
      ids.push(...canonical);
    }
    const matches: boolean = ids.some(
      (id: unknown): boolean => typeof id === "string" && id.trim() === modelId,
    );
    if (!matches) {
      continue;
    }
    const vision: unknown = record["vision"];
    return { vision: typeof vision === "boolean" ? vision : undefined };
  }
  return null;
}
