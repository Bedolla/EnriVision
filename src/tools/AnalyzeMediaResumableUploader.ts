/**
 * ANALYZE MEDIA RESUMABLE UPLOADER
 *
 * Streams local bytes to EnriProxy through resumable upload sessions with
 * offset resync and bounded retries. Upload progress is reported to stderr
 * at most once per 10% step (plus completion) so multi-hundred-chunk
 * uploads do not flood the operator log.
 *
 * @module tools/AnalyzeMediaResumableUploader
 */

import { open } from "node:fs/promises";

import {
  EnriProxyHttpError,
  type CreateUploadSessionResponse,
  type EnriProxyClient,
} from "../client/EnriProxyClient.js";
import { ANALYZE_MEDIA_LIMITS } from "./AnalyzeMediaContract.js";

/**
 * Hard cap for the overall upload deadline (mirrors EnriCode 20 min).
 */
const MAX_UPLOAD_DEADLINE_MS: number = 20 * 60 * 1000;

/**
 * Headroom added to the size-derived overall upload deadline.
 */
const UPLOAD_DEADLINE_HEADROOM_MS: number = 60_000;

/**
 * Worst-case upload throughput for deadline sizing (~1 Mbps, mirrors EnriCode).
 */
const UPLOAD_DEADLINE_BYTES_PER_SECOND: number = 125_000;

/**
 * File-identity re-check cadence in chunks (mirrors EnriCode 16).
 */
export const IDENTITY_CHECK_EVERY_CHUNKS: number = 16;

/**
 * File-identity re-check cadence in milliseconds (mirrors EnriCode 5 s).
 */
export const IDENTITY_CHECK_EVERY_MS: number = 5_000;

/**
 * Consecutive upload iterations without offset advance before the upload is
 * declared stuck (mirrors the single-file same-offset 409 guard).
 *
 * @remarks
 * A 2xx chunk response that reports the pre-chunk offset advances nothing:
 * retrying the same bytes forever would spin to the 20 min deadline, so the
 * third consecutive no-advance iteration fails fast with the inconsistent-
 * protocol error instead.
 */
export const MAX_CONSECUTIVE_NO_ADVANCE: number = 3;

/**
 * Uploads local bytes through resumable EnriProxy sessions.
 */
