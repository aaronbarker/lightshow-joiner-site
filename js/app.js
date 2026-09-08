import {
  parseFseqHeader,
  validateFseq,
  joinFseqBuffers,
  createSampleFseq,
  createSilentWav,
  formatDuration,
  formatDurationWords,
  totalIncludedDurationMs,
  joinDurationMs,
  durationMs,
  stemOf,
  extensionOf,
  defaultInclude,
  isSelectableForJoin,
  resolveJoinTarget,
  rowCompatibility,
  missingPairNote,
  isMissingPair,
  effectiveStepTime,
  stepConvertChangeShiftStats,
  validateJoinedSegments,
  formatJoinVerifySummary,
  SKIP_STEP_MS,
} from "./fseq.js";
import {
  joinShowAudio,
  preloadFfmpeg,
  formatAudioAlignNote,
  audioAlignDeltaMs,
  measureMediaDurationMs,
  summarizeAudioAlign,
} from "./audio-join.js";
import {
  analyzeClosureUsage,
  emptyClosureUsage,
  formatClosureResetSummary,
  planClosureResets,
} from "./closures.js";
import { createZipStore } from "./zip.js";

const ACCEPTED = new Set(["fseq", "mp3", "wav"]);
const PREVIEW_ICON_PLAY =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.15v9.7L13.2 8 5 3.15z"/></svg>';
const PREVIEW_ICON_PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 3h3.1v10H4zm4.9 0H12v10H8.9z"/></svg>';

const preview = {
  showId: null,
  audio: new Audio(),
  objectUrl: null,
  seeking: false,
};

const state = {
  shows: [],
  audioByKey: new Map(),
  sortKey: "name",
  sortDir: "asc",
  customOrder: false,
  upgrade48to200: false,
  convert50to20: false,
  resetClosures: true,
};

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  folderInput: document.getElementById("folder-input"),
  pickFiles: document.getElementById("pick-files"),
  pickFolder: document.getElementById("pick-folder"),
  loadSamples: document.getElementById("load-samples"),
  results: document.getElementById("results"),
  stats: document.getElementById("stats"),
  rows: document.getElementById("show-rows"),
  joinBtn: document.getElementById("join-btn"),
  outputName: document.getElementById("output-name"),
  upgrade48to200: document.getElementById("upgrade-48-to-200"),
  convert50to20: document.getElementById("convert-50-to-20"),
  resetClosures: document.getElementById("reset-closures"),
  stepConvertWarning: document.getElementById("step-convert-warning"),
  closureResetWarning: document.getElementById("closure-reset-warning"),
  combinedTimeValue: document.getElementById("combined-time-value"),
  joinStatus: document.getElementById("join-status"),
  clearShows: document.getElementById("clear-shows"),
  selectCompatible: document.getElementById("select-compatible"),
};

function joinOptions() {
  return {
    upgrade48to200: state.upgrade48to200,
    convert50to20: state.convert50to20,
    resetClosures: state.resetClosures,
  };
}

function fileKey(file) {
  return (file.webkitRelativePath || file.name).replaceAll("\\", "/");
}

function basename(path) {
  return path.split("/").pop() || path;
}

function dirname(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  parts.pop();
  return parts.join("/");
}

function isAccepted(file) {
  return ACCEPTED.has(extensionOf(file.name));
}

async function walkEntry(entry, files) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    try {
      Object.defineProperty(file, "webkitRelativePath", {
        value: entry.fullPath.replace(/^\//, ""),
        configurable: true,
      });
    } catch {
      // File.webkitRelativePath is read-only in some browsers; fileKey falls back to name.
    }
    files.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  for (const child of children) {
    await walkEntry(child, files);
  }
}

async function filesFromDataTransfer(dataTransfer) {
  const collected = [];
  const items = [...(dataTransfer.items || [])];
  const entries = items
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length) {
    for (const entry of entries) {
      await walkEntry(entry, collected);
    }
    return collected;
  }
  return [...(dataTransfer.files || [])];
}

function pairAudio(showPath, audioFiles) {
  const stem = stemOf(basename(showPath));
  const dir = dirname(showPath);
  const matches = audioFiles.filter((file) => stemOf(fileKey(file)) === stem);
  const sameDir = matches.filter((file) => dirname(fileKey(file)) === dir);
  const pool = sameDir.length ? sameDir : matches;
  const mp3 = pool.find((file) => extensionOf(file.name) === "mp3");
  const wav = pool.find((file) => extensionOf(file.name) === "wav");
  if (mp3) return { kind: "mp3", file: mp3 };
  if (wav) return { kind: "wav", file: wav };
  return { kind: "missing", file: null };
}

