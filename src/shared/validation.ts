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
    throw new Error(`${name} must be an object.`);
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
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must be a non-empty string.`);
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
 * Returns an integer when the value is a number or numeric string, otherwise undefined.
 *
 * @param value - Value to validate
 * @returns Parsed integer or undefined
 */
export function optionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Returns a number when the value is a number or numeric string, otherwise undefined.
 *
 * @param value - Value to validate
 * @returns Parsed number or undefined
 */
export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Returns a boolean when the value is a boolean, otherwise undefined.
 *
 * @param value - Value to validate
 * @returns Boolean or undefined
 */
export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
    throw new Error(`${name} must start with http:// or https://`);
  }
  return url.replace(/\/+$/, "");
}
