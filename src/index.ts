#!/usr/bin/env node
/**
 * ENRIVISION - MCP ENTRYPOINT
 *
 * Starts the EnriVision MCP server on stdio.
 *
 * @module index
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EnriProxyClient } from "./client/EnriProxyClient.js";
import { AnalyzeMediaTool } from "./tools/AnalyzeMediaTool.js";
import { EnriVisionServer } from "./server/EnriVisionServer.js";
import { resolveTimeoutMs } from "./shared/validation.js";
import { packageInfoService } from "./package-info.js";

/**
 * Environment variable for EnriProxy base URL.
 */
const ENRIPROXY_URL_ENV = "ENRIPROXY_URL";

/**
 * Environment variable for EnriProxy API key.
 */
const ENRIPROXY_API_KEY_ENV = "ENRIPROXY_API_KEY";

/**
 * Environment variable for default request timeout in milliseconds.
 */
const ENRIVISION_TIMEOUT_MS_ENV = "ENRIVISION_TIMEOUT_MS";

/**
 * Default EnriProxy URL used when env is not set.
 */
const DEFAULT_ENRIPROXY_URL = "http://127.0.0.1:8787";

/**
 * Default request timeout in milliseconds.
 *
 * @remarks
 * Uploads are performed in chunks; this timeout applies per request.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Entry point for the MCP server.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log("EnriVision");
    console.log("");
    console.log("This is an MCP server over stdio that uploads local media to EnriProxy for server-side extraction and analysis. / Este es un servidor MCP sobre stdio que sube media local a EnriProxy para extracción y análisis del lado servidor.");
    console.log("");
    console.log("Usage / Uso:");
    console.log("  enrivision              (starts the MCP server over stdio / inicia el servidor MCP sobre stdio)");
    console.log("  enrivision --version");
    console.log("  enrivision --help");
    console.log("");
    console.log("Environment variables / Variables de entorno:");
    console.log("  ENRIPROXY_URL (optional, default: http://127.0.0.1:8787 / opcional, por defecto: http://127.0.0.1:8787)");
    console.log("  ENRIPROXY_API_KEY (required / requerida)");
    console.log("  ENRIVISION_TIMEOUT_MS (optional, default: 1800000; operator cap: the analyze timeout is min(operator, mode budget) with single 10 min and multipass/auto 20 min; per-chunk timeouts honor min(operator, derived 30s..300s) floored at 30 s / opcional, por defecto: 1800000; tope del operador: el timeout de análisis es min(operador, presupuesto del modo) con single 10 min y multipass/auto 20 min; los timeouts por chunk honran min(operador, derivado 30s..300s) con piso de 30 s)");
    console.log("  ENRIVISION_DEFAULT_LANGUAGE (optional, e.g. es/en / opcional, p. ej. es/en)");
    console.log("  ENRIVISION_QUIET=1 (optional, silences upload/retry progress on stderr / opcional, silencia el progreso subida/reintentos en stderr)");
    console.log("  ENRIVISION_DENY_SYMLINKS=1 (optional, rejects symlinked path/paths inputs; on Windows O_NOFOLLOW is 0 (advisory), so strict mode rests on the lstat-vs-fstat dev:ino comparison with a small swap window / opcional, rechaza path/paths con enlaces simbólicos; en Windows O_NOFOLLOW es 0 (consultivo), así que el modo estricto descansa en la comparación dev:ino de lstat-vs-fstat con una ventana pequeña)");
    console.log("  ENRIVISION_MODEL (optional, model id for dispatch affinity; omit for auto-dispatch / opcional, id del modelo para afinidad de dispatch; omita para auto-dispatch)");
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(packageInfoService.getVersion());
    process.exit(0);
  }

  const serverUrl = (process.env[ENRIPROXY_URL_ENV] ?? DEFAULT_ENRIPROXY_URL).trim();
  const apiKey = (process.env[ENRIPROXY_API_KEY_ENV] ?? "").trim();
  if (!apiKey) {
    console.error(
      "[EnriVision] WARNING: missing ENRIPROXY_API_KEY; the server starts but every analyze_media call will fail until it is set. / AVISO: falta ENRIPROXY_API_KEY; el servidor arranca pero cada llamada a analyze_media fallará hasta configurarla."
    );
  }
  const timeoutMsRaw = (process.env[ENRIVISION_TIMEOUT_MS_ENV] ?? "").trim();
  const resolvedTimeout = resolveTimeoutMs(timeoutMsRaw, ENRIVISION_TIMEOUT_MS_ENV, DEFAULT_TIMEOUT_MS);
  if (resolvedTimeout.warning) {
    console.error(`[EnriVision] WARNING / AVISO: ${resolvedTimeout.warning}`);
  }
  const timeoutMs = resolvedTimeout.timeoutMs;

  const analyzeMediaTool = new AnalyzeMediaTool({
    createClient: (baseUrl, key, timeout) =>
      new EnriProxyClient({
        baseUrl,
        apiKey: key,
        timeoutMs: timeout
      }),
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: timeoutMs
  });

  const server = new EnriVisionServer({
    name: "EnriVision",
    version: packageInfoService.getVersion(),
    analyzeMediaTool
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[EnriVision] MCP server running on stdio / Servidor MCP en ejecución sobre stdio");
}

void main().catch((error: unknown) => {
  console.error("[EnriVision] FATAL ERROR / ERROR FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