async function ingestFiles(fileList, { replace = false } = {}) {
  const files = [...fileList].filter(isAccepted);
  if (!files.length) {
    setJoinStatus("No .fseq / .mp3 / .wav files found in that drop.", "warn");
    return;
  }

  if (replace) {
    stopPreview();
    state.shows = [];
    state.audioByKey.clear();
  }

  const audioFiles = files.filter((file) => extensionOf(file.name) !== "fseq");
  const fseqFiles = files.filter((file) => extensionOf(file.name) === "fseq");

  for (const file of audioFiles) {
    state.audioByKey.set(fileKey(file), file);
  }

  if (!fseqFiles.length && !state.shows.length) {
    render();
    setJoinStatus("Audio files were added, but no matching .fseq sequences yet.", "warn");
    return;
  }

  const existing = new Set(state.shows.map((show) => show.path));
  for (const file of fseqFiles) {
    const path = fileKey(file);
    if (existing.has(path)) continue;
    const show = await readShow(file, path, [...state.audioByKey.values()]);
    state.shows.push(show);
  }

  // Re-pair audio in case matching wav/mp3 arrived after an fseq.
  const allAudio = [...state.audioByKey.values()];
  for (const show of state.shows) {
    const wasMissing = show.audio?.kind === "missing";
    show.audio = pairAudio(show.path, allAudio);
    if (show.audio?.file) {
      show.audioDurationMs = await measureMediaDurationMs(show.audio.file);
    } else {
      show.audioDurationMs = null;
    }
    if (wasMissing && defaultInclude(show, joinOptions())) {
      show.include = true;
    }
  }
  applyEligibility();
  clearJoinVerify();

  state.sortKey = "name";
  state.sortDir = "asc";
  state.customOrder = false;
  sortShows();
  render();
  preloadFfmpeg().catch(() => {
    // Join will surface a real error if the engine is still unavailable.
  });
}

async function readShow(file, path, audioFiles) {
  const headerBytes = await file.slice(0, 64).arrayBuffer();
  let header = null;
  let error = null;
  try {
    header = parseFseqHeader(headerBytes);
  } catch (err) {
    error = err.message;
  }

  const validation = error ? { ok: false, errors: [error], warnings: [] } : validateFseq(headerBytes);
  const audio = pairAudio(path, audioFiles);
  const show = {
    id: `${path}:${file.size}:${file.lastModified}`,
    path,
    name: basename(path),
    file,
    header,
    error,
    validation,
    include: false,
    audio,
    changeShift: null,
    closureUsage: emptyClosureUsage(),
    audioDurationMs: null,
    joinVerify: null,
  };
  const extras = await readShowFrameExtras(file, header);
  show.changeShift = extras.changeShift;
  show.closureUsage = extras.closureUsage;
  if (audio.file) {
    show.audioDurationMs = await measureMediaDurationMs(audio.file);
  }
  show.include = defaultInclude(show, joinOptions());
  return show;
}

async function readShowFrameExtras(file, header) {
  const empty = { changeShift: null, closureUsage: emptyClosureUsage() };
  if (!file || !header || header.compression !== 0) return empty;
  const channelCount = header.channelCount;
  const frameCount = header.frameCount;
  if (!channelCount || !frameCount || channelCount < 1 || frameCount < 1) return empty;
  const start = header.dataOffset;
  const size = channelCount * frameCount;
  if (!Number.isFinite(start) || !Number.isFinite(size) || start < 0 || size < 1) return empty;
  try {
    const frameBuf = await file.slice(start, start + size).arrayBuffer();
    const frameData = new Uint8Array(frameBuf);
    return {
      changeShift:
        header.stepTime === SKIP_STEP_MS
          ? stepConvertChangeShiftStats(frameData, channelCount, frameCount)
          : null,
      closureUsage: analyzeClosureUsage(frameData, channelCount, frameCount),
    };
  } catch {
    return empty;
  }
}

