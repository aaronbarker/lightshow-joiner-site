import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseFseqHeader,
  validateFseq,
  compatibilityFor,
  joinFseqBuffers,
  createSampleFseq,
  formatDuration,
  formatDurationWords,
  totalIncludedDurationMs,
  stemOf,
  expandFrameChannels,
  upgradeFseqChannels,
  convertStepFrames,
  convertFseqStepTime,
  convertedFrameCount,
  stepConvertChangeShiftStats,
  stepConvertChangeShiftStatsFromBuffer,
  formatStepConvertChangeShiftNote,
  effectiveStepTime,
  isHardBlocked,
  isSelectableForJoin,
  defaultInclude,
  rowCompatibility,
  resolveJoinTarget,
  prepareFseqForJoin,
  readUncompressedFrames,
  validateJoinedSegments,
  formatJoinVerifySummary,
} from "../js/fseq.js";

test("parses uncompressed V2 PSEQ header fields", () => {
  const buffer = createSampleFseq({
    channelCount: 48,
    frameCount: 100,
    stepTime: 20,
    fill: 7,
  });
  const header = parseFseqHeader(buffer);
  assert.equal(header.magic, "PSEQ");
  assert.equal(header.channelCount, 48);
  assert.equal(header.frameCount, 100);
  assert.equal(header.stepTime, 20);
  assert.equal(header.compression, 0);
  assert.equal(header.major, 2);
  assert.equal(header.dataOffset, 32);
});

test("rejects missing PSEQ magic", () => {
  const buffer = createSampleFseq();
  new Uint8Array(buffer)[0] = 0x58;
  assert.throws(() => parseFseqHeader(buffer), /PSEQ/);
});

test("compatibility matches CLI include/skip rules", () => {
  const keep = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 48, stepTime: 20 })));
  assert.equal(keep.include, true);
  assert.match(keep.note, /48ch \/ 20ms/);

  const skipStep = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 48, stepTime: 50 })));
  assert.equal(skipStep.include, false);
  assert.match(skipStep.note, /50ms/);

  const skipCh = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 200, stepTime: 20 })));
  assert.equal(skipCh.include, false);
  assert.match(skipCh.note, /200 channels/);

  const skipBoth = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 200, stepTime: 50 })));
  assert.equal(skipBoth.include, false);
  assert.match(skipBoth.note, /50ms/);

  const keep200 = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 200, stepTime: 20 })), {
    upgrade48to200: true,
  });
  assert.equal(keep200.include, true);
  assert.match(keep200.note, /200ch \/ 20ms/);

  const keep48up = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 48, stepTime: 20 })), {
    upgrade48to200: true,
  });
  assert.equal(keep48up.include, true);
  assert.match(keep48up.note, /48ch \/ 20ms → 200ch/);

  const keep50buf = createSampleFseq({
    channelCount: 48,
    stepTime: 50,
    frameCount: 8,
    frameFill: (i) => [1, 2, 3, 3, 4, 4, 4, 5][i],
  });
  const keep50 = compatibilityFor(parseFseqHeader(keep50buf), {
    convert50to20: true,
    changeShift: stepConvertChangeShiftStatsFromBuffer(keep50buf),
  });
  assert.equal(keep50.include, true);
  assert.match(keep50.note, /50ms → 20ms/);
  assert.equal(keep50.shiftNote, "2/4 changes start 10ms late");

  const skip200at50 = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 200, stepTime: 50 })), {
    convert50to20: true,
  });
  assert.equal(skip200at50.include, false);
  assert.match(skip200at50.note, /200 channels/);
  assert.equal(skip200at50.shiftNote, undefined);

  const keep200at50 = compatibilityFor(parseFseqHeader(createSampleFseq({ channelCount: 200, stepTime: 50 })), {
    convert50to20: true,
    upgrade48to200: true,
  });
  assert.equal(keep200at50.include, true);
  assert.match(keep200at50.note, /200ch \/ 50ms → 20ms/);
  assert.equal(keep200at50.shiftNote, undefined);

  assert.equal(keep.shiftNote, undefined);
  assert.equal(skipStep.shiftNote, undefined);
  assert.equal(keep48up.shiftNote, undefined);
});

