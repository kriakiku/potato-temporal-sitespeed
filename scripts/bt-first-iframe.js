/**
 * Browsertime --script: first iframe time (ms since navigation).
 * Uses Resource Timing when available; else performance.now() at detection.
 * Waits via MutationObserver until timeout.
 */
module.exports = async function () {
  var TIMEOUT_MS = 60000;

  function measureIframeMs(iframe) {
    if (!iframe) return -1;
    var src = (iframe.src || iframe.getAttribute("src") || "").split(/[?#]/)[0];
    var best = -1;
    var entries = performance.getEntriesByType("resource");
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var isIframe =
        e.initiatorType === "iframe" ||
        (src && typeof e.name === "string" && e.name.indexOf(src) === 0);
      if (!isIframe) continue;
      if (best < 0 || e.startTime < best) best = e.startTime;
    }
    if (best >= 0) return Math.round(best);
    return Math.round(performance.now());
  }

  function tryFind() {
    return measureIframeMs(document.querySelector("iframe"));
  }

  var immediate = tryFind();
  if (immediate >= 0) return { firstIframeMs: immediate };

  return new Promise(function (resolve) {
    var settled = false;
    function done(ms) {
      if (settled) return;
      settled = true;
      try {
        obs.disconnect();
      } catch (_) {}
      clearTimeout(timer);
      resolve({ firstIframeMs: ms });
    }

    var obs = new MutationObserver(function () {
      var ms = tryFind();
      if (ms >= 0) done(ms);
    });
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });

    var timer = setTimeout(function () {
      done(-1);
    }, TIMEOUT_MS);

    // Race: iframe may appear between querySelector and observe
    var again = tryFind();
    if (again >= 0) done(again);
  });
};
