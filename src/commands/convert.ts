import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { CAC } from "cac";

import { createClient } from "@/lib/client";
import { findConverter } from "@/lib/converters";
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info, warn } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { openInput, openOutput } from "@/lib/streams";
import { resolveAuth } from "@/lib/token";

interface ConvertFlags {
  type?: string;
  option?: string[] | string;
  url?: string;
  sandbox?: boolean;
  pollInterval?: number | string;
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  verbose?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const MIN_POLL_INTERVAL_MS = 100;

export function resolvePollInterval(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_POLL_INTERVAL_MS) {
    throw new UsageError(
      `Invalid --poll-interval "${raw}".`,
      `Must be a number ≥ ${MIN_POLL_INTERVAL_MS} (milliseconds).`,
    );
  }
  return n;
}

export function registerConvert(cli: CAC): void {
  cli
    .command("convert [input] [output]", "Run a conversion task")
    .option("-t, --type <type>", "Conversion type (e.g. json_to_excel, convert.json_to_excel)")
    .option("--option <kv>", "Conversion option as key=value (repeatable)", { type: [] })
    .option("--url <url>", "Use a remote URL as input instead of a local file")
    .option("--sandbox", "Sandbox mode (skips conversion, validates plumbing)")
    .option("--poll-interval <ms>", `Status poll interval in ms (default ${DEFAULT_POLL_INTERVAL_MS})`)
    .example("  ctio convert -t json_to_excel data.json out.xlsx")
    .example("  cat data.json | ctio convert -t json_to_excel - out.xlsx")
    .example("  ctio convert -t xml_to_csv data.xml - > out.csv")
    .example("  ctio convert -t excel_to_xml in.xlsx out.xml --option header=yes")
    .action(async (input: string | undefined, output: string | undefined, flags: ConvertFlags) => {
      const pos = resolvePositionals(unswapStdio(input), unswapStdio(output), Boolean(flags.url));
      await runConvert(pos.input, pos.output, flags);
    });
}

async function runConvert(
  inputArg: string | undefined,
  outputArg: string | undefined,
  flags: ConvertFlags,
): Promise<void> {
  if (!flags.type) throw new UsageError("Missing required --type / -t.", "Example: -t json_to_excel");
  if (!outputArg) throw new UsageError("Missing output path.", 'Use "-" for stdout, or pass a file path.');

  const format = pickFormat(flags.format);
  const conversionType = normalizeType(flags.type);
  const conversionOptions = parseOptionFlags(flags.option);
  for (const key of unknownOptionKeys(conversionType, Object.keys(conversionOptions))) {
    warn(`unknown option "${key}" for ${conversionType} - sending it anyway (see \`ctio describe ${flags.type}\`)`);
  }
  if (flags.sandbox) conversionOptions["sandbox"] = true;

  const auth = await resolveAuth({
    tokenFlag: flags.token,
    profileFlag: flags.profile,
    regionFlag: flags.region,
    baseUrlFlag: flags.baseUrl,
  });

  const client = createClient({
    token: auth.token,
    region: auth.region,
    ...(auth.baseUrlOverride ? { baseUrlOverride: auth.baseUrlOverride } : {}),
    ...(flags.insecure ? { insecure: true } : {}),
  });

  if (flags.url && inputArg) {
    throw new UsageError("Use either a positional input or --url, not both.");
  }
  if (!flags.url && !inputArg) {
    throw new UsageError("Missing input.", 'Pass a file path, "-" for stdin, or --url <URL>.');
  }

  const started = Date.now();
  let fileId: string | undefined;
  let urlForTask: string | undefined;

  if (flags.url) {
    urlForTask = flags.url;
    debug(`input: url=${flags.url}`);
  } else {
    const inputPath = inputArg as string;
    const src = await openInput(inputPath);
    debug(
      src.kind === "file"
        ? `input: file=${src.path} size=${src.size ?? "?"}`
        : "input: stdin (streaming)",
    );
    const choice = pickUploadInput(src);
    if (choice.kind === "path") {
      // Pass the path string so the SDK sets the multipart filename to the
      // basename - otherwise the uploaded file loses its original name.
      fileId = await client.files.upload(choice.path);
    } else {
      // stdin: there is no path to derive a filename from. The upload
      // goes out with the default "file" - the user explicitly piped,
      // so they've already opted out of a meaningful name.
      fileId = await client.files.upload(src.stream() as Readable);
    }
    debug(`upload complete file_id=${fileId}`);
  }

  const task = await client.createTask({
    type: conversionType,
    options: buildTaskOptions({
      ...(fileId ? { fileId } : {}),
      ...(urlForTask ? { url: urlForTask } : {}),
      options: conversionOptions,
    }),
  });
  debug(`task created id=${task.id}`);

  if (format === "pretty") info(`task ${task.id} created, waiting...`);

  const pollingInterval = resolvePollInterval(flags.pollInterval);

  await task.wait({
    pollingInterval,
    onProgress: (s) => {
      debug(`progress status=${s.status} ${s.conversionProgress ?? 0}%`);
      if (format === "pretty") {
        process.stderr.write(`\r  ${s.status} ${s.conversionProgress ?? 0}%   `);
      }
    },
  });
  if (format === "pretty") process.stderr.write("\n");

  if (task.isError) {
    throw new CtioError(
      `Conversion failed: ${task.error ?? "unknown error"}`,
      ExitCode.ApiError,
    );
  }
  if (!task.isSuccess) {
    throw new CtioError(`Task did not succeed: status=${task.status}`, ExitCode.ApiError);
  }

  const sink = openOutput(outputArg);
  if (sink.kind === "file") {
    await task.downloadTo(sink.path as string);
    debug(`downloaded to ${sink.path}`);
  } else {
    const resultStream = (await task.downloadStream()) as unknown as Readable;
    await pipeline(resultStream, process.stdout);
    debug("downloaded to stdout");
  }

  const durationMs = Date.now() - started;
  const status = {
    task_id: task.id,
    type: conversionType,
    status: task.status,
    duration_ms: durationMs,
    output: sink.kind === "stdout" ? "-" : sink.path,
    ...(flags.sandbox ? { sandbox: true } : {}),
  };

  if (format === "pretty") {
    info(`✓ ${conversionType} done in ${durationMs} ms${sink.kind === "stdout" ? " (stdout)" : ` → ${sink.path}`}`);
    return;
  }

  emitStatus(status, format, sink.kind === "stdout");
}

