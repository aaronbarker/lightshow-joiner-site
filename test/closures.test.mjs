import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeClosureUsage,
  buildResetTailFrames,
  CLOSURE_CMD,
  closureBudgets,
  emptyClosureUsage,
  formatClosureBudgetWarning,
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

test("planClosureResets injects one defaults reset after the last show when budget allows", () => {
  const openTrunk = usageFor(41, CLOSURE_CMD.OPEN);
  const idle = emptyClosureUsage();
  const plan = planClosureResets([
    { usage: openTrunk, stepTime: 20, name: "a.fseq" },
    { usage: idle, stepTime: 20, name: "b.fseq" },
    { usage: idle, stepTime: 20, name: "c.fseq" },
  ]);

  assert.equal(plan.injectIndex, 2);
  assert.equal(plan.injectName, "c.fseq");
  assert.deepEqual(plan.tails[0].commandIds, []);
  assert.deepEqual(plan.tails[1].commandIds, []);
  assert.deepEqual(plan.tails[2].commandIds, ["liftgate"]);
  assert.equal(plan.tails[2].durationSec, 4);
  assert.equal(plan.tails[2].frameCount, 200);
  assert.equal(plan.addedCounts.liftgate, 1);
  assert.equal(plan.sourceCounts.liftgate, 1);
  assert.equal(plan.budgets.find((item) => item.id === "liftgate").used, 2);
  assert.equal(plan.warnings.length, 0);
});

test("injects after the last show that still fits when later shows exhaust the limit", () => {
  const open = usageFor(41, CLOSURE_CMD.OPEN);
  const segments = Array.from({ length: 6 }, (_, i) => ({
    usage: open,
    stepTime: 20,
    name: `${i + 1}.fseq`,
  }));
  const plan = planClosureResets(segments);
  // prefix after show 5 (index 4) is 5, so Close still fits as command 6.
  assert.equal(plan.injectIndex, 4);
  assert.deepEqual(plan.tails[4].commandIds, ["liftgate"]);
  assert.equal(plan.tails[5].frameCount, 0);
  assert.equal(plan.addedCounts.liftgate, 1);
  assert.equal(plan.sourceCounts.liftgate, 6);
  assert.match(plan.warnings.join(" "), /Liftgate: 7\/6 commands — vehicle will ignore extras/);
});

test("nine liftgate-using shows inject once at the last fitting open and warn", () => {
  const open = usageFor(41, CLOSURE_CMD.OPEN);
  const segments = Array.from({ length: 9 }, (_, i) => ({
    usage: open,
    stepTime: 20,
    name: `${i + 1}.fseq`,
  }));
  const plan = planClosureResets(segments);
  assert.equal(plan.sourceCounts.liftgate, 9);
  assert.equal(plan.addedCounts.liftgate, 1);
  assert.equal(plan.injectIndex, 4);
  assert.equal(plan.tails.filter((tail) => tail.frameCount > 0).length, 1);
  assert.match(formatClosureBudgetWarning(plan.budgets.find((item) => item.id === "liftgate")), /9\/6|10\/6/);
  assert.match(plan.warnings.join(" "), /Liftgate: 10\/6 commands — vehicle will ignore extras/);
  assert.match(formatClosureResetSummary(plan), /Reset closures after 5\.fseq/);
});

test("skips inject when even one reset cannot fit anywhere", () => {
  // Six separate Open runs, ending Open: prefix is 6, so a Close would be command 7.
  const data = new Uint8Array(12 * 48);
  const lift = 40;
  for (let f = 0; f < 12; f += 1) {
    data[f * 48 + lift] = f % 2 === 0 ? CLOSURE_CMD.OPEN : CLOSURE_CMD.IDLE;
  }
  const usage = analyzeClosureUsage(data, 48, 12);
  assert.equal(usage.liftgate.count, 6);
  assert.equal(usage.liftgate.last, CLOSURE_CMD.OPEN);
  const plan = planClosureResets([{ usage, stepTime: 20, name: "busy.fseq" }]);
  assert.equal(plan.addedCounts.liftgate, 0);
  assert.equal(plan.injectIndex, -1);
  assert.equal(plan.skippedInject, true);
  assert.equal(plan.tails[0].frameCount, 0);
  assert.match(plan.warnings.join(" "), /no remaining command budget/i);
});

test("charge port budget is tracked independently", () => {
  const openPort = usageFor(46, CLOSURE_CMD.OPEN);
  const segments = Array.from({ length: 3 }, (_, i) => ({
    usage: openPort,
    stepTime: 20,
    name: `port-${i}.fseq`,
  }));
  const plan = planClosureResets(segments);
  assert.equal(plan.sourceCounts.chargePort, 3);
  // Latest full fit: after show 2 (index 1) prefix=2, Close is command 3.
  assert.equal(plan.injectIndex, 1);
  assert.equal(plan.addedCounts.chargePort, 1);
  assert.match(plan.warnings.join(" "), /Charge port: 4\/3 commands — vehicle will ignore extras/);
});

test("does not inject when the last command is already the default pose", () => {
  const closed = usageFor(41, CLOSURE_CMD.CLOSE);
  const plan = planClosureResets([
    { usage: closed, stepTime: 20, name: "done.fseq" },
    { usage: emptyClosureUsage(), stepTime: 20, name: "idle.fseq" },
  ]);
  assert.equal(plan.injectIndex, -1);
  assert.equal(plan.addedCounts.liftgate, 0);
  assert.match(formatClosureResetSummary(plan), /no extra tail needed/);
});

test("closureBudgets only lists types that were used", () => {
  const budgets = closureBudgets({ liftgate: 2, chargePort: 0 }, { liftgate: 1 });
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].label, "Liftgate");
  assert.equal(budgets[0].used, 3);
  assert.equal(budgets[0].limit, 6);
  assert.equal(budgets[0].over, false);
  assert.equal(formatClosureBudgetWarning(budgets[0]), "Liftgate: 3/6 commands");
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

test("join injects a single liftgate close tail after the last fitting show", () => {
  const openTrunk = createSampleFseq({
    frameCount: 10,
    fill: 7,
    channelValues: { 41: CLOSURE_CMD.OPEN },
  });
  const dance = createSampleFseq({ frameCount: 8, fill: 3 });
  const options = { resetClosures: true, showNames: ["open.fseq", "dance.fseq"] };
  const joined = joinFseqBuffers([openTrunk, dance], options);

  assert.equal(joined.resetPlan.tails[0].frameCount, 0);
  assert.equal(joined.resetPlan.tails[1].frameCount, 200);
  assert.equal(joined.resetPlan.injectIndex, 1);
  assert.equal(joined.totalFrames, 10 + 8 + 200);
  assert.equal(joined.durationS, (218 * 20) / 1000);

  const header = parseFseqHeader(joined.buffer);
  const data = new Uint8Array(joined.buffer, header.dataOffset);
  const tailAt = 18 * 48;
  assert.equal(data[tailAt + 40], CLOSURE_CMD.CLOSE);
  assert.equal(data[tailAt], 0);

  const verify = validateJoinedSegments(joined.buffer, [openTrunk, dance], options);
  assert.equal(verify.ok, true);
  assert.equal(verify.segments[0].tailFrames, 0);
  assert.equal(verify.segments[1].tailFrames, 200);
  assert.equal(verify.leftoverFrames, 0);
  assert.equal(verify.expectedFrames, 218);
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
