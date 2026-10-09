/**
 * ANALYZE MEDIA KNOWN KEYS
 *
 * Accepted key spellings for every level of the `analyze_media` tool input:
 * top-level arguments plus the nested `video`/`document`/`audio`/`images`/
 * `region` tuning objects. Shared by the MCP param parser, the direct-client
 * pre-upload backstop, and the schema-parser agreement tests so the three
 * surfaces can never drift.
 *
 * @module tools/AnalyzeMediaKnownKeys
 */

/**
 * Maximum `source_url` characters the proxy ingests (EnriProxy
 * `VISION_MAX_SOURCE_URL_CHARS`): longer URLs fail in the parser, before any
 * byte travels, instead of failing at the server after cost.
 */
export const MAX_SOURCE_URL_CHARS = 2048;

/**
 * Accepted top-level argument keys (documented params plus every accepted flat alias).
 *
 * @remarks
 * Unknown top-level keys fail in Spanish listing the valid keys, so typos
 * (`max_frams`, `questoin`) never analyze a whole file at full cost.
 */
export const TOP_LEVEL_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "context",
  "question",
  "language",
  "max_frames",
  "maxFrames",
  "transcribe",
  "transcription_language",
  "transcriptionLanguage",
  "analysis_mode",
  "analysisMode",
  "delivery",
  "model",
  "region",
  "video",
  "audio",
  "document",
  "images",
  "segmentSeconds",
  "segment_seconds",
  "maxSegments",
  "max_segments",
  "maxFramesPerSegment",
  "max_frames_per_segment",
  "audioTimestamps",
  "audio_timestamps",
  "documentMaxPages",
  "document_max_pages",
  "clipStartSeconds",
  "clip_start_seconds",
  "clipEndSeconds",
  "clip_end_seconds",
  "clipDurationSeconds",
  "clip_duration_seconds",
  "cursor",
  "offset",
  "limit",
]);

/**
 * Accepted key spellings inside the `video` tuning object (snake_case + camelCase).
 */
export const VIDEO_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "clip_start_seconds",
  "clipStartSeconds",
  "clip_end_seconds",
  "clipEndSeconds",
  "clip_duration_seconds",
  "clipDurationSeconds",
  "segment_seconds",
  "segmentSeconds",
  "max_segments",
  "maxSegments",
  "max_frames_per_segment",
  "maxFramesPerSegment",
]);

/**
 * Accepted key spellings inside the `document` tuning object (snake_case + camelCase + legacy aliases).
 */
export const DOCUMENT_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "max_pages_total",
  "maxPagesTotal",
  "max_pages",
  "maxPages",
  "documentMaxPages",
  "document_max_pages",
  "start_page",
  "startPage",
  "documentStartPage",
  "pages_per_batch",
  "pagesPerBatch",
  "max_images_per_batch",
  "maxImagesPerBatch",
  "scanned_text_threshold_chars",
  "scannedTextThresholdChars",
]);

/**
 * Accepted key spellings inside the `audio` tuning object (snake_case + camelCase).
 */
export const AUDIO_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "timestamps",
  "audioTimestamps",
  "audio_timestamps",
  "segment_seconds",
  "segmentSeconds",
  "max_segments",
  "maxSegments",
]);

/**
 * Accepted key spellings inside the `region` zoom object.
 */
export const REGION_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "x",
  "y",
  "width",
  "height",
]);

/**
 * Accepted key spellings inside the `images` tuning object (snake_case + camelCase).
 */
export const IMAGES_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "max_images_total",
  "maxImagesTotal",
  "images_per_batch",
  "imagesPerBatch",
  "max_dimension",
  "maxDimension",
]);
