/**
 * ANALYZE MEDIA PARAMETER PARSER
 *
 * Validates raw MCP tool arguments for `analyze_media`, including multipass
 * knob ranges, so out-of-range values fail locally in Spanish instead of
 * being silently clamped by EnriProxy.
 *
 * Anti-hallucination bar (nothing the model sends is dropped quietly):
 * - Unknown keys fail at every level with the canonical coaching
 *   "Parámetro no reconocido: <keys>. Parámetros aceptados: <real list>".
 * - Closed enums (`analysis_mode`, `delivery`) reject every present non-null
 *   value that is not exactly one of the valid selectors (non-strings
 *   included); `null` and blank strings count as absent.
 * - Two spellings of the same knob with DIFFERENT values fail (send a
 *   single spelling); equal duplicates resolve to that value.
 * - The documented flat-over-nested precedence applies with a Spanish
 *   honesty warning when both levels arrive with different values.
 *
 * Enforced knob contract (documented in the MCP tool schema, mirrors EnriProxy `VisionAnalysisHandler`):
 * - max_frames (or maxFrames): integer 1-20 (default 20)
 * - analysis_mode (or analysisMode): auto|single|multipass
 * - video.segment_seconds (or segmentSeconds, flat or nested): 5-600 seconds (default 60)
 * - video.max_segments (or maxSegments, flat or nested): integer 1-60
 * - video.max_frames_per_segment (or maxFramesPerSegment, flat or nested): integer 1-20 (default 8)
 * - video.clip_start_seconds (or clipStartSeconds): 0-86400
 * - video.clip_end_seconds (or clipEndSeconds): 0-86400, > start; duration derives as end - start
 * - video.clip_duration_seconds (or clipDurationSeconds): (0, 86400]
 * - audio.segment_seconds (or segmentSeconds, flat or nested): 5-600 seconds (default 60)
 * - audio.max_segments (or maxSegments, flat or nested): integer 1-60
 * - audio.timestamps (or audioTimestamps flat): strict boolean
 * - document.max_pages_total (or documentMaxPages flat): integer 1-200 (default 20)
 * - document.pages_per_batch: integer 1-200
 * - document.max_images_per_batch: integer 0-20 (0 = no render)
 * - document.scanned_text_threshold_chars: integer 0-5000
 * - images.max_images_total: integer 1-500
 * - images.images_per_batch: integer 1-20
 * - images.max_dimension: integer 256-4096
 * - paths[]: at most 100 entries
 *
 * @module tools/AnalyzeMediaParamParser
 */

import { isAbsolute } from "node:path";

import { MediaUrlFetcher } from "../shared/mediaUrlFetcher.js";
import {
  assertObject,
  assertOptionalBoolean,
  assertOptionalEnum,
  assertOptionalString,
  buildClipWindowClampedWarning,
  optionalFraction,
  optionalInt,
  optionalNumber,
} from "../shared/validation.js";
import type {
  AnalyzeMediaToolParams,
  ImageRegion,
} from "./AnalyzeMediaContract.js";
import { ANALYZE_MEDIA_LIMITS } from "./AnalyzeMediaContract.js";
import {
  AUDIO_KNOWN_KEYS,
  DOCUMENT_KNOWN_KEYS,
  IMAGES_KNOWN_KEYS,
  MAX_SOURCE_URL_CHARS,
  REGION_KNOWN_KEYS,
  TOP_LEVEL_KNOWN_KEYS,
  VIDEO_KNOWN_KEYS,
} from "./AnalyzeMediaKnownKeys.js";
import type { AliasCandidate } from "./AnalyzeMediaAliasResolution.js";
import {
  aliasValuesEqual,
  firstDefined,
  hasAnyValue,
  resolveAliasedCandidate,
  resolveFlatOverNestedCandidate,
} from "./AnalyzeMediaAliasResolution.js";

export {
  AUDIO_KNOWN_KEYS,
  DOCUMENT_KNOWN_KEYS,
  IMAGES_KNOWN_KEYS,
  REGION_KNOWN_KEYS,
  TOP_LEVEL_KNOWN_KEYS,
  VIDEO_KNOWN_KEYS,
};

/**
 * Validates raw `analyze_media` tool arguments.
 */
export class AnalyzeMediaParamParser {
  /**
   * Honesty notes collected while parsing (reset on every `parseParams` call).
   */
  private parseWarnings: string[] = [];

