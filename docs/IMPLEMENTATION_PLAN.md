# EnriVision MCP - Implementation Plan

Last Updated: 2026-01-07 14:10 -06:00

## Overview

EnriVision is a **client-side MCP (Model Context Protocol) server** that enables Claude Code CLI (and other MCP clients) to analyze local media files through **server-side processing in EnriProxy**.

EnriVision exposes **one** MCP tool:

- `analyze_media`

The tool:

1. Reads a local file on the **client** machine (or a set of local images via `paths[]`)
2. Uploads its bytes to **EnriProxy** using a **resumable** (tus-like) protocol (supports up to **4GB** by default)
3. Triggers server-side extraction + model analysis via `POST /v1/vision/analyze`
4. Returns **text-only** results (plus metadata) to the model

EnriVision **does not** run ffmpeg/Whisper locally. Client machines can be slow/low-power; EnriProxy does the heavy work on the server.

## Monorepo Layout (Current)

This repository is a monorepo at `Enri/` containing:

- `Enri/EnriProxy` (active)
- `Enri/EnriCode` (paused until EnriProxy is complete)
- `Enri/EnriVision` (this MCP package)

## Why This Exists (Problem Statement)

Claude Code CLI has a native tool `Read(...)` that:

- Works well for text/config files, PDFs, and common images
- May reject binary media such as `.mp4` / `.mp3` (`"This tool cannot read binary files."`)
- May return garbage text for some image formats (e.g., AVIF/HEIC/TIFF/SVG), depending on the client

When EnriProxy runs on a **remote server**, local paths like `C:\Users\...\Downloads\Gringa.mp4` only exist on the client machine. Server-side logic cannot read client disks.

Therefore, the correct remote solution is: **upload bytes from the client to the server**.

## High-Level Architecture

```
Claude Code CLI / MCP Client
  └─ mcp__enrivision__analyze_media(path="C:\...\file.mp4")
       ├─ POST  /v1/uploads           (create session)
       ├─ HEAD  /v1/uploads/:id       (resume offset)
       ├─ PATCH /v1/uploads/:id       (stream bytes in chunks, resumable)
       └─ POST  /v1/vision/analyze    (server-side extraction + model call)
            └─ provider response (text-only)
```

```
Claude Code CLI / MCP Client (many images)
  └─ mcp__enrivision__analyze_media(paths=["C:\...\a.png","C:\...\b.png",...])
       ├─ Build a tar archive stream (no compression)
       │    - Content-Type: application/vnd.enrivision.media-set+tar
       │    - First entry: manifest.json (JSON, v1)
       │    - Next entries: 000001.png, 000002.png, ...
       ├─ POST  /v1/uploads           (create session)
       ├─ HEAD  /v1/uploads/:id       (resume offset)
       ├─ PATCH /v1/uploads/:id       (stream tar bytes in chunks, resumable)
       └─ POST  /v1/vision/analyze    (server-side extraction + batching + reduce)
            └─ provider response (text-only)
```

## Naming Requirements

- npm package name: `@bedolla/enrivision`
- MCP server name (recommended): `enrivision`
- MCP tool name (required): `analyze_media`

Notes:

- In Claude Code CLI, the tool will appear as `mcp__enrivision__analyze_media` when configured under the name `enrivision`.
- Tool names are case-sensitive. The tool name must be `analyze_media`. Internal TypeScript method names may be `analyzeMedia()` etc.

## Authentication (API Key Required)

All EnriVision calls to EnriProxy must include:

- `Authorization: Bearer <API_KEY>`

The API key must match one of the configured keys in:

- `EnriProxy/config.json` → `auth.api_key_policy.keys[*].key`

Security notes:

- Do **not** exempt `/v1/uploads/*` or `/v1/vision/analyze` via `auth.api_key_policy.exclude_paths`.
- Never log raw API keys.

## EnriVision MCP (Client)

### Installation (Claude Code CLI)

Example `claude_desktop_config.json` / Claude Code CLI MCP config:

```json
{
  "mcpServers": {
    "enrivision": {
      "command": "npx",
      "args": ["-y", "@bedolla/enrivision"],
      "env": {
        "ENRIPROXY_URL": "https://your-enriproxy.example.com",
        "ENRIPROXY_API_KEY": "Enri-Es-Bien-Puta",
        "ENRIVISION_TIMEOUT_MS": "1800000"
      }
    }
  }
}
```

### Environment Variables

- `ENRIPROXY_URL` (required, default: `http://127.0.0.1:8787`)
- `ENRIPROXY_API_KEY` (required)
- `ENRIVISION_TIMEOUT_MS` (optional, default: `1800000`)

### Tool: `analyze_media` (Model-Facing Description)

The tool description must clearly communicate:

- `path` is a local path on the **client** machine (where the MCP server runs)
- `paths` is a list of local image paths on the **client** machine (uploaded as a single tar archive to avoid per-key session limits)
- The tool uploads **raw bytes** using **resumable uploads** (no base64 for large files)
- The server returns **text-only** analysis + metadata
- For video, frames + transcript belong to the **same** timeline (not unrelated images)
- Set `language` to match the user request to avoid language drift
- An API key is required (provided via `ENRIPROXY_API_KEY`)

### Tool parameters (schema-level)

Required:

- `path` (string): absolute local file path, OR
- `paths` (string[]): absolute local image paths (multi-image sets)

Optional (general):

- `context` (string): `ui|diagram|chart|error|code|meeting|tutorial|photo`
- `question` (string): explicit question to answer
- `language` (string): preferred response language code (e.g., `es`)
- `analysis_mode` (string): `auto|single|multipass`