function framesFromFills(fills, channelCount = 4) {
  const data = new Uint8Array(fills.length * channelCount);
  for (let i = 0; i < fills.length; i += 1) {
    data.fill(fills[i] & 0xff, i * channelCount, (i + 1) * channelCount);
  }
  return data;
}

test("stepConvertChangeShiftStats counts visual changes, not source slots", () => {
  const channels = 4;
  const evenOnly = framesFromFills([1, 1, 2, 2, 3, 3, 4, 4], channels);
  assert.deepEqual(stepConvertChangeShiftStats(evenOnly, channels, 8), { shifted: 0, total: 3 });

  const oddOnly = framesFromFills([1, 2, 2, 3, 3, 4], channels);
  assert.deepEqual(stepConvertChangeShiftStats(oddOnly, channels, 6), { shifted: 3, total: 3 });

  const mix = framesFromFills([1, 2, 3, 3, 4], channels);
  assert.deepEqual(stepConvertChangeShiftStats(mix, channels, 5), { shifted: 1, total: 3 });

  const staticFrames = framesFromFills([7, 7, 7, 7], channels);
  assert.deepEqual(stepConvertChangeShiftStats(staticFrames, channels, 4), { shifted: 0, total: 0 });
  assert.equal(formatStepConvertChangeShiftNote({ shifted: 0, total: 0 }), "no light changes (static)");
  assert.equal(formatStepConvertChangeShiftNote({ shifted: 12, total: 87 }), "12/87 changes start 10ms late");
  assert.equal(formatStepConvertChangeShiftNote(null), "");

  assert.equal(stepConvertChangeShiftStats(evenOnly, channels, 0), null);
  assert.deepEqual(stepConvertChangeShiftStats(new Uint8Array(channels), channels, 1), { shifted: 0, total: 0 });
  assert.equal(stepConvertChangeShiftStats(new Uint8Array(3), channels, 2), null);
  assert.equal(stepConvertChangeShiftStats(null, channels, 4), null);

  const evenBuf = createSampleFseq({
    channelCount: channels,
    frameCount: 8,
    stepTime: 50,
    frameFill: (i) => Math.floor(i / 2) + 1,
  });
  assert.deepEqual(stepConvertChangeShiftStatsFromBuffer(evenBuf), { shifted: 0, total: 3 });

  const oddBuf = createSampleFseq({
    channelCount: channels,
    frameCount: 6,
    stepTime: 50,
    frameFill: (i) => Math.floor((i + 1) / 2) + 1,
  });
  assert.deepEqual(stepConvertChangeShiftStatsFromBuffer(oddBuf), { shifted: 3, total: 3 });

  const staticBuf = createSampleFseq({ channelCount: channels, frameCount: 8, stepTime: 50, fill: 9 });
  assert.deepEqual(stepConvertChangeShiftStatsFromBuffer(staticBuf), { shifted: 0, total: 0 });

  const oneByte = new Uint8Array(channels * 2);
  oneByte[channels + 2] = 9;
  assert.deepEqual(stepConvertChangeShiftStats(oneByte, channels, 2), { shifted: 1, total: 1 });

  const compressed = createSampleFseq({ channelCount: channels, frameCount: 4, stepTime: 50, compression: 1, frameFill: (i) => i });
  assert.equal(stepConvertChangeShiftStatsFromBuffer(compressed), null);
});

function fakeShow({ channels = 48, stepTime = 20, include = false, audio = "wav", extra = {} } = {}) {
  const buffer = createSampleFseq({ channelCount: channels, stepTime });
  const header = parseFseqHeader(buffer);
  return {
    header,
    include,
    error: null,
    validation: validateFseq(buffer),
    audio: { kind: audio, file: audio === "missing" ? null : {} },
    orphanAudio: false,
    ...extra,
  };
}