  /**
   * Validates raw MCP tool arguments.
   *
   * @remarks
   * Accepts `snake_case` and `camelCase` spellings (`max_frames` or
   * `maxFrames`) plus EnriCode-style flat knobs (`segmentSeconds`,
   * `maxSegments`, `maxFramesPerSegment`, `audioTimestamps`,
   * `documentMaxPages`, `clipStartSeconds`, `clipEndSeconds`,
   * `clipDurationSeconds`). Flat knobs win over their nested
   * `video`/`audio`/`document` counterparts, mirroring EnriCode.
   *
   * @param raw - Raw tool arguments.
   * @returns Validated parameters.
   * @throws Error with an Spanish-first bilingual message when arguments are missing or out of range.
   */
  public parseParams(raw: unknown): AnalyzeMediaToolParams {
    this.parseWarnings = [];
    const obj = assertObject(raw, "arguments");
    const record = obj as Record<string, unknown>;

    // EnriCode-only attachment selectors have no meaning here: fail with a
    // redirect instead of ignoring them silently (parity trap for models
    // alternating between surfaces).
    if (
      typeof record["attachmentIndex"] !== "undefined" ||
      typeof record["attachmentId"] !== "undefined"
    ) {
      throw new Error(
        "attachmentIndex/attachmentId sólo existen en EnriCode vision.analyze_media; aquí use 'path' o 'paths'. / attachmentIndex/attachmentId only exist in EnriCode vision.analyze_media; use 'path' or 'paths' here."
      );
    }

    this.throwOnUnknownKeys(record, TOP_LEVEL_KNOWN_KEYS, "argumentos", "top-level");

    const path: string | undefined = this.parsePath(record["path"]);
    const paths: string[] | undefined = this.parsePaths(record["paths"]);
    const cursor: string | undefined = this.parseCursor(record["cursor"]);
    const offset: number | undefined = this.parseOffset(record["offset"]);
    const continuationLimit: number | undefined = this.parseContinuationLimit(record["limit"]);

    // Continuation mode: a cursor reads the next window of a previously
    // truncated list without uploading or analyzing anything. Mixing it
    // with file selectors fails fast so models never pay an upload they
    // did not intend (or silently drop the files they meant to analyze).
    if (cursor !== undefined) {
      if (path !== undefined || (paths !== undefined && paths.length > 0)) {
        throw new Error("cursor no se combina con 'path'/'paths': para continuar una lista truncada mande solo cursor (y offset/limit opcionales). / cursor cannot be combined with 'path'/'paths': to continue a truncated list send only cursor (plus optional offset/limit).");
      }
    } else if (!path && (!paths || paths.length === 0)) {
      throw new Error("Proporcione 'path' o 'paths'. / Provide 'path' or 'paths'.");
    }
    const context = AnalyzeMediaParamParser.requireBoundedPromptText(
      assertOptionalString(record["context"], "context"),
      "context",
    );
    const question = AnalyzeMediaParamParser.requireBoundedPromptText(
      assertOptionalString(record["question"], "question"),
      "question",
    );
    const language = this.parseLanguageHint(
      assertOptionalString(record["language"], "language"),
      "language",
    );
    const maxFrames = this.parseBoundedInt(
      this.resolveTopLevelKnob("max_frames", [
        { key: "max_frames", value: record["max_frames"] },
        { key: "maxFrames", value: record["maxFrames"] },
      ]),
      "max_frames",
      1,
      20,
    );
    const transcribe = assertOptionalBoolean(record["transcribe"], "transcribe");
    const transcriptionLanguage = this.parseLanguageHint(
      assertOptionalString(
        this.resolveTopLevelKnob("transcription_language", [
          { key: "transcription_language", value: record["transcription_language"] },
          { key: "transcriptionLanguage", value: record["transcriptionLanguage"] },
        ]),
        "transcription_language",
      ),
      "transcription_language",
    );

    const analysisMode = this.parseAnalysisMode(
      this.resolveTopLevelKnob("analysis_mode", [
        { key: "analysis_mode", value: record["analysis_mode"] },
        { key: "analysisMode", value: record["analysisMode"] },
      ]),
    );
    const delivery = this.parseDelivery(record["delivery"]);
    const model = this.parseModelHint(record["model"]);

    const region = this.parseRegion(record["region"]);
    // `region` zooms a single image: reject it with multi-entry `paths`
    // locally instead of paying server cost or silently ignoring it. A
    // single-entry `paths` is equivalent to `path` (models that normalize
    // everything to `paths` keep working); longer sets still fail.
    if (region && paths && paths.length > 1) {
      throw new Error("region sólo aplica a una imagen individual (path o paths con un solo elemento), no a conjuntos de varias imágenes. / region only applies to a single image (path or single-entry paths), not to multi-image sets.");
    }

    const hasVideoSection: boolean = typeof record["video"] !== "undefined";
    const hasAudioSection: boolean = typeof record["audio"] !== "undefined";
    // Shared flats feed the explicit section when exactly one exists (the
    // other section must not shadow them); with zero explicit sections they
    // fan out to both and the server applies the media-matching one; with
    // both explicit they fail below as ambiguous.
    const video = this.parseVideo(record["video"], record, !hasAudioSection || hasVideoSection);
    const document = this.parseDocument(record["document"], record);
    const audio = this.parseAudio(record["audio"], record, !hasVideoSection || hasAudioSection);
    this.rejectConflictingNestedSegmentKnobs(record);

    return {
      path,
      paths,
      cursor,
      offset,
      continuationLimit,
      context,
      question,
      language,
      maxFrames,
      transcribe,
      transcriptionLanguage,
      analysisMode,
      delivery,
      model,
      region,
      video,
      document,
      audio,
      images: this.parseImages(record["images"]),
      ...(this.parseWarnings.length > 0 ? { warnings: Object.freeze([...this.parseWarnings]) } : {}),
    };
  }

  /**
   * Rejects differing nested video/audio segment knobs without a flat winner.
   *
   * @remarks
   * Flat-over-nested precedence mirrors EnriCode: a flat `segmentSeconds` or
   * `maxSegments` wins over both nested sections (fan-out to both is
   * intentional; the server applies the media-matching one). Without a flat,
   * differing nested `video` vs `audio` values for the same knob fail in
   * Spanish and point at the flat winner, mirroring
   * `VisionAnalyzeMediaToolInputParser` video-beats-audio conflict guards.
   *
   * @param flat - Top-level arguments carrying flat knob aliases.
   * @throws Error with an Spanish-first bilingual message when nested video/audio values differ without a flat.
   */
  private rejectConflictingNestedSegmentKnobs(flat: Record<string, unknown>): void {
    const flatSegmentSeconds = firstDefined(flat["segmentSeconds"], flat["segment_seconds"]);
    const flatMaxSegments = firstDefined(flat["maxSegments"], flat["max_segments"]);
    const videoRaw: unknown = flat["video"];
    const audioRaw: unknown = flat["audio"];
    const videoRecord: Record<string, unknown> =
      videoRaw !== undefined && typeof videoRaw === "object" && videoRaw !== null && !Array.isArray(videoRaw)
        ? (videoRaw as Record<string, unknown>)
        : {};
    const audioRecord: Record<string, unknown> =
      audioRaw !== undefined && typeof audioRaw === "object" && audioRaw !== null && !Array.isArray(audioRaw)
        ? (audioRaw as Record<string, unknown>)
        : {};
    const nestedVideoSegment = firstDefined(
      videoRecord["segment_seconds"],
      videoRecord["segmentSeconds"],
    );
    const nestedAudioSegment = firstDefined(
      audioRecord["segment_seconds"],
      audioRecord["segmentSeconds"],
    );
    if (
      typeof flatSegmentSeconds === "undefined"
      && typeof nestedVideoSegment !== "undefined"
      && typeof nestedAudioSegment !== "undefined"
      && !aliasValuesEqual(nestedVideoSegment, nestedAudioSegment)
    ) {
      throw new Error(
        "video.segment_seconds y audio.segment_seconds difieren sin un plano segmentSeconds que gane; use el plano segmentSeconds o solo uno de los dos objetos. / video.segment_seconds and audio.segment_seconds differ without a flat segmentSeconds winner; use the flat segmentSeconds or only one of the two objects."
      );
    }
    const nestedVideoMax = firstDefined(videoRecord["max_segments"], videoRecord["maxSegments"]);
    const nestedAudioMax = firstDefined(audioRecord["max_segments"], audioRecord["maxSegments"]);
    if (
      typeof flatMaxSegments === "undefined"
      && typeof nestedVideoMax !== "undefined"
      && typeof nestedAudioMax !== "undefined"
      && !aliasValuesEqual(nestedVideoMax, nestedAudioMax)
    ) {
      throw new Error(
        "video.max_segments y audio.max_segments difieren sin un plano maxSegments que gane; use el plano maxSegments o solo uno de los dos objetos. / video.max_segments and audio.max_segments differ without a flat maxSegments winner; use the flat maxSegments or only one of the two objects."
      );
    }
  }

