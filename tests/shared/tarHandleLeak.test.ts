import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { FileHandle } from "node:fs/promises";

/**
 * Counters shared with the `node:fs/promises` mock below.
 */
interface HandleCounters {
  /**
   * Number of file handles opened.
   */
  opened: number;

  /**
   * Number of file handles closed.
   */
  closed: number;
}

/**
 * Returns the shared counters, creating them on first use.
 *
 * @returns Shared handle counters.
 */
function getCounters(): HandleCounters {
  const key = "__enrivisionTarHandleCounters";
  const holder = globalThis as Record<string, HandleCounters | undefined>;
  if (!holder[key]) {
    holder[key] = { opened: 0, closed: 0 };
  }
  return holder[key] as HandleCounters;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
      const handle: FileHandle = await actual.open(...args);
      const counters: HandleCounters = getCounters();
      counters.opened += 1;
      const originalClose = handle.close.bind(handle);
      handle.close = (async (): Promise<void> => {
        counters.closed += 1;
        await originalClose();
      }) as typeof handle.close;
      return handle;
    }) as typeof actual.open
  };
});

const { TarStream } = await import("../../src/shared/tar.js");
const { computeTarSizeBytes } = await import("../../src/shared/tar.js");
import type { TarEntry } from "../../src/shared/tar.js";

describe("TarStream file-handle hygiene", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("abandoning iteration mid-file closes the open handle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-tar-"));
    try {
      const fileA = join(dir, "a.bin");
      await writeFile(fileA, Buffer.alloc(4096, 0x61));
      const stA = await stat(fileA);
      const nowSeconds = Math.floor(Date.now() / 1000);

      const entries: TarEntry[] = [
        {
          name: "manifest.json",
          source: { type: "buffer", buffer: Buffer.from("{}", "utf8") },
          mtimeSeconds: nowSeconds
        },
        {
          name: "000001.bin",
          source: { type: "file", path: fileA, sizeBytes: stA.size },
          mtimeSeconds: nowSeconds
        }
      ];
      const tar = new TarStream(entries);
      expect(tar.getSizeBytes()).toBe(computeTarSizeBytes(entries));

      const counters: HandleCounters = getCounters();
      counters.opened = 0;
      counters.closed = 0;

      // Consume past the manifest (1024) + file header (512) so the
      // file-backed content handle is open, then abandon the iterator the
      // same way the offset-resync break does.
      let consumed = 0;
      for await (const chunk of tar.iterateChunks(0, 64)) {
        consumed += chunk.length;
        if (consumed > 2048) {
          break;
        }
      }
      expect(consumed).toBeGreaterThan(2048);
      expect(counters.opened).toBe(1);
      expect(counters.closed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
