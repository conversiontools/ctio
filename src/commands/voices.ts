import { basename } from "node:path";

import type { CAC } from "cac";

import { CTIO_USER_AGENT } from "@/lib/client";
import { CtioError, ExitCode, IoError, UsageError } from "@/lib/errors";
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
  name?: string | number;
  tone?: string;
  consent?: string;
  yes?: boolean;
}

export interface Voice {
  id: string;
  name: string;
  type: "builtin" | "clone";
  // Built-in voices: the language_tts code the voice speaks.
  language?: string;
  // Clones: the tone label given when it was cloned.
  tone?: string;
  created?: string | null;
}

// GET /v1/voices
interface VoicesResponse {
  error?: string | null;
  voices?: Voice[];
  formats?: string[];
  languages?: Array<{ code: string; name: string }>;
  // What POST /v1/voices expects as `consent`, word for word.
  consent_statement?: string;
}

// POST /v1/voices, DELETE /v1/voices/:id
interface VoiceChangeResponse {
  error?: string | null;
  voice?: Voice;
  deleted?: string;
}

export type VoicesPlan =
  | { action: "list" }
  | { action: "clone"; file: string; name: string; tone?: string; consent?: string }
  | { action: "delete"; id: string };

const CLONE_USAGE = 'ctio voice clone <file> --name <name> [--tone <tone>] --consent "<statement>"';

export function registerVoices(cli: CAC): void {
  cli
    .command("voice [action] [target]", "List the text-to-speech voices, or clone / delete your own: clone | delete")
    // The list command was `voices` before cloning arrived; scripts that call it keep working.
    .alias("voices")
    .option("--name <name>", "clone: a name for the new voice")
    .option("--tone <tone>", "clone: a label for the sample's mood: normal, excited, cheerful, confident, curious, calm, sad, angry, frustrated")
    .option("--consent <statement>", "clone: the consent statement, word for word (`ctio voice` shows it)")
    .option("--yes", "delete: confirm; a deleted voice cannot be restored")
    .example("  ctio voice --format pretty")
    .example('  ctio voice clone my-voice.wav --name "My narrator" --tone calm --consent "<statement>"')
    .example("  ctio voice delete <voice_id> --yes")
    .example("  ctio convert -t ai_text_to_mp3 script.txt narration.wav --option voice_tts=<voice_id>")
    .action(async (action: string | undefined, target: string | undefined, flags: VoicesFlags) => {
      const format = pickFormat(flags.format);
      const plan = planVoices(action, target, flags);
      const auth = await resolveAuth({
        tokenFlag: flags.token,
        profileFlag: flags.profile,
        regionFlag: flags.region,
        baseUrlFlag: flags.baseUrl,
      });
      const baseUrl = auth.baseUrlOverride ?? regionToBaseUrl(auth.region);
      switch (plan.action) {
        case "list":
          await runList(baseUrl, auth.token, format);
          return;
        case "clone":
          await runClone(plan, baseUrl, auth.token, format);
          return;
        case "delete":
          await runDelete(plan.id, baseUrl, auth.token, format);
          return;
      }
    });
}

/** Which voices action to run, with its arguments checked before anything is sent. */
export function planVoices(action: string | undefined, target: string | undefined, flags: VoicesFlags): VoicesPlan {
  if (action === undefined || action === "list") return { action: "list" };

  if (action === "clone") {
    if (!target) throw new UsageError("Missing the audio sample to clone.", `Usage: ${CLONE_USAGE}`);
    const name = flags.name === undefined ? "" : String(flags.name).trim();
    if (!name) throw new UsageError("Missing --name for the new voice.", `Usage: ${CLONE_USAGE}`);
    return {
      action: "clone",
      file: target,
      name,
      ...(flags.tone === undefined ? {} : { tone: String(flags.tone) }),
      ...(flags.consent === undefined ? {} : { consent: String(flags.consent) }),
    };
  }

  if (action === "delete") {
    if (!target) throw new UsageError("Missing the ID of the voice to delete.", "Usage: ctio voice delete <voice_id> --yes");
    if (!flags.yes) throw new UsageError("Deleting a voice cannot be undone.", "Add --yes to confirm.");
    return { action: "delete", id: target };
  }

  throw new UsageError(
    `Unknown voices action "${action}".`,
    "Use `ctio voice`, `ctio voice clone <file> ...` or `ctio voice delete <voice_id> --yes`.",
  );
}

/**
 * Why the --consent flag does not confirm consent, or null when it does. Checked
 * before the sample is read, so no voice leaves the machine without it.
 */
