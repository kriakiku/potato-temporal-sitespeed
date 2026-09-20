/**
 * Generate a browsertime multi/journey script: open URL, then if
 * `[data-test-id="fullScreen"]` is present, Selenium Actions-tap the viewport center.
 * Presence check only — click is not targeted at the element.
 *
 * Important: do NOT use `commands.navigate(url)` before the tap. That API always
 * runs pageCompleteCheck before returning, which can take a long time while the
 * marker is already on screen. Open with raw `driver.get`, gate+tap, then
 * `wait.byPageToComplete()` so metrics still settle before stop.
 *
 * Warm cache is handled outside this script (second sitespeed run with a shared
 * Chrome user-data-dir after POST /v1/stats/reset).
 */
export type MeasureJourneyInput = {
  url: string;
  /** Passed to commands.measure.start (urlAlias / result name) */
  alias: string;
  /** How long to wait for the fullscreen marker (ms) */
  fullscreenWaitMs?: number;
};

const FULLSCREEN_SELECTOR = '[data-test-id="fullScreen"]';

export function buildMeasureJourneyScript(input: MeasureJourneyInput): string {
  const waitMs = input.fullscreenWaitMs ?? 10_000;
  return `/**
 * Auto-generated browsertime journey (do not edit by hand).
 * Measure ${JSON.stringify(input.alias)}; if ${FULLSCREEN_SELECTOR} appears, Actions-tap viewport center.
 * Opens via driver.get so the gate runs before pageCompleteCheck.
 */
module.exports = async function (context, commands) {
  var url = ${JSON.stringify(input.url)};
  var alias = ${JSON.stringify(input.alias)};
  var selector = ${JSON.stringify(FULLSCREEN_SELECTOR)};
  var fullscreenWaitMs = ${waitMs};
  var driver = context.selenium && context.selenium.driver;
  if (!driver || typeof driver.get !== "function") {
    throw new Error("context.selenium.driver unavailable");
  }

  await commands.measure.start(alias);
  // Skip commands.navigate — it blocks on pageCompleteCheck before we can tap.
  await driver.get(url);

  try {
    // Gate only: element must appear; we do not click it.
    if (typeof commands.wait === "function") {
      await commands.wait(selector, { timeout: fullscreenWaitMs });
    } else if (commands.wait && typeof commands.wait.bySelector === "function") {
      await commands.wait.bySelector(selector, fullscreenWaitMs);
    } else if (typeof commands.exists === "function") {
      var ok = await commands.exists(selector, { timeout: fullscreenWaitMs });
      if (!ok) throw new Error("fullscreen marker not found");
    } else {
      throw new Error("no wait/exists command for fullscreen gate");
    }

    if (!commands.action || typeof commands.action.getActions !== "function") {
      throw new Error("Selenium Actions API unavailable");
    }

    // Viewport center in CSS pixels → real pointer event (not element.click / JS).
    var size = await commands.js.run(
      "return { w: window.innerWidth, h: window.innerHeight };"
    );
    var x = Math.floor((size && size.w ? size.w : 0) / 2);
    var y = Math.floor((size && size.h ? size.h : 0) / 2);
    if (x <= 0 || y <= 0) {
      throw new Error("invalid viewport size for center tap");
    }

    var actions = commands.action.getActions();
    await actions.move({ x: x, y: y, origin: "viewport" }).pause(50).click().perform();
    if (typeof commands.action.clear === "function") {
      await commands.action.clear();
    }

    context.log.info(
      "Actions center-tap at " + x + "," + y + " (gate " + selector + ")"
    );
    if (commands.wait && typeof commands.wait.byTime === "function") {
      await commands.wait.byTime(1000);
    }
  } catch (e) {
    context.log.info(
      "No " +
        selector +
        " within " +
        fullscreenWaitMs +
        "ms (or center tap failed): " +
        (e && e.message ? e.message : String(e)) +
        "; continuing without tap"
    );
  }

  // Settle configured pageCompleteCheck after the tap window.
  if (commands.wait && typeof commands.wait.byPageToComplete === "function") {
    await commands.wait.byPageToComplete();
  }

  return commands.measure.stop();
};
`;
}

export { FULLSCREEN_SELECTOR };