test("hard-blocks missing pairs, 50ms, compressed, and invalid shows", () => {
  assert.equal(isHardBlocked(fakeShow({ audio: "missing" })), true);
  assert.equal(isHardBlocked(fakeShow({ extra: { orphanAudio: true, header: null } })), true);
  assert.equal(isHardBlocked(fakeShow({ stepTime: 50 })), true);
  assert.equal(isHardBlocked(fakeShow()), false);

  const compressed = createSampleFseq({ compression: 1 });
  assert.equal(
    isHardBlocked({
      header: parseFseqHeader(compressed),
      error: null,
      validation: validateFseq(compressed),
      audio: { kind: "wav" },
    }),
    true
  );
});

test("join target disables channel-mismatched checkboxes unless 48→200 upgrade is on", () => {
  const show48 = fakeShow({ channels: 48, include: true });
  const show200 = fakeShow({ channels: 200 });
  const show50 = fakeShow({ stepTime: 50 });
  const target = resolveJoinTarget([show48, show200]);
  assert.deepEqual(target, { channelCount: 48, stepTime: 20 });

  assert.equal(isSelectableForJoin(show48, target), true);
  assert.equal(isSelectableForJoin(show200, target), false);
  assert.equal(isSelectableForJoin(show200, target, { upgrade48to200: true }), true);
  assert.equal(isSelectableForJoin(show50, target, { upgrade48to200: true }), false);
  assert.equal(isSelectableForJoin(show50, target, { convert50to20: true }), true);
  assert.equal(defaultInclude(show50, { convert50to20: true }), true);
  assert.equal(isHardBlocked(show50, { convert50to20: true }), false);
  assert.deepEqual(resolveJoinTarget([fakeShow({ stepTime: 50, include: true })], { convert50to20: true }), {
    channelCount: 48,
    stepTime: 20,
  });
  assert.equal(effectiveStepTime(50, { convert50to20: true }), 20);
  assert.equal(effectiveStepTime(20, { convert50to20: true }), 20);
  assert.equal(defaultInclude(show200), false);
  assert.equal(defaultInclude(show200, { upgrade48to200: true }), true);
  assert.equal(defaultInclude(fakeShow({ audio: "missing" })), false);

  const skip = rowCompatibility(show200, target);
  assert.equal(skip.include, false);
  assert.match(skip.note, /200ch vs 48ch join target/);

  const upgraded = rowCompatibility(show200, target, { upgrade48to200: true });
  assert.equal(upgraded.include, true);

  const converted = rowCompatibility(
    { ...show50, changeShift: { shifted: 12, total: 87 } },
    target,
    { convert50to20: true }
  );
  assert.equal(converted.include, true);
  assert.match(converted.note, /50ms → 20ms/);
  assert.equal(converted.shiftNote, "12/87 changes start 10ms late");
  assert.equal(
    rowCompatibility({ ...show50, changeShift: { shifted: 0, total: 0 } }, target, { convert50to20: true }).shiftNote,
    "no light changes (static)"
  );
  assert.equal(rowCompatibility(show48, target, { convert50to20: true }).shiftNote, undefined);
  assert.equal(rowCompatibility(show50, target).shiftNote, undefined);
});

test("expandFrameChannels pads each frame with zeros", () => {
  const frames = 3;
  const src = new Uint8Array(48 * frames);
  src.fill(9);
  const expanded = expandFrameChannels(src, 48, 200, frames);
  assert.equal(expanded.byteLength, 200 * frames);
  for (let i = 0; i < frames; i += 1) {
    const frame = expanded.subarray(i * 200, (i + 1) * 200);
    assert.ok(frame.subarray(0, 48).every((value) => value === 9));
    assert.ok(frame.subarray(48).every((value) => value === 0));
  }
});

