#!/usr/bin/env bun
import { cac } from "cac";

import packageJson from "../package.json" with { type: "json" };

import { registerAuth } from "@/commands/auth";
import { registerConvert } from "@/commands/convert";
import { registerDescribe } from "@/commands/describe";
import { registerList } from "@/commands/list";
import { registerParse } from "@/commands/parse";
import { registerStudio } from "@/commands/studio";
import { registerTask } from "@/commands/task";
import { registerVersion } from "@/commands/version";
import { CtioError, ExitCode } from "@/lib/errors";
import { error, setVerbose } from "@/lib/logger";

const VERSION = packageJson.version;

// Claude Code plugin hint: when ctio runs inside Claude Code (CLAUDECODE=1),
// emit a one-line marker to stderr so Claude Code can offer to install our
// plugin from the official Anthropic marketplace. The marker is stripped from
// the model's view, and Claude Code only acts on it for plugins in
// `claude-plugins-official` - so this is dormant until the plugin is accepted
// there. See https://code.claude.com/docs/en/plugin-hints
function emitClaudeCodePluginHint(): void {
  if (process.env["CLAUDECODE"]) {
    process.stderr.write(
      '<claude-code-hint v="1" type="plugin" value="conversiontools@claude-plugins-official" />\n',
    );
  }
}

async function main(): Promise<void> {
  emitClaudeCodePluginHint();
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
  registerParse(cli);
  registerStudio(cli);
  registerTask(cli);
  registerList(cli);
  registerDescribe(cli);
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
