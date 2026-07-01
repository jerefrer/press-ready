/* Press Ready — analysis worker.
   Runs Pyodide + PyMuPDF off the main thread so the tab stays responsive,
   and reports real progress (incl. the 18 MB wheel download) + ETA. */

importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.2/full/pyodide.js");

let pyodide = null;

function post(stage, message, progress, eta) {
  self.postMessage({ type: "status", stage, message, progress, eta });
}

// Fetch a URL while reporting byte progress into the [from, to] slice of the bar.
async function fetchWithProgress(url, from, to, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("download failed (" + resp.status + ")");
  const total = +resp.headers.get("Content-Length") || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  const t0 = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      const frac = received / total;
      const elapsed = (performance.now() - t0) / 1000;
      const rate = elapsed > 0 ? received / elapsed : 0;
      const eta = rate > 0 ? Math.ceil((total - received) / rate) : null;
      const mb = (received / 1e6).toFixed(0) + " / " + (total / 1e6).toFixed(0) + " MB";
      post("download", label + " " + mb, from + (to - from) * frac, eta);
    } else {
      post("download", label, null, null);
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function ensureEngine() {
  if (pyodide) return;
  post("engine", "Starting the engine…", 0.04, null);
  pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.2/full/" });

  post("packages", "Loading the tools (numpy, Pillow)…", 0.12, null);
  await pyodide.loadPackage(["numpy", "Pillow"]);

  const WHEEL = "pymupdf-1.28.0-cp313-abi3-pyemscripten_2025_0_wasm32.whl";
  const wheelUrl = new URL("../vendor/" + WHEEL, self.location.href).href;
  // Loading (engine + wheel) fills 0 → 0.5 ; the analysis gets 0.5 → 1.0.
  await fetchWithProgress(wheelUrl, 0.18, 0.42, "Loading the PDF reader…");
  post("install", "Installing the PDF reader…", 0.46, null);
  await pyodide.loadPackage(wheelUrl);

  const analyzerUrl = new URL("./analyzer.py", self.location.href).href;
  const src = await (await fetch(analyzerUrl)).text();
  pyodide.runPython(src);
}

self.onmessage = async (e) => {
  if (!e.data || e.data.type !== "analyze") return;
  try {
    await ensureEngine();
    post("reading", "Reading your PDF…", 0.5, null);
    pyodide.globals.set("pdf_bytes", e.data.bytes);
    // Progression réelle de l'analyse (phase la plus longue) : 0.5 → 0.96,
    // pilotée image par image depuis Python.
    pyodide.globals.set("emit_progress", (done, total) => {
      if (done < 0) { post("analyzing", "Finishing up…", 0.98, null); return; }
      const frac = total > 0 ? done / total : 0;
      const label = total > 1
        ? "Checking images (" + done + " / " + total + ")…"
        : "Checking ink, colors and text…";
      post("analyzing", label, 0.5 + 0.46 * frac, null);
    });
    post("analyzing", "Checking ink, colors and text…", 0.5, null);
    const json = await pyodide.runPythonAsync(
      "import json\n_res = analyze(bytes(pdf_bytes.to_py()), progress=emit_progress)\njson.dumps(_res)");
    self.postMessage({ type: "result", result: JSON.parse(json) });
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) ? err.message : String(err) });
  }
};
