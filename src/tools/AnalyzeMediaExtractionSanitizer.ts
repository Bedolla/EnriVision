/**
 * ANALYZE MEDIA EXTRACTION SANITIZER
 *
 * Strips routing-only internals from the EnriProxy extraction payload before
 * it reaches the model. Only upload identifiers, provider-routing identities,
 * and secret-bearing keys are removed: coverage metadata that EnriProxy
 * intentionally returns (`detected_media_type`, `analysis_mode_*`,
 * `multipass`, `models`, `strategy`, `warnings`, `frame_count`, `timeline`)
 * is preserved so the model can report honest coverage (missing frames).
 *
 * Key matching is separator-insensitive (`-`, `_`, `.` stripped): hyphenated
 * spellings such as `api-key` or `access-token` match like `api_key`.
 *
 * @module tools/AnalyzeMediaExtractionSanitizer
 */

/**
 * Internal-only extraction keys stripped at any depth (case-insensitive,
 * separator-insensitive: matched against the separator-stripped form).
 *
 * @remarks
 * Covers upload identifiers, provider-routing identities, secret-bearing
 * token variants (`api_key`, `secret`, `refresh_token`, `access_token`,
 * `auth_token`, `id_token`, bare `token`), and bare bearer material (`jwt`,
 * `jwk` plus suffixed variants). Coverage and accounting keys such as
 * `multipass`, `detected_media_type`, `analysis_mode_*`, `models`,
 * `strategy`, `warnings`, `frame_count`, `timeline`, and the OpenAI usage
 * block (`prompt_tokens`, `completion_tokens`, `total_tokens`, …) are
 * explicitly preserved (see {@link PRESERVED_KEYS} and the accounting set).
 */
const STRIPPED_KEY_PATTERN: RegExp =
  /^(uploadids?.*|provider.*|apikeys?.*|secrets?.*|refreshtokens?.*|accesstokens?.*|authtokens?.*|idtokens?.*|jwts?.*|jwks?.*|tokens?)$/iu;

/**
 * Internal routing identifiers that never reach the model.
 *
 * @remarks
 * The anchored pattern above requires a literal `id` after `upload_`, so
 * `upload_url` would survive it; session/trace ids are plausible server
 * internals too. Listed explicitly (case-insensitive) instead.
 */
const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  "sessionid",
  "clienttraceid",
  "traceid",
  "uploadurl",
  "requestid",
]);

/**
 * Secret-material suffixes stripped at any depth (case-insensitive).
 *
 * @remarks
 * The anchored pattern misses prefixed secrets (`client_secret`,
 * `my_api_key`) and bearer/authorization material, all of which would
 * otherwise reach the model. Matched as a suffix so `monkey`-style false
 * positives cannot strip legitimate metadata.
 */
const SECRET_SUFFIX_PATTERN: RegExp = /(password|passwd|bearer|authorization|authentication|nonce|signature)$/iu;

/**
 * Coverage/accounting keys that must survive sanitization even though an
 * older broader pattern used to strip them.
 */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([
  "multipass",
  "detected_media_type",
  "analysis_mode",
  "analysis_mode_requested",
  "analysis_mode_used",
  "models",
  "model",
  "strategy",
  "warnings",
  "frame_count",
  "timeline",
]);

/**
 * Legitimate accounting/metadata keys that must survive sanitization even
 * though they contain the substring `token`.
 *
 * @remarks
 * Covers the standard OpenAI-compatible usage block (`prompt_tokens`,
 * `completion_tokens`, `total_tokens`, `input_tokens`, `output_tokens`) plus
 * reasoning/cache variants. Compared in separator-stripped form (see
 * {@link normalizeSanitizerKey}) so hyphenated spellings (`prompt-tokens`)
 * and vendor-prefixed variants (`response_input_tokens`) survive too.
 */
const ACCOUNTING_KEYS: ReadonlySet<string> = new Set([
  "tokenusage",
  "tokensused",
  "tokencount",
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "inputtokens",
  "outputtokens",
  "reasoningtokens",
  "cachetokens",
]);

