import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, createZipStore } from "../js/zip.js";

test("crc32 matches the ZIP/IEEE value for hello", () => {
  assert.equal(crc32(new TextEncoder().encode("hello")), 0x3610a686);
});

test("createZipStore writes a readable STORE archive with both names", () => {
  const fseq = new Uint8Array([1, 2, 3, 4]);
  const mp3 = new Uint8Array([5, 6, 7]);
  const zip = createZipStore([
    { name: "joined.fseq", data: fseq },
    { name: "joined.mp3", data: mp3 },
  ]);
  const asText = new TextDecoder("latin1").decode(zip);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.ok(asText.includes("joined.fseq"));
  assert.ok(asText.includes("joined.mp3"));
  assert.ok(asText.includes("PK"));
  assert.ok(zip.byteLength > fseq.byteLength + mp3.byteLength + 80);
});
