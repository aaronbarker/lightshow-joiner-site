# Lightshow Joiner (web)

Browser-only Tesla lightshow joiner. Companion to the Python CLI in [aaronbarker/lightshow-joiner](https://github.com/aaronbarker/lightshow-joiner).

Drop a folder (or pick `.fseq` / `.mp3` / `.wav` files), scan each show the way the CLI terminal scan does, sort or reorder the table, and join compatible uncompressed V2 FSEQ files. **Nothing is uploaded** — all parsing and joining happens in your browser.

The Python CLI stays in its own repo. This site does not modify that project.

## Use it

1. Open the site (local preview or GitHub Pages).
2. Drag a lightshow folder onto the drop zone, or use **Choose files** / **Choose folder**. Folder pick needs a browser that supports `webkitdirectory` (desktop Chrome and Safari do).
3. Review the table: name (play/pause plus a scrubber when a row has audio), channels, step time, duration (`m:ss`), audio match (`mp3` / `wav` / `missing`), and compatibility. When a track is meaningfully longer or shorter than the FSEQ, a pad/trim note appears under Compatibility. Tesla validator still runs; a failed source shows a **Validator failed** badge under the title. After **Join & download**, each included row also gets a **Join verified** or **Join mismatch** badge — the joined FSEQ is compared segment-by-segment to that show’s frames (after the same 48→200 / 50→20 transforms; reset tails are skipped in the compare).
4. Compatible shows default to **include** (48 channels + 20 ms, with matching audio). **50 ms** shows stay skipped unless you turn on experimental **Convert 50ms → 20ms**. **200-channel** shows stay skipped unless you turn on **Upgrade 48ch → 200ch**.
5. Missing pairs (`.fseq` without audio, or audio without `.fseq`) are shown as **red error rows** with the include checkbox disabled. Incompatible shows (wrong step time, channel mismatch vs the current join target, compressed/invalid) also have the checkbox locked.
6. Sort by clicking column headers (starts as name ascending). Drag the `⋮⋮` handle to set join order.
7. Watch **Total time of combined output** — it sums the currently checked, join-eligible rows (plus closure-reset tails when that option is on) and updates when you change includes, sort/order, 48→200 upgrade, 50→20 conversion, or closure reset.
8. **Join & download** concatenates frame data (same as `joiner-fseq.py`) and joins matching audio in that same table order. Each track is **padded with silence or trimmed** so its length matches that show’s FSEQ duration (after 50→20 / 48→200). That keeps lights and audio aligned at every show boundary instead of letting small gaps stack toward later songs. A pad/trim note appears under Compatibility when the difference is at least ~50 ms. WAV files are converted to MP3 in the browser (ffmpeg.wasm), then the fitted MP3s are concatenated. You get a `.zip` with `name.fseq` + `name.mp3`. If audio join fails, the FSEQ still downloads and the error is shown. The joiner then checks each included show against that slice of the output and shows **Join verified** or **Join mismatch** under the name (first mismatched frame, or a length/channel/step error).
9. **Reset closures between shows** (on by default) counts Open/Close/Dance on the closure channels, then injects **one** defaults reset (trunk/charge **closed**, windows/mirrors **open**) after the last included show that still has Tesla command budget. It does not reset after every track. If even that one extra command would be ignored, the inject is skipped. The options area shows per-type counts vs limits (e.g. `Liftgate: 8/6 commands — vehicle will ignore extras`). Idle/Stop do not count. Limits per joined USB show: liftgate 6, each window 6, each mirror 20, charge port 3.

The first audio join downloads the ffmpeg.wasm engine (~32 MB from jsDelivr) and caches it in this browser. Later joins reuse that cache. Nothing is uploaded.

**Load sample shows** builds synthetic PSEQ files in memory so you can try the table and join without Tesla files.

## Local preview

ES modules need a local HTTP server (opening `index.html` as a `file://` URL may fail):

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080

FSEQ parse/join, duration, zip, and audio-helper unit tests (no browser required):

```bash
npm test
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

## Compatibility (same as the CLI, plus optional 48→200 and experimental 50→20)

| Show type        | Default        |
| ---------------- | -------------- |
| 48 channels, 20 ms, uncompressed V2, with audio | Include |
| Missing `.fseq` / audio pair | Error row (checkbox disabled) |
| 50 ms step time  | Skip, unless **Convert 50ms → 20ms** is on |
| 200 channels, 20 ms | Skip, unless **Upgrade 48ch → 200ch** is on |

Join still requires matching step time across the checked rows, or enable **Convert 50ms → 20ms** (experimental) near the join button. That option expands 50 ms frames onto a 20 ms grid so wall-clock duration stays matched to the audio: every two original frames (100 ms) become five 20 ms frames (for example `A,A,A,B,B`). It does **not** only rewrite the header `step_time`, and it does **not** convert 20 ms → 50 ms. Lights may look slightly less tight to the beat, with possible ~10 ms local stutter — not runaway drift if duration is preserved.

Channel counts must match, or enable **Upgrade 48ch → 200ch**. That option expands each 48-channel frame to 200 channels by padding unused channels with zeros and updates the FSEQ header channel count to 200. The two options can be combined (a 48ch / 50ms show becomes 200ch / 20ms).

Tesla `validator.py` checks run client-side (PSEQ magic, 48 or 200 channels, uncompressed, step ≥ 15 ms, duration under 4 hours).

## Audio length vs FSEQ

Shows often have an MP3/WAV that is slightly shorter or longer than `frames × step`. The joiner measures each included track against that show’s FSEQ duration **after** the same 50→20 / 48→200 transforms used at join, then pads or trims before concat. Combined output time is the FSEQ (plus any closure-reset tails), not the original audio lengths.

## Closure reset tails

Tesla closures use command bytes `0` idle, `64` open, `128` dance, `192` close, `255` stop on the usual 48-channel layout (same first 48 channels when upgraded to 200): mirrors 35–36, windows 37–40, liftgate 41, charge port 46. Tails hold the reset command long enough for the movement (about 4 s for liftgate close / windows, 2 s for mirrors / charge port) with lights off.

Actuation limits apply to the **whole joined file**. The joiner counts existing Open/Close/Dance runs, reserves one slot for a defaults reset, and places that single tail after the latest show (or last open) where `source commands so far + 1` still fits. Later source commands may still push the file over the cap — the UI warns `Type: used/limit commands — vehicle will ignore extras`. If no inject point has a free slot, the reset is skipped and the same warning is shown.
