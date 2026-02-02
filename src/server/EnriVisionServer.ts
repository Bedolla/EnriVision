/**
 * ENRIVISION MCP SERVER
 *
 * Implements a minimal MCP server (stdio transport) exposing a single tool:
 * `analyze_media`.
 *
 * @module server/EnriVisionServer
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

import type { AnalyzeMediaTool } from "../tools/AnalyzeMediaTool.js";

/**
 * Configuration for {@link EnriVisionServer}.
 */
export interface EnriVisionServerConfig {
  /**
   * Server name reported via MCP.
   */
  readonly name: string;

  /**
   * Server version reported via MCP.
   */
  readonly version: string;

  /**
   * Tool implementation for `analyze_media`.
   */
  readonly analyzeMediaTool: AnalyzeMediaTool;
}

/**
 * MCP server exposing EnriVision tools.
 */
export class EnriVisionServer {
  /**
   * Underlying MCP server implementation.
   */
  private readonly server: Server;

  /**
   * Analyze media tool implementation.
   */
  private readonly analyzeMediaTool: AnalyzeMediaTool;

  /**
   * Creates a new {@link EnriVisionServer}.
   *
   * @param config - Server configuration
   */
  public constructor(config: EnriVisionServerConfig) {
    this.analyzeMediaTool = config.analyzeMediaTool;

    this.server = new Server(
      { name: config.name, version: config.version },
      {
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      }
    );

    this.registerToolHandlers();
  }

