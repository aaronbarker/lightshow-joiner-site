/**
 * Tesla FSEQ helpers — parse, validate, and concatenate uncompressed V2 PSEQ files.
 * Layout and join behavior match aaronbarker/lightshow-joiner (joiner-fseq.py / validator.py).
 *
 * Header (little-endian):
 *   0-3   magic "PSEQ"
 *   4-5   data_offset uint16
 *   6     minor
 *   7     major
 *   8-9   header_len uint16
 *   10-13 channel_count uint32
 *   14-17 frame_count uint32
 *   18    step_time_ms uint8
 *   19    flags
 *   20    compression (0 = uncompressed)
 *   24-31 unique id uint64
 */

export const PSEQ_MAGIC = "PSEQ";
export const DEFAULT_CHANNELS = 48;
export const DEFAULT_STEP_MS = 20;
export const SKIP_STEP_MS = 50;
export const SKIP_CHANNELS = 200;

export function readAscii(buffer, offset, length) {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...bytes);
}

export function parseFseqHeader(buffer) {
  if (!buffer || buffer.byteLength < 21) {
    throw new Error("File is too small to be an FSEQ header");
  }

  const view = new DataView(buffer);
  const magic = readAscii(buffer, 0, 4);
  if (magic !== PSEQ_MAGIC) {
    throw new Error("Not a valid FSEQ file (missing PSEQ magic)");
  }

  const dataOffset = view.getUint16(4, true);
  const minor = view.getUint8(6);
  const major = view.getUint8(7);
  const headerLen = view.getUint16(8, true);
  const channelCount = view.getUint32(10, true);
  const frameCount = view.getUint32(14, true);
  const stepTime = view.getUint8(18);
  const flags = view.getUint8(19);
  const compression = view.getUint8(20);

  return {
    magic,
    dataOffset,
    minor,
    major,
    headerLen,
    channelCount,
    frameCount,
    stepTime,
    flags,
    compression,
    version: `${major}.${minor}`,
  };
}

