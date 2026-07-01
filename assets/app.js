/* Bon à tirer — orchestration Pyodide + rendu du rapport (100 % client-side). */

const $ = (id) => document.getElementById(id);
const el = {
  dropSection: $("dropSection"), drop: $("drop"), file: $("file"),
  loading: $("loading"), loadTitle: $("loadTitle"), loadMsg: $("loadMsg"),
  report: $("report"), summary: $("summary"), cards: $("cards"),
  errorBox: $("errorBox"), errorMsg: $("errorMsg"),
  printBtn: $("printBtn"), againBtn: $("againBtn"), retryBtn: $("retryBtn"),
};

let pyodide = null;
let analyzerSrc = null;

const show = (name) => {
  for (const s of ["dropSection", "loading", "report", "errorBox"]) {
    el[s].classList.toggle("hidden", s !== name);
  }
};

const setLoad = (title, msg) => {
  if (title) el.loadTitle.textContent = title;
  if (msg !== undefined) el.loadMsg.textContent = msg;
};

// Prépare Pyodide + PyMuPDF au premier usage (mise en cache navigateur ensuite).
async function ensureEngine() {
  if (pyodide) return;
  setLoad("Préparation des couleurs…", "Chargement de l'atelier (une fois).");
  pyodide = await loadPyodide();
  setLoad(null, "Chargement des outils d'analyse…");
  await pyodide.loadPackage(["numpy", "Pillow"]);
  setLoad(null, "Chargement du lecteur PDF…");
  await pyodide.loadPackage("./vendor/pymupdf-1.28.0-cp313-abi3-pyemscripten_2025_0_wasm32.whl");
  analyzerSrc = await (await fetch("assets/analyzer.py")).text();
  pyodide.runPython(analyzerSrc);
}

async function analyze(file) {
  show("loading");
  setLoad("Préparation des couleurs…", "");
  try {
    await ensureEngine();
    setLoad("Lecture de votre PDF…", file.name);
    const buf = new Uint8Array(await file.arrayBuffer());
    pyodide.globals.set("pdf_bytes", buf);
    const resultJson = await pyodide.runPythonAsync(`
import json
_res = analyze(bytes(pdf_bytes.to_py()))
json.dumps(_res)
`);
    renderReport(JSON.parse(resultJson), file.name);
  } catch (e) {
    console.error(e);
    el.errorMsg.textContent =
      "Détail technique : " + (e && e.message ? e.message : e);
    show("errorBox");
  }
}

const ICON = { ok: "✓", warn: "!", crit: "×" };

function renderReport(res, filename) {
  const attn = res.n_crit + res.n_warn;
  const good = attn === 0;
  el.summary.className = "summary " + (good ? "good" : "attn");
  el.summary.innerHTML = `
    <div class="big" aria-hidden="true">${good ? "✨" : "🖐️"}</div>
    <div>
      <h2>${good ? "Votre fichier a l'air prêt !" : "Quelques points à regarder"}</h2>
      <p>${good
        ? "Aucun souci détecté sur les contrôles habituels."
        : `${res.n_crit} point(s) important(s) et ${res.n_warn} à vérifier avant l'imprimeur.`}</p>
      <p class="file">${filename} · ${res.pages} page(s)${res.meta.pdfx ? " · " + res.meta.pdfx : ""}</p>
    </div>`;

  const order = { crit: 0, warn: 1, ok: 2 };
  const sorted = [...res.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  el.cards.innerHTML = sorted.map((f) => `
    <div class="card ${f.severity}">
      <div class="badge ${f.severity}" aria-hidden="true">${ICON[f.severity]}</div>
      <div>
        <h3>${f.title}</h3>
        <p>${f.message}</p>
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
    el.errorMsg.textContent = "Ce fichier n'est pas un PDF.";
    show("errorBox");
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

// éviter que le navigateur ouvre le PDF si on rate la zone
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

el.printBtn.addEventListener("click", () => window.print());
el.againBtn.addEventListener("click", () => show("dropSection"));
el.retryBtn.addEventListener("click", () => show("dropSection"));