export class AnalyzeMediaResumableUploader {
  /**
   * Uploads a file to EnriProxy in resumable chunks.
   *
   * @param client - EnriProxy client.
   * @param filePath - Local file path.
   * @param fileSize - Total file size in bytes.
   * @param session - Server-created session.
   * @param timeoutMs - Request timeout in milliseconds.
   * @param signal - Optional cancellation signal.
   * @param expectedIdentity - Resolve-time file identity compared at open (`fstat`); same-size swaps fail loudly.
   * @returns Final offset.
   * @throws Error with an Spanish-first bilingual message when the upload stalls, is cancelled, or stays incomplete.
   */
  public async uploadFileResumable(
    client: EnriProxyClient,
    filePath: string,
    fileSize: number,
    session: CreateUploadSessionResponse,
    timeoutMs: number,
    signal?: AbortSignal,
    expectedIdentity?: string,
  ): Promise<number> {
    const chunkSize: number = effectiveChunkSizeBytes(session.chunk_size_bytes);
    // One scratch for the whole upload, bounded by the actual file size so a
    // 1-byte file never pins the full 16 MiB ceiling (mirrors EnriCode
    // `max(1, min(effectiveChunkSize, totalBytes))`). Every iteration reads
    // into a subarray view instead of allocating per chunk. Safe because each
    // chunk is fully consumed (retries included) before the next read, and an
    // offset resync discards the chunk before re-reading at the new offset.
    const scratch: Buffer = Buffer.allocUnsafe(resolveScratchSize(chunkSize, fileSize));
    const progress = new UploadProgressLogger(fileSize);
    const uploadStartedAt: number = Date.now();
    const uploadDeadlineMs: number = resolveUploadDeadlineMs(fileSize);
    const handle = await open(filePath, "r");

    try {
      // Staged resolve-time identity first (same-size replacement
      // between resolve and upload), then the size gate: either mismatch
      // fails loudly instead of shipping the wrong content.
      const openedStat = await handle.stat();
      const initialIdentity: string = describeFileIdentity(openedStat);
      if (typeof expectedIdentity === "string" && initialIdentity !== expectedIdentity) {
        throw new Error(
          `El archivo cambió entre la resolución y la subida (${filePath}); reintente la llamada con el archivo estable. / File changed between resolve and upload (${filePath}); retry the call with a stable file.`
        );
      }
      if (openedStat.size !== fileSize) {
        throw new Error(
          `El archivo cambió antes de la subida (${filePath}); reintente la llamada. / File changed before upload (${filePath}); retry the call.`
        );
      }
      let offset: number = await withResumableRetry(
        () => client.getUploadOffset(session.upload_id, signal),
        signal,
      );
      if (!Number.isFinite(offset) || offset < 0 || offset > fileSize) {
        throw new Error(
          `Offset del servidor inválido para la subida: ${String(offset)} (tamaño del archivo: ${String(fileSize)}). / Invalid server offset for the upload: ${String(offset)} (file size: ${String(fileSize)}).`
        );
      }

      let chunksSinceIdentityCheck: number = 0;
      let lastIdentityCheckAt: number = 0;
      let consecutiveNoAdvance: number = 0;
      while (offset < fileSize) {
        this.throwIfCancelled(signal);
        if (Date.now() - uploadStartedAt > uploadDeadlineMs) {
          await deleteUploadSessionBestEffort(client, session.upload_id);
          throw new Error(
            `La subida excedió el tiempo máximo (${String(Math.round(uploadDeadlineMs / 1000))} s para ${String(fileSize)} bytes); reintente con un archivo más pequeño o una conexión más rápida. / Upload exceeded the maximum time (${String(Math.round(uploadDeadlineMs / 1000))} s for ${String(fileSize)} bytes); retry with a smaller file or a faster connection.`
          );
        }
        if (shouldRecheckIdentity(chunksSinceIdentityCheck, Date.now(), lastIdentityCheckAt)) {
          // fstat on the OPEN handle (never a path re-stat): a rename-swap
          // keeps this fd on the original bytes, so path-stat would judge a
          // file we are no longer reading. Comparing the handle identity
          // catches in-place same-size writes; truncation is caught by size.
          const current = await handle.stat();
          if (describeFileIdentity(current) !== initialIdentity) {
            await deleteUploadSessionBestEffort(client, session.upload_id);
            throw new Error(
              `El archivo cambió mientras se subía (${filePath}); reintente la llamada con el archivo estable. / File changed while uploading (${filePath}); retry the call with a stable file.`
            );
          }
          if (current.size < fileSize) {
            await deleteUploadSessionBestEffort(client, session.upload_id);
            throw new Error(
              `El archivo se truncó mientras se subía (${filePath}); reintente la llamada con el archivo estable. / File was truncated while uploading (${filePath}); retry the call with a stable file.`
            );
          }
          chunksSinceIdentityCheck = 0;
          lastIdentityCheckAt = Date.now();
        }
        const remaining: number = fileSize - offset;
        const nextSize: number = Math.min(chunkSize, remaining);

        const view: Buffer = scratch.subarray(0, nextSize);
        const read = await handle.read(view, 0, nextSize, offset);
        if (read.bytesRead <= 0) {
          break;
        }

        const chunk: Buffer =
          read.bytesRead === view.length ? view : view.subarray(0, read.bytesRead);

        const expectedOffset: number = offset;
        const nextOffset: number = await this.uploadChunkWithRetry(
          client,
          session.upload_id,
          expectedOffset,
          chunk,
          resolveChunkTimeoutMs(chunk.length, timeoutMs),
          signal,
        );
        assertNoForwardGap(nextOffset, expectedOffset, chunk.length);
        if (nextOffset === expectedOffset) {
          consecutiveNoAdvance += 1;
          if (consecutiveNoAdvance >= MAX_CONSECUTIVE_NO_ADVANCE) {
            await deleteUploadSessionBestEffort(client, session.upload_id);
            throw new Error(
              `El servidor rechazó el fragmento sin avanzar el offset (protocolo de subida inconsistente); reintente la llamada. / The server rejected the chunk without advancing the offset (inconsistent upload protocol); retry the call.`
            );
          }
        } else {
          consecutiveNoAdvance = 0;
        }
        offset = nextOffset;
        chunksSinceIdentityCheck += 1;
        progress.report(offset);
      }

      return offset;
    } finally {
      await handle.close();
    }
  }

