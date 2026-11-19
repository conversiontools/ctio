import type { CAC } from "cac";

import { checkParseKey, type ParseUsage } from "@/commands/parse";
import { createClient } from "@/lib/client";
import { AuthInvalidError, UsageError } from "@/lib/errors";
import { info, maskToken } from "@/lib/logger";
import { emit, isOutputFormat, type OutputFormat } from "@/lib/output";
import {
  getActiveProfile,
  getProfile,
  loadProfiles,
  profilesPath,
  saveProfiles,
  selectedProfileName,
  type Profile,
  type ProfilesFile,
} from "@/lib/profile";
import { isRegion, regionToBaseUrl, type Region } from "@/lib/region";
import { PARSE_BASE_URL, PARSE_KEYS_URL } from "@/lib/token";

interface AuthCommandOptions {
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  yes?: boolean;
  all?: boolean;
  parse?: boolean;
}

const AUTH_ACTIONS = [
  "login",
  "status",
  "list",
  "add-profile",
  "use-profile",
  "logout",
] as const;
type AuthAction = (typeof AUTH_ACTIONS)[number];

function isAuthAction(v: string): v is AuthAction {
  return (AUTH_ACTIONS as readonly string[]).includes(v);
}

export function registerAuth(cli: CAC): void {
  cli
    .command(
      "auth <action> [name]",
      "Manage auth: login | status | list | add-profile <name> | use-profile <name> | logout",
    )
    .option("--all", "logout: remove every profile (requires --yes)")
    .option("--yes", "Confirm destructive actions")
    .option("--parse", "login: save a Parse API key to the profile; logout: remove only the Parse key")
    .example("  ctio auth login")
    .example("  ctio auth login --parse")
    .example("  ctio auth status")
    .example("  ctio auth list")
    .example("  ctio auth add-profile prod --region us")
    .example("  ctio auth use-profile prod")
    .example("  ctio auth logout --profile prod")
    .action(async (action: string, name: string | undefined, opts: AuthCommandOptions) => {
      if (!isAuthAction(action)) {
        throw new UsageError(
          `Unknown auth action: "${action}".`,
          `Available: ${AUTH_ACTIONS.join(", ")}.`,
        );
      }
      switch (action) {
        case "login":
          if (opts.parse) {
            await loginParse(opts);
          } else {
            await loginInteractive(opts);
          }
          return;
        case "status":
          await authStatus(opts);
          return;
        case "list":
          await authList(opts);
          return;
        case "add-profile":
          if (!name) throw new UsageError("`auth add-profile <name>` requires a profile name.");
          await addProfile(name, opts);
          return;
        case "use-profile":
          if (!name) throw new UsageError("`auth use-profile <name>` requires a profile name.");
          await useProfile(name);
          return;
        case "logout":
          await logout(opts);
          return;
      }
    });
}

function parseRegionInput(input: string | undefined, fallback: Region = "auto"): Region {
  if (!input) return fallback;
  const trimmed = input.trim();
  if (trimmed === "") return fallback;
  if (!isRegion(trimmed)) {
    throw new UsageError(`Invalid region "${trimmed}".`, "Use one of: auto, us, eu, ap.");
  }
  return trimmed;
}