Optional (legacy single-pass budgets):

- `max_frames` (integer 1–20): video-only, applies to **single-pass** extraction
- `transcribe` (boolean): video-only, whether to transcribe audio
- `transcription_language` (string): `auto|es|en|...`

Optional (video multipass tuning):

- `video.clip_start_seconds` (number): start offset in seconds for time-targeted analysis
- `video.clip_duration_seconds` (number): duration in seconds for time-targeted analysis
- `video.segment_seconds` (number): segment duration in seconds
- `video.max_segments` (integer): maximum segments to analyze
- `video.max_frames_per_segment` (integer): frame budget per segment

Optional (PDF multipass tuning):

- `document.max_pages_total` (integer): maximum pages to analyze in total
- `document.pages_per_batch` (integer): pages per map batch
- `document.max_images_per_batch` (integer): rendered pages per batch
- `document.scanned_text_threshold_chars` (integer): page text threshold for “scanned/visual” detection

Optional (image-set multipass tuning):

- `images.max_images_total` (integer): maximum images to analyze in total
- `images.images_per_batch` (integer): images per map batch
- `images.max_dimension` (integer): max dimension for each image (width/height)

Optional (client overrides):


Validation approach:

- Prefer lightweight, dependency-free runtime validation (avoid adding zod only for input validation).

## EnriProxy (Server)

### Resumable Upload API

Endpoints:

- `POST  /v1/uploads` → create session (metadata only)
- `HEAD  /v1/uploads/:id` → query current offset (resume)
- `PATCH /v1/uploads/:id` → append bytes at `Upload-Offset`

Defaults (when not configured):

- Max upload size: `4GB`
- Chunk size: `16MB`
- Session TTL: `3 hours`
- Global max sessions: `50`
- Per-key max sessions: `10`

#### POST `/v1/uploads`

Request JSON:

```json
{
  "filename": "Gringa.mp4",
  "size_bytes": 4918000,
  "content_type": "video/mp4",
  "client_trace_id": "optional"
}
```

Response JSON:

```json
{
  "upload_id": "upload_<uuid>",
  "chunk_size_bytes": 16777216,
  "expires_at": 1767000000000
}
```

#### HEAD `/v1/uploads/:id`

Response headers:

- `Upload-Offset`: current byte offset
- `Upload-Length`: total expected size
- `Upload-Expires`: expiration timestamp

#### PATCH `/v1/uploads/:id`

Headers:

- `Content-Type: application/offset+octet-stream`
- `Upload-Offset: <number>`
- `Content-Length: <number>`

Body:

- Raw bytes for that chunk

Response:

- HTTP `204 No Content`
- `Upload-Offset: <newOffset>`

Error behavior (important for robustness):

- Strict offset validation: server rejects mismatches (HTTP `409`) to prevent corruption
- Session expiration: server returns HTTP `410` when expired
- Chunk size enforcement: server rejects oversized chunks (HTTP `413`)

### Analysis Endpoint (`POST /v1/vision/analyze`)

EnriProxy performs:

- Media type detection (video/audio/image/document/text)
- Server-side extraction (ffmpeg frames, Whisper transcription, PDF text/render, etc.)
- Provider calls and response normalization

The endpoint supports multi-pass analysis for large inputs via `analysis_mode` and per-type tuning fields.

For the exact behavior and defaults of multi-pass video/PDF analysis, read:

- `EnriProxy/docs/VISION_ANALYSIS_MULTIPASS.md`

### Cleanup expectations

- Upload bytes are stored on the **server** under a non-public directory (default: `./uploads/resumable`).
- Temporary artifacts (frames, Whisper inputs, etc.) must be written under a server temp directory and cleaned up.
- Sessions expire automatically and are cleaned by TTL cleanup.

EnriProxy must never create files next to client-local paths (that would only happen if you incorrectly tried to read client paths on the server).

## Claude Code CLI Compatibility (Read + Playwright)

EnriVision is **additive** and should not break existing client functionality:

- `Read(...)` for PNG/JPG/PDF/text continues to work (client reads locally and sends content blocks to EnriProxy)
- Playwright MCP screenshots continue to work (created locally; typically attached via `Read(...)`)
- Use `analyze_media` for video/audio/exotic formats or when resumable uploads are required

## Required Reading (For Another LLM Implementing This)

To avoid common mistakes and hallucinations, read:

- `EnriProxy/docs/ENRIVISION.md`
- `EnriProxy/docs/VISION_ANALYSIS_MULTIPASS.md`
- `EnriProxy/config.json` (API keys + security policy)
- `EnriProxy/src/presentation/http/middlewares/AuthMiddleware.ts`
- `EnriProxy/src/presentation/http/handlers/UploadsHandler.ts`
- `EnriProxy/src/presentation/http/handlers/VisionAnalysisHandler.ts`
- `EnriVision/src/server/EnriVisionServer.ts`
- `EnriVision/src/tools/AnalyzeMediaTool.ts`

## Production Checklist

- EnriVision:
  - `npm run build` succeeds
  - `npm test` succeeds (unit tests)
  - `bin.enrivision` points to `dist/index.js` with a shebang
  - Package name `@bedolla/enrivision` is used for npm publishing
- EnriProxy:
  - `/v1/uploads/*` and `/v1/vision/analyze` require API keys
  - Upload directory is not publicly served
  - TTL cleanup runs and logs failures without crashing
  - Request size limits allow chunk uploads (tune `request_size_limit.max_body_size` if needed)
