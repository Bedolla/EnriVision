import { describe, expect, it } from "vitest";

import { AnalyzeMediaTool } from "../src/tools/AnalyzeMediaTool.js";

describe("AnalyzeMediaTool.parseParams", () => {
  it("rejects non-absolute paths", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    expect(() => tool.parseParams({ path: "relative.mp4" })).toThrow(/absolute/i);
  });

  it("maps snake_case fields to params", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({
      path: "C:\\Users\\User\\Downloads\\clip.mp4",
      context: "video",
      question: "What is happening?",
      language: "es",
      max_frames: "7",
      transcribe: false,
      transcription_language: "auto",
      analysis_mode: "multipass",
      video: {
        clip_start_seconds: "12.5",
        clip_duration_seconds: "30",
        segment_seconds: "60",
        max_segments: "100",
        max_frames_per_segment: "8"
      },
      document: {
        max_pages_total: "500",
        pages_per_batch: "25",
        max_images_per_batch: "6",
        scanned_text_threshold_chars: "40"
      },
      audio: {
        timestamps: true,
        segment_seconds: "15",
        max_segments: "10"
      }
    });

    expect(params.path).toContain("clip.mp4");
    expect(params.context).toBe("video");
    expect(params.question).toBe("What is happening?");
    expect(params.language).toBe("es");
    expect(params.maxFrames).toBe(7);
    expect(params.transcribe).toBe(false);
    expect(params.transcriptionLanguage).toBe("auto");
    expect(params.analysisMode).toBe("multipass");
    expect(params.video?.clipStartSeconds).toBe(12.5);
    expect(params.video?.clipDurationSeconds).toBe(30);
    expect(params.video?.segmentSeconds).toBe(60);
    expect(params.video?.maxSegments).toBe(100);
    expect(params.video?.maxFramesPerSegment).toBe(8);
    expect(params.document?.maxPagesTotal).toBe(500);
    expect(params.document?.pagesPerBatch).toBe(25);
    expect(params.document?.maxImagesPerBatch).toBe(6);
    expect(params.document?.scannedTextThresholdChars).toBe(40);
    expect(params.audio?.timestamps).toBe(true);
    expect(params.audio?.segmentSeconds).toBe(15);
    expect(params.audio?.maxSegments).toBe(10);
  });

  it("rejects invalid analysis_mode values", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    expect(() =>
      tool.parseParams({
        path: "C:\\Users\\User\\Downloads\\clip.mp4",
        analysis_mode: "invalid"
      })
    ).toThrow(/analysis_mode/i);
  });

  it("accepts paths[] for multi-image analysis", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const params = tool.parseParams({
      paths: ["C:\\\\Users\\\\User\\\\Downloads\\\\a.png", "C:\\\\Users\\\\User\\\\Downloads\\\\b.png"],
      language: "es",
      images: {
        max_images_total: "200",
        images_per_batch: "6",
        max_dimension: "2048"
      }
    });

    expect(params.paths?.length).toBe(2);
    expect(params.language).toBe("es");
    expect(params.images?.maxImagesTotal).toBe(200);
    expect(params.images?.imagesPerBatch).toBe(6);
    expect(params.images?.maxDimension).toBe(2048);
  });
});

describe("AnalyzeMediaTool output sanitization", () => {
  it("strips internal multipass/model routing fields from extraction", () => {
    const tool = new AnalyzeMediaTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000
    });

    const rawExtraction = {
      filename: "A.mp4",
      content_type: "video/mp4",
      upload_id: "upload_123",
      detected_media_type: "video",
      analysis_mode_used: "multipass",
      multipass: {
        map: { models: ["Some-Internal-Model"] },
        reduce: { model: "Some-Internal-Model" }
      },
      timeline: { type: "video", duration_seconds: 90.37 },
      segment_summaries: [
        {
          start_seconds: 0,
          end_seconds: 60,
          summary: "ok"
        }
      ],
      nested: {
        model: "Some-Internal-Model"
      }
    };

    const sanitized = (tool as unknown as {
      stripInternalExtractionFields: (value: Record<string, unknown>) => Record<string, unknown>;
    }).stripInternalExtractionFields(rawExtraction as unknown as Record<string, unknown>);
    expect(sanitized).toHaveProperty("filename", "A.mp4");
    expect(sanitized).toHaveProperty("timeline");
    expect(sanitized).toHaveProperty("segment_summaries");
    expect(sanitized).not.toHaveProperty("upload_id");
    expect(sanitized).not.toHaveProperty("detected_media_type");
    expect(sanitized).not.toHaveProperty("analysis_mode_used");
    expect(sanitized).not.toHaveProperty("multipass");
    expect(sanitized).not.toHaveProperty("model");
    expect(sanitized).toHaveProperty("nested");
    const nested = (sanitized as Record<string, unknown>)["nested"];
    expect(nested).toBeTypeOf("object");
    expect(nested as Record<string, unknown>).not.toHaveProperty("model");
  });
});
