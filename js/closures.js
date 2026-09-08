/**
 * Tesla closure reset tails for joined lightshows.
 *
 * Official command bytes (xLights brightness Q/A/Z/F):
 *   0 Idle, 64 Open, 128 Dance, 192 Close, 255 Stop
 * Only Open / Close / Dance count toward per-USB-show actuation limits.
 *
 * 1-based channels match teslamotors/light-show + the 48ch community table.
 * 200ch layouts keep the same first 48 channels (extras stay idle in the tail).
 */

export const CLOSURE_CMD = {
  IDLE: 0,
  OPEN: 64,
  DANCE: 128,
  CLOSE: 192,
  STOP: 255,
};

/** Closures Aaron asked to reset: trunk/power closed, windows + mirrors open. */
export const RESET_CLOSURES = {
  mirrorL: { id: "mirrorL", channel: 35, limit: 20, reset: CLOSURE_CMD.OPEN, openSec: 2, closeSec: 2, label: "Mirror L" },
  mirrorR: { id: "mirrorR", channel: 36, limit: 20, reset: CLOSURE_CMD.OPEN, openSec: 2, closeSec: 2, label: "Mirror R" },
  windowLF: { id: "windowLF", channel: 37, limit: 6, reset: CLOSURE_CMD.OPEN, openSec: 4, closeSec: 4, label: "Window LF" },
  windowLR: { id: "windowLR", channel: 38, limit: 6, reset: CLOSURE_CMD.OPEN, openSec: 4, closeSec: 4, label: "Window LR" },
  windowRF: { id: "windowRF", channel: 39, limit: 6, reset: CLOSURE_CMD.OPEN, openSec: 4, closeSec: 4, label: "Window RF" },
  windowRR: { id: "windowRR", channel: 40, limit: 6, reset: CLOSURE_CMD.OPEN, openSec: 4, closeSec: 4, label: "Window RR" },
  liftgate: { id: "liftgate", channel: 41, limit: 6, reset: CLOSURE_CMD.CLOSE, openSec: 14, closeSec: 4, label: "Liftgate" },
  chargePort: { id: "chargePort", channel: 46, limit: 3, reset: CLOSURE_CMD.CLOSE, openSec: 2, closeSec: 2, label: "Charge port" },
};

export const RESET_CLOSURE_IDS = Object.keys(RESET_CLOSURES);

export function isActuatingCommand(value) {
  return value === CLOSURE_CMD.OPEN || value === CLOSURE_CMD.DANCE || value === CLOSURE_CMD.CLOSE;
}

export function emptyClosureUsage() {
  const usage = {};
  for (const id of RESET_CLOSURE_IDS) {
    usage[id] = { count: 0, used: false, last: null };
  }
  return usage;
}

/**
 * Count Open/Close/Dance runs on each reset closure.
 * A contiguous run of the same actuating byte is one command.
 */
export function analyzeClosureUsage(frameData, channelCount, frameCount) {
  const usage = emptyClosureUsage();
  const channels = Number(channelCount);
  const frames = Number(frameCount);
  if (!frameData || !Number.isFinite(channels) || !Number.isFinite(frames) || channels < 1 || frames < 1) {
    return usage;
  }
  const expected = channels * frames;
  if (frameData.byteLength < expected) return usage;

  for (const spec of Object.values(RESET_CLOSURES)) {
    const idx = spec.channel - 1;
    if (idx >= channels) continue;
    let count = 0;
    let last = null;
    let runValue = null;
    for (let f = 0; f < frames; f += 1) {
      const value = frameData[f * channels + idx];
      if (isActuatingCommand(value)) {
        if (runValue !== value) {
          count += 1;
          runValue = value;
        }
        last = value;
      } else {
        runValue = null;
      }
    }
    usage[spec.id] = { count, used: count > 0, last };
  }
  return usage;
}

export function resetMovementSec(spec) {
  return spec.reset === CLOSURE_CMD.OPEN ? spec.openSec : spec.closeSec;
}

export function tailDurationSecForCommands(commandIds) {
  const ids = commandIds || [];
  if (!ids.length) return 0;
  let max = 0;
  for (const id of ids) {
    const spec = RESET_CLOSURES[id];
    if (!spec) continue;
    max = Math.max(max, resetMovementSec(spec));
  }
  return max;
}

export function tailFrameCountForDuration(durationSec, stepTime) {
  const step = Number(stepTime);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(step) || step < 1) {
    return 0;
  }
  return Math.ceil((durationSec * 1000) / step);
}

export function buildResetTailFrames(channelCount, frameCount, commandIds) {
  const channels = Math.max(0, Math.floor(Number(channelCount) || 0));
  const frames = Math.max(0, Math.floor(Number(frameCount) || 0));
  const out = new Uint8Array(channels * frames);
  if (!channels || !frames) return out;
  const ids = commandIds || [];
  for (let f = 0; f < frames; f += 1) {
    const off = f * channels;
    for (const id of ids) {
      const spec = RESET_CLOSURES[id];
      if (!spec) continue;
      const idx = spec.channel - 1;
      if (idx >= 0 && idx < channels) out[off + idx] = spec.reset;
    }
  }
  return out;
}

function usedAnywhere(usages, id) {
  return (usages || []).some((usage) => usage?.[id]?.used);
}