function sortShows() {
  if (state.customOrder) return;
  const dir = state.sortDir === "asc" ? 1 : -1;
  const key = state.sortKey;

  const valueOf = (show) => {
    if (key === "name") return show.name.toLowerCase();
    if (key === "channels") return show.header?.channelCount ?? -1;
    if (key === "stepTime") return show.header?.stepTime ?? -1;
    if (key === "duration") return show.header ? durationMs(show.header) : -1;
    if (key === "audio") return show.audio.kind;
    if (key === "compat") {
      return rowCompatibility(show, resolveJoinTarget(state.shows, joinOptions()), joinOptions()).note.toLowerCase();
    }
    if (key === "valid") return show.validation.ok ? 1 : 0;
    return show.name.toLowerCase();
  };

  state.shows.sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * dir;
    }
    return String(left).localeCompare(String(right), undefined, { numeric: true }) * dir;
  });
}

function includedShows() {
  return state.shows.filter((show) => show.include && show.header && !show.orphanAudio);
}

function closureResetPlan(shows = includedShows()) {
  const options = joinOptions();
  if (!options.resetClosures) return { enabled: false, tails: [], warnings: [] };
  return planClosureResets(
    shows.map((show) => ({
      usage: show.closureUsage || emptyClosureUsage(),
      stepTime: effectiveStepTime(show.header.stepTime, options),
      name: show.name,
    })),
    { enabled: true }
  );
}

function audioAlignNoteFor(show, options = joinOptions(), extraMs = 0) {
  if (!show?.header || !Number.isFinite(show.audioDurationMs)) return "";
  const targetMs = joinDurationMs(show.header, options) + (Number(extraMs) || 0);
  const delta = audioAlignDeltaMs(show.audioDurationMs, targetMs);
  return formatAudioAlignNote(delta);
}

function orphanAudioShows() {
  const paired = new Set();
  for (const show of state.shows) {
    if (show.audio?.file) paired.add(fileKey(show.audio.file));
  }
  const orphans = [];
  for (const [key, file] of state.audioByKey) {
    if (paired.has(key)) continue;
    const kind = extensionOf(file.name) === "mp3" ? "mp3" : "wav";
    orphans.push({
      id: `orphan-audio:${key}:${file.size}:${file.lastModified}`,
      path: key,
      name: basename(key),
      file: null,
      header: null,
      error: "Audio without matching .fseq",
      validation: { ok: false, errors: ["Audio without matching .fseq"], warnings: [] },
      include: false,
      audio: { kind, file },
      orphanAudio: true,
      joinVerify: null,
    });
  }
  return orphans;
}

function displayShows() {
  return [...state.shows, ...orphanAudioShows()];
}

function clearJoinVerify() {
  for (const show of state.shows) {
    show.joinVerify = null;
  }
}

function applyEligibility({ selectCompatible = false } = {}) {
  const options = joinOptions();
  const target = resolveJoinTarget(state.shows, options);
  for (const show of state.shows) {
    const selectable = isSelectableForJoin(show, target, options);
    if (!selectable) {
      show.include = false;
    } else if (selectCompatible) {
      show.include = defaultInclude(show, options) || (target ? selectable : show.include);
    }
  }
}

