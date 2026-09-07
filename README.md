# Lightshow Joiner (web)

Browser-only Tesla lightshow joiner. Companion to the Python CLI in [aaronbarker/lightshow-joiner](https://github.com/aaronbarker/lightshow-joiner).

Drop a folder (or pick `.fseq` / `.mp3` / `.wav` files), scan each show the way the CLI terminal scan does, sort or reorder the table, and join compatible uncompressed V2 FSEQ files. **Nothing is uploaded** — all parsing and joining happens in your browser.

The Python CLI stays in its own repo. This site does not modify that project.

## Use it

1. Open the site (local preview or GitHub Pages).
2. Drag a lightshow folder onto the drop zone, or use **Choose files** / **Choose folder**. Folder pick needs a browser that supports `webkitdirectory` (desktop Chrome and Safari do).
3. Review the table: name, channels, step time, frames, duration, audio match (`mp3` / `wav` / `missing`), compatibility, and Tesla-style validator result.
4. Compatible shows default to **include** (48 channels + 20 ms). **50 ms** and **200-channel** shows are skipped, matching the Python tool. You can check a homogeneous set if you want to join those instead.
5. Sort by clicking column headers (starts as name ascending). Drag the `⋮⋮` handle to set join order.
6. **Join & download .fseq** concatenates frame data and rewrites the frame count, same as `joiner-fseq.py`.

Audio concatenation (ffmpeg.wasm) is not in this first ship. Pair the downloaded `.fseq` with audio yourself, or use the Python CLI + ffmpeg for MP3 join.

**Load sample shows** builds synthetic PSEQ files in memory so you can try the table and join without Tesla files.

## Local preview

ES modules need a local HTTP server (opening `index.html` as a `file://` URL may fail):

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080

FSEQ parse/join unit tests (no browser required):

```bash
node --test test/fseq.test.mjs
```

## Enable GitHub Pages

This repo is static files at the repository root (`index.html`, `styles.css`, `js/`). No build step.

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to **`/ (root)`**.
4. Click **Save**.
5. After it deploys, the site is at `https://<user>.github.io/lightshow-joiner-site/` (or your custom domain).

Notes:

- A **private** repository can use Pages if your GitHub plan allows it (GitHub Pro / Team / Education, or a public repo). If Pages is disabled, make the repo public or upgrade, then repeat the steps above.
- `.nojekyll` is included so GitHub does not run Jekyll on the `js/` folder.
- Hosting this site is not an upload backend. User lightshows never leave the browser.

## Compatibility (same as the CLI)

| Show type        | Default        |
| ---------------- | -------------- |
| 48 channels, 20 ms, uncompressed V2 | Include |
| 50 ms step time  | Skip           |
| 200 channels     | Skip           |

Join still requires matching channel count and step time across the checked rows. Tesla `validator.py` checks run client-side (PSEQ magic, 48 or 200 channels, uncompressed, step ≥ 15 ms, duration under 4 hours).
