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

export function buildMeasureJourneyScript(input: MeasureJourneyInput): string {
  const hideJs = buildFullscreenHideJs();
  return `/**
 * Auto-generated browsertime journey (do not edit by hand).
 * Measure ${JSON.stringify(input.alias)}; hide ${FULLSCREEN_SELECTOR} via injected CSS.
 * Opens via driver.get so the hide runs before pageCompleteCheck.
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
