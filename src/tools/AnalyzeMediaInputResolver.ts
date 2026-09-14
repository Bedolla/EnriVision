/**
 * ANALYZE MEDIA INPUT RESOLVER
 *
 * Turns validated `path`/`paths` arguments into local files ready for
 * upload: URL inputs are materialized through bounded streaming downloads,
 * every input is readability-checked, and its effective upload content type
 * is resolved.
 *
 * Content-type rule: the server-reported content type is authoritative and
 * always wins over the extension-derived guess, so `image/webp` served from
 * `/a.png` can never degrade to `image/png`; the generic
 * `application/octet-stream` never wins.
 *
 * @module tools/AnalyzeMediaInputResolver
 */

import { constants, type Stats } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { basename } from "node:path";

import { lookup as mimeLookup } from "mime-types";

import { MediaUrlFetcher, type MediaUrlFetchResult } from "../shared/mediaUrlFetcher.js";
import { describeFileIdentity } from "./AnalyzeMediaResumableUploader.js";
import { ANALYZE_MEDIA_LIMITS, type AnalyzeMediaToolParams } from "./AnalyzeMediaContract.js";

/**
 * Reports whether one filesystem error carries the given `code`.
 *
 * @param error - Caught error value.
 * @param code - Expected Node.js error code (for example `"ELOOP"`).
 * @returns True when the error carries the code.
 */
function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * One media input resolved to a local file ready for upload.
 */
export interface ResolvedMediaInput {
  /**
   * Local filesystem path (already materialized for URL inputs).
   */
  readonly localPath: string;

  /**
   * Upload file name.
   */
  readonly filename: string;

  /**
   * File size in bytes.
   */
  readonly sizeBytes: number;

  /**
   * Effective MIME type for the upload session.
   */
  readonly contentType: string;

  /**
   * Server-reported content type for downloaded URLs.
   */
  readonly urlContentType?: string;

  /**
   * True when the download file extension was synthesized from the server
   * content type.
   */
  readonly extensionSynthesized: boolean;

  /**
   * File identity staged at resolve time (`ino:size:mtime:birthtime:nlink`).
   *
   * @remarks
   * The uploader compares it against the `fstat` identity of the opened
   * handle so a same-size replacement between resolve and upload fails
   * loudly instead of shipping the wrong bytes.
   */
  readonly stagedIdentity?: string;
}

/**
 * Resolved inputs plus the owned URL downloads awaiting cleanup.
 */
export interface ResolvedMediaInputs {
  /**
   * Upload-ready inputs in request order.
   */
  readonly inputs: readonly ResolvedMediaInput[];

  /**
   * Owned URL downloads; the caller must clean each one up.
   */
  readonly materialized: readonly MediaUrlFetchResult[];

  /**
   * Single remote URL for server-side `source_url` ingest, set only when a
   * lone http(s) input exceeds the 64 MiB client download cap. The fetcher
   * SSRF guards already passed, so the server can ingest it directly
   * without a client download + re-upload round trip.
   */
  readonly remoteUrl?: string;
}

/**
 * Resolves validated media arguments into upload-ready local files.
 */
export class AnalyzeMediaInputResolver {
  /**
   * Do-not-follow flag for strict-mode opens (`0` where advisory).
   *
   * @remarks
   * `O_NOFOLLOW` is honored on POSIX; on Windows it is advisory at best,
   * so the `dev:ino` handle-identity comparison stays the real gate there.
   */
  private static readonly NO_FOLLOW_FLAG: number =
    process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

  /**
   * Bounded http(s) media fetcher used for URL inputs.
   */
  private readonly urlFetcher: MediaUrlFetcher;

  /**
   * Creates a new {@link AnalyzeMediaInputResolver}.
   *
   * @param urlFetcher - URL fetcher used to materialize http(s) inputs.
   */
  public constructor(urlFetcher: MediaUrlFetcher) {
    this.urlFetcher = urlFetcher;
  }

