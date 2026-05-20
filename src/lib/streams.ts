import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { IoError, UsageError } from "./errors";

export const STDIO_TOKEN = "-";

export function isStdio(path: string): boolean {
  return path === STDIO_TOKEN;
}

export interface InputSource {
  kind: "file" | "stdin";
  path?: string;
  size?: number;
  stream: () => Readable;
}

export interface OutputSink {
  kind: "file" | "stdout";
  path?: string;
  stream: () => Writable;
}

export async function openInput(path: string): Promise<InputSource> {
  if (isStdio(path)) {
    if (process.stdin.isTTY) {
      throw new UsageError(
        'Input is "-" (stdin) but stdin is a TTY (no piped data).',
        "Pipe data in, e.g. `cat data.json | ctio convert -t json_to_excel - out.xlsx`.",
      );
    }
    return {
      kind: "stdin",
      stream: () => process.stdin,
    };
  }

  let size: number | undefined;
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      throw new UsageError(`Input path is not a regular file: ${path}`);
    }
    size = s.size;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new IoError(`Input file not found: ${path}`);
    }
    throw new IoError(`Cannot access input file ${path}: ${(err as Error).message}`);
  }

  return {
    kind: "file",
    path,
    ...(size !== undefined ? { size } : {}),
    stream: () => createReadStream(path),
  };
}

export function openOutput(path: string): OutputSink {
  if (isStdio(path)) {
    return {
      kind: "stdout",
      stream: () => process.stdout,
    };
  }
  return {
    kind: "file",
    path,
    stream: () => createWriteStream(path),
  };
}