function render() {
  const rows = displayShows();
  const hasShows = rows.length > 0;
  els.results.classList.toggle("is-visible", hasShows);
  if (!hasShows) {
    stopPreview();
    els.rows.innerHTML = "";
    els.stats.innerHTML = "";
    updateCombinedTime([]);
    updateStepConvertWarning();
    updateClosureResetWarning();
    return;
  }

  const options = joinOptions();
  const target = resolveJoinTarget(state.shows, options);
  const included = includedShows();
  const resetPlan = options.resetClosures ? closureResetPlan(included) : null;
  const tailMsById = new Map();
  if (resetPlan) {
    included.forEach((show, index) => {
      tailMsById.set(show.id, resetPlan.tails[index]?.durationMs || 0);
    });
  }
  const pairErrors = rows.filter((show) => isMissingPair(show)).length;
  const skipped = rows.length - included.length;
  els.stats.innerHTML = `
    <span class="chip"><strong>${rows.length}</strong> scanned</span>
    <span class="chip include"><strong>${included.length}</strong> included</span>
    <span class="chip skip"><strong>${skipped}</strong> skipped / blocked</span>
    ${pairErrors ? `<span class="chip error"><strong>${pairErrors}</strong> missing pair</span>` : ""}
  `;

  els.rows.innerHTML = rows
    .map((show, index) => {
      const header = show.header;
      const compat = rowCompatibility(show, target, options);
      const audioNote = audioAlignNoteFor(show, options, tailMsById.get(show.id) || 0);
      const selectable = isSelectableForJoin(show, target, options);
      const pairNote = missingPairNote(show);
      const errorRow = Boolean(pairNote || show.error || show.orphanAudio);
      const audioLabel = show.orphanAudio
        ? `${show.audio.kind} (no .fseq)`
        : show.audio.kind === "missing"
          ? "missing pair"
          : show.audio.kind;
      const audioClass = show.audio.kind === "missing" || show.orphanAudio ? "error" : `audio-${show.audio.kind}`;
      const validTitle = show.validation.ok
        ? show.validation.warnings?.join(" ") || "Tesla validator checks passed"
        : show.validation.errors.join(" ");
      const rowClass = [
        errorRow ? "is-error" : "",
        !errorRow && compat.kind === "skip" ? "is-skip" : "",
        show.include ? "" : "is-excluded",
      ]
        .filter(Boolean)
        .join(" ");
      const statusText = pairNote || show.error || "";
      const canPreview = hasPreviewableAudio(show);
      const validatorFailed = !show.validation.ok && !show.orphanAudio;
      const playButton = canPreview
        ? `<button type="button" class="preview-play" data-action="preview" title="Play" aria-label="Play ${escapeAttr(show.name)}" aria-pressed="false">${PREVIEW_ICON_PLAY}</button>`
        : "";
      const scrubber = canPreview
        ? `<input type="range" class="preview-scrubber" min="0" max="1000" value="0" step="1" hidden aria-label="Seek ${escapeAttr(show.name)}" />`
        : "";
      const metaBits = [
        statusText ? `<span class="row-status">${escapeHtml(statusText)}</span>` : "",
        validatorFailed
          ? `<span class="badge error validator-fail" title="${escapeAttr(validTitle)}">Validator failed</span>`
          : "",
        show.joinVerify
          ? `<span class="badge ${show.joinVerify.ok ? "include" : "error"} join-verify" title="${escapeAttr(show.joinVerify.detail)}">${escapeHtml(show.joinVerify.badge)}</span>`
          : "",
      ]
        .filter(Boolean)
        .join("");
      return `
        <tr class="${rowClass}" data-id="${escapeAttr(show.id)}" draggable="false">
          <td class="col-tight">
            <input type="checkbox" data-action="include" ${show.include ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="Include ${escapeAttr(show.name)}" />
          </td>
          <td class="col-tight">
            <button type="button" class="drag-handle" data-action="drag" title="Drag to reorder" aria-label="Reorder ${escapeAttr(show.name)}">⋮⋮</button>
            <span class="num">${index + 1}</span>
          </td>
          <td class="name-cell">
            <div class="name-main">
              ${playButton}
              <span class="name-text" title="${escapeAttr(show.path)}">${escapeHtml(show.name)}</span>
            </div>
            ${metaBits ? `<div class="name-meta">${metaBits}</div>` : ""}
            ${scrubber}
          </td>
          <td class="num col-tight">${header ? header.channelCount : "—"}</td>
          <td class="num col-tight">${header ? header.stepTime : "—"}</td>
          <td class="num col-tight">${header ? formatDuration(durationMs(header)) : "—"}</td>
          <td class="col-tight"><span class="badge ${audioClass}">${escapeHtml(audioLabel)}</span></td>
          <td class="compat-cell">
            <span class="badge ${compat.kind}">${escapeHtml(compat.note)}</span>
            ${
              compat.shiftNote
                ? `<span class="compat-shift" title="Visual light changes (bytes that differ from the previous frame). Odd-index changes start 10ms late on the 20ms grid.">${escapeHtml(compat.shiftNote)}</span>`
                : ""
            }
            ${
              audioNote
                ? `<span class="compat-shift compat-audio" title="This track’s length will be padded or trimmed so it matches this show’s FSEQ duration after 50→20 / 48→200.">${escapeHtml(audioNote)}</span>`
                : ""
            }
          </td>
        </tr>
      `;
    })
    .join("");

  for (const th of document.querySelectorAll("th.sortable")) {
    const key = th.dataset.sort;
    th.setAttribute("aria-sort", key === state.sortKey && !state.customOrder ? `${state.sortDir}ending` : "none");
  }

  els.joinBtn.disabled = included.length < 2;
  updateCombinedTime(included);
  updateStepConvertWarning();
  updateClosureResetWarning(included);
  bindRowEvents();
  if (preview.showId && !rows.some((show) => show.id === preview.showId)) {
    stopPreview();
  }
  syncPreviewUi();
}