  /**
   * Resolves validated params into local upload-ready inputs.
   *
   * @remarks
   * When `paths` carries at least one entry it wins over `path` (documented
   * in the tool schema).
   *
   * @param params - Validated tool parameters.
   * @param signal - Optional cancellation signal forwarded to URL downloads.
   * @returns Resolved inputs plus owned downloads awaiting cleanup.
   * @throws Error with an Spanish-first bilingual message when no input was provided, a download fails, or a file is unreadable.
   */
  public async resolve(
    params: AnalyzeMediaToolParams,
    signal?: AbortSignal,
  ): Promise<ResolvedMediaInputs> {
    const requestedPaths: readonly string[] =
      Array.isArray(params.paths) && params.paths.length > 0
        ? [...params.paths]
        : typeof params.path === "string" && params.path.trim()
          ? [params.path.trim()]
          : [];

    if (requestedPaths.length === 0) {
      throw new Error("Proporcione 'path' o 'paths'. / Provide 'path' or 'paths'.");
    }

    const materialized: MediaUrlFetchResult[] = [];
    const inputs: ResolvedMediaInput[] = [];
    // Fail fast once the resolved bytes exceed the 4 GiB upload ceiling so
    // a 100-URL set stops materializing instead of downloading ~6 GiB of
    // temp files before the tar packager rejects the set.
    // Multi-entry sets are image-only: each entry is validated right after
    // it materializes (authoritative check on the effective content type),
    // so the first non-image entry fails before the rest is downloaded.
    const isImageSet: boolean = requestedPaths.length > 1;
    let resolvedBytes = 0;
    try {
      for (const requested of requestedPaths) {
        if (!MediaUrlFetcher.isHttpUrl(requested)) {
          const local = await this.resolveLocalFile(requested);
          this.throwOnNonImageSetEntry(local.localPath, local.contentType, isImageSet);
          resolvedBytes += local.sizeBytes;
          this.throwOnUploadCeilingExceeded(resolvedBytes, inputs.length + 1, isImageSet);
          inputs.push(local);
          continue;
        }
        // A lone oversized URL escalates to server-side `source_url`
        // ingest instead of failing: the fetcher already passed its SSRF
        // guards before hitting the size cap, and multi-entry sets stay
        // local-only (the server tar flow has no URL-ingest branch).
        if (!isImageSet) {
          try {
            const fetched: MediaUrlFetchResult = await this.urlFetcher.fetch(requested, { signal });
            materialized.push(fetched);
            const downloaded = await this.resolveDownloadedFile(fetched);
            resolvedBytes += downloaded.sizeBytes;
            this.throwOnUploadCeilingExceeded(resolvedBytes, inputs.length + 1, isImageSet);
            inputs.push(downloaded);
            continue;
          } catch (error: unknown) {
            if (signal?.aborted !== true && MediaUrlFetcher.isSizeCapError(error)) {
              for (const fetched of materialized) {
                await fetched.cleanup();
              }
              return { inputs: [], materialized: [], remoteUrl: requested };
            }
            throw error;
          }
        }
        const fetched: MediaUrlFetchResult = await this.urlFetcher.fetch(requested, { signal });
        materialized.push(fetched);
        const downloaded = await this.resolveDownloadedFile(fetched);
        this.throwOnNonImageSetEntry(downloaded.localPath, downloaded.contentType, isImageSet);
        resolvedBytes += downloaded.sizeBytes;
        this.throwOnUploadCeilingExceeded(resolvedBytes, inputs.length + 1, isImageSet);
        inputs.push(downloaded);
      }
    } catch (error: unknown) {
      for (const fetched of materialized) {
        await fetched.cleanup();
      }
      throw error;
    }

    return { inputs, materialized };
  }

