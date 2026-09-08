import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeClosureUsage,
  buildResetTailFrames,
  CLOSURE_CMD,
  emptyClosureUsage,
  formatClosureResetSummary,
  planClosureResets,
  RESET_CLOSURES,
  tailDurationSecForCommands,
  tailFrameCountForDuration,
} from "../js/closures.js";
import {
  createSampleFseq,
  joinFseqBuffers,
  parseFseqHeader,
  readUncompressedFrames,
  validateJoinedSegments,
} from "../js/fseq.js";

function framesWithChannel(frameCount, channel1, value, channelCount = 48) {
  const data = new Uint8Array(frameCount * channelCount);
  const idx = channel1 - 1;
  for (let f = 0; f < frameCount; f += 1) {
    data[f * channelCount + idx] = value;
  }
  return data;
}

function usageFor(channel1, value, frames = 10) {
  return analyzeClosureUsage(framesWithChannel(frames, channel1, value), 48, frames);
}

test("analyzeClosureUsage counts contiguous Open/Close/Dance runs", () => {
  const channels = 48;
  const frames = 8;
  const data = new Uint8Array(frames * channels);
  const lift = RESET_CLOSURES.liftgate.channel - 1;
  // Idle, Open run, Idle, Close run, Open single → 3 commands
  const seq = [0, 64, 64, 0, 192, 192, 255, 64];
  for (let f = 0; f < frames; f += 1) data[f * channels + lift] = seq[f];

  const usage = analyzeClosureUsage(data, channels, frames);
  assert.equal(usage.liftgate.count, 3);
  assert.equal(usage.liftgate.used, true);
  assert.equal(usage.liftgate.last, 64);
  assert.equal(usage.mirrorL.used, false);
  assert.equal(usage.chargePort.count, 0);
});

test("Idle and Stop do not count as actuations", () => {
  const usage = analyzeClosureUsage(framesWithChannel(6, 41, CLOSURE_CMD.STOP), 48, 6);
  assert.equal(usage.liftgate.count, 0);
  assert.equal(usage.liftgate.used, false);
  assert.equal(usage.liftgate.last, null);
});

test("planClosureResets only mid-resets used closures and always tries the last show", () => {
  const openTrunk = usageFor(41, CLOSURE_CMD.OPEN);
  const idle = emptyClosureUsage();
  const plan = planClosureResets([
    { usage: openTrunk, stepTime: 20, name: "a.fseq" },
    { usage: idle, stepTime: 20, name: "b.fseq" },
    { usage: idle, stepTime: 20, name: "c.fseq" },
  ]);

  assert.deepEqual(plan.tails[0].commandIds, ["liftgate"]);
  assert.equal(plan.tails[0].durationSec, 4);
  assert.equal(plan.tails[0].frameCount, 200);
  assert.deepEqual(plan.tails[1].commandIds, []);
  assert.deepEqual(plan.tails[2].commandIds, ["liftgate"]);
  assert.equal(plan.addedCounts.liftgate, 2);
});

test("liftgate budget reserves the final reset and skips mid-playlist extras", () => {
  const open = usageFor(41, CLOSURE_CMD.OPEN);
  const idle = emptyClosureUsage();
  // 5 opens already used → 1 slot left → reserve for the end, skip mid.
  const segments = [
    { usage: open, stepTime: 20, name: "1.fseq" },
    { usage: open, stepTime: 20, name: "2.fseq" },
    { usage: open, stepTime: 20, name: "3.fseq" },
    { usage: open, stepTime: 20, name: "4.fseq" },
    { usage: open, stepTime: 20, name: "5.fseq" },
    { usage: idle, stepTime: 20, name: "6.fseq" },
  ];
  const plan = planClosureResets(segments);
  assert.equal(plan.tails[0].commandIds.includes("liftgate"), false);
  assert.equal(plan.tails[4].commandIds.includes("liftgate"), false);
  assert.deepEqual(plan.tails[5].commandIds, ["liftgate"]);
  assert.ok(plan.skippedMid.length >= 1);
  assert.match(plan.warnings.join(" "), /skipped reset after/);
});