  /**
   * Parses the `analysis_mode` selector accepting both spellings.
   *
   * @remarks
   * Strict enum: a present non-null value that is not exactly one of the
   * valid selectors (non-strings included) fails with coaching instead of
   * being silently dropped to the default; `null` and blank strings count
   * as absent.
   *
   * @param raw - Raw selector value.
   * @returns Validated selector or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when the value is not auto|single|multipass.
   */
  private parseAnalysisMode(raw: unknown): AnalyzeMediaToolParams["analysisMode"] {
    return assertOptionalEnum(raw, "analysis_mode", ["auto", "single", "multipass"]);
  }

  /**
   * Parses the optional `delivery` lane selector.
   *
   * @remarks
   * Strict enum: a present non-null value that is not exactly one of the
   * valid selectors (non-strings included) fails with coaching instead of
   * being silently dropped to the default; `null` and blank strings count
   * as absent.
   *
   * @param raw - Raw selector value.
   * @returns Validated selector or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when the value is not auto|analysis.
   */
  private parseDelivery(raw: unknown): AnalyzeMediaToolParams["delivery"] {
    return assertOptionalEnum(raw, "delivery", ["auto", "analysis"]);
  }

  /**
   * Parses the single `path` argument.
   *
   * @param raw - Raw `path` argument.
   * @returns Trimmed path, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when the path is neither absolute nor http(s).
   */
  private parsePath(raw: unknown): string | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (typeof raw !== "string") {
      throw new Error("path debe ser una ruta de archivo absoluta o una URL http(s). / path must be an absolute file path or an http(s) URL.");
    }
    const path: string | undefined = raw.trim() ? raw.trim() : undefined;
    if (path && !isAbsolute(path) && !MediaUrlFetcher.isHttpUrl(path)) {
      throw new Error("path debe ser una ruta de archivo absoluta o una URL http(s). / path must be an absolute file path or an http(s) URL.");
    }
    if (path && MediaUrlFetcher.isHttpUrl(path) && Array.from(path).length > MAX_SOURCE_URL_CHARS) {
      throw new Error(
        `La URL de path excede el límite de ingesta del servidor de ${String(MAX_SOURCE_URL_CHARS)} caracteres (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use una URL más corta. / path URL exceeds the ${String(MAX_SOURCE_URL_CHARS)}-char server ingest limit (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use a shorter URL.`
      );
    }
    return path;
  }

  /**
   * Parses the continuation cursor for truncated-list reads.
   *
   * @param raw - Raw `cursor` argument.
   * @returns Validated cursor, or undefined when absent.
   * @throws Error with a Spanish-first bilingual message when present but malformed.
   */
  private parseCursor(raw: unknown): string | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
      throw new Error("cursor debe ser el cursor opaco devuelto en una respuesta truncada (segment_summaries_cursor o transcription_segments_cursor). / cursor must be the opaque cursor from a truncated response (segment_summaries_cursor or transcription_segments_cursor).");
    }
    return raw;
  }

  /**
   * Parses the continuation start index.
   *
   * @param raw - Raw `offset` argument.
   * @returns Validated offset, or undefined when absent.
   * @throws Error with a Spanish-first bilingual message when present but not an integer >= 0.
   */
  private parseOffset(raw: unknown): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new Error("offset debe ser un entero mayor o igual que 0 (por defecto, el next_offset de la respuesta). / offset must be an integer greater than or equal to 0 (defaults to the response next_offset).");
    }
    return raw;
  }

  /**
   * Parses the continuation window length.
   *
   * @param raw - Raw `limit` argument.
   * @returns Validated limit, or undefined when absent.
   * @throws Error with a Spanish-first bilingual message when present but not an integer in [1, 100].
   */
  private parseContinuationLimit(raw: unknown): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 100) {
      throw new Error("limit debe ser un entero entre 1 y 100 (por defecto, el tamaño de ventana del servidor). / limit must be an integer between 1 and 100 (defaults to the server window size).");
    }
    return raw;
  }

  /**
   * Parses the multi-image `paths` argument.
   *
   * @remarks
   * Blank entries are discarded (documented in the tool schema); when at
   * least one valid entry remains, `paths` wins over `path` at execution.
   *
   * @param raw - Raw `paths` argument.
   * @returns Validated paths, or undefined when absent/empty.
   * @throws Error with an Spanish-first bilingual message when `paths` is not an array of absolute paths or http(s) URLs.
   */
  private parsePaths(raw: unknown): string[] | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new Error("paths debe ser un arreglo de rutas de archivo absolutas o URLs http(s). / paths must be an array of absolute file paths or http(s) URLs.");
    }
    const out: string[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const item: unknown = raw[index];
      if (typeof item === "string" && !item.trim()) {
        continue;
      }
      if (typeof item !== "string") {
        throw new Error(`paths[${String(index)}] debe ser una ruta de archivo absoluta o una URL http(s). / paths[${String(index)}] must be an absolute file path or an http(s) URL.`);
      }
      const candidate: string = item.trim();
      if (!isAbsolute(candidate) && !MediaUrlFetcher.isHttpUrl(candidate)) {
        throw new Error("paths debe contener sólo rutas de archivo absolutas o URLs http(s). / paths must contain only absolute file paths or http(s) URLs.");
      }
      if (MediaUrlFetcher.isHttpUrl(candidate) && Array.from(candidate).length > MAX_SOURCE_URL_CHARS) {
        throw new Error(
          `La URL de paths[${String(index)}] excede el límite de ingesta del servidor de ${String(MAX_SOURCE_URL_CHARS)} caracteres (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use una URL más corta. / paths[${String(index)}] URL exceeds the ${String(MAX_SOURCE_URL_CHARS)}-char server ingest limit (EnriProxy VISION_MAX_SOURCE_URL_CHARS); use a shorter URL.`
        );
      }
      out.push(candidate);
    }
    if (out.length > ANALYZE_MEDIA_LIMITS.maxPathsCount) {
      throw new Error(
        `paths acepta como máximo ${String(ANALYZE_MEDIA_LIMITS.maxPathsCount)} archivos por llamada; divida el conjunto en varias llamadas. / paths accepts at most ${String(ANALYZE_MEDIA_LIMITS.maxPathsCount)} files per call; split the set into several calls.`
      );
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Parses the optional `video` tuning object with range validation.
   *
   * @remarks
   * Accepts `snake_case` and `camelCase` spellings inside `video`, plus
   * flat knobs (`clipStartSeconds`, `clipEndSeconds`, `clipDurationSeconds`,
   * `segmentSeconds`, `maxSegments`, `maxFramesPerSegment`) with
   * flat-over-nested precedence. When `clip_end_seconds` is present the
   * duration derives as `fin = inicio + duración` (`duration = end - start`)
   * and `end <= start` fails (a zero window would be dropped downstream,
   * silently widening the analysis); otherwise an explicit `clip_duration_seconds`
   * is used. Every clip bound lives in `0-86400` segundos (24 h). When any
   * clip knob is present but `clip_start_seconds` is absent, the start is
   * synthesized as `0` so the server never defaults the offset (mirrors
   * EnriCode `VisionAnalyzeMediaRequestRecords`), and
   * `start + duration > 86400` clamps the duration to the 24 h range with
   * a Spanish warning in `warnings` (mirrors the proxy timeline trim);
   * only a start already at the limit fails. A lone `clip_start_seconds`
   * at the 86400 cap with no duration forwards untouched (server decides),
   * mirroring EnriCode `VisionAnalyzeMediaClipWindowReader`, which likewise
   * returns a start-only window with no warning in that case.
   *
   * @param raw - Raw `video` argument.
   * @param flat - Top-level arguments carrying flat knob aliases.
   * @param applySharedFlats - Whether shared `segmentSeconds`/`maxSegments` flats feed this section.
   * @returns Validated video tuning, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when any knob is present but invalid or out of range.
   */
  private parseVideo(raw: unknown, flat: Record<string, unknown>, applySharedFlats: boolean): AnalyzeMediaToolParams["video"] | undefined {
    const nested: Record<string, unknown> =
      typeof raw === "undefined" ? {} : (assertObject(raw, "video") as Record<string, unknown>);
    this.throwOnUnknownKeys(nested, VIDEO_KNOWN_KEYS, "video", "nested");
    const clipStartSeconds = this.parseClipBound(
      this.resolveFlatOverNestedKnob(
        "video.clip_start_seconds",
        [
          { key: "clipStartSeconds", value: flat["clipStartSeconds"] },
          { key: "clip_start_seconds", value: flat["clip_start_seconds"] },
        ],
        [
          { key: "clip_start_seconds", value: nested["clip_start_seconds"] },
          { key: "clipStartSeconds", value: nested["clipStartSeconds"] },
        ],
      ),
      "video.clip_start_seconds",
      0,
      ANALYZE_MEDIA_LIMITS.maxClipSeconds,
    );
    const clipEndSeconds = this.parseClipBound(
      this.resolveFlatOverNestedKnob(
        "video.clip_end_seconds",
        [
          { key: "clipEndSeconds", value: flat["clipEndSeconds"] },
          { key: "clip_end_seconds", value: flat["clip_end_seconds"] },
        ],
        [
          { key: "clip_end_seconds", value: nested["clip_end_seconds"] },
          { key: "clipEndSeconds", value: nested["clipEndSeconds"] },
        ],
      ),
      "video.clip_end_seconds",
      0,
      ANALYZE_MEDIA_LIMITS.maxClipSeconds,
    );
    let clipDurationSeconds = this.parseClipDuration(
      this.resolveFlatOverNestedKnob(
        "video.clip_duration_seconds",
        [
          { key: "clipDurationSeconds", value: flat["clipDurationSeconds"] },
          { key: "clip_duration_seconds", value: flat["clip_duration_seconds"] },
        ],
        [
          { key: "clip_duration_seconds", value: nested["clip_duration_seconds"] },
          { key: "clipDurationSeconds", value: nested["clipDurationSeconds"] },
        ],
      ),
    );
    if (clipEndSeconds !== undefined) {
      const start: number = clipStartSeconds ?? 0;
      if (clipEndSeconds <= start) {
        throw new Error(
          "video.clip_end_seconds debe ser mayor que video.clip_start_seconds (fin = inicio + duración). / video.clip_end_seconds must be greater than video.clip_start_seconds (end = start + duration)."
        );
      }
      clipDurationSeconds = clipEndSeconds - start;
    }
    // A clip window anchored only by end or duration still starts at 0:
    // synthesize it so the server never defaults the offset. Mirrors
    // EnriCode VisionAnalyzeMediaRequestRecords (clip_start_seconds travels
    // even when 0 while a window exists).
    const hasClipWindow: boolean =
      clipStartSeconds !== undefined
      || clipEndSeconds !== undefined
      || clipDurationSeconds !== undefined;
    const effectiveClipStartSeconds: number | undefined = hasClipWindow
      ? (clipStartSeconds ?? 0)
      : undefined;
    // Parity clamp (mirrors EnriCode `VisionAnalyzeMediaClipWindowReader` and
    // the proxy timeline trim): an overflowing window is clamped to the 24 h
    // range with a Spanish honesty warning instead of failing, so
    // `start=86300,duration=200` analyzes 100 s loudly on every surface.
    if (
      effectiveClipStartSeconds !== undefined
      && clipDurationSeconds !== undefined
      && effectiveClipStartSeconds + clipDurationSeconds > ANALYZE_MEDIA_LIMITS.maxClipSeconds
    ) {
      if (effectiveClipStartSeconds >= ANALYZE_MEDIA_LIMITS.maxClipSeconds) {
        throw new Error(
          `video.clip_start_seconds (${String(effectiveClipStartSeconds)}) ya llegó al límite de ${String(ANALYZE_MEDIA_LIMITS.maxClipSeconds)} segundos (24 h): baje el inicio para dejar una ventana analizable. / video.clip_start_seconds (${String(effectiveClipStartSeconds)}) already reached the ${String(ANALYZE_MEDIA_LIMITS.maxClipSeconds)} s limit (24 h): lower the start to leave an analyzable window.`
        );
      }
      const requestedDuration: number = clipDurationSeconds;
      clipDurationSeconds = ANALYZE_MEDIA_LIMITS.maxClipSeconds - effectiveClipStartSeconds;
      this.parseWarnings.push(
        buildClipWindowClampedWarning(
          effectiveClipStartSeconds,
          requestedDuration,
          clipDurationSeconds,
          ANALYZE_MEDIA_LIMITS.maxClipSeconds,
        )
      );
    }
    const parsed = {
      clipStartSeconds: effectiveClipStartSeconds,
      clipDurationSeconds,
      segmentSeconds: this.parseBoundedNumber(
        applySharedFlats
          ? this.resolveFlatOverNestedKnob(
              "video.segment_seconds",
              [
                { key: "segmentSeconds", value: flat["segmentSeconds"] },
                { key: "segment_seconds", value: flat["segment_seconds"] },
              ],
              [
                { key: "segment_seconds", value: nested["segment_seconds"] },
                { key: "segmentSeconds", value: nested["segmentSeconds"] },
              ],
            )
          : this.resolveNestedKnob("video.segment_seconds", [
              { key: "segment_seconds", value: nested["segment_seconds"] },
              { key: "segmentSeconds", value: nested["segmentSeconds"] },
            ]),
        "video.segment_seconds",
        5,
        600,
      ),
      maxSegments: this.parseBoundedInt(
        applySharedFlats
          ? this.resolveFlatOverNestedKnob(
              "video.max_segments",
              [
                { key: "maxSegments", value: flat["maxSegments"] },
                { key: "max_segments", value: flat["max_segments"] },
              ],
              [
                { key: "max_segments", value: nested["max_segments"] },
                { key: "maxSegments", value: nested["maxSegments"] },
              ],
            )
          : this.resolveNestedKnob("video.max_segments", [
              { key: "max_segments", value: nested["max_segments"] },
              { key: "maxSegments", value: nested["maxSegments"] },
            ]),
        "video.max_segments",
        1,
        60,
      ),
      maxFramesPerSegment: this.parseBoundedInt(
        this.resolveFlatOverNestedKnob(
          "video.max_frames_per_segment",
          [
            { key: "maxFramesPerSegment", value: flat["maxFramesPerSegment"] },
            { key: "max_frames_per_segment", value: flat["max_frames_per_segment"] },
          ],
          [
            { key: "max_frames_per_segment", value: nested["max_frames_per_segment"] },
            { key: "maxFramesPerSegment", value: nested["maxFramesPerSegment"] },
          ],
        ),
        "video.max_frames_per_segment",
        1,
        20,
      ),
    };
    return hasAnyValue(parsed) ? parsed : undefined;
  }

  /**
   * Parses the optional `document` tuning object with range validation.
   *
   * @remarks
   * Accepts `snake_case` and `camelCase` spellings, plus the flat
   * `documentMaxPages` knob with flat-over-nested precedence.
   *
   * @param raw - Raw `document` argument.
   * @param flat - Top-level arguments carrying flat knob aliases.
   * @returns Validated document tuning, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when any knob is present but invalid or out of range.
   */
  private parseDocument(raw: unknown, flat: Record<string, unknown>): AnalyzeMediaToolParams["document"] | undefined {
    const nested: Record<string, unknown> =
      typeof raw === "undefined" ? {} : (assertObject(raw, "document") as Record<string, unknown>);
    this.throwOnUnknownKeys(nested, DOCUMENT_KNOWN_KEYS, "document", "nested");
    const parsed = {
      maxPagesTotal: this.parseBoundedInt(
        this.resolveFlatOverNestedKnob(
          "document.max_pages_total",
          [
            { key: "documentMaxPages", value: flat["documentMaxPages"] },
            { key: "document_max_pages", value: flat["document_max_pages"] },
          ],
          [
            { key: "max_pages_total", value: nested["max_pages_total"] },
            { key: "maxPagesTotal", value: nested["maxPagesTotal"] },
            { key: "max_pages", value: nested["max_pages"] },
            { key: "maxPages", value: nested["maxPages"] },
            { key: "documentMaxPages", value: nested["documentMaxPages"] },
            { key: "document_max_pages", value: nested["document_max_pages"] },
          ],
        ),
        "document.max_pages_total",
        1,
        200,
      ),
      startPage: this.parseBoundedInt(
        this.resolveFlatOverNestedKnob(
          "document.start_page",
          [
            { key: "documentStartPage", value: flat["documentStartPage"] },
            { key: "document_start_page", value: flat["document_start_page"] },
          ],
          [
            { key: "start_page", value: nested["start_page"] },
            { key: "startPage", value: nested["startPage"] },
            { key: "documentStartPage", value: nested["documentStartPage"] },
          ],
        ),
        "document.start_page",
        1,
        100_000,
      ),
      pagesPerBatch: this.parseBoundedInt(
        this.resolveNestedKnob("document.pages_per_batch", [
          { key: "pages_per_batch", value: nested["pages_per_batch"] },
          { key: "pagesPerBatch", value: nested["pagesPerBatch"] },
        ]),
        "document.pages_per_batch",
        1,
        200,
      ),
      maxImagesPerBatch: this.parseBoundedInt(
        this.resolveNestedKnob("document.max_images_per_batch", [
          { key: "max_images_per_batch", value: nested["max_images_per_batch"] },
          { key: "maxImagesPerBatch", value: nested["maxImagesPerBatch"] },
        ]),
        "document.max_images_per_batch",
        0,
        20,
      ),
      scannedTextThresholdChars: this.parseBoundedInt(
        this.resolveNestedKnob("document.scanned_text_threshold_chars", [
          { key: "scanned_text_threshold_chars", value: nested["scanned_text_threshold_chars"] },
          { key: "scannedTextThresholdChars", value: nested["scannedTextThresholdChars"] },
        ]),
        "document.scanned_text_threshold_chars",
        0,
        5000,
      ),
    };
    // A batch larger than the total is a certain caller typo: fail locally
    // in Spanish instead of paying multipass map calls the server truncates.
    // Mirrors EnriCode VisionAnalyzeMediaRequestRecords.
    if (
      parsed.pagesPerBatch !== undefined
      && parsed.maxPagesTotal !== undefined
      && parsed.pagesPerBatch > parsed.maxPagesTotal
    ) {
      throw new Error(
        "document.pages_per_batch no puede ser mayor que document.max_pages_total (el lote no puede exceder el total). / document.pages_per_batch cannot be greater than document.max_pages_total (a batch cannot exceed the total)."
      );
    }
    return hasAnyValue(parsed) ? parsed : undefined;
  }

  /**
   * Parses the optional `audio` tuning object with range validation.
   *
   * @remarks
   * Accepts `snake_case` and `camelCase` spellings, plus the flat
   * `audioTimestamps`, `segmentSeconds`, and `maxSegments` knobs with
   * flat-over-nested precedence. Boolean knobs are strict: `"yes"` fails
   * instead of being dropped silently.
   *
   * @param raw - Raw `audio` argument.
   * @param flat - Top-level arguments carrying flat knob aliases.
   * @param applySharedFlats - Whether shared `segmentSeconds`/`maxSegments` flats feed this section.
   * @returns Validated audio tuning, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when any knob is present but invalid or out of range.
   */
  private parseAudio(raw: unknown, flat: Record<string, unknown>, applySharedFlats: boolean): AnalyzeMediaToolParams["audio"] | undefined {
    const nested: Record<string, unknown> =
      typeof raw === "undefined" ? {} : (assertObject(raw, "audio") as Record<string, unknown>);
    this.throwOnUnknownKeys(nested, AUDIO_KNOWN_KEYS, "audio", "nested");
    const parsed = {
      timestamps: assertOptionalBoolean(
        this.resolveFlatOverNestedKnob(
          "audio.timestamps",
          [
            { key: "audioTimestamps", value: flat["audioTimestamps"] },
            { key: "audio_timestamps", value: flat["audio_timestamps"] },
          ],
          [
            { key: "timestamps", value: nested["timestamps"] },
            { key: "audioTimestamps", value: nested["audioTimestamps"] },
            { key: "audio_timestamps", value: nested["audio_timestamps"] },
          ],
        ),
        "audio.timestamps",
      ),
      segmentSeconds: this.parseBoundedNumber(
        applySharedFlats
          ? this.resolveFlatOverNestedKnob(
              "audio.segment_seconds",
              [
                { key: "segmentSeconds", value: flat["segmentSeconds"] },
                { key: "segment_seconds", value: flat["segment_seconds"] },
              ],
              [
                { key: "segment_seconds", value: nested["segment_seconds"] },
                { key: "segmentSeconds", value: nested["segmentSeconds"] },
              ],
            )
          : this.resolveNestedKnob("audio.segment_seconds", [
              { key: "segment_seconds", value: nested["segment_seconds"] },
              { key: "segmentSeconds", value: nested["segmentSeconds"] },
            ]),
        "audio.segment_seconds",
        5,
        600,
      ),
      maxSegments: this.parseBoundedInt(
        applySharedFlats
          ? this.resolveFlatOverNestedKnob(
              "audio.max_segments",
              [
                { key: "maxSegments", value: flat["maxSegments"] },
                { key: "max_segments", value: flat["max_segments"] },
              ],
              [
                { key: "max_segments", value: nested["max_segments"] },
                { key: "maxSegments", value: nested["maxSegments"] },
              ],
            )
          : this.resolveNestedKnob("audio.max_segments", [
              { key: "max_segments", value: nested["max_segments"] },
              { key: "maxSegments", value: nested["maxSegments"] },
            ]),
        "audio.max_segments",
        1,
        60,
      ),
    };
    return hasAnyValue(parsed) ? parsed : undefined;
  }

  /**
   * Parses the optional `images` tuning object with sanity validation.
   *
   * @param raw - Raw `images` argument.
   * @returns Validated images tuning, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when any knob is present but invalid.
   */
  private parseImages(raw: unknown): AnalyzeMediaToolParams["images"] | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const value = assertObject(raw, "images");
    const record = value as Record<string, unknown>;
    this.throwOnUnknownKeys(record, IMAGES_KNOWN_KEYS, "images", "nested");
    const parsed = {
      maxImagesTotal: this.parseBoundedInt(
        this.resolveNestedKnob("images.max_images_total", [
          { key: "max_images_total", value: record["max_images_total"] },
          { key: "maxImagesTotal", value: record["maxImagesTotal"] },
        ]),
        "images.max_images_total",
        1,
        500,
      ),
      imagesPerBatch: this.parseBoundedInt(
        this.resolveNestedKnob("images.images_per_batch", [
          { key: "images_per_batch", value: record["images_per_batch"] },
          { key: "imagesPerBatch", value: record["imagesPerBatch"] },
        ]),
        "images.images_per_batch",
        1,
        20,
      ),
      maxDimension: this.parseBoundedInt(
        this.resolveNestedKnob("images.max_dimension", [
          { key: "max_dimension", value: record["max_dimension"] },
          { key: "maxDimension", value: record["maxDimension"] },
        ]),
        "images.max_dimension",
        256,
        4096,
      ),
    };
    // Same batch-over-total guard as documents: fail locally in Spanish.
    // Mirrors EnriCode VisionAnalyzeMediaRequestRecords.
    if (
      parsed.imagesPerBatch !== undefined
      && parsed.maxImagesTotal !== undefined
      && parsed.imagesPerBatch > parsed.maxImagesTotal
    ) {
      throw new Error(
        "images.images_per_batch no puede ser mayor que images.max_images_total (el lote no puede exceder el total). / images.images_per_batch cannot be greater than images.max_images_total (a batch cannot exceed the total)."
      );
    }
    return hasAnyValue(parsed) ? parsed : undefined;
  }

  /**
   * Rejects unknown keys with the canonical unrecognized-parameter coaching.
   *
   * @remarks
   * Typos (`max_pages_totall`, `segement_seconds`) must fail locally instead
   * of being ignored silently and analyzing the whole file at full cost. The
   * message format matches the EnriWeb bar: "Parámetro no reconocido:
   * <keys>. Parámetros aceptados: <real list>".
   *
   * @param actual - Raw object keys.
   * @param known - Accepted key spellings for the scope.
   * @param section - Section name for error messages.
   * @param scope - Whether the keys sit at the top level or inside a section.
   * @throws Error with an Spanish-first bilingual message when the scope carries unknown keys.
   */
  private throwOnUnknownKeys(
    actual: Record<string, unknown>,
    known: ReadonlySet<string>,
    section: string,
    scope: "top-level" | "nested",
  ): void {
    const unknown: string[] = Object.keys(actual).filter((key: string): boolean => !known.has(key));
    if (unknown.length > 0) {
      const keysList: string = unknown.join(", ");
      const accepted: string = [...known].join(", ");
      const message: string =
        scope === "top-level"
          ? `Parámetro no reconocido: ${keysList}. Parámetros aceptados: ${accepted}. / Unknown parameter: ${keysList}. Accepted parameters: ${accepted}.`
          : `Parámetro no reconocido dentro de '${section}': ${keysList}. Parámetros aceptados (${section}): ${accepted}. / Unknown parameter in '${section}': ${keysList}. Accepted parameters (${section}): ${accepted}.`;
      throw new Error(message);
    }
  }

  /**
   * Resolves one knob among its same-level top-level spellings.
   *
   * @param fieldName - Canonical field name for error messages.
   * @param candidates - Top-level spellings with their raw values.
   * @returns Winning raw value, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when two spellings carry different values.
   */
  private resolveTopLevelKnob(fieldName: string, candidates: readonly AliasCandidate[]): unknown {
    return resolveAliasedCandidate(fieldName, candidates)?.value;
  }

  /**
   * Resolves one knob among its same-level nested spellings.
   *
   * @param fieldName - Dotted field name for error messages.
   * @param candidates - Nested spellings with their raw values.
   * @returns Winning raw value, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when two spellings carry different values.
   */
  private resolveNestedKnob(fieldName: string, candidates: readonly AliasCandidate[]): unknown {
    return resolveAliasedCandidate(fieldName, candidates)?.value;
  }

  /**
   * Resolves one knob applying the documented flat-over-nested precedence.
   *
   * @remarks
   * Each level first collapses its own spellings (conflicting duplicates
   * fail); the flat winner then beats the nested winner. When both arrive
   * with different values, a Spanish honesty warning is recorded (the
   * flat-wins precedence is documented in the tool schema, so the call
   * proceeds but the model still learns which value applied).
   *
   * @param fieldName - Dotted field name for error/warning messages.
   * @param flatCandidates - Flat-level spellings with their raw values.
   * @param nestedCandidates - Nested-level spellings with their raw values.
   * @returns Winning raw value, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when same-level spellings carry different values.
   */
  private resolveFlatOverNestedKnob(
    fieldName: string,
    flatCandidates: readonly AliasCandidate[],
    nestedCandidates: readonly AliasCandidate[],
  ): unknown {
    const flatWinner: AliasCandidate | undefined = resolveAliasedCandidate(fieldName, flatCandidates);
    const nestedWinner: AliasCandidate | undefined = resolveAliasedCandidate(fieldName, nestedCandidates);
    const resolution = resolveFlatOverNestedCandidate(
      fieldName,
      flatWinner ?? { key: "(flat)", value: undefined },
      nestedWinner ?? { key: "(nested)", value: undefined },
    );
    if (resolution.warning !== null) {
      this.parseWarnings.push(resolution.warning);
    }
    return resolution.winner?.value;
  }

  /**
   * Validates one language hint against the EnriCode pattern.
   *
   * @param raw - Raw language value.
   * @param fieldName - Field name for error messages.
   * @returns Validated hint, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when the hint has an invalid shape.
   */
  private parseLanguageHint(raw: string | undefined, fieldName: string): string | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const trimmed: string = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    if (trimmed.length > 32 || !/^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,2}$/.test(trimmed)) {
      throw new Error(`${fieldName} debe ser un código de idioma como 'es', 'en' o 'auto' (máximo 32 caracteres). / ${fieldName} must be a language code like 'es', 'en', or 'auto' (max 32 chars).`);
    }
    return trimmed;
  }

  /**
   * Parses an optional integer knob that must be absent or within a range.
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @param min - Inclusive minimum.
   * @param max - Inclusive maximum.
   * @returns Validated integer, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not an integer within range.
   */
  private parseBoundedInt(
    raw: unknown,
    fieldName: string,
    min: number,
    max: number,
  ): number | undefined {    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined = optionalInt(raw);
    if (typeof parsed === "undefined" || !Number.isInteger(parsed)) {
      throw new Error(`${fieldName} debe ser un entero entre ${String(min)} y ${String(max)}. / ${fieldName} must be an integer between ${String(min)} and ${String(max)}.`);
    }
    if (parsed < min || parsed > max) {
      throw new Error(`${fieldName} debe ser un entero entre ${String(min)} y ${String(max)}. / ${fieldName} must be an integer between ${String(min)} and ${String(max)}.`);
    }
    return parsed;
  }

  /**
   * Parses an optional numeric knob that must be absent or within a range.
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @param min - Inclusive minimum.
   * @param max - Inclusive maximum.
   * @returns Validated number, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not a number within range.
   */
  private parseBoundedNumber(
    raw: unknown,
    fieldName: string,
    min: number,
    max: number,
  ): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined = optionalNumber(raw);
    if (typeof parsed === "undefined" || !Number.isFinite(parsed)) {
      throw new Error(`${fieldName} debe ser un número entre ${String(min)} y ${String(max)}. / ${fieldName} must be a number between ${String(min)} and ${String(max)}.`);
    }
    if (parsed < min || parsed > max) {
      throw new Error(`${fieldName} debe ser un número entre ${String(min)} y ${String(max)}. / ${fieldName} must be a number between ${String(min)} and ${String(max)}.`);
    }
    return parsed;
  }

  /**
   * Parses an optional clip-window bound that must be absent or within 0-86400.
   *
   * @param raw - Raw knob value.
   * @param fieldName - Dotted field name for error messages.
   * @param min - Inclusive minimum.
   * @param max - Inclusive maximum.
   * @returns Validated number, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not a number within range.
   */
  private parseClipBound(raw: unknown, fieldName: string, min: number, max: number): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined = optionalNumber(raw);
    if (typeof parsed === "undefined" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new Error(`${fieldName} debe ser un número entre ${String(min)} y ${String(max)} (segundos). / ${fieldName} must be a number between ${String(min)} and ${String(max)} (seconds).`);
    }
    return parsed;
  }

  /**
   * Parses an optional clip duration that must be absent or within (0, 86400].
   *
   * @param raw - Raw knob value.
   * @returns Validated duration, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when present but not a positive number within range.
   */
  private parseClipDuration(raw: unknown): number | undefined {
    if (typeof raw === "undefined") {
      return undefined;
    }
    const parsed: number | undefined = optionalNumber(raw);
    if (
      typeof parsed === "undefined" ||
      !Number.isFinite(parsed) ||
      parsed <= 0 ||
      parsed > ANALYZE_MEDIA_LIMITS.maxClipSeconds
    ) {
      throw new Error(
        `video.clip_duration_seconds debe ser un número mayor que 0 y menor o igual que ${String(ANALYZE_MEDIA_LIMITS.maxClipSeconds)} (segundos). / video.clip_duration_seconds must be a number greater than 0 and at most ${String(ANALYZE_MEDIA_LIMITS.maxClipSeconds)} (seconds).`
      );
    }
    return parsed;
  }

  /**
   * Parses the optional requested model id for server-side dispatch affinity.
   *
   * @param raw - Raw `model` argument.
   * @returns Trimmed model id, or undefined when absent/blank.
   * @throws Error with an Spanish-first bilingual message when the model id is not a short string.
   */
  private parseModelHint(raw: unknown): string | undefined {
    if (typeof raw === "undefined" || raw === null) {
      return undefined;
    }
    if (typeof raw !== "string" || raw.trim().length === 0 || Array.from(raw.trim()).length > 128) {
      throw new Error("model debe ser el id del modelo activo (texto no vacío, máximo 128 caracteres). Omita para auto-dispatch. / model must be the active model id (non-empty text, max 128 chars). Omit for auto-dispatch.");
    }
    return raw.trim();
  }

  /**
   * Parses and validates the optional relative image region.
   *
   * @param raw - Raw `region` argument.
   * @returns Validated region, or undefined when absent.
   * @throws Error with an Spanish-first bilingual message when the region is malformed or out of range.
   */
  private parseRegion(raw: unknown): ImageRegion | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "region debe ser un objeto {x, y, width, height} con coordenadas relativas entre 0 y 1. Nunca invente coordenadas: use las cajas devueltas en 'elements' de un análisis previo de la misma imagen. / region must be an object {x, y, width, height} with relative coords between 0 and 1. Never invent coordinates: use the boxes returned in 'elements' of a previous analysis of the same image.",
      );
    }
    const record = raw as Record<string, unknown>;
    // A typo such as `widh` would otherwise be ignored and zoom the wrong
    // area: reject unknown keys like every other tuning section.
    this.throwOnUnknownKeys(record, REGION_KNOWN_KEYS, "region", "nested");
    const readFraction = (fieldName: string): number => {
      const parsed: number | undefined = optionalFraction(record[fieldName]);
      if (typeof parsed === "undefined" || parsed < 0 || parsed > 1) {
        throw new Error(
          `region.${fieldName} debe ser un número entre 0 y 1 (coordenadas relativas a la imagen original). Use las cajas de 'elements' de un análisis previo. / region.${fieldName} must be a number between 0 and 1 (coords relative to the original image). Use the 'elements' boxes of a previous analysis.`,
        );
      }
      return parsed;
    };
    const region: ImageRegion = {
      x: readFraction("x"),
      y: readFraction("y"),
      width: readFraction("width"),
      height: readFraction("height"),
    };
    if (region.width <= 0 || region.height <= 0) {
      throw new Error("region.width y region.height deben ser mayores que 0. / region.width and region.height must be greater than 0.");
    }
    if (region.x + region.width > 1 || region.y + region.height > 1) {
      throw new Error(
        "region debe caber en la imagen original: x+width y y+height no pueden exceder 1. Use las cajas de 'elements' de un análisis previo. / region must fit inside the original image: x+width and y+height cannot exceed 1. Use the 'elements' boxes of a previous analysis."
      );
    }
    return region;
  }

  /**
   * Rejects oversized prompt text before any byte is uploaded.
   *
   * @remarks
   * Mirrors EnriProxy `VISION_MAX_QUESTION_CHARS`/`VISION_MAX_CONTEXT_CHARS`
   * (2000): the server 400s after upload cost, so the gate lives here.
   *
   * @param value - Optional prompt text.
   * @param fieldName - `question` or `context`.
   * @returns Prompt text, or undefined when absent.
   * @throws Error in Spanish naming the 2000-character cap.
   */
  private static requireBoundedPromptText(value: string | undefined, fieldName: string): string | undefined {
    if (typeof value === "undefined") {
      return undefined;
    }
    if (Array.from(value).length > ANALYZE_MEDIA_LIMITS.maxPromptChars) {
      throw new Error(
        `${fieldName} excede el máximo de ${String(ANALYZE_MEDIA_LIMITS.maxPromptChars)} caracteres (se recibieron ${String(Array.from(value).length)}). Acorte el texto y reintente: el servidor rechaza este mismo tope después de cobrar el upload. / ${fieldName} exceeds the ${String(ANALYZE_MEDIA_LIMITS.maxPromptChars)}-char maximum (got ${String(Array.from(value).length)}). Shorten the text and retry: the server rejects this same cap after charging the upload.`
      );
    }
    return value;
  }
}

