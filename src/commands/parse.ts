import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import type { CAC } from "cac";

import { resolvePollInterval } from "@/commands/convert";
import { CTIO_USER_AGENT } from "@/lib/client";
import { type ExitCodeValue, CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { type OutputFormat, emit, isOutputFormat } from "@/lib/output";
import { resolveParseToken } from "@/lib/token";

// Seconds the upload request is held open for an inline answer. Longer
// extractions come back as `processing` and are polled, so this stays well under
// any proxy or client idle timeout.
const INLINE_WAIT_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

interface ParseFlags {
  output?: string;
  schema?: string;
  schemaId?: string;
  id?: string | number;
  timeout?: number | string;
  pollInterval?: number | string;
  parseToken?: string;
  baseUrl?: string;
  format?: string;
}

// The envelope of POST /extract and GET /extractions/:id (and of their errors).
interface ExtractionResponse {
  success?: boolean;
  id?: string;
  status?: string;
  data?: unknown;
  data_expired?: boolean;
  progress?: number | null;
  pages_used?: number;
  cached?: boolean;
  error?: string | null;
  message?: string;
}

interface ParseContext {
  parseToken: string;
  baseUrl: string;
}

interface WaitPlan {
  timeoutSec: number;
  deadline: number | null;
  pollIntervalMs: number;
}

interface CompletedExtraction {
  response: ExtractionResponse;
  data: unknown;
}

export type ParsePlan = { source: "file"; file: string } | { source: "id"; id: string };

export type ExtractionOutcome = { kind: "completed"; data: unknown } | { kind: "running"; id: string };

class ParseRequestError extends CtioError {
  readonly retryable: boolean;

  constructor(message: string, exitCode: ExitCodeValue, retryable: boolean, hint?: string) {
    super(message, exitCode, hint);
    this.name = "ParseRequestError";
    this.retryable = retryable;
  }
}

/**
 * Parse a --schema file into the `fields` array the Parse API expects. Accepts
 * either a bare JSON array of field definitions or an object with a `fields`
 * property (the shape Parse exports).
 */
export function loadFields(content: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new UsageError(
      "Schema file is not valid JSON.",
      "Pass a JSON file containing the fields to extract.",
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { fields?: unknown }).fields)) {
    return (parsed as { fields: unknown[] }).fields;
  }
  throw new UsageError(
    "Schema file must be a JSON array of fields, or an object with a `fields` array.",
  );
}

/** A new extraction of a document, or a follow-up on an earlier one by id. */
export function planParse(file: string | undefined, flags: ParseFlags): ParsePlan {
  if (flags.id !== undefined) {
    if (file) {
      throw new UsageError("Pass a document or --id, not both.");
    }
    // The option parser turns an all-digit value into a number, and its text is gone.
    if (typeof flags.id !== "string") {
      throw new UsageError(
        `--id ${flags.id} is not an extraction id.`,
        "Use the extraction id that ctio parse printed (32 letters and digits).",
      );
    }
    if (flags.schema || flags.schemaId) {
      throw new UsageError("--schema and --schema-id apply to a new extraction, not to --id.");
    }
    return { source: "id", id: flags.id };
  }
  if (!file) {
    throw new UsageError(
      "Missing the document to extract.",
      "Usage: ctio parse <file> [--schema fields.json], or ctio parse --id <extraction_id> for an earlier extraction.",
    );
  }
  return { source: "file", file };
}

export function resolveTimeout(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`Invalid --timeout "${raw}".`, "Must be a number of seconds ≥ 0 (0 = no cap).");
  }
  return n;
}

/** The `wait` sent with the upload: the inline window, never past the overall cap. */
export function inlineWaitSeconds(timeoutSec: number): number {
  return timeoutSec > 0 ? Math.min(INLINE_WAIT_SECONDS, timeoutSec) : INLINE_WAIT_SECONDS;
}

/**
 * What an extraction answer means: a result, or still running. The API always
 * carries `status`, and a 200 can be `failed` too, so this branches on status
 * only. Anything without a usable result is an error, never a printed `null`.
 */
