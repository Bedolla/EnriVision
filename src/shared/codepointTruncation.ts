/**
 * CODE-POINT TRUNCATION
 *
 * Single-pass, bounded-memory truncation helpers for model-facing text.
 * Analysis payloads can reach tens of MiB, so `Array.from(text)` (one full
 * array per call, sometimes three per payload) is an OOM-shaped cost paid
 * only to keep a few tens of KiB. These helpers walk the string once with
 * `for..of` (code-point iteration, never splitting surrogates) while
 * retaining at most `head + tail` characters plus a running total.
 *
 * @module shared/codepointTruncation
 */

/**
 * Result of a single-pass code-point truncation.
 */
export interface CodePointTruncation {
  /**
   * Kept head characters (up to the requested head budget).
   */
  readonly head: string;

  /**
   * Kept tail characters (up to the requested tail budget, in order).
   */
  readonly tail: string;

  /**
   * Head plus tail (the bounded text to forward).
   */
  readonly text: string;

  /**
   * Total code points observed in the input.
   */
  readonly totalChars: number;

  /**
   * True when input exceeded the head + tail budget.
   */
  readonly truncated: boolean;
}

/**
 * Truncates text to a head budget in a single pass with O(budget) memory.
 *
 * @param value - Raw text.
 * @param maxChars - Maximum code points kept from the start.
 * @returns Truncation result.
 */
export function truncateCodePointsHead(value: string, maxChars: number): CodePointTruncation {
  return truncateCodePointsHeadTail(value, maxChars, 0);
}

/**
 * Truncates text keeping head and tail in a single pass with O(budget) memory.
 *
 * @remarks
 * Keeping the tail preserves conclusions that head-only truncation drops.
 * When the input fits the combined budget the original reference is
 * returned untouched (`truncated: false`) so callers can rely on
 * passthrough.
 *
 * @param value - Raw text.
 * @param headChars - Code points kept at the start.
 * @param tailChars - Code points kept at the end.
 * @returns Truncation result.
 */
export function truncateCodePointsHeadTail(
  value: string,
  headChars: number,
  tailChars: number,
): CodePointTruncation {
  const headLimit: number = Math.max(0, Math.floor(headChars));
  const tailLimit: number = Math.max(0, Math.floor(tailChars));
  const head: string[] = [];
  const tail: string[] = [];
  let tailStart = 0;
  let total = 0;
  for (const point of value) {
    total += 1;
    if (head.length < headLimit) {
      head.push(point);
      continue;
    }
    if (tailLimit === 0) {
      continue;
    }
    if (tail.length < tailLimit) {
      tail.push(point);
      continue;
    }
    tail[tailStart] = point;
    tailStart = (tailStart + 1) % tailLimit;
  }
  if (total <= headLimit + tailLimit) {
    return { head: value, tail: "", text: value, totalChars: total, truncated: false };
  }
  const headText: string = head.join("");
  let tailText = "";
  if (tail.length > 0) {
    tailText =
      tail.length < tailLimit
        ? tail.join("")
        : [...tail.slice(tailStart), ...tail.slice(0, tailStart)].join("");
  }
  return { head: headText, tail: tailText, text: headText + tailText, totalChars: total, truncated: true };
}
