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
import {
  ANALYZE_MEDIA_ERROR_CODES,
  ANALYZE_MEDIA_LIMITS,
  type AnalyzeMediaElementBox,
  type AnalyzeMediaErrorCode,
} from "../tools/AnalyzeMediaContract.js";
import { truncateCodePointsHeadTail } from "../shared/codepointTruncation.js";

/**
 * Bilingual fragments marking caller-side input errors for {@link EnriVisionServer.mapToolError}.
 *
 * @remarks
 * Every fragment below appears in the Spanish-first half, the English half,
 * or both of this repo's own validation messages, so locally-thrown argument
 * and tuning errors map to `ENRICODE_ERR_TOOL_INPUT_INVALID` without listing
 * each message. Execution failures (upload/analysis/transport) match none of
 * these and stay `ENRICODE_ERR_TOOL_EXECUTION_FAILED`. Protocol-shape faults
 * whose wording happens to contain a fragment (`Server response is invalid`,
 * `Upload-Offset` header faults, `Invalid server offset`, and the 50 MiB
 * response-overflow notice whose English half says "exceeded") are exempted
 * first in {@link EnriVisionServer.mapToolError} so they never misclassify
 * as input.
 */
const INPUT_ERROR_PATTERN: RegExp = /must be|debe ser|unknown|desconocid|reject|rechaz|does not apply|no aplica|only appl|solo aplica|provide|proporcione|not allowed|no se permite|not a file|no es un archivo|not an image|no es imagen|must contain|debe contener|cannot|no puede|exceed|excede|differ|difieren|greater than|mayor que|must fit|caber|must start with|debe comenzar|invalid|inválid|missing|falta|only exist|sólo existen|without advancing|sin avanzar|no vision capability|no tiene capacidad de visión/iu;

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
   * Maximum warnings carried by either envelope (server-controlled input).
   */
  private static readonly MAX_ENVELOPE_WARNINGS: number = 20;

  /**
   * Maximum code points kept per warning line.
   */
  private static readonly MAX_ENVELOPE_WARNING_CHARS: number = 1000;

  /**
   * Maximum grounded elements carried by either envelope.
   */
  private static readonly MAX_ENVELOPE_ELEMENTS: number = 100;

  /**
   * Bounds server-controlled warnings for model-facing envelopes.
   *
   * @param warnings - Raw warnings, when present.
   * @returns Capped warnings with code-point-safe lines.
   */
  private static boundEnvelopeWarnings(warnings: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
    if (!Array.isArray(warnings) || warnings.length === 0) {
      return [];
    }
    return warnings.slice(0, EnriVisionServer.MAX_ENVELOPE_WARNINGS).map((warning: string): string =>
      truncateCodePointsHeadTail(String(warning ?? ""), EnriVisionServer.MAX_ENVELOPE_WARNING_CHARS, 0).text,
    );
  }

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

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name !== "analyze_media") {
        const mapped = EnriVisionServer.mapToolError(
          new Error(`Herramienta desconocida: ${request.params.name} / Unknown tool: ${request.params.name}.`),
        );
        return {
          isError: true,
          content: [{ type: "text", text: mapped.text }],
          structuredContent: mapped.structuredContent,
        } satisfies CallToolResult;
      }

      try {
        const args = request.params.arguments ?? {};
        const params = this.analyzeMediaTool.parseParams(args);
        const result = await this.analyzeMediaTool.execute(params, { signal: extra.signal });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: EnriVisionServer.formatAnalysisText(
                result.analysis,
                result.media_type,
                result.elements,
                result.warnings,
              ),
            },
          ],
          structuredContent: EnriVisionServer.boundStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        const mapped = EnriVisionServer.mapToolError(error);
        return {
          isError: true,
          content: [{ type: "text", text: mapped.text }],
          structuredContent: mapped.structuredContent,
        } satisfies CallToolResult;
      }
    });
  }

  /**
   * Maps one tool failure to bilingual text plus a machine-readable error shape.
   *
   * @remarks
   * OpenAI-compatible third-party clients cannot branch on a human string:
   * every MCP error carries `structuredContent: {code, retryable, httpStatus?}`
   * reusing the EnriCode `VisionAnalyzeMediaErrorMapper` vocabulary
   * (`ENRICODE_ERR_TOOL_INPUT_INVALID` for argument/tuning errors including
   * proxy 400/422, `ENRICODE_ERR_TOOL_EXECUTION_FAILED` for server/transport
   * failures, `ENRICODE_ERR_TOOL_EXECUTION_TIMEOUT` for expired budgets,
   * `ENRICODE_ERR_TOOL_EXECUTION_ABORTED` for caller cancels). `retryable` is
   * true only for 408/429/5xx proxy statuses and expired budgets; terminal
   * input/auth errors and cancels never retry unchanged. `httpStatus` is
   * present only when the failure carries a proxy HTTP status.
   *
   * @param error - Unknown caught failure.
   * @returns Bilingual text plus the machine-readable error shape.
   */
  public static mapToolError(error: unknown): {
    readonly text: string;
    readonly structuredContent: {
      readonly code: AnalyzeMediaErrorCode;
      readonly retryable: boolean;
      readonly httpStatus?: number;
    };
  } {
    const message: string = error instanceof Error ? error.message : String(error);
    const status: number | undefined = EnriVisionServer.readHttpStatus(error);
    if (
      (error instanceof Error
        && (error.name === "AbortError" || error.name === "TimeoutError"))
      || /cancelled by the client|cancelada por el cliente/u.test(message)
    ) {
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionAborted, retryable: false },
      };
    }
    if (typeof status === "number") {
      if (status === 400 || status === 422) {
        return {
          text: message,
          structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.inputInvalid, retryable: false, httpStatus: status },
        };
      }
      if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
        return {
          text: message,
          structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionFailed, retryable: true, httpStatus: status },
        };
      }
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionFailed, retryable: false, httpStatus: status },
      };
    }
    // Stable-code mapping (proxy knob-validation errors carry `invalid_*`
    // codes + dotted fields): matches on the machine vocabulary instead of
    // Spanish prose, even when the HTTP status was lost in transport.
    const serverCode: unknown =
      typeof error === "object" && error !== null ? (error as { readonly serverCode?: unknown })["serverCode"] : undefined;
    if (typeof serverCode === "string" && serverCode.startsWith("invalid_")) {
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.inputInvalid, retryable: false },
      };
    }
    if (/timed out|expiró|agotó el tiempo límite|exceeded the maximum time/u.test(message)) {
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionTimeout, retryable: true },
      };
    }
    if (
      /Server response is invalid|Missing Upload-Offset|Invalid Upload-Offset|Invalid server offset/u.test(message)
      || /tamaño máximo permitido|maximum allowed size/iu.test(message)
    ) {
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionFailed, retryable: false },
      };
    }
    if (INPUT_ERROR_PATTERN.test(message)) {
      return {
        text: message,
        structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.inputInvalid, retryable: false },
      };
    }
    return {
      text: message,
      structuredContent: { code: ANALYZE_MEDIA_ERROR_CODES.executionFailed, retryable: false },
    };
  }

  /**
   * Reads a proxy HTTP status from an unknown failure.
   *
   * @param error - Unknown caught failure.
   * @returns HTTP status when the failure carries one, otherwise undefined.
   */
  private static readHttpStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) {
      return undefined;
    }
    const status: unknown = (error as { readonly status?: unknown })["status"];
    if (typeof status !== "number" || !Number.isFinite(status)) {
      return undefined;
    }
    const floored: number = Math.floor(status);
    // HTTP statuses live in 100-599; 0 is the transport-level "no response"
    // marker (socket errors) and must not mask the stable-code mapping.
    return floored >= 100 && floored <= 599 ? floored : undefined;
  }

  /**
   * Bounds the `structuredContent` payload for small MCP clients.
   *
   * @remarks
   * MCP delivers the whole result in one JSON frame, so the full `analysis`
   * is truncated to `maxStructuredContentAnalysisChars` keeping
   * `maxStructuredContentAnalysisHeadChars` at the start and the remainder
   * at the end (conclusions survive) with an inline Spanish-first bilingual
   * seam stating
   * both ends plus the total (`analysis_truncated: true` plus
   * `analysis_total_chars`; code-point safe, single pass with O(limit)
   * memory via `truncateCodePointsHeadTail`), and `extraction` is capped at
   * `maxStructuredContentExtractionChars` serialized characters with its
   * shape preserved. Small payloads pass through untouched. The seam mirrors
   * `content.text` and EnriCode `VisionAnalyzeMediaResultTruncator` so models
   * reading only `structuredContent` never hallucinate continuity.
   *
   * @param result - Full tool result.
   * @returns Bounded structured content.
   */
  private static boundStructuredContent(result: {
    readonly analysis: string;
    readonly elements?: ReadonlyArray<AnalyzeMediaElementBox>;
    readonly media_type: string;
    readonly warnings?: ReadonlyArray<string>;
    readonly extraction: Record<string, unknown>;
  }): Record<string, unknown> {
    const limit: number = ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisChars;
    const headChars: number = ANALYZE_MEDIA_LIMITS.maxStructuredContentAnalysisHeadChars;
    // The seam counts against the budget: shrink the tail by exactly the
    // seam's code points (iterating to a fixed point because the seam
    // prints the tail length) so head + seam + tail never exceeds the
    // declared limit.
    let tailChars: number = limit - headChars;
    const totalProbe = truncateCodePointsHeadTail(result.analysis, headChars, tailChars);
    const totalChars: number = totalProbe.totalChars;
    let seam: string = EnriVisionServer.buildStructuredSeam(headChars, tailChars, totalChars);
    if (totalProbe.truncated) {
      for (let pass: number = 0; pass < 3; pass += 1) {
        const seamChars: number = Array.from(seam).length;
        const nextTail: number = Math.max(0, limit - headChars - seamChars);
        if (nextTail === tailChars) {
          break;
        }
        tailChars = nextTail;
        seam = EnriVisionServer.buildStructuredSeam(headChars, tailChars, totalChars);
      }
    }
    const cut = truncateCodePointsHeadTail(result.analysis, headChars, tailChars);
    const boundedElements: ReadonlyArray<AnalyzeMediaElementBox> | undefined = Array.isArray(result.elements)
      ? result.elements.slice(0, EnriVisionServer.MAX_ENVELOPE_ELEMENTS).map((element) => ({
        ...element,
        label: truncateCodePointsHeadTail(String(element.label ?? ""), 200, 0).text,
      }))
      : result.elements;
    const boundedAnalysis: string = cut.truncated
      ? `${cut.head}${seam}${cut.tail}`
      : result.analysis;
    const boundedExtraction: Record<string, unknown> =
      EnriVisionServer.boundExtraction(result.extraction);
    const boundedWarnings: ReadonlyArray<string> = EnriVisionServer.boundEnvelopeWarnings(
      Array.isArray(result.warnings) ? result.warnings : undefined,
    );
    const boundedMediaType: string = EnriVisionServer.sanitizeMediaTypeLabel(result.media_type);
    const sourceWarnings: ReadonlyArray<string> = Array.isArray(result.warnings) ? result.warnings : [];
    const warningsChanged: boolean =
      boundedWarnings.length !== sourceWarnings.length
      || boundedWarnings.some((warning: string, index: number): boolean => warning !== sourceWarnings[index]);
    const mediaTypeChanged: boolean = boundedMediaType !== result.media_type;
    if (totalChars <= limit && boundedExtraction === result.extraction && boundedElements === result.elements && !warningsChanged && !mediaTypeChanged) {
      return { ...result };
    }
    return {
      ...result,
      elements: boundedElements,
      media_type: boundedMediaType,
      warnings: boundedWarnings,
      analysis: boundedAnalysis,
      ...(totalChars <= limit
        ? {}
        : { analysis_truncated: true, analysis_total_chars: totalChars }),
      extraction: boundedExtraction,
    };
  }

  /**
   * Builds the Spanish-first bilingual truncation seam for the structured
   * analysis head+tail cut.
   *
   * @param headChars - Head code points kept.
   * @param tailChars - Tail code points kept.
   * @param totalChars - Total analysis code points.
   * @returns Seam string placed between head and tail.
   */
  private static buildStructuredSeam(headChars: number, tailChars: number, totalChars: number): string {
    return `…[truncado: se muestran principio (${String(headChars)}) y fin (${String(tailChars)}) de ${String(totalChars)} caracteres / truncated: showing head (${String(headChars)}) and tail (${String(tailChars)}) of ${String(totalChars)} chars]…`;
  }

  /**
   * Caps an extraction payload to the structured-content budget.
   *
   * @remarks
   * Single `JSON.stringify` size probe measured in code points (not UTF-16
   * units, so astral-plane text is budgeted in the same units as every
   * other truncation in this module): payloads within budget keep their
   * exact reference (callers can rely on passthrough). Over-budget payloads
   * get long strings head+tail cut at `maxBoundExtractionStringChars` with
   * an Spanish-first bilingual marker; the object shape is preserved. The
   * result is re-probed after every cut: when tightening still exceeds the
   * budget the per-string cap is quartered (down to 64 chars) and, as a last
   * resort, the payload degrades to a bilingual omission marker — so
   * `serialized(bounded)` never exceeds the budget. The walk is iterative
   * with explicit depth and node budgets, so a hostile deep/wide server
   * response degrades to the omission marker instead of overflowing
   * the call stack.
   *
   * @param extraction - Raw extraction object.
   * @returns Original object when within budget, otherwise a bounded copy.
   */
  private static boundExtraction(
    extraction: Record<string, unknown>,
  ): Record<string, unknown> {
    let serialized: string;
    try {
      serialized = JSON.stringify(extraction);
    } catch {
      return {};
    }
    if (!EnriVisionServer.isOverExtractionBudget(serialized)) {
      return extraction;
    }
    let perString: number = ANALYZE_MEDIA_LIMITS.maxBoundExtractionStringChars;
    let bounded: unknown = EnriVisionServer.cutLongStrings(extraction, perString);
    for (let round = 0; round < 4; round += 1) {
      let reserialized: string;
      try {
        reserialized = JSON.stringify(bounded);
      } catch {
        return {};
      }
      if (!EnriVisionServer.isOverExtractionBudget(reserialized)) {
        return bounded as Record<string, unknown>;
      }
      perString = Math.max(64, Math.floor(perString / 4));
      bounded = EnriVisionServer.cutLongStrings(extraction, perString);
    }
    try {
      const finalSerialized: string = JSON.stringify(bounded);
      if (!EnriVisionServer.isOverExtractionBudget(finalSerialized)) {
        return bounded as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {
      _omitted:
        `[extracción omitida: aún excedía ${String(ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars)} caracteres tras recortar strings largas / extraction omitted: still exceeded ${String(ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars)} chars after tightening long strings]`,
    };
  }

  /**
   * Reports whether one serialized extraction exceeds the budget (code points).
   *
   * @remarks
   * Single-pass probe with O(budget) memory (no second full string): counts
   * code points while retaining at most the budget head.
   *
   * @param serialized - Serialized extraction payload.
   * @returns True when the payload exceeds `maxStructuredContentExtractionChars`.
   */
  private static isOverExtractionBudget(serialized: string): boolean {
    return truncateCodePointsHeadTail(
      serialized,
      ANALYZE_MEDIA_LIMITS.maxStructuredContentExtractionChars,
      0,
    ).truncated;
  }

  /**
   * Copies a value cutting strings longer than the cap (head+tail).
   *
   * @remarks
   * Iterative post-order walk with an explicit stack: `MAX_DEPTH` bounds
   * nesting (deeper subtrees become a bilingual omission marker) and
   * `MAX_NODES` bounds breadth (past the budget, remaining containers
   * become the same marker), so hostile server payloads cannot overflow the
   * call stack or stall the MCP frame. `__proto__`/`constructor`/`prototype`
   * keys are still dropped. JSON-derived extractions cannot cycle, but the
   * node budget doubles as a cycle backstop.
   *
   * @param value - Unknown value to bound.
   * @param perString - Maximum code points kept per string (split head/tail).
   * @returns Bounded copy.
   */
  private static cutLongStrings(value: unknown, perString: number): unknown {
    if (typeof value === "string") {
      return EnriVisionServer.cutOneLongString(value, perString);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const MAX_DEPTH: number = 32;
    const MAX_NODES: number = 20000;
    const root: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    let nodes = 1;
    const stack: Array<{
      readonly source: Record<string, unknown> | ReadonlyArray<unknown>;
      readonly copy: Record<string, unknown> | unknown[];
      readonly depth: number;
    }> = [{ source: value as Record<string, unknown> | ReadonlyArray<unknown>, copy: root, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const entries: ReadonlyArray<readonly [string | number, unknown]> = Array.isArray(frame.source)
        ? frame.source.map((item: unknown, index: number): readonly [number, unknown] => [index, item])
        : Object.entries(frame.source);
      for (const [key, child] of entries) {
        if (
          typeof key === "string"
          && (key === "__proto__" || key === "constructor" || key === "prototype")
        ) {
          continue;
        }
        nodes += 1;
        const assign = (bounded: unknown): void => {
          if (Array.isArray(frame.copy)) {
            (frame.copy as unknown[])[key as number] = bounded;
          } else {
            (frame.copy as Record<string, unknown>)[key as string] = bounded;
          }
        };
        if (typeof child === "string") {
          assign(EnriVisionServer.cutOneLongString(child, perString));
        } else if (child !== null && typeof child === "object") {
          if (frame.depth + 1 > MAX_DEPTH || nodes > MAX_NODES) {
            assign("[contenido omitido: estructura demasiado profunda o extensa / content omitted: structure too deep or wide]");
          } else {
            const childCopy: Record<string, unknown> | unknown[] = Array.isArray(child) ? [] : {};
            assign(childCopy);
            stack.push({
              source: child as Record<string, unknown> | ReadonlyArray<unknown>,
              copy: childCopy,
              depth: frame.depth + 1,
            });
          }
        } else {
          assign(child);
        }
      }
    }
    return root;
  }

  /**
   * Cuts one string to the per-string budget keeping head and tail.
   *
   * @param value - Raw string.
   * @param perString - Maximum code points kept (split head/tail).
   * @returns Original string when within budget, otherwise a bounded copy with an Spanish-first bilingual seam.
   */
  private static cutOneLongString(value: string, perString: number): unknown {
    const head: number = Math.ceil(perString / 2);
    const tail: number = Math.floor(perString / 2);
    const cut = truncateCodePointsHeadTail(value, head, tail);
    if (!cut.truncated) {
      return value;
    }
    return `${cut.head}…[truncado: se muestran principio y fin de ${String(cut.totalChars)} caracteres / truncated: showing head and tail of ${String(cut.totalChars)} chars]…${cut.tail}`;
  }

  /**
   * Builds the Spanish-first bilingual truncation seam for the text-output
   * analysis head+tail cut, including its framing newlines.
   *
   * @param head - Head code points kept.
   * @param tail - Tail code points kept.
   * @param totalChars - Total analysis code points.
   * @returns Seam string placed between head and tail.
   */
  private static buildTextOutputSeam(head: number, tail: number, totalChars: number): string {
    return `\n\n[…texto truncado por tamaño: se muestran principio (${String(head)}) y fin (${String(tail)}) de ${String(totalChars)} caracteres / truncated text by size: showing head (${String(head)}) and tail (${String(tail)}) of ${String(totalChars)} chars…]\n\n`;
  }

  /**
   * Formats the model-facing text output with a bounded analysis appendix.
   *
   * @remarks
   * The server `analysis` text can reach tens of MiB; only head+tail
   * (`maxAnalysisTextChars` code points split evenly, single pass) reach the
   * model context, followed by an explicit Spanish-first bilingual truncation
   * notice naming both ends and the total. Keeping the tail preserves
   * conclusions that head-only truncation drops. When analysis fails, the
   * thrown message may embed a `Detalle del servidor:` fragment in the proxy
   * language. Element labels are sliced by code point (never splitting
   * surrogate pairs) and flattened to one line; the server `media_type` is
   * stripped of line breaks and bounded to 128 chars so a hostile value
   * cannot break the envelope.
   *
   * @param analysis - Raw server analysis text.
   * @param mediaType - Detected media type.
   * @param elements - Optional grounded element boxes.
   * @param warnings - Optional Spanish-first bilingual honesty notes (e.g., clamped clip).
   * @returns Bounded Spanish-first bilingual text output.
   */
  private static formatAnalysisText(
    analysis: string,
    mediaType: string,
    elements: ReadonlyArray<AnalyzeMediaElementBox> | undefined,
    warnings?: ReadonlyArray<string>,
  ): string {
    const limit: number = ANALYZE_MEDIA_LIMITS.maxAnalysisTextChars;
    const head: number = Math.ceil(limit / 2);
    // The seam plus its framing newlines count against the budget: shrink
    // the tail by exactly their code points (fixed-point pass because the
    // seam prints the tail length) so head + seam + tail never exceeds the
    // declared limit.
    let tail: number = Math.floor(limit / 2);
    const probe = truncateCodePointsHeadTail(analysis, head, tail);
    const totalChars: number = probe.totalChars;
    let seamText: string = EnriVisionServer.buildTextOutputSeam(head, tail, totalChars);
    if (probe.truncated) {
      for (let pass: number = 0; pass < 3; pass += 1) {
        const seamChars: number = Array.from(seamText).length;
        const nextTail: number = Math.max(0, limit - head - seamChars);
        if (nextTail === tail) {
          break;
        }
        tail = nextTail;
        seamText = EnriVisionServer.buildTextOutputSeam(head, tail, totalChars);
      }
    }
    const cut = truncateCodePointsHeadTail(analysis, head, tail);
    const trimmed: string = cut.truncated
      ? `${cut.head}${seamText}${cut.tail}`
      : analysis;
    const safeMediaType: string = EnriVisionServer.sanitizeMediaTypeLabel(mediaType);
    const header: string = `ANÁLISIS (${safeMediaType}) / ANALYSIS (${safeMediaType}):\n${trimmed}`;
    const cappedElements: ReadonlyArray<AnalyzeMediaElementBox> = Array.isArray(elements)
      ? elements.slice(0, EnriVisionServer.MAX_ENVELOPE_ELEMENTS)
      : [];
    const withElements: string =
      cappedElements.length > 0
        ? `${header}\n\nelementos ('elements', cajas relativas a la imagen original, coordenadas normalizadas 0-1 —no píxeles—; (0,0) es la esquina superior izquierda; reutilizables directamente como 'region' para zoom; NUNCA invente coordenadas) / elements ('elements', boxes relative to the original image, normalized 0-1 coords — not pixels; (0,0) is the top-left corner; reusable directly as 'region' for zoom; NEVER invent coordinates):\n${cappedElements
          .map(
            (element) => {
              const singleLine: string = String(element.label ?? "").replace(/[\r\n]+/gu, " ");
              const label: string = truncateCodePointsHeadTail(singleLine, 200, 0).text;
              return `- ${label} [${element.box.x}, ${element.box.y}, ${element.box.width}, ${element.box.height}]`;
            },
          )
          .join("\n")}`
        : header;
    const cappedWarnings: ReadonlyArray<string> = EnriVisionServer.boundEnvelopeWarnings(warnings);
    if (cappedWarnings.length > 0) {
      const warningLines: string = cappedWarnings.map((warning: string): string => `- ${warning}`).join("\n");
      return `${withElements}\n\navisos / warnings:\n${warningLines}`;
    }
    return withElements;
  }

  /**
   * Sanitizes one server `media_type` value for the text envelope header.
   *
   * @remarks
   * The header interpolates the value verbatim today (validated non-empty
   * only): line breaks are flattened and the value is bounded to 128 code
   * points so a hostile server value cannot inject envelope lines.
   *
   * @param mediaType - Raw server media type.
   * @returns Single-line media type label (at most 128 code points).
   */
  private static sanitizeMediaTypeLabel(mediaType: string): string {
    const singleLine: string = String(mediaType ?? "").replace(/[\r\n]+/gu, " ").trim();
    const source: string = singleLine.length > 0 ? singleLine : "unknown";
    return truncateCodePointsHeadTail(source, 128, 0).text;
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
        "Sube y analiza un archivo mediante EnriProxy (extracción del lado servidor + análisis con modelo).\n / Upload and analyze a media file via EnriProxy (server-side extraction + model analysis)." +
        "\n" +
        "Cuándo usarla: PDFs grandes o escaneados donde el Read puede truncar; video/audio u otros binarios que el cliente no puede leer; HEIC/AVIF/TIFF/APNG/SVG/Office cuando el Read no es confiable; archivos muy grandes con subidas reanudables (hasta 4 GiB).\n / When to use: large or scanned PDFs where client Read may truncate; video/audio or binary media the client cannot Read; HEIC/AVIF/TIFF/APNG/SVG/Office docs when client Read is unreliable; very large files needing resumable uploads (up to 4 GiB)." +
        "\n" +
        "Reglas: use `path` para un archivo, `paths` para varias imágenes. Cuando `paths` trae al menos una entrada válida, `path` se ignora (contrato explícito: mandar ambos se permite, `path` se ignora en silencio — prefiera semántica oneOf y mande solo uno). Las entradas en blanco se descartan; claves desconocidas en `video`/`audio`/`document`/`images` se rechazan. `question` es opcional aquí (obligatoria en EnriCode); attachmentIndex/attachmentId no existen aquí (sólo EnriCode).\n / Rules: use `path` for one file, `paths` for several images (UI screenshots/photo sets). When `paths` carries at least one valid entry, `path` is ignored (explicit ignore-path contract: sending both is allowed, `path` is silently ignored — prefer oneOf semantics and send only one). Blank `paths` entries are discarded; unknown keys inside `video`/`audio`/`document`/`images` are rejected (check typos like `max_pages_totall`). `question` is optional here (required in EnriCode vision.analyze_media); attachmentIndex/attachmentId do not exist here (EnriCode-only)." +
        "\n" +
        "Presupuestos (timeout = min(ENRIVISION_TIMEOUT_MS del operador, presupuesto del modo)): single = 10 min (una pasada, rápida y barata); multipass = 20 min (por segmentos/lotes + reducción); auto = 20 min (el servidor elige y puede escalar a multipass). Si no sabe cuál usar, omita el afinado (auto).\n / Analysis budgets (client analyze timeout = min(operator ENRIVISION_TIMEOUT_MS, mode budget)): single = 10 min (one pass, fast and cheap, 1 image or simple questions); multipass = 20 min (per-segment/batch map + reduce; PDFs over ~20 pages, long videos, image sets); auto = 20 min (the server picks and may escalate to multipass). If unsure, omit tuning (auto)." +
        "\n" +
        "Clip de video: para preguntas en un tiempo específico (\"¿qué pasa en 12:34?\") use video.clip_start_seconds + video.clip_duration_seconds: convierta a segundos (12:34 = 12*60+34 = 754), por ejemplo clip_start_seconds=754 y clip_duration_seconds=30. O dé video.clip_end_seconds (fin = inicio + duración, 0-86400 s).\n / Video clip targeting: for time-specific questions (\"what happens at 12:34?\") use video.clip_start_seconds + video.clip_duration_seconds: convert to seconds (12:34 = 12*60+34 = 754) and request a window, e.g. clip_start_seconds=754 and clip_duration_seconds=30. Or give video.clip_end_seconds instead (end = start + duration, 0-86400 s)." +
        "\n" +
        "Enteros estrictos: los knobs enteros aceptan números o strings enteras completas (\"60\" vale; \"8.0\", \"8abc\" y 7.9 fallan). Los flotantes aceptan decimales (\"12.5\" vale). transcribe vale true por defecto y no tiene efecto en imágenes/documentos (se declara en warnings, se ignora). Requiere API key válida de EnriProxy (env ENRIPROXY_API_KEY).\n / Strict integers: integer knobs accept numbers or complete integer strings (\"60\" works; \"8.0\", \"8abc\", 7.9 fail). Floats accept decimals (\"12.5\" works). transcribe defaults to true and has no effect on images/documents (declared in warnings, ignored). Requires a valid EnriProxy API key (env ENRIPROXY_API_KEY, sent as Authorization: Bearer ...)." +
        "\n" +
        "Errores: las fallas devuelven isError con texto bilingüe más structuredContent {code, retryable, httpStatus?} con el vocabulario EnriCode; retryable marca 429/5xx/timeouts. Si el mensaje trae `Detalle del servidor:` en el idioma del proxy, repórtelo tal cual. Fotogramas y transcripción comparten la MISMA línea de tiempo. `model` es el id del modelo para afinidad de dispatch (máximo 128 caracteres o env ENRIVISION_MODEL; omita para auto-dispatch). `language` controla el idioma de la RESPUESTA; `transcription_language` aparte el idioma que Whisper espera al TRANSCRIBIR (\"auto\" = detectar solo).\n / Errors: failures return isError with bilingual text plus structuredContent {code, retryable, httpStatus?} reusing the EnriCode vocabulary (ENRICODE_ERR_TOOL_INPUT_INVALID / EXECUTION_FAILED / EXECUTION_TIMEOUT / EXECUTION_ABORTED); retryable marks 429/5xx/timeouts. If the message carries a `Detalle del servidor:` fragment in the proxy language, report it verbatim. Video frames and transcription share the SAME video timeline. Animated GIF/WebP/APNG/SVG become representative key frames. `model` is the active model id for server-side dispatch affinity (max 128 chars, or env ENRIVISION_MODEL; omit for auto-dispatch). Set `language` (e.g. \"es\") to match the user language and avoid drift: `language` controls the analysis RESPONSE language; `transcription_language` separately controls the language Whisper expects when TRANSCRIBING audio (\"auto\" = detect only)." +
        "\n" +
        "Ejemplos mínimos: (1) una imagen: {\"path\": \"/tmp/foto.png\", \"question\": \"...\"}. (2) clip de video 12:34->754s: {\"path\": \"/tmp/charla.mp4\", \"question\": \"...\", \"video\": {\"clip_start_seconds\": 754, \"clip_duration_seconds\": 30}}. (3) PDF largo multipass: {\"path\": \"/tmp/manual.pdf\", \"question\": \"...\", \"analysis_mode\": \"multipass\"}. Rutas absolutas del host MCP (en Windows valen `C:/...`; en POSIX lanzarían error).\n / Minimal examples: (1) single image: {\"path\": \"/tmp/shot.png\", \"question\": \"What does each capture show?\"}. (2) video clip 12:34->754s: {\"path\": \"/tmp/talk.mp4\", \"question\": \"What happens at 12:34?\", \"video\": {\"clip_start_seconds\": 754, \"clip_duration_seconds\": 30}}. (3) long PDF multipass: {\"path\": \"/tmp/manual.pdf\", \"question\": \"Summarize each chapter.\", \"analysis_mode\": \"multipass\"}. Absolute MCP-host paths (`C:/...` drive paths only work on a Windows host; POSIX rejects them)." +
        "\n" +
        "Continuación: si la respuesta trae has_more con cursor (segment_summaries_cursor o transcription_segments_cursor), pida el resto con solo cursor (+ offset opcional, por defecto next_offset; también `limit` opcional 1-100 para acotar la ventana). Con cursor no mande path/paths. / Continuation: when the response carries has_more with a cursor (segment_summaries_cursor or transcription_segments_cursor), ask for the rest with only cursor (+ optional offset, defaults to next_offset; optional `limit` 1-100 bounds the window); never send path/paths with cursor." +
        "\n" +
        "Depuración de capturas de UI: abra con un veredicto de una línea; describa zona por zona; aproxime colores como hex; cuantifique defectos de layout; transcriba etiquetas, botones y errores visibles; compare observado vs esperado cuando aplique. / UI-screenshot debugging (when the media are app screenshots): open with a one-line plain verdict; describe zone by zone (header, sidebar, main content, modals, notifications), not as a general scene; approximate colors as hex values (e.g. #1F6FEB) and name them; quantify layout defects (overflows, clipping, overlaps, misalignments, missing spacing, cut text) estimating pixel magnitudes when possible; transcribe labels, buttons, and any visible error/status text; when the request states what was expected, compare observed vs expected explicitly.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Ruta absoluta a un archivo local en la máquina donde corre el servidor MCP (por ejemplo, C:\\\\Users\\\\User\\\\Downloads\\\\video.mp4), o una URL http(s) de imagen/video/audio/PDF para descargar y analizar (hasta 64 MiB; hosts locales y redes privadas bloqueados). Una URL solitaria que excede 64 MiB escala a la ingesta `source_url` del servidor (descarga reanudable del lado de EnriProxy con más hops y techo mayor); los archivos locales usan subida reanudable hasta 4 GiB. Cuando `paths` trae al menos una entrada válida, `path` se ignora. / Absolute local file path on the machine running this MCP server (e.g. C:\\Users\\User\\Downloads\\video.mp4), or one http(s) URL of image/video/audio/PDF to download and analyze (up to 64 MiB; localhost and private networks blocked). A solitary URL above 64 MiB escalates to the server's `source_url` ingestion (resumable server-side download with extra hops and a higher ceiling); local files use resumable upload up to 4 GiB. When `paths` carries at least one valid entry, `path` is ignored."
          },
          paths: {
            type: "array",
            description:
              "Rutas absolutas a varios archivos de imagen locales o URLs http(s) (capturas de UI/sets de fotos; cada URL hasta 64 MiB). Cuando se proporcionan, EnriVision sube un único archivo de conjunto para procesamiento por lotes y reducción del lado servidor. Las entradas en blanco se descartan. / Absolute local paths to several image files, or http(s) image URLs (UI screenshots/photo sets; each URL up to 64 MiB). When provided, EnriVision uploads a single set archive for server-side batching + reduce.",
            items: {
              type: "string",
              description:
                "Una imagen: ruta absoluta local o URL http(s) (hasta 64 MiB; hosts locales y redes privadas bloqueados). / One image: absolute local path or http(s) URL (up to 64 MiB; localhost and private networks blocked)."
            }
          },
          context: {
            type: "string",
            description:
              "Pista opcional de análisis: ui, diagram, chart, error, code, meeting, tutorial, photo. Déjelo vacío para detección automática. Máximo 2000 caracteres; si los excede falla antes de subir. / Optional analysis hint: ui, diagram, chart, error, code, meeting, tutorial, photo. Leave empty for auto-detect. Max 2000 chars; longer fails before upload."
          },
          question: {
            type: "string",
            description: "Pregunta explícita opcional que responder sobre el archivo (opcional aquí; en EnriCode vision.analyze_media es obligatoria). Máximo 2000 caracteres; si los excede falla antes de subir. / Optional explicit question to answer about the file (optional here; required in EnriCode vision.analyze_media). Max 2000 chars; longer fails before upload."
          },
          language: {
            type: "string",
            description:
              "Código de idioma preferido de la RESPUESTA del análisis (ISO 639-1), por ejemplo 'es', 'en'. No afecta la transcripción: para eso use 'transcription_language'. Precedencia: parámetro explícito > ENRIVISION_DEFAULT_LANGUAGE > servidor. / Preferred RESPONSE language code of the analysis (ISO 639-1), e.g. 'es', 'en'. Does not affect transcription: use 'transcription_language' for that. Precedence: explicit param > ENRIVISION_DEFAULT_LANGUAGE > server."
          },
          max_frames: {
            type: ["integer", "string"],
            description:
              "Máximo opcional de fotogramas para videos, entero 1-20 (por defecto 20), en modo 'single' (pasada única). También acepta maxFrames. Para tiempos específicos, prefiera video.clip_start_seconds + video.clip_duration_seconds. Para multipass, use video.max_frames_per_segment. / Optional max frames for videos, integer 1-20 (default 20), in 'single' mode. Also accepts maxFrames; complete integer strings work."
          },
          model: {
            type: "string",
            description:
              "Id opcional del modelo activo para afinidad de dispatch del lado servidor (incluido el reroute Muse Spark); texto no vacío de máximo 128 caracteres. También acepta el env ENRIVISION_MODEL. Omita para auto-dispatch. / Optional active model id for server-side dispatch affinity (including the Muse Spark reroute); non-empty text, max 128 chars. Also accepts env ENRIVISION_MODEL. Omit for auto-dispatch."
          },
          transcribe: {
            type: ["boolean", "string"],
            description: "Sobreescritura opcional para activar/desactivar la transcripción de audio en videos. Acepta true/false y \"true\"/\"false\" (los demás valores se rechazan). / Optional override to enable/disable audio transcription on videos. Accepts true/false and \"true\"/\"false\" (other values are rejected). Has no effect on images/documents (declared in warnings, ignored)."
          },
          transcription_language: {
            type: "string",
            description:
              "También acepta transcriptionLanguage. Pista opcional de idioma que Whisper espera al TRANSCRIBIR el audio/video (por ejemplo, 'auto', 'es', 'en'; 'auto' = detectar solo). No cambia el idioma de la respuesta: para eso use 'language'. / Also accepts transcriptionLanguage. Optional hint for the language Whisper expects when TRANSCRIBING audio/video (e.g. 'auto', 'es', 'en'; 'auto' = detect only). Does not change the response language: use 'language' for that."
          },
          transcriptionLanguage: {
            type: "string",
            description:
              "Alias de transcription_language (misma pista, misma precedencia). / Alias of transcription_language (same hint, same precedence)."
          },
          maxFrames: {
            type: ["integer", "string"],
            description:
              "Alias de max_frames (entero 1-20, por defecto 20, modo single). Las strings enteras completas valen. / Alias of max_frames (integer 1-20, default 20, single mode). Complete integer strings work."
          },
          analysis_mode: {
            type: "string",
            enum: ["auto", "single", "multipass"],
            description:
              "También acepta analysisMode. Selector opcional de modo de análisis. 'single' = una sola pasada, rápida y barata (1 imagen, preguntas simples). 'multipass' = por segmentos/lotes + reducción (PDFs de más de 20 páginas, videos largos, conjuntos). 'auto' = el servidor elige (prefiere multipass para PDFs de más de 20 páginas). Omita si no sabe cuál usar. / Also accepts analysisMode. Optional analysis-mode selector. 'single' = one pass, fast and cheap (1 image, simple questions). 'multipass' = per-segment/batch + reduce (PDFs over ~20 pages, long videos, sets). 'auto' = the server picks (prefers multipass for PDFs over ~20 pages). Omit if unsure."
          },
          analysisMode: {
            type: "string",
            enum: ["auto", "single", "multipass"],
            description:
              "Alias de analysis_mode (mismo selector, mismos presupuestos). / Alias of analysis_mode (same selector, same budgets)."
          },
          region: {
            type: "object",
            description:
              "Región relativa de la IMAGEN original para analizar a resolución nativa (zoom; acepta números y strings numéricas como \"0.1\"). Coordenadas entre 0 y 1; (0,0) es la esquina superior izquierda. Use las cajas devueltas en 'elements' de un análisis previo de la misma imagen: NUNCA invente coordenadas. Ideal para leer texto pequeño (etiquetas, código) que en la imagen completa comprimida resulta ilegible. Regla única: sólo imágenes individuales (`path` o `paths` con un solo elemento); con conjuntos de varias imágenes, video, PDF u otra media no-imagen la llamada se rechaza con error. / Relative REGION of the ORIGINAL image for native-resolution zoom (accepts numbers and numeric strings like \"0.1\"). Coords between 0 and 1; (0,0) is the top-left corner. Use the boxes returned in 'elements' of a previous analysis of the same image: NEVER invent coordinates. Ideal for small text (labels, code) illegible in the compressed full image. Single images only (`path` or single-entry `paths`); multi-image sets, video, PDF, or other non-image media are rejected.",
            properties: {
              x: {
                type: ["number", "string"],
                description: "Coordenada horizontal relativa de la esquina superior izquierda (0 = borde izquierdo). / Relative horizontal coord of the top-left corner (0 = left edge)."
              },
              y: {
                type: ["number", "string"],
                description: "Coordenada vertical relativa de la esquina superior izquierda (0 = borde superior). / Relative vertical coord of the top-left corner (0 = top edge)."
              },
              width: {
                type: ["number", "string"],
                description: "Ancho relativo (1 = ancho completo). / Relative width (1 = full width)."
              },
              height: {
                type: ["number", "string"],
                description: "Alto relativo (1 = alto completo). / Relative height (1 = full height)."
              }
            },
            required: ["x", "y", "width", "height"]
          },
          cursor: {
            type: "string",
            description:
              "Cursor opaco de continuación de una respuesta truncada (segment_summaries_cursor o transcription_segments_cursor). Con cursor NO se sube ni analiza nada: solo lee la siguiente ventana de la lista. No se combina con 'path'/'paths'. / Opaque continuation cursor from a truncated response (segment_summaries_cursor or transcription_segments_cursor). With cursor nothing is uploaded or analyzed: it only reads the next window of the list. Cannot be combined with 'path'/'paths'."
          },
          offset: {
            type: "integer",
            description:
              "Índice inicial de la continuación (entero >= 0; por defecto, el next_offset de la respuesta). / Continuation start index (integer >= 0; defaults to the response next_offset)."
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description:
              "Máximo de entradas a leer en esta continuación (1-100; por defecto el tamaño de ventana del servidor). / Maximum entries to read in this continuation (1-100; defaults to the server window size)."
          },
          video: {
            type: "object",
            description:
              "Ajuste opcional de multipass para video. Se usa sólo al analizar videos. Dentro de video valen snake_case y camelCase (clip_start_seconds o clipStartSeconds, segment_seconds o segmentSeconds, max_segments o maxSegments, max_frames_per_segment o maxFramesPerSegment), y los planos clipStartSeconds/clipEndSeconds/clipDurationSeconds/segmentSeconds/maxSegments/maxFramesPerSegment valen igual (el plano gana sobre ambos anidados). Sin plano, video.segment_seconds y audio.segment_seconds (o max_segments) con valores distintos se rechazan: use el plano o solo uno de los dos objetos. / Optional multipass tuning for video. Only used when analyzing videos. Inside video both snake_case and camelCase work, and the flat clipStartSeconds/clipEndSeconds/clipDurationSeconds/segmentSeconds/maxSegments/maxFramesPerSegment aliases work the same (flat wins over both nested). Without a flat, differing video.segment_seconds vs audio.segment_seconds (or max_segments) values are rejected: use the flat or only one of the two objects.",
            properties: {
              clip_start_seconds: {
                type: ["number", "string"],
                description:
                  "Inicio opcional del clip en segundos (0-86400). Para 12:34 use 754 (= 12*60+34). Con clip_end_seconds, fin = inicio + duración. / Optional clip start in seconds (0-86400). For 12:34 use 754 (= 12*60+34). With clip_end_seconds, end = start + duration."
              },
              clip_end_seconds: {
                type: ["number", "string"],
                description:
                  "Fin opcional del clip en segundos (0-86400, debe ser mayor que el inicio). Si se da, la duración se calcula como fin menos inicio e ignora clip_duration_seconds. / Optional clip end in seconds (0-86400, must exceed start). When given, duration derives as end minus start and clip_duration_seconds is ignored."
              },
              clip_duration_seconds: {
                type: ["number", "string"],
                description:
                  "Duración opcional del clip en segundos (mayor que 0, hasta 86400). Úsela junto a clip_start_seconds; si da clip_end_seconds, no la necesita. Si el fin implícito (inicio + duración) excede 86400 segundos, la duración se recorta al límite con un aviso en 'warnings'. / Optional clip duration in seconds (greater than 0, up to 86400). Use with clip_start_seconds; not needed with clip_end_seconds. When start + duration exceeds 86400 s the duration is trimmed to the limit with a 'warnings' note."
              },
              segment_seconds: {
                type: ["number", "string"],
                description: "Duración del segmento en segundos para video (5-600; por defecto 60). / Segment duration in seconds for video (5-600; default 60)."
              },
              max_segments: {
                type: ["integer", "string"],
                description: "Número máximo de segmentos de video a analizar (entero 1-60; el servidor rechaza valores mayores). / Max video segments to analyze (integer 1-60; the server rejects larger values)."
              },
              max_frames_per_segment: {
                type: ["integer", "string"],
                description: "Máximo de fotogramas a extraer por segmento de video (entero 1-20; por defecto 8). / Max frames to extract per video segment (integer 1-20; default 8)."
              },
              clipStartSeconds: {
                type: ["number", "string"],
                description: "Alias de clip_start_seconds (0-86400). El plano clipStartSeconds gana sobre el anidado. / Alias of clip_start_seconds (0-86400). Flat clipStartSeconds wins over nested."
              },
              clipEndSeconds: {
                type: ["number", "string"],
                description: "Alias de clip_end_seconds (0-86400, debe ser mayor que el inicio). El plano gana sobre el anidado. / Alias of clip_end_seconds (0-86400, must exceed start). Flat wins over nested."
              },
              clipDurationSeconds: {
                type: ["number", "string"],
                description: "Alias de clip_duration_seconds (mayor que 0, hasta 86400). El plano gana sobre el anidado. / Alias of clip_duration_seconds (greater than 0, up to 86400). Flat wins over nested."
              },
              segmentSeconds: {
                type: ["number", "string"],
                description: "Alias de segment_seconds para video (5-600; por defecto 60). El plano gana sobre el anidado. / Alias of segment_seconds for video (5-600; default 60). Flat wins over nested."
              },
              maxSegments: {
                type: ["integer", "string"],
                description: "Alias de max_segments para video (entero 1-60). El plano gana sobre el anidado. / Alias of max_segments for video (integer 1-60). Flat wins over nested."
              },
              maxFramesPerSegment: {
                type: ["integer", "string"],
                description: "Alias de max_frames_per_segment (entero 1-20; por defecto 8). El plano gana sobre el anidado. / Alias of max_frames_per_segment (integer 1-20; default 8). Flat wins over nested."
              }
            }
          },
          document: {
            type: "object",
            description:
              "Ajuste opcional de multipass para documentos (PDF). Dentro de document valen snake_case, camelCase y los legados max_pages/maxPages/documentMaxPages/document_max_pages. Los planos documentMaxPages/document_max_pages valen igual que document.max_pages_total (el plano gana). / Optional multipass tuning for documents (PDF). Inside document snake_case, camelCase, and legacy max_pages/maxPages/documentMaxPages/document_max_pages work. The flat documentMaxPages/document_max_pages aliases equal document.max_pages_total (flat wins).",
            properties: {
              max_pages_total: {
                type: ["integer", "string"],
                description: "Número máximo de páginas a analizar en total (entero 1-200; por defecto 20). Más páginas = más costo y tiempo; omita para pocas páginas. / Max pages to analyze in total (integer 1-200; default 20). More pages = more cost and time; omit for few pages."
              },
              pages_per_batch: {
                type: ["integer", "string"],
                description: "Páginas por lote para las llamadas map de multipass (entero 1-200). Lotes chicos = más llamadas pero menos memoria; omita para el valor del servidor. / Pages per batch for multipass map calls (integer 1-200). Smaller batches = more calls but less memory; omit for the server value."
              },
              max_images_per_batch: {
                type: ["integer", "string"],
                description: "Máximo de páginas renderizadas (imágenes) por lote (entero 0-20; 0 = sin render). Más imágenes = más costo de visión; omita para el valor del servidor. / Max rendered (image) pages per batch (integer 0-20; 0 = no render). More images = more vision cost; omit for the server value."
              },
              scanned_text_threshold_chars: {
                type: ["integer", "string"],
                description:
                  "Longitud mínima de texto extraído para tratar una página como textual en vez de escaneada (entero 0-5000). Sólo afecta el enrutamiento texto-vs-visión; omita para el valor del servidor. / Min extracted-text length to treat a page as textual instead of scanned (integer 0-5000). Only affects text-vs-vision routing; omit for the server value."
              },
              maxPagesTotal: {
                type: ["integer", "string"],
                description: "Alias de max_pages_total (entero 1-200; por defecto 20). El plano gana sobre el anidado. / Alias of max_pages_total (integer 1-200; default 20). Flat wins over nested."
              },
              max_pages: {
                type: ["integer", "string"],
                description: "Alias legado de max_pages_total (entero 1-200). El plano gana sobre el anidado. / Legacy alias of max_pages_total (integer 1-200). Flat wins over nested."
              },
              maxPages: {
                type: ["integer", "string"],
                description: "Alias legado de max_pages_total (entero 1-200). El plano gana sobre el anidado. / Legacy alias of max_pages_total (integer 1-200). Flat wins over nested."
              },
              documentMaxPages: {
                type: ["integer", "string"],
                description: "Alias legado de max_pages_total (entero 1-200). El plano gana sobre el anidado. / Legacy alias of max_pages_total (integer 1-200). Flat wins over nested."
              },
              document_max_pages: {
                type: ["integer", "string"],
                description: "Alias legado de max_pages_total (entero 1-200). El plano gana sobre el anidado. / Legacy alias of max_pages_total (integer 1-200). Flat wins over nested."
              },
              pagesPerBatch: {
                type: ["integer", "string"],
                description: "Alias de pages_per_batch (entero 1-200). / Alias of pages_per_batch (integer 1-200)."
              },
              maxImagesPerBatch: {
                type: ["integer", "string"],
                description: "Alias de max_images_per_batch (entero 0-20; 0 = sin render). / Alias of max_images_per_batch (integer 0-20; 0 = no render)."
              },
              scannedTextThresholdChars: {
                type: ["integer", "string"],
                description: "Alias de scanned_text_threshold_chars (entero 0-5000). / Alias of scanned_text_threshold_chars (integer 0-5000)."
              }
            }
          },
          audio: {
            type: "object",
            description:
              "Ajuste opcional de multipass para audio (se usa sólo al analizar archivos de audio). Dentro de audio valen timestamps, audioTimestamps o audio_timestamps, segment_seconds o segmentSeconds, max_segments o maxSegments, y los planos audioTimestamps/audio_timestamps/segmentSeconds/segment_seconds/maxSegments/max_segments valen igual (el plano gana sobre ambos anidados). Sin plano, valores distintos entre video y audio para el mismo knob se rechazan. timestamps acepta true/false y \"true\"/\"false\". / Optional multipass tuning for audio (only used when analyzing audio files). Inside audio timestamps, audioTimestamps, or audio_timestamps work, as do segment_seconds/segmentSeconds and max_segments/maxSegments; flat aliases work the same (flat wins over both nested). Without a flat, differing video vs audio values for the same knob are rejected. timestamps accepts true/false and \"true\"/\"false\".",
            properties: {
              timestamps: {
                type: ["boolean", "string"],
                description: "Si incluir segmentos con marca de tiempo en la extracción de audio. / Whether to include timestamped segments in the audio extraction."
              },
              segment_seconds: {
                type: ["number", "string"],
                description: "Duración del segmento en segundos para multipass de audio (5-600; por defecto 60). / Segment duration in seconds for audio multipass (5-600; default 60)."
              },
              max_segments: {
                type: ["integer", "string"],
                description: "Número máximo de segmentos de audio a analizar (entero 1-60; el servidor rechaza valores mayores). / Max audio segments to analyze (integer 1-60; the server rejects larger values)."
              },
              audioTimestamps: {
                type: ["boolean", "string"],
                description: "Alias de timestamps (acepta true/false y \"true\"/\"false\"). El plano gana sobre el anidado. / Alias of timestamps (accepts true/false and \"true\"/\"false\"). Flat wins over nested."
              },
              audio_timestamps: {
                type: ["boolean", "string"],
                description: "Alias de timestamps (solo audio). El plano gana sobre el anidado. / Alias of timestamps (audio only). Flat wins over nested."
              },
              segmentSeconds: {
                type: ["number", "string"],
                description: "Alias de segment_seconds para audio (5-600; por defecto 60). El plano gana sobre el anidado. / Alias of segment_seconds for audio (5-600; default 60). Flat wins over nested."
              },
              maxSegments: {
                type: ["integer", "string"],
                description: "Alias de max_segments para audio (entero 1-60). El plano gana sobre el anidado. / Alias of max_segments for audio (integer 1-60). Flat wins over nested."
              }
            }
          },
          images: {
            type: "object",
            description:
              "Ajuste opcional de multipass para conjuntos de imágenes (se usa sólo con `paths`). Dentro de images valen snake_case y camelCase (max_images_total o maxImagesTotal, images_per_batch o imagesPerBatch, max_dimension o maxDimension). / Optional multipass tuning for image sets (only used with `paths`). Inside images snake_case and camelCase work.",
            properties: {
              max_images_total: {
                type: ["integer", "string"],
                description: "Número máximo de imágenes del conjunto a analizar (entero 1-500). Más imágenes = más costo y tiempo; omita para analizarlas todas. / Max set images to analyze (integer 1-500). More images = more cost and time; omit to analyze all."
              },
              images_per_batch: {
                type: ["integer", "string"],
                description: "Imágenes por lote para las llamadas map de multipass (entero 1-20). Lotes chicos = más llamadas pero menos memoria; omita para el valor del servidor. / Images per batch for multipass map calls (integer 1-20). Smaller batches = more calls but less memory; omit for the server value."
              },
              max_dimension: {
                type: ["integer", "string"],
                description: "Dimensión máxima de cada imagen en píxeles, ancho/alto (entero 256-4096). Valores grandes = más detalle y más costo; omita para el valor del servidor. / Max image dimension in pixels, width/height (integer 256-4096). Larger values = more detail and more cost; omit for the server value."
              },
              maxImagesTotal: {
                type: ["integer", "string"],
                description: "Alias de max_images_total (entero 1-500). / Alias of max_images_total (integer 1-500)."
              },
              imagesPerBatch: {
                type: ["integer", "string"],
                description: "Alias de images_per_batch (entero 1-20). / Alias of images_per_batch (integer 1-20)."
              },
              maxDimension: {
                type: ["integer", "string"],
                description: "Alias de max_dimension (entero 256-4096). / Alias of max_dimension (integer 256-4096)."
              }
            }
          },
          segmentSeconds: {
            type: ["number", "string"],
            description:
              "Atajo plano de segment_seconds (5-600 s; también vale segment_seconds). Sin objetos video/audio alimenta a ambos y el servidor aplica el que corresponda; con un solo objeto alimenta a ese; con ambos y sin plano, valores distintos se rechazan. El plano gana sobre ambos anidados. / Flat shortcut for segment_seconds (5-600 s; segment_seconds also works). Without video/audio objects it feeds both and the server applies the matching one; with one object it feeds that one; with both and differing values (no flat) it is rejected. Flat wins over both nested."
          },
          segment_seconds: {
            type: ["number", "string"],
            description: "Alias plano de segmentSeconds (5-600 s). El plano gana sobre video.segment_seconds y audio.segment_seconds. / Flat alias for segmentSeconds (5-600 s). Flat wins over video.segment_seconds and audio.segment_seconds."
          },
          maxSegments: {
            type: ["integer", "string"],
            description:
              "Atajo plano de max_segments (entero 1-60; también vale max_segments). Misma precedencia que segmentSeconds: sin objetos alimenta a ambos, con uno alimenta a ese, con ambos distintos sin plano se rechaza. El plano gana. / Flat shortcut for max_segments (integer 1-60; max_segments also works). Same precedence as segmentSeconds. Flat wins."
          },
          max_segments: {
            type: ["integer", "string"],
            description: "Alias plano de maxSegments (entero 1-60). El plano gana sobre video.max_segments y audio.max_segments. / Flat alias for maxSegments (integer 1-60). Flat wins over video.max_segments and audio.max_segments."
          },
          maxFramesPerSegment: {
            type: ["integer", "string"],
            description:
              "Atajo plano de video.max_frames_per_segment (entero 1-20; también vale max_frames_per_segment). Solo aplica a video; con audio se rechaza. El plano gana sobre el anidado. / Flat shortcut for video.max_frames_per_segment (integer 1-20; max_frames_per_segment also works). Video only; rejected with audio. Flat wins over nested."
          },
          max_frames_per_segment: {
            type: ["integer", "string"],
            description: "Alias plano de maxFramesPerSegment (entero 1-20, solo video). El plano gana sobre el anidado. / Flat alias for maxFramesPerSegment (integer 1-20, video only). Flat wins over nested."
          },
          audioTimestamps: {
            type: ["boolean", "string"],
            description:
              "Atajo plano de audio.timestamps (también vale audio_timestamps; acepta true/false y \"true\"/\"false\"). Solo aplica a audio. El plano gana sobre el anidado. / Flat shortcut for audio.timestamps (audio_timestamps also works; accepts true/false and \"true\"/\"false\"). Audio only. Flat wins over nested."
          },
          audio_timestamps: {
            type: ["boolean", "string"],
            description: "Alias plano de audioTimestamps (solo audio). El plano gana sobre el anidado. / Flat alias for audioTimestamps (audio only). Flat wins over nested."
          },
          documentMaxPages: {
            type: ["integer", "string"],
            description:
              "Atajo plano de document.max_pages_total (entero 1-200; también vale document_max_pages). Solo aplica a documentos. El plano gana sobre el anidado. / Flat shortcut for document.max_pages_total (integer 1-200; document_max_pages also works). Documents only. Flat wins over nested."
          },
          document_max_pages: {
            type: ["integer", "string"],
            description: "Alias plano de documentMaxPages (entero 1-200, solo documentos). El plano gana sobre el anidado. / Flat alias for documentMaxPages (integer 1-200, documents only). Flat wins over nested."
          },
          clipStartSeconds: {
            type: ["number", "string"],
            description:
              "Atajo plano de video.clip_start_seconds (0-86400 s; también vale clip_start_seconds). Para 12:34 use 754. El plano gana sobre el anidado. / Flat shortcut for video.clip_start_seconds (0-86400 s; clip_start_seconds also works). For 12:34 use 754. Flat wins over nested."
          },
          clip_start_seconds: {
            type: ["number", "string"],
            description: "Alias plano de clipStartSeconds (0-86400 s). El plano gana sobre el anidado. / Flat alias for clipStartSeconds (0-86400 s). Flat wins over nested."
          },
          clipEndSeconds: {
            type: ["number", "string"],
            description:
              "Atajo plano de video.clip_end_seconds (0-86400 s, mayor que el inicio; también vale clip_end_seconds). La duración se calcula como fin menos inicio. El plano gana sobre el anidado. / Flat shortcut for video.clip_end_seconds (0-86400 s, greater than start; clip_end_seconds also works). Duration derives as end minus start. Flat wins over nested."
          },
          clip_end_seconds: {
            type: ["number", "string"],
            description: "Alias plano de clipEndSeconds (0-86400 s). El plano gana sobre el anidado. / Flat alias for clipEndSeconds (0-86400 s). Flat wins over nested."
          },
          clipDurationSeconds: {
            type: ["number", "string"],
            description:
              "Atajo plano de video.clip_duration_seconds (mayor que 0, hasta 86400 s; también vale clip_duration_seconds). Úselo junto a clipStartSeconds. El plano gana sobre el anidado. / Flat shortcut for video.clip_duration_seconds (greater than 0, up to 86400 s; clip_duration_seconds also works). Use with clipStartSeconds. Flat wins over nested."
          },
          clip_duration_seconds: {
            type: ["number", "string"],
            description: "Alias plano de clipDurationSeconds (hasta 86400 s). El plano gana sobre el anidado. / Flat alias for clipDurationSeconds (up to 86400 s). Flat wins over nested."
          }
        },
        anyOf: [{ required: ["path"] }, { required: ["paths"] }, { required: ["cursor"] }]
      },
      outputSchema: {
        type: "object",
        properties: {
          analysis: {
            type: "string",
            description: "Análisis en texto producido por EnriProxy. / Text analysis produced by EnriProxy."
          },
          elements: {
            type: "array",
            description:
              "Cajas de elementos detectados en análisis de imagen (coordenadas relativas 0-1, reutilizables como `region`). / Detected element boxes in image analyses (relative 0-1 coords, reusable as `region`).",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                box: {
                  type: "object",
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" }
                  },
                  required: ["x", "y", "width", "height"]
                }
              },
              required: ["label", "box"]
            }
          },
          media_type: {
            type: "string",
            description: "Tipo de media detectado. / Detected media type."
          },
          warnings: {
            type: "array",
            description: "Avisos de honestidad bilingües (por ejemplo, ventana de clip recortada al límite de 24 h). Solo presente cuando el parseo ajustó un valor pedido. / Honesty warnings (bilingual, e.g. clip window trimmed to the 24 h limit). Only present when parsing adjusted a requested value.",
            items: { type: "string" }
          },
          extraction: {
            type: "object",
            description: "Metadatos de extracción devueltos por el servidor (sin identificadores internos). Las strings muy largas se recortan principio+fin con el marcador […truncado…]; la forma del objeto se preserva. / Extraction metadata returned by the server (no internal ids). Very long strings are head+tail trimmed with a […truncated…] marker; object shape is preserved."
          },
          analysis_truncated: {
            type: "boolean",
            description: "`true` cuando `analysis` se truncó al tope de `structuredContent` (262144 caracteres en puntos de código; se conservan principio y fin). / Flag that is true when `analysis` was truncated to the `structuredContent` cap (262144 chars in code points; head and tail kept)."
          },
          analysis_total_chars: {
            type: "integer",
            description: "Total de caracteres (puntos de código) del análisis completo antes de truncar. / Total chars (code points) of the full analysis before truncation."
          }
        },
        required: ["analysis", "media_type", "extraction"]
      }
    };
  }
}