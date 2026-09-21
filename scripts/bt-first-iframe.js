/**
 * Browsertime --script: first iframe time (ms since navigation).
 * Sync read only — journey installs a non-blocking probe after driver.get
 * (`window.__potatoFirstIframeMs`). Never waits / never returns -1.
 */
module.exports = function () {
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

  var probed =
    typeof window.__potatoFirstIframeMs === "number"
      ? window.__potatoFirstIframeMs
      : -1;
  if (probed >= 0) return { firstIframeMs: probed };

  var immediate = tryFind();
  if (immediate >= 0) return { firstIframeMs: immediate };

  // No iframe — omit metric (do not emit -1 / do not block).
  return {};
};