  /**
   * Fails fast when resolved bytes already exceed the upload ceiling.
   *
   * @remarks
   * Multi-entry sets travel as one tar archive (headers, padding, manifest,
   * end marker), so the fail-fast estimates the tar framing overhead (see
   * {@link estimateMediaSetTarBytes}) instead of the raw byte sum: a set
   * summing to 3.99 GiB raw would otherwise materialize ~100 temp downloads
   * only for the packager to reject it once framing pushes it over 4 GiB.
   * Over-estimating is correct for a fail-fast.
   *
   * @param resolvedBytes - Running total of resolved input bytes.
   * @param entryCount - Resolved entries so far (including the latest).
   * @param isImageSet - Whether the call resolves a multi-entry set.
   * @throws Error with an Spanish-first bilingual message when the set already exceeds 4 GiB.
   */
  private throwOnUploadCeilingExceeded(resolvedBytes: number, entryCount: number, isImageSet: boolean): void {
    const effectiveBytes: number = isImageSet
      ? estimateMediaSetTarBytes(resolvedBytes, entryCount)
      : resolvedBytes;
    if (effectiveBytes > ANALYZE_MEDIA_LIMITS.maxUploadBytes) {
      throw new Error(
        isImageSet
          ? `El conjunto de archivos excede el límite de subida de 4 GiB (${String(effectiveBytes)} bytes estimados con tar overhead); divida el conjunto en varias llamadas. / File set exceeds the 4 GiB upload limit (${String(effectiveBytes)} bytes estimated with tar overhead); split the set into several calls.`
          : `El archivo excede el límite de subida de 4 GiB (${String(effectiveBytes)} bytes); use un archivo más liviano. / File exceeds the 4 GiB upload limit (${String(effectiveBytes)} bytes); use a lighter file.`
      );
    }
  }

  /**
   * Resolves one local file into an upload-ready input.
   *
   * @param localPath - Absolute local file path.
   * @returns Upload-ready input.
   * @throws Error with an Spanish-first bilingual message when the file is missing or unreadable.
   */
  private async resolveLocalFile(localPath: string): Promise<ResolvedMediaInput> {
    const staged = await this.assertReadableFile(localPath);
    const sizeBytes: number = staged.sizeBytes;
    const contentType: string = this.detectMimeType(localPath);
    // Fail fast before any upload session exists: a 4 GiB non-media file
    // must never be uploaded only for the server to reject it.
    if (!MediaUrlFetcher.isAllowedMediaContentType(contentType)) {
      throw new Error(
        `El archivo local no es media analizable (${localPath}, content-type: ${contentType}). Solo se aceptan imagen, video, audio, PDF y documentos de Office. / Local file is not analyzable media (${localPath}, content-type: ${contentType}). Only image, video, audio, PDF, and Office documents are accepted.`
      );
    }
    return {
      localPath,
      filename: basename(localPath),
      sizeBytes,
      contentType,
      extensionSynthesized: false,
      stagedIdentity: staged.stagedIdentity,
    };
  }

  /**
   * Rejects a non-image entry of a multi-entry set right after it materializes.
   *
   * @remarks
   * The tar packager repeats this check authoritatively before packing; the
   * early check here only stops the resolver from downloading the rest of
   * the set after the first failure. Single inputs keep any allowed type.
   *
   * @param localPath - Materialized local path (for error messages).
   * @param contentType - Effective content type of the entry.
   * @param isImageSet - Whether the call resolves a multi-entry set.
   * @throws Error with an Spanish-first bilingual message when a set entry is not an image.
   */
  private throwOnNonImageSetEntry(localPath: string, contentType: string, isImageSet: boolean): void {
    if (isImageSet && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(
        `paths debe contener sólo archivos de imagen. No es imagen: ${localPath} (${contentType}) / paths must contain only image files. Not an image: ${localPath} (${contentType}).`
      );
    }
  }

  /**
   * Resolves one downloaded URL file into an upload-ready input.
   *
   * @param fetched - Owned download result.
   * @returns Upload-ready input preferring the server content type when the extension was synthesized.
   * @throws Error with an Spanish-first bilingual message when the downloaded file is unreadable.
   */
  private async resolveDownloadedFile(fetched: MediaUrlFetchResult): Promise<ResolvedMediaInput> {
    const staged = await this.assertReadableFile(fetched.localPath);
    const sizeBytes: number = staged.sizeBytes;
    const urlContentType: string = fetched.contentType;
    const contentType: string = this.resolveEffectiveContentType(fetched.localPath, urlContentType);
    // Same allowlist as local files: a download that resolves to
    // non-media (blanked disallowed type plus an uninferred extension)
    // fails before any upload session exists, never mid-upload.
    if (!MediaUrlFetcher.isAllowedMediaContentType(contentType)) {
      throw new Error(
        `La URL no sirvió un archivo de media válido (${fetched.localPath}, content-type: ${contentType}). Solo se aceptan imagen, video, audio, PDF y documentos de Office. / URL did not serve a valid media file (${fetched.localPath}, content-type: ${contentType}). Only image, video, audio, PDF, and Office documents are accepted.`
      );
    }
    return {
      localPath: fetched.localPath,
      filename: basename(fetched.localPath),
      sizeBytes,
      contentType,
      urlContentType,
      extensionSynthesized: fetched.extensionSynthesized,
      stagedIdentity: staged.stagedIdentity,
    };
  }