/**
 * Normalizes one extraction key for separator-insensitive matching.
 *
 * @remarks
 * Strips `-`, `_`, and `.` after lowercasing so hyphenated secrets
 * (`api-key`, `access-token`, `provider-id`, `client-secret`, `upload-ids`)
 * match the same anchored and suffix rules as their underscored spellings.
 *
 * @param key - Raw extraction key.
 * @returns Lowercased key without `-`, `_`, or `.` characters.
 */
function normalizeSanitizerKey(key: string): string {
  return key.toLowerCase().replace(/[-_.]/gu, "");
}
/**
 * Reports whether one separator-stripped key is legitimate usage accounting.
 *
 * @remarks
 * Exact match covers the standard OpenAI-compatible usage block; the
 * ends-with rule additionally preserves vendor-prefixed variants (for
 * example `response_input_tokens` → `responseinputtokens`). Preservation is
 * the fail-open direction here only because every accounting token is a
 * known usage-counter suffix, never a secret shape.
 *
 * @param normalizedKey - Separator-stripped lowercased key (see {@link normalizeSanitizerKey}).
 * @returns True when the key is accounting and must survive sanitization.
 */
function isAccountingKey(normalizedKey: string): boolean {
  if (ACCOUNTING_KEYS.has(normalizedKey)) {
    return true;
  }
  for (const token of ACCOUNTING_KEYS) {
    if (normalizedKey.length > token.length && normalizedKey.endsWith(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Object keys that must never be assigned (prototype pollution guard).
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Sanitizes EnriProxy extraction payloads for model consumption.
 */
export class AnalyzeMediaExtractionSanitizer {
  /**
   * Removes internal identifiers from the extraction payload.
   *
   * @param extraction - Raw extraction object returned by EnriProxy.
   * @returns Sanitized plain extraction object.
   */
  public sanitize(extraction: Record<string, unknown>): Record<string, unknown> {
    const stripped: unknown = this.stripInternalFields(extraction);
    if (stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
      return stripped as Record<string, unknown>;
    }
    return {};
  }

  /**
   * Recursively strips internal fields from an unknown value.
   *
   * @param value - Unknown value to sanitize.
   * @returns Sanitized value.
   */
  private stripInternalFields(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripInternalFields(item));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (UNSAFE_KEYS.has(key)) {
        continue;
      }
      const lowered: string = key.toLowerCase();
      if (PRESERVED_KEYS.has(lowered)) {
        next[key] = this.stripInternalFields(child);
        continue;
      }
      // Separator-insensitive matching (F10): hyphens, underscores, and dots
      // are stripped before every rule below, so `api-key`, `access-token`,
      // `provider-id`, `client-secret`, and `upload-ids` match exactly like
      // their underscored spellings. Accounting is checked first so usage
      // counters (including hyphenated and vendor-prefixed variants) survive
      // the `token` suffix sweep.
      const normalized: string = normalizeSanitizerKey(key);
      if (isAccountingKey(normalized)) {
        next[key] = this.stripInternalFields(child);
        continue;
      }
      if (STRIPPED_KEY_PATTERN.test(normalized)) {
        continue;
      }
      if (INTERNAL_KEYS.has(normalized)) {
        continue;
      }
      // Substring/suffix secret sweep. Catches prefixed secrets the anchored
      // pattern misses (`client_secret`, `my_token`) plus bare `jwt`/`jwk`
      // bearer material and request-signing leftovers (`nonce`, `signature`).
      if (
        normalized.includes("secret") ||
        normalized.includes("apikey") ||
        normalized.includes("privatekey") ||
        normalized.includes("credential") ||
        normalized.includes("password") ||
        normalized.includes("passwd") ||
        /tokens?$/u.test(normalized) ||
        SECRET_SUFFIX_PATTERN.test(normalized)
      ) {
        continue;
      }
      next[key] = this.stripInternalFields(child);
    }

    return next;
  }
}
