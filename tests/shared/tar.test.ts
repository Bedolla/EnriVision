import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeTarSizeBytes, TarStream, type TarEntry } from "../../src/shared/tar.js";

function parseTarHeader(block: Buffer): { name: string; size: number } {
  const nameRaw = block.subarray(0, 100).toString("utf8");
  const nullIndex = nameRaw.indexOf("\u0000");
  const name = (nullIndex >= 0 ? nameRaw.slice(0, nullIndex) : nameRaw).trim();

  const sizeRaw = block.subarray(124, 136).toString("utf8");
  const sizeText = sizeRaw.replace(/\u0000/g, "").trim();
  const size = sizeText ? Number.parseInt(sizeText, 8) : 0;

  return { name, size: Number.isFinite(size) && size >= 0 ? size : 0 };
}

describe("tar helpers", () => {
  test("builds deterministic tar bytes and supports resume offsets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-tar-"));
    try {
      const fileA = join(dir, "a.bin");
      const fileB = join(dir, "b.bin");

      const bytesA = Buffer.from("hello world", "utf8");
      const bytesB = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

      await writeFile(fileA, bytesA);
      await writeFile(fileB, bytesB);

      const stA = await stat(fileA);
      const stB = await stat(fileB);

      const manifestBuffer = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      const nowSeconds = Math.floor(Date.now() / 1000);

      const entries: TarEntry[] = [
        { name: "manifest.json", source: { type: "buffer", buffer: manifestBuffer }, mtimeSeconds: nowSeconds },
        { name: "000001.bin", source: { type: "file", path: fileA, sizeBytes: stA.size }, mtimeSeconds: nowSeconds },
        { name: "000002.bin", source: { type: "file", path: fileB, sizeBytes: stB.size }, mtimeSeconds: nowSeconds }
      ];

      const expectedSize = computeTarSizeBytes(entries);
      const tar = new TarStream(entries);
      expect(tar.getSizeBytes()).toBe(expectedSize);

      const fullParts: Buffer[] = [];
      for await (const chunk of tar.iterateChunks(0, 128)) {
        fullParts.push(chunk);
      }

      const full = Buffer.concat(fullParts);
      expect(full.length).toBe(expectedSize);

      const header0 = parseTarHeader(full.subarray(0, 512));
      expect(header0.name).toBe("manifest.json");
      expect(header0.size).toBe(manifestBuffer.length);

      const tail = full.subarray(full.length - 1024);
      expect(tail.every((b) => b === 0)).toBe(true);

      const manifestPadded = Math.ceil(manifestBuffer.length / 512) * 512;
      const fileAHeaderStart = 512 + manifestPadded;
      const fileAContentStart = fileAHeaderStart + 512;
      const resumeOffset = fileAContentStart + 10;
      const resumeParts: Buffer[] = [];
      for await (const chunk of tar.iterateChunks(resumeOffset, 64)) {
        resumeParts.push(chunk);
      }
      const resumed = Buffer.concat(resumeParts);
      expect(resumed).toEqual(full.subarray(resumeOffset));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
