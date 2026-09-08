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

import {
  analyzeClosureUsage,
  buildResetTailFrames,
  emptyResetPlan,
  planClosureResets,
} from "./closures.js";

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

/** Frame count after the same 50→20 expand used at join. 48→200 does not change frames. */
export function joinFrameCount(header, { convert50to20 = false } = {}) {
  if (!header) return 0;
  if (convert50to20 && header.stepTime === SKIP_STEP_MS) {
    return convertedFrameCount(header.frameCount, header.stepTime, DEFAULT_STEP_MS);
  }
  return header.frameCount;
}

/** Wall-clock duration after join transforms (50→20 preserves length except odd-frame rounding). */
export function joinDurationMs(header, options = {}) {
  if (!header) return 0;
  return joinFrameCount(header, options) * effectiveStepTime(header.stepTime, options);
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
 * Human duration for the pre-join total: "X min Y sec", with hours when needed.
 * Invalid values return "—". Zero is "0 min 0 sec".
 */
export function formatDurationWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hr`);
  parts.push(`${minutes} min`);
  parts.push(`${seconds} sec`);
  return parts.join(" ");
}

/** Sum FSEQ durations for the same row set the join button uses. */
export function totalIncludedDurationMs(shows, options = {}, tails = []) {
  return (shows || []).reduce((sum, show, index) => {
    if (!show?.header) return sum;
    return sum + joinDurationMs(show.header, options) + (tails[index]?.durationMs || 0);
  }, 0);
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

export function effectiveStepTime(stepTime, { convert50to20 = false } = {}) {
  if (convert50to20 && stepTime === SKIP_STEP_MS) return DEFAULT_STEP_MS;
  return stepTime;
}

function channelPayloadsDiffer(frameData, offA, offB, channelCount) {
  for (let i = 0; i < channelCount; i += 1) {
    if (frameData[offA + i] !== frameData[offB + i]) return true;
  }
  return false;
}

/**
 * Count visual light changes and how many start 10ms late after 50→20 mapping
 * (`srcIndex = floor((out_i * 20) / 50)`).
 *
 * A visual change is source index i >= 1 whose `channelCount` bytes differ from
 * frame i-1. Frame 0 is the initial state, not a change. A change at odd i
 * has ideal start i*50, which is not on a 20ms grid, so it appears 10ms late.
 *
 * Returns null when frame bytes are missing or too short to scan.
 */
export function stepConvertChangeShiftStats(frameData, channelCount, frameCount) {
  const channels = Number(channelCount);
  const frames = Number(frameCount);
  if (!Number.isFinite(channels) || !Number.isFinite(frames) || channels < 1 || frames < 1) {
    return null;
  }
  const ch = Math.floor(channels);
  const n = Math.floor(frames);
  const expected = ch * n;
  if (!frameData || frameData.byteLength < expected) {
    return null;
  }

  let total = 0;
  let shifted = 0;
  for (let i = 1; i < n; i += 1) {
    const prevOff = (i - 1) * ch;
    const currOff = i * ch;
    if (channelPayloadsDiffer(frameData, prevOff, currOff, ch)) {
      total += 1;
      if (i % 2 === 1) shifted += 1;
    }
  }
  return { shifted, total };
}

/** Same scan from an uncompressed PSEQ buffer (header + frame payload). */
export function stepConvertChangeShiftStatsFromBuffer(buffer) {
  const header = parseFseqHeader(buffer);
  if (header.compression !== 0) return null;
  const frameData = new Uint8Array(buffer, header.dataOffset);
  return stepConvertChangeShiftStats(frameData, header.channelCount, header.frameCount);
}

export function formatStepConvertChangeShiftNote(stats) {
  if (!stats) return "";
  if (stats.total === 0) return "no light changes (static)";
  return `${stats.shifted}/${stats.total} changes start 10ms late`;
}

function attachStepConvertShiftNote(result, header, convert50to20, changeShift) {
  if (!result || result.kind !== "include" || !convert50to20 || header?.stepTime !== SKIP_STEP_MS) {
    return result;
  }
  const note = formatStepConvertChangeShiftNote(changeShift);
  if (!note) return result;
  return { ...result, shiftNote: note };
}

/**
 * CLI include/skip rules from lightshow-joiner.py:
 * skip 50ms, skip 200ch, keep 48ch / 20ms as the default compatible set.
 * When upgrade48to200 is on, 48ch/20ms and 200ch/20ms are both include-eligible
 * (48ch frames are padded to 200ch at join time).
 * When convert50to20 is on, 50ms shows are include-eligible as 20ms after
 * frame expansion (never the reverse 20→50).
 */
export function compatibilityFor(header, { upgrade48to200 = false, convert50to20 = false, changeShift, frameData } = {}) {
  if (!header) {
    return { include: false, kind: "error", note: "Could not read header" };
  }
  if (header.compression !== 0) {
    return { include: false, kind: "skip", note: "Skip: compressed (Tesla needs uncompressed V2)" };
  }
  if (header.stepTime === SKIP_STEP_MS && !convert50to20) {
    return { include: false, kind: "skip", note: "Skip: 50ms step time (no conversion)" };
  }

  const stepNote =
    header.stepTime === SKIP_STEP_MS && convert50to20 ? "50ms → 20ms" : `${header.stepTime}ms`;

  let result;
  if (header.channelCount === SKIP_CHANNELS && effectiveStepTime(header.stepTime, { convert50to20 }) === DEFAULT_STEP_MS) {
    if (upgrade48to200) {
      result = { include: true, kind: "include", note: `Include: 200ch / ${stepNote}` };
    } else {
      result = { include: false, kind: "skip", note: "Skip: 200 channels" };
    }
  } else if (header.channelCount === DEFAULT_CHANNELS && effectiveStepTime(header.stepTime, { convert50to20 }) === DEFAULT_STEP_MS) {
    if (upgrade48to200) {
      result = { include: true, kind: "include", note: `Include: 48ch / ${stepNote} → 200ch` };
    } else {
      result = { include: true, kind: "include", note: `Include: 48ch / ${stepNote}` };
    }
  } else {
    result = {
      include: false,
      kind: "skip",
      note: `Skip: ${header.channelCount}ch / ${header.stepTime}ms (want 48ch / 20ms)`,
    };
  }
  const stats =
    changeShift ??
    (frameData ? stepConvertChangeShiftStats(frameData, header.channelCount, header.frameCount) : null);
  return attachStepConvertShiftNote(result, header, convert50to20, stats);
}

export function isMissingPair(show) {
  return Boolean(show?.orphanAudio) || show?.audio?.kind === "missing";
}

/**
 * Shows that can never be merged: missing fseq/audio pair, unreadable,
 * compressed/invalid, or 50ms when 50→20 conversion is off.
 */
export function isHardBlocked(show, { convert50to20 = false } = {}) {
  if (!show) return true;
  if (show.orphanAudio) return true;
  if (!show.header || show.error) return true;
  if (isMissingPair(show)) return true;
  if (show.header.compression !== 0) return true;
  if (show.validation && show.validation.ok === false) return true;
  if (show.header.stepTime === SKIP_STEP_MS && !convert50to20) return true;
  return false;
}

export function resolveJoinTarget(shows, { convert50to20 = false } = {}) {
  const included = (shows || []).filter((show) => show.include && show.header && !show.orphanAudio);
  if (!included.length) return null;
  return {
    channelCount: included[0].header.channelCount,
    stepTime: effectiveStepTime(included[0].header.stepTime, { convert50to20 }),
  };
}

export function channelsMatchForJoin(showChannels, targetChannels, upgrade48to200 = false) {
  if (showChannels === targetChannels) return true;
  if (!upgrade48to200) return false;
  const pair = new Set([showChannels, targetChannels]);
  return pair.has(DEFAULT_CHANNELS) && pair.has(SKIP_CHANNELS);
}

export function isSelectableForJoin(show, target, { upgrade48to200 = false, convert50to20 = false } = {}) {
  if (isHardBlocked(show, { convert50to20 })) return false;
  const step = effectiveStepTime(show.header.stepTime, { convert50to20 });
  if (!target) {
    return (
      step === DEFAULT_STEP_MS &&
      (show.header.channelCount === DEFAULT_CHANNELS || show.header.channelCount === SKIP_CHANNELS)
    );
  }
  if (step !== target.stepTime) return false;
  return channelsMatchForJoin(show.header.channelCount, target.channelCount, upgrade48to200);
}

export function defaultInclude(show, { upgrade48to200 = false, convert50to20 = false } = {}) {
  const options = { upgrade48to200, convert50to20 };
  if (isHardBlocked(show, options)) return false;
  return compatibilityFor(show.header, options).include;
}

export function missingPairNote(show) {
  if (show?.orphanAudio) return "Audio without matching .fseq";
  if (show?.audio?.kind === "missing") return "Missing matching .mp3/.wav";
  return "";
}

export function rowCompatibility(show, target, { upgrade48to200 = false, convert50to20 = false } = {}) {
  const options = { upgrade48to200, convert50to20 };
  if (show?.orphanAudio) {
    return { include: false, kind: "error", note: "Missing .fseq pair" };
  }
  if (show?.audio?.kind === "missing") {
    return { include: false, kind: "error", note: "Missing audio pair" };
  }
  if (show?.error || !show?.header) {
    return { include: false, kind: "error", note: show?.error || "Could not read header" };
  }

  const base = compatibilityFor(show.header, options);
  let result;
  if (isSelectableForJoin(show, target, options)) {
    if (base.kind === "include") {
      result = { ...base, include: true };
    } else {
      const stepNote =
        show.header.stepTime === SKIP_STEP_MS && convert50to20
          ? "50ms → 20ms"
          : `${show.header.stepTime}ms`;
      result = {
        include: true,
        kind: "include",
        note: `Can join: ${show.header.channelCount}ch / ${stepNote}`,
      };
    }
  } else if (show.header.compression !== 0) {
    result = base;
  } else if (show.header.stepTime === SKIP_STEP_MS && !convert50to20) {
    result = base;
  } else {
    const showStep = effectiveStepTime(show.header.stepTime, options);
    if (target && showStep !== target.stepTime) {
      result = {
        include: false,
        kind: "skip",
        note: `Skip: ${show.header.stepTime}ms vs ${target.stepTime}ms join target`,
      };
    } else if (target && !channelsMatchForJoin(show.header.channelCount, target.channelCount, upgrade48to200)) {
      result = {
        include: false,
        kind: "skip",
        note: `Skip: ${show.header.channelCount}ch vs ${target.channelCount}ch join target`,
      };
    } else {
      result = { ...base, include: false };
    }
  }
  const stats =
    options.changeShift ??
    show.changeShift ??
    (show.frameData
      ? stepConvertChangeShiftStats(show.frameData, show.header.channelCount, show.header.frameCount)
      : null);
  return attachStepConvertShiftNote(result, show.header, convert50to20, stats);
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

/**
 * How many 20ms frames a 50ms sequence becomes. Wall-clock duration is
 * preserved to the nearest output step (even frame counts are exact).
 */
export function convertedFrameCount(frameCount, fromStep = SKIP_STEP_MS, toStep = DEFAULT_STEP_MS) {
  return Math.round((frameCount * fromStep) / toStep);
}

/**
 * Repeat 50ms frames onto a 20ms grid. Every two source frames (100ms) become
 * five output frames (A,A,A,B,B). Does not convert 20→50.
 */
export function convertStepFrames(frameData, channelCount, frameCount, fromStep, toStep) {
  if (fromStep === toStep) {
    return frameData.subarray(0, channelCount * frameCount);
  }
  if (fromStep !== SKIP_STEP_MS || toStep !== DEFAULT_STEP_MS) {
    throw new Error(`Can only convert ${SKIP_STEP_MS}ms → ${DEFAULT_STEP_MS}ms (got ${fromStep}→${toStep})`);
  }
  const expected = channelCount * frameCount;
  if (frameData.byteLength < expected) {
    throw new Error("Not enough frame data to convert step time");
  }
  const outFrames = convertedFrameCount(frameCount, fromStep, toStep);
  const out = new Uint8Array(outFrames * channelCount);
  for (let i = 0; i < outFrames; i += 1) {
    const srcIndex = Math.min(frameCount - 1, Math.floor((i * toStep) / fromStep));
    const srcOff = srcIndex * channelCount;
    out.set(frameData.subarray(srcOff, srcOff + channelCount), i * channelCount);
  }
  return out;
}

/**
 * Expand a 50ms FSEQ onto 20ms frames and rewrite step_time + frame_count.
 * Already-20ms files are returned unchanged. Never converts 20→50.
 */
export function convertFseqStepTime(buffer, toStep = DEFAULT_STEP_MS) {
  const header = parseFseqHeader(buffer);
  if (header.stepTime === toStep) {
    return buffer;
  }
  if (header.stepTime !== SKIP_STEP_MS || toStep !== DEFAULT_STEP_MS) {
    throw new Error(
      `Can only convert ${SKIP_STEP_MS}ms shows to ${DEFAULT_STEP_MS}ms (got ${header.stepTime}→${toStep})`
    );
  }
  if (header.compression !== 0) {
    throw new Error("Cannot convert a compressed FSEQ");
  }

  const expected = header.channelCount * header.frameCount;
  const frameData = new Uint8Array(buffer, header.dataOffset);
  if (frameData.byteLength < expected) {
    throw new Error("Not enough frame data to convert step time");
  }

  const expanded = convertStepFrames(
    frameData.subarray(0, expected),
    header.channelCount,
    header.frameCount,
    header.stepTime,
    toStep
  );
  const out = new Uint8Array(header.dataOffset + expanded.byteLength);
  out.set(new Uint8Array(buffer, 0, header.dataOffset), 0);
  out.set(expanded, header.dataOffset);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(14, convertedFrameCount(header.frameCount, header.stepTime, toStep), true);
  view.setUint8(18, toStep);
  return out.buffer;
}

function setUint64LE(view, offset, value) {
  const big = BigInt(value);
  const mask = 0xffffffffn;
  view.setUint32(offset, Number(big & mask), true);
  view.setUint32(offset + 4, Number((big >> 32n) & mask), true);
}

/**
 * Apply the same optional 50→20 / 48→200 transforms used at join time.
 * Order matches joinFseqBuffers: convert step first, then pad channels.
 */
export function prepareFseqForJoin(buffer, { upgrade48to200 = false, convert50to20 = false } = {}) {
  let next = buffer;
  if (convert50to20) {
    const header = parseFseqHeader(next);
    if (header.stepTime === SKIP_STEP_MS) {
      next = convertFseqStepTime(next, DEFAULT_STEP_MS);
    }
  }
  if (upgrade48to200) {
    const header = parseFseqHeader(next);
    if (header.channelCount === DEFAULT_CHANNELS) {
      next = upgradeFseqChannels(next, SKIP_CHANNELS);
    }
  }
  return next;
}

/**
 * Uncompressed frame payload plus header. Trims trailing bytes past
 * channelCount * frameCount (same as joiner-fseq.py).
 */
export function readUncompressedFrames(buffer, { label = "File" } = {}) {
  const header = parseFseqHeader(buffer);
  if (header.compression !== 0) {
    throw new Error(`${label} is compressed. Tesla requires uncompressed V2.`);
  }
  const expectedSize = header.channelCount * header.frameCount;
  const frameData = new Uint8Array(buffer, header.dataOffset);
  if (frameData.byteLength < expectedSize) {
    throw new Error(`${label}: not enough frame data`);
  }
  return {
    header,
    headerBytes: new Uint8Array(buffer, 0, header.dataOffset),
    frameData: frameData.subarray(0, expectedSize),
    trailingBytes: frameData.byteLength - expectedSize,
  };
}

function firstDifferingByte(a, b) {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  if (a.byteLength !== b.byteLength) return n;
  return -1;
}

function payloadActivity(frameData, channelCount) {
  const total = frameData?.byteLength ?? 0;
  if (!total || !channelCount) {
    return { litBytes: 0, totalBytes: total, litRatio: 0, litPrimary: 0, litExtra: 0 };
  }
  const primary = Math.min(DEFAULT_CHANNELS, channelCount);
  let lit = 0;
  let litPrimary = 0;
  for (let i = 0; i < total; i += 1) {
    if (frameData[i] !== 0) {
      lit += 1;
      if (i % channelCount < primary) litPrimary += 1;
    }
  }
  return {
    litBytes: lit,
    totalBytes: total,
    litRatio: lit / total,
    litPrimary,
    litExtra: lit - litPrimary,
  };
}

function activityDetail(activity, channelCount) {
  if (!activity || !activity.totalBytes) return "No frame bytes to compare.";
  const pct = (activity.litRatio * 100).toFixed(activity.litRatio > 0 && activity.litRatio < 0.01 ? 2 : 1);
  let text = `${pct}% of bytes are non-zero`;
  if (channelCount > DEFAULT_CHANNELS && activity.litBytes > 0) {
    const extraPct = Math.round((activity.litExtra / activity.litBytes) * 100);
    if (extraPct >= 70) {
      text += `; ${extraPct}% of activity is on channels ${DEFAULT_CHANNELS + 1}–${channelCount}`;
    }
  }
  return text;
}

function annotateJoinSegment(segment) {
  if (segment.ok) {
    segment.badge = "Join verified";
    const activity = activityDetail(segment.activity, segment.channelCount);
    segment.detail = segment.sourceTrailingBytes
      ? `Matches source after join transforms. ${activity}. Source had ${segment.sourceTrailingBytes} trailing byte(s) past the declared frames (ignored, same as the CLI).`
      : `Matches source after join transforms. ${activity}.`;
    return segment;
  }

  const reasonBadges = {
    mismatch: `Join mismatch · frame ${segment.firstMismatchFrame ?? "?"}`,
    length: "Join mismatch · length",
    channel_count: "Join mismatch · channels",
    step_time: "Join mismatch · step",
  };
  segment.badge = reasonBadges[segment.reason] || "Join mismatch";
  segment.detail = segment.note;
  return segment;
}

/**
 * Compare each source (after the same join transforms) to that slice of the
 * joined FSEQ. Reports the first mismatched frame, length/channel/step errors,
 * leftover frames in the output, and a light-activity hint for dark segments.
 */
export function validateJoinedSegments(joinedBuffer, sourceBuffers, options = {}) {
  if (!joinedBuffer) {
    throw new Error("Need a joined FSEQ buffer to validate");
  }
  const sources = sourceBuffers || [];
  const joined = readUncompressedFrames(joinedBuffer, { label: "Joined file" });
  const preparedSources = sources.map((buffer, index) =>
    readUncompressedFrames(prepareFseqForJoin(buffer, options), { label: `Source ${index + 1}` })
  );
  const resetPlan = resetPlanForParsed(preparedSources, options);
  const segments = [];
  let byteOffset = 0;
  let allOk = true;

  for (let i = 0; i < preparedSources.length; i += 1) {
    const label = `Source ${i + 1}`;
    const src = preparedSources[i];
    const tailFrames = resetPlan.tails[i]?.frameCount || 0;
    const startFrame = joined.header.channelCount
      ? Math.floor(byteOffset / joined.header.channelCount)
      : 0;
    const segment = {
      index: i,
      ok: true,
      reason: "ok",
      note: "",
      startFrame,
      frameCount: src.header.frameCount,
      sourceFrames: src.header.frameCount,
      tailFrames,
      channelCount: src.header.channelCount,
      stepTime: src.header.stepTime,
      firstMismatchFrame: null,
      firstMismatchJoinedFrame: null,
      sourceTrailingBytes: src.trailingBytes,
      activity: payloadActivity(src.frameData, src.header.channelCount),
    };

    if (src.header.channelCount !== joined.header.channelCount) {
      segment.ok = false;
      segment.reason = "channel_count";
      segment.note = `${label} is ${src.header.channelCount}ch after transforms; joined file is ${joined.header.channelCount}ch`;
    } else if (src.header.stepTime !== joined.header.stepTime) {
      segment.ok = false;
      segment.reason = "step_time";
      segment.note = `${label} is ${src.header.stepTime}ms after transforms; joined file is ${joined.header.stepTime}ms`;
    } else {
      const need = src.frameData.byteLength;
      const available = Math.max(0, joined.frameData.byteLength - byteOffset);
      if (available < need) {
        const availableFrames = Math.floor(available / src.header.channelCount);
        segment.ok = false;
        segment.reason = "length";
        segment.note = `${label}: joined file has ${availableFrames} of ${src.header.frameCount} frames starting at frame ${startFrame}`;
        byteOffset += available;
      } else {
        const slice = joined.frameData.subarray(byteOffset, byteOffset + need);
        const diffAt = firstDifferingByte(slice, src.frameData);
        if (diffAt >= 0) {
          const localFrame = Math.floor(diffAt / src.header.channelCount);
          segment.ok = false;
          segment.reason = "mismatch";
          segment.firstMismatchFrame = localFrame;
          segment.firstMismatchJoinedFrame = startFrame + localFrame;
          segment.note = `${label}: first mismatch at frame ${localFrame} (joined frame ${startFrame + localFrame})`;
        }
        byteOffset += need;
      }
    }

    if (segment.ok && tailFrames > 0 && src.header.channelCount === joined.header.channelCount) {
      const tailBytes = tailFrames * src.header.channelCount;
      const available = Math.max(0, joined.frameData.byteLength - byteOffset);
      if (available < tailBytes) {
        segment.ok = false;
        segment.reason = "length";
        segment.note = `${label}: joined file is missing ${tailFrames} closure-reset frame(s) after this show`;
      } else {
        byteOffset += tailBytes;
      }
    }

    if (!segment.ok) allOk = false;
    segments.push(annotateJoinSegment(segment));
  }

  const leftoverBytes = Math.max(0, joined.frameData.byteLength - byteOffset);
  const leftoverFrames = joined.header.channelCount
    ? Math.floor(leftoverBytes / joined.header.channelCount)
    : 0;
  if (leftoverFrames > 0) allOk = false;

  const expectedFrames = segments.reduce((sum, item) => sum + item.sourceFrames + (item.tailFrames || 0), 0);
  if (joined.header.frameCount !== expectedFrames) {
    allOk = false;
  }

  return {
    ok: allOk,
    joined: {
      frameCount: joined.header.frameCount,
      channelCount: joined.header.channelCount,
      stepTime: joined.header.stepTime,
      dataBytes: joined.frameData.byteLength,
    },
    leftoverFrames,
    leftoverBytes,
    expectedFrames,
    segments,
  };
}

export function formatJoinVerifySummary(result, names = []) {
  if (!result) return "";
  const n = result.segments.length;
  const passed = result.segments.filter((item) => item.ok).length;
  const label = (index) => names[index] || `Show ${index + 1}`;
  if (n === 0) return "Segment check: no source shows to compare.";
  let text = result.ok
    ? `Segment check: all ${n} included show${n === 1 ? "" : "s"} match the joined FSEQ.`
    : `Segment check: ${passed}/${n} show${n === 1 ? "" : "s"} match.`;
  if (!result.ok) {
    const fails = result.segments
      .filter((item) => !item.ok)
      .map((item) => `${label(item.index)}: ${item.note.replace(/^Source \d+: /, "")}`);
    if (fails.length) text += ` ${fails.join(" ")}`;
  }
  if (result.leftoverFrames > 0) {
    text += ` Joined file has ${result.leftoverFrames} extra frame${result.leftoverFrames === 1 ? "" : "s"} after the sources.`;
  } else if (result.joined?.frameCount !== result.expectedFrames) {
    text += ` Joined header says ${result.joined.frameCount} frames; sources add up to ${result.expectedFrames}.`;
  }
  return text;
}

function resetPlanForParsed(parsed, { resetClosures = false, showNames = [] } = {}) {
  if (!resetClosures) return emptyResetPlan(parsed.length);
  return planClosureResets(
    parsed.map((item, index) => ({
      usage: analyzeClosureUsage(item.frameData, item.header.channelCount, item.header.frameCount),
      stepTime: item.header.stepTime,
      name: showNames[index] || `Show ${index + 1}`,
    })),
    { enabled: true }
  );
}

function appendResetTail(item, tail) {
  if (!tail?.frameCount) {
    return { ...item, tailFrames: 0, tailMs: 0 };
  }
  const tailFrames = buildResetTailFrames(item.header.channelCount, tail.frameCount, tail.commandIds);
  const frameData = new Uint8Array(item.frameData.byteLength + tailFrames.byteLength);
  frameData.set(item.frameData, 0);
  frameData.set(tailFrames, item.frameData.byteLength);
  return {
    ...item,
    frameData,
    header: { ...item.header, frameCount: item.header.frameCount + tail.frameCount },
    tailFrames: tail.frameCount,
    tailMs: tail.durationMs,
  };
}

export function joinFseqBuffers(
  buffers,
  { upgrade48to200 = false, convert50to20 = false, resetClosures = false, showNames = [] } = {}
) {
  if (!buffers || buffers.length < 1) {
    throw new Error("Need at least one FSEQ file to join");
  }

  const options = { upgrade48to200, convert50to20, resetClosures, showNames };
  const parsed = buffers.map((buffer, index) => {
    const prepared = prepareFseqForJoin(buffer, options);
    const item = readUncompressedFrames(prepared, { label: `File ${index + 1}` });
    if (item.header.major !== 2) {
      // Match joiner-fseq.py: warn but continue. Caller can surface the version.
    }
    return item;
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

  const resetPlan = resetPlanForParsed(parsed, options);
  const withTails = parsed.map((item, index) => appendResetTail(item, resetPlan.tails[index]));

  const totalFrames = withTails.reduce((sum, item) => sum + item.header.frameCount, 0);
  const totalData = withTails.reduce((sum, item) => sum + item.frameData.byteLength, 0);
  const out = new Uint8Array(withTails[0].headerBytes.byteLength + totalData);
  out.set(withTails[0].headerBytes, 0);
  let offset = withTails[0].headerBytes.byteLength;
  for (const item of withTails) {
    out.set(item.frameData, offset);
    offset += item.frameData.byteLength;
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(14, totalFrames, true);
  if (withTails[0].headerBytes.byteLength >= 32) {
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
    resetPlan,
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
  frameFill = null,
  /** 1-based channel → byte, applied after fill (e.g. `{ 41: 64 }` opens the liftgate). */
  channelValues = null,
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
  if (typeof frameFill === "function") {
    for (let i = 0; i < frameCount; i += 1) {
      const start = dataOffset + i * channelCount;
      bytes.fill(frameFill(i) & 0xff, start, start + channelCount);
    }
  } else {
    bytes.fill(fill & 0xff, dataOffset);
  }
  if (channelValues && typeof channelValues === "object") {
    for (const [channel, value] of Object.entries(channelValues)) {
      const idx = Number(channel) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= channelCount) continue;
      for (let i = 0; i < frameCount; i += 1) {
        bytes[dataOffset + i * channelCount + idx] = Number(value) & 0xff;
      }
    }
  }
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