test("upgradeFseqChannels rewrites header count and pads frames", () => {
  const buffer = createSampleFseq({ channelCount: 48, frameCount: 4, fill: 5 });
  const upgraded = upgradeFseqChannels(buffer, 200);
  const header = parseFseqHeader(upgraded);
  assert.equal(header.channelCount, 200);
  assert.equal(header.frameCount, 4);
  assert.equal(header.stepTime, 20);

  const data = new Uint8Array(upgraded, header.dataOffset);
  assert.equal(data.byteLength, 4 * 200);
  const first = data.subarray(0, 200);
  assert.ok(first.subarray(0, 48).every((value) => value === 5));
  assert.ok(first.subarray(48).every((value) => value === 0));

  const validated = validateFseq(upgraded);
  assert.equal(validated.ok, true);

  const already200 = createSampleFseq({ channelCount: 200, frameCount: 2 });
  assert.equal(upgradeFseqChannels(already200, 200), already200);
});

test("Tesla-style validator accepts 48ch/20ms uncompressed v2.0", () => {
  const result = validateFseq(createSampleFseq({ frameCount: 50 }));
  assert.equal(result.ok, true);
  assert.equal(result.results.frameCount, 50);
  assert.equal(result.errors.length, 0);
});

test("Tesla-style validator rejects compressed or odd channel counts", () => {
  const compressed = validateFseq(createSampleFseq({ compression: 1 }));
  assert.equal(compressed.ok, false);
  assert.match(compressed.errors.join(" "), /Uncompressed/);

  const odd = validateFseq(createSampleFseq({ channelCount: 64 }));
  assert.equal(odd.ok, false);
  assert.match(odd.errors.join(" "), /48 or 200/);
});

test("join concatenates frame blobs and rewrites frame count", () => {
  const a = createSampleFseq({ frameCount: 10, fill: 1 });
  const b = createSampleFseq({ frameCount: 15, fill: 2 });
  const joined = joinFseqBuffers([a, b]);

  assert.equal(joined.totalFrames, 25);
  assert.equal(joined.channelCount, 48);
  assert.equal(joined.stepTime, 20);
  assert.equal(joined.durationS, 0.5);

  const header = parseFseqHeader(joined.buffer);
  assert.equal(header.frameCount, 25);
  assert.equal(header.channelCount, 48);
  assert.equal(header.stepTime, 20);

  const data = new Uint8Array(joined.buffer, header.dataOffset);
  assert.equal(data.byteLength, 25 * 48);
  assert.ok(data.subarray(0, 10 * 48).every((value) => value === 1));
  assert.ok(data.subarray(10 * 48).every((value) => value === 2));

  const validated = validateFseq(joined.buffer);
  assert.equal(validated.ok, true);
});

test("join rejects channel or step mismatches", () => {
  const a = createSampleFseq({ channelCount: 48, stepTime: 20 });
  const b = createSampleFseq({ channelCount: 200, stepTime: 20 });
  const c = createSampleFseq({ channelCount: 48, stepTime: 50 });
  assert.throws(() => joinFseqBuffers([a, b]), /Channel count mismatch/);
  assert.throws(() => joinFseqBuffers([a, c]), /Step time mismatch/);
});

test("join upgrades 48ch frames to 200ch when the option is on", () => {
  const a = createSampleFseq({ channelCount: 48, frameCount: 5, fill: 3 });
  const b = createSampleFseq({ channelCount: 200, frameCount: 7, fill: 8 });
  assert.throws(() => joinFseqBuffers([a, b]), /Channel count mismatch/);

  const joined = joinFseqBuffers([a, b], { upgrade48to200: true });
  assert.equal(joined.channelCount, 200);
  assert.equal(joined.stepTime, 20);
  assert.equal(joined.totalFrames, 12);

  const header = parseFseqHeader(joined.buffer);
  assert.equal(header.channelCount, 200);
  assert.equal(header.frameCount, 12);

  const data = new Uint8Array(joined.buffer, header.dataOffset);
  const first = data.subarray(0, 200);
  assert.ok(first.subarray(0, 48).every((value) => value === 3));
  assert.ok(first.subarray(48).every((value) => value === 0));
  assert.ok(data.subarray(5 * 200).every((value) => value === 8));

  const only48 = joinFseqBuffers([a], { upgrade48to200: true });
  assert.equal(only48.channelCount, 200);
  assert.equal(validateFseq(joined.buffer).ok, true);
});

