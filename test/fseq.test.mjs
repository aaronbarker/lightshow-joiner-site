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
