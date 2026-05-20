import { basename } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { CAC } from "cac";

import { createClient } from "@/lib/client";
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { regionToBaseUrl } from "@/lib/region";
import { openInput, openOutput } from "@/lib/streams";
import { resolveAuth } from "@/lib/token";
import { streamUpload } from "@/lib/upload";

interface ConvertFlags {
  type?: string;
  option?: string[] | string;
  url?: string;
  sandbox?: boolean;
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  verbose?: boolean;
}

export function registerConvert(cli: CAC): void {
  cli
    .command("convert [input] [output]", "Run a conversion task")
    .option("-t, --type <type>", "Conversion type (e.g. json_to_excel, convert.json_to_excel)")
    .option("--option <kv>", "Conversion option as key=value (repeatable)", { type: [] })
    .option("--url <url>", "Use a remote URL as input instead of a local file")
    .option("--sandbox", "Sandbox mode (skips conversion, validates plumbing)")
    .example("  ctio convert -t json_to_excel data.json out.xlsx")
    .example("  cat data.json | ctio convert -t json_to_excel - out.xlsx")
    .example("  ctio convert -t xml_to_csv data.xml - > out.csv")
    .example("  ctio convert -t excel_to_xml in.xlsx out.xml --option header=yes")
    .action(async (input: string | undefined, output: string | undefined, flags: ConvertFlags) => {
      await runConvert(unswapStdio(input), unswapStdio(output), flags);
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
    const uploadBaseUrl = auth.baseUrlOverride ?? regionToBaseUrl(auth.region);
    const uploadFilename =
      src.kind === "file" && src.path ? basename(src.path) : "stdin";
    fileId = await streamUpload({
      baseURL: uploadBaseUrl,
      token: auth.token,
      source: src.stream() as Readable,
      filename: uploadFilename,
    });
    debug(`upload complete file_id=${fileId}`);
  }

  const task = await client.createTask({
    type: conversionType,
    options: {
      ...(fileId ? { file_id: fileId } : {}),
      ...(urlForTask ? { url: urlForTask } : {}),
      ...conversionOptions,
    },
  });
  debug(`task created id=${task.id}`);

  if (format === "pretty") info(`task ${task.id} created, waiting...`);

  await task.wait({
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

const STDIO_SENTINEL = "__ctio_stdio__";

function unswapStdio(v: string | undefined): string | undefined {
  return v === STDIO_SENTINEL ? "-" : v;
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

function coerceValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "") return "";
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

export const __testables = {
  normalizeType,
  parseOptionFlags,
  coerceValue,
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
