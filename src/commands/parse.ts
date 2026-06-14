import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import type { CAC } from "cac";

import packageJson from "../../package.json" with { type: "json" };
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { resolveParseToken } from "@/lib/token";

const USER_AGENT = `ctio/${packageJson.version}`;

interface ParseFlags {
  output?: string;
  schema?: string;
  schemaId?: string;
  parseToken?: string;
  baseUrl?: string;
  format?: string;
}

interface ExtractResponse {
  success?: boolean;
  id?: string;
  filename?: string;
  status?: string;
  data?: unknown;
  pages_used?: number;
  error?: string | null;
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

export function registerParse(cli: CAC): void {
  cli
    .command("parse <file>", "Extract structured data from a document (Parse API)")
    .option("-o, --output <file>", "Write the extracted data to a file (default: stdout)")
    .option("--schema <file>", "JSON file with the fields to extract (schema-less if omitted)")
    .option("--schema-id <id>", "Use a saved Parse schema by id")
    .option("--parse-token <token>", "Parse API key (or env CT_PARSE_TOKEN); create one at parse.conversiontools.io")
    .example("  ctio parse invoice.pdf")
    .example("  ctio parse invoice.pdf --schema fields.json -o out.json")
    .example("  CT_PARSE_TOKEN=... ctio parse contract.pdf --format pretty")
    .action(async (file: string, flags: ParseFlags) => {
      const { parseToken, baseUrl } = resolveParseToken({
        parseTokenFlag: flags.parseToken,
        baseUrlFlag: flags.baseUrl,
      });
      const format = pickFormat(flags.format);

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
        const fields = loadFields(await readFile(flags.schema, "utf8"));
        form.append("fields", JSON.stringify(fields));
      }

      const url = `${baseUrl}/parse/extract`;
      debug(`POST ${url} (${fileBuf.length} bytes)`);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${parseToken}`, "User-Agent": USER_AGENT },
          body: form,
        });
      } catch (err) {
        throw new CtioError(`Parse request failed: ${(err as Error).message}`, ExitCode.GenericError);
      }

      let json: ExtractResponse;
      try {
        json = (await res.json()) as ExtractResponse;
      } catch {
        throw new CtioError(`Parse returned a non-JSON response (HTTP ${res.status}).`, ExitCode.GenericError);
      }

      if (!res.ok || json.success === false) {
        const msg = json.error || `Parse failed (HTTP ${res.status}).`;
        const hint =
          res.status === 401
            ? "Check your Parse API key (--parse-token / CT_PARSE_TOKEN)."
            : undefined;
        throw new CtioError(msg, ExitCode.GenericError, hint);
      }

      if (json.pages_used !== undefined) info(`Extracted ${json.pages_used} page(s).`);

      if (flags.output) {
        await writeFile(flags.output, `${JSON.stringify(json.data ?? null, null, 2)}\n`, "utf8");
        info(`Wrote extracted data to ${flags.output}`);
        return;
      }
      emit(json.data ?? null, format);
    });
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

export const __testables = {
  loadFields,
};
