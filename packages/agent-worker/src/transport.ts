import { StringDecoder } from "node:string_decoder";

/** Maximum size of one worker JSONL frame, including neither newline nor UTF-8 overhead. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export interface JsonLineWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: "drain", listener: () => void): this;
}

/**
 * Return false from a frame handler to stop consuming stdin after that frame.
 * The worker uses this for an orderly shutdown: frames already dispatched are
 * awaited, while commands that followed the shutdown frame are never admitted.
 */
export type JsonLineHandler = (
  frame: unknown,
) => void | boolean | Promise<void | boolean>;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export const encodeJsonLine = (
  value: unknown,
  maxFrameBytes = MAX_FRAME_BYTES,
): string => {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `无法序列化 worker frame：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new Error("worker frame 必须能被 JSON 序列化。");
  }
  if (byteLength(encoded) > maxFrameBytes) {
    throw new Error(`worker frame 超过 ${maxFrameBytes} 字节上限。`);
  }
  return `${encoded}\n`;
};

export const parseJsonLine = (
  line: string,
  maxFrameBytes = MAX_FRAME_BYTES,
): unknown => {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (byteLength(normalized) > maxFrameBytes) {
    throw new Error(`worker frame 超过 ${maxFrameBytes} 字节上限。`);
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch (error) {
    throw new Error(
      `worker frame 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const asChunkString = (chunk: Uint8Array | string, decoder: StringDecoder) =>
  typeof chunk === "string" ? chunk : decoder.write(chunk);

const parseBuffer = async (
  buffer: string,
  onFrame: JsonLineHandler,
  maxFrameBytes: number,
): Promise<{ remaining: string; stopped: boolean }> => {
  let remaining = buffer;
  while (true) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) {
      if (byteLength(remaining) > maxFrameBytes) {
        throw new Error(`worker frame 超过 ${maxFrameBytes} 字节上限。`);
      }
      return { remaining, stopped: false };
    }
    const line = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    if (line.trim().length === 0) {
      continue;
    }
    const shouldContinue = await onFrame(parseJsonLine(line, maxFrameBytes));
    if (shouldContinue === false) {
      // The caller has deliberately closed the input boundary. Discard the
      // rest of this chunk so commands queued behind shutdown cannot race the
      // worker's teardown.
      return { remaining: "", stopped: true };
    }
  }
};

/** Read newline-delimited JSON while preserving UTF-8 characters split across chunks. */
export const readJsonLines = async (
  input: AsyncIterable<Uint8Array | string>,
  onFrame: JsonLineHandler,
  maxFrameBytes = MAX_FRAME_BYTES,
): Promise<void> => {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stopped = false;
  for await (const chunk of input) {
    buffer += asChunkString(chunk, decoder);
    const parsed = await parseBuffer(buffer, onFrame, maxFrameBytes);
    buffer = parsed.remaining;
    if (parsed.stopped) {
      stopped = true;
      break;
    }
  }
  if (stopped) return;
  buffer += decoder.end();
  if (buffer.trim().length > 0) {
    await onFrame(parseJsonLine(buffer, maxFrameBytes));
  }
};

/** Serialize worker replies in order and wait for writable backpressure. */
export class JsonlWriter {
  private tail = Promise.resolve();
  private readonly output: JsonLineWritable;
  private readonly maxFrameBytes: number;

  public constructor(
    output: JsonLineWritable,
    maxFrameBytes = MAX_FRAME_BYTES,
  ) {
    this.output = output;
    this.maxFrameBytes = maxFrameBytes;
  }

  public write(value: unknown): Promise<void> {
    const line = encodeJsonLine(value, this.maxFrameBytes);
    const next = this.tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let callbackFinished = false;
          let drained = true;
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled || !callbackFinished || !drained) return;
            settled = true;
            if (error) reject(error);
            else resolve();
          };
          try {
            const accepted = this.output.write(line, (error) => {
              callbackFinished = true;
              settle(error);
            });
            if (!accepted) {
              drained = false;
              this.output.once("drain", () => {
                drained = true;
                settle();
              });
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }

  public async flush(): Promise<void> {
    await this.tail;
  }
}
