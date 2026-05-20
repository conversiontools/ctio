import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import type { CAC } from "cac";

import { resolvePollInterval } from "@/commands/convert";
import { createClient } from "@/lib/client";
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { openOutput } from "@/lib/streams";
import { resolveAuth } from "@/lib/token";

interface TaskFlags {
  wait?: boolean;
  download?: boolean;
  timeout?: number | string;
  pollInterval?: number | string;
  status?: string;
  limit?: number | string;
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  verbose?: boolean;
}

const TASK_ID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$|^[0-9a-fA-F]{32}$/;
const VALID_STATUSES = ["PENDING", "RUNNING", "SUCCESS", "ERROR"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(v: string): v is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(v);
}

const STDIO_SENTINEL = "__ctio_stdio__";
function unswapStdio(v: string | undefined): string | undefined {
  return v === STDIO_SENTINEL ? "-" : v;
}

export function registerTask(cli: CAC): void {
  cli
    .command(
      "task <action> [output]",
      "Inspect a task by ID, or `task list` to list recent tasks",
    )
    .option("--wait", "Block until task reaches SUCCESS or ERROR")
    .option("--download", "Download result file (after --wait if pending). Use [output] = `-` for stdout")
    .option("--timeout <sec>", "Cap --wait time in seconds (0 = no cap)", { default: 0 })
    .option("--poll-interval <ms>", "Status poll interval in ms (default 500)")
    .option("--status <status>", "list: filter by status (PENDING|RUNNING|SUCCESS|ERROR)")
    .option("--limit <n>", "list: cap entries (server may also cap)")
    .example("  ctio task <id>")
    .example("  ctio task <id> --wait --format pretty")
    .example("  ctio task <id> --download out.xlsx")
    .example("  ctio task <id> --download -        # stream to stdout")
    .example("  ctio task list --status ERROR")
    .action(async (action: string, output: string | undefined, flags: TaskFlags) => {
      const out = unswapStdio(output);
      const format = pickFormat(flags.format);

      if (action === "list") {
        await runTaskList(flags, format);
        return;
      }

      if (!TASK_ID_RE.test(action)) {
        throw new UsageError(
          `"${action}" is not a task id and is not the literal "list".`,
          "Pass a task UUID/hex id, or `ctio task list`.",
        );
      }

      await runTaskShow(action, out, flags, format);
    });
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

async function runTaskShow(
  taskId: string,
  outputPath: string | undefined,
  flags: TaskFlags,
  format: OutputFormat,
): Promise<void> {
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

  const task = await client.getTask(taskId);
  debug(`fetched task=${task.id} status=${task.status}`);

  if (flags.wait) {
    const timeoutSec = Number(flags.timeout ?? 0);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
      throw new UsageError(`Invalid --timeout "${flags.timeout}".`);
    }
    if (format === "pretty") info(`waiting for ${task.id}...`);
    const pollingInterval = resolvePollInterval(flags.pollInterval);
    await task.wait({
      pollingInterval,
      ...(timeoutSec > 0 ? { timeout: timeoutSec * 1000 } : {}),
      onProgress: (s) => {
        debug(`progress status=${s.status} ${s.conversionProgress ?? 0}%`);
        if (format === "pretty") {
          process.stderr.write(`\r  ${s.status} ${s.conversionProgress ?? 0}%   `);
        }
      },
    });
    if (format === "pretty") process.stderr.write("\n");
  }

  if (flags.download) {
    if (!task.isSuccess) {
      throw new CtioError(
        `Cannot download: task status is ${task.status}${task.error ? ` (${task.error})` : ""}`,
        ExitCode.ApiError,
      );
    }
    const target = outputPath ?? null;
    if (target === "-") {
      const resultStream = (await task.downloadStream()) as unknown as Readable;
      await pipeline(resultStream, process.stdout);
      debug("downloaded to stdout");
    } else if (target) {
      await task.downloadTo(target);
      debug(`downloaded to ${target}`);
    } else {
      const finalPath = await task.downloadTo();
      debug(`downloaded to ${finalPath}`);
    }
  }

  emitTask(task, outputPath, format);
}

interface TaskSummary {
  task_id: string;
  type?: string;
  status: string;
  conversionProgress: number;
  fileId: string | null;
  error: string | null;
  downloaded?: string;
}

function emitTask(
  task: {
    id: string;
    type: string;
    status: string;
    conversionProgress: number;
    fileId: string | null;
    error: string | null;
  },
  downloaded: string | undefined,
  format: OutputFormat,
): void {
  const payload: TaskSummary = {
    task_id: task.id,
    ...(task.type ? { type: task.type } : {}),
    status: task.status,
    conversionProgress: task.conversionProgress,
    fileId: task.fileId,
    error: task.error,
    ...(downloaded ? { downloaded } : {}),
  };

  if (format === "pretty") {
    process.stdout.write(`Task:     ${payload.task_id}\n`);
    if (payload.type) process.stdout.write(`Type:     ${payload.type}\n`);
    process.stdout.write(`Status:   ${payload.status}\n`);
    process.stdout.write(`Progress: ${payload.conversionProgress}%\n`);
    if (payload.fileId) process.stdout.write(`File:     ${payload.fileId}\n`);
    if (payload.error) process.stdout.write(`Error:    ${payload.error}\n`);
    if (payload.downloaded) process.stdout.write(`Saved:    ${payload.downloaded}\n`);
    return;
  }
  emit(payload, format);
}

async function runTaskList(flags: TaskFlags, format: OutputFormat): Promise<void> {
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

  const listOptions: { status?: ValidStatus } = {};
  if (flags.status) {
    const s = String(flags.status).toUpperCase();
    if (!isValidStatus(s)) {
      throw new UsageError(
        `Invalid --status "${flags.status}".`,
        `Use one of: ${VALID_STATUSES.join(", ")}.`,
      );
    }
    listOptions.status = s;
  }

  const raw = await client.tasks.list(listOptions);
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    throw new UsageError(`Invalid --limit "${flags.limit}".`);
  }
  const trimmed = limit !== undefined ? raw.slice(0, limit) : raw;

  if (format === "pretty") {
    if (trimmed.length === 0) {
      info("No tasks found.");
      return;
    }
    for (const t of trimmed) {
      process.stdout.write(
        `${t.id}  ${String(t.status).padEnd(8)}  ${t.dateCreated ?? ""}  ${t.type}\n`,
      );
    }
    return;
  }
  emit(trimmed, format);
}

export const __testables = {
  TASK_ID_RE,
  isValidStatus,
};
