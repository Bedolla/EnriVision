/**
 * TAR UTILITIES
 *
 * Small, dependency-free tar (ustar) helpers used to package multiple local
 * files into a single resumable upload stream.
 *
 * @module shared/tar
 */

import { open } from "node:fs/promises";

/**
 * Source for a tar entry.
 */
export type TarEntrySource =
  | {
      /**
       * Inline buffer payload.
       */
      readonly type: "buffer";

      /**
       * Buffer content.
       */
      readonly buffer: Buffer;
    }
  | {
      /**
       * File-backed payload.
       */
      readonly type: "file";

      /**
       * Absolute file path.
       */
      readonly path: string;

      /**
       * File size in bytes.
       */
      readonly sizeBytes: number;
    };

/**
 * Tar entry description.
 */
export interface TarEntry {
  /**
   * Tar entry name (ustar limit: 100 bytes for the simple header form).
   */
  readonly name: string;

  /**
   * Entry payload source.
   */
  readonly source: TarEntrySource;

  /**
   * Unix mtime seconds used in the header.
   */
  readonly mtimeSeconds: number;
}

/**
 * Layout element computed for a tar entry.
 */
interface TarLayoutEntry {
  /**
   * Entry name.
   */
  readonly name: string;

  /**
   * Header bytes.
   */
  readonly header: Buffer;

  /**
   * Content source.
   */
  readonly source: TarEntrySource;

  /**
   * Start offset of the header in the tar stream.
   */
  readonly headerStart: number;

  /**
   * Start offset of the content in the tar stream.
   */
  readonly contentStart: number;

  /**
   * Content size in bytes.
   */
  readonly contentSize: number;

  /**
   * Padding size (0..511).
   */
  readonly paddingSize: number;

  /**
   * Total bytes for header + content + padding.
   */
  readonly totalSize: number;
}

/**
 * Computes the total tar size in bytes, including the 1024-byte end marker.
 *
 * @param entries - Tar entries
 * @returns Total tar size in bytes
 */
export function computeTarSizeBytes(entries: ReadonlyArray<TarEntry>): number {
  let total = 0;
  for (const entry of entries) {
    total += 512;
    const contentSize =
      entry.source.type === "buffer" ? entry.source.buffer.length : entry.source.sizeBytes;
    total += contentSize;
    total += computePaddingSize(contentSize);
  }
  // Two 512-byte zero blocks.
  total += 1024;
  return total;
}

/**
 * Streaming tar generator that can start from an arbitrary byte offset.
 */
export class TarStream {
  /**
   * Precomputed tar layout.
   */
  private readonly layout: TarLayoutEntry[];

  /**
   * Total tar size.
   */
  private readonly totalSizeBytes: number;

  /**
   * Creates a new {@link TarStream}.
   *
   * @param entries - Tar entries in order
   */
  public constructor(entries: ReadonlyArray<TarEntry>) {
    const normalized: TarLayoutEntry[] = [];
    let cursor = 0;

    for (const entry of entries) {
      const name = entry.name;
      if (!isSafeTarName(name)) {
        throw new Error(`Invalid tar entry name: ${name}`);
      }

      const contentSize =
        entry.source.type === "buffer" ? entry.source.buffer.length : entry.source.sizeBytes;

      const header = buildUstarHeader(name, contentSize, entry.mtimeSeconds);
      const paddingSize = computePaddingSize(contentSize);
      const totalSize = 512 + contentSize + paddingSize;

      normalized.push({
        name,
        header,
        source: entry.source,
        headerStart: cursor,
        contentStart: cursor + 512,
        contentSize,
        paddingSize,
        totalSize
      });

      cursor += totalSize;
    }

    this.layout = normalized;
    this.totalSizeBytes = cursor + 1024;
  }

  /**
   * Returns the total tar size in bytes.
   *
   * @returns Total size
   */
  public getSizeBytes(): number {
    return this.totalSizeBytes;
  }