export function readOutcome(json: ExtractionResponse): ExtractionOutcome {
  const id = json.id ?? "(no id)";
  switch (json.status) {
    case "completed":
      if (json.data_expired) {
        throw new CtioError(
          `Extraction ${id} completed, but its stored result has expired.`,
          ExitCode.ApiError,
          "Extract the document again.",
        );
      }
      if (json.data === undefined || json.data === null) {
        throw new CtioError(
          `Extraction ${id} completed, but its result could not be read.`,
          ExitCode.ApiError,
          resumeHint(id),
        );
      }
      return { kind: "completed", data: json.data };
    case "failed":
      throw new CtioError(`Extraction ${id} failed: ${json.error || "no reason given"}`, ExitCode.ApiError);
    case "pending":
    case "processing":
      if (!json.id) {
        throw new CtioError("Parse accepted the document but returned no extraction id.", ExitCode.ApiError);
      }
      return { kind: "running", id: json.id };
    default:
      throw new CtioError(
        `Parse returned an unexpected extraction status "${json.status ?? "(none)"}".`,
        ExitCode.ApiError,
      );
  }
}

function resumeHint(id: string): string {
  return `Fetch it later with: ctio parse --id ${id}`;
}

export function registerParse(cli: CAC): void {
  cli
    .command("parse [file]", "Extract structured data from a document (Parse API)")
    .option("-o, --output <file>", "Write the extracted data to a file (default: stdout)")
    .option("--schema <file>", "JSON file with the fields to extract (schema-less if omitted)")
    .option("--schema-id <id>", "Use a saved Parse schema by id")
    .option("--id <extraction_id>", "Fetch an earlier extraction (waits if it is still running)")
    .option("--timeout <sec>", `Give up waiting after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}, 0 = no cap)`)
    .option("--poll-interval <ms>", `Status poll interval in ms (default ${DEFAULT_POLL_INTERVAL_MS})`)
    .option("--parse-token <token>", "Parse API key (or env CT_PARSE_TOKEN); create one at parse.conversiontools.io")
    .example("  ctio parse invoice.pdf")
    .example("  ctio parse invoice.pdf --schema fields.json -o out.json")
    .example("  ctio parse --id <extraction_id>")
    .example("  CT_PARSE_TOKEN=... ctio parse contract.pdf --format pretty")
    .action(async (file: string | undefined, flags: ParseFlags) => {
      const plan = planParse(file, flags);
      const { parseToken, baseUrl } = resolveParseToken({
        parseTokenFlag: flags.parseToken,
        baseUrlFlag: flags.baseUrl,
      });
      const ctx: ParseContext = { parseToken, baseUrl };
      const format = pickFormat(flags.format);
      const timeoutSec = resolveTimeout(flags.timeout);
      const wait: WaitPlan = {
        timeoutSec,
        deadline: timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null,
        pollIntervalMs:
          flags.pollInterval === undefined ? DEFAULT_POLL_INTERVAL_MS : resolvePollInterval(flags.pollInterval),
      };

      const first =
        plan.source === "file"
          ? await startExtraction(ctx, plan.file, flags, timeoutSec)
          : await parseFetch(ctx, "GET", `extractions/${encodeURIComponent(plan.id)}`);
      const { response, data } = await followExtraction(ctx, first, wait, format);

      if (response.cached) {
        info("This document was already extracted with the same fields: returning the stored result (no pages charged).");
      } else if (response.pages_used !== undefined) {
        info(`Extracted ${response.pages_used} page(s).`);
      }

      if (flags.output) {
        await writeFile(flags.output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        info(`Wrote extracted data to ${flags.output}`);
        return;
      }
      emit(data, format);
    });
}

async function startExtraction(
  ctx: ParseContext,
  file: string,
  flags: ParseFlags,
  timeoutSec: number,
): Promise<ExtractionResponse> {
  let fileBuf: Buffer;
  try {
    fileBuf = await readFile(file);
  } catch {
    throw new UsageError(`Cannot read input file: ${file}`);
  }

  const form = new FormData();
  form.append("file", new Blob([fileBuf]), basename(file));
  if (flags.schemaId) form.append("schema_id", flags.schemaId);
  if (flags.schema) {
    let schemaContent: string;
    try {
      schemaContent = await readFile(flags.schema, "utf8");
    } catch {
      throw new UsageError(`Cannot read schema file: ${flags.schema}`);
    }
    form.append("fields", JSON.stringify(loadFields(schemaContent)));
  }
  form.append("wait", String(inlineWaitSeconds(timeoutSec)));

  debug(`uploading ${fileBuf.length} bytes`);
  return parseFetch(ctx, "POST", "extract", form);
}

// Poll GET /extractions/:id from the first answer until it settles, or the cap.
async function followExtraction(
  ctx: ParseContext,
  first: ExtractionResponse,
  wait: WaitPlan,
  format: OutputFormat,
): Promise<CompletedExtraction> {
  let json = first;
  let failures = 0;
  let announced = false;
  let progressShown = false;
  try {
    for (;;) {
      const outcome = readOutcome(json);
      if (outcome.kind === "completed") return { response: json, data: outcome.data };

      const { id } = outcome;
      if (wait.deadline !== null && Date.now() >= wait.deadline) {
        throw new CtioError(
          `Extraction ${id} is still processing after ${wait.timeoutSec}s.`,
          ExitCode.GenericError,
          resumeHint(id),
        );
      }
      if (!announced) {
        info(`Extraction ${id} is processing, waiting for the result...`);
        announced = true;
      }
      if (format === "pretty") {
        process.stderr.write(`\r  processing ${json.progress ?? 0}%   `);
        progressShown = true;
      }

      const remaining = wait.deadline === null ? wait.pollIntervalMs : wait.deadline - Date.now();
      await sleep(Math.max(0, Math.min(wait.pollIntervalMs, remaining)));

      try {
        json = await parseFetch(ctx, "GET", `extractions/${encodeURIComponent(id)}`);
        failures = 0;
      } catch (err) {
        if (!(err instanceof ParseRequestError) || !err.retryable) throw err;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new CtioError(err.message, err.exitCode, resumeHint(id));
        }
        debug(`poll failed (${failures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${err.message}`);
      }
    }
  } finally {
    if (progressShown) process.stderr.write("\n");
  }
}

async function parseFetch(
  ctx: ParseContext,
  method: "GET" | "POST",
  path: string,
  body?: FormData,
): Promise<ExtractionResponse> {
  const url = `${ctx.baseUrl}/${path}`;
  debug(`${method} ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${ctx.parseToken}`, "User-Agent": CTIO_USER_AGENT },
      ...(body ? { body } : {}),
    });
  } catch (err) {
    throw new ParseRequestError(`Parse request failed: ${(err as Error).message}`, ExitCode.ApiError, true);
  }

  const retryable = res.status >= 500 || res.status === 429;
  let json: ExtractionResponse;
  try {
    json = (await res.json()) as ExtractionResponse;
  } catch {
    throw new ParseRequestError(`Parse returned a non-JSON response (HTTP ${res.status}).`, ExitCode.ApiError, retryable);
  }

  if (res.status === 401) {
    throw new ParseRequestError(
      json.error || "Authentication failed.",
      ExitCode.AuthError,
      false,
      "Check your Parse API key (--parse-token / CT_PARSE_TOKEN).",
    );
  }
  if (res.status === 404) {
    throw new ParseRequestError(json.error || "Not found.", ExitCode.NotFound, false);
  }
  if (!res.ok || json.success === false) {
    // `message` is the API's user-facing sentence for a plan limit; `error` otherwise.
    const msg = json.message || json.error || `Parse failed (HTTP ${res.status}).`;
    throw new ParseRequestError(msg, ExitCode.ApiError, retryable);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

export const __testables = {
  inlineWaitSeconds,
  loadFields,
  planParse,
  readOutcome,
  resolveTimeout,
};
