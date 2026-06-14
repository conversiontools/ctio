import type { CAC } from "cac";

import { findConverter, type ConverterEntry, type OptionSpec } from "@/lib/converters";
import { UsageError } from "@/lib/errors";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";

interface DescribeFlags {
  format?: string;
}

export function registerDescribe(cli: CAC): void {
  cli
    .command("describe <type>", "Show a converter's options, allowed values, and defaults")
    .option("--format <format>", "Output format: json | pretty | ndjson")
    .example("  ctio describe xml_to_csv")
    .example("  ctio describe xml_to_csv --format pretty")
    .example("  ctio describe convert.ai_pdf_to_json")
    .action((type: string, flags: DescribeFlags) => {
      const converter = findConverter(type);
      if (!converter) {
        throw new UsageError(
          `Unknown converter "${type}".`,
          "Run `ctio list` to see available converters.",
        );
      }
      const format = pickFormat(flags.format);
      if (format === "pretty") {
        renderPretty(converter);
        return;
      }
      emit(converter, format);
    });
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

function renderPretty(c: ConverterEntry): void {
  process.stdout.write(`${c.title} (${c.type})\n`);
  if (c.description) process.stdout.write(`${c.description}\n`);
  if (c.from && c.to) process.stdout.write(`Input: ${c.from}   Output: ${c.to}\n`);
  process.stdout.write("\n");

  const specs = c.optionSpecs ?? [];
  if (specs.length === 0 && c.options.length === 0) {
    process.stdout.write("This converter takes no options.\n");
    return;
  }

  process.stdout.write("Options:\n");
  if (specs.length > 0) {
    for (const o of specs) renderOption(o);
  } else {
    // Fallback: we only have option names (no detailed metadata bundled).
    for (const name of c.options) process.stdout.write(`  ${name}\n`);
  }

  process.stdout.write(`\nExample:\n  ${buildExample(c, specs)}\n`);
}

function renderOption(o: OptionSpec): void {
  const typeLabel = o.type ? ` (${o.type})` : "";
  const def = o.default === undefined ? "" : `   [default: ${String(o.default)}]`;
  process.stdout.write(`  ${o.name}${typeLabel}${def}\n`);
  if (o.title) process.stdout.write(`      ${o.title}\n`);
  if (o.values && o.values.length > 0) {
    process.stdout.write(`      values: ${o.values.join(" | ")}\n`);
  }
}

function buildExample(c: ConverterEntry, specs: OptionSpec[]): string {
  const short = c.type.replace(/^convert\./, "");
  const inExt = c.from ?? "input";
  const outExt = c.to ?? "out";
  // Show the --option syntax using the first allowed value of the first enum
  // option, if any - so the example is copy-paste runnable.
  const enumOpt = specs.find((o) => o.values && o.values.length > 0);
  const optPart = enumOpt ? ` --option ${enumOpt.name}=${enumOpt.values![0]}` : "";
  return `ctio convert -t ${short} input.${inExt} out.${outExt}${optPart}`;
}

export const __testables = {
  buildExample,
};