function updateStepConvertWarning() {
  if (!els.stepConvertWarning) return;
  els.stepConvertWarning.hidden = !state.convert50to20;
}

function updateClosureResetWarning(included = includedShows()) {
  if (!els.closureResetWarning) return;
  if (!state.resetClosures || included.length < 2) {
    els.closureResetWarning.hidden = true;
    els.closureResetWarning.textContent = "";
    return;
  }
  const plan = closureResetPlan(included);
  if (!plan.warnings?.length) {
    els.closureResetWarning.hidden = true;
    els.closureResetWarning.textContent = "";
    return;
  }
  els.closureResetWarning.hidden = false;
  els.closureResetWarning.textContent = plan.warnings.join(" ");
}

function updateCombinedTime(included = includedShows()) {
  if (!els.combinedTimeValue) return;
  if (!included.length) {
    els.combinedTimeValue.textContent = "—";
    els.combinedTimeValue.classList.add("is-empty");
    return;
  }
  const options = joinOptions();
  const tails = options.resetClosures ? closureResetPlan(included).tails : [];
  els.combinedTimeValue.textContent = formatDurationWords(totalIncludedDurationMs(included, options, tails));
  els.combinedTimeValue.classList.remove("is-empty");
}

function hasPreviewableAudio(show) {
  return Boolean(show?.audio?.file && (show.audio.kind === "mp3" || show.audio.kind === "wav"));
}

function stopPreview() {
  preview.audio.pause();
  preview.audio.removeAttribute("src");
  try {
    preview.audio.load();
  } catch {
    // Ignore browsers that throw while resetting an empty media element.
  }
  if (preview.objectUrl) {
    URL.revokeObjectURL(preview.objectUrl);
    preview.objectUrl = null;
  }
  preview.showId = null;
  preview.seeking = false;
  syncPreviewUi();
}

function isPreviewPlaying() {
  return Boolean(preview.showId && !preview.audio.paused && !preview.audio.ended);
}

function updateScrubber() {
  if (!preview.showId || preview.seeking) return;
  const row = els.rows.querySelector(`tr[data-id="${CSS.escape(preview.showId)}"]`);
  const scrubber = row?.querySelector(".preview-scrubber");
  if (!scrubber) return;
  const duration = preview.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    scrubber.value = "0";
    return;
  }
  scrubber.value = String(Math.round((preview.audio.currentTime / duration) * 1000));
}

function syncPreviewUi() {
  const playing = isPreviewPlaying();
  for (const row of els.rows.querySelectorAll("tr")) {
    const active = row.dataset.id === preview.showId;
    row.classList.toggle("is-previewing", active);
    const scrubber = row.querySelector(".preview-scrubber");
    if (scrubber) scrubber.hidden = !active;
    const button = row.querySelector('[data-action="preview"]');
    if (!button) continue;
    const thisPlaying = active && playing;
    const label = row.querySelector(".name-text")?.textContent || "audio";
    button.classList.toggle("is-playing", thisPlaying);
    button.setAttribute("aria-pressed", thisPlaying ? "true" : "false");
    button.setAttribute("aria-label", thisPlaying ? `Pause ${label}` : `Play ${label}`);
    button.title = thisPlaying ? "Pause" : "Play";
    button.innerHTML = thisPlaying ? PREVIEW_ICON_PAUSE : PREVIEW_ICON_PLAY;
  }
  updateScrubber();
}

async function togglePreview(show) {
  if (!hasPreviewableAudio(show)) return;
  if (preview.showId === show.id) {
    if (preview.audio.paused) {
      try {
        await preview.audio.play();
      } catch {
        // Autoplay or decode errors stay silent in the row UI.
      }
    } else {
      preview.audio.pause();
    }
    syncPreviewUi();
    return;
  }

  const previousUrl = preview.objectUrl;
  preview.showId = show.id;
  preview.objectUrl = URL.createObjectURL(show.audio.file);
  preview.audio.src = preview.objectUrl;
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  syncPreviewUi();
  try {
    await preview.audio.play();
  } catch {
    // Leave the scrubber visible so the user can retry play.
  }
  syncPreviewUi();
}