export function durationMs(header) {
  return header.frameCount * header.stepTime;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatDurationPrecise(header) {
  const seconds = (header.frameCount * header.stepTime) / 1000;
  if (!Number.isFinite(seconds)) return "—";
  if (seconds >= 60) {
    return `${formatDuration(seconds * 1000)} (${seconds.toFixed(1)}s)`;
  }
  return `${seconds.toFixed(1)}s`;
}

/**
 * Tesla validator.py checks (client-side).
 * Returns { ok, errors, warnings, results }.
 */
export function validateFseq(buffer) {
  const errors = [];
  const warnings = [];
  let header = null;

  try {
    header = parseFseqHeader(buffer);
  } catch (err) {
    return {
      ok: false,
      errors: [err.message],
      warnings,
      results: null,
      header: null,
    };
  }

  if (header.dataOffset < 24 || header.frameCount < 1 || header.stepTime < 15) {
    errors.push("Unknown file format, expected FSEQ v2.0");
  }
  if (header.channelCount !== 48 && header.channelCount !== 200) {
    errors.push(`Expected 48 or 200 channels, got ${header.channelCount}`);
  }
  if (header.compression !== 0) {
    errors.push("Expected file format to be V2 Uncompressed");
  }

  const durationS = (header.frameCount * header.stepTime) / 1000;
  if (durationS > 4 * 60 * 60) {
    errors.push(`Expected total duration to be less than 4 hours, got ${durationS.toFixed(1)}s`);
  }
  if ((header.minor !== 0 && header.minor !== 2) || header.major !== 2) {
    warnings.push(
      `FSEQ version is ${header.major}.${header.minor}. Only 2.0 and 2.2 have been validated by Tesla.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    results: {
      frameCount: header.frameCount,
      stepTime: header.stepTime,
      durationS,
      channelCount: header.channelCount,
    },
    header,
  };
}

/**
 * CLI include/skip rules from lightshow-joiner.py:
 * skip 50ms, skip 200ch, keep 48ch / 20ms as the default compatible set.
 * When upgrade48to200 is on, 48ch/20ms and 200ch/20ms are both include-eligible
 * (48ch frames are padded to 200ch at join time). Step-time is never converted.
 */
export function compatibilityFor(header, { upgrade48to200 = false } = {}) {
  if (!header) {
    return { include: false, kind: "error", note: "Could not read header" };
  }
  if (header.compression !== 0) {
    return { include: false, kind: "skip", note: "Skip: compressed (Tesla needs uncompressed V2)" };
  }
  if (header.stepTime === SKIP_STEP_MS) {
    return { include: false, kind: "skip", note: "Skip: 50ms step time (no conversion)" };
  }
  if (header.channelCount === SKIP_CHANNELS && header.stepTime === DEFAULT_STEP_MS) {
    if (upgrade48to200) {
      return { include: true, kind: "include", note: "Include: 200ch / 20ms" };
    }
    return { include: false, kind: "skip", note: "Skip: 200 channels" };
  }
  if (header.channelCount === DEFAULT_CHANNELS && header.stepTime === DEFAULT_STEP_MS) {
    if (upgrade48to200) {
      return { include: true, kind: "include", note: "Include: 48ch / 20ms → 200ch" };
    }
    return { include: true, kind: "include", note: "Include: 48ch / 20ms" };
  }
  return {
    include: false,
    kind: "skip",
    note: `Skip: ${header.channelCount}ch / ${header.stepTime}ms (want 48ch / 20ms)`,
  };
}

export function isMissingPair(show) {
  return Boolean(show?.orphanAudio) || show?.audio?.kind === "missing";
}

/**
 * Shows that can never be merged: missing fseq/audio pair, unreadable,
 * compressed/invalid, or 50ms (step time is not converted).
 */
export function isHardBlocked(show) {
  if (!show) return true;
  if (show.orphanAudio) return true;
  if (!show.header || show.error) return true;
  if (isMissingPair(show)) return true;
  if (show.header.compression !== 0) return true;
  if (show.validation && show.validation.ok === false) return true;
  if (show.header.stepTime === SKIP_STEP_MS) return true;
  return false;
}

export function resolveJoinTarget(shows) {
  const included = (shows || []).filter((show) => show.include && show.header && !show.orphanAudio);
  if (!included.length) return null;
  return {
    channelCount: included[0].header.channelCount,
    stepTime: included[0].header.stepTime,
  };
}

export function channelsMatchForJoin(showChannels, targetChannels, upgrade48to200 = false) {
  if (showChannels === targetChannels) return true;
  if (!upgrade48to200) return false;
  const pair = new Set([showChannels, targetChannels]);
  return pair.has(DEFAULT_CHANNELS) && pair.has(SKIP_CHANNELS);
}

export function isSelectableForJoin(show, target, { upgrade48to200 = false } = {}) {
  if (isHardBlocked(show)) return false;
  if (!target) {
    return (
      show.header.stepTime === DEFAULT_STEP_MS &&
      (show.header.channelCount === DEFAULT_CHANNELS || show.header.channelCount === SKIP_CHANNELS)
    );
  }
  if (show.header.stepTime !== target.stepTime) return false;
  return channelsMatchForJoin(show.header.channelCount, target.channelCount, upgrade48to200);
}

export function defaultInclude(show, { upgrade48to200 = false } = {}) {
  if (isHardBlocked(show)) return false;
  return compatibilityFor(show.header, { upgrade48to200 }).include;
}

export function missingPairNote(show) {
  if (show?.orphanAudio) return "Audio without matching .fseq";
  if (show?.audio?.kind === "missing") return "Missing matching .mp3/.wav";
  return "";
}

export function rowCompatibility(show, target, { upgrade48to200 = false } = {}) {
  if (show?.orphanAudio) {
    return { include: false, kind: "error", note: "Missing .fseq pair" };
  }
  if (show?.audio?.kind === "missing") {
    return { include: false, kind: "error", note: "Missing audio pair" };
  }
  if (show?.error || !show?.header) {
    return { include: false, kind: "error", note: show?.error || "Could not read header" };
  }

  const base = compatibilityFor(show.header, { upgrade48to200 });
  if (isSelectableForJoin(show, target, { upgrade48to200 })) {
    if (base.kind === "include") return { ...base, include: true };
    return {
      include: true,
      kind: "include",
      note: `Can join: ${show.header.channelCount}ch / ${show.header.stepTime}ms`,
    };
  }

  if (show.header.compression !== 0) return base;
  if (show.header.stepTime === SKIP_STEP_MS) return base;
  if (target && show.header.stepTime !== target.stepTime) {
    return {
      include: false,
      kind: "skip",
      note: `Skip: ${show.header.stepTime}ms vs ${target.stepTime}ms join target`,
    };
  }
  if (target && !channelsMatchForJoin(show.header.channelCount, target.channelCount, upgrade48to200)) {
    return {
      include: false,
      kind: "skip",
      note: `Skip: ${show.header.channelCount}ch vs ${target.channelCount}ch join target`,
    };
  }
  return { ...base, include: false };
}

/**
 * Expand each frame from `fromChannels` to `toChannels` by padding unused
 * channels with zeros (the easy 48 → 200 conversion). Does not change step time.
 */
export function expandFrameChannels(frameData, fromChannels, toChannels, frameCount) {
  if (toChannels < fromChannels) {
    throw new Error(`Cannot shrink frames from ${fromChannels} to ${toChannels} channels`);
  }
  if (toChannels === fromChannels) {
    return frameData.subarray(0, fromChannels * frameCount);
  }
  const expected = fromChannels * frameCount;
  if (frameData.byteLength < expected) {
    throw new Error("Not enough frame data to expand channels");
  }
  const out = new Uint8Array(toChannels * frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const srcOff = i * fromChannels;
    const dstOff = i * toChannels;
    out.set(frameData.subarray(srcOff, srcOff + fromChannels), dstOff);
  }
  return out;
}

/**
 * Pad an uncompressed 48ch FSEQ to 200 channels and rewrite the header count.
 * Already-200 files are returned unchanged. Step time is left as-is.
 */
export function upgradeFseqChannels(buffer, toChannels = SKIP_CHANNELS) {
  const header = parseFseqHeader(buffer);
  if (header.channelCount === toChannels) {
    return buffer;
  }
  if (header.channelCount !== DEFAULT_CHANNELS) {
    throw new Error(
      `Can only upgrade ${DEFAULT_CHANNELS}-channel shows to ${toChannels} channels (got ${header.channelCount})`
    );
  }
  if (header.compression !== 0) {
    throw new Error("Cannot upgrade a compressed FSEQ");
  }

  const expected = header.channelCount * header.frameCount;
  const frameData = new Uint8Array(buffer, header.dataOffset);
  if (frameData.byteLength < expected) {
    throw new Error("Not enough frame data to upgrade channel count");
  }

  const expanded = expandFrameChannels(
    frameData.subarray(0, expected),
    header.channelCount,
    toChannels,
    header.frameCount
  );
  const out = new Uint8Array(header.dataOffset + expanded.byteLength);
  out.set(new Uint8Array(buffer, 0, header.dataOffset), 0);
  out.set(expanded, header.dataOffset);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(10, toChannels, true);
  return out.buffer;
}

function setUint64LE(view, offset, value) {
  const big = BigInt(value);
  const mask = 0xffffffffn;
  view.setUint32(offset, Number(big & mask), true);
  view.setUint32(offset + 4, Number((big >> 32n) & mask), true);
}

export function joinFseqBuffers(buffers, { upgrade48to200 = false } = {}) {
  if (!buffers || buffers.length < 1) {
    throw new Error("Need at least one FSEQ file to join");
  }

  const prepared = buffers.map((buffer) => {
    if (!upgrade48to200) return buffer;
    const header = parseFseqHeader(buffer);
    if (header.channelCount === DEFAULT_CHANNELS) {
      return upgradeFseqChannels(buffer, SKIP_CHANNELS);
    }
    return buffer;
  });

  const parsed = prepared.map((buffer, index) => {
    const header = parseFseqHeader(buffer);
    if (header.compression !== 0) {
      throw new Error(`File ${index + 1} is compressed. Tesla requires uncompressed V2.`);
    }
    if (header.major !== 2) {
      // Match joiner-fseq.py: warn but continue. Caller can surface the version.
    }
    const expectedSize = header.channelCount * header.frameCount;
    const frameData = new Uint8Array(buffer, header.dataOffset);
    if (frameData.byteLength < expectedSize) {
      throw new Error(`File ${index + 1}: not enough frame data`);
    }
    return {
      header,
      headerBytes: new Uint8Array(buffer, 0, header.dataOffset),
      frameData: frameData.subarray(0, expectedSize),
    };
  });

  const ref = parsed[0].header;
  for (let i = 1; i < parsed.length; i++) {
    const h = parsed[i].header;
    if (h.channelCount !== ref.channelCount) {
      throw new Error(
        `Channel count mismatch: file ${i + 1} has ${h.channelCount}, expected ${ref.channelCount}`
      );
    }
    if (h.stepTime !== ref.stepTime) {
      throw new Error(
        `Step time mismatch: file ${i + 1} has ${h.stepTime} ms, expected ${ref.stepTime} ms`
      );
    }
  }

  const totalFrames = parsed.reduce((sum, item) => sum + item.header.frameCount, 0);
  const totalData = parsed.reduce((sum, item) => sum + item.frameData.byteLength, 0);
  const out = new Uint8Array(parsed[0].headerBytes.byteLength + totalData);
  out.set(parsed[0].headerBytes, 0);
  let offset = parsed[0].headerBytes.byteLength;
  for (const item of parsed) {
    out.set(item.frameData, offset);
    offset += item.frameData.byteLength;
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(14, totalFrames, true);
  if (parsed[0].headerBytes.byteLength >= 32) {
    setUint64LE(view, 24, Date.now());
  }

  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    bytes: out,
    totalFrames,
    channelCount: ref.channelCount,
    stepTime: ref.stepTime,
    durationS: (totalFrames * ref.stepTime) / 1000,
    version: ref.version,
  };
}

export function createSampleFseq({
  channelCount = DEFAULT_CHANNELS,
  frameCount = 50,
  stepTime = DEFAULT_STEP_MS,
  major = 2,
  minor = 0,
  compression = 0,
  fill = 1,
  dataOffset = 32,
} = {}) {
  const expected = channelCount * frameCount;
  const bytes = new Uint8Array(dataOffset + expected);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x50; // P
  bytes[1] = 0x53; // S
  bytes[2] = 0x45; // E
  bytes[3] = 0x51; // Q
  view.setUint16(4, dataOffset, true);
  view.setUint8(6, minor);
  view.setUint8(7, major);
  view.setUint16(8, dataOffset, true);
  view.setUint32(10, channelCount, true);
  view.setUint32(14, frameCount, true);
  view.setUint8(18, stepTime);
  view.setUint8(19, 0);
  view.setUint8(20, compression);
  setUint64LE(view, 24, 1);
  bytes.fill(fill & 0xff, dataOffset);
  return bytes.buffer;
}

export function createSilentWav({ durationSec = 0.2, sampleRate = 8000 } = {}) {
  const samples = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = samples * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes.buffer;
}

export function stemOf(filename) {
  const base = filename.split("/").pop() || filename;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

export function extensionOf(filename) {
  const base = filename.split("/").pop() || filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
