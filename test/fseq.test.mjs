import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseFseqHeader,
  validateFseq,
  compatibilityFor,
  joinFseqBuffers,
  createSampleFseq,
  formatDuration,
  stemOf,
  expandFrameChannels,
  upgradeFseqChannels,
  isHardBlocked,
  isSelectableForJoin,
  defaultInclude,
  rowCompatibility,
  resolveJoinTarget,
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
  assert.equal(defaultInclude(show200), false);
  assert.equal(defaultInclude(show200, { upgrade48to200: true }), true);
  assert.equal(defaultInclude(fakeShow({ audio: "missing" })), false);

  const skip = rowCompatibility(show200, target);
  assert.equal(skip.include, false);
  assert.match(skip.note, /200ch vs 48ch join target/);

  const upgraded = rowCompatibility(show200, target, { upgrade48to200: true });
  assert.equal(upgraded.include, true);
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
