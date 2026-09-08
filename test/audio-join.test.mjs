import assert from "node:assert/strict";
import { test } from "node:test";
import { createSilentWav } from "../js/fseq.js";
import {
  audioFilesForShows,
  concatListText,
  audioAlignDeltaMs,
  formatAudioAlignNote,
  formatAlignSeconds,
  wavDurationMs,
  audioFitArgs,
  summarizeAudioAlign,
  formatFfmpegDuration,
  AUDIO_ALIGN_NOTE_MS,
} from "../js/audio-join.js";

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

test("audioAlignDeltaMs is pad-positive and trim-negative", () => {
  assert.equal(audioAlignDeltaMs(800, 2000), 1200);
  assert.equal(audioAlignDeltaMs(2800, 2000), -800);
  assert.equal(audioAlignDeltaMs(2000, 2000), 0);
  assert.equal(audioAlignDeltaMs(null, 2000), null);
  assert.equal(audioAlignDeltaMs(Number.NaN, 1000), null);
});

test("formatAudioAlignNote uses Aaron-style pad vs trim wording", () => {
  assert.equal(formatAudioAlignNote(1200), "1.2s will be padded to audio to match fseq timing");
  assert.equal(formatAudioAlignNote(-800), "0.8s will be trimmed from audio to match fseq timing");
  assert.equal(formatAudioAlignNote(49), "");
  assert.equal(formatAudioAlignNote(-49), "");
  assert.match(formatAudioAlignNote(AUDIO_ALIGN_NOTE_MS), /padded to audio to match fseq timing/);
  assert.equal(formatAlignSeconds(50), "0.05s");
});

test("wavDurationMs reads createSilentWav length", () => {
  const wav = createSilentWav({ durationSec: 4, sampleRate: 8000 });
  assert.ok(Math.abs(wavDurationMs(wav) - 4000) < 1);
  const short = createSilentWav({ durationSec: 0.2, sampleRate: 8000 });
  assert.ok(Math.abs(wavDurationMs(short) - 200) < 1);
  assert.equal(wavDurationMs(new ArrayBuffer(8)), null);
});

test("audioFitArgs pads then cuts at the FSEQ duration", () => {
  assert.deepEqual(audioFitArgs("in0.wav", "fit0.mp3", 2.4), [
    "-y",
    "-i",
    "in0.wav",
    "-af",
    "apad",
    "-t",
    "2.400",
    "-q:a",
    "9",
    "fit0.mp3",
  ]);
  assert.equal(formatFfmpegDuration(1.6), "1.600");
});

test("summarizeAudioAlign mentions pad and trim counts", () => {
  assert.equal(summarizeAudioAlign([1200, -800, 10]), "Audio padded 1 and trimmed 1 to match FSEQ timing.");
  assert.equal(summarizeAudioAlign([10, -10]), "");
  assert.equal(summarizeAudioAlign([200]), "Audio padded 1 to match FSEQ timing.");
});
