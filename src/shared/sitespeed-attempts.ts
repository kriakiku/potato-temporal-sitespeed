/**
 * Max Temporal activity attempts for `runSitespeed`.
 * At workflow-bundle time the worker replaces `process.env.SITESPEED_MAX_ATTEMPTS`
 * via webpack DefinePlugin (default `"1"`). Do not read other env vars here.
 */
export function sitespeedActivityMaxAttempts(): number {
  const raw = process.env.SITESPEED_MAX_ATTEMPTS;
  const n = Number(raw ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
