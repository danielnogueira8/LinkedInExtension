// Content script for LinkedIn Activity Sorter.
//
// Strategy:
// 1. Inject interceptor.js into the page so we can observe LinkedIn's own
//    Voyager API responses (we never make our own LinkedIn API calls).
// 2. Parse posts out of those responses and store them keyed by profile.
// 3. Render a sort toolbar + an in-place sorted feed that links to the
//    original posts on LinkedIn. The native feed is left intact underneath
//    a toggle so the user can always fall back.
// 4. "Load more" works by programmatically scrolling the page, which lets
//    LinkedIn's own infinite-scroll fire — paced with a delay so we don't
//    hammer their servers. Hard cap configurable in the popup.

(function () {
  const LOG_PREFIX = "[LI Activity Sorter]";
  const log = (...a) => console.debug(LOG_PREFIX, ...a);

  // ---------- Inject the page-context interceptor ----------
  function injectInterceptor() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("src/interceptor.js");
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
    } catch (e) {
      console.warn(LOG_PREFIX, "interceptor inject failed", e);
    }
  }
  injectInterceptor();

  // ---------- State ----------
  /** @type {Map<string, Post>} */
  const posts = new Map(); // urn -> Post
  let currentSort = "recent";
  let panelEl = null;
  let listEl = null;
  let statusEl = null;
  let loadingMore = false;
  let nativeFeedHidden = false;

  /**
   * @typedef {Object} Post
   * @property {string} urn
   * @property {string|null} permalink
   * @property {string} text
   * @property {number} likes
   * @property {number} comments
   * @property {number} reposts
   * @property {number} publishedAt   epoch ms (0 if unknown)
   * @property {string} authorName
   * @property {string|null} mediaThumb
   */

  // ---------- Voyager parsing ----------
  // LinkedIn's Voyager responses are deeply nested. Instead of pinning to one
  // exact shape (which breaks often), we walk the tree looking for objects
  // that smell like an UpdateV2 / FeedUpdate.

  function isPostNode(node) {
    if (!node || typeof node !== "object") return false;
    // Common discriminators across recent Voyager schemas.
    const t = node.$type || node["com.linkedin.voyager.feed.render.UpdateV2"];
    if (t && String(t).includes("UpdateV2")) return true;
    if (node.updateMetadata && (node.commentary || node.content)) return true;
    if (node.entityUrn && /urn:li:(activity|share|ugcPost|fsd_update)/.test(node.entityUrn)) {
      // must also have engagement-ish fields somewhere
      if (node.socialDetail || node.socialContent || node.socialActivityCounts) return true;
    }
    return false;
  }

  function pickNumber(...vals) {
    for (const v of vals) {
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return 0;
  }

  function findCounts(node) {
    // Search a few well-known locations for like/comment/share counts.
    const candidates = [];
    const visit = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 6) return;
      if (
        ("numLikes" in n || "numComments" in n || "numShares" in n ||
          "reactionTypeCounts" in n)
      ) {
        candidates.push(n);
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === "object") visit(v, depth + 1);
      }
    };
    visit(node, 0);

    let likes = 0, comments = 0, reposts = 0;
    for (const c of candidates) {
      likes = Math.max(likes, pickNumber(c.numLikes, c.totalReactions, c.numReactions));
      if (Array.isArray(c.reactionTypeCounts)) {
        const sum = c.reactionTypeCounts.reduce(
          (acc, r) => acc + (r && typeof r.count === "number" ? r.count : 0),
          0
        );
        likes = Math.max(likes, sum);
      }
      comments = Math.max(comments, pickNumber(c.numComments));
      reposts = Math.max(reposts, pickNumber(c.numShares, c.numReshares));
    }
    return { likes, comments, reposts };
  }

  function findText(node) {
    // commentary.text.text is common
    const tryPaths = [
      ["commentary", "text", "text"],
      ["commentary", "text"],
      ["content", "commentary", "text", "text"],
      ["text", "text"],
    ];
    for (const path of tryPaths) {
      let cur = node;
      for (const p of path) {
        if (cur && typeof cur === "object") cur = cur[p];
        else { cur = null; break; }
      }
      if (typeof cur === "string" && cur.trim()) return cur.trim();
    }
    return "";
  }

  function findPublishedAt(node) {
    let ts = 0;
    const visit = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 6 || ts) return;
      if (typeof n.publishedAt === "number") { ts = n.publishedAt; return; }
      if (n.actor && typeof n.actor.subDescription === "object") {
        // sometimes a relative string only — skip
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === "object") visit(v, depth + 1);
      }
    };
    visit(node, 0);
    return ts;
  }

  function findActorName(node) {
    const a = node.actor || (node.updateMetadata && node.updateMetadata.actor);
    if (!a) return "";
    const n = a.name;
    if (typeof n === "string") return n;
    if (n && typeof n.text === "string") return n.text;
    return "";
  }

  function findActivityUrn(node) {
    // Prefer urn:li:activity:... — that's what permalinks use.
    const urns = [];
    const visit = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 6) return;
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (typeof v === "string" && v.startsWith("urn:li:activity:")) urns.push(v);
        else if (v && typeof v === "object") visit(v, depth + 1);
      }
    };
    visit(node, 0);
    if (urns.length) return urns[0];
    // fall back to entityUrn
    return node.entityUrn || node.preDashEntityUrn || null;
  }

  function permalinkFromUrn(urn) {
    if (!urn) return null;
    const m = /urn:li:activity:(\d+)/.exec(urn);
    if (m) return `https://www.linkedin.com/feed/update/urn:li:activity:${m[1]}/`;
    return null;
  }

  function ingest(node) {
    if (!isPostNode(node)) return false;
    const urn = findActivityUrn(node) || node.entityUrn;
    if (!urn) return false;
    const counts = findCounts(node);
    const text = findText(node);
    const publishedAt = findPublishedAt(node);
    const authorName = findActorName(node);
    const permalink = permalinkFromUrn(urn);
    const existing = posts.get(urn);
    /** @type {Post} */
    const merged = {
      urn,
      permalink,
      text: text || (existing && existing.text) || "",
      likes: Math.max(counts.likes, existing ? existing.likes : 0),
      comments: Math.max(counts.comments, existing ? existing.comments : 0),
      reposts: Math.max(counts.reposts, existing ? existing.reposts : 0),
      publishedAt: publishedAt || (existing && existing.publishedAt) || 0,
      authorName: authorName || (existing && existing.authorName) || "",
      mediaThumb: existing ? existing.mediaThumb : null,
    };
    posts.set(urn, merged);
    return true;
  }

  function walkAndIngest(json) {
    let added = 0;
    const visit = (n, depth) => {
      if (!n || typeof n !== "object" || depth > 10) return;
      if (Array.isArray(n)) {
        for (const item of n) visit(item, depth + 1);
        return;
      }
      if (ingest(n)) added++;
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === "object") visit(v, depth + 1);
      }
    };
    visit(json, 0);
    return added;
  }

  // ---------- Message bridge from interceptor ----------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "linkedin-activity-sorter") return;
    if (data.kind === "voyager-response") {
      try {
        const added = walkAndIngest(data.payload && data.payload.json);
        if (added > 0) {
          log(`ingested ${added} posts (total ${posts.size})`);
          renderList();
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "ingest error", e);
      }
    }
  });

  // ---------- UI ----------
  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return;
    panelEl = document.createElement("div");
    panelEl.id = "lias-panel";
    panelEl.innerHTML = `
      <div class="lias-header">
        <div class="lias-title">Activity Sorter</div>
        <div class="lias-actions">
          <button data-sort="recent" class="lias-sort lias-active">Most recent</button>
          <button data-sort="likes" class="lias-sort">Most likes</button>
          <button data-sort="comments" class="lias-sort">Most comments</button>
          <button data-sort="reposts" class="lias-sort">Most reposts</button>
        </div>
        <div class="lias-toolbar">
          <button id="lias-toggle">Hide native feed</button>
          <button id="lias-load">Load more</button>
          <span id="lias-status" class="lias-status">0 posts seen</span>
        </div>
      </div>
      <ol id="lias-list" class="lias-list"></ol>
      <div class="lias-foot">
        Personal use only. Data stays in your browser. Respect LinkedIn's Terms of Service.
      </div>
    `;
    document.body.appendChild(panelEl);
    listEl = panelEl.querySelector("#lias-list");
    statusEl = panelEl.querySelector("#lias-status");
    panelEl.querySelectorAll(".lias-sort").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentSort = btn.dataset.sort;
        panelEl.querySelectorAll(".lias-sort").forEach((b) =>
          b.classList.toggle("lias-active", b === btn)
        );
        renderList();
      });
    });
    panelEl.querySelector("#lias-toggle").addEventListener("click", toggleNative);
    panelEl.querySelector("#lias-load").addEventListener("click", loadMore);
  }

  function toggleNative() {
    nativeFeedHidden = !nativeFeedHidden;
    document.documentElement.classList.toggle("lias-hide-native", nativeFeedHidden);
    const btn = panelEl.querySelector("#lias-toggle");
    if (btn) btn.textContent = nativeFeedHidden ? "Show native feed" : "Hide native feed";
  }

  function fmt(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, { dateStyle: "medium" });
    } catch { return "—"; }
  }

  function sortedPosts() {
    const arr = Array.from(posts.values());
    const cmp = {
      recent: (a, b) => (b.publishedAt || 0) - (a.publishedAt || 0),
      likes: (a, b) => b.likes - a.likes,
      comments: (a, b) => b.comments - a.comments,
      reposts: (a, b) => b.reposts - a.reposts,
    }[currentSort];
    return arr.sort(cmp);
  }

  function renderList() {
    ensurePanel();
    if (!listEl) return;
    const arr = sortedPosts();
    statusEl.textContent = `${arr.length} post${arr.length === 1 ? "" : "s"} seen`;
    const frag = document.createDocumentFragment();
    for (const p of arr) {
      const li = document.createElement("li");
      li.className = "lias-item";
      const text = (p.text || "(no text)").slice(0, 280);
      li.innerHTML = `
        <div class="lias-meta">
          <span class="lias-stat" title="Likes">👍 ${fmt(p.likes)}</span>
          <span class="lias-stat" title="Comments">💬 ${fmt(p.comments)}</span>
          <span class="lias-stat" title="Reposts">🔁 ${fmt(p.reposts)}</span>
          <span class="lias-date">${fmtDate(p.publishedAt)}</span>
        </div>
        <div class="lias-text"></div>
        <div class="lias-link">
          ${p.permalink ? `<a href="${p.permalink}" target="_blank" rel="noopener">Open post ↗</a>` : ""}
        </div>
      `;
      // textContent assign avoids any HTML injection from post text
      li.querySelector(".lias-text").textContent = text;
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
  }

  // ---------- Pacing for load more ----------
  // We trigger LinkedIn's own infinite-scroll by scrolling the window. We pace
  // it gently to avoid behaving like a scraper.
  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const btn = panelEl.querySelector("#lias-load");
    btn.disabled = true;
    const startCount = posts.size;
    const cfg = await getConfig();
    const targetExtra = cfg.batchSize; // how many *new* posts we want this click
    const stepMs = cfg.scrollDelayMs;
    const maxSteps = cfg.maxStepsPerLoad;

    // Find a scroll container that actually scrolls (LinkedIn sometimes uses inner)
    for (let i = 0; i < maxSteps; i++) {
      const before = posts.size;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      await sleep(stepMs);
      // If nothing new arrived in two cycles, stop early.
      if (posts.size === before) {
        await sleep(stepMs);
        if (posts.size === before) break;
      }
      if (posts.size - startCount >= targetExtra) break;
    }
    btn.disabled = false;
    loadingMore = false;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- Config ----------
  const DEFAULTS = {
    batchSize: 25,            // additional posts to try to load per click
    scrollDelayMs: 1500,      // gap between scroll triggers (be polite)
    maxStepsPerLoad: 20,      // hard cap per click
  };

  function getConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (v) => resolve({ ...DEFAULTS, ...v }));
      } catch {
        resolve(DEFAULTS);
      }
    });
  }

  // ---------- Boot ----------
  function boot() {
    ensurePanel();
    renderList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // SPA navigations: LinkedIn swaps the body without full reload. Re-mount the
  // panel and reset state when the profile changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      posts.clear();
      if (panelEl) panelEl.remove();
      panelEl = null;
      // Only mount on activity pages
      if (/\/in\/[^/]+\/recent-activity/.test(location.pathname)) {
        boot();
      }
    } else if (panelEl && !document.body.contains(panelEl)) {
      // Re-attach if LinkedIn nuked it
      document.body.appendChild(panelEl);
    }
  }, 1500);
})();
