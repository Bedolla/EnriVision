import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import { aliasValuesEqual } from "../src/tools/AnalyzeMediaAliasResolution.js";
import { AnalyzeMediaParamParser } from "../src/tools/AnalyzeMediaParamParser.js";
import { TOP_LEVEL_KNOWN_KEYS } from "../src/tools/AnalyzeMediaParamParser.js";

/**
 * Absolute fixture path for the current platform (no hardcoded Windows
 * paths: the release gate runs on Linux).
 *
 * @param name - File name.
 * @returns Absolute path.
 */
function abs(name: string): string {
  return join(tmpdir(), name);
}

describe("AnalyzeMedia R13: canonical unrecognized-parameter coaching", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = abs("r13.png");

  it("rejects unknown top-level keys with the real accepted list", () => {
    let message: string = "";
    try {
      parser.parseParams({ path: img, questoin: "q" });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Parámetro no reconocido: questoin. Parámetros aceptados: ");
    for (const key of TOP_LEVEL_KNOWN_KEYS) {
      expect(message).toContain(key);
    }
  });

  it("lists every unknown key when several arrive at once", () => {
    expect(() => parser.parseParams({ path: img, bogus_one: 1, bogus_two: 2 })).toThrow(
      /Parámetro no reconocido: bogus_one, bogus_two\. Parámetros aceptados: /u
    );
  });

  it("rejects unknown keys inside every nested section with the section list", () => {
    expect(() => parser.parseParams({ path: img, region: { x: 0, y: 0, width: 1, height: 1, z: 0 } })).toThrow(
      /Parámetro no reconocido dentro de 'region': z\. Parámetros aceptados \(region\): x, y, width, height\./u
    );
    expect(() => parser.parseParams({ path: img, audio: { timestampps: true } })).toThrow(
      /Parámetro no reconocido dentro de 'audio': timestampps/u
    );
  });
});

describe("AnalyzeMedia R13: strict enums (analysis_mode, delivery)", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = abs("r13.png");

  it("rejects present non-string and unknown-string selectors", () => {
    for (const bad of [5, true, {}, []]) {
      expect(() => parser.parseParams({ path: img, analysis_mode: bad })).toThrow(
        "analysis_mode debe ser uno de: auto|single|multipass"
      );
      expect(() => parser.parseParams({ path: img, delivery: bad })).toThrow(
        "delivery debe ser uno de: auto|analysis"
      );
    }
    expect(() => parser.parseParams({ path: img, analysis_mode: "turbo" })).toThrow(
      "analysis_mode debe ser uno de: auto|single|multipass"
    );
    expect(() => parser.parseParams({ path: img, delivery: "fast" })).toThrow(
      "delivery debe ser uno de: auto|analysis"
    );
  });

  it("treats null and blank strings as absent", () => {
    for (const absent of [null, "", "   "]) {
      const params = parser.parseParams({ path: img, analysis_mode: absent, delivery: absent });
      expect(params.analysisMode).toBeUndefined();
      expect(params.delivery).toBeUndefined();
    }
  });

  it("accepts the valid selectors and the camelCase alias", () => {
    expect(parser.parseParams({ path: img, analysis_mode: "single" }).analysisMode).toBe("single");
    expect(parser.parseParams({ path: img, analysisMode: "multipass" }).analysisMode).toBe("multipass");
    expect(parser.parseParams({ path: img, delivery: "auto" }).delivery).toBe("auto");
    expect(parser.parseParams({ path: img, delivery: "analysis" }).delivery).toBe("analysis");
  });

  it("mirrors the strict enums on the direct-client backstop (delivery included)", () => {
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ delivery: "turbo" } as never),
    ).toThrow("delivery debe ser uno de: auto|analysis");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ analysisMode: 5 } as never),
    ).toThrow("analysis_mode debe ser uno de: auto|single|multipass");
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ analysisMode: "auto", delivery: "analysis" } as never),
    ).not.toThrow();
    expect((): void =>
      EnriProxyClient.requirePreUploadTuning({ delivery: "" } as never),
    ).not.toThrow();
  });
});