export function consentProblem(consent: string | undefined, statement: string): CtioError | null {
  if (consent !== undefined && consent.trim() === statement) return null;
  return new UsageError(
    consent === undefined
      ? "Cloning a voice needs the speaker's consent."
      : "The --consent text does not match the consent statement.",
    `Only if this is your own voice, or you have the speaker's explicit permission, add:\n  --consent "${statement}"`,
  );
}

async function runList(baseUrl: string, token: string, format: OutputFormat): Promise<void> {
  const res = await fetchVoices(baseUrl, token);
  const voices = res.voices ?? [];

  if (format === "pretty") {
    process.stdout.write(renderTable(voices));
    if (res.formats?.length) info(`formats: ${res.formats.join(", ")}`);
    if (!voices.some((v) => v.type === "clone")) {
      info("No cloned voices on this account. Clone one with `ctio voice clone <file>` or on voice.conversiontools.io.");
    }
    return;
  }
  if (format === "ndjson") {
    emit(voices, format);
    return;
  }
  emit(
    {
      voices,
      formats: res.formats ?? [],
      languages: res.languages ?? [],
      ...(res.consent_statement ? { consent_statement: res.consent_statement } : {}),
    },
    format,
  );
}

async function runClone(
  plan: Extract<VoicesPlan, { action: "clone" }>,
  baseUrl: string,
  token: string,
  format: OutputFormat,
): Promise<void> {
  const { consent_statement: statement } = await fetchVoices(baseUrl, token);
  if (statement) {
    const problem = consentProblem(plan.consent, statement);
    if (problem) throw problem;
  }

  const sample = Bun.file(plan.file);
  if (!(await sample.exists())) throw new IoError(`File not found: ${plan.file}`);
  if (sample.size === 0) throw new IoError(`The file is empty: ${plan.file}`);

  const form = new FormData();
  form.set("file", sample, basename(plan.file));
  form.set("name", plan.name);
  if (plan.tone !== undefined) form.set("tone", plan.tone);
  form.set("consent", (plan.consent ?? "").trim());

  debug(`POST ${baseUrl}/voices (${sample.size} bytes)`);
  const res = await callApi<VoiceChangeResponse>(`${baseUrl}/voices`, token, { method: "POST", body: form });
  const voice = res.voice;
  if (!voice?.id) throw new CtioError("The API did not return the new voice.", ExitCode.ApiError);

  if (format === "pretty") {
    process.stdout.write(`Cloned "${voice.name}" (${voice.tone ?? "normal"}). Voice ID: ${voice.id}\n`);
    info(`Speak with it: ctio convert -t ai_text_to_mp3 script.txt narration.mp3 --option voice_tts=${voice.id}`);
    return;
  }
  emit(format === "ndjson" ? voice : { voice }, format);
}

async function runDelete(id: string, baseUrl: string, token: string, format: OutputFormat): Promise<void> {
  debug(`DELETE ${baseUrl}/voices/${id}`);
  const res = await callApi<VoiceChangeResponse>(`${baseUrl}/voices/${encodeURIComponent(id)}`, token, { method: "DELETE" });
  const deleted = res.deleted ?? id;
  if (format === "pretty") {
    process.stdout.write(`Deleted voice ${deleted}\n`);
    return;
  }
  emit({ deleted }, format);
}

function fetchVoices(baseUrl: string, token: string): Promise<VoicesResponse> {
  debug(`GET ${baseUrl}/voices`);
  return callApi<VoicesResponse>(`${baseUrl}/voices`, token, { method: "GET" });
}

async function callApi<T extends { error?: string | null }>(url: string, token: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "User-Agent": CTIO_USER_AGENT },
    });
  } catch (err) {
    throw new CtioError(`Request failed: ${(err as Error).message}`, ExitCode.ApiError);
  }

  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new CtioError(`The API returned a non-JSON response (HTTP ${res.status}).`, ExitCode.ApiError);
  }
  if (res.status === 401) {
    throw new CtioError(json.error || "Authentication failed.", ExitCode.AuthError, "Run `ctio auth login` to refresh your token.");
  }
  if (res.status === 404) {
    throw new CtioError(json.error || "Not found.", ExitCode.NotFound, "`ctio voice` lists the voice IDs on your account.");
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
  const languageOf = (v: Voice) => v.language ?? "-";
  const languageWidth = Math.max(8, ...rows.map((v) => languageOf(v).length));
  const line = (id: string, name: string, language: string, type: string) =>
    `${id.padEnd(idWidth)}  ${name.padEnd(nameWidth)}  ${language.padEnd(languageWidth)}  ${type}\n`;
  return line("ID", "NAME", "LANGUAGE", "TYPE") + rows.map((v) => line(v.id, v.name, languageOf(v), v.type)).join("");
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
