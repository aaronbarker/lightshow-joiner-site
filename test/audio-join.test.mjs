import assert from "node:assert/strict";
import { test } from "node:test";
import { audioFilesForShows, concatListText } from "../js/audio-join.js";

test("audioFilesForShows keeps table order and prefers each row's paired file", () => {
  const mp3 = { name: "intro.mp3" };
  const wav = { name: "dance.wav" };
  const inputs = audioFilesForShows([
    { name: "intro.fseq", audio: { kind: "mp3", file: mp3 } },
    { name: "dance.fseq", audio: { kind: "wav", file: wav } },
  ]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].inputName, "in0.mp3");
  assert.equal(inputs[0].ext, "mp3");
  assert.equal(inputs[1].inputName, "in1.wav");
  assert.equal(inputs[1].mp3Name, "in1.mp3");
  assert.equal(inputs[1].ext, "wav");
});

test("audioFilesForShows throws when a join row has no audio file", () => {
  assert.throws(
    () => audioFilesForShows([{ name: "lonely.fseq", audio: { kind: "missing", file: null } }]),
    /no paired audio/
  );
});

test("concatListText writes ffmpeg concat demuxer lines", () => {
  assert.equal(concatListText(["in0.mp3", "in1.mp3"]), "file 'in0.mp3'\nfile 'in1.mp3'\n");
});