  /**
   * Resolves the upload content type for one media input.
   *
   * @remarks
   * The server-reported content type is authoritative: whenever it differs
   * from the extension-derived guess it wins (a synthesized download
   * extension is only a filesystem hint, and a mismatched authored
   * extension such as `/a.png` serving `image/webp` must never shadow the
   * real type). The generic `application/octet-stream` never wins.
   *
   * @param localPath - Local file path (already materialized for URLs).
   * @param urlContentType - Server-reported content type for downloaded URLs.
   * @returns Effective MIME type.
   */
  private resolveEffectiveContentType(localPath: string, urlContentType?: string): string {
    const reported: string =
      typeof urlContentType === "string" ? urlContentType.trim().toLowerCase() : "";
    if (reported !== "" && reported !== "application/octet-stream") {
      return reported;
    }
    return this.detectMimeType(localPath);
  }

  /**
   * Detects a MIME type using the file extension.
   *
   * @param filePath - File path.
   * @returns MIME type string.
   */
  private detectMimeType(filePath: string): string {
    const detected = mimeLookup(filePath);
    if (typeof detected === "string" && detected.trim()) {
      return detected.trim();
    }
    return "application/octet-stream";
  }

  /**
   * Validates that a path exists and is a readable file.
   *
   * @remarks
   * `path` follows symlinks by design (the MCP host trusts the model with
   * host-file access, like the documented DNS-rebinding residual in
   * `mediaUrlFetcher.ts`). Operators that need strict mode set
   * `ENRIVISION_DENY_SYMLINKS=1` to reject symlinked inputs with a Spanish
   * error instead.
   *
   * @param filePath - Local filesystem path.
   * @returns File size in bytes.
   * @throws Error with an Spanish-first bilingual message when the file is missing, not readable, a rejected symlink, or exceeds 4 GiB.
   */
  private async assertReadableFile(filePath: string): Promise<{ readonly sizeBytes: number; readonly stagedIdentity: string }> {
    if (process.env["ENRIVISION_DENY_SYMLINKS"] === "1") {
      return this.assertReadableFileWithoutSymlinks(filePath);
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error: unknown) {
      this.throwOnMissingFile(filePath, error);
      throw new Error(`Archivo no encontrado: ${filePath} / File not found: ${filePath}.`);
    }
    // Ensure the file is readable.
    const handle = await open(filePath, "r");
    try {
      // Stage the identity from `fstat` on the opened handle (never the
      // path stat): the uploader compares it at open time so a same-size
      // replacement between resolve and upload fails loudly.
      const openedStat = await handle.stat();
      return {
        sizeBytes: this.checkFileStat(filePath, fileStat.size, fileStat.isFile()),
        stagedIdentity: describeFileIdentity(openedStat),
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Validates one file without ever trusting a path re-stat.
   *
   * @remarks
   * `lstat` + `stat` + `open` on the same path races: a symlink swapped in
   * between the check and the open defeats `ENRIVISION_DENY_SYMLINKS`.
   * Opening with `O_NOFOLLOW` (POSIX) makes a swapped-in symlink fail with
   * `ELOOP` instead, and the size/kind verdicts come from `fstat` on the
   * opened handle — never from a second path lookup. The `dev:ino`
   * comparison additionally rejects a real file swapped between `lstat`
   * and `open` on platforms where `O_NOFOLLOW` is advisory.
   *
   * @param filePath - Local filesystem path.
   * @returns File size in bytes plus the staged `fstat` identity.
   * @throws Error with an Spanish-first bilingual message when the file is missing, a symlink, swapped mid-check, or exceeds 4 GiB.
   */
  private async assertReadableFileWithoutSymlinks(filePath: string): Promise<{ readonly sizeBytes: number; readonly stagedIdentity: string }> {
    let linkStat: Stats;
    try {
      linkStat = await lstat(filePath);
      if (linkStat.isSymbolicLink()) {
        throw new Error(`No se permiten enlaces simbólicos: ${filePath} / Symbolic links are not allowed: ${filePath}.`);
      }
    } catch (error: unknown) {
      this.throwOnMissingFile(filePath, error);
      throw new Error(`Archivo no encontrado: ${filePath} / File not found: ${filePath}.`);
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, constants.O_RDONLY | AnalyzeMediaInputResolver.NO_FOLLOW_FLAG);
    } catch (error: unknown) {
      if (isErrnoCode(error, "ELOOP")) {
        throw new Error(`No se permiten enlaces simbólicos: ${filePath} / Symbolic links are not allowed: ${filePath}.`);
      }
      this.throwOnMissingFile(filePath, error);
      throw new Error(`Archivo no encontrado: ${filePath} / File not found: ${filePath}.`);
    }
    try {
      const openedStat = await handle.stat();
      if (openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino) {
        throw new Error(`El archivo cambió durante la validación (${filePath}); reintente la llamada. / File changed during validation (${filePath}); retry the call.`);
      }
      return {
        sizeBytes: this.checkFileStat(filePath, openedStat.size, openedStat.isFile()),
        stagedIdentity: describeFileIdentity(openedStat),
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Applies the shared size/kind verdicts to one stat result.
   *
   * @param filePath - Local filesystem path (for error messages).
   * @param size - File size in bytes.
   * @param isFile - Whether the stat target is a regular file.
   * @returns File size in bytes.
   * @throws Error with an Spanish-first bilingual message when the target is not a file, is empty, or exceeds 4 GiB.
   */
  private checkFileStat(filePath: string, size: number, isFile: boolean): number {
    if (!isFile) {
      throw new Error(`No es un archivo: ${filePath} / Not a file: ${filePath}.`);
    }
    if (size === 0) {
      throw new Error(`El archivo está vacío (0 bytes): ${filePath}. No hay nada que analizar. / File is empty (0 bytes): ${filePath}. Nothing to analyze.`);
    }
    if (size > ANALYZE_MEDIA_LIMITS.maxUploadBytes) {
      throw new Error(
        `El archivo excede el límite de subida de 4 GiB: ${filePath} (${String(size)} bytes). / File exceeds the 4 GiB upload limit: ${filePath} (${String(size)} bytes).`
      );
    }
    return size;
  }

  /**
   * Maps filesystem lookup failures to the stable not-found error.
   *
   * @param filePath - Local filesystem path (for error messages).
   * @param error - Raw filesystem error.
   * @throws Error with an Spanish-first bilingual message when the file is missing; rethrows unreadable-file errors otherwise.
   */
  private throwOnMissingFile(filePath: string, error: unknown): void {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Archivo no encontrado: ${filePath} / File not found: ${filePath}.`);
    }
    if (error instanceof Error && /no se permiten enlaces/i.test(error.message)) {
      throw error;
    }
    throw new Error(`No se puede leer el archivo: ${filePath} / Cannot read file: ${filePath}.`);
  }
}

/**
 * Estimates the tar archive size for a multi-image set before packing.
 *
 * @remarks
 * Fail-fast estimator (over-estimates on purpose): raw bytes plus one 512 B
 * header per file, the manifest entry (512 B header plus content padded to
 * 512 B), worst-case content padding (511 B per file), and the 1024 B end
 * marker. The manifest term budgets 256 B of envelope plus 512 B per entry
 * (worst case: 255 B basenames plus content type plus JSON overhead), so
 * long filenames never under-estimate. Used by the resolver so a set that
 * only fits raw never pays ~100 temp downloads before the packager rejects
 * it.
 *
 * @param rawBytes - Summed input bytes.
 * @param fileCount - Number of files in the set.
 * @returns Estimated tar size in bytes.
 */
export function estimateMediaSetTarBytes(rawBytes: number, fileCount: number): number {
  const manifestContentBytes: number = 256 + Math.max(0, fileCount) * 512;
  const manifestPaddedBytes: number = Math.ceil(manifestContentBytes / 512) * 512;
  return (
    Math.max(0, rawBytes) +
    Math.max(0, fileCount) * 512 +
    512 +
    manifestPaddedBytes +
    Math.max(0, fileCount) * 511 +
    1024
  );
}
