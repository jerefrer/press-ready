# -*- coding: utf-8 -*-
"""
analyzer.py — moteur de contrôle préflight, exécuté DANS LE NAVIGATEUR via
Pyodide (PyMuPDF + Pillow + numpy). Lecture seule : n'écrit jamais le PDF.

Porté depuis analyze_yellow.py + preflight_report.py (qui utilisaient pikepdf,
non disponible en WebAssembly). Ici tout passe par PyMuPDF (fitz).

Point d'entrée : analyze(data: bytes) -> dict JSON-able.
"""

import io
import pymupdf
import numpy as np
from PIL import Image

# Seuils (mêmes valeurs que les scripts validés)
Y_MIN, C_MIN, M_MAX, K_MAX, CYAN_TRACE_MAX = 70.0, 5.0, 40.0, 20.0, 25.0
TAC_MAX = 300.0
DPI_MIN = 300.0
BLEED_MM = 3.0
PT_PER_MM = 72.0 / 25.4
BLACK_MAX_RGB = 50.0

PAINT = {"f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "n"}
SHOW = {"Tj", "TJ", "'", '"'}


def to_ink(a):
    # PyMuPDF renvoie le CMJN NON-inversé (0 = pas d'encre, 255 = pleine encre),
    # contrairement à pikepdf/JPEG-Adobe. On lit donc l'encre directement.
    return a.astype("float32") / 255.0 * 100.0


def cmyk_max_rgb(c, m, y, k):
    return max((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)) * 255.0


# --------------------------------------------------------------------------- #
def _dpi_map(doc):
    """xref -> (dpi, page_number) au plus grand placement."""
    out = {}
    for pno in range(doc.page_count):
        try:
            infos = doc[pno].get_image_info(xrefs=True)
        except Exception:
            continue
        for info in infos:
            xref = info.get("xref", 0)
            bbox = info.get("bbox")
            w = info.get("width", 0)
            h = info.get("height", 0)
            if not xref or not bbox or not w or not h:
                continue
            w_pt = abs(bbox[2] - bbox[0])
            h_pt = abs(bbox[3] - bbox[1])
            if w_pt <= 1 or h_pt <= 1:
                continue
            dpi = min(w / (w_pt / 72.0), h / (h_pt / 72.0))
            area = w_pt * h_pt
            prev = out.get(xref)
            if prev is None or area > prev[2]:
                out[xref] = (round(dpi), pno + 1, area)
    return {k: (v[0], v[1]) for k, v in out.items()}


def _analyze_images(doc):
    dmap = _dpi_map(doc)
    seen = set()
    low_dpi, over_tac, rgb_imgs = [], [], []
    yellow = trace = green = ypix = 0
    for pno in range(doc.page_count):
        for im in doc[pno].get_images(full=True):
            xref = im[0]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                d = doc.extract_image(xref)
            except Exception:
                continue
            ncomp = d.get("colorspace", 0)
            w, h = d.get("width", 0), d.get("height", 0)
            dpi, page = dmap.get(xref, (None, pno + 1))
            if dpi is not None and dpi < DPI_MIN and w * h > 10000:
                low_dpi.append({"page": page, "dpi": dpi, "dims": f"{w}×{h}"})
            if ncomp == 3:
                rgb_imgs.append({"page": page, "dims": f"{w}×{h}"})
            if ncomp == 4:
                try:
                    pil = Image.open(io.BytesIO(d["image"]))
                    if pil.mode != "CMYK":
                        continue
                    a = np.asarray(pil)
                    s = max(1, max(a.shape[:2]) // 500)
                    a = to_ink(a[::s, ::s, :])
                except Exception:
                    continue
                C, M, Y, K = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
                tac = a.sum(2)
                mx = float(tac.max())
                if mx > TAC_MAX:
                    pct = 100.0 * float((tac > TAC_MAX).sum()) / tac.size
                    if pct >= 0.05:
                        over_tac.append({"page": page, "tac": round(mx),
                                         "area": round(pct, 1)})
                yel = (Y >= Y_MIN) & (M <= M_MAX) & (K <= K_MAX)
                pol = yel & (C >= C_MIN)
                yellow += int(yel.sum())
                trace += int((pol & (C < CYAN_TRACE_MAX)).sum())
                green += int((pol & (C >= CYAN_TRACE_MAX)).sum())
                ypix += a.shape[0] * a.shape[1]
    low_dpi.sort(key=lambda x: x["dpi"])
    over_tac.sort(key=lambda x: -x["area"])
    return {"low_dpi": low_dpi, "over_tac": over_tac, "rgb_imgs": rgb_imgs,
            "yellow": yellow, "trace": trace, "green": green}


def _iter_streams(doc):
    for pno in range(doc.page_count):
        try:
            c = doc[pno].read_contents()
            if c:
                yield c
        except Exception:
            pass
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, "Subtype")[1] == "/Form":
                s = doc.xref_stream(x)
                if s:
                    yield s
        except Exception:
            pass


def _analyze_vectors(doc):
    """Texte noir quadri vs K100, + couleurs vectorielles RGB."""
    k100 = quadri = 0
    rgb_ops = 0
    for data in _iter_streams(doc):
        try:
            t = data.decode("latin-1", "ignore")
        except Exception:
            continue
        if "rg" in t or "RG" in t:
            toks_all = t.split()
            for i, tk in enumerate(toks_all):
                if tk in ("rg", "RG") and i >= 3:
                    rgb_ops += 1
        if "BT" not in t:
            continue
        toks = t.split()
        nums = []
        pf = None
        for tk in toks:
            if tk == "k" and len(nums) >= 4:
                pf = tuple(nums[-4:])
                nums = []
            elif tk in PAINT:
                pf = None
                nums = []
            elif tk in SHOW:
                if pf is not None:
                    c, m, y, k = pf
                    if cmyk_max_rgb(c, m, y, k) <= BLACK_MAX_RGB:
                        if (c + m + y) <= 0.01:
                            k100 += 1
                        else:
                            quadri += 1
                pf = None
                nums = []
            else:
                try:
                    nums.append(float(tk))
                    nums = nums[-4:]
                except ValueError:
                    nums = []
    return {"k100": k100, "quadri": quadri, "rgb_ops": rgb_ops}


def _analyze_fonts(doc):
    seen = set()
    not_embedded = set()
    for pno in range(doc.page_count):
        try:
            for f in doc.get_page_fonts(pno, full=True):
                xref = f[0]
                ext = f[1]
                base = f[3]
                if xref in seen:
                    continue
                seen.add(xref)
                if not ext:  # pas d'extension = police non embarquée
                    not_embedded.add(base)
        except Exception:
            pass
    return {"count": len(seen), "not_embedded": sorted(not_embedded)}


def _analyze_boxes(doc):
    need = BLEED_MM * PT_PER_MM
    no_trim, low_bleed = [], []
    for pno in range(doc.page_count):
        page = doc[pno]
        try:
            tb = doc.xref_get_key(page.xref, "TrimBox")
            has_trim = tb[0] == "array"
        except Exception:
            has_trim = False
        if not has_trim:
            no_trim.append(pno + 1)
            continue
        try:
            trim = page.trimbox
            bleed = page.bleedbox
            m = min(trim.x0 - bleed.x0, trim.y0 - bleed.y0,
                    bleed.x1 - trim.x1, bleed.y1 - trim.y1)
            if m < need - 0.5:
                low_bleed.append(pno + 1)
        except Exception:
            pass
    return {"no_trim": no_trim, "low_bleed": low_bleed}


def _meta(doc):
    pdfx = None
    oi = None
    try:
        for x in range(1, doc.xref_length()):
            v = doc.xref_get_key(x, "GTS_PDFXVersion")
            if v[0] == "string":
                pdfx = v[1].strip("()")
                break
    except Exception:
        pass
    try:
        cat = doc.pdf_catalog()
        if doc.xref_get_key(cat, "OutputIntents")[0] == "array":
            oi = "présent"
    except Exception:
        pass
    return {"pdfx": pdfx, "output_intent": oi}


# --------------------------------------------------------------------------- #
def analyze(data):
    doc = pymupdf.open(stream=data, filetype="pdf")
    pages = doc.page_count
    img = _analyze_images(doc)
    vec = _analyze_vectors(doc)
    fonts = _analyze_fonts(doc)
    boxes = _analyze_boxes(doc)
    meta = _meta(doc)

    findings = []

    # Texte noir
    if vec["quadri"] > 0:
        findings.append({
            "key": "black", "severity": "crit",
            "title": "Texte noir en quadrichromie",
            "message": f"{vec['quadri']} bloc(s) de texte noir sont fabriqués "
                       "avec les 4 encres au lieu du noir seul (K100). "
                       "Ré-exportez avec le noir en K100.",
            "items": []})
    else:
        findings.append({
            "key": "black", "severity": "ok",
            "title": "Texte noir en noir seul (K100)",
            "message": "Aucun texte noir en quadrichromie.", "items": []})

    # RGB résiduel
    if img["rgb_imgs"] or vec["rgb_ops"]:
        parts = []
        if img["rgb_imgs"]:
            parts.append(f"{len(img['rgb_imgs'])} image(s) RVB")
        if vec["rgb_ops"]:
            parts.append(f"{vec['rgb_ops']} couleur(s) vectorielle(s) RVB")
        findings.append({
            "key": "rgb", "severity": "crit",
            "title": "Couleurs RVB résiduelles",
            "message": "Trouvé : " + ", ".join(parts) +
                       ". Tout doit être converti en CMJN FOGRA52.",
            "items": [f"page {r['page']} ({r['dims']})" for r in img["rgb_imgs"][:8]]})
    else:
        findings.append({
            "key": "rgb", "severity": "ok", "title": "Tout en CMJN",
            "message": "Aucune couleur RVB résiduelle.", "items": []})

    # Encrage TAC
    if img["over_tac"]:
        findings.append({
            "key": "tac", "severity": "warn",
            "title": "Trop d'encre (sur-encrage)",
            "message": f"{len(img['over_tac'])} image(s) dépassent {int(TAC_MAX)}% "
                       "d'encre. À corriger en reconvertissant via FOGRA52.",
            "items": [f"page {t['page']} : {t['tac']}% sur {t['area']}% de l'image"
                      for t in img["over_tac"][:10]]})
    else:
        findings.append({
            "key": "tac", "severity": "ok", "title": "Encrage maîtrisé",
            "message": f"Aucune image au-dessus de {int(TAC_MAX)}% d'encre.",
            "items": []})

    # Résolution
    if img["low_dpi"]:
        findings.append({
            "key": "dpi", "severity": "warn",
            "title": "Images en basse définition",
            "message": f"{len(img['low_dpi'])} image(s) sous {int(DPI_MIN)} dpi. "
                       "À remplacer par des versions de meilleure qualité.",
            "items": [f"page {d['page']} : {d['dpi']} dpi ({d['dims']})"
                      for d in img["low_dpi"][:10]]})
    else:
        findings.append({
            "key": "dpi", "severity": "ok", "title": "Résolution suffisante",
            "message": f"Toutes les images ≥ {int(DPI_MIN)} dpi.", "items": []})

    # Jaunes
    yp = img["yellow"] or 1
    tr_pct = round(100 * img["trace"] / yp)
    if img["trace"] > 0 and tr_pct >= 5:
        findings.append({
            "key": "yellow", "severity": "warn",
            "title": "Jaunes qui peuvent verdir",
            "message": f"Environ {tr_pct}% des zones jaunes contiennent un peu de "
                       "cyan (tendance à tirer vers le vert sur papier non couché). "
                       "À vérifier côté illustration.",
            "items": []})
    else:
        findings.append({
            "key": "yellow", "severity": "ok", "title": "Jaunes propres",
            "message": "Pas de cyan notable dans les jaunes.", "items": []})

    # Polices
    if fonts["not_embedded"]:
        findings.append({
            "key": "fonts", "severity": "crit",
            "title": "Polices non incluses",
            "message": f"{len(fonts['not_embedded'])} police(s) ne sont pas "
                       "incluses dans le PDF (risque de substitution).",
            "items": fonts["not_embedded"][:8]})
    else:
        findings.append({
            "key": "fonts", "severity": "ok", "title": "Polices incluses",
            "message": f"Les {fonts['count']} police(s) sont incluses.", "items": []})

    # Fond perdu
    if boxes["no_trim"] or boxes["low_bleed"]:
        msg = []
        if boxes["no_trim"]:
            msg.append(f"{len(boxes['no_trim'])} page(s) sans cadre de coupe")
        if boxes["low_bleed"]:
            msg.append(f"{len(boxes['low_bleed'])} page(s) avec fond perdu < {int(BLEED_MM)} mm")
        findings.append({
            "key": "bleed", "severity": "warn", "title": "Fond perdu à vérifier",
            "message": " ; ".join(msg) + ".", "items": []})
    else:
        findings.append({
            "key": "bleed", "severity": "ok", "title": "Fond perdu présent",
            "message": f"Cadre de coupe et fond perdu ≥ {int(BLEED_MM)} mm.",
            "items": []})

    n_crit = sum(1 for f in findings if f["severity"] == "crit")
    n_warn = sum(1 for f in findings if f["severity"] == "warn")
    return {"ok": True, "pages": pages, "meta": meta, "findings": findings,
            "n_crit": n_crit, "n_warn": n_warn}
