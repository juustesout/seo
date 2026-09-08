/**
 * Shared strict-JSON helpers for the writer AI boundaries (W4+). Model replies
 * are never trusted until they have been reduced to a bare JSON object and
 * Zod-validated at the owning boundary (planner / section writer). These two
 * helpers only normalise the transport formatting some models add around JSON.
 */

/** Strip a single markdown code fence (```json ... ```) some models add
 *  around JSON even when told not to, so parsing only ever sees the object. */
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
}

/** Parses model text into a plain object; returns null when it is not JSON. */
export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text)) as unknown;
  } catch {
    return null;
  }
}
