#!/usr/bin/env bun
import { cac } from "cac";

import packageJson from "../package.json" with { type: "json" };

import { registerAuth } from "@/commands/auth";
import { registerConvert } from "@/commands/convert";
import { registerList } from "@/commands/list";
import { registerTask } from "@/commands/task";
import { registerVersion } from "@/commands/version";
import { CtioError, ExitCode } from "@/lib/errors";
import { error, setVerbose } from "@/lib/logger";

const VERSION = packageJson.version;

async function main(): Promise<void> {
  const cli = cac("ctio");

  cli
    .option("--verbose", "Print verbose diagnostics to stderr (never logs tokens or file content)")
    .option("--profile <name>", "Use a named profile from the config file")
    .option("--token <token>", "Override token for this invocation")
    .option("--region <region>", "Override region: auto | us | eu | ap")
    .option("--base-url <url>", "Override API base URL (escape hatch for staging/local)")
    .option("--insecure", "Disable TLS verification (dev only, prints warning)")
    .option("--format <format>", "Output format: json | pretty | ndjson", { default: "json" });

  registerConvert(cli);
  registerTask(cli);
  registerList(cli);
  registerAuth(cli);
  registerVersion(cli, VERSION);

  cli.help();
  cli.version(VERSION);

  const STDIO_SENTINEL = "__ctio_stdio__";
  const rawArgv = process.argv.slice();
  const patchedArgv = rawArgv.map((a, i) =>
    i >= 2 && a === "-" ? STDIO_SENTINEL : a,
  );
  const parsed = cli.parse(patchedArgv, { run: false });
  parsed.args = parsed.args.map((a) => (a === STDIO_SENTINEL ? "-" : a));

  if (parsed.options["verbose"]) setVerbose(true);

  if (parsed.options["help"] || parsed.options["version"]) {
    process.exit(ExitCode.Ok);
  }
  if (parsed.args.length === 0 && !cli.matchedCommand) {
    cli.outputHelp();
    process.exit(ExitCode.Ok);
  }

  try {
    await cli.runMatchedCommand();
  } catch (err) {
    if (err instanceof CtioError) {
      error(err.message);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      process.exit(err.exitCode);
    }
    error((err as Error).message ?? String(err));
    process.exit(ExitCode.GenericError);
  }
}

await main();