function pickFormat(opts: AuthCommandOptions): OutputFormat {
  const raw = opts.format ?? "pretty";
  if (!isOutputFormat(raw)) {
    throw new UsageError(`Invalid --format "${raw}".`, "Use one of: json, pretty, ndjson.");
  }
  return raw;
}

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (typeof stdin.setRawMode === "function" && stdin.isRaw) {
    stdin.setRawMode(false);
  }
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        cleanup();
        resolve(buf.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf.replace(/\r$/, ""));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.pause();
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) {
    return await readLine(prompt);
  }
  process.stderr.write(prompt);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (byte === 0x03) {
          cleanup();
          process.stderr.write("\n");
          reject(new UsageError("Aborted."));
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

async function validateToken(token: string, region: Region, baseUrlOverride: string | undefined): Promise<string> {
  const client = createClient({
    token,
    region,
    ...(baseUrlOverride ? { baseUrlOverride } : {}),
  });
  try {
    const user = await client.getUser();
    return user.email;
  } catch (err) {
    throw new AuthInvalidError((err as Error).message);
  }
}

async function loginInteractive(opts: AuthCommandOptions): Promise<void> {
  info("To get an API token:");
  info("  1. Open https://conversiontools.io/profile");
  info('  2. Find the "API Token" section and copy the token.');
  info("");

  const tokenInput = (opts.token ?? (await readSecret("Paste your API token: "))).trim();
  if (!tokenInput) throw new UsageError("Token cannot be empty.");

  const profileName = ((await readLine("Profile name [default]: ")).trim() || "default");
  const regionInput = (await readLine("Region [auto] (auto|us|eu|ap): ")).trim();
  const region = parseRegionInput(regionInput, "auto");

  info("Validating token...");
  const email = await validateToken(tokenInput, region, opts.baseUrl);
  info(`✓ Authenticated as ${email}`);

  const file = await loadProfiles();
  // Keep a Parse API key saved earlier in this profile.
  file.profiles[profileName] = {
    ...file.profiles[profileName],
    token: tokenInput,
    region,
    email,
  };
  file.active = profileName;
  await saveProfiles(file);

  info(`Saved profile "${profileName}" to ${profilesPath()}`);
  info(`Active profile: ${profileName}`);
}

async function loginParse(opts: AuthCommandOptions): Promise<void> {
  info("To get a Parse API key:");
  info(`  1. Open ${PARSE_KEYS_URL}`);
  info("  2. Create a key and copy it.");
  info("");

  const key = (await readSecret("Paste your Parse API key: ")).trim();
  if (!key) throw new UsageError("The Parse API key cannot be empty.");

  info("Validating the key...");
  const usage = await checkParseKey(key, opts.baseUrl ?? PARSE_BASE_URL);
  info(`✓ Parse key works${describeParseUsage(usage)}`);

  const file = await loadProfiles();
  const profileName = selectedProfileName(file, opts.profile);
  const existing = file.profiles[profileName];
  file.profiles[profileName] = existing
    ? { ...existing, parseToken: key }
    : { region: "auto", parseToken: key };
  await saveProfiles(file);

  info(`Saved the Parse API key to profile "${profileName}" in ${profilesPath()}`);
}

function describeParseUsage(usage: ParseUsage): string {
  if (typeof usage.pages_remaining !== "number" || typeof usage.pages_limit !== "number") return "";
  const left = usage.pages_remaining.toLocaleString("en-US");
  const limit = usage.pages_limit.toLocaleString("en-US");
  return ` (${usage.plan ?? "free"} plan, ${left} of ${limit} pages left this month)`;
}

async function addProfile(name: string, opts: AuthCommandOptions): Promise<void> {
  if (!name) throw new UsageError("Profile name is required.");
  const file = await loadProfiles();
  if (file.profiles[name]) {
    throw new UsageError(`Profile "${name}" already exists.`, "Use `ctio auth logout --profile " + name + "` first to replace it.");
  }

  const tokenInput = (opts.token ?? (await readSecret(`Paste API token for "${name}": `))).trim();
  if (!tokenInput) throw new UsageError("Token cannot be empty.");

  const region = parseRegionInput(opts.region, "auto");
  info("Validating token...");
  const email = await validateToken(tokenInput, region, opts.baseUrl);
  info(`✓ Authenticated as ${email}`);

  file.profiles[name] = { token: tokenInput, region, email };
  await saveProfiles(file);
  info(`Added profile "${name}".`);
}

async function useProfile(name: string): Promise<void> {
  const file = await loadProfiles();
  if (!file.profiles[name]) {
    throw new UsageError(`Profile "${name}" not found.`, `Available: ${Object.keys(file.profiles).join(", ") || "(none)"}.`);
  }
  file.active = name;
  await saveProfiles(file);
  info(`Active profile: ${name}`);
}

async function logout(opts: AuthCommandOptions): Promise<void> {
  const file = await loadProfiles();

  if (opts.all) {
    if (!opts.yes) {
      throw new UsageError("Refusing to remove all profiles without --yes.");
    }
    file.profiles = {};
    file.active = "default";
    await saveProfiles(file);
    info("Removed all profiles.");
    return;
  }

  const target = opts.parse ? selectedProfileName(file, opts.profile) : (opts.profile ?? file.active);
  const profile = file.profiles[target];
  if (!profile) {
    throw new UsageError(`Profile "${target}" not found.`);
  }
  if (opts.parse) {
    if (!profile.parseToken) {
      throw new UsageError(`Profile "${target}" has no saved Parse API key.`);
    }
    if (profile.token) {
      delete profile.parseToken;
      await saveProfiles(file);
      info(`Removed the Parse API key from profile "${target}".`);
      return;
    }
  }
  delete file.profiles[target];
  if (file.active === target) {
    const remaining = Object.keys(file.profiles);
    file.active = remaining[0] ?? "default";
  }
  await saveProfiles(file);
  info(`Removed profile "${target}".`);
}

interface StatusPayload {
  active: string;
  email?: string;
  token: string;
  parseToken: string;
  region: Region;
  endpoint: string;
  source: "profile" | "none";
}

async function authStatus(opts: AuthCommandOptions): Promise<void> {
  const format = pickFormat(opts);
  const file = await loadProfiles();
  const activeName = opts.profile ?? file.active;
  const profile = opts.profile ? getProfile(file, activeName) : getActiveProfile(file);

  if (!profile) {
    if (format === "pretty") {
      info("No active profile. Run `ctio auth login`.");
      return;
    }
    emit({ active: null, source: "none" }, format);
    return;
  }

  const payload: StatusPayload = {
    active: activeName,
    ...(profile.email ? { email: profile.email } : {}),
    token: maskToken(profile.token),
    parseToken: maskToken(profile.parseToken),
    region: profile.region,
    endpoint: regionToBaseUrl(profile.region),
    source: "profile",
  };

  if (format === "pretty") {
    process.stdout.write(`Active profile: ${payload.active}\n`);
    if (payload.email) process.stdout.write(`Email:          ${payload.email}\n`);
    process.stdout.write(`Token:          ${payload.token}\n`);
    process.stdout.write(`Parse key:      ${payload.parseToken}\n`);
    process.stdout.write(`Region:         ${payload.region} (→ ${payload.endpoint})\n`);
    return;
  }
  emit(payload, format);
}

async function authList(opts: AuthCommandOptions): Promise<void> {
  const format = pickFormat(opts);
  const file = await loadProfiles();
  const entries = Object.entries(file.profiles).map(([name, p]: [string, Profile]) => ({
    name,
    active: name === file.active,
    ...(p.email ? { email: p.email } : {}),
    token: maskToken(p.token),
    parseToken: maskToken(p.parseToken),
    region: p.region,
  }));

  if (format === "pretty") {
    if (entries.length === 0) {
      info("No profiles configured. Run `ctio auth login`.");
      return;
    }
    for (const e of entries) {
      const marker = e.active ? "*" : " ";
      const parsePart = e.parseToken === "(none)" ? "" : `  parse ${e.parseToken}`;
      const emailPart = "email" in e && e.email ? `  ${e.email}` : "";
      process.stdout.write(`${marker} ${e.name.padEnd(16)} ${e.region.padEnd(6)} ${e.token}${parsePart}${emailPart}\n`);
    }
    return;
  }
  emit(entries, format);
}

export type { ProfilesFile };
