# Vendored ffmpeg.wasm wrappers

Small MIT-licensed JavaScript wrappers from [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). The large `ffmpeg-core.wasm` (~32 MB) is **not** in this repo; the site downloads it from jsDelivr on first use and caches it in the browser.

| Package | Version | Path |
| --- | --- | --- |
| `@ffmpeg/ffmpeg` | 0.12.10 | `vendor/ffmpeg/` |
| `@ffmpeg/util` | 0.12.1 | `vendor/ffmpeg-util/` |
| `@ffmpeg/core` (CDN) | 0.12.10 | `https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/` |

Single-thread core is used so GitHub Pages does not need COOP/COEP headers.
