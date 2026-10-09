/**
 * ANALYZE MEDIA ALIAS RESOLUTION
 *
 * Pure helpers that pick one value among the accepted spellings of the same
 * knob (snake_case vs camelCase, flat vs nested) while refusing the silent
 * drops of the "hallucinated parameter" class: when two spellings of the
 * same knob arrive with DIFFERENT values the call fails (or warns for the
 * documented flat-over-nested precedence) instead of quietly discarding one.
 *
 * @module tools/AnalyzeMediaAliasResolution
 */

import { optionalNumber } from "../shared/validation.js";

/**
 * One accepted spelling of a knob with its raw value.
 */
export interface AliasCandidate {
  /**
   * Exact key spelling as it appeared in the tool arguments.
   */
  readonly key: string;

  /**
   * Raw value found under that key (undefined when absent).
   */
  readonly value: unknown;
}

/**
 * Result of the flat-over-nested precedence resolution.
 */
export interface FlatOverNestedResolution {
  /**
   * Winning candidate (flat when present, nested otherwise).
   */
  readonly winner: AliasCandidate | undefined;

  /**
   * Spanish-first bilingual honesty warning when both levels arrived with
   * different values and the documented flat-wins precedence applied.
   */
  readonly warning: string | null;
}

/**
 * Returns the first defined candidate, used for snake_case/camelCase and flat/nested aliases.
 *
 * @param candidates - Alias values in precedence order.
 * @returns First defined value or undefined when all are absent.
 */
export function firstDefined(...candidates: readonly unknown[]): unknown {
  for (const candidate of candidates) {
    if (typeof candidate !== "undefined") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Reports whether a parsed tuning object carries at least one defined knob.
 *
 * @param parsed - Parsed tuning object with optional knobs.
 * @returns True when at least one knob is defined.
 */
export function hasAnyValue(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some((value: unknown): boolean => typeof value !== "undefined");
}

/**
 * Compares two raw knob values for equality, tolerating numeric-string pairs.
 *
 * @remarks
 * Numeric strings (`"60"` vs `60`) count as equal so equal-value duplicate
 * spellings never fire the conflict guards, mirroring the EnriCode numeric
 * coercion. Non-numeric values compare as trimmed strings.
 *
 * @param left - First raw value.
 * @param right - Second raw value.
 * @returns True when both describe the same number or the same trimmed string.
 */
export function aliasValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  const leftNumber: number | undefined = optionalNumber(left);
  const rightNumber: number | undefined = optionalNumber(right);
  if (typeof leftNumber !== "undefined" && typeof rightNumber !== "undefined") {
    return leftNumber === rightNumber;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.trim() === right.trim();
  }
  return false;
}

/**
 * Resolves one knob among its same-level accepted spellings.
 *
 * @remarks
 * Absent spellings are skipped. Two present spellings with the SAME value
 * (including `"60"` vs `60`) resolve to that value. Two present spellings
 * with DIFFERENT values fail: the model must never believe it sent one
 * budget while the parser silently applied another.
 *
 * @param fieldName - Canonical dotted field name for error messages.
 * @param candidates - Accepted spellings with their raw values.
 * @returns Winning candidate, or undefined when every spelling is absent.
 * @throws Error with a Spanish-first bilingual message when two spellings carry different values.
 */
export function resolveAliasedCandidate(
  fieldName: string,
  candidates: readonly AliasCandidate[],
): AliasCandidate | undefined {
  const present: AliasCandidate[] = candidates.filter(
    (candidate: AliasCandidate): boolean => typeof candidate.value !== "undefined",
  );
  if (present.length === 0) {
    return undefined;
  }
  const winner: AliasCandidate = present[0]!;
  for (const other of present.slice(1)) {
    if (!aliasValuesEqual(winner.value, other.value)) {
      throw new Error(
        `Se recibieron valores distintos para el mismo parámetro ${fieldName} (${winner.key}=${formatAliasValue(winner.value)}, ${other.key}=${formatAliasValue(other.value)}): mande solo un spelling. / Conflicting values for the same parameter ${fieldName} (${winner.key}=${formatAliasValue(winner.value)}, ${other.key}=${formatAliasValue(other.value)}): send a single spelling.`
      );
    }
  }
  return winner;
}

/**
 * Applies the documented flat-over-nested precedence for one knob.
 *
 * @remarks
 * A flat value wins over the nested one (documented in the tool schema), so
 * differing values do not fail; instead the resolution carries a Spanish
 * honesty warning so the model learns which value actually applied. Equal
 * values (and absent flats or nesteds) resolve silently.
 *
 * @param fieldName - Canonical dotted field name for warning messages.
 * @param flat - Winning flat-level candidate (undefined value when absent).
 * @param nested - Winning nested-level candidate (undefined value when absent).
 * @returns Winning candidate plus the honesty warning when precedence applied.
 */
export function resolveFlatOverNestedCandidate(
  fieldName: string,
  flat: AliasCandidate,
  nested: AliasCandidate,
): FlatOverNestedResolution {
  if (typeof flat.value === "undefined") {
    return { winner: nested.value === undefined ? undefined : nested, warning: null };
  }
  if (typeof nested.value !== "undefined" && !aliasValuesEqual(flat.value, nested.value)) {
    return {
      winner: flat,
      warning:
        `${fieldName}: tanto ${flat.key}=${formatAliasValue(flat.value)} (plano) como ${nested.key}=${formatAliasValue(nested.value)} (anidado) están presentes y difieren: gana el plano ${flat.key}=${formatAliasValue(flat.value)} (contrato documentado: el plano gana sobre el anidado). / ` +
        `${fieldName}: both ${flat.key}=${formatAliasValue(flat.value)} (flat) and ${nested.key}=${formatAliasValue(nested.value)} (nested) are present and differ: the flat ${flat.key}=${formatAliasValue(flat.value)} wins (documented contract: flat wins over nested).`,
    };
  }
  return { winner: flat, warning: null };
}

/**
 * Formats one raw alias value for conflict messages.
 *
 * @param value - Raw knob value.
 * @returns Compact printable representation.
 */
function formatAliasValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return typeof value;
}
