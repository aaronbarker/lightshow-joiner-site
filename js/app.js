import {
  parseFseqHeader,
  validateFseq,
  joinFseqBuffers,
  createSampleFseq,
  createSilentWav,
  formatDurationPrecise,
  durationMs,
  stemOf,
  extensionOf,
  defaultInclude,
  isSelectableForJoin,
  resolveJoinTarget,
  rowCompatibility,
  missingPairNote,
  isMissingPair,
} from "./fseq.js";

const ACCEPTED = new Set(["fseq", "mp3", "wav"]);

const state = {
  shows: [],
  audioByKey: new Map(),
  sortKey: "name",
  sortDir: "asc",
  customOrder: false,
  upgrade48to200: false,
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
  joinStatus: document.getElementById("join-status"),
  clearShows: document.getElementById("clear-shows"),
  selectCompatible: document.getElementById("select-compatible"),
};

function joinOptions() {
  return { upgrade48to200: state.upgrade48to200 };
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
    if (wasMissing && defaultInclude(show, joinOptions())) {
      show.include = true;
    }
  }
  applyEligibility();

  state.sortKey = "name";
  state.sortDir = "asc";
  state.customOrder = false;
  sortShows();
  render();
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
  };
  show.include = defaultInclude(show, joinOptions());
  return show;
}

function sortShows() {
  if (state.customOrder) return;
  const dir = state.sortDir === "asc" ? 1 : -1;
  const key = state.sortKey;

  const valueOf = (show) => {
    if (key === "name") return show.name.toLowerCase();
    if (key === "channels") return show.header?.channelCount ?? -1;
    if (key === "stepTime") return show.header?.stepTime ?? -1;
    if (key === "frames") return show.header?.frameCount ?? -1;
    if (key === "duration") return show.header ? durationMs(show.header) : -1;
    if (key === "audio") return show.audio.kind;
    if (key === "compat") {
      return rowCompatibility(show, resolveJoinTarget(state.shows), joinOptions()).note.toLowerCase();
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
    });
  }
  return orphans;
}

function displayShows() {
  return [...state.shows, ...orphanAudioShows()];
}

function applyEligibility({ selectCompatible = false } = {}) {
  const target = resolveJoinTarget(state.shows);
  const options = joinOptions();
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
    els.rows.innerHTML = "";
    els.stats.innerHTML = "";
    return;
  }

  const target = resolveJoinTarget(state.shows);
  const options = joinOptions();
  const included = includedShows();
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
      const selectable = isSelectableForJoin(show, target, options);
      const pairNote = missingPairNote(show);
      const errorRow = Boolean(pairNote || show.error || show.orphanAudio);
      const audioLabel = show.orphanAudio
        ? `${show.audio.kind} (no .fseq)`
        : show.audio.kind === "missing"
          ? "missing pair"
          : show.audio.kind;
      const audioClass = show.audio.kind === "missing" || show.orphanAudio ? "error" : `audio-${show.audio.kind}`;
      const validLabel = show.validation.ok
        ? show.validation.warnings?.length
          ? "warn"
          : "pass"
        : "fail";
      const validTitle = show.validation.ok
        ? show.validation.warnings?.join(" ") || "Tesla validator checks passed"
        : show.validation.errors.join(" ");
      const rowClass = [
        errorRow ? "is-error" : "",
        !errorRow && compat.kind === "skip" ? "is-skip" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const statusText = pairNote || show.error || "";
      return `
        <tr class="${rowClass}" data-id="${escapeAttr(show.id)}" draggable="false">
          <td>
            <input type="checkbox" data-action="include" ${show.include ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="Include ${escapeAttr(show.name)}" />
          </td>
          <td>
            <button type="button" class="drag-handle" data-action="drag" title="Drag to reorder" aria-label="Reorder ${escapeAttr(show.name)}">⋮⋮</button>
            <span class="num">${index + 1}</span>
          </td>
          <td class="name-cell" title="${escapeAttr(show.path)}">
            ${escapeHtml(show.name)}
            ${statusText ? `<span class="row-status">${escapeHtml(statusText)}</span>` : ""}
          </td>
          <td class="num">${header ? header.channelCount : "—"}</td>
          <td class="num">${header ? header.stepTime : "—"}</td>
          <td class="num">${header ? header.frameCount : "—"}</td>
          <td class="num">${header ? formatDurationPrecise(header) : "—"}</td>
          <td><span class="badge ${audioClass}">${escapeHtml(audioLabel)}</span></td>
          <td><span class="badge ${compat.kind}">${escapeHtml(compat.note)}</span></td>
          <td><span class="badge ${show.validation.ok ? "include" : "error"}" title="${escapeAttr(validTitle)}">${validLabel}</span></td>
        </tr>
      `;
    })
    .join("");

  for (const th of document.querySelectorAll("th.sortable")) {
    const key = th.dataset.sort;
    th.setAttribute("aria-sort", key === state.sortKey && !state.customOrder ? `${state.sortDir}ending` : "none");
  }

  els.joinBtn.disabled = included.length < 2;
  bindRowEvents();
}