  /**
   * Connects the server to a transport and starts listening.
   *
   * @param transport - MCP transport (stdio)
   */
  public async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Registers tool list and tool call handlers.
   */
  private registerToolHandlers(): void {
    const analyzeMediaDefinition = this.getAnalyzeMediaToolDefinition();

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: [analyzeMediaDefinition] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "analyze_media") {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }]
        } satisfies CallToolResult;
      }

      try {
        const args = request.params.arguments ?? {};
        const params = this.analyzeMediaTool.parseParams(args);
        const result = await this.analyzeMediaTool.execute(params);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `ANALYSIS (${result.media_type}):\n${result.analysis}`
            }
          ],
          structuredContent: result
        } satisfies CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        } satisfies CallToolResult;
      }
    });
  }

  /**
   * Returns the JSON schema tool definition for `analyze_media`.
   *
   * @returns Tool definition
   */
  private getAnalyzeMediaToolDefinition(): Tool {
    return {
      name: "analyze_media",
      description:
        "Upload and analyze a local file via EnriProxy (server-side extraction + model analysis).\n" +
        "\n" +
        "When to use:\n" +
        "- Large PDFs (many pages) or scanned PDFs where client-side Read may truncate or miss content.\n" +
        "- Video/audio or other binary media your client cannot Read.\n" +
        "- Audio files in common formats (mp3, wav, flac, m4a, aac, ogg/oga, opus, wma, weba, mka, aiff/aif/aifc, caf, m4b/m4r, mp1/mp2/mpa/mpga).\n" +
        "- HEIC/AVIF/TIFF/APNG/SVG/Office docs when your client Read is unreliable.\n" +
        "- Very large files where resumable uploads are required (up to 4GB).\n" +
        "- Large PDFs/videos: set `analysis_mode` to 'multipass' for better coverage (auto prefers multipass for PDFs > 20 pages).\n" +
        "- For time-specific video questions (e.g., \"what happens at 12:34?\"), set `video.clip_start_seconds` and `video.clip_duration_seconds`.\n" +
        "\n" +
        "Rules:\n" +
        "- Use `path` for one file, or `paths` for multiple images (UI screenshots/photo sets).\n" +
        "- `path`/`paths` are absolute paths on the machine running this MCP server (the client).\n" +
        "- Requires a valid EnriProxy API key (env `ENRIPROXY_API_KEY`, sent as Authorization: Bearer ...).\n" +
        "- Prefer the client's native Read tool only for small/simple text/PDF/common images when it works; prefer this tool for large PDFs.\n" +
        "- Answer strictly from the tool output; if frames/transcript are missing, say so.\n" +
        "- Video: frames + transcript belong to the SAME video timeline (not unrelated images).\n" +
        "- Animated GIF/WebP/APNG/SVG inputs are converted into representative key frames.\n" +
        "- Set `language` (e.g., 'es') to match the user request and avoid language drift.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path to a local file on the machine running the MCP server (e.g., C:\\\\Users\\\\User\\\\Downloads\\\\video.mp4)."
          },
          paths: {
            type: "array",
            description:
              "Absolute paths to multiple local image files (UI screenshots/photo sets). When provided, EnriVision uploads a single media-set archive for server-side batching + reduce.",
            items: {
              type: "string"
            }
          },
          context: {
            type: "string",
            description:
              "Optional analysis hint: ui, diagram, chart, error, code, meeting, tutorial, photo. Leave empty for auto-detection."
          },
          question: {
            type: "string",
            description: "Optional explicit question to answer about the file."
          },
          language: {
            type: "string",
            description: "Preferred response language code (ISO 639-1), e.g. 'es', 'en'."
          },
          max_frames: {
            type: "integer",
            description:
              "Optional max frames for videos (1-20) in single-pass mode. For targeted timestamps, prefer video.clip_start_seconds + video.clip_duration_seconds. For multipass, use video.max_frames_per_segment."
          },
          transcribe: {
            type: "boolean",
            description: "Optional override to enable/disable audio transcription for videos."
          },
          transcription_language: {
            type: "string",
            description: "Optional Whisper language hint for audio/video transcription (e.g., 'auto', 'es', 'en')."
          },
          analysis_mode: {
            type: "string",
            description: "Optional analysis mode selector: auto, single, or multipass."
          },
          video: {
            type: "object",
            description: "Optional video multipass tuning. Used only when analyzing videos.",
            properties: {
              clip_start_seconds: {
                type: "number",
                description: "Optional clip start offset in seconds for time-targeted video analysis."
              },
              clip_duration_seconds: {
                type: "number",
                description: "Optional clip duration in seconds for time-targeted video analysis."
              },
              segment_seconds: {
                type: "number",
                description: "Segment duration in seconds."
              },
              max_segments: {
                type: "integer",
                description: "Maximum number of segments to analyze."
              },
              max_frames_per_segment: {
                type: "integer",
                description: "Maximum frames to extract per segment."
              }
            }
          },
          document: {
            type: "object",
            description: "Optional document multipass tuning (PDF).",
            properties: {
              max_pages_total: {
                type: "integer",
                description: "Maximum number of pages to analyze in total."
              },
              pages_per_batch: {
                type: "integer",
                description: "Pages per batch for multipass map calls."
              },
              max_images_per_batch: {
                type: "integer",
                description: "Maximum rendered pages (images) per batch."
              },
              scanned_text_threshold_chars: {
                type: "integer",
                description: "Minimum extracted text length to treat a page as textual."
              }
            }
          },
          audio: {
            type: "object",
            description: "Optional audio multipass tuning (used only when analyzing audio files).",
            properties: {
              timestamps: {
                type: "boolean",
                description: "Whether to include timestamped segments in audio extraction."
              },
              segment_seconds: {
                type: "number",
                description: "Segment duration in seconds for audio multipass."
              },
              max_segments: {
                type: "integer",
                description: "Maximum number of audio segments to analyze."
              }
            }
          },
          images: {
            type: "object",
            description: "Optional image-set multipass tuning (used only with `paths`).",
            properties: {
              max_images_total: {
                type: "integer",
                description: "Maximum number of images to analyze in total."
              },
              images_per_batch: {
                type: "integer",
                description: "Images per batch for multipass map calls."
              },
              max_dimension: {
                type: "integer",
                description: "Maximum dimension for images (width/height)."
              }
            }
          }
        },
        anyOf: [{ required: ["path"] }, { required: ["paths"] }]
      }
    };
  }
}
