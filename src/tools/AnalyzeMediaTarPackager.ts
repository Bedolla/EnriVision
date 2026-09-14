/**
 * ANALYZE MEDIA TAR PACKAGER
 *
 * Packages multiple local images into a single EnriVision media-set tar
 * archive and uploads it through a resumable EnriProxy session. A single
 * archive avoids creating many concurrent upload sessions (capped per API
 * key) and enables server-side batching plus reduce for large screenshot
 * sets.
 *
 * @module tools/AnalyzeMediaTarPackager
 */

import { extname } from "node:path";
import { stat } from "node:fs/promises";

import type { EnriProxyClient } from "../client/EnriProxyClient.js";
import { computeTarSizeBytes, TarStream, type TarEntry } from "../shared/tar.js";
import { ANALYZE_MEDIA_LIMITS } from "./AnalyzeMediaContract.js";
import type { ResolvedMediaInput } from "./AnalyzeMediaInputResolver.js";
import {
  assertNoForwardGap,
  describeFileIdentity,
  effectiveChunkSizeBytes,
  MAX_CONSECUTIVE_NO_ADVANCE,
  resolveChunkTimeoutMs,
  resolveUploadDeadlineMs,
  shouldRecheckIdentity,
  UploadProgressLogger,
  withResumableRetry,
  type AnalyzeMediaResumableUploader,
} from "./AnalyzeMediaResumableUploader.js";

/**
 * Content type for EnriVision media-set archives (tar, no compression).
 */
const ENRIVISION_MEDIA_SET_TAR_CONTENT_TYPE = "application/vnd.enrivision.media-set+tar";

/**
 * Fixed manifest entry name inside EnriVision media-set tar archives.
 */
const ENRIVISION_MEDIA_SET_TAR_MANIFEST_NAME = "manifest.json";

/**
 * One image staged for the media-set tar archive.
 */
interface StagedMediaSetFile {
  /**
   * 1-based item index.
   */
  readonly index: number;

  /**
   * Original upload file name.
   */
  readonly filename: string;

  /**
   * Local file path.
   */
  readonly path: string;

  /**
   * File size in bytes.
   */
  readonly sizeBytes: number;

  /**
   * Effective content type.
   */
  readonly contentType: string;

  /**
   * Tar entry name (`00000N` + last extension).
   *
   * @remarks
   * Opaque by design: only the manifest `filename` + `content_type` carry
   * identity, so multi-extension sources (`foto.tar.gz` -> `00000N.gz`)
   * stay harmless while debugging reads the manifest, not the entry name.
   */
  readonly entryName: string;
}

/**
 * Packages and uploads multi-image sets as one media-set tar archive.
 */
export class AnalyzeMediaTarPackager {
  /**
   * Chunk uploader used for the tar byte stream.
   */
  private readonly uploader: AnalyzeMediaResumableUploader;

  /**
   * Creates a new {@link AnalyzeMediaTarPackager}.
   *
   * @param uploader - Resumable chunk uploader.
   */
  public constructor(uploader: AnalyzeMediaResumableUploader) {
    this.uploader = uploader;
  }

