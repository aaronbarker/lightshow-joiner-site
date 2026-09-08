/**
 * Browser-side audio concat via ffmpeg.wasm (single-thread core).
 * Pairing and order match the FSEQ join. WAV is converted to MP3 first,
 * then MP3s are concatenated — same idea as the Python CLI.
 *
 * The JS wrapper is vendored; the ~32 MB wasm core is fetched from jsDelivr
 * and stored in this origin's Cache Storage for later visits.
 */

import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { fetchFile } from "../vendor/ffmpeg-util/index.js";
import { extensionOf } from "./fseq.js";

/** Only show pad/trim UI notes when the gap is at least this large. */
export const AUDIO_ALIGN_NOTE_MS = 50;

export const FFMPEG_CORE_VERSION = "0.12.10";
export const FFMPEG_CACHE_NAME = `ffmpeg-core-${FFMPEG_CORE_VERSION}`;
export const FFMPEG_CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

const CORE_JS = `${FFMPEG_CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM = `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`;

let ffmpeg = null;
let loadPromise = null;

export function audioFilesForShows(shows) {
  return (shows || []).map((show, index) => {
    const file = show?.audio?.file;
    if (!file) {
      throw new Error(`Show ${index + 1} (${show?.name || "unknown"}) has no paired audio`);
    }
    const ext = extensionOf(file.name) === "mp3" ? "mp3" : "wav";
    return {
      file,
      ext,
      inputName: `in${index}.${ext}`,
      mp3Name: `in${index}.mp3`,
      fitName: `fit${index}.mp3`,
      sourceName: file.name,
    };
  });
}

export function concatListText(mp3Names) {
  return mp3Names.map((name) => `file '${String(name).replaceAll("'", "'\\''")}'`).join("\n") + "\n";
}

/** Positive = audio is short (pad). Negative = audio is long (trim). */
export function audioAlignDeltaMs(audioMs, fseqMs) {
  if (!Number.isFinite(audioMs) || !Number.isFinite(fseqMs) || audioMs < 0 || fseqMs < 0) {
    return null;
  }
  return fseqMs - audioMs;
}

export function formatAlignSeconds(ms) {
  const seconds = Math.abs(ms) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds >= 10) return `${seconds.toFixed(1)}s`;
  if (seconds >= 0.1) return `${seconds.toFixed(1)}s`;
  return `${seconds.toFixed(2)}s`;
}

export function formatAudioAlignNote(deltaMs, thresholdMs = AUDIO_ALIGN_NOTE_MS) {
  if (!Number.isFinite(deltaMs) || Math.abs(deltaMs) < thresholdMs) return "";
  const label = formatAlignSeconds(deltaMs);
  if (deltaMs > 0) return `${label} will be padded to audio to match fseq timing`;
  return `${label} will be trimmed from audio to match fseq timing`;
}

export function formatIdleTailTrimNote(surplusMs) {
  if (!Number.isFinite(surplusMs) || surplusMs < AUDIO_ALIGN_NOTE_MS) return "";
  return `${formatAlignSeconds(surplusMs)} idle FSEQ tail will be trimmed to match audio`;
}

export function formatActiveTailWarningNote(surplusMs) {
  if (!Number.isFinite(surplusMs) || surplusMs < AUDIO_ALIGN_NOTE_MS) return "";
  return `FSEQ runs ${formatAlignSeconds(surplusMs)} past audio; trailing frames are active`;
}

/** Row note: idle trim, active-tail warning, or the existing pad/trim audio line. */
export function formatShowAlignNote(plan, extraMs = 0, thresholdMs = AUDIO_ALIGN_NOTE_MS) {
  if (!plan) return "";
  if (plan.action === "trim") return formatIdleTailTrimNote(plan.surplusMs);
  if (plan.action === "active") return formatActiveTailWarningNote(plan.surplusMs);
  const targetMs = (Number.isFinite(plan.fseqMs) ? plan.fseqMs : 0) + (Number(extraMs) || 0);
  return formatAudioAlignNote(audioAlignDeltaMs(plan.audioMs, targetMs), thresholdMs);
}

function bytesFromWavBuffer(buffer) {
  if (!buffer) return null;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer.buffer instanceof ArrayBuffer && Number.isFinite(buffer.byteLength)) {
    const offset = Number.isFinite(buffer.byteOffset) ? buffer.byteOffset : 0;
    return new Uint8Array(buffer.buffer, offset, buffer.byteLength);
  }
  return new Uint8Array(buffer);
}

/** PCM WAV duration from RIFF header + data chunk. */
export function wavDurationMs(buffer) {
  if (!buffer || buffer.byteLength < 44) return null;
  const bytes = bytesFromWavBuffer(buffer);
  if (!bytes || bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (tag(0, 4) !== "RIFF" || tag(8, 4) !== "WAVE") return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const bytesPerSample = bitsPerSample / 8;
      if (!sampleRate || !channels || !bytesPerSample) return null;
      return (size / (bytesPerSample * channels) / sampleRate) * 1000;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export function formatFfmpegDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "0";
  return value.toFixed(3);
}

/**
 * Pad with silence if short, trim if long: `apad` then cut at the FSEQ duration.
 * Same args for WAV→MP3 and already-MP3 inputs.
 */
export function audioFitArgs(inputName, outputName, durationSec) {
  return ["-y", "-i", inputName, "-af", "apad", "-t", formatFfmpegDuration(durationSec), "-q:a", "9", outputName];
}

export function summarizeAudioAlign(deltas, { idleTrimmed = 0, activeTails = 0 } = {}) {
  let padded = 0;
  let trimmed = 0;
  for (const delta of deltas || []) {
    if (!Number.isFinite(delta)) continue;
    if (delta >= AUDIO_ALIGN_NOTE_MS) padded += 1;
    else if (delta <= -AUDIO_ALIGN_NOTE_MS) trimmed += 1;
  }
  const parts = [];
  if (idleTrimmed) {
    parts.push(
      `Idle FSEQ tail trimmed on ${idleTrimmed} show${idleTrimmed === 1 ? "" : "s"}.`
    );
  }
  if (activeTails) {
    parts.push(
      `FSEQ ran past audio with active trailing frames on ${activeTails} show${activeTails === 1 ? "" : "s"}.`
    );
  }
  if (padded || trimmed) {
    const audioParts = [];
    if (padded) audioParts.push(`padded ${padded}`);
    if (trimmed) audioParts.push(`trimmed ${trimmed}`);
    parts.push(`Audio ${audioParts.join(" and ")} to match FSEQ timing.`);
  }
  return parts.join(" ");
}

export async function measureMediaDurationMs(file) {
  if (!file) return null;
  if (typeof document === "undefined") {
    if (extensionOf(file.name) === "wav") {
      return wavDurationMs(await file.arrayBuffer());
    }
    return null;
  }
  if (extensionOf(file.name) === "wav") {
    try {
      const fromHeader = wavDurationMs(await file.arrayBuffer());
      if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
    } catch {
      // Fall through to the media element.
    }
  }
  return new Promise((resolve) => {
    const el = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (ms) => {
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        // Ignore reset errors.
      }
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => {
      const duration = el.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration * 1000 : null);
    });
    el.addEventListener("error", () => finish(null));
    el.src = url;
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDownloadProgress({ received, total }) {
  if (total > 0) {
    const pct = Math.min(100, Math.round((received / total) * 100));
    return `Loading ffmpeg… ${pct}% (${formatBytes(received)} / ${formatBytes(total)}). First visit downloads the engine; later joins reuse the browser cache.`;
  }
  return `Loading ffmpeg… ${formatBytes(received) || "starting"} downloaded.`;
}

async function responseToUint8(response, onProgress) {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !response.body.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ received: buffer.byteLength, total: buffer.byteLength });
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function cachedBlobURL(url, mimeType, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(FFMPEG_CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      onProgress?.({ received: 1, total: 1, cached: true });
      const buffer = await hit.arrayBuffer();
      return URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    }
  } catch {
    cache = null;
  }

  const fetched = await fetch(url);
  if (!fetched.ok) {
    throw new Error(`Could not download ffmpeg core (${fetched.status} from ${url})`);
  }
  const bytes = await responseToUint8(fetched, onProgress);
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { "Content-Type": mimeType } }));
    } catch {
      // Quota or private-mode cache failure should not block joining.
    }
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export async function loadFfmpeg(onStatus) {
  if (ffmpeg?.loaded) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    instance.on("progress", ({ progress }) => {
      const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
      onStatus?.(`Joining audio… ${pct}%`);
    });

    onStatus?.("Loading ffmpeg… downloading the browser engine (about 32 MB, then cached).");
    const coreURL = await cachedBlobURL(CORE_JS, "text/javascript", () => {
      onStatus?.("Loading ffmpeg… core script.");
    });
    const wasmURL = await cachedBlobURL(CORE_WASM, "application/wasm", (info) => {
      if (info.cached) {
        onStatus?.("Loading ffmpeg… using cached engine.");
        return;
      }
      onStatus?.(formatDownloadProgress(info));
    });

    onStatus?.("Starting ffmpeg…");
    await instance.load({ coreURL, wasmURL });
    ffmpeg = instance;
    return instance;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

export function preloadFfmpeg() {
  if (typeof window === "undefined") return Promise.resolve(null);
  return loadFfmpeg();
}

async function execOrThrow(instance, args, label, logs) {
  const code = await instance.exec(args);
  if (code === 0) return;
  const tail = (logs || []).slice(-6).join(" | ");
  throw new Error(`${label} failed (ffmpeg exit ${code})${tail ? `: ${tail}` : ""}`);
}

export async function joinShowAudio(shows, onStatus, { targetDurationsSec = [] } = {}) {
  const inputs = audioFilesForShows(shows);
  if (inputs.length < 2) {
    throw new Error("Need at least two paired audio files to join");
  }

  const instance = await loadFfmpeg(onStatus);
  const logs = [];
  const onLog = ({ message }) => {
    if (message) logs.push(message);
  };
  instance.on("log", onLog);

  const written = [];
  try {
    const mp3Names = [];
    let convertedWav = 0;
    let fitted = 0;

    for (const [index, item] of inputs.entries()) {
      onStatus?.(`Writing audio ${index + 1} of ${inputs.length} (${item.sourceName})…`);
      const bytes = await fetchFile(item.file);
      await instance.writeFile(item.inputName, bytes);
      written.push(item.inputName);

      const targetSec = Number(targetDurationsSec[index]);
      const shouldFit = Number.isFinite(targetSec) && targetSec > 0;
      if (shouldFit) {
        const verb = item.ext === "wav" ? "Converting and fitting" : "Fitting";
        onStatus?.(`${verb} ${item.sourceName} to ${formatFfmpegDuration(targetSec)}s (FSEQ timing)…`);
        await execOrThrow(
          instance,
          audioFitArgs(item.inputName, item.fitName, targetSec),
          `Fit audio for ${item.sourceName}`,
          logs
        );
        written.push(item.fitName);
        if (item.ext === "wav") convertedWav += 1;
        fitted += 1;
        mp3Names.push(item.fitName);
      } else if (item.ext === "wav") {
        onStatus?.(`Converting ${item.sourceName} (WAV → MP3)…`);
        await execOrThrow(
          instance,
          ["-y", "-i", item.inputName, "-q:a", "9", item.mp3Name],
          `WAV→MP3 for ${item.sourceName}`,
          logs
        );
        written.push(item.mp3Name);
        convertedWav += 1;
        mp3Names.push(item.mp3Name);
      } else {
        mp3Names.push(item.inputName);
      }
    }

    await instance.writeFile("concat.txt", new TextEncoder().encode(concatListText(mp3Names)));
    written.push("concat.txt");

    onStatus?.("Concatenating audio in table order…");
    try {
      await execOrThrow(
        instance,
        ["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "out.mp3"],
        "MP3 concat (copy)",
        logs
      );
    } catch {
      onStatus?.("Stream-copy concat failed; re-encoding MP3…");
      await execOrThrow(
        instance,
        ["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-q:a", "9", "out.mp3"],
        "MP3 concat (re-encode)",
        logs
      );
    }
    written.push("out.mp3");

    const output = await instance.readFile("out.mp3");
    if (!output?.byteLength) {
      throw new Error("ffmpeg produced an empty MP3");
    }
    return {
      bytes: output instanceof Uint8Array ? output : new Uint8Array(output),
      convertedWav,
      fitted,
      count: inputs.length,
    };
  } finally {
    instance.off("log", onLog);
    for (const path of written) {
      try {
        await instance.deleteFile(path);
      } catch {
        // Ignore cleanup errors so a successful join still downloads.
      }
    }
  }
}
