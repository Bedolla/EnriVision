# EnriVision Changelog

All notable changes to EnriVision are documented in this file.

## 2026-08-24
### Changed
- Every model-facing string is now Spanish, matching the monorepo convention: the full `analyze_media` description (usage rules, when-to-use list) and every parameter description across the schema (`path`, `paths`, `context`, `question`, `language`, `max_frames`, `transcribe`, `transcription_language`, `analysis_mode`, and the `video`/`document`/`audio`/`images` tuning objects), plus tool validation errors, upload/analysis errors, the unknown-tool server message, and the output envelope (`ANÁLISIS (tipo):`). Wire field names and the EnriProxy contract are unchanged.
- The tool description now carries UI-screenshot debugging guidance mirroring EnriProxy's vision system prompt: for application captures, open with a one-line verdict, describe zone by zone (header/sidebar/content/modals/notifications), approximate colors as hex and flag inconsistencies, quantify layout defects (overflow, clipping, overlap, misalignment, cut-off text) with pixel estimates, transcribe visible labels/errors verbatim, and compare observed vs expected when the caller stated an expectation — so non-Enri clients (OpenCode/Codex CLI with third-party models) get the same UI-debugging quality without EnriCode's coaching.
### Testing
- Ran: `npm test` (OK) - 3 files, 8 tests.
- Ran: `npm run typecheck` and `npm run build` (OK).

## 2026-06-19
### Changed
- Bumped package version to `0.1.1` for npm publishing.
- Aligned the package Node.js engine requirement with the Enri runtime standard (`>=24`).
- Updated the `analysis_mode` MCP schema with the explicit enum accepted by EnriProxy (`auto`, `single`, `multipass`).
### Testing
- Ran: `npm test` (OK) - 3 files, 8 tests.
- Ran: `npm run build` (OK).

## 2026-01-13
### Tests
- Added a regression test to ensure EnriVision strips internal extraction fields (e.g., `multipass`, `model`, and upload/routing identifiers) before returning tool output.

## 2026-01-12
### Docs
- Documented Claude Code CLI `Read(...)` supported formats as a compatibility reference, clarifying when EnriVision MCP is required (unsupported images, video/audio, and larger/binary inputs).

## 2026-01-08
### Changed
- EnriProxy `/v1/vision/analyze` responses no longer include internal provider model identifiers or multipass routing details; EnriVision tool output remains safe and minimal.
- Added `extraction.timeline` for audio/video analyses and kept optional `extraction.segment_summaries` for multipass timelines.
- Raised EnriVision Node.js engine requirement to `>= 24` (aligned with the Enri monorepo standard).
### Improved
- Animated image key frame selection now prioritizes visually distinct frames (scene-change heuristic) for GIF/WebP/APNG.

## 2026-01-07
### Added
- Animated SVG/APNG uploads now produce representative key frames via EnriProxy for analysis.
- Audio uploads now recognize additional common extensions (AIFF/CAF/M4B/M4R/OGA/WEBA/MKA/MP1/MP2/MPA/MPGA).
- Added video clip window parameters (`video.clip_start_seconds`, `video.clip_duration_seconds`) for time-targeted analysis.
### Changed
- Updated npm publishing references to use the @bedolla/enrivision scope and refreshed README examples.
- Removed per-call server_url/api_key/timeout_ms overrides from MCP schema, tool parsing, and docs.
- Clarified animated GIF/WebP support in EnriVision tool descriptions and README.
- Refined README wording around upload size defaults and PDF truncation risk.
### Tests
- Added request payload tests for EnriVision's EnriProxy client (upload session + analyze payloads).
