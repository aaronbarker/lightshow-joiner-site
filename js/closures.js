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

function sourceCounts(usages) {
  const totals = {};
  for (const id of RESET_CLOSURE_IDS) {
    totals[id] = (usages || []).reduce((sum, usage) => sum + (usage?.[id]?.count || 0), 0);
  }
  return totals;
}

function prefixCounts(usages) {
  const prefixes = [];
  const running = Object.fromEntries(RESET_CLOSURE_IDS.map((id) => [id, 0]));
  for (const usage of usages || []) {
    for (const id of RESET_CLOSURE_IDS) {
      running[id] += usage?.[id]?.count || 0;
    }
    prefixes.push({ ...running });
  }
  return prefixes;
}

function lastCommandThrough(usages, id, index) {
  let last = null;
  for (let i = 0; i <= index; i += 1) {
    const value = usages[i]?.[id]?.last;
    if (value != null) last = value;
  }
  return last;
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

export function closureBudgets(sourceCountsMap = {}, addedCountsMap = {}) {
  return RESET_CLOSURE_IDS.map((id) => {
    const spec = RESET_CLOSURES[id];
    const source = sourceCountsMap[id] || 0;
    const added = addedCountsMap[id] || 0;
    const used = source + added;
    return {
      id,
      label: spec.label,
      source,
      added,
      used,
      limit: spec.limit,
      over: used > spec.limit,
    };
  }).filter((item) => item.source > 0 || item.added > 0);
}

export function formatClosureBudgetWarning(budget) {
  if (!budget) return "";
  const line = `${budget.label}: ${budget.used}/${budget.limit} commands`;
  return budget.over ? `${line} — vehicle will ignore extras` : line;
}

export function emptyResetPlan(count = 0) {
  return {
    enabled: false,
    tails: Array.from({ length: count }, () => makeTail([], 20)),
    warnings: [],
    sourceCounts: sourceCounts([]),
    addedCounts: Object.fromEntries(RESET_CLOSURE_IDS.map((id) => [id, 0])),
    budgets: [],
    injectIndex: -1,
    injectName: "",
    skippedInject: false,
  };
}

function neededAt(usages, prefixes, index) {
  const prefix = prefixes[index] || {};
  return RESET_CLOSURE_IDS.filter((id) => {
    const spec = RESET_CLOSURES[id];
    return (prefix[id] || 0) > 0 && lastCommandThrough(usages, id, index) !== spec.reset;
  });
}

function fittingAt(needed, prefixes, index) {
  const prefix = prefixes[index] || {};
  return needed.filter((id) => (prefix[id] || 0) + 1 <= RESET_CLOSURES[id].limit);
}

/**
 * One defaults-pose reset (trunk/power Close, windows/mirrors Open), placed
 * after the latest show where those extra Open/Close commands still fit
 * inside Tesla’s per-USB-show limits. Source commands already in the FSEQ
 * always count; we never inject after every segment.
 */
export function planClosureResets(segments, { enabled = true } = {}) {
  const items = segments || [];
  if (!enabled || items.length === 0) {
    return emptyResetPlan(items.length);
  }

  const usages = items.map((item) => item.usage || emptyClosureUsage());
  const totals = sourceCounts(usages);
  const prefixes = prefixCounts(usages);
  const addedCounts = Object.fromEntries(RESET_CLOSURE_IDS.map((id) => [id, 0]));
  const tails = items.map((item) => makeTail([], Number(item.stepTime) || 20));

  let inject = null;
  let partial = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const needed = neededAt(usages, prefixes, i);
    if (!needed.length) continue;
    const fitting = fittingAt(needed, prefixes, i);
    if (fitting.length === needed.length) {
      inject = { index: i, commandIds: fitting };
      break;
    }
    if (fitting.length && !partial) {
      partial = { index: i, commandIds: fitting };
    }
  }
  if (!inject) inject = partial;

  if (inject) {
    for (const id of inject.commandIds) addedCounts[id] += 1;
    tails[inject.index] = makeTail(inject.commandIds, Number(items[inject.index].stepTime) || 20);
  }

  const budgets = closureBudgets(totals, addedCounts);
  const warnings = budgets.filter((item) => item.over).map((item) => formatClosureBudgetWarning(item));
  const skippedInject = Boolean(!inject && neededAt(usages, prefixes, items.length - 1).length);
  if (skippedInject) {
    warnings.push("No closure reset injected — no remaining command budget.");
  }

  return {
    enabled: true,
    tails,
    warnings: [...new Set(warnings)],
    sourceCounts: totals,
    addedCounts,
    budgets,
    injectIndex: inject ? inject.index : -1,
    injectName: inject ? items[inject.index].name || `Show ${inject.index + 1}` : "",
    skippedInject,
  };
}

export function formatClosureResetSummary(plan) {
  if (!plan?.enabled) return "";
  const tail = (plan.tails || []).find((item) => item.frameCount > 0);
  const extraSec = (tail?.durationMs || 0) / 1000;
  const parts = [];
  if (tail && plan.injectIndex >= 0) {
    const time = extraSec >= 10 ? extraSec.toFixed(0) : extraSec.toFixed(extraSec >= 1 ? 1 : 2);
    const where = plan.injectName ? ` after ${plan.injectName}` : "";
    parts.push(`Reset closures${where} (+${time}s lights-off / silence).`);
  } else if (plan.skippedInject) {
    parts.push("No closure reset injected — no remaining command budget.");
  } else {
    parts.push("Closure reset on; no extra tail needed.");
  }
  const over = (plan.warnings || []).filter((text) => text.includes("will ignore extras"));
  if (over.length) parts.push(over.join(" "));
  return parts.join(" ");
}
