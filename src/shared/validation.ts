/**
 * VALIDATION HELPERS
 *
 * Small, dependency-free runtime validation utilities for MCP tool inputs and
 * server responses.
 *
 * @module shared/validation
 */

/**
 * Asserts that a value is a non-null object (but not an array).
 *
 * @param value - Value to validate
 * @param name - Human-readable field name for error messages
 * @returns The value as a record
 */
export function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} debe ser un objeto. / ${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Asserts that a value is a non-empty string.
 *
 * @param value - Value to validate
 * @param name - Human-readable field name for error messages
 * @returns Trimmed string
 */
export function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} debe ser una cadena de texto. / ${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} debe ser una cadena de texto no vacía. / ${name} must be a non-empty string.`);
  }
  return trimmed;
}

/**
 * Returns a trimmed string when the value is a string, otherwise undefined.
 *
 * @param value - Value to validate
 * @returns Trimmed string or undefined
 */
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns an integer when the value is an integer number or an integer
 * numeric string, otherwise undefined.
 *
 * @remarks
 * Strict by design: fractional numbers (`7.9`) and fractional strings
 * (`"7.9"`) are rejected (undefined) so callers fail with a Spanish
 * coaching error instead of silently flooring to `7`.
 *
 * @param value - Value to validate
 * @returns Parsed integer or undefined
 */
export function optionalInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed: string = value.trim();
    if (!/^[+-]?\d+$/u.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Returns a number when the value is a number or a complete numeric string, otherwise undefined.
 *
 * @remarks
 * Strict by design: partial numerics (`"12:34"`, `"754s"`, `"1e"`) and
 * exponent spellings (`"1e3"`) are rejected (undefined) so callers fail
 * with a Spanish coaching error instead of silently parsing a prefix
 * (`parseFloat("12:34") === 12`). Mirrors the anchored-string policy of
 * {@link optionalFraction} and {@link optionalInt} plus EnriCode
 * `coerceCompleteNumber` and the proxy `requireValidFloat`/`requireValidInt`.
 *
 * @param value - Value to validate
 * @returns Parsed number or undefined
 */
export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed: string = value.trim();
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/u.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Returns a trimmed string when present, failing on non-string values.
 *
 * @remarks
 * Strict by design: when the key exists (anything but `undefined`) with a
 * non-string value (`123`, `{}`, `null`), callers get a Spanish coaching
 * error instead of silently dropping the value (which hides model mistakes
 * such as `language: 5`). Absent keys stay `undefined`; blank strings
 * collapse to `undefined`.
 *
 * @param value - Raw field value.
 * @param fieldName - Dotted field name for error messages.
 * @returns Trimmed string or undefined when absent/blank.
 * @throws Error with an Spanish-first bilingual message when present but not a string.
 */
export function assertOptionalString(value: unknown, fieldName: string): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} debe ser una cadena de texto. / ${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns a boolean when the value is a boolean, otherwise undefined.
 *
 * @remarks
 * Strict by design: truthy strings such as `"true"` are NOT coerced and
 * return undefined so callers can fail with a Spanish coaching error.
 *
 * @param value - Value to validate
 * @returns Boolean or undefined
 */
export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Validates an optional boolean knob, accepting booleans plus `"true"`/`"false"` strings.
 *
 * @remarks
 * Small-model parity with EnriCode `readOptionalBoolean`: `"true"` and
 * `"false"` (trimmed, case-insensitive) coerce; every other present value
 * fails in Spanish (`"yes"`, `1`, `{}` never coerce silently).
 *
 * @param value - Raw knob value.
 * @param fieldName - Dotted field name for error messages.
 * @returns Boolean or undefined when absent.
 * @throws Error with an Spanish-first bilingual message when present but not a boolean nor a true/false string.
 */
export function assertOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized: string = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  throw new Error(`${fieldName} debe ser un booleano (true o false; también vale "true"/"false"). / ${fieldName} must be a boolean (true or false; "true"/"false" also work).`);
}

/**
 * Parses a relative [0,1] fraction from a number or a complete numeric string.
 *
 * @remarks
 * Strict by design: booleans, empty strings, and partial numerics are
 * rejected instead of being coerced (`Number(true) === 1`).
 *
 * @param value - Raw fraction value.
 * @returns Parsed finite number or undefined when unparseable.
 */
export function optionalFraction(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed: string = value.trim();
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/u.test(trimmed)) {
      return undefined;
    }
    const parsed: number = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Builds the shared Spanish-first bilingual honesty warning for one clamped clip window.
 *
 * @remarks
 * Single builder for the parser and the direct-client backstop so both surfaces
 * declare the exact analyzed window with identical wording. The Spanish half keeps
 * the `La ventana pedida (inicio …) … se recortó la duración` prefix family shared with
 * EnriCode `buildClipWindowClampedWarning` (`La ventana del clip pedida … recortó`),
 * so es-MX parity fixtures keep matching on both sides.
 *
 * @param startSeconds - Effective analyzed window start in seconds.
 * @param requestedDurationSeconds - Requested window duration in seconds (before clamping).
 * @param clampedDurationSeconds - Analyzed window duration in seconds (after clamping).
 * @param maxSeconds - Clip-window cap in seconds (86400, 24 h).
 * @returns Spanish-first bilingual warning naming the requested and analyzed windows.
 */
export function buildClipWindowClampedWarning(
  startSeconds: number,
  requestedDurationSeconds: number,
  clampedDurationSeconds: number,
  maxSeconds: number,
): string {
  const requestedEnd: number = startSeconds + requestedDurationSeconds;
  const english: string =
    `Requested clip window (start ${String(startSeconds)} s + duration ${String(requestedDurationSeconds)} s = end ${String(requestedEnd)} s)` +
    ` exceeds the 24 h limit: trimmed duration to ${String(clampedDurationSeconds)} s (end ${String(maxSeconds)} s).`;
  const spanish: string =
    `La ventana pedida (inicio ${String(startSeconds)} s + duración ${String(requestedDurationSeconds)} s = fin ${String(requestedEnd)} s)` +
    ` excede el límite de 24 h: se recortó la duración a ${String(clampedDurationSeconds)} s (fin ${String(maxSeconds)} s).`;
  return `${spanish} / ${english}`;
}

/**
 * Resolves a timeout override from a raw environment string.
 *
 * @remarks
 * Strict by design: only `^\d+$` with a value `> 0` is accepted. Anything
 * else present (`"30s"`, `"1e4"`, `"0"`, `"-5"`) falls back to
 * `fallbackMs` with a bilingual stderr warning instead of silently using a
 * garbage budget (`parseInt("30s") === 30`).
 *
 * @param raw - Raw environment value (already trimmed, may be empty).
 * @param envName - Environment variable name for the warning.
 * @param fallbackMs - Fallback timeout in milliseconds.
 * @returns Resolved timeout plus a Spanish warning, or null when clean.
 */
export function resolveTimeoutMs(
  raw: string,
  envName: string,
  fallbackMs: number,
): { readonly timeoutMs: number; readonly warning: string | null } {
  if (!raw) {
    return { timeoutMs: fallbackMs, warning: null };
  }
  if (/^\d+$/u.test(raw)) {
    const parsed: number = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return { timeoutMs: parsed, warning: null };
    }
  }
  return {
    timeoutMs: fallbackMs,
    warning: `${envName} inválido ('${raw}'); se usa ${String(fallbackMs)}ms. / ${envName} invalid ('${raw}'); using ${String(fallbackMs)}ms.`,
  };
}

/**
 * Asserts that a string looks like an HTTP(S) URL.
 *
 * @param value - Value to validate
 * @param name - Field name
 * @returns Normalized URL string
 */
export function assertHttpUrl(value: unknown, name: string): string {
  const url = assertNonEmptyString(value, name);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`${name} debe comenzar con http:// o https://. / ${name} must start with http:// or https://.`);
  }
  return url.replace(/\/+$/, "");
}