test("join rejects compressed inputs", () => {
  const a = createSampleFseq();
  const b = createSampleFseq({ compression: 2 });
  assert.throws(() => joinFseqBuffers([a, b]), /compressed/);
});

test("formatDuration and stem helpers", () => {
  assert.equal(formatDuration(90_000), "1:30");
  assert.equal(formatDuration(3_661_000), "1:01:01");
  assert.equal(stemOf("Shows/Halloween Intro.FSEQ"), "halloween intro");
});

test("formatDurationWords and included duration sum", () => {
  assert.equal(formatDurationWords(-1), "—");
  assert.equal(formatDurationWords(Number.NaN), "—");
  assert.equal(formatDurationWords(0), "0 min 0 sec");
  assert.equal(formatDurationWords(5_000), "0 min 5 sec");
  assert.equal(formatDurationWords(90_000), "1 min 30 sec");
  assert.equal(formatDurationWords(3_661_000), "1 hr 1 min 1 sec");

  const a = fakeShow({ include: true });
  a.header.frameCount = 100;
  a.header.stepTime = 20;
  const b = fakeShow({ include: true });
  b.header.frameCount = 150;
  b.header.stepTime = 20;
  assert.equal(totalIncludedDurationMs([a, b]), 5_000);
  assert.equal(formatDurationWords(totalIncludedDurationMs([a, b])), "0 min 5 sec");
  assert.equal(totalIncludedDurationMs([]), 0);
});

test("convertStepFrames maps two 50ms frames onto five 20ms frames (A,A,A,B,B)", () => {
  const channels = 4;
  const src = new Uint8Array(channels * 2);
  src.fill(1, 0, channels);
  src.fill(2, channels);
  const out = convertStepFrames(src, channels, 2, 50, 20);
  assert.equal(out.byteLength, 5 * channels);
  assert.ok(out.subarray(0, channels).every((value) => value === 1));
  assert.ok(out.subarray(channels, 2 * channels).every((value) => value === 1));
  assert.ok(out.subarray(2 * channels, 3 * channels).every((value) => value === 1));
  assert.ok(out.subarray(3 * channels, 4 * channels).every((value) => value === 2));
  assert.ok(out.subarray(4 * channels).every((value) => value === 2));
  assert.equal(convertedFrameCount(2, 50, 20), 5);
  assert.equal(convertedFrameCount(1, 50, 20), 3);
  assert.throws(() => convertStepFrames(src, channels, 2, 20, 50), /50ms → 20ms/);
});

test("convertFseqStepTime expands frames and rewrites header, preserving duration", () => {
  const buffer = createSampleFseq({ frameCount: 4, stepTime: 50, fill: 9 });
  const converted = convertFseqStepTime(buffer, 20);
  const header = parseFseqHeader(converted);
  assert.equal(header.stepTime, 20);
  assert.equal(header.frameCount, 10);
  assert.equal(header.channelCount, 48);
  assert.equal(header.frameCount * header.stepTime, 4 * 50);

  const data = new Uint8Array(converted, header.dataOffset);
  assert.equal(data.byteLength, 10 * 48);
  assert.ok(data.every((value) => value === 9));
  assert.equal(validateFseq(converted).ok, true);

  const already20 = createSampleFseq({ frameCount: 3, stepTime: 20 });
  assert.equal(convertFseqStepTime(already20, 20), already20);
  assert.throws(() => convertFseqStepTime(already20, 50), /50ms shows to 20ms/);
});

