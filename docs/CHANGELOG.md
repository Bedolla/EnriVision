# Changelog (EnriVision)

## 0.1.7 (2026-09-18) — auditoría r1 vs endpoints de media de EnriProxy

Implementados los 10 hallazgos de la auditoría contra los endpoints reales de EnriProxy (`/v1/vision/analyze`, `/v1/vision/segments`, `/v1/uploads`, `/v1/account/models`). 0 rupturas, 5 de superficie y 5 de higiene:

- **anyOf con cursor**: el inputSchema ahora acepta llamadas cursor-only (`{required:["cursor"]}`) que la propia descripción documenta (modo continuación), además de path/paths.
- **env correcto**: la descripción del tool decía `ENRIVISION_API_KEY`; el env real que lee `index.ts` es `ENRIPROXY_API_KEY` — corregido en ES/EN (test de invariantes lo clava).
- **errores por código estable**: nuevo `extractServerErrorInsight` parsea `code`/`field` que emite el proxy (vocabulario `invalid_<root>` + campo punteado); `EnriProxyHttpError` los preserva (`serverCode`/`serverField`), el detalle de error incluye `[campo/field: video.clip_duration_seconds]` y `mapToolError` clasifica `invalid_*` → `ENRICODE_ERR_TOOL_INPUT_INVALID` por código (antes de prose regex; `readHttpStatus` ahora ignora statuses no-HTTP como 0 para no enmascarar el código).
- **limit de continuación**: `limit` (1-100, entero) expuesto en schema + parser (`TOP_LEVEL_KNOWN_KEYS` + `parseContinuationLimit` con errores bilingües) + contrato (`continuationLimit`) + `executeContinuation` → wire de `/v1/vision/segments`.
- **README honesto**: quitado `.jsonl` (mime-types no lo mapea; el resolver lo rechaza), documentados `region`, `cursor`/`offset`/`limit`, `model`, `video.clip_end_seconds`, la escalada `source_url` para URLs solitarias >64 MiB y la subida local reanudable hasta 4 GiB.
- **offset integer-only**: el schema declaraba `["number","string"]` pero parser y proxy rechazan strings — ahora `type: "integer"`.
- **docstring del client**: lista completa de endpoints usados (añadidos DELETE `/v1/uploads/:id`, POST `/v1/vision/segments`, GET `/v1/account/models`).
- **model/request_id tipados y proyectados**: `AnalyzeVisionResponse.model`/`request_id` y `extraction.model_used`/`extraction.request_id` (el modelo efectivo del dispatch queda visible).
- **`\n` faltante** entre secciones "Ejemplos mínimos" y "Continuación" de la descripción.

Tests: suite 326→332 (6 nuevos en `EnriVisionAuditR1`: limit parsing, insight anidado/top-level, clasificación por código sin status, contract de model/request_id, invariantes de schema/env). Typecheck + build limpios. Instalación global reinstalada desde el checkout (0.1.7).
