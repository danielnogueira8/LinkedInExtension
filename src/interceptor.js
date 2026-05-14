// Runs in the page's main world so it can patch window.fetch and XMLHttpRequest.
// We only OBSERVE responses LinkedIn already requested for this page; we never
// initiate requests of our own. Data is forwarded to the content script via
// window.postMessage and never leaves the browser.

(function () {
  if (window.__linkedInActivitySorterInstalled) return;
  window.__linkedInActivitySorterInstalled = true;

  // Hints we look for in voyager URLs. We cast a wide net because LinkedIn
  // moves endpoints around (REST → GraphQL), and we'd rather over-collect
  // and let the parser filter than miss responses entirely.
  const TARGET_URL_HINTS = [
    "profileUpdates",
    "memberShares",
    "profileComponents",
    "feedDashProfileUpdates",
    "creatorDashFollowingFeed",
    "voyagerIdentityDashProfileUpdates",
    "feedDashMainFeed",
    "feedDashUpdates",
    "graphql",
    "ProfileUpdates",
    "MainFeed",
  ];

  function urlIsInteresting(url) {
    if (typeof url !== "string") return false;
    // voyager REST OR voyager GraphQL endpoint
    if (!url.includes("/voyager/")) return false;
    // GraphQL endpoint contains "/voyager/api/graphql" — always inspect
    if (url.includes("/graphql")) return true;
    return TARGET_URL_HINTS.some((h) => url.includes(h));
  }

  function emit(payload) {
    try {
      window.postMessage(
        { source: "linkedin-activity-sorter", kind: "voyager-response", payload },
        window.location.origin
      );
    } catch (_) {
      // ignore
    }
  }

  // Patch fetch
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(...args) {
    const req = args[0];
    const url = typeof req === "string" ? req : req && req.url;
    const promise = originalFetch.apply(this, args);
    if (urlIsInteresting(url)) {
      promise
        .then((res) => {
          // Clone so we don't consume the body LinkedIn needs.
          try {
            const clone = res.clone();
            clone
              .json()
              .then((json) => emit({ url, json }))
              .catch(() => {});
          } catch (_) {}
          return res;
        })
        .catch(() => {});
    }
    return promise;
  };

  // Patch XHR
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let _url = null;
    const open = xhr.open;
    xhr.open = function (method, url, ...rest) {
      _url = url;
      return open.call(this, method, url, ...rest);
    };
    xhr.addEventListener("load", function () {
      if (!urlIsInteresting(_url)) return;
      try {
        const text = xhr.responseText;
        if (!text) return;
        const json = JSON.parse(text);
        emit({ url: _url, json });
      } catch (_) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
})();