  /**
   * Uploads a single chunk with retry and offset resync.
   *
   * @param client - EnriProxy client.
   * @param uploadId - Upload id.
   * @param offset - Expected offset.
   * @param chunk - Chunk bytes.
   * @param timeoutMs - Timeout in milliseconds.
   * @param signal - Optional cancellation signal.
   * @returns New offset (possibly resynced by the server on 409).
   * @throws Error with an Spanish-first bilingual message when the chunk is rejected or cancelled.
   */
  public async uploadChunkWithRetry(
    client: EnriProxyClient,
    uploadId: string,
    offset: number,
    chunk: Buffer,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    // 3 attempts per chunk (initial try plus 2 retries, mirrors EnriCode
    // `MAX_CHUNK_ATTEMPTS`): terminal statuses fail fast instead of burning
    // attempts and masking auth/quota as a generic failure.
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.throwIfCancelled(signal);
      try {
        return await client.appendUploadChunk({ uploadId, offset, chunk, timeoutMs, signal });
      } catch (error: unknown) {
        this.throwIfCancelled(signal);
        const message: string = error instanceof Error ? error.message : String(error);

        if (error instanceof EnriProxyHttpError) {
          // Offset mismatch: resync once and let the caller re-read at the
          // correct offset. A same-offset 409 means the server rejected the
          // bytes without advancing: fail fast instead of probing again
          // (a second immediate probe returns the same offset) or burning
          // all retry attempts.
          if (error.status === 409) {
            const actual: number = await withResumableRetry(
              () => client.getUploadOffset(uploadId, signal),
              signal,
            );
            if (actual !== offset) {
              if (!isProgressQuiet()) {
                console.error(`enrivision: offset resync (${offset} -> ${actual})`);
              }
              return actual;
            }
            throw new Error(
              `El servidor rechazó el fragmento sin avanzar el offset (protocolo de subida inconsistente); reintente la llamada. / The server rejected the chunk without advancing the offset (inconsistent upload protocol); retry the call.`
            );
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

        const retryAfterMs: number | null = retryAfterDelayMs(error);
        const backoffMs: number =
          retryAfterMs ?? Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        if (!isProgressQuiet()) {
          console.error(`enrivision: retry ${attempt}/${maxAttempts} after ${backoffMs}ms (${message})`);
        }
        await sleepAbortably(backoffMs, signal);
      }
    }

    throw new Error("La subida falló tras los reintentos. / Upload failed after retries.");
  }

  /**
   * Throws a Spanish cancellation error when the signal fired.
   *
   * @param signal - Optional cancellation signal.
   * @throws Error with an Spanish-first bilingual message when cancelled.
   */
  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
    }
  }
}

/**
 * Reports upload progress to stderr at most once per 10% step.
 *
 * @remarks
 * Shared by single-file and tar-set uploads so both planes log the same
 * `enrivision: upload NN%` lines (suppressible with `ENRIVISION_QUIET=1`).
 */
export class UploadProgressLogger {
  /**
   * Total bytes to send.
   */
  private readonly totalBytes: number;

  /**
   * Last reported 10% step (-1 before the first report).
   */
  private lastReportedStep: number = -1;

