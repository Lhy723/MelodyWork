import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";
import {
  JsonlWriter,
  encodeJsonLine,
  parseJsonLine,
  readJsonLines,
} from "./transport.ts";

test("readJsonLines preserves unicode split across chunks", async () => {
  const frames = [];
  const encoded = encodeJsonLine({ text: "你好，Pi" });
  const bytes = Buffer.from(encoded);
  await readJsonLines(
    Readable.from([
      bytes.subarray(0, 2),
      bytes.subarray(2, 5),
      bytes.subarray(5),
    ]),
    (frame) => frames.push(frame),
  );
  assert.deepEqual(frames, [{ text: "你好，Pi" }]);
});

test("readJsonLines rejects malformed and oversized frames", async () => {
  await assert.rejects(
    () => readJsonLines(Readable.from(["{broken}\n"]), () => undefined),
    /不是有效 JSON/,
  );
  await assert.rejects(
    () => readJsonLines(Readable.from(["12345"]), () => undefined, 4),
    /超过 4 字节上限/,
  );
  assert.throws(() => parseJsonLine("12345", 4), /超过 4 字节上限/);
});

test("readJsonLines stops after a handler returns false", async () => {
  const frames = [];
  await readJsonLines(
    Readable.from(['{"id":1}\n{"id":2}\n{"id":3}\n']),
    (frame) => {
      frames.push(frame);
      return false;
    },
  );
  assert.deepEqual(frames, [{ id: 1 }]);
});

test("JsonlWriter serializes writes in order", async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk.toString()));
  const writer = new JsonlWriter(output);
  await Promise.all([writer.write({ n: 1 }), writer.write({ n: 2 })]);
  assert.deepEqual(chunks.join(""), '{"n":1}\n{"n":2}\n');
});