  /**
   * Iterates tar bytes as chunks, starting from a given offset.
   *
   * @param startOffset - Starting byte offset (for resumable uploads)
   * @param chunkSize - Maximum bytes per yielded chunk
   * @returns Async iterator of buffers
   */
  public async *iterateChunks(
    startOffset: number,
    chunkSize: number
  ): AsyncGenerator<Buffer, void, void> {
    const normalizedStart = Math.max(0, Math.floor(startOffset));
    const normalizedChunk = Math.max(1, Math.floor(chunkSize));

    if (normalizedStart >= this.totalSizeBytes) {
      return;
    }

    let position = normalizedStart;

    const state = this.seek(position);

    while (position < this.totalSizeBytes) {
      const remainingTar = this.totalSizeBytes - position;
      const desired = Math.min(normalizedChunk, remainingTar);

      const parts: Buffer[] = [];
      let remaining = desired;
      let emptyReadsInARow = 0;

      while (remaining > 0) {
        const read = await this.readNext(state, remaining);
        if (read.length <= 0) {
          emptyReadsInARow += 1;
          if (emptyReadsInARow > 50) {
            break;
          }
          continue;
        }
        emptyReadsInARow = 0;
        parts.push(read);
        remaining -= read.length;
        position += read.length;
      }

      if (parts.length === 0) {
        break;
      }

      yield parts.length === 1 ? parts[0] : Buffer.concat(parts);
    }
  }

  /**
   * Internal seek state for reading.
   */
  private seek(offset: number): {
    phase: "entry_header" | "entry_content" | "entry_padding" | "eof";
    entryIndex: number;
    phaseOffset: number;
    fileHandle: Awaited<ReturnType<typeof open>> | null;
  } {
    let cursor = 0;
    for (let i = 0; i < this.layout.length; i++) {
      const entry = this.layout[i]!;
      const next = cursor + entry.totalSize;
      if (offset < next) {
        const rel = offset - cursor;
        if (rel < 512) {
          return { phase: "entry_header", entryIndex: i, phaseOffset: rel, fileHandle: null };
        }
        const relContent = rel - 512;
        if (relContent < entry.contentSize) {
          return { phase: "entry_content", entryIndex: i, phaseOffset: relContent, fileHandle: null };
        }
        const relPadding = relContent - entry.contentSize;
        return { phase: "entry_padding", entryIndex: i, phaseOffset: relPadding, fileHandle: null };
      }
      cursor = next;
    }

    const eofStart = cursor;
    const eofOffset = offset - eofStart;
    return { phase: "eof", entryIndex: this.layout.length, phaseOffset: eofOffset, fileHandle: null };
  }

  /**
   * Reads up to maxBytes from the current state and advances the state.
   */
  private async readNext(
    state: {
      phase: "entry_header" | "entry_content" | "entry_padding" | "eof";
      entryIndex: number;
      phaseOffset: number;
      fileHandle: Awaited<ReturnType<typeof open>> | null;
    },
    maxBytes: number
  ): Promise<Buffer> {
    const want = Math.max(1, Math.floor(maxBytes));

    if (state.phase === "eof") {
      const remaining = Math.max(0, 1024 - state.phaseOffset);
      if (remaining <= 0) {
        return Buffer.alloc(0);
      }
      const take = Math.min(want, remaining);
      state.phaseOffset += take;
      return Buffer.alloc(take, 0);
    }

    const entry = this.layout[state.entryIndex]!;

    if (state.phase === "entry_header") {
      const remaining = Math.max(0, 512 - state.phaseOffset);
      const take = Math.min(want, remaining);
      const out = entry.header.subarray(state.phaseOffset, state.phaseOffset + take);
      state.phaseOffset += take;
      if (state.phaseOffset >= 512) {
        state.phase = "entry_content";
        state.phaseOffset = 0;
      }
      return out;
    }

    if (state.phase === "entry_content") {
      const remaining = Math.max(0, entry.contentSize - state.phaseOffset);
      if (remaining <= 0) {
        state.phase = "entry_padding";
        state.phaseOffset = 0;
        await this.closeFileHandle(state);
        return Buffer.alloc(0);
      }
      const take = Math.min(want, remaining);

      if (entry.source.type === "buffer") {
        const buf = entry.source.buffer.subarray(state.phaseOffset, state.phaseOffset + take);
        state.phaseOffset += take;
        if (state.phaseOffset >= entry.contentSize) {
          state.phase = "entry_padding";
          state.phaseOffset = 0;
        }
        return buf;
      }

      const handle = await this.ensureFileHandle(state, entry.source.path);
      const buffer = Buffer.allocUnsafe(take);
      const read = await handle.read(buffer, 0, take, state.phaseOffset);
      if (read.bytesRead <= 0) {
        await this.closeFileHandle(state);
        state.phase = "entry_padding";
        state.phaseOffset = 0;
        return Buffer.alloc(0);
      }

      state.phaseOffset += read.bytesRead;
      const out = read.bytesRead === buffer.length ? buffer : buffer.subarray(0, read.bytesRead);
      if (state.phaseOffset >= entry.contentSize) {
        await this.closeFileHandle(state);
        state.phase = "entry_padding";
        state.phaseOffset = 0;
      }
      return out;
    }

    // entry_padding
    const remaining = Math.max(0, entry.paddingSize - state.phaseOffset);
    if (remaining <= 0) {
      state.entryIndex += 1;
      state.phaseOffset = 0;
      state.fileHandle = null;
      if (state.entryIndex >= this.layout.length) {
        state.phase = "eof";
      } else {
        state.phase = "entry_header";
      }
      return Buffer.alloc(0);
    }

    const take = Math.min(want, remaining);
    state.phaseOffset += take;
    if (state.phaseOffset >= entry.paddingSize) {
      state.entryIndex += 1;
      state.phaseOffset = 0;
      state.fileHandle = null;
      if (state.entryIndex >= this.layout.length) {
        state.phase = "eof";
      } else {
        state.phase = "entry_header";
      }
    }
    return Buffer.alloc(take, 0);
  }

