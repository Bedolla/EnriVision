# EnriVision

EnriVision is a **Model Context Protocol (MCP)** server over `stdio` that uploads local media to **EnriProxy** and returns **server-side extraction + model analysis**.

This is useful for media types that many MCP clients cannot read reliably (videos, audio, scanned PDFs, HEIC/AVIF, large files), while keeping the MCP server itself lightweight.

## What this project is

- An MCP server process your MCP host launches (OpenCode, Claude Code, Codex, etc.)
- A thin client for EnriProxy (resumable upload + structured output)

## Requirements

- Node.js `>= 22` (recommended: Node 24 LTS)
- A reachable EnriProxy server with these endpoints enabled:
  - `POST /v1/uploads`
  - `HEAD /v1/uploads/:id`
  - `PATCH /v1/uploads/:id`
  - `POST /v1/vision/analyze`
- An EnriProxy API key (configured on the EnriProxy side)

## Install

```powershell
# Global install
npm install -g @bedolla/enrivision

# Or run without installing
npx -y @bedolla/enrivision@latest --help
```

## Build

```powershell
npm install
npm run typecheck
npm run build
```

## Usage

### 1) Configure your MCP host

EnriVision runs as an MCP server over `stdio`. Your MCP host is responsible for launching the process.

Example: global install

```jsonc
{
  "EnriVision": {
    "type": "stdio",
    "command": "enrivision",
    "args": [],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY",
      "ENRIVISION_DEFAULT_LANGUAGE": "es"
    }
  }
}
```

Example: no install (always uses whatever npm currently tags as `latest`)

```jsonc
{
  "EnriVision": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@bedolla/enrivision@latest"],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY",
      "ENRIVISION_DEFAULT_LANGUAGE": "es"
    }
  }
}
```

<details>
<summary>Use a local dev checkout</summary>

```jsonc
{
  "EnriVision": {
    "type": "stdio",
    "command": "node",
    "args": ["C:\\\\Users\\\\Administrator\\\\Projects\\\\EnriVision\\\\dist\\\\index.js"],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY",
      "ENRIVISION_DEFAULT_LANGUAGE": "es"
    }
  }
}
```

</details>

## Configuration

EnriVision is configured via environment variables:

- `ENRIPROXY_URL` (`string`, optional, default: `http://127.0.0.1:8787`)
- `ENRIPROXY_API_KEY` (`string`, required)
- `ENRIVISION_TIMEOUT_MS` (`string`, optional, default: `1800000`)
  - Parsed as an integer (milliseconds). Uploads are performed in chunks; this timeout applies per request.
- `ENRIVISION_DEFAULT_LANGUAGE` (`string`, optional)
  - Default language to send when the tool call does not provide `language`.

## MCP tools

EnriVision exposes this MCP tool:

- `analyze_media`

<details>
<summary>Tool inputs (option-by-option)</summary>

General notes:

- The tool accepts a single JSON object as its input (the MCP `arguments`).
- Exactly one of `path` or `paths` is required.
- Paths must be absolute on the machine running the MCP server.
- EnriVision does not accept per-call `server_url`/`api_key` overrides (these are configured via env vars).

### `analyze_media`

Inputs:

- `path` (`string`, optional): absolute local file path.
- `paths` (`string[]`, optional): absolute local image paths (useful for UI screenshot sets).
- `context` (`string`, optional): high-level hint (examples: `ui`, `diagram`, `chart`, `error`, `code`, `meeting`, `tutorial`, `photo`).
- `question` (`string`, optional): what you want to extract/answer.
- `language` (`string`, optional): preferred response language (ISO 639-1; e.g., `es`, `en`). If omitted, uses `ENRIVISION_DEFAULT_LANGUAGE` when set.
- `analysis_mode` (`string`, optional): `auto` | `single` | `multipass`.
- `max_frames` (`number`, optional): single-pass video frames (`1..20`).
- `transcribe` (`boolean`, optional): enable/disable transcription (videos).
- `transcription_language` (`string`, optional): whisper hint (`auto`, `es`, `en`, ...).

Video targeting:

- `video.clip_start_seconds` (`number`, optional)
- `video.clip_duration_seconds` (`number`, optional)

Multipass tuning (advanced; used only for `analysis_mode: multipass`):

- `video.segment_seconds` (`number`, optional)
- `video.max_segments` (`number`, optional)
- `video.max_frames_per_segment` (`number`, optional)
- `document.max_pages_total` (`number`, optional)
- `document.pages_per_batch` (`number`, optional)
- `document.max_images_per_batch` (`number`, optional)
- `document.scanned_text_threshold_chars` (`number`, optional)
- `audio.timestamps` (`boolean`, optional)
- `audio.segment_seconds` (`number`, optional)
- `audio.max_segments` (`number`, optional)
- `images.max_images_total` (`number`, optional)
- `images.images_per_batch` (`number`, optional)
- `images.max_dimension` (`number`, optional)

Output:

- `analysis` (`string`): model-produced analysis.
- `media_type` (`string`): detected media type (`video`, `audio`, `image`, `document`, `image_set`).
- `extraction` (`object`): safe metadata summary (internal routing details are stripped).

Example `arguments` object:

```jsonc
{
  "path": "C:\\\\path\\\\to\\\\video.mp4",
  "question": "What are the key steps demonstrated?",
  "analysis_mode": "auto",
  "transcribe": true,
  "language": "es"
}
```

</details>

<details>
<summary>Claude Code CLI Read(...) compatibility (reference)</summary>

Many MCP clients include a built-in `Read(...)` tool that can ingest local files and attach them to the model request.
This is convenient, but the set of supported formats is limited and can change across client versions.

If the file you need to analyze is not reliably supported by your client (for example `.avif`, `.heic`, `.svg`, videos,
audio, or Office documents), prefer EnriVision MCP so the client can upload bytes and EnriProxy can do extraction reliably.

</details>

<details>
<summary>Supported media types (by extension)</summary>

EnriProxy determines media type using content-type and extension allow-lists.

Videos:

- `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.m4v`, `.wmv`, `.flv`, `.3gp`, `.3g2`, `.ts`, `.mts`, `.m2ts`, `.mpeg`, `.mpg`, `.gif`

Audio:

- `.mp3`, `.mp1`, `.mp2`, `.mpa`, `.mpga`, `.wav`, `.aiff`, `.aif`, `.aifc`, `.caf`, `.flac`, `.m4a`, `.m4b`, `.m4r`, `.aac`, `.ogg`, `.oga`, `.wma`, `.opus`, `.weba`, `.mka`

Images:

- `.png`, `.apng`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.heic`, `.heif`, `.tiff`, `.tif`, `.bmp`, `.svg`, `.ico`

Documents:

- `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.jsonl`

</details>
