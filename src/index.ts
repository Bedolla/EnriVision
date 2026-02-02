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
    console.log("This is an MCP server over stdio that uploads local media to EnriProxy for server-side extraction and analysis.");
    console.log("");
    console.log("Usage:");
    console.log("  enrivision              (start MCP server over stdio)");
    console.log("  enrivision --version");
    console.log("  enrivision --help");
    console.log("");
    console.log("Environment variables:");
    console.log("  ENRIPROXY_URL (optional, default: http://127.0.0.1:8787)");
    console.log("  ENRIPROXY_API_KEY (required)");
    console.log("  ENRIVISION_TIMEOUT_MS (optional, default: 1800000)");
    console.log("  ENRIVISION_DEFAULT_LANGUAGE (optional, e.g. es/en)");
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(packageInfoService.getVersion());
    process.exit(0);
  }

  const serverUrl = (process.env[ENRIPROXY_URL_ENV] ?? DEFAULT_ENRIPROXY_URL).trim();
  const apiKey = (process.env[ENRIPROXY_API_KEY_ENV] ?? "").trim();
  const timeoutMsRaw = (process.env[ENRIVISION_TIMEOUT_MS_ENV] ?? "").trim();
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : DEFAULT_TIMEOUT_MS;

  const analyzeMediaTool = new AnalyzeMediaTool({
    createClient: (baseUrl, key, timeout) =>
      new EnriProxyClient({
        baseUrl,
        apiKey: key,
        timeoutMs: timeout
      }),
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  });

  const server = new EnriVisionServer({
    name: "EnriVision",
    version: packageInfoService.getVersion(),
    analyzeMediaTool
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[EnriVision] MCP server running on stdio");
}

void main().catch((error: unknown) => {
  console.error("[EnriVision] FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