  /**
   * Ensures a file handle is open for the current file-backed entry.
   */
  private async ensureFileHandle(
    state: { fileHandle: Awaited<ReturnType<typeof open>> | null },
    filePath: string
  ): Promise<Awaited<ReturnType<typeof open>>> {
    if (state.fileHandle) {
      return state.fileHandle;
    }
    state.fileHandle = await open(filePath, "r");
    return state.fileHandle;
  }

  /**
   * Closes any open file handle for the current state.
   */
  private async closeFileHandle(state: { fileHandle: Awaited<ReturnType<typeof open>> | null }): Promise<void> {
    if (!state.fileHandle) {
      return;
    }
    try {
      await state.fileHandle.close();
    } finally {
      state.fileHandle = null;
    }
  }
}

/**
 * Computes tar padding size for a payload length.
 */
function computePaddingSize(sizeBytes: number): number {
  const mod = sizeBytes % 512;
  return mod === 0 ? 0 : 512 - mod;
}

/**
 * Validates that a name is safe for a simple ustar header.
 */
function isSafeTarName(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("\u0000")) {
    return false;
  }
  // Keep it simple: only basenames, no directories.
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes(":")) {
    return false;
  }
  const bytes = Buffer.byteLength(normalized, "utf8");
  return bytes > 0 && bytes <= 100 && /^[A-Za-z0-9._-]{1,100}$/.test(normalized);
}

/**
 * Builds a ustar header block for a regular file.
 */
function buildUstarHeader(name: string, sizeBytes: number, mtimeSeconds: number): Buffer {
  const buf = Buffer.alloc(512, 0);

  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, sizeBytes);
  writeOctal(buf, 136, 12, Math.max(0, Math.floor(mtimeSeconds)));

  // Checksum field: 8 bytes, initially filled with spaces.
  buf.fill(0x20, 148, 156);

  // Typeflag '0' (regular file).
  buf[156] = 0x30;

  // UStar magic + version.
  writeString(buf, 257, 6, "ustar\0");
  writeString(buf, 263, 2, "00");

  const checksum = computeTarChecksum(buf);
  writeChecksum(buf, checksum);

  return buf;
}

/**
 * Writes a fixed-width string field (null-padded).
 */
function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

/**
 * Writes a fixed-width octal number field.
 */
function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const raw = Math.max(0, Math.floor(value));
  const oct = raw.toString(8);
  const padded = oct.padStart(Math.max(0, length - 1), "0");
  const field = `${padded}\0`;
  writeString(buf, offset, length, field);
}

/**
 * Computes tar header checksum.
 */
function computeTarChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] ?? 0;
  }
  return sum;
}

/**
 * Writes tar checksum field (6 octal digits + null + space).
 */
function writeChecksum(buf: Buffer, checksum: number): void {
  const oct = Math.max(0, Math.floor(checksum)).toString(8).padStart(6, "0");
  writeString(buf, 148, 6, oct);
  buf[154] = 0;
  buf[155] = 0x20;
}