  /**
   * Creates one throttled progress logger.
   *
   * @param totalBytes - Total bytes to send.
   */
  public constructor(totalBytes: number) {
    this.totalBytes = totalBytes;
  }

  /**
   * Reports progress when a new 10% step (or completion) is reached.
   *
   * @param sentBytes - Bytes sent so far.
   */
  public report(sentBytes: number): void {
    if (this.totalBytes <= 0 || isProgressQuiet()) {
      return;
    }
    const step: number =
      sentBytes >= this.totalBytes ? 10 : Math.floor((sentBytes / this.totalBytes) * 10);
    if (step <= this.lastReportedStep) {
      return;
    }
    this.lastReportedStep = step;
    const progress: number = Math.floor((sentBytes / this.totalBytes) * 100);
    console.error(`enrivision: upload ${progress}% (${sentBytes}/${this.totalBytes} bytes)`);
  }
}

/**
 * Reports whether upload progress/retry logs are suppressed.
 *
 * @remarks
 * Scripted stdio hosts set `ENRIVISION_QUIET=1` to silence stderr progress
 * lines; transport framing always stays on stdout, so this only mutes noise.
 *
 * @returns True when `ENRIVISION_QUIET` is exactly `"1"`.
 */
export function isProgressQuiet(): boolean {
  return process.env["ENRIVISION_QUIET"] === "1";
}

/**
 * Reads a server-requested retry delay from an HTTP error.
 *
 * @remarks
 * Only 408 (timeout) and 429 (rate limit) honor `Retry-After`: other
 * statuses either fail fast (4xx) or use exponential backoff (5xx). The
 * delay accepts delta-seconds or an HTTP date, clamped to 0..30 s so a
 * hostile header can never stall the upload plane for hours.
 *
 * @param error - Error thrown by the failed attempt.
 * @returns Retry delay in milliseconds, or null when no retry delay applies.
 */
export function retryAfterDelayMs(error: unknown): number | null {
  if (!(error instanceof EnriProxyHttpError)) {
    return null;
  }
  if (error.status !== 408 && error.status !== 429) {
    return null;
  }
  const raw: string | string[] | undefined = findHeaderValue(error.headers, "retry-after");
  const first: string | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string" || !first.trim()) {
    return null;
  }
  const trimmed: string = first.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Math.min(30_000, Math.max(0, Number.parseInt(trimmed, 10) * 1000));
  }
  const at: number = Date.parse(trimmed);
  if (!Number.isFinite(at)) {
    return null;
  }
  return Math.min(30_000, Math.max(0, at - Date.now()));
}

/**
 * Runs one resumable-plane operation with bounded backoff.
 *
 * @remarks
 * Covers session creation and offset probes (single-shot before): up to 3
 * attempts with exponential backoff plus jitter. `408`/`429` are retried
 * honoring the server `Retry-After` header; other 4xx fail fast.
 * Cancellation always throws immediately; the last error is rethrown in
 * Spanish as received.
 *
 * @param operation - Thunk performing the HTTP operation.
 * @param signal - Optional cancellation signal.
 * @returns Operation result.
 * @throws Error from the last attempt when all attempts fail.
 */