preview.audio.addEventListener("timeupdate", updateScrubber);
preview.audio.addEventListener("durationchange", updateScrubber);
preview.audio.addEventListener("play", syncPreviewUi);
preview.audio.addEventListener("pause", syncPreviewUi);
preview.audio.addEventListener("ended", () => {
  preview.audio.currentTime = 0;
  syncPreviewUi();
});

function bindRowEvents() {
  for (const row of els.rows.querySelectorAll("tr")) {
    const id = row.dataset.id;
    const checkbox = row.querySelector('[data-action="include"]');
    checkbox?.addEventListener("change", () => {
      const show = state.shows.find((item) => item.id === id);
      if (!show) return;
      show.include = checkbox.checked;
      clearJoinVerify();
      applyEligibility();
      render();
    });

    const previewButton = row.querySelector('[data-action="preview"]');
    previewButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const show = displayShows().find((item) => item.id === id);
      if (show) togglePreview(show);
    });

    const scrubber = row.querySelector(".preview-scrubber");
    if (scrubber) {
      const seekFromScrubber = () => {
        if (preview.showId !== id) return;
        const duration = preview.audio.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        preview.audio.currentTime = (Number(scrubber.value) / 1000) * duration;
      };
      scrubber.addEventListener("pointerdown", () => {
        preview.seeking = true;
      });
      scrubber.addEventListener("input", seekFromScrubber);
      const endSeek = () => {
        preview.seeking = false;
        seekFromScrubber();
        updateScrubber();
      };
      scrubber.addEventListener("pointerup", endSeek);
      scrubber.addEventListener("pointercancel", endSeek);
      scrubber.addEventListener("change", endSeek);
    }

    const handle = row.querySelector('[data-action="drag"]');
    handle?.addEventListener("pointerdown", () => {
      row.draggable = true;
    });
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", id);
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => {
      row.draggable = false;
      row.classList.remove("is-dragging");
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData("text/plain");
      const fromIndex = state.shows.findIndex((item) => item.id === fromId);
      const toIndex = state.shows.findIndex((item) => item.id === id);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      const [moved] = state.shows.splice(fromIndex, 1);
      state.shows.splice(toIndex, 0, moved);
      state.customOrder = true;
      clearJoinVerify();
      render();
    });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function setJoinStatus(message, kind = "info", { scroll = false } = {}) {
  if (!message) {
    els.joinStatus.innerHTML = "";
    return;
  }
  els.joinStatus.innerHTML = `<div class="status ${kind}">${message}</div>`;
  if (scroll) {
    els.joinStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function downloadBlob(data, filename, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fseqSummary(selected, joined, validation, verify, audioNote = "") {
  const validText = validation.ok
    ? `Tesla validator checks passed (${joined.totalFrames} frames, ${joined.durationS.toFixed(1)}s).`
    : `Joined file failed validator: ${validation.errors.join("; ")}`;
  const upgradeNote = state.upgrade48to200 ? " 48→200 upgrade applied." : "";
  const convertNote = state.convert50to20 ? " 50→20 step conversion applied." : "";
  const resetNote = state.resetClosures && joined.resetPlan ? ` ${formatClosureResetSummary(joined.resetPlan)}` : "";
  const names = selected.map((show) => show.name);
  const verifyText = verify ? ` ${formatJoinVerifySummary(verify, names)}` : "";
  const alignNote = audioNote ? ` ${audioNote}` : "";
  return `${selected.length} shows, ${joined.channelCount}ch, ${joined.stepTime}ms, ${joined.totalFrames} frames, ${joined.durationS.toFixed(1)}s. ${validText}${upgradeNote}${convertNote}${resetNote}${alignNote}${verifyText}`;
}

async function joinAndDownload() {
  const selected = includedShows();
  if (selected.length < 2) {
    setJoinStatus("Check at least two compatible shows to join.", "warn");
    return;
  }

  const options = joinOptions();
  const steps = new Set(selected.map((show) => effectiveStepTime(show.header.stepTime, options)));
  const channels = new Set(selected.map((show) => show.header.channelCount));
  const mixedChannels = channels.size > 1;
  if (steps.size > 1 || (mixedChannels && !state.upgrade48to200)) {
    setJoinStatus(
      "Included shows must share the same step time (or enable 50→20 conversion), and the same channel count unless 48→200 upgrade is on.",
      "err"
    );
    return;
  }
  if (mixedChannels && state.upgrade48to200) {
    const allowed = [...channels].every((count) => count === 48 || count === 200);
    if (!allowed) {
      setJoinStatus("48→200 upgrade only applies to 48-channel and 200-channel shows.", "err");
      return;
    }
  }

  const name = (els.outputName.value || "joined").replace(/\.(fseq|zip|mp3)$/i, "").trim() || "joined";
  els.joinBtn.disabled = true;
  els.joinBtn.textContent = "Joining…";
  clearJoinVerify();
  setJoinStatus("Reading sequences and concatenating frames…", "info", { scroll: true });

  try {
    const buffers = [];
    for (const show of selected) {
      buffers.push(await show.file.arrayBuffer());
    }
    const joinOpts = { ...joinOptions(), showNames: selected.map((show) => show.name) };
    const joined = joinFseqBuffers(buffers, joinOpts);
    const validation = validateFseq(joined.buffer);
    const verify = validateJoinedSegments(joined.buffer, buffers, joinOpts);
    for (let i = 0; i < selected.length; i += 1) {
      selected[i].joinVerify = verify.segments[i] || null;
    }
    render();
    els.joinBtn.disabled = true;
    els.joinBtn.textContent = "Joining…";

    const alignDeltas = selected.map((show, index) => {
      const fseqMs = joinDurationMs(show.header, joinOpts);
      const tailMs = joined.resetPlan?.tails[index]?.durationMs || 0;
      return audioAlignDeltaMs(show.audioDurationMs, fseqMs + tailMs);
    });
    const audioNote = summarizeAudioAlign(alignDeltas);
    const summary = fseqSummary(selected, joined, validation, verify, audioNote);

    const targetDurationsSec = selected.map((show, index) => {
      const fseqMs = joinDurationMs(show.header, joinOpts);
      const tailMs = joined.resetPlan?.tails[index]?.durationMs || 0;
      return (fseqMs + tailMs) / 1000;
    });

    let audioResult = null;
    let audioError = null;
    try {
      audioResult = await joinShowAudio(
        selected,
        (message) => setJoinStatus(message, "info", { scroll: true }),
        { targetDurationsSec }
      );
    } catch (err) {
      audioError = err;
    }

    if (audioResult) {
      const zipBytes = createZipStore([
        { name: `${name}.fseq`, data: joined.bytes },
        { name: `${name}.mp3`, data: audioResult.bytes },
      ]);
      downloadBlob(zipBytes, `${name}.zip`, "application/zip");
      const wavNote = audioResult.convertedWav
        ? ` Converted ${audioResult.convertedWav} WAV file(s) to MP3.`
        : "";
      setJoinStatus(
        `Downloaded <strong>${escapeHtml(name)}.zip</strong> containing <strong>${escapeHtml(name)}.fseq</strong> and <strong>${escapeHtml(name)}.mp3</strong> — ${summary}${wavNote}`,
        validation.ok && verify.ok ? "ok" : "warn"
      );
    } else {
      downloadBlob(joined.bytes, `${name}.fseq`, "application/octet-stream");
      const reason = audioError?.message || "Audio join did not run.";
      setJoinStatus(
        `Downloaded <strong>${escapeHtml(name)}.fseq</strong> only — ${summary} Audio join failed: ${escapeHtml(reason)}`,
        "warn"
      );
    }
    els.joinStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setJoinStatus(escapeHtml(err.message || String(err)), "err", { scroll: true });
  } finally {
    els.joinBtn.textContent = "Join & download";
    els.joinBtn.disabled = includedShows().length < 2;
  }
}

function loadSamples() {
  const wav = createSilentWav({ durationSec: 4 });
  const files = [
    fileFrom("halloween-intro.fseq", createSampleFseq({ frameCount: 100, fill: 11 })),
    fileFrom("halloween-intro.wav", wav, "audio/wav"),
    fileFrom("pumpkin-dance.fseq", createSampleFseq({ frameCount: 150, fill: 22 })),
    fileFrom("pumpkin-dance.wav", wav, "audio/wav"),
    fileFrom("finale.fseq", createSampleFseq({ frameCount: 80, fill: 33 })),
    fileFrom(
      "slow-show.fseq",
      createSampleFseq({
        frameCount: 40,
        stepTime: 50,
        frameFill: (i) => {
          // Mix of odd-index (late) and even-index (on-grid) visual changes → 3/11.
          if (i >= 36) return 12;
          if (i >= 32) return 11;
          if (i >= 28) return 10;
          if (i >= 24) return 9;
          if (i >= 20) return 8;
          if (i >= 16) return 7;
          if (i >= 9) return 6;
          if (i >= 8) return 5;
          if (i >= 3) return 4;
          if (i >= 2) return 3;
          if (i >= 1) return 2;
          return 1;
        },
      })
    ),
    fileFrom("slow-show.wav", wav, "audio/wav"),
    fileFrom("still-glow.fseq", createSampleFseq({ frameCount: 24, stepTime: 50, fill: 66 })),
    fileFrom("still-glow.wav", wav, "audio/wav"),
    fileFrom("cybertruck-wide.fseq", createSampleFseq({ frameCount: 60, channelCount: 200, fill: 55 })),
    fileFrom("cybertruck-wide.wav", wav, "audio/wav"),
    fileFrom(
      "trunk-left-open.fseq",
      createSampleFseq({ frameCount: 50, fill: 0, channelValues: { 41: 64 } })
    ),
    fileFrom("trunk-left-open.wav", wav, "audio/wav"),
    fileFrom("lonely-track.wav", wav, "audio/wav"),
  ];
  ingestFiles(files, { replace: true });
  setJoinStatus(
    "Loaded in-browser sample shows (synthetic PSEQ bytes). Compatible 48ch / 20ms rows with audio are checked. Missing-pair rows are red and locked; 50ms rows stay skipped unless you turn on experimental 50→20 conversion; 200ch rows stay skipped unless 48→200 upgrade is on.",
    "info"
  );
}

function fileFrom(name, buffer, type = "application/octet-stream") {
  return new File([buffer], name, { type });
}

function clearShows() {
  stopPreview();
  state.shows = [];
  state.audioByKey.clear();
  state.customOrder = false;
  setJoinStatus("");
  render();
}

els.pickFiles.addEventListener("click", (event) => {
  event.stopPropagation();
  els.fileInput.click();
});
els.pickFolder.addEventListener("click", (event) => {
  event.stopPropagation();
  els.folderInput.click();
});
els.loadSamples.addEventListener("click", (event) => {
  event.stopPropagation();
  loadSamples();
});
els.fileInput.addEventListener("change", () => {
  ingestFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.folderInput.addEventListener("change", () => {
  ingestFiles(els.folderInput.files);
  els.folderInput.value = "";
});
els.clearShows.addEventListener("click", clearShows);
els.selectCompatible.addEventListener("click", () => {
  for (const show of state.shows) {
    show.include = defaultInclude(show, joinOptions());
  }
  clearJoinVerify();
  applyEligibility();
  render();
});
function applyJoinOptionChange() {
  for (const show of state.shows) {
    show.include = defaultInclude(show, joinOptions());
  }
  clearJoinVerify();
  applyEligibility();
  render();
}

els.upgrade48to200?.addEventListener("change", () => {
  state.upgrade48to200 = Boolean(els.upgrade48to200.checked);
  applyJoinOptionChange();
});
els.convert50to20?.addEventListener("change", () => {
  state.convert50to20 = Boolean(els.convert50to20.checked);
  applyJoinOptionChange();
});
els.resetClosures?.addEventListener("change", () => {
  state.resetClosures = Boolean(els.resetClosures.checked);
  applyJoinOptionChange();
});
els.joinBtn.addEventListener("click", joinAndDownload);

els.dropzone.addEventListener("click", (event) => {
  if (event.target.closest("button")) return;
  els.fileInput.click();
});
els.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.fileInput.click();
  }
});

["dragenter", "dragover"].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-over");
  });
});
["dragleave", "drop"].forEach((type) => {
  els.dropzone.addEventListener(type, () => els.dropzone.classList.remove("is-over"));
});
els.dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  const files = await filesFromDataTransfer(event.dataTransfer);
  ingestFiles(files);
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

for (const th of document.querySelectorAll("th.sortable")) {
  th.tabIndex = 0;
  const activate = () => {
    const key = th.dataset.sort;
    if (state.sortKey === key && !state.customOrder) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = key === "name" ? "asc" : "asc";
    }
    state.customOrder = false;
    sortShows();
    render();
  };
  th.addEventListener("click", activate);
  th.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
}