test("nine liftgate-using shows stay at the Tesla limit of 6", () => {
  const open = usageFor(41, CLOSURE_CMD.OPEN);
  const segments = Array.from({ length: 9 }, (_, i) => ({
    usage: open,
    stepTime: 20,
    name: `${i + 1}.fseq`,
  }));
  const plan = planClosureResets(segments);
  const added = plan.addedCounts.liftgate;
  const source = plan.sourceCounts.liftgate;
  assert.equal(source, 9);
  assert.equal(added, 0);
  assert.ok(plan.warnings.some((text) => /already use 9/.test(text)));
  assert.equal(plan.tails[8].frameCount, 0);
});

test("charge port limit of 3 is respected independently", () => {
  const openPort = usageFor(46, CLOSURE_CMD.OPEN);
  const segments = Array.from({ length: 3 }, (_, i) => ({
    usage: openPort,
    stepTime: 20,
    name: `port-${i}.fseq`,
  }));
  const plan = planClosureResets(segments);
  assert.equal(plan.sourceCounts.chargePort, 3);
  assert.equal(plan.addedCounts.chargePort, 0);
  assert.match(formatClosureResetSummary(plan), /no extra tails|skipped|already use/i);
});

test("buildResetTailFrames writes default pose and leaves lights idle", () => {
  const frames = buildResetTailFrames(48, 3, ["liftgate", "windowLF", "mirrorL", "chargePort"]);
  assert.equal(frames.byteLength, 48 * 3);
  for (let f = 0; f < 3; f += 1) {
    const off = f * 48;
    assert.equal(frames[off + 34], CLOSURE_CMD.OPEN);
    assert.equal(frames[off + 36], CLOSURE_CMD.OPEN);
    assert.equal(frames[off + 40], CLOSURE_CMD.CLOSE);
    assert.equal(frames[off + 45], CLOSURE_CMD.CLOSE);
    assert.equal(frames[off], 0);
    assert.equal(frames[off + 10], 0);
  }
});

test("tail duration uses the slowest commanded movement", () => {
  assert.equal(tailDurationSecForCommands(["mirrorL"]), 2);
  assert.equal(tailDurationSecForCommands(["mirrorL", "liftgate"]), 4);
  assert.equal(tailFrameCountForDuration(4, 20), 200);
  assert.equal(tailFrameCountForDuration(4, 50), 80);
});

test("join injects a liftgate close tail and segment verify still passes", () => {
  const openTrunk = createSampleFseq({
    frameCount: 10,
    fill: 7,
    channelValues: { 41: CLOSURE_CMD.OPEN },
  });
  const dance = createSampleFseq({ frameCount: 8, fill: 3 });
  const options = { resetClosures: true, showNames: ["open.fseq", "dance.fseq"] };
  const joined = joinFseqBuffers([openTrunk, dance], options);

  assert.equal(joined.resetPlan.tails[0].frameCount, 200);
  assert.equal(joined.resetPlan.tails[1].frameCount, 200);
  assert.equal(joined.totalFrames, 10 + 200 + 8 + 200);
  assert.equal(joined.durationS, (418 * 20) / 1000);

  const header = parseFseqHeader(joined.buffer);
  const data = new Uint8Array(joined.buffer, header.dataOffset);
  const firstTail = 10 * 48;
  assert.equal(data[firstTail + 40], CLOSURE_CMD.CLOSE);
  assert.equal(data[firstTail], 0);

  const verify = validateJoinedSegments(joined.buffer, [openTrunk, dance], options);
  assert.equal(verify.ok, true);
  assert.equal(verify.segments[0].tailFrames, 200);
  assert.equal(verify.leftoverFrames, 0);
  assert.equal(verify.expectedFrames, 418);
});

test("join without resetClosures does not add tails", () => {
  const openTrunk = createSampleFseq({
    frameCount: 10,
    fill: 1,
    channelValues: { 41: CLOSURE_CMD.OPEN },
  });
  const other = createSampleFseq({ frameCount: 5, fill: 2 });
  const joined = joinFseqBuffers([openTrunk, other]);
  assert.equal(joined.totalFrames, 15);
  assert.equal(joined.resetPlan.enabled, false);
  const frames = readUncompressedFrames(joined.buffer);
  assert.equal(frames.header.frameCount, 15);
});
