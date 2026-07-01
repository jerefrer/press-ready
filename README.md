# Bon à tirer 🎨

Petit outil web pour **vérifier un PDF avant l'imprimeur** (offset, papier non couché,
profil FOGRA52) — pensé pour la série *Maintenant, je sais…* (Padmakara).

On glisse un PDF, l'outil dit **ce qui va** et **ce qui mérite un coup d'œil** :
texte noir en quadrichromie, sur-encrage, images basse définition, couleurs RVB
résiduelles, jaunes qui risquent de verdir, polices non incluses, fond perdu.

**Tout se passe dans le navigateur** (WebAssembly / Pyodide + PyMuPDF) : le PDF
n'est jamais envoyé sur un serveur. Rien à installer.

## Utilisation

Ouvrez la page, glissez un PDF. Le premier chargement télécharge l'atelier
(~30 Mo, mis en cache ensuite). Le rapport peut être enregistré en PDF via le
bouton « Enregistrer en PDF / imprimer ».

## Mettre en ligne sur GitHub Pages

1. Créez un dépôt sur GitHub et poussez ce dossier :
   ```bash
   git remote add origin git@github.com:VOTRE-COMPTE/bon-a-tirer.git
   git push -u origin main
   ```
2. Sur GitHub : **Settings → Pages → Source : Deploy from a branch → `main` / `root`**.
3. L'outil sera en ligne à `https://VOTRE-COMPTE.github.io/bon-a-tirer/`.

## Contenu

| Fichier | Rôle |
|---|---|
| `index.html` | l'interface |
| `assets/style.css` | le design (univers peint + encres CMJN) |
| `assets/app.js` | glisser-déposer + orchestration Pyodide |
| `assets/analyzer.py` | le moteur d'analyse (PyMuPDF + Pillow + numpy) |
| `vendor/pymupdf-…-wasm32.whl` | PyMuPDF compilé pour le navigateur (WebAssembly) |

## Notes techniques

- Pyodide 0.28.2 (chargé depuis le CDN jsDelivr) ; PyMuPDF 1.28 via
  `loadPackage()` (⚠️ `micropip` ne fonctionne pas pour PyMuPDF).
- Le moteur reprend les seuils validés : jaune Y≥70 / C≥5 / M≤40 / K≤20,
  encrage total (TAC) ≤ 300 %, résolution ≥ 300 dpi, fond perdu ≥ 3 mm.
- Lecture seule : l'outil ne modifie ni n'enregistre le PDF.

## Compatibilité

Fonctionne sur tout navigateur récent (Chrome, Firefox, Safari, Edge) avec
support WebAssembly — donc aussi sur des Mac plus anciens dotés d'un navigateur
à jour.
