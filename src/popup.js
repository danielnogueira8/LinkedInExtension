const DEFAULTS = {
  batchSize: 25,
  scrollDelayMs: 1500,
  maxStepsPerLoad: 20,
};

function load() {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    document.getElementById("batchSize").value = v.batchSize;
    document.getElementById("scrollDelayMs").value = v.scrollDelayMs;
    document.getElementById("maxStepsPerLoad").value = v.maxStepsPerLoad;
  });
}

function save() {
  const cfg = {
    batchSize: clamp(+document.getElementById("batchSize").value, 5, 200),
    scrollDelayMs: clamp(+document.getElementById("scrollDelayMs").value, 500, 10000),
    maxStepsPerLoad: clamp(+document.getElementById("maxStepsPerLoad").value, 1, 100),
  };
  chrome.storage.sync.set(cfg, () => {
    const s = document.getElementById("saved");
    s.textContent = "Saved";
    setTimeout(() => (s.textContent = ""), 1500);
  });
}

function clamp(n, lo, hi) {
  if (!isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

document.getElementById("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
