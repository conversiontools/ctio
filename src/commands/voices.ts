import type { CAC } from "cac";

import { CTIO_USER_AGENT } from "@/lib/client";
import { CtioError, ExitCode, UsageError } from "@/lib/errors";
import { debug, info } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import { regionToBaseUrl } from "@/lib/region";
import { resolveAuth } from "@/lib/token";

interface VoicesFlags {
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  format?: string;
}

export interface Voice {
  id: string;
  name: string;
  type: "builtin" | "clone";
  created?: string | null;
}

// GET /v1/voices
interface VoicesResponse {
  error?: string | null;
  voices?: Voice[];
  formats?: string[];
  languages?: Array<{ code: string; name: string }>;
}

export function registerVoices(cli: CAC): void {
  cli
    .command("voices", "List the text-to-speech voices: built-in ones and your own cloned voices")
    .example("  ctio voices --format pretty")
    .example("  ctio convert -t ai_text_to_mp3 script.txt narration.wav --option voice_tts=<id>")
    .action(async (flags: VoicesFlags) => {
      const format = pickFormat(flags.format);
      const auth = await resolveAuth({
        tokenFlag: flags.token,
        profileFlag: flags.profile,
        regionFlag: flags.region,
        baseUrlFlag: flags.baseUrl,
      });
      const baseUrl = auth.baseUrlOverride ?? regionToBaseUrl(auth.region);
      const res = await fetchVoices(baseUrl, auth.token);
      const voices = res.voices ?? [];

      if (format === "pretty") {
        process.stdout.write(renderTable(voices));
        if (res.formats?.length) info(`formats: ${res.formats.join(", ")}`);
        if (!voices.some((v) => v.type === "clone")) {
          info("No cloned voices on this account. Clone one on voice.conversiontools.io; its ID then shows up here.");
        }
        return;
      }
      if (format === "ndjson") {
        emit(voices, format);
        return;
      }
      emit({ voices, formats: res.formats ?? [], languages: res.languages ?? [] }, format);
    });
}

async function fetchVoices(baseUrl: string, token: string): Promise<VoicesResponse> {
  const url = `${baseUrl}/voices`;
  debug(`GET ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": CTIO_USER_AGENT },
    });
  } catch (err) {
    throw new CtioError(`Request failed: ${(err as Error).message}`, ExitCode.ApiError);
  }

  let json: VoicesResponse;
  try {
    json = (await res.json()) as VoicesResponse;
  } catch {
    throw new CtioError(`The API returned a non-JSON response (HTTP ${res.status}).`, ExitCode.ApiError);
  }
  if (res.status === 401) {
    throw new CtioError("Authentication failed.", ExitCode.AuthError, "Run `ctio auth login` to refresh your token.");
  }
  if (!res.ok || json.error) {
    throw new CtioError(json.error || `Request failed (HTTP ${res.status}).`, ExitCode.ApiError);
  }
  return json;
}

/** ID / NAME / TYPE columns, clones first: they are the ids nobody can guess. */
export function renderTable(voices: readonly Voice[]): string {
  const rows = [...voices].sort((a, b) => Number(a.type === "builtin") - Number(b.type === "builtin"));
  const idWidth = Math.max(2, ...rows.map((v) => v.id.length));
  const nameWidth = Math.max(4, ...rows.map((v) => v.name.length));
  const line = (id: string, name: string, type: string) => `${id.padEnd(idWidth)}  ${name.padEnd(nameWidth)}  ${type}\n`;
  return line("ID", "NAME", "TYPE") + rows.map((v) => line(v.id, v.name, v.type)).join("");
}

function pickFormat(raw: string | undefined): OutputFormat {
  const candidate = raw ?? "json";
  if (!isOutputFormat(candidate)) {
    throw new UsageError(`Invalid --format "${candidate}".`, "Use one of: json, pretty, ndjson.");
  }
  return candidate;
}

export const __testables = {
  renderTable,
};
