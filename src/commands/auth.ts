import type { CAC } from "cac";

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
  type Profile,
  type ProfilesFile,
} from "@/lib/profile";
import { isRegion, regionToBaseUrl, type Region } from "@/lib/region";

interface AuthCommandOptions {
  profile?: string;
  token?: string;
  region?: string;
  baseUrl?: string;
  insecure?: boolean;
  format?: string;
  yes?: boolean;
  all?: boolean;
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
    .example("  ctio auth login")
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
          await loginInteractive(opts);
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
  file.profiles[profileName] = {
    token: tokenInput,
    region,
    email,
  };
  file.active = profileName;
  await saveProfiles(file);

  info(`Saved profile "${profileName}" to ${profilesPath()}`);
  info(`Active profile: ${profileName}`);
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

  const target = opts.profile ?? file.active;
  if (!file.profiles[target]) {
    throw new UsageError(`Profile "${target}" not found.`);
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
    region: profile.region,
    endpoint: regionToBaseUrl(profile.region),
    source: "profile",
  };

  if (format === "pretty") {
    process.stdout.write(`Active profile: ${payload.active}\n`);
    if (payload.email) process.stdout.write(`Email:          ${payload.email}\n`);
    process.stdout.write(`Token:          ${payload.token}\n`);
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
    region: p.region,
  }));

  if (format === "pretty") {
    if (entries.length === 0) {
      info("No profiles configured. Run `ctio auth login`.");
      return;
    }
    for (const e of entries) {
      const marker = e.active ? "*" : " ";
      const emailPart = "email" in e && e.email ? `  ${e.email}` : "";
      process.stdout.write(`${marker} ${e.name.padEnd(16)} ${e.region.padEnd(6)} ${e.token}${emailPart}\n`);
    }
    return;
  }
  emit(entries, format);
}

export type { ProfilesFile };
