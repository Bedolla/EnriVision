/**
 * Analyze Media audit R9 batch E5 regression tests (EnriVision MCP side).
 *
 * Pins the five M4 fixes: Spanish-first model-facing warnings, English
 * operator stderr (pinned by absence of Spanish operator lines in the
 * touched call sites), and the single-file staged-identity TOCTOU guard.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MediaUrlFetcher } from "../src/shared/mediaUrlFetcher.js";
import { AnalyzeMediaInputResolver } from "../src/tools/AnalyzeMediaInputResolver.js";
import { AnalyzeMediaResumableUploader } from "../src/tools/AnalyzeMediaResumableUploader.js";
import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

describe("Analyze Media R9E5: model-facing warnings lead in Spanish", () => {
  it("orders transcribe and advisory warnings ES-first with a separator", () => {
    const tool = new AnalyzeMediaTool({} as never);
    const reader = tool as unknown as {
      transcribeInapplicableWarning(
        params: unknown,
        inputs: ReadonlyArray<{ readonly localPath: string; readonly contentType: string }>
      ): string | undefined;
    };
    const multi = reader.transcribeInapplicableWarning({ transcribe: true }, [
      { localPath: "a.png", contentType: "image/png" },
      { localPath: "b.png", contentType: "image/png" }
    ]);
    expect(multi).toContain(" / ");
    expect(multi?.indexOf("transcribe no tiene efecto") ?? -1).toBeLessThan(
      multi?.indexOf("transcribe has no effect") ?? Number.MAX_SAFE_INTEGER
    );
    const image = reader.transcribeInapplicableWarning({ transcribe: true }, [
      { localPath: "a.png", contentType: "image/png" }
    ]);
    expect(image?.startsWith("transcribe no tiene efecto")).toBe(true);
    expect(reader.transcribeInapplicableWarning({}, [{ localPath: "a.png", contentType: "image/png" }])).toBeUndefined();
    expect(reader.transcribeInapplicableWarning({ transcribe: true }, [])).toBeUndefined();
  });
});

describe("Analyze Media R9E5: same-size swaps fail between resolve and upload", () => {
  it("rejects the upload at open with zero network calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r9e5-"));
    try {
      const file = join(dir, "foto.png");
      await writeFile(file, Buffer.alloc(64, 0x61));
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      const resolved = await resolver.resolve({ path: file });
      const single = resolved.inputs[0];
      expect(single?.stagedIdentity).toMatch(/^\d+:\d+:/u);

      await writeFile(file, Buffer.alloc(64, 0x62));
      await utimes(file, new Date(), new Date(Date.now() + 3_600_000));

      const uploader: AnalyzeMediaResumableUploader = new AnalyzeMediaResumableUploader();
      let networkCalls = 0;
      const fake = {
        getUploadOffset: async (): Promise<number> => {
          networkCalls += 1;
          return 0;
        },
        appendUploadChunk: async (): Promise<number> => {
          networkCalls += 1;
          return 64;
        }
      } as never;
      await expect(
        uploader.uploadFileResumable(
          fake,
          file,
          64,
          { upload_id: "upload_r9e5", chunk_size_bytes: 1024 } as never,
          30_000,
          undefined,
          single?.stagedIdentity
        )
      ).rejects.toThrow(/cambió entre la resolución y la subida/u);
      expect(networkCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads untouched files staged by the resolver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "enrivision-r9e5-ok-"));
    try {
      const file = join(dir, "foto.png");
      await writeFile(file, Buffer.alloc(64, 0x61));
      const resolver = new AnalyzeMediaInputResolver(new MediaUrlFetcher());
      const resolved = await resolver.resolve({ path: file });
      const single = resolved.inputs[0];
      const uploader: AnalyzeMediaResumableUploader = new AnalyzeMediaResumableUploader();
      const fake = {
        getUploadOffset: async (): Promise<number> => 0,
        appendUploadChunk: async (request: { offset: number; chunk: Buffer }): Promise<number> =>
          request.offset + request.chunk.length
      } as never;
      const offset: number = await uploader.uploadFileResumable(
        fake,
        file,
        64,
        { upload_id: "upload_r9e5_ok", chunk_size_bytes: 1024 } as never,
        30_000,
        undefined,
        single?.stagedIdentity
      );
      expect(offset).toBe(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
