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
          content: [{ type: "text", text: `Herramienta desconocida: ${request.params.name}` }]
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
              text:
                `ANALISIS (${result.media_type}):\n${result.analysis}` +
                (Array.isArray(result.elements) && result.elements.length > 0
                  ? `\n\nelements (cajas relativas a la imagen original, coordenadas normalizadas 0-1 —no píxeles—; (0,0) es la esquina superior izquierda; reutilizables directamente como 'region' para zoom; NUNCA invente coordenadas):\n${result.elements
                      .map(
                        (element) =>
                          `- ${element.label} [${element.box.x}, ${element.box.y}, ${element.box.width}, ${element.box.height}]`
                      )
                      .join("\n")}`
                  : "")
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
        "Sube y analiza un archivo local mediante EnriProxy (extracción del lado servidor + análisis con modelo).\n" +
        "\n" +
        "Cuándo usarla:\n" +
        "- PDFs grandes (muchas páginas) o escaneados donde el Read del cliente puede truncar o perder contenido.\n" +
        "- Video/audio u otros medios binarios que su cliente no puede leer con Read.\n" +
        "- Archivos de audio en formatos comunes (mp3, wav, flac, m4a, aac, ogg/oga, opus, wma, weba, mka, aiff/aif/aifc, caf, m4b/m4r, mp1/mp2/mpa/mpga).\n" +
        "- HEIC/AVIF/TIFF/APNG/SVG/documentos de Office cuando el Read del cliente es poco confiable.\n" +
        "- Archivos muy grandes que requieren subidas reanudables (hasta 4GB).\n" +
        "- PDFs/videos grandes: use `analysis_mode` = 'multipass' para mejor cobertura (auto prefiere multipass para PDFs de más de 20 páginas).\n" +
        "- Para preguntas de video en un tiempo específico (por ejemplo, \"¿qué pasa en 12:34?\"), use `video.clip_start_seconds` y `video.clip_duration_seconds`.\n" +
        "\n" +
        "Reglas:\n" +
        "- Use `path` para un archivo, o `paths` para varias imágenes (capturas de UI/sets de fotos).\n" +
        "- `path`/`paths` aceptan rutas absolutas en la máquina donde corre este servidor MCP (el cliente), o URLs http(s) que se descargan temporalmente en esa misma máquina (hasta 64 MiB; no se permiten hosts locales ni redes privadas).\n" +
        "- Requiere una API key válida de EnriProxy (env `ENRIPROXY_API_KEY`, enviada como Authorization: Bearer ...).\n" +
        "- Prefiera el Read nativo del cliente sólo para texto/PDF/imágenes comunes pequeños y simples cuando funcione; prefiera esta herramienta para PDFs grandes.\n" +
        "- Responda estrictamente con la salida de la herramienta; si faltan fotogramas/transcripción, dígalo.\n" +
        "- Video: los fotogramas y la transcripción pertenecen a la MISMA línea de tiempo del video (no son imágenes sin relación).\n" +
        "- Los GIF/WebP/APNG/SVG animados se convierten en fotogramas clave representativos.\n" +
        "- Establezca `language` (por ejemplo, 'es') para coincidir con el idioma del usuario y evitar deriva de idioma.\n" +
        "\n" +
        "Depuración de capturas de UI (cuando el material sean capturas de pantalla de aplicaciones):\n" +
        "- Abra con un veredicto de una línea en lenguaje claro (por ejemplo, 'el formulario de login renderiza correctamente' o 'el header se solapa con la barra lateral').\n" +
        "- Describa zona por zona (header, barra lateral, contenido principal, modales, notificaciones), no como escena general.\n" +
        "- Aproxime los colores como valores hex (por ejemplo, #1F6FEB) y nómbrelos; señale colores inesperados o inconsistentes.\n" +
        "- Cuantifique defectos de layout: desbordes, recortes, solapamientos, desalineaciones, espaciados faltantes, texto cortado; estime magnitudes en píxeles cuando sea posible.\n" +
        "- Transcriba textualmente etiquetas, botones y cualquier mensaje de error o estado visible.\n" +
        "- Si la solicitud indica qué se esperaba, compare observado vs esperado de forma explícita.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Ruta absoluta a un archivo local en la máquina donde corre el servidor MCP (por ejemplo, C:\\\\Users\\\\User\\\\Downloads\\\\video.mp4), o una URL http(s) de imagen/video/audio/PDF para descargar y analizar (hasta 64 MiB; hosts locales y redes privadas bloqueados)."
          },
          paths: {
            type: "array",
            description:
              "Rutas absolutas a varios archivos de imagen locales o URLs http(s) (capturas de UI/sets de fotos; cada URL hasta 64 MiB). Cuando se proporcionan, EnriVision sube un único archivo de conjunto para procesamiento por lotes y reducción del lado servidor.",
            items: {
              type: "string"
            }
          },
          context: {
            type: "string",
            description:
              "Pista opcional de análisis: ui, diagram, chart, error, code, meeting, tutorial, photo. Déjelo vacío para detección automática."
          },
          question: {
            type: "string",
            description: "Pregunta explícita opcional que responder sobre el archivo."
          },
          language: {
            type: "string",
            description: "Código de idioma preferido de respuesta (ISO 639-1), por ejemplo 'es', 'en'."
          },
          max_frames: {
            type: "integer",
            description:
              "Máximo opcional de fotogramas para videos (1-20) en modo single-pass. Para tiempos específicos, prefiera video.clip_start_seconds + video.clip_duration_seconds. Para multipass, use video.max_frames_per_segment."
          },
          transcribe: {
            type: "boolean",
            description: "Sobreescritura opcional para activar/desactivar la transcripción de audio en videos."
          },
          transcription_language: {
            type: "string",
            description:
              "Pista opcional de idioma para la transcripción de audio/video (por ejemplo, 'auto', 'es', 'en')."
          },
          analysis_mode: {
            type: "string",
            enum: ["auto", "single", "multipass"],
            description: "Selector opcional de modo de análisis: auto, single o multipass."
          },
          region: {
            type: "object",
            description:
              "Región relativa de la IMAGEN original para analizar a resolución nativa (zoom). Coordenadas entre 0 y 1; (0,0) es la esquina superior izquierda. Use las cajas devueltas en 'elements' de un análisis previo de la misma imagen: NUNCA invente coordenadas. Ideal para leer texto pequeño (labels, código) que en la imagen completa comprimida resulta ilegible. Sólo imágenes (path, no paths).",
            properties: {
              x: {
                type: "number",
                description: "Coordenada horizontal relativa de la esquina superior izquierda (0 = borde izquierdo)."
              },
              y: {
                type: "number",
                description: "Coordenada vertical relativa de la esquina superior izquierda (0 = borde superior)."
              },
              width: {
                type: "number",
                description: "Ancho relativo (1 = ancho completo)."
              },
              height: {
                type: "number",
                description: "Alto relativo (1 = alto completo)."
              }
            },
            required: ["x", "y", "width", "height"]
          },
          video: {
            type: "object",
            description: "Ajuste opcional de multipass para video. Se usa sólo al analizar videos.",
            properties: {
              clip_start_seconds: {
                type: "number",
                description: "Offset opcional de inicio del clip en segundos para análisis de video dirigido a un tiempo."
              },
              clip_duration_seconds: {
                type: "number",
                description: "Duración opcional del clip en segundos para análisis de video dirigido a un tiempo."
              },
              segment_seconds: {
                type: "number",
                description: "Duración del segmento en segundos."
              },
              max_segments: {
                type: "integer",
                description: "Número máximo de segmentos a analizar."
              },
              max_frames_per_segment: {
                type: "integer",
                description: "Máximo de fotogramas a extraer por segmento."
              }
            }
          },
          document: {
            type: "object",
            description: "Ajuste opcional de multipass para documentos (PDF).",
            properties: {
              max_pages_total: {
                type: "integer",
                description: "Número máximo de páginas a analizar en total."
              },
              pages_per_batch: {
                type: "integer",
                description: "Páginas por lote para las llamadas map de multipass."
              },
              max_images_per_batch: {
                type: "integer",
                description: "Máximo de páginas renderizadas (imágenes) por lote."
              },
              scanned_text_threshold_chars: {
                type: "integer",
                description: "Longitud mínima de texto extraído para tratar una página como textual."
              }
            }
          },
          audio: {
            type: "object",
            description: "Ajuste opcional de multipass para audio (se usa sólo al analizar archivos de audio).",
            properties: {
              timestamps: {
                type: "boolean",
                description: "Si incluir segmentos con marca de tiempo en la extracción de audio."
              },
              segment_seconds: {
                type: "number",
                description: "Duración del segmento en segundos para multipass de audio."
              },
              max_segments: {
                type: "integer",
                description: "Número máximo de segmentos de audio a analizar."
              }
            }
          },
          images: {
            type: "object",
            description: "Ajuste opcional de multipass para conjuntos de imágenes (se usa sólo con `paths`).",
            properties: {
              max_images_total: {
                type: "integer",
                description: "Número máximo de imágenes a analizar en total."
              },
              images_per_batch: {
                type: "integer",
                description: "Imágenes por lote para las llamadas map de multipass."
              },
              max_dimension: {
                type: "integer",
                description: "Dimensión máxima para las imágenes (ancho/alto)."
              }
            }
          }
        },
        anyOf: [{ required: ["path"] }, { required: ["paths"] }]
      }
    };
  }
}