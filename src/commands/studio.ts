import { basename } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { CAC } from "cac";
import type { ConversionToolsClient } from "conversiontools";

import { resolvePollInterval } from "@/commands/convert";
import { createClient, CTIO_USER_AGENT } from "@/lib/client";
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { regionToBaseUrl } from "@/lib/region";
import { openInput } from "@/lib/streams";
import { resolveAuth } from "@/lib/token";

interface StudioFlags {
  wait?: boolean;
  pollInterval?: number | string;
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  verbose?: boolean;
}

// GET /v1/converters list entry (also the shape getById returns the subset of).
interface ConverterSummary {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  ready?: boolean;
  published?: boolean;
  inputType?: string | null;
  outputType?: string | null;
}

// GET /v1/converters/:id (the readiness fields we consult).
interface ConverterDetail {
  status?: string;
  ready?: boolean;
}

// GET /v1/converters/:id/run/status (terminal carries the result file_id).
interface RunStatus {
  status?: string;
  progress?: number;
  file_id?: string;
  file_result_name?: string;
  error?: string;
  code?: string;
}

// Structure extraction (onFileUpload) is normally seconds; cap the wait so a
// wedged converter can't hang the CLI forever.
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

const STDIO_SENTINEL = "__ctio_stdio__";
function unswapStdio(v: string | undefined): string | undefined {
  return v === STDIO_SENTINEL ? "-" : v;
}

// Pure dispatch: validate the action + positionals into a typed plan. Kept
// side-effect-free so it is unit-testable without any network.
export type StudioPlan =
  | { action: "run"; converterId: string; file: string; output?: string }
  | { action: "download"; converterId: string; output?: string }
  | { action: "list"; search?: string };

export function planStudio(
  action: string | undefined,
  a: string | undefined,
  b: string | undefined,
  c: string | undefined,
): StudioPlan {
  switch (action) {
    case "run":
      if (!a) throw new UsageError("Missing <converter_id>.", "Usage: ctio studio run <converter_id> <file> [output]");
      if (!b) throw new UsageError("Missing <file>.", "Usage: ctio studio run <converter_id> <file> [output]");
      return { action: "run", converterId: a, file: b, ...(c ? { output: c } : {}) };
    case "download":
      if (!a) throw new UsageError("Missing <converter_id>.", "Usage: ctio studio download <converter_id> [output]");
      return { action: "download", converterId: a, ...(b ? { output: b } : {}) };
    case "list":
      return { action: "list", ...(a ? { search: a } : {}) };
    default:
      throw new UsageError(
        action ? `Unknown studio action "${action}".` : "Missing studio action.",
        "Use one of: run, download, list. Example: ctio studio run <converter_id> invoice.csv out.json",
      );
  }
}

export function registerStudio(cli: CAC): void {
  cli
    .command(
      "studio <action> [a] [b] [c]",
      "Reuse an AI Studio custom converter: run | download | list",
    )
    .option("--wait", "studio run: block until the run finishes (implied when an [output] is given)")
    .option("--poll-interval <ms>", "Status poll interval in ms (default 500)")
    .example("  ctio studio list")
    .example("  ctio studio list invoice")
    .example("  ctio studio run <converter_id> invoice.csv out.json")
    .example("  ctio studio run <converter_id> invoice.csv -        # result to stdout")
    .example("  ctio studio download <converter_id> out.json        # last run's result")
    .example("  ctio studio download <converter_id> -")
    .action(async (action: string, a: string | undefined, b: string | undefined, c: string | undefined, flags: StudioFlags) => {
      const format = pickFormat(flags.format);
      const plan = planStudio(action, unswapStdio(a), unswapStdio(b), unswapStdio(c));
      switch (plan.action) {
        case "run":
          await runStudioRun(plan, flags, format);
          return;
        case "download":
          await runStudioDownload(plan, flags, format);
          return;
        case "list":
          await runStudioList(plan, flags, format);
          return;
      }
    });
}

interface StudioContext {
  client: ConversionToolsClient;
  baseUrl: string;
  token: string;
}

async function studioSetup(flags: StudioFlags): Promise<StudioContext> {
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
  const baseUrl = auth.baseUrlOverride ?? regionToBaseUrl(auth.region);
  return { client, baseUrl, token: auth.token };
}

// Raw HTTP for the converter endpoints — the SDK covers files + tasks, not the
// AI Studio converter lifecycle. UA `ctio/<v>` tags these runs as platform=cli.
async function converterFetch<T>(
  ctx: StudioContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${ctx.baseUrl}/${path}`;
  debug(`${method} ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "User-Agent": CTIO_USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new CtioError(`Request failed: ${(err as Error).message}`, ExitCode.ApiError);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      detail = j.error || j.message || "";
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) {
      throw new CtioError("Authentication failed.", ExitCode.AuthError, "Run `ctio auth login` to refresh your token.");
    }
    if (res.status === 404) {
      throw new CtioError(detail || "Converter not found.", ExitCode.NotFound, "Check the converter_id (see `ctio studio list`).");
    }
    if (res.status === 409) {
      throw new CtioError(detail || "The converter is busy.", ExitCode.ApiError, "It is building or running — wait a moment and retry.");
    }
    throw new CtioError(detail || `Request failed (HTTP ${res.status}).`, ExitCode.ApiError);
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStudioList(plan: Extract<StudioPlan, { action: "list" }>, flags: StudioFlags, format: OutputFormat): Promise<void> {
  const ctx = await studioSetup(flags);
  const path = plan.search ? `converters?search=${encodeURIComponent(plan.search)}` : "converters";
  const res = await converterFetch<{ converters?: ConverterSummary[] }>(ctx, "GET", path);
  const list = res.converters ?? [];

  if (format === "pretty") {
    if (list.length === 0) {
      info(plan.search ? `No converters match "${plan.search}".` : "No converters yet. Build one in AI Studio.");
      return;
    }
    for (const c of list) {
      const io = c.inputType || c.outputType ? `${c.inputType ?? "?"}->${c.outputType ?? "?"}` : "-";
      process.stdout.write(`${c.id}  ${(c.ready ? "ready" : "draft").padEnd(5)}  ${io.padEnd(14)}  ${c.name ?? ""}\n`);
    }
    return;
  }
  emit(list, format);
}

async function runStudioRun(plan: Extract<StudioPlan, { action: "run" }>, flags: StudioFlags, format: OutputFormat): Promise<void> {
  const ctx = await studioSetup(flags);
  const pollInterval = resolvePollInterval(flags.pollInterval);
  const started = Date.now();

  // 1. Upload the new input file (SDK; streams large files / stdin).
  const src = await openInput(plan.file);
  let fileId: string;
  let filename: string;
  let size: number | undefined;
  if (src.kind === "file" && src.path) {
    fileId = await ctx.client.files.upload(src.path);
    filename = basename(src.path);
    size = src.size;
  } else {
    fileId = await ctx.client.files.upload(src.stream() as Readable);
    filename = "file";
  }
  debug(`uploaded file_id=${fileId}`);

  // 2. Attach it to the existing built converter.
  await converterFetch(ctx, "POST", `converters/${plan.converterId}/attach-file`, {
    file_id: fileId,
    filename,
    ...(size ? { size } : {}),
  });
  if (format === "pretty") info("file attached, processing...");

  // 3. Wait for extraction to settle (status idle) before running — running
  //    mid-extraction lets the converter's `-> idle` transition clobber the
  //    run status. Mirrors the web / MCP flow.
  await waitForIdle(ctx, plan.converterId, pollInterval, format);

  // 4. Run on the uploaded file.
  await converterFetch(ctx, "POST", `converters/${plan.converterId}/run`, { dataSource: "uploaded" });
  if (format === "pretty") info("run started...");

  // 5. Fire-and-forget when neither an output nor --wait was requested.
  const willWait = Boolean(plan.output) || Boolean(flags.wait);
  if (!willWait) {
    const payload = { converter_id: plan.converterId, status: "RUNNING" };
    if (format === "pretty") {
      info(`run started. Fetch the result later: ctio studio download ${plan.converterId} <output>`);
      return;
    }
    emit(payload, format);
    return;
  }

  // 6. Poll the run to completion.
  const result = await waitForRun(ctx, plan.converterId, pollInterval, format);
  if (result.status !== "SUCCESS") {
    throw new CtioError(
      `Run failed: ${result.error ?? "the conversion could not be completed"}${result.code ? ` (${result.code})` : ""}`,
      ExitCode.ApiError,
    );
  }
  if (!result.file_id) {
    throw new CtioError("Run succeeded but no result file was returned.", ExitCode.ApiError);
  }

  // 7. Download the result (only when an output path was given).
  let savedTo: string | undefined;
  if (plan.output) {
    savedTo = await downloadResult(ctx.client, result.file_id, plan.output);
  }

  const payload = {
    converter_id: plan.converterId,
    status: "SUCCESS",
    result_file_id: result.file_id,
    ...(result.file_result_name ? { result_name: result.file_result_name } : {}),
    ...(savedTo ? { output: savedTo } : {}),
    duration_ms: Date.now() - started,
  };
  if (format === "pretty") {
    info(`✓ run SUCCESS in ${Date.now() - started} ms${savedTo ? (savedTo === "-" ? " (stdout)" : ` → ${savedTo}`) : ""}`);
    return;
  }
  emitStatus(payload, format, plan.output === "-");
}

async function runStudioDownload(plan: Extract<StudioPlan, { action: "download" }>, flags: StudioFlags, format: OutputFormat): Promise<void> {
  const ctx = await studioSetup(flags);
  const r = await converterFetch<RunStatus>(ctx, "GET", `converters/${plan.converterId}/run/status`);

  if (r.status === "RUNNING") {
    throw new CtioError(
      `Converter ${plan.converterId} is still running (${r.progress ?? 0}%).`,
      ExitCode.ApiError,
      "Wait and retry, or use `ctio studio run <converter_id> <file> <output>` to run and wait in one step.",
    );
  }
  if (r.status === "IDLE" || !r.status) {
    throw new CtioError(
      `Converter ${plan.converterId} has no completed run to download.`,
      ExitCode.NotFound,
      "Run it first: ctio studio run <converter_id> <file> <output>.",
    );
  }
  if (r.status === "ERROR") {
    throw new CtioError(`The last run failed: ${r.error ?? "unknown error"}.`, ExitCode.ApiError);
  }
  if (r.status !== "SUCCESS" || !r.file_id) {
    throw new CtioError(`No downloadable result for converter ${plan.converterId}.`, ExitCode.NotFound);
  }

  const savedTo = await downloadResult(ctx.client, r.file_id, plan.output);
  const payload = {
    converter_id: plan.converterId,
    result_file_id: r.file_id,
    ...(r.file_result_name ? { result_name: r.file_result_name } : {}),
    output: savedTo,
  };
  if (format === "pretty") {
    info(`✓ downloaded${savedTo === "-" ? " (stdout)" : ` → ${savedTo}`}`);
    return;
  }
  emitStatus(payload, format, plan.output === "-");
}

// Poll GET /converters/:id until extraction settles to `idle`.
async function waitForIdle(ctx: StudioContext, converterId: string, pollInterval: number, format: OutputFormat): Promise<void> {
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  for (;;) {
    const c = await converterFetch<ConverterDetail>(ctx, "GET", `converters/${converterId}`);
    const status = c.status ?? "unknown";
    if (status === "idle") {
      if (c.ready === false) {
        throw new CtioError(
          `Converter ${converterId} is not built yet (no runnable workflow).`,
          ExitCode.ApiError,
          "Finish building it in AI Studio first, then re-run.",
        );
      }
      if (format === "pretty") process.stderr.write("\n");
      return;
    }
    if (status === "error") {
      throw new CtioError(`Converter ${converterId} could not read the attached file.`, ExitCode.ApiError);
    }
    if (Date.now() > deadline) {
      throw new CtioError("Timed out waiting for the file to be processed.", ExitCode.ApiError);
    }
    if (format === "pretty") process.stderr.write(`\r  processing (${status})...   `);
    await sleep(pollInterval);
  }
}

// Poll GET /converters/:id/run/status until terminal. The API's own staleness
// guard flips a dead run to ERROR, so this always terminates.
async function waitForRun(ctx: StudioContext, converterId: string, pollInterval: number, format: OutputFormat): Promise<RunStatus> {
  for (;;) {
    const r = await converterFetch<RunStatus>(ctx, "GET", `converters/${converterId}/run/status`);
    if (r.status === "SUCCESS" || r.status === "ERROR") {
      if (format === "pretty") process.stderr.write("\n");
      return r;
    }
    if (format === "pretty") process.stderr.write(`\r  ${r.status ?? "RUNNING"} ${r.progress ?? 0}%   `);
    await sleep(pollInterval);
  }
}

async function downloadResult(client: ConversionToolsClient, fileId: string, output: string | undefined): Promise<string> {
  if (output === "-") {
    const stream = (await client.files.downloadStream(fileId)) as unknown as Readable;
    await pipeline(stream, process.stdout);
    return "-";
  }
  return client.files.downloadTo(fileId, output);
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

// When the result streamed to stdout, the status JSON must go to stderr so it
// doesn't corrupt the piped file. Mirrors convert's emitStatus.
function emitStatus(payload: unknown, format: OutputFormat, fileOnStdout: boolean): void {
  if (!fileOnStdout) {
    emit(payload, format);
    return;
  }
  if (format === "pretty") {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export const __testables = {
  planStudio,
  unswapStdio,
};
