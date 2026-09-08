import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_JOIN_OPTIONS,
  JOIN_OPTIONS_COOKIE_NAME,
  normalizeJoinOptions,
  serializeJoinOptions,
  parseJoinOptions,
  readCookieValue,
  readJoinOptionsFromCookie,
  joinOptionsCookieString,
  writeJoinOptionsCookie,
  loadSavedJoinOptions,
} from "../js/join-options.js";

test("join option defaults match current checkboxes (upgrade/convert off, reset on)", () => {
  assert.deepEqual(DEFAULT_JOIN_OPTIONS, {
    upgrade48to200: false,
    convert50to20: false,
    resetClosures: true,
  });
  assert.deepEqual(normalizeJoinOptions(undefined), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(normalizeJoinOptions(null), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(normalizeJoinOptions({}), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(
    normalizeJoinOptions({ upgrade48to200: true, extra: "ignore" }),
    { upgrade48to200: true, convert50to20: false, resetClosures: true }
  );
  assert.deepEqual(
    normalizeJoinOptions({ upgrade48to200: "yes", convert50to20: 1, resetClosures: 0 }),
    { ...DEFAULT_JOIN_OPTIONS }
  );
});

test("join options cookie serializes and parses a round-trip", () => {
  const custom = { upgrade48to200: true, convert50to20: true, resetClosures: false };
  assert.equal(serializeJoinOptions(custom), "u1_c1_r0");
  assert.deepEqual(parseJoinOptions(serializeJoinOptions(custom)), custom);
  assert.deepEqual(parseJoinOptions(serializeJoinOptions(DEFAULT_JOIN_OPTIONS)), { ...DEFAULT_JOIN_OPTIONS });
  assert.equal(serializeJoinOptions({}), "u0_c0_r1");
});

test("join options cookie parse falls back to defaults on missing or garbage", () => {
  assert.deepEqual(parseJoinOptions(""), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(parseJoinOptions(null), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(parseJoinOptions("not-a-cookie"), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(parseJoinOptions("u2_c0_r1"), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(parseJoinOptions("u1_c0_r1_extra"), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(readJoinOptionsFromCookie(""), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(readJoinOptionsFromCookie(null), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(readJoinOptionsFromCookie("theme=dark"), { ...DEFAULT_JOIN_OPTIONS });
  assert.deepEqual(loadSavedJoinOptions(""), { ...DEFAULT_JOIN_OPTIONS });
});

test("readJoinOptionsFromCookie finds the named cookie among others", () => {
  const header = `theme=dark; ${JOIN_OPTIONS_COOKIE_NAME}=u1_c0_r0; other=1`;
  assert.equal(readCookieValue(header, JOIN_OPTIONS_COOKIE_NAME), "u1_c0_r0");
  assert.deepEqual(readJoinOptionsFromCookie(header), {
    upgrade48to200: true,
    convert50to20: false,
    resetClosures: false,
  });
});

test("writeJoinOptionsCookie sets a Path=/ cookie and fails soft without a store", () => {
  let assigned = "";
  assert.equal(
    writeJoinOptionsCookie({ upgrade48to200: true, convert50to20: false, resetClosures: true }, (value) => {
      assigned = value;
    }),
    true
  );
  assert.match(assigned, new RegExp(`^${JOIN_OPTIONS_COOKIE_NAME}=u1_c0_r1;`));
  assert.match(assigned, /Path=\//);
  assert.match(assigned, /SameSite=Lax/);
  assert.deepEqual(readJoinOptionsFromCookie(assigned.split(";")[0]), {
    upgrade48to200: true,
    convert50to20: false,
    resetClosures: true,
  });
  assert.equal(joinOptionsCookieString(DEFAULT_JOIN_OPTIONS).startsWith(`${JOIN_OPTIONS_COOKIE_NAME}=u0_c0_r1;`), true);

  assert.equal(
    writeJoinOptionsCookie(DEFAULT_JOIN_OPTIONS, () => {
      throw new Error("cookies blocked");
    }),
    false
  );
  assert.equal(writeJoinOptionsCookie(DEFAULT_JOIN_OPTIONS), false);
});