function normalizeType(raw: string): string {
  return raw.startsWith("convert.") ? raw : `convert.${raw}`;
}

/**
 * Build the `options` payload sent to the API. User `--option` values are
 * spread LAST so they always win - nothing (defaults included) may overwrite
 * what the user explicitly asked for.
 */
export function buildTaskOptions(args: {
  fileId?: string;
  url?: string;
  options: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(args.fileId ? { file_id: args.fileId } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...args.options,
  };
}

/**
 * Warn (never drop) when `--option` names a key the bundled catalog doesn't
 * list for this converter - a silently ignored typo is worse than a stray
 * warning. The catalog snapshot can lag a freshly shipped option, so this is
 * advisory only: the option is still sent, and the API remains the authority.
 */
export function unknownOptionKeys(type: string, keys: string[]): string[] {
  const converter = findConverter(type);
  if (!converter || converter.options.length === 0) return [];
  return keys.filter((k) => k !== "sandbox" && !converter.options.includes(k));
}

const STDIO_SENTINEL = "__ctio_stdio__";

function unswapStdio(v: string | undefined): string | undefined {
  return v === STDIO_SENTINEL ? "-" : v;
}

/**
 * `convert [input] [output]` binds a lone positional to `input`. But a URL
 * conversion (`--url`) takes no input positional, so a single positional there
 * is really the OUTPUT (e.g. `convert -t website_to_pdf out.pdf --url ...`).
 * When --url is set and only one positional was given, treat it as the output.
 */
export function resolvePositionals(
  input: string | undefined,
  output: string | undefined,
  hasUrl: boolean,
): { input: string | undefined; output: string | undefined } {
  if (hasUrl && input !== undefined && output === undefined) {
    return { input: undefined, output: input };
  }
  return { input, output };
}

export type UploadChoice =
  | { kind: "path"; path: string }
  | { kind: "stream" };

/**
 * Decide whether to upload via path string (lets the SDK extract a basename
 * for the multipart filename header) or via raw stream (no filename hint).
 *
 * Always prefer path when available. Stdin is the only legitimate stream
 * case - it genuinely has no source filename to send.
 */
export function pickUploadInput(src: { kind: "file" | "stdin"; path?: string }): UploadChoice {
  if (src.kind === "file" && src.path) {
    return { kind: "path", path: src.path };
  }
  return { kind: "stream" };
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

function parseOptionFlags(raw: string[] | string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  const list = (Array.isArray(raw) ? raw : [raw]).filter(
    (e): e is string => typeof e === "string" && e.length > 0,
  );
  if (list.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const entry of list) {
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new UsageError(`Invalid --option "${entry}". Expected key=value.`);
    }
    const key = entry.slice(0, eq).trim();
    const valueRaw = entry.slice(eq + 1);
    if (!key) throw new UsageError(`Invalid --option "${entry}". Empty key.`);
    out[key] = coerceValue(valueRaw);
  }
  return out;
}

/**
 * Coerce a `--option key=value` value for the API payload.
 *
 * Numeric-looking values stay STRINGS on purpose. Several options are string
 * enums of digits (`version: '2'|'1'|'3'`, `bitrate: '128'|...`, `bit_depth`,
 * `audio_channels`, `sampling_rate`, `image_resolution`). The API validates
 * those with an exact-match list lookup, so a JSON number never matches and the
 * value is silently REPLACED by that option's default - the conversion then
 * reports SUCCESS while having ignored the flag (e.g. `--option version=1` ran
 * as version 2). Options that genuinely want a number parse it from the string
 * anyway (parseInt/parseFloat), so strings are safe across the board.
 *
 * Booleans stay real booleans: the API's yes/no options explicitly accept
 * `true`/`false` alongside 'yes'/'on', and the string "true" is NOT accepted.
 */
function coerceValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

export const __testables = {
  normalizeType,
  parseOptionFlags,
  coerceValue,
  resolvePollInterval,
  pickUploadInput,
  resolvePositionals,
  buildTaskOptions,
  unknownOptionKeys,
};

function emitStatus(payload: unknown, format: OutputFormat, fileOnStdout: boolean): void {
  if (!fileOnStdout) {
    emit(payload, format);
    return;
  }
  if (format === "ndjson") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === "json") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
}