function lastCommand(usage, id) {
  return usage?.[id]?.last ?? null;
}

function sourceCounts(usages) {
  const totals = {};
  for (const id of RESET_CLOSURE_IDS) {
    totals[id] = (usages || []).reduce((sum, usage) => sum + (usage?.[id]?.count || 0), 0);
  }
  return totals;
}

function makeTail(commandIds, stepTime) {
  const durationSec = tailDurationSecForCommands(commandIds);
  const frameCount = tailFrameCountForDuration(durationSec, stepTime);
  return {
    commandIds: [...commandIds],
    durationSec,
    durationMs: frameCount * stepTime,
    frameCount,
    stepTime,
  };
}

export function emptyResetPlan(count = 0) {
  return {
    enabled: false,
    tails: Array.from({ length: count }, () => makeTail([], 20)),
    warnings: [],
    sourceCounts: sourceCounts([]),
    addedCounts: Object.fromEntries(RESET_CLOSURE_IDS.map((id) => [id, 0])),
    skippedMid: [],
  };
}

/**
 * Budget Open/Close resets across the whole joined USB show.
 *
 * Mid-segment tails: only closures that were actuated in that segment.
 * Final tail: any closure actuated anywhere in the join (covers the
 * "trunk left open" case even when mid resets were skipped).
 * Final reset is reserved first so a 9-show liftgate playlist still
 * tries to close at the end instead of spending the last slot mid-list.
 */
export function planClosureResets(segments, { enabled = true } = {}) {
  const items = segments || [];
  if (!enabled || items.length === 0) {
    return emptyResetPlan(items.length);
  }

  const usages = items.map((item) => item.usage || emptyClosureUsage());
  const totals = sourceCounts(usages);
  const remaining = {};
  const warnings = [];
  const addedCounts = Object.fromEntries(RESET_CLOSURE_IDS.map((id) => [id, 0]));

  for (const spec of Object.values(RESET_CLOSURES)) {
    const used = totals[spec.id] || 0;
    remaining[spec.id] = spec.limit - used;
    if (used > spec.limit) {
      warnings.push(
        `${spec.label}: included shows already use ${used} Open/Close/Dance command(s) (Tesla limit ${spec.limit} per USB show).`
      );
    }
  }

  const lastIndex = items.length - 1;
  const lastUsage = usages[lastIndex];
  const finalIds = [];
  for (const spec of Object.values(RESET_CLOSURES)) {
    if (!usedAnywhere(usages, spec.id)) continue;
    if (lastCommand(lastUsage, spec.id) === spec.reset) continue;
    if (remaining[spec.id] >= 1) {
      finalIds.push(spec.id);
      remaining[spec.id] -= 1;
      addedCounts[spec.id] += 1;
    } else if (usedAnywhere(usages, spec.id)) {
      warnings.push(
        `${spec.label}: skipped end-of-join reset (Tesla limit ${spec.limit} already used).`
      );
    }
  }

  const tails = [];
  const skippedMid = [];
  for (let i = 0; i < items.length; i += 1) {
    const stepTime = Number(items[i].stepTime) || 20;
    if (i === lastIndex) {
      tails.push(makeTail(finalIds, stepTime));
      continue;
    }

    const commandIds = [];
    const usage = usages[i];
    for (const spec of Object.values(RESET_CLOSURES)) {
      if (!usage[spec.id]?.used) continue;
      if (lastCommand(usage, spec.id) === spec.reset) continue;
      if (remaining[spec.id] >= 1) {
        commandIds.push(spec.id);
        remaining[spec.id] -= 1;
        addedCounts[spec.id] += 1;
      } else {
        skippedMid.push({ index: i, id: spec.id, name: items[i].name || `Show ${i + 1}` });
        warnings.push(
          `${spec.label}: skipped reset after ${items[i].name || `show ${i + 1}`} to stay under Tesla’s ${spec.limit}-command limit.`
        );
      }
    }
    tails.push(makeTail(commandIds, stepTime));
  }

  return {
    enabled: true,
    tails,
    warnings: [...new Set(warnings)],
    sourceCounts: totals,
    addedCounts,
    skippedMid,
  };
}

export function formatClosureResetSummary(plan) {
  if (!plan?.enabled) return "";
  const tailCount = (plan.tails || []).filter((tail) => tail.frameCount > 0).length;
  const extraMs = (plan.tails || []).reduce((sum, tail) => sum + (tail.durationMs || 0), 0);
  const extraSec = extraMs / 1000;
  const parts = [];
  if (tailCount) {
    const time = extraSec >= 10 ? extraSec.toFixed(0) : extraSec.toFixed(extraSec >= 1 ? 1 : 2);
    parts.push(
      `Reset closures after ${tailCount} show${tailCount === 1 ? "" : "s"} (+${time}s lights-off / silence).`
    );
  } else {
    parts.push("Closure reset on; no extra tails needed.");
  }
  if (plan.skippedMid?.length) {
    parts.push("Some mid-playlist resets were skipped to stay under Tesla actuation limits.");
  }
  const over = (plan.warnings || []).filter((text) => text.includes("already use"));
  if (over.length) parts.push(over[0]);
  return parts.join(" ");
}
