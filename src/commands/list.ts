import type { CAC } from "cac";

import { CONVERTERS, type ConverterEntry } from "@/lib/converters";
import { UsageError } from "@/lib/errors";
import { info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";

interface ListFlags {
  from?: string;
  to?: string;
  ai?: boolean;
  custom?: boolean;
  detail?: boolean;
  format?: string;
}

export function registerList(cli: CAC): void {
  cli
    .command("list", "List available converters")
    .option("--from <format>", "Filter to converters that accept this input format")
    .option("--to <format>", "Filter to converters that produce this output format")
    .option("--ai", "AI-powered converters only")
    .option("--custom", "Custom (per-user / per-client) converters only")
    .option("--detail", "Pretty mode: include title, description, and option keys")
    .example("  ctio list")
    .example("  ctio list --from json --format pretty")
    .example("  ctio list --from pdf --to text")
    .example("  ctio list --ai --format pretty --detail")
    .action(async (flags: ListFlags) => {
      const format = pickFormat(flags.format);
      const filtered = filterConverters(CONVERTERS, flags);

      if (format === "pretty") {
        renderPretty(filtered, Boolean(flags.detail));
        return;
      }
      emit(filtered, format);
    });
}

export function filterConverters(
  list: readonly ConverterEntry[],
  flags: { from?: string; to?: string; ai?: boolean; custom?: boolean },
): readonly ConverterEntry[] {
  const from = flags.from?.toLowerCase().trim();
  const to = flags.to?.toLowerCase().trim();
  return list.filter((c) => {
    if (from && c.from !== from) return false;
    if (to && c.to !== to) return false;
    if (flags.ai && !c.ai) return false;
    if (flags.custom && !c.custom) return false;
    return true;
  });
}

function renderPretty(list: readonly ConverterEntry[], detail: boolean): void {
  if (list.length === 0) {
    info("No converters match the given filters.");
    return;
  }
  if (!detail) {
    for (const c of list) {
      const short = c.type.replace(/^convert\./, "");
      const flow = c.from && c.to ? `${c.from.padEnd(14)} → ${c.to}` : "—";
      process.stdout.write(`${short.padEnd(36)}  ${flow}\n`);
    }
    process.stdout.write(`\n${list.length} of ${CONVERTERS.length} converters\n`);
    return;
  }
  for (const c of list) {
    const tags = [
      c.ai ? "ai" : null,
      c.custom ? "custom" : null,
      c.batch ? "batch" : null,
      c.comingSoon ? "coming-soon" : null,
      c.registrationRequired ? "registration-required" : null,
    ]
      .filter(Boolean)
      .join(", ");
    process.stdout.write(`${c.type}\n`);
    process.stdout.write(`  ${c.title}\n`);
    if (c.from && c.to) process.stdout.write(`  from: ${c.from}  to: ${c.to}\n`);
    if (tags) process.stdout.write(`  tags: ${tags}\n`);
    if (c.optionSpecs && c.optionSpecs.length > 0) {
      process.stdout.write(`  options:\n`);
      for (const o of c.optionSpecs) {
        const vals = o.values && o.values.length > 0 ? ` = ${o.values.join(" | ")}` : "";
        process.stdout.write(`    ${o.name}${vals}\n`);
      }
    } else if (c.options.length > 0) {
      process.stdout.write(`  options: ${c.options.join(", ")}\n`);
    }
    process.stdout.write("\n");
  }
  process.stdout.write(`${list.length} of ${CONVERTERS.length} converters\n`);
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

export const __testables = {
  filterConverters,
};
