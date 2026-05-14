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
  const log = (...a) => console.log(LOG_PREFIX, ...a);

  // The interceptor runs in the MAIN world via a separate content_script
  // entry in the manifest, so we don't need to inject anything here.

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

  // ---------- DOM scraping (primary, reliable path) ----------
  // We read posts directly from LinkedIn's rendered DOM. Each activity card
  // carries a urn:li:activity URN as data-urn or in inner attributes, plus
  // engagement counts in the social-counts row. This works regardless of
  // which Voyager endpoint LinkedIn used.

  const POST_CARD_SELECTORS = [
    'div[data-urn^="urn:li:activity:"]',
    'div[data-id^="urn:li:activity:"]',
    'div.feed-shared-update-v2',
    'div.profile-creator-shared-feed-update__container',
  ];

  function findPostCards() {
    const seen = new Set();
    const out = [];
    for (const sel of POST_CARD_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        out.push(el);
      });
    }
    return out;
  }

  function extractUrnFromCard(card) {
    // direct attributes
    for (const attr of ["data-urn", "data-id"]) {
      const v = card.getAttribute(attr);
      if (v && v.startsWith("urn:li:activity:")) return v;
    }
    // search descendants
    const withUrn = card.querySelector('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
    if (withUrn) {
      return withUrn.getAttribute("data-urn") || withUrn.getAttribute("data-id");
    }
    // search innerHTML for the URN string as last resort
    const m = /urn:li:activity:(\d+)/.exec(card.innerHTML);
    if (m) return `urn:li:activity:${m[1]}`;
    return null;
  }

  function parseCount(text) {
    if (!text) return 0;
    const t = String(text).trim().replace(/,/g, "");
    // "1,234" "12K" "1.2K" "3M"
    const m = /^([\d.]+)\s*([KMB]?)/i.exec(t);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1;
    return Math.round(n * mult);
  }

  function extractCountsFromCard(card) {
    // LinkedIn's social-counts row contains likes / comments / reposts.
    // Class names change; we use a few patterns + aria-labels.
    let likes = 0, comments = 0, reposts = 0;

    // Likes: aria-label like "1,234 reactions"
    const likeEl = card.querySelector(
      'button[aria-label*="reaction" i], span.social-details-social-counts__reactions-count, [data-test-id="social-actions-reactions"]'
    );
    if (likeEl) {
      const label = likeEl.getAttribute("aria-label") || likeEl.textContent;
      likes = parseCount(label);
    }

    // Comments: button or link with "comments"
    const commentEls = card.querySelectorAll(
      'li.social-details-social-counts__comments button, button[aria-label*="comment" i], a[aria-label*="comment" i], [data-test-id="social-actions-comments"]'
    );
    for (const el of commentEls) {
      const label = el.getAttribute("aria-label") || el.textContent;
      const n = parseCount(label);
      if (n > comments) comments = n;
    }

    // Reposts
    const repostEls = card.querySelectorAll(
      'button[aria-label*="repost" i], button[aria-label*="reshare" i], a[aria-label*="repost" i]'
    );
    for (const el of repostEls) {
      const label = el.getAttribute("aria-label") || el.textContent;
      const n = parseCount(label);
      if (n > reposts) reposts = n;
    }

    return { likes, comments, reposts };
  }

  function extractTextFromCard(card) {
    const el = card.querySelector(
      '.feed-shared-update-v2__description, .update-components-text, [class*="update-components-text"], [data-test-id="main-feed-activity-card-commentary"]'
    );
    if (el) return el.innerText.trim();
    // fallback: first long-ish text node
    const ps = card.querySelectorAll("span, p");
    for (const p of ps) {
      const t = p.innerText && p.innerText.trim();
      if (t && t.length > 30) return t;
    }
    return "";
  }

  function extractRelativeDateFromCard(card) {
    // LinkedIn shows things like "2d • Edited •" or "3w •". We try to find it.
    const el = card.querySelector(
      '.update-components-actor__sub-description, .feed-shared-actor__sub-description, [class*="actor__sub-description"]'
    );
    if (!el) return { rel: "", ts: 0 };
    const text = el.innerText || "";
    return { rel: text.trim(), ts: relativeToTs(text) };
  }

  function relativeToTs(text) {
    // Parses things like "2h", "3d", "1w", "2mo", "1yr". Returns approx epoch ms.
    const m = /(\d+)\s*(s|sec|min|m|h|hr|d|day|w|wk|mo|month|y|yr|year)/i.exec(text);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const sec = 1000;
    const map = {
      s: sec, sec: sec,
      min: 60 * sec, m: 60 * sec,
      h: 3600 * sec, hr: 3600 * sec,
      d: 86400 * sec, day: 86400 * sec,
      w: 7 * 86400 * sec, wk: 7 * 86400 * sec,
      mo: 30 * 86400 * sec, month: 30 * 86400 * sec,
      y: 365 * 86400 * sec, yr: 365 * 86400 * sec, year: 365 * 86400 * sec,
    };
    const ms = map[unit] * n;
    return ms ? Date.now() - ms : 0;
  }

  function scrapeDOM() {
    const cards = findPostCards();
    let added = 0, updated = 0;
    for (const card of cards) {
      const urn = extractUrnFromCard(card);
      if (!urn) continue;
      const counts = extractCountsFromCard(card);
      const text = extractTextFromCard(card);
      const date = extractRelativeDateFromCard(card);
      const existing = posts.get(urn);
      const merged = {
        urn,
        permalink: permalinkFromUrn(urn),
        text: text || (existing && existing.text) || "",
        likes: Math.max(counts.likes, existing ? existing.likes : 0),
        comments: Math.max(counts.comments, existing ? existing.comments : 0),
        reposts: Math.max(counts.reposts, existing ? existing.reposts : 0),
        publishedAt: existing && existing.publishedAt ? existing.publishedAt : date.ts,
        authorName: existing ? existing.authorName : "",
        mediaThumb: existing ? existing.mediaThumb : null,
      };
      if (existing) updated++;
      else added++;
      posts.set(urn, merged);
    }
    if (added || updated) {
      log(`DOM scrape: +${added} new, ~${updated} updated, total ${posts.size}`);
      renderList();
    }
    return added + updated;
  }

  // Watch the page: any time DOM changes, re-scrape.
  const domObserver = new MutationObserver(() => {
    // Debounce — LinkedIn mutates a LOT
    if (domObserver._t) clearTimeout(domObserver._t);
    domObserver._t = setTimeout(() => scrapeDOM(), 250);
  });
  function startDOMObserver() {
    try {
      domObserver.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  // ---------- Message bridge from interceptor ----------
  // Debug ring buffer — last 10 raw payloads, exposed as window.__lias for
  // troubleshooting parser misses. No data is exfiltrated.
  const debugBuffer = [];
  let totalSeen = 0;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "linkedin-activity-sorter") return;
    if (data.kind === "voyager-response") {
      totalSeen++;
      const url = data.payload && data.payload.url;
      const json = data.payload && data.payload.json;
      debugBuffer.push({ url, json });
      if (debugBuffer.length > 10) debugBuffer.shift();
      try {
        const added = walkAndIngest(json);
        log(`response ${totalSeen} (${shortenUrl(url)}) → +${added} posts (total ${posts.size})`);
        if (added > 0) renderList();
      } catch (e) {
        console.warn(LOG_PREFIX, "ingest error", e);
      }
    }
  });

  function shortenUrl(u) {
    if (!u) return "?";
    try {
      const p = new URL(u);
      return p.pathname + (p.search ? "?…" : "");
    } catch {
      return String(u).slice(0, 80);
    }
  }

  // Expose a debug handle so you can inspect captured payloads from console.
  // Usage: __lias.last  /  __lias.all  /  __lias.posts
  try {
    window.__lias = {
      get last() { return debugBuffer[debugBuffer.length - 1]; },
      get all() { return debugBuffer.slice(); },
      get posts() { return Array.from(posts.values()); },
      get totalSeen() { return totalSeen; },
    };
  } catch {}

  // ---------- UI ----------
  function isActivityPage() {
    return /\/in\/[^/]+\/recent-activity/.test(location.pathname);
  }

  function profileActivityUrl() {
    const m = /\/in\/([^/]+)/.exec(location.pathname);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1]}/recent-activity/all/`;
  }

  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return;
    panelEl = document.createElement("div");
    panelEl.id = "lias-panel";

    if (!isActivityPage()) {
      // Promo / deep-link panel on the main profile.
      const url = profileActivityUrl();
      panelEl.innerHTML = `
        <div class="lias-header">
          <div class="lias-title">Activity Sorter</div>
          <div class="lias-foot" style="border:none;text-align:left;padding:6px 0 0;">
            Sort this profile's posts by likes, comments, reposts, or date.
          </div>
        </div>
        <div style="padding:12px;">
          <a id="lias-go" class="lias-cta" href="${url || "#"}">Open recent activity →</a>
        </div>
        <div class="lias-foot">
          Personal use only. Data stays in your browser.
        </div>
      `;
      document.body.appendChild(panelEl);
      return;
    }

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
      <ol id="lias-list" class="lias-list">
        <li class="lias-empty">Scroll the page once or click <b>Load more</b> to fetch posts.</li>
      </ol>
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
    if (!listEl) return; // not on activity page
    const arr = sortedPosts();
    if (statusEl) statusEl.textContent = `${arr.length} post${arr.length === 1 ? "" : "s"} seen`;
    if (arr.length === 0) {
      listEl.innerHTML = `<li class="lias-empty">Scroll the page once or click <b>Load more</b> to fetch posts.</li>`;
      return;
    }
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
  // LinkedIn lazy-loads either via window scroll OR an inner scroll container,
  // and sometimes via a "Show more results" button. We try all three, paced.
  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const btn = panelEl.querySelector("#lias-load");
    btn.disabled = true;
    const startCount = posts.size;
    const cfg = await getConfig();
    const targetExtra = cfg.batchSize;
    const stepMs = cfg.scrollDelayMs;
    const maxSteps = cfg.maxStepsPerLoad;

    for (let i = 0; i < maxSteps; i++) {
      const before = posts.size;
      triggerScroll();
      clickShowMoreIfPresent();
      await sleep(stepMs);
      if (posts.size === before) {
        await sleep(stepMs);
        if (posts.size === before) break;
      }
      if (posts.size - startCount >= targetExtra) break;
    }
    btn.disabled = false;
    loadingMore = false;
  }

  function triggerScroll() {
    // Window
    window.scrollTo(0, document.documentElement.scrollHeight);
    // Any inner scrollable container (LinkedIn sometimes uses .scaffold-finite-scroll)
    const candidates = document.querySelectorAll(
      'main, [data-finite-scroll], .scaffold-finite-scroll, [class*="scaffold"]'
    );
    candidates.forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 50) {
        el.scrollTop = el.scrollHeight;
      }
    });
    // Fire a synthetic scroll event some lazy loaders listen for
    window.dispatchEvent(new Event("scroll"));
  }

  function clickShowMoreIfPresent() {
    // LinkedIn uses a "Show more results" button at the bottom of activity feeds
    const buttons = document.querySelectorAll(
      'button.scaffold-finite-scroll__load-button, button[aria-label*="Show more"], button[aria-label*="show more"]'
    );
    for (const b of buttons) {
      const rect = b.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && !b.disabled) {
        b.click();
        return true;
      }
    }
    return false;
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
    if (isActivityPage()) {
      // First scrape immediately, then watch for new cards as user scrolls.
      setTimeout(scrapeDOM, 500);
      setTimeout(scrapeDOM, 1500);
      setTimeout(scrapeDOM, 3000);
      startDOMObserver();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // Debug handle for the isolated world
  try {
    window.__liasContent = {
      scrape: scrapeDOM,
      posts: () => Array.from(posts.values()),
      reset: () => { posts.clear(); renderList(); },
    };
  } catch {}

  // SPA navigations: LinkedIn swaps the body without full reload. Re-mount the
  // panel and reset state when the profile changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      posts.clear();
      if (panelEl) panelEl.remove();
      panelEl = null;
      if (/\/in\/[^/]+/.test(location.pathname)) {
        boot();
      }
    } else if (panelEl && !document.body.contains(panelEl)) {
      // Re-attach if LinkedIn nuked it
      document.body.appendChild(panelEl);
    }
  }, 1500);
})();
