# EnriVision Status

Last Updated: 2026-01-13

## Current State
- EnriVision is a client-side MCP server (npm: `@bedolla/enrivision`) exposing a single tool: `analyze_media`.
- `analyze_media` uploads local file bytes to EnriProxy via resumable uploads (`/v1/uploads`) and triggers server-side analysis (`/v1/vision/analyze`).
- Supports both single-file analysis (`path`) and multi-image analysis (`paths[]`). When `paths[]` is used, EnriVision uploads a single tar archive (`application/vnd.enrivision.media-set+tar`) to avoid per-key concurrent upload-session limits.
- Supports multipass tuning via tool parameters (`analysis_mode`, `video`, `document`, `images`) while keeping client-side work limited to streaming bytes (no local ffmpeg/Whisper).
- Video clip targeting is supported via `video.clip_start_seconds` + `video.clip_duration_seconds` for time-specific questions.
- Requires an EnriProxy API key configured in `EnriProxy/config.json` under `auth.api_key_policy.keys[*].key`.
- Tool output is intentionally minimal and safe for model consumption. EnriVision strips internal fields (upload ids, detected media type, analysis mode fields, and any multipass/model internals) from extraction metadata.
- For audio/video analyses, EnriProxy now returns a dedicated `extraction.timeline` object and optional `extraction.segment_summaries` (when multipass is used) without exposing provider/model identifiers.
- Optional: `ENRIVISION_DEFAULT_LANGUAGE` can be set to reduce language drift when the model does not pass `language` (for example, default to `es`).
- The example Claude Code CLI config in `EnriVision/README.md` includes `ENRIVISION_DEFAULT_LANGUAGE="es"` for Spanish-first workflows.
- `EnriVision/README.md` documents Claude Code CLI `Read(...)` supported formats as a compatibility reference to clarify when EnriVision MCP is required.
- The tool description explicitly recommends EnriVision for large/scanned PDFs to encourage models to prefer it over client-side Read when coverage matters.
- Animated GIF/WebP/APNG/SVG uploads are supported; EnriProxy extracts representative key frames for analysis.
- Audio uploads recognize additional common extensions (AIFF/CAF/M4B/M4R/OGA/WEBA/MKA/MP1/MP2/MPA/MPGA).
- README is aligned for npm/GitHub publishing under `@bedolla/enrivision` with updated installation, configuration, and accuracy notes (Node.js >= 24).
- MCP tool schema no longer exposes per-call `server_url`, `api_key`, or `timeout_ms` overrides.

## Testing
- Ran: `npm run build` (OK).
- Ran: `npm test` (OK) - 3 files, 8 tests.
