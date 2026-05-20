import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { CTIO_USER_AGENT } from "./client";
import { CtioError, ExitCode, IoError } from "./errors";
import { debug } from "./logger";

interface UploadOptions {
  baseURL: string;
  token: string;
  source: Readable;
  filename: string;
}

interface FileUploadResponse {
  error: string | null;
  file_id: string;
}

export async function streamUpload(opts: UploadOptions): Promise<string> {
  const boundary = `----ctio-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${sanitizeFilename(opts.filename)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const body = buildMultipartStream(head, opts.source, tail);

  const url = `${opts.baseURL.replace(/\/+$/, "")}/files`;
  debug(`upload POST ${url} (chunked multipart, no buffering)`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "User-Agent": CTIO_USER_AGENT,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    throw new IoError(`Network error during upload: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new CtioError(
      `Upload failed: HTTP ${response.status}${text ? ` — ${truncate(text)}` : ""}`,
      ExitCode.ApiError,
    );
  }

  let json: FileUploadResponse;
  try {
    json = (await response.json()) as FileUploadResponse;
  } catch (err) {
    throw new CtioError(
      `Upload response was not JSON: ${(err as Error).message}`,
      ExitCode.ApiError,
    );
  }

  if (json.error) {
    throw new CtioError(`Upload rejected by API: ${json.error}`, ExitCode.ApiError);
  }
  if (!json.file_id) {
    throw new CtioError("Upload response missing file_id", ExitCode.ApiError);
  }
  return json.file_id;
}

function buildMultipartStream(head: Buffer, body: Readable, tail: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(head));
      body.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buf));
      });
      body.on("end", () => {
        controller.enqueue(new Uint8Array(tail));
        controller.close();
      });
      body.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      body.destroy();
    },
  });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(s: string, limit = 200): string {
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}