test("join converts 50ms shows to 20ms when the option is on", () => {
  const native20 = createSampleFseq({ frameCount: 10, stepTime: 20, fill: 1 });
  const slow50 = createSampleFseq({ frameCount: 2, stepTime: 50, fill: 2 });
  assert.throws(() => joinFseqBuffers([native20, slow50]), /Step time mismatch/);

  const joined = joinFseqBuffers([native20, slow50], { convert50to20: true });
  assert.equal(joined.stepTime, 20);
  assert.equal(joined.channelCount, 48);
  assert.equal(joined.totalFrames, 15);
  assert.equal(joined.durationS, 0.3);

  const header = parseFseqHeader(joined.buffer);
  assert.equal(header.stepTime, 20);
  assert.equal(header.frameCount, 15);
  const data = new Uint8Array(joined.buffer, header.dataOffset);
  assert.ok(data.subarray(0, 10 * 48).every((value) => value === 1));
  assert.ok(data.subarray(10 * 48, 13 * 48).every((value) => value === 2));
  assert.ok(data.subarray(13 * 48).every((value) => value === 2));
  assert.equal(validateFseq(joined.buffer).ok, true);
});

test("validateJoinedSegments passes when every source segment matches", () => {
  const a = createSampleFseq({ frameCount: 10, fill: 1 });
  const b = createSampleFseq({ frameCount: 15, fill: 2 });
  const joined = joinFseqBuffers([a, b]);
  const result = validateJoinedSegments(joined.buffer, [a, b]);
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 2);
  assert.equal(result.leftoverFrames, 0);
  assert.equal(result.expectedFrames, 25);
  assert.equal(result.segments[0].ok, true);
  assert.equal(result.segments[0].badge, "Join verified");
  assert.equal(result.segments[0].startFrame, 0);
  assert.equal(result.segments[0].frameCount, 10);
  assert.equal(result.segments[1].ok, true);
  assert.equal(result.segments[1].startFrame, 10);
  assert.equal(result.segments[1].frameCount, 15);
  assert.match(formatJoinVerifySummary(result, ["intro.fseq", "dance.fseq"]), /all 2 included shows match/);
});

test("validateJoinedSegments reports the first mismatched frame", () => {
  const a = createSampleFseq({ frameCount: 8, fill: 4 });
  const b = createSampleFseq({ frameCount: 6, fill: 9 });
  const joined = joinFseqBuffers([a, b]);
  const header = parseFseqHeader(joined.buffer);
  const bytes = new Uint8Array(joined.buffer);
  // Corrupt frame 2 of show B (joined frame 10) on channel 3.
  const corruptAt = header.dataOffset + (8 + 2) * header.channelCount + 3;
  bytes[corruptAt] ^= 0xff;

  const result = validateJoinedSegments(joined.buffer, [a, b]);
  assert.equal(result.ok, false);
  assert.equal(result.segments[0].ok, true);
  assert.equal(result.segments[1].ok, false);
  assert.equal(result.segments[1].reason, "mismatch");
  assert.equal(result.segments[1].firstMismatchFrame, 2);
  assert.equal(result.segments[1].firstMismatchJoinedFrame, 10);
  assert.equal(result.segments[1].badge, "Join mismatch · frame 2");
  assert.match(formatJoinVerifySummary(result, ["a.fseq", "b.fseq"]), /b\.fseq/);
});

test("validateJoinedSegments flags a truncated last segment", () => {
  const a = createSampleFseq({ frameCount: 5, fill: 1 });
  const b = createSampleFseq({ frameCount: 7, fill: 2 });
  const joined = joinFseqBuffers([a, b]);
  const header = parseFseqHeader(joined.buffer);
  const keepFrames = 5 + 3;
  const truncated = joined.buffer.slice(0, header.dataOffset + keepFrames * header.channelCount);
  const view = new DataView(truncated);
  view.setUint32(14, keepFrames, true);

  const result = validateJoinedSegments(truncated, [a, b]);
  assert.equal(result.ok, false);
  assert.equal(result.segments[0].ok, true);
  assert.equal(result.segments[1].ok, false);
  assert.equal(result.segments[1].reason, "length");
  assert.equal(result.segments[1].badge, "Join mismatch · length");
});

