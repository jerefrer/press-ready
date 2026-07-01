/* Press Ready — UI + analysis worker orchestration (100% client-side). */

const $ = (id) => document.getElementById(id);
const el = {
  dropSection: $("dropSection"), drop: $("drop"), file: $("file"),
  loading: $("loading"), loadTitle: $("loadTitle"), loadMsg: $("loadMsg"),
  bar: $("bar"), barFill: $("barFill"), eta: $("eta"),
  report: $("report"), summary: $("summary"), cards: $("cards"),
  errorBox: $("errorBox"), errorMsg: $("errorMsg"),
  printBtn: $("printBtn"), againBtn: $("againBtn"), retryBtn: $("retryBtn"),
};

let worker = null;

const show = (name) => {
  for (const s of ["dropSection", "loading", "report", "errorBox"]) {
    el[s].classList.toggle("hidden", s !== name);
  }
};

function setBar(progress) {
  if (progress == null) {
    el.bar.classList.add("indeterminate");
  } else {
    el.bar.classList.remove("indeterminate");
    el.barFill.style.width = Math.max(0, Math.min(1, progress)) * 100 + "%";
  }
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return "about " + sec + "s left";
  return "about " + Math.ceil(sec / 60) + " min left";
}

function onStatus(m) {
  if (m.message !== undefined) el.loadMsg.textContent = m.message || "";
  setBar(m.progress);
  el.eta.textContent = fmtEta(m.eta);
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("assets/worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") onStatus(m);
    else if (m.type === "result") renderReport(m.result, currentName);
    else if (m.type === "error") showError(m.message);
  };
  worker.onerror = (e) => showError(e.message || "worker error");
  return worker;
}

let currentName = "";

function analyze(file) {
  currentName = file.name;
  show("loading");
  el.loadTitle.textContent = "Mixing the inks…";
  el.loadMsg.textContent = "The first load takes a little longer, then it's instant.";
  el.eta.textContent = "";
  setBar(0.03);
  file.arrayBuffer().then((ab) => {
    const bytes = new Uint8Array(ab);
    ensureWorker().postMessage({ type: "analyze", bytes }, [bytes.buffer]);
  });
}

function showError(msg) {
  el.errorMsg.textContent = "Technical detail: " + msg;
  show("errorBox");
}

const ICON = { ok: "✓", warn: "!", crit: "×" };

function renderReport(res, filename) {
  const attn = res.n_crit + res.n_warn;
  const good = attn === 0;
  el.summary.className = "summary " + (good ? "good" : "attn");
  el.summary.innerHTML = `
    <div class="big" aria-hidden="true">${good ? "✨" : "🖐️"}</div>
    <div>
      <h2>${good ? "Your file looks ready!" : "A few things to look at"}</h2>
      <p>${good
        ? "No issues found on the usual checks."
        : `${res.n_crit} important point(s) and ${res.n_warn} to check before printing.`}</p>
      <p class="file">${escapeHtml(filename)} · ${res.pages} page(s)${res.meta.pdfx ? " · " + res.meta.pdfx : ""}</p>
    </div>`;

  const order = { crit: 0, warn: 1, ok: 2 };
  const sorted = [...res.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  el.cards.innerHTML = sorted.map((f) => `
    <div class="card ${f.severity}">
      <div class="badge ${f.severity}" aria-hidden="true">${ICON[f.severity]}</div>
      <div>
        <h3>${escapeHtml(f.title)}</h3>
        <p>${escapeHtml(f.message)}</p>
        ${f.items && f.items.length
          ? "<ul>" + f.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("") + "</ul>"
          : ""}
      </div>
    </div>`).join("");
  show("report");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---- Interactions ----
function pick(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("This file isn't a PDF.");
    return;
  }
  analyze(file);
}

el.drop.addEventListener("click", () => el.file.click());
el.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.file.click(); }
});
el.file.addEventListener("change", (e) => pick(e.target.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("drag"); }));
el.drop.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

el.printBtn.addEventListener("click", () => window.print());
el.againBtn.addEventListener("click", () => show("dropSection"));
el.retryBtn.addEventListener("click", () => show("dropSection"));