export async function withResumableRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
    }
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (signal?.aborted) {
        throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
      }
      if (
        error instanceof EnriProxyHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        throw error;
      }
      if (attempt === maxAttempts) {
        break;
      }
      const retryAfterMs: number | null = retryAfterDelayMs(error);
      const backoffMs: number =
        retryAfterMs ??
        (Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.floor(Math.random() * 250));
      if (!isProgressQuiet()) {
        const message: string = error instanceof Error ? error.message : String(error);
        console.error(`enrivision: retry ${attempt}/${maxAttempts} after ${backoffMs}ms (${message})`);
      }
      await sleepAbortably(backoffMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Finds one HTTP error header value without regard to capitalization.
 *
 * @remarks
 * Servers send `Retry-After`, `retry-after`, or any other casing; checking
 * only two spellings drops the rest. Mirrors the case-insensitive lookup
 * used by the client (`getHeaderValue`).
 *
 * @param headers - Response headers.
 * @param name - Header name (any casing).
 * @returns Header value when present, otherwise undefined.
 */
function findHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const target: string = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

/**
 * Sleeps abortably for the given delay.
 *
 * @param delayMs - Delay in milliseconds.
 * @param signal - Optional cancellation signal.
 * @throws Error with an Spanish-first bilingual message when cancelled while sleeping.
 */
function sleepAbortably(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client."));
  }
  return new Promise<void>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Default chunk size when the server advertisement is missing or invalid.
 *
 * @remarks
 * Mirrors EnriCode `VisionAnalyzeMediaUploadCoordinator.DEFAULT_CHUNK_SIZE_BYTES`.
 */
export const DEFAULT_CHUNK_BYTES: number = 256 * 1024;

/**
 * Caps a server-advertised chunk size to the local 16 MiB ceiling.
 *
 * @remarks
 * A compromised proxy must never trick the client into a 1 GiB
 * `Buffer.allocUnsafe` (OOM); the cap keeps every allocation bounded.
 * Missing or invalid advertisements fall back to the 256 KiB default
 * (mirrors EnriCode): falling back to the 16 MiB ceiling instead would
 * force every misbehaving-proxy upload through maximum-size allocations.
 *
 * @param serverChunkSizeBytes - Chunk size advertised by the server.
 * @returns Effective chunk size in bytes (4 KiB..16 MiB, default 256 KiB).
 */
export function effectiveChunkSizeBytes(serverChunkSizeBytes: number): number {
  if (!Number.isFinite(serverChunkSizeBytes) || serverChunkSizeBytes <= 0) {
    return DEFAULT_CHUNK_BYTES;
  }
  return Math.min(ANALYZE_MEDIA_LIMITS.maxChunkBytes, Math.max(4096, Math.floor(serverChunkSizeBytes)));
}

/**
 * Derives the global upload deadline for a payload size.
 *
 * @remarks
 * Mirrors EnriCode `VisionAnalyzeMediaUploadCoordinator`: size-derived at
 * ~1 Mbps plus 60 s headroom, capped at 20 min, so a trickling connection
 * can never run for hours past every analysis budget.
 *
 * @param totalBytes - Total payload bytes.
 * @returns Deadline in milliseconds.
 */
export function resolveUploadDeadlineMs(totalBytes: number): number {
  const sized: number =
    Math.ceil(Math.max(0, totalBytes) / UPLOAD_DEADLINE_BYTES_PER_SECOND) * 1000
    + UPLOAD_DEADLINE_HEADROOM_MS;
  return Math.min(MAX_UPLOAD_DEADLINE_MS, sized);
}

/**
 * Describes a stable file identity for TOCTOU detection.
 *
 * @remarks
 * Size alone misses same-size replacements: inode, mtime, birthtime, and
 * link count join the identity, mirroring EnriCode `describeFileIdentity`.
 *
 * @param stats - File stats.
 * @returns Stable identity string (ino:size:mtime:birthtime:nlink).
 */
export function describeFileIdentity(stats: {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs?: number;
  readonly nlink?: number;
}): string {
  const birthtimeMs: number = typeof stats.birthtimeMs === "number" ? stats.birthtimeMs : 0;
  const nlink: number = typeof stats.nlink === "number" ? stats.nlink : 0;
  return `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}:${String(birthtimeMs)}:${String(nlink)}`;
}

/**
 * Deletes an upload session without ever throwing.
 *
 * @param client - EnriProxy client.
 * @param uploadId - Upload id to release.
 */
async function deleteUploadSessionBestEffort(
  client: EnriProxyClient,
  uploadId: string,
): Promise<void> {
  try {
    await client.deleteUploadSession(uploadId, AbortSignal.timeout(15_000));
  } catch {
    // Best-effort: the original deadline/identity error always wins.
  }
}

/**
 * Rejects a server offset that jumped past the bytes just sent.
 *
 * @remarks
 * A forward jump (`nextOffset > expectedOffset + sentBytes`) means the
 * server skipped bytes that were never sent: resuming there would ship a
 * file with a hole. Backward jumps are legitimate 409 resyncs handled by
 * the caller; only forward jumps fail here.
 *
 * @param nextOffset - Server-reported offset after the chunk.
 * @param expectedOffset - Offset the chunk was sent at.
 * @param sentBytes - Chunk length in bytes.
 * @throws Error with an Spanish-first bilingual message when the server skipped unsent bytes.
 */
export function assertNoForwardGap(nextOffset: number, expectedOffset: number, sentBytes: number): void {
  if (nextOffset > expectedOffset + sentBytes) {
    throw new Error(
      `El servidor reportó un offset adelantado (${String(nextOffset)} > ${String(expectedOffset + sentBytes)}); hay bytes sin enviar y la subida no puede continuar sin huecos. Reintente la llamada. / The server reported a forward-skipped offset (${String(nextOffset)} > ${String(expectedOffset + sentBytes)}); some bytes were never sent and the upload cannot continue without gaps. Retry the call.`
    );
  }
}

/**
 * Derives the per-upload scratch size, bounded by the actual file size.
 *
 * @remarks
 * Mirrors EnriCode `max(1, min(effectiveChunkSize, totalBytes))`: tiny files
 * must not pin the full 16 MiB ceiling per concurrent upload session.
 *
 * @param chunkSize - Negotiated chunk size in bytes.
 * @param fileSize - Total file size in bytes.
 * @returns Scratch size in bytes (always at least 1).
 */
export function resolveScratchSize(chunkSize: number, fileSize: number): number {
  return Math.max(1, Math.min(chunkSize, fileSize));
}

/**
 * Reports whether the periodic file-identity re-check is due.
 *
 * @remarks
 * Shared by the single-file and tar upload loops so both planes re-check on
 * the same cadence: every 16 chunks or every 5 s (mirrors EnriCode).
 *
 * @param chunksSinceCheck - Chunks uploaded since the last check.
 * @param nowMs - Current time in milliseconds.
 * @param lastCheckMs - Time of the last check in milliseconds.
 * @returns True when the identity re-check must run now.
 */
export function shouldRecheckIdentity(
  chunksSinceCheck: number,
  nowMs: number,
  lastCheckMs: number,
): boolean {
  return chunksSinceCheck >= IDENTITY_CHECK_EVERY_CHUNKS || nowMs - lastCheckMs >= IDENTITY_CHECK_EVERY_MS;
}

/**
 * Derives a per-chunk timeout from the chunk size and the call timeout.
 *
 * @remarks
 * Assumes ~125 KB/s worst case (mirrors EnriCode `CHUNK_TIMEOUT_BYTES_PER_SECOND`), clamped to
 * 30 s..300 s so one chunk can never hang the upload for hours (the old
 * fixed 30 min per chunk did). The operator budget caps the derived value
 * via `Math.min`, but the 30 s floor always wins: a tighter operator budget
 * must not force single-chunk budgets that fail on slow links where EnriCode
 * still uses the 30 s floor.
 *
 * @param chunkBytes - Chunk size in bytes.
 * @param callTimeoutMs - Configured call timeout in milliseconds.
 * @returns Effective chunk timeout in milliseconds (never below 30 s).
 */
export function resolveChunkTimeoutMs(chunkBytes: number, callTimeoutMs: number): number {
  const derived: number = Math.min(
    300000,
    Math.max(30000, Math.ceil(Math.max(1, chunkBytes) / 125000) * 1000),
  );
  if (Number.isFinite(callTimeoutMs) && callTimeoutMs > 0) {
    return Math.max(30000, Math.min(callTimeoutMs, derived));
  }
  return derived;
}