test("validateJoinedSegments follows 50→20 and 48→200 transforms", () => {
  const slow48 = createSampleFseq({ channelCount: 48, frameCount: 2, stepTime: 50, fill: 4 });
  const wide20 = createSampleFseq({ channelCount: 200, frameCount: 3, stepTime: 20, fill: 6 });
  const options = { convert50to20: true, upgrade48to200: true };
  const joined = joinFseqBuffers([slow48, wide20], options);

  const preparedSlow = prepareFseqForJoin(slow48, options);
  const preparedWide = prepareFseqForJoin(wide20, options);
  assert.equal(parseFseqHeader(preparedSlow).channelCount, 200);
  assert.equal(parseFseqHeader(preparedSlow).stepTime, 20);
  assert.equal(parseFseqHeader(preparedSlow).frameCount, 5);
  assert.equal(readUncompressedFrames(preparedWide).header.channelCount, 200);

  const result = validateJoinedSegments(joined.buffer, [slow48, wide20], options);
  assert.equal(result.ok, true);
  assert.equal(result.segments[0].frameCount, 5);
  assert.equal(result.segments[0].channelCount, 200);
  assert.equal(result.segments[1].startFrame, 5);
  assert.equal(result.segments[1].frameCount, 3);
  assert.ok(result.segments[0].activity.litPrimary > 0);
  assert.ok(result.segments[1].activity.litBytes > 0);
});

test("validateJoinedSegments reports a channel-count mismatch", () => {
  const a = createSampleFseq({ channelCount: 48, frameCount: 4, fill: 1 });
  const b = createSampleFseq({ channelCount: 200, frameCount: 4, fill: 2 });
  const joined = joinFseqBuffers([a, createSampleFseq({ channelCount: 48, frameCount: 4, fill: 2 })]);
  const result = validateJoinedSegments(joined.buffer, [a, b]);
  assert.equal(result.ok, false);
  assert.equal(result.segments[0].ok, true);
  assert.equal(result.segments[1].ok, false);
  assert.equal(result.segments[1].reason, "channel_count");
  assert.equal(result.segments[1].badge, "Join mismatch · channels");
});

test("validateJoinedSegments catches a nine-show last-segment swap", () => {
  const sources = Array.from({ length: 9 }, (_, i) =>
    createSampleFseq({ frameCount: 4 + i, fill: (i + 1) * 11 })
  );
  const joined = joinFseqBuffers(sources);
  const good = validateJoinedSegments(joined.buffer, sources);
  assert.equal(good.ok, true);
  assert.equal(good.segments.length, 9);
  assert.equal(good.segments[8].startFrame, sources.slice(0, 8).reduce((sum, buf) => sum + parseFseqHeader(buf).frameCount, 0));

  const swapped = [...sources.slice(0, 8), createSampleFseq({ frameCount: 12, fill: 7 })];
  const bad = validateJoinedSegments(joined.buffer, swapped);
  assert.equal(bad.ok, false);
  assert.equal(bad.segments[7].ok, true);
  assert.equal(bad.segments[8].ok, false);
  assert.equal(bad.segments[8].reason, "mismatch");
  assert.equal(bad.segments[8].firstMismatchFrame, 0);
});

test("join can combine 50→20 conversion with 48→200 upgrade", () => {
  const slow48 = createSampleFseq({ channelCount: 48, frameCount: 2, stepTime: 50, fill: 4 });
  const wide20 = createSampleFseq({ channelCount: 200, frameCount: 3, stepTime: 20, fill: 6 });
  const joined = joinFseqBuffers([slow48, wide20], { convert50to20: true, upgrade48to200: true });
  assert.equal(joined.channelCount, 200);
  assert.equal(joined.stepTime, 20);
  assert.equal(joined.totalFrames, 8);
  const data = new Uint8Array(joined.buffer, parseFseqHeader(joined.buffer).dataOffset);
  const first = data.subarray(0, 200);
  assert.ok(first.subarray(0, 48).every((value) => value === 4));
  assert.ok(first.subarray(48).every((value) => value === 0));
  assert.ok(data.subarray(5 * 200).every((value) => value === 6));
});
