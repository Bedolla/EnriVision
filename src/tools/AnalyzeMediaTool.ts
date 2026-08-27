/**
 * ANALYZE MEDIA TOOL
 *
 * Implements the `analyze_media` MCP tool:
 * - Validates local file paths or http(s) URLs
 * - Materializes URL inputs via bounded downloads (temporary, owned cleanup)
 * - Streams the bytes to EnriProxy via resumable uploads
 * - Triggers server-side analysis and returns text-only results
 *
 * @module tools/AnalyzeMediaTool
 */

import { existsSync } from "node:fs";
import { stat, open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import { lookup as mimeLookup } from "mime-types";

import { EnriProxyHttpError, type CreateUploadSessionResponse, type EnriProxyClient } from "../client/EnriProxyClient.js";
import { assertHttpUrl, assertNonEmptyString, assertObject, optionalBoolean, optionalInt, optionalNumber, optionalString } from "../shared/validation.js";
import { MediaUrlFetcher, type MediaUrlFetchResult } from "../shared/mediaUrlFetcher.js";
import { computeTarSizeBytes, TarStream, type TarEntry } from "../shared/tar.js";

/**
 * Content type for EnriVision media-set archives (tar, no compression).
 */
const ENRIVISION_MEDIA_SET_TAR_CONTENT_TYPE = "application/vnd.enrivision.media-set+tar";

/**
 * Fixed manifest entry name inside EnriVision media-set tar archives.
 */
const ENRIVISION_MEDIA_SET_TAR_MANIFEST_NAME = "manifest.json";

/**
 * One media input resolved to a local file ready for upload.
 */
interface ResolvedMediaInput {
  /**
   * Local filesystem path (already materialized for URL inputs).
   */
  readonly localPath: string;

  /**
   * Server-reported content type for downloaded URLs, preferred when the local
   * extension lookup is inconclusive.
   */
  readonly urlContentType?: string;
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
   * Use `paths` to analyze multiple images in a single call.
   */
  readonly path?: string;

  /**
   * Absolute local filesystem paths or http(s) URLs on the MCP host.
   *
   * @remarks
   * When provided, EnriVision uploads the files as a single media-set archive
   * (resumable, up to 4GB) and triggers server-side batching + reduce.
   *
   * This is intended for many UI screenshots / photo sets.
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
   * Optional max frames override for videos (1-20).
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
     * Whether to include timestamped segments in audio extraction.
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
   *
   * @remarks
   * Used only when analyzing multiple images via `paths`.
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

  /**
   * Optional relative region of the analyzed image for native-resolution zoom.
   *
   * @remarks
   * Normalized [0,1] coordinates over the original image (0,0 = top-left
   * corner). Use the boxes returned in `elements` of a previous analysis of
   * the same image; never invent coordinates.
   */
  readonly region?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
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
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
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
 * Dependencies for {@link AnalyzeMediaTool}.
 */
export interface AnalyzeMediaToolDeps {
  /**
   * Creates an EnriProxy client with a base URL, API key, and timeout.
   *
   * @param serverUrl - EnriProxy URL
   * @param apiKey - EnriProxy API key
   * @param timeoutMs - Timeout in ms
   * @returns Client instance
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

/**
 * MCP tool that uploads and analyzes local or http(s) URL media.
 */
export class AnalyzeMediaTool {
  /**
   * Tool dependencies.
   */
  private readonly deps: AnalyzeMediaToolDeps;

  /**
   * Bounded http(s) media fetcher used when `path`/`paths` carry URLs.
   */
  private readonly urlFetcher: MediaUrlFetcher;

  /**
   * Creates a new {@link AnalyzeMediaTool}.
   *
   * @param deps - Tool dependencies
   * @param urlFetcher - Optional URL fetcher override for tests
   */
  public constructor(deps: AnalyzeMediaToolDeps, urlFetcher: MediaUrlFetcher = new MediaUrlFetcher()) {
    this.deps = deps;
    this.urlFetcher = urlFetcher;
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments
   * @returns Validated parameters
   */
  public parseParams(raw: unknown): AnalyzeMediaToolParams {
    const obj = assertObject(raw, "arguments");

    const pathRaw = typeof obj["path"] === "string" ? obj["path"].trim() : "";
    const path = pathRaw ? pathRaw : undefined;
    if (path && !isAbsolute(path) && !MediaUrlFetcher.isHttpUrl(path)) {
      throw new Error("path debe ser una ruta de archivo absoluta o una URL http(s).");
    }

    const pathsRaw = obj["paths"];
    let paths: string[] | undefined;
    if (typeof pathsRaw !== "undefined") {
      if (!Array.isArray(pathsRaw)) {
        throw new Error("paths debe ser un arreglo de rutas de archivo absolutas.");
      }
      const out: string[] = [];
      for (const item of pathsRaw) {
        if (typeof item !== "string" || !item.trim()) {
          continue;
        }
        const p = item.trim();
        if (!isAbsolute(p) && !MediaUrlFetcher.isHttpUrl(p)) {
          throw new Error("paths debe contener sólo rutas de archivo absolutas o URLs http(s).");
        }
        out.push(p);
      }
      if (out.length > 0) {
        paths = out;
      }
    }

    if (!path && (!paths || paths.length === 0)) {
      throw new Error("Proporcione 'path' o 'paths'.");
    }
    const context = optionalString(obj["context"]);
    const question = optionalString(obj["question"]);
    const language = optionalString(obj["language"]);
    const maxFrames = optionalInt(obj["max_frames"]);
    const transcribe = optionalBoolean(obj["transcribe"]);
    const transcriptionLanguage = optionalString(obj["transcription_language"]);

    const analysisModeRaw = optionalString(obj["analysis_mode"]);
    const analysisMode =
      analysisModeRaw === "auto" || analysisModeRaw === "single" || analysisModeRaw === "multipass"
        ? analysisModeRaw
        : analysisModeRaw
          ? (() => {
              throw new Error("analysis_mode debe ser uno de: auto|single|multipass.");
            })()
          : undefined;

    const videoRaw = obj["video"];
    let video: AnalyzeMediaToolParams["video"] | undefined;
    if (typeof videoRaw !== "undefined") {
      const v = assertObject(videoRaw, "video");
      video = {
        clipStartSeconds: optionalNumber(v["clip_start_seconds"]),
        clipDurationSeconds: optionalNumber(v["clip_duration_seconds"]),
        segmentSeconds: optionalNumber(v["segment_seconds"]),
        maxSegments: optionalInt(v["max_segments"]),
        maxFramesPerSegment: optionalInt(v["max_frames_per_segment"])
      };
    }

    const documentRaw = obj["document"];
    let document: AnalyzeMediaToolParams["document"] | undefined;
    if (typeof documentRaw !== "undefined") {
      const d = assertObject(documentRaw, "document");
      document = {
        maxPagesTotal: optionalInt(d["max_pages_total"]),
        pagesPerBatch: optionalInt(d["pages_per_batch"]),
        maxImagesPerBatch: optionalInt(d["max_images_per_batch"]),
        scannedTextThresholdChars: optionalInt(d["scanned_text_threshold_chars"])
      };
    }

    const audioRaw = obj["audio"];
    let audio: AnalyzeMediaToolParams["audio"] | undefined;
    if (typeof audioRaw !== "undefined") {
      const a = assertObject(audioRaw, "audio");
      audio = {
        timestamps: optionalBoolean(a["timestamps"]),
        segmentSeconds: optionalNumber(a["segment_seconds"]),
        maxSegments: optionalInt(a["max_segments"])
      };
    }

    const imagesRaw = obj["images"];
    let images: AnalyzeMediaToolParams["images"] | undefined;
    if (typeof imagesRaw !== "undefined") {
      const img = assertObject(imagesRaw, "images");
      images = {
        maxImagesTotal: optionalInt(img["max_images_total"]),
        imagesPerBatch: optionalInt(img["images_per_batch"]),
        maxDimension: optionalInt(img["max_dimension"])
      };
    }

    return {
      path,
      paths,
      context,
      question,
      language,
      maxFrames,
      transcribe,
      transcriptionLanguage,
      analysisMode,
      region: this.parseRegion(obj["region"]),
      video,
      document,
      audio,
      images
    };
  }

  /**
   * Executes the tool.
   *
   * @param params - Validated parameters
   * @returns Tool result
   */
  public async execute(params: AnalyzeMediaToolParams): Promise<AnalyzeMediaToolResult> {
    const serverUrl = assertHttpUrl(this.deps.defaultServerUrl, "ENRIPROXY_URL");
    const apiKey = assertNonEmptyString(this.deps.defaultApiKey, "ENRIPROXY_API_KEY");
    const timeoutMs = this.deps.defaultTimeoutMs;

    const clientTraceId = `enrivision_${randomUUID()}`;

    const client = this.deps.createClient(serverUrl, apiKey, timeoutMs);

    const requestedPaths =
      Array.isArray(params.paths) && params.paths.length > 0
        ? [...params.paths]
        : typeof params.path === "string" && params.path.trim()
          ? [params.path.trim()]
          : [];

    if (requestedPaths.length === 0) {
      throw new Error("Proporcione 'path' o 'paths'.");
    }

    const materialized: MediaUrlFetchResult[] = [];

    try {
      const inputs: ResolvedMediaInput[] = [];
      for (const requested of requestedPaths) {
        if (!MediaUrlFetcher.isHttpUrl(requested)) {
          inputs.push({ localPath: requested });
          continue;
        }
        const fetched: MediaUrlFetchResult = await this.urlFetcher.fetch(requested);
        materialized.push(fetched);
        inputs.push({ localPath: fetched.localPath, urlContentType: fetched.contentType });
      }

      let uploadId: string;

      if (inputs.length > 1) {
        uploadId = await this.uploadImageSetAsMediaSetTar(
          client,
          inputs,
          timeoutMs,
          clientTraceId
        );
      } else {
        const single = inputs[0]!;
        const fileSize = await this.assertReadableFile(single.localPath);
        const filename = basename(single.localPath);
        const contentType = this.resolveEffectiveContentType(single.localPath, single.urlContentType);

        const session = await client.createUploadSession({
          filename,
          sizeBytes: fileSize,
          contentType,
          clientTraceId
        });

        const finalOffset = await this.uploadFileResumable(client, single.localPath, fileSize, session, timeoutMs);
        if (finalOffset !== fileSize) {
          throw new Error(`Subida incompleta: se enviaron ${finalOffset} de ${fileSize} bytes.`);
        }

        uploadId = session.upload_id;
      }

      const defaultLanguageRaw =
        typeof process.env["ENRIVISION_DEFAULT_LANGUAGE"] === "string"
          ? process.env["ENRIVISION_DEFAULT_LANGUAGE"].trim()
          : "";
      const language =
        typeof params.language === "string" && params.language.trim()
          ? params.language.trim()
          : defaultLanguageRaw
            ? defaultLanguageRaw
            : undefined;

      const analysis = await client.analyze({
        uploadId,
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
        images: params.images
      });

      const extraction = this.stripInternalExtractionFields(analysis.extraction);

      return {
        analysis: analysis.analysis,
        ...(Array.isArray(analysis.elements) && analysis.elements.length > 0
          ? { elements: Object.freeze(analysis.elements.map((element) => Object.freeze({ ...element }))) }
          : {}),
        media_type: analysis.media_type,
        extraction
      };
    } finally {
      for (const fetched of materialized) {
        await fetched.cleanup();
      }
    }
  }

  /**
   * Resolves the upload content type for one media input.
   *
   * @remarks
   * URL downloads keep their extension-derived type when the extension is
   * recognized; otherwise the server-reported content type wins over the
   * generic `application/octet-stream` fallback.
   *
   * @param localPath - Local file path (already materialized for URLs)
   * @param urlContentType - Server-reported content type for downloaded URLs
   * @returns Effective MIME type
   */
  private resolveEffectiveContentType(localPath: string, urlContentType?: string): string {
    const detected = this.detectMimeType(localPath);
    if (detected !== "application/octet-stream") {
      return detected;
    }
    if (urlContentType && urlContentType.trim() && urlContentType !== "application/octet-stream") {
      return urlContentType.trim();
    }
    return detected;
  }

  /**
   * Removes internal identifiers (upload ids, routing-only values, etc.) from the
   * extraction payload before returning it to the model.
   *
   * @param extraction - Raw extraction object returned by EnriProxy
   * @returns Sanitized extraction object
   */
  private stripInternalExtractionFields(
    extraction: Record<string, unknown>
  ): Record<string, unknown> {
    const stripped = this.stripInternalFields(extraction);
    return this.asPlainObject(stripped);
  }

  /**
   * Recursively strips internal fields from an unknown value.
   *
   * @param value - Unknown value to sanitize
   * @returns Sanitized value
   */
  private stripInternalFields(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripInternalFields(item));        
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (key === "upload_id" || key === "uploadId") {
        continue;
      }
      if (key === "detected_media_type") {
        continue;
      }
      if (key === "analysis_mode_requested" || key === "analysis_mode_used") {
        continue;
      }
      if (key === "multipass") {
        continue;
      }
      if (key === "model") {
        continue;
      }
      next[key] = this.stripInternalFields(child);
    }

    return next;
  }

  /**
   * Ensures the sanitized extraction value is a plain JSON object.
   *
   * @param value - Sanitized value
   * @returns Plain object
   */
  private asPlainObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  /**
   * Validates that a path exists and is a readable file.
   *
   * @param filePath - Local filesystem path
  /**
   * Parses and validates the optional relative image region.
   *
   * @param raw - Raw `region` argument.
   * @returns Validated region, or undefined when absent.
   */
  private parseRegion(
    raw: unknown
  ): { x: number; y: number; width: number; height: number } | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "region debe ser un objeto {x, y, width, height} con coordenadas relativas entre 0 y 1. Nunca invente coordenadas: use las cajas devueltas en 'elements' de un análisis previo de la misma imagen."
      );
    }
    const record = raw as Record<string, unknown>;
    const readFraction = (fieldName: string): number => {
      const value: unknown = record[fieldName];
      const parsed: number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(
          `region.${fieldName} debe ser un número entre 0 y 1 (coordenadas relativas a la imagen original). Use las cajas de 'elements' de un análisis previo.`
        );
      }
      return parsed;
    };
    const region = {
      x: readFraction("x"),
      y: readFraction("y"),
      width: readFraction("width"),
      height: readFraction("height")
    };
    if (region.width <= 0 || region.height <= 0) {
      throw new Error("region.width y region.height deben ser mayores que 0.");
    }
    return region;
  }

  /**
   * Validates that a path exists and is a readable file.
   *
   * @param filePath - Local filesystem path
   * @returns File size in bytes
   */
  private async assertReadableFile(filePath: string): Promise<number> {
    if (!existsSync(filePath)) {
      throw new Error(`Archivo no encontrado: ${filePath}`);
    }

    const st = await stat(filePath);
    if (!st.isFile()) {
      throw new Error(`No es un archivo: ${filePath}`);
    }

    // Ensure the file is readable.
    const handle = await open(filePath, "r");
    try {
      return st.size;
    } finally {
      await handle.close();
    }
  }

  /**
   * Detects MIME type using file extension.
   *
   * @param filePath - File path
   * @returns MIME type string
   */
  private detectMimeType(filePath: string): string {
    const detected = mimeLookup(filePath);
    if (typeof detected === "string" && detected.trim()) {
      return detected.trim();
    }
    return "application/octet-stream";
  }

  /**
   * Uploads multiple local images as a single EnriVision media-set tar archive.
   *
   * @remarks
   * This avoids creating many concurrent resumable upload sessions (which are
   * capped per API key) and enables server-side batching + reduce for large
   * screenshot sets.
   *
   * @param client - EnriProxy client
   * @param inputs - Resolved media inputs (local paths, URLs already materialized)
   * @param timeoutMs - Request timeout per HTTP request
   * @param clientTraceId - Client trace id for correlation
   * @returns Upload id for the created tar session
   */
  private async uploadImageSetAsMediaSetTar(
    client: EnriProxyClient,
    inputs: ReadonlyArray<ResolvedMediaInput>,
    timeoutMs: number,
    clientTraceId: string
  ): Promise<string> {
    if (inputs.length < 2) {
      throw new Error("uploadImageSetAsMediaSetTar requires at least 2 file paths.");
    }

    const files: Array<{
      index: number;
      path: string;
      filename: string;
      sizeBytes: number;
      contentType: string;
      entryName: string;
    }> = [];

    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i]!;
      const sizeBytes = await this.assertReadableFile(input.localPath);
      const filename = basename(input.localPath);
      const contentType = this.resolveEffectiveContentType(input.localPath, input.urlContentType);

      if (!contentType.toLowerCase().startsWith("image/")) {
        throw new Error(`paths debe contener sólo archivos de imagen. No es imagen: ${input.localPath} (${contentType})`);
      }

      const extRaw = extname(filename).toLowerCase();
      const ext = extRaw && /^[a-z0-9.]+$/.test(extRaw) ? extRaw : ".img";
      const entryName = `${String(i + 1).padStart(6, "0")}${ext}`;

      files.push({
        index: i + 1,
        path: input.localPath,
        filename,
        sizeBytes,
        contentType,
        entryName
      });
    }

    const manifest = {
      type: "enrivision_media_set",
      version: 1,
      media_type: "image_set",
      items: files.map((f) => ({
        index: f.index,
        name: f.entryName,
        filename: f.filename,
        content_type: f.contentType,
        size_bytes: f.sizeBytes
      }))
    };

    const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
    const nowSeconds = Math.floor(Date.now() / 1000);

    const entries: TarEntry[] = [
      {
        name: ENRIVISION_MEDIA_SET_TAR_MANIFEST_NAME,
        source: { type: "buffer", buffer: manifestBuffer },
        mtimeSeconds: nowSeconds
      },
      ...files.map(
        (f): TarEntry => ({
          name: f.entryName,
          source: { type: "file", path: f.path, sizeBytes: f.sizeBytes },
          mtimeSeconds: nowSeconds
        })
      )
    ];

    const tarSizeBytes = computeTarSizeBytes(entries);
    const tar = new TarStream(entries);
    if (tar.getSizeBytes() !== tarSizeBytes) {
      throw new Error("Internal error: tar size mismatch.");
    }

    const session = await client.createUploadSession({
      filename: "enrivision-image-set.tar",
      sizeBytes: tarSizeBytes,
      contentType: ENRIVISION_MEDIA_SET_TAR_CONTENT_TYPE,
      clientTraceId
    });

    const chunkSize = Math.max(1, Math.floor(session.chunk_size_bytes));
    let offset = await client.getUploadOffset(session.upload_id);
    if (offset < 0 || offset > tarSizeBytes) {
      throw new Error(`Invalid server offset for tar upload: ${offset}`);
    }

    while (offset < tarSizeBytes) {
      let madeProgress = false;

      for await (const chunk of tar.iterateChunks(offset, chunkSize)) {
        if (chunk.length === 0) {
          continue;
        }

        const expectedOffset = offset;
        const nextOffset = await this.uploadChunkWithRetry(
          client,
          session.upload_id,
          expectedOffset,
          chunk,
          timeoutMs
        );

        offset = nextOffset;
        madeProgress = true;

        const progress = Math.floor((offset / tarSizeBytes) * 100);
        console.error(`enrivision: upload ${progress}% (${offset}/${tarSizeBytes} bytes)`);

        // Offset resync: restart generation from the server-provided offset.
        if (offset !== expectedOffset + chunk.length) {
          break;
        }

        if (offset >= tarSizeBytes) {
          break;
        }
      }

      if (!madeProgress) {
        throw new Error("Subida estancada: no hubo progreso al enviar los fragmentos del tar.");
      }
    }

    if (offset !== tarSizeBytes) {
      throw new Error(`Subida incompleta: se enviaron ${offset} de ${tarSizeBytes} bytes.`);
    }

    return session.upload_id;
  }

  /**
   * Uploads a file to EnriProxy in resumable chunks.
   *
   * @param client - EnriProxy client
   * @param filePath - Local file path
   * @param fileSize - Total file size in bytes
   * @param session - Server-created session
   * @param timeoutMs - Request timeout in milliseconds
   * @returns Final offset
   */
  private async uploadFileResumable(
    client: EnriProxyClient,
    filePath: string,
    fileSize: number,
    session: CreateUploadSessionResponse,
    timeoutMs: number
  ): Promise<number> {
    const chunkSize = Math.max(1, Math.floor(session.chunk_size_bytes));
    const handle = await open(filePath, "r");

    try {
      let offset = await client.getUploadOffset(session.upload_id);

      while (offset < fileSize) {
        const remaining = fileSize - offset;
        const nextSize = Math.min(chunkSize, remaining);

        const buffer = Buffer.allocUnsafe(nextSize);
        const read = await handle.read(buffer, 0, nextSize, offset);
        if (read.bytesRead <= 0) {
          break;
        }

        const chunk = read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead);

        offset = await this.uploadChunkWithRetry(client, session.upload_id, offset, chunk, timeoutMs);

        const progress = Math.floor((offset / fileSize) * 100);
        console.error(`enrivision: upload ${progress}% (${offset}/${fileSize} bytes)`);
      }

      return offset;
    } finally {
      await handle.close();
    }
  }

  /**
   * Uploads a single chunk with retry and offset resync.
   *
   * @param client - EnriProxy client
   * @param uploadId - Upload id
   * @param offset - Expected offset
   * @param chunk - Chunk bytes
   * @param timeoutMs - Timeout in ms
   * @returns New offset
   */
  private async uploadChunkWithRetry(
    client: EnriProxyClient,
    uploadId: string,
    offset: number,
    chunk: Buffer,
    timeoutMs: number
  ): Promise<number> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await client.appendUploadChunk({ uploadId, offset, chunk, timeoutMs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof EnriProxyHttpError) {
          // Offset mismatch: resync and let the caller re-read at the correct offset.
          if (error.status === 409) {
            const actual = await client.getUploadOffset(uploadId);
            if (actual !== offset) {
              console.error(`enrivision: offset resync (${offset} -> ${actual})`);
              return actual;
            }
          }

          // Do not retry on client errors (except 409 which is handled above).
          if (
            error.status === 400 ||
            error.status === 401 ||
            error.status === 403 ||
            error.status === 404 ||
            error.status === 410 ||
            error.status === 413
          ) {
            throw error;
          }
        }

        if (attempt === maxAttempts) {
          throw error;
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.error(`enrivision: retry ${attempt}/${maxAttempts} after ${backoffMs}ms (${message})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error("La subida falló tras los reintentos.");
  }
}
