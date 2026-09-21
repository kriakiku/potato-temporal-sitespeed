/**
 * Generate a browsertime multi/journey script: open URL, inject CSS to hide
 * `[data-test-id="fullScreen"]` (no wait / no click), then pageCompleteCheck.
 *
 * Important: do NOT use `commands.navigate(url)` before the hide. That API always
 * runs pageCompleteCheck before returning. Open with raw `driver.get`, inject
 * style, then `wait.byPageToComplete()` so metrics still settle before stop.
 *
 * Warm cache is handled outside this script (second sitespeed run with a shared
 * Chrome user-data-dir after POST /v1/stats/reset).
 *
 * Right after driver.get, installs a non-blocking iframe probe
 * (`window.__potatoFirstIframeMs`) so `--browsertime.script` can read the
 * timing after pageComplete without waiting.
 */
export type MeasureJourneyInput = {
  url: string;
  /** Passed to commands.measure.start (urlAlias / result name) */
  alias: string;
};

const FULLSCREEN_SELECTOR = '[data-test-id="fullScreen"]';

/** Browser-side snippet: inject a style tag that hides the fullscreen control. */
export function buildFullscreenHideJs(): string {
  const css = `${FULLSCREEN_SELECTOR}{display:none!important}`;
  return [
    "var s=document.createElement('style');",
    "s.setAttribute('data-potato-hide-fullscreen','1');",
    `s.textContent=${JSON.stringify(css)};`,
    "document.documentElement.appendChild(s);",
    "return true;",
  ].join("");
}

/**
 * Non-blocking iframe probe: records ms-since-navigation into
 * `window.__potatoFirstIframeMs` via MutationObserver. Returns immediately.
 * Shared measure logic with scripts/bt-first-iframe.js (Resource Timing, else now).
 */
export function buildFirstIframeProbeJs(): string {
  return [
    "if (window.__potatoIframeProbe) return true;",
    "window.__potatoIframeProbe = true;",
    "window.__potatoFirstIframeMs = -1;",
    "function measureIframeMs(iframe) {",
    "  if (!iframe) return -1;",
    "  var src = (iframe.src || iframe.getAttribute('src') || '').split(/[?#]/)[0];",
    "  var best = -1;",
    "  var entries = performance.getEntriesByType('resource');",
    "  for (var i = 0; i < entries.length; i++) {",
    "    var e = entries[i];",
    "    var isIframe = e.initiatorType === 'iframe' ||",
    "      (src && typeof e.name === 'string' && e.name.indexOf(src) === 0);",
    "    if (!isIframe) continue;",
    "    if (best < 0 || e.startTime < best) best = e.startTime;",
    "  }",
    "  if (best >= 0) return Math.round(best);",
    "  return Math.round(performance.now());",
    "}",
    "function tryFind() {",
    "  return measureIframeMs(document.querySelector('iframe'));",
    "}",
    "function note(ms) {",
    "  if (typeof ms === 'number' && ms >= 0 && window.__potatoFirstIframeMs < 0) {",
    "    window.__potatoFirstIframeMs = ms;",
    "    try { obs.disconnect(); } catch (_) {}",
    "  }",
    "}",
    "var obs = new MutationObserver(function () { note(tryFind()); });",
    "try {",
    "  obs.observe(document.documentElement || document.body, { childList: true, subtree: true });",
    "} catch (_) {}",
    "note(tryFind());",
    "return true;",
  ].join("");
}

export function buildMeasureJourneyScript(input: MeasureJourneyInput): string {
  const hideJs = buildFullscreenHideJs();
  const probeJs = buildFirstIframeProbeJs();
  return `/**
 * Auto-generated browsertime journey (do not edit by hand).
 * Measure ${JSON.stringify(input.alias)}; hide ${FULLSCREEN_SELECTOR} via injected CSS.
 * Opens via driver.get so the hide runs before pageCompleteCheck.
 * Installs non-blocking first-iframe probe right after navigation.
 */
module.exports = async function (context, commands) {
  var url = ${JSON.stringify(input.url)};
  var alias = ${JSON.stringify(input.alias)};
  var selector = ${JSON.stringify(FULLSCREEN_SELECTOR)};
  var driver = context.selenium && context.selenium.driver;
  if (!driver || typeof driver.get !== "function") {
    throw new Error("context.selenium.driver unavailable");
  }

  await commands.measure.start(alias);
  // Skip commands.navigate — it blocks on pageCompleteCheck before we can hide.
  await driver.get(url);

  try {
    await commands.js.run(${JSON.stringify(probeJs)});
    context.log.info("Installed first-iframe probe");
  } catch (e) {
    context.log.info(
      "Failed to install first-iframe probe: " +
        (e && e.message ? e.message : String(e)) +
        "; continuing"
    );
  }

  try {
    await commands.js.run(${JSON.stringify(hideJs)});
    context.log.info("Injected CSS hide for " + selector);
  } catch (e) {
    context.log.info(
      "Failed to inject fullscreen hide CSS: " +
        (e && e.message ? e.message : String(e)) +
        "; continuing"
    );
  }

  if (commands.wait && typeof commands.wait.byPageToComplete === "function") {
    await commands.wait.byPageToComplete();
  }

  return commands.measure.stop();
};
`;
}

export { FULLSCREEN_SELECTOR };