describe("AnalyzeMedia R13: conflicting duplicate spellings are rejected", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = abs("r13.png");

  it("rejects top-level alias pairs carrying different values", () => {
    expect(() => parser.parseParams({ path: img, max_frames: 5, maxFrames: 8 })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro max_frames \(max_frames=5, maxFrames=8\)/u
    );
    expect(() => parser.parseParams({ path: img, analysis_mode: "single", analysisMode: "multipass" })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro analysis_mode/u
    );
    expect(() =>
      parser.parseParams({ path: img, transcription_language: "es", transcriptionLanguage: "en" })
    ).toThrow(/Se recibieron valores distintos para el mismo parámetro transcription_language/u);
  });

  it("rejects nested alias pairs and multi-alias families carrying different values", () => {
    expect(() => parser.parseParams({ path: img, video: { segment_seconds: 30, segmentSeconds: 60 } })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro video\.segment_seconds/u
    );
    expect(() => parser.parseParams({ path: img, document: { max_pages_total: 10, maxPages: 20 } })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro document\.max_pages_total/u
    );
    expect(() => parser.parseParams({ path: img, audio: { timestamps: true, audioTimestamps: false } })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro audio\.timestamps/u
    );
    expect(() => parser.parseParams({ paths: [img], images: { max_dimension: 512, maxDimension: 1024 } })).toThrow(
      /Se recibieron valores distintos para el mismo parámetro images\.max_dimension/u
    );
  });

  it("accepts equal duplicate spellings (numeric strings count as equal)", () => {
    const params = parser.parseParams({ path: img, max_frames: 8, maxFrames: "8" });
    expect(params.maxFrames).toBe(8);
    const doc = parser.parseParams({ path: abs("r13.pdf"), document: { max_pages: 10, maxPages: 10 } });
    expect(doc.document?.maxPagesTotal).toBe(10);
  });

  it("compares alias values tolerating numeric strings and trimming strings", () => {
    expect(aliasValuesEqual(60, "60")).toBe(true);
    expect(aliasValuesEqual("0.5", 0.5)).toBe(true);
    expect(aliasValuesEqual(" es ", "es")).toBe(true);
    expect(aliasValuesEqual(30, 60)).toBe(false);
    expect(aliasValuesEqual("es", "en")).toBe(false);
    expect(aliasValuesEqual(true, "true")).toBe(false);
  });
});

describe("AnalyzeMedia R13: flat-over-nested differences warn instead of dropping", () => {
  const parser = new AnalyzeMediaParamParser();
  const img: string = abs("r13.png");

  it("applies the flat value and records an honesty warning", () => {
    const params = parser.parseParams({
      path: abs("r13.mp4"),
      segmentSeconds: 60,
      video: { segment_seconds: 30 },
    });
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.warnings?.some((warning: string): boolean => warning.includes("gana el plano"))).toBe(true);
  });

  it("warns on the document flat pair too", () => {
    const params = parser.parseParams({
      path: abs("r13.pdf"),
      documentMaxPages: 50,
      document: { max_pages_total: 20 },
    });
    expect(params.document?.maxPagesTotal).toBe(50);
    expect(
      params.warnings?.some((warning: string): boolean => warning.includes("document.max_pages_total")),
    ).toBe(true);
  });

  it("does not warn when both levels agree numerically", () => {
    const params = parser.parseParams({
      path: abs("r13.mp4"),
      segmentSeconds: 60,
      video: { segment_seconds: "60" },
    });
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.warnings).toBeUndefined();
  });
});

describe("AnalyzeMedia R13: blank paths entries", () => {
  const parser = new AnalyzeMediaParamParser();

  it("discards blank entries and keeps the valid ones", () => {
    const img: string = abs("r13-b.png");
    const params = parser.parseParams({ paths: ["   ", img, ""] });
    expect(params.paths).toEqual([img]);
  });

  it("fails with the path-required coaching when every entry is blank", () => {
    expect(() => parser.parseParams({ paths: ["", "   "] })).toThrow(/Proporcione 'path' o 'paths'/u);
  });
});