function bindRowEvents() {
  for (const row of els.rows.querySelectorAll("tr")) {
    const id = row.dataset.id;
    const checkbox = row.querySelector('[data-action="include"]');
    checkbox?.addEventListener("change", () => {
      const show = state.shows.find((item) => item.id === id);
      if (!show) return;
      show.include = checkbox.checked;
      applyEligibility();
      render();
    });

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

function setJoinStatus(message, kind = "info") {
  if (!message) {
    els.joinStatus.innerHTML = "";
    return;
  }
  els.joinStatus.innerHTML = `<div class="status ${kind}">${message}</div>`;
}

async function joinAndDownload() {
  const selected = includedShows();
  if (selected.length < 2) {
    setJoinStatus("Check at least two compatible shows to join.", "warn");
    return;
  }

  const steps = new Set(selected.map((show) => show.header.stepTime));
  const channels = new Set(selected.map((show) => show.header.channelCount));
  const mixedChannels = channels.size > 1;
  if (steps.size > 1 || (mixedChannels && !state.upgrade48to200)) {
    setJoinStatus(
      "Included shows must share the same step time, and the same channel count unless 48→200 upgrade is on.",
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

  const name = (els.outputName.value || "joined").replace(/\.fseq$/i, "").trim() || "joined";
  els.joinBtn.disabled = true;
  setJoinStatus("Reading sequences and concatenating frames…", "info");

  try {
    const buffers = [];
    for (const show of selected) {
      buffers.push(await show.file.arrayBuffer());
    }
    const joined = joinFseqBuffers(buffers, joinOptions());
    const validation = validateFseq(joined.buffer);
    const blob = new Blob([joined.bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.fseq`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    const missingAudio = selected.filter((show) => show.audio.kind === "missing").length;
    const validText = validation.ok
      ? `Tesla validator checks passed (${joined.totalFrames} frames, ${joined.durationS.toFixed(1)}s).`
      : `Joined file failed validator: ${validation.errors.join("; ")}`;
    const upgradeNote = state.upgrade48to200 ? " 48→200 upgrade applied." : "";
    setJoinStatus(
      `Downloaded <strong>${escapeHtml(name)}.fseq</strong> — ${selected.length} shows, ${joined.channelCount}ch, ${joined.stepTime}ms, ${joined.totalFrames} frames, ${joined.durationS.toFixed(1)}s. ${validText}${upgradeNote} Audio join coming next${missingAudio ? `; ${missingAudio} included show(s) have no matching mp3/wav` : ""}.`,
      validation.ok ? "ok" : "warn"
    );
    els.joinStatus.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setJoinStatus(escapeHtml(err.message || String(err)), "err");
  } finally {
    els.joinBtn.disabled = includedShows().length < 2;
  }
}

function loadSamples() {
  const wav = createSilentWav({ durationSec: 0.25 });
  const files = [
    fileFrom("halloween-intro.fseq", createSampleFseq({ frameCount: 100, fill: 11 })),
    fileFrom("halloween-intro.wav", wav, "audio/wav"),
    fileFrom("pumpkin-dance.fseq", createSampleFseq({ frameCount: 150, fill: 22 })),
    fileFrom("pumpkin-dance.wav", wav, "audio/wav"),
    fileFrom("finale.fseq", createSampleFseq({ frameCount: 80, fill: 33 })),
    fileFrom("slow-show.fseq", createSampleFseq({ frameCount: 40, stepTime: 50, fill: 44 })),
    fileFrom("slow-show.wav", wav, "audio/wav"),
    fileFrom("cybertruck-wide.fseq", createSampleFseq({ frameCount: 60, channelCount: 200, fill: 55 })),
    fileFrom("cybertruck-wide.wav", wav, "audio/wav"),
    fileFrom("lonely-track.wav", wav, "audio/wav"),
  ];
  ingestFiles(files, { replace: true });
  setJoinStatus(
    "Loaded in-browser sample shows (synthetic PSEQ bytes). Compatible 48ch / 20ms rows with audio are checked. Missing-pair rows are red and locked; 50ms and mismatched 200ch rows stay unchecked and disabled unless you turn on 48→200 upgrade.",
    "info"
  );
}

function fileFrom(name, buffer, type = "application/octet-stream") {
  return new File([buffer], name, { type });
}

function clearShows() {
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
  applyEligibility();
  render();
});
els.upgrade48to200?.addEventListener("change", () => {
  state.upgrade48to200 = Boolean(els.upgrade48to200.checked);
  if (state.upgrade48to200) {
    for (const show of state.shows) {
      if (defaultInclude(show, joinOptions())) show.include = true;
    }
  }
  applyEligibility();
  render();
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