  /**
   * Uploads multiple local images as a single media-set tar archive.
   *
   * @param client - EnriProxy client.
   * @param inputs - Resolved media inputs (URLs already materialized).
   * @param timeoutMs - Request timeout per HTTP request.
   * @param clientTraceId - Client trace id for correlation.
   * @param signal - Optional cancellation signal.
   * @returns Upload id for the created tar session.
   * @throws Error with an Spanish-first bilingual message when inputs are not images or the upload stalls.
   */
  public async uploadImageSetAsMediaSetTar(
    client: EnriProxyClient,
    inputs: readonly ResolvedMediaInput[],
    timeoutMs: number,
    clientTraceId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (inputs.length < 2) {
      throw new Error("Se requieren al menos 2 archivos de imagen para el tar de conjunto. / At least 2 image files are required for the set tar.");
    }

    // Snapshot full file identity at stage time (ino:size:mtime:birthtime:nlink):
    // a concurrent writer that truncates, grows, or same-size-replaces a file
    // mid-upload must fail loudly instead of shipping zero-filled entries.
    const stagedIdentities = new Map<string, string>();
    for (const input of inputs) {
      const current = await stat(input.localPath);
      if (current.size !== input.sizeBytes) {
        throw new Error(
          `El archivo cambió antes de la subida (${input.localPath}); reintente la llamada. / File changed before upload (${input.localPath}); retry the call.`
        );
      }
      // Same-size swaps ship wrong bytes silently without this gate
      // (mirrors the single-file upload identity check).
      if (input.stagedIdentity !== undefined && describeFileIdentity(current) !== input.stagedIdentity) {
        throw new Error(
          `El archivo cambió antes de la subida (${input.localPath}); reintente la llamada. / File changed before upload (${input.localPath}); retry the call.`
        );
      }
      stagedIdentities.set(input.localPath, describeFileIdentity(current));
    }

    const files: StagedMediaSetFile[] = inputs.map((input, position) => {
      if (!input.contentType.toLowerCase().startsWith("image/")) {
        throw new Error(
          `paths debe contener sólo archivos de imagen. No es imagen: ${input.localPath} (${input.contentType}) / paths must contain only image files. Not an image: ${input.localPath} (${input.contentType}).`,
        );
      }
      const extRaw: string = extname(input.filename).toLowerCase();
      const ext: string = extRaw && /^[a-z0-9.]+$/.test(extRaw) ? extRaw : ".img";
      return {
        index: position + 1,
        filename: input.filename,
        path: input.localPath,
        sizeBytes: input.sizeBytes,
        contentType: input.contentType,
        entryName: `${String(position + 1).padStart(6, "0")}${ext}`,
      };
    });

    const manifest = {
      type: "enrivision_media_set",
      version: 1,
      media_type: "image_set",
      items: files.map((file) => ({
        index: file.index,
        name: file.entryName,
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
      })),
    };

    const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
    const nowSeconds: number = Math.floor(Date.now() / 1000);

    const entries: TarEntry[] = [
      {
        name: ENRIVISION_MEDIA_SET_TAR_MANIFEST_NAME,
        source: { type: "buffer", buffer: manifestBuffer },
        mtimeSeconds: nowSeconds,
      },
      ...files.map(
        (file): TarEntry => ({
          name: file.entryName,
          source: {
            type: "file",
            path: file.path,
            sizeBytes: file.sizeBytes,
            expectedIdentity: stagedIdentities.get(file.path),
          },
          mtimeSeconds: nowSeconds,
        }),
      ),
    ];

    const tarSizeBytes: number = computeTarSizeBytes(entries);
    if (tarSizeBytes > ANALYZE_MEDIA_LIMITS.maxUploadBytes) {
      throw new Error(
        `El conjunto de imágenes excede el límite de subida de 4 GiB (${String(tarSizeBytes)} bytes); divida el conjunto en varias llamadas. / Image set exceeds the 4 GiB upload limit (${String(tarSizeBytes)} bytes); split the set into several calls.`
      );
    }
    const tar = new TarStream(entries, { describeIdentity: describeFileIdentity });
    if (tar.getSizeBytes() !== tarSizeBytes) {
      throw new Error("Error interno: discrepancia en el tamaño del tar. / Internal error: tar size mismatch.");
    }

    const session = await withResumableRetry(
      () =>
        client.createUploadSession({
          filename: "enrivision-image-set.tar",
          sizeBytes: tarSizeBytes,
          contentType: ENRIVISION_MEDIA_SET_TAR_CONTENT_TYPE,
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
    if (serverMaxBytes !== null && tarSizeBytes > serverMaxBytes) {
      try {
        await client.deleteUploadSession(session.upload_id, AbortSignal.timeout(15_000));
      } catch {
        // Best-effort: the size error always wins.
      }
      throw new Error(
        `El conjunto excede el tamaño máximo del servidor (${String(serverMaxBytes)} bytes); divida el conjunto en varias llamadas. / Set exceeds the server maximum size (${String(serverMaxBytes)} bytes); split the set into several calls.`
      );
    }

    const chunkSize: number = effectiveChunkSizeBytes(session.chunk_size_bytes);
    let offset: number = await withResumableRetry(
      () => client.getUploadOffset(session.upload_id, signal),
      signal,
    );
    if (!Number.isFinite(offset) || offset < 0 || offset > tarSizeBytes) {
      throw new Error(`Offset del servidor inválido para la subida del tar: ${offset} / Invalid server offset for the tar upload: ${offset}.`);
    }

    const uploadStartedAt: number = Date.now();
    const uploadDeadlineMs: number = resolveUploadDeadlineMs(tarSizeBytes);
    let chunksSinceIdentityCheck: number = 0;
    let lastIdentityCheckAt: number = 0;
    // Consecutive outer iterations that uploaded bytes without advancing the
    // server offset (2xx same-offset responses): the third one fails fast
    // with the inconsistent-protocol error instead of spinning to the
    // 20 min deadline (mirrors the single-file same-offset 409 guard).
    let consecutiveNoAdvance: number = 0;
    const progress = new UploadProgressLogger(tarSizeBytes);
    while (offset < tarSizeBytes) {
      if (signal?.aborted) {
        throw new Error("La solicitud fue cancelada por el cliente. / Request cancelled by the client.");
      }
      if (Date.now() - uploadStartedAt > uploadDeadlineMs) {
        try {
          await client.deleteUploadSession(session.upload_id, AbortSignal.timeout(15_000));
        } catch {
          // Best-effort: the deadline error always wins.
        }
        throw new Error(
          `La subida excedió el tiempo máximo (${String(Math.round(uploadDeadlineMs / 1000))} s para ${String(tarSizeBytes)} bytes); reintente con menos imágenes o una conexión más rápida. / Upload exceeded the maximum time (${String(Math.round(uploadDeadlineMs / 1000))} s for ${String(tarSizeBytes)} bytes); retry with fewer images or a faster connection.`
        );
      }
      // Same cadence as the single-file path (every 16 chunks or 5 s, mirrors
      // EnriCode): the tar loop previously only had the 5 s timer, so fast
      // links could stream 256 MiB unchecked between checks.
      if (shouldRecheckIdentity(chunksSinceIdentityCheck, Date.now(), lastIdentityCheckAt)) {
        for (const input of inputs) {
          const current = await stat(input.localPath);
          const expected: string | undefined = stagedIdentities.get(input.localPath);
          if (typeof expected === "string" && describeFileIdentity(current) !== expected) {
            try {
              await client.deleteUploadSession(session.upload_id, AbortSignal.timeout(15_000));
            } catch {
              // Best-effort: the identity error always wins.
            }
            throw new Error(
              `El archivo cambió mientras se subía (${input.localPath}); reintente la llamada con archivos estables. / File changed while uploading (${input.localPath}); retry the call with stable files.`
            );
          }
        }
        chunksSinceIdentityCheck = 0;
        lastIdentityCheckAt = Date.now();
      }
      let madeProgress = false;

      // Breaking out of this loop on offset resync is safe: TarStream
      // releases its file handle in a generator finally block.
      for await (const chunk of tar.iterateChunks(offset, chunkSize)) {
        if (chunk.length === 0) {
          continue;
        }

        const expectedOffset: number = offset;
        const nextOffset: number = await this.uploader.uploadChunkWithRetry(
          client,
          session.upload_id,
          expectedOffset,
          chunk,
          resolveChunkTimeoutMs(chunk.length, timeoutMs),
          signal,
        );

        // A forward jump skips bytes that were never sent (a hole in the
        // tar): fail fast instead of resyncing past them.
        assertNoForwardGap(nextOffset, expectedOffset, chunk.length);
        offset = nextOffset;
        madeProgress = true;
        chunksSinceIdentityCheck += 1;
        progress.report(offset);

        // Offset resync: restart generation from the server-provided offset.
        if (offset !== expectedOffset + chunk.length) {
          if (offset === expectedOffset) {
            consecutiveNoAdvance += 1;
            if (consecutiveNoAdvance >= MAX_CONSECUTIVE_NO_ADVANCE) {
              try {
                await client.deleteUploadSession(session.upload_id, AbortSignal.timeout(15_000));
              } catch {
                // Best-effort: the stuck-offset error always wins.
              }
              throw new Error(
                `El servidor rechazó el fragmento sin avanzar el offset (protocolo de subida inconsistente); reintente la llamada. / The server rejected the chunk without advancing the offset (inconsistent upload protocol); retry the call.`
              );
            }
          } else {
            consecutiveNoAdvance = 0;
          }
          break;
        }
        consecutiveNoAdvance = 0;

        if (offset >= tarSizeBytes) {
          break;
        }
      }

      if (!madeProgress) {
        throw new Error("Subida estancada: no hubo progreso al enviar los fragmentos del tar. / Stalled upload: no progress sending the tar chunks.");
      }
    }

    if (offset !== tarSizeBytes) {
      throw new Error(`Subida incompleta: se enviaron ${offset} de ${tarSizeBytes} bytes. / Incomplete upload: sent ${offset} of ${tarSizeBytes} bytes.`);
    }

    return session.upload_id;
  }
}

