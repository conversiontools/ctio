import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";

import { isRegion, type Region } from "./region";
import { IoError } from "./errors";

export interface Profile {
  token: string;
  region: Region;
  email?: string;
}

export interface ProfilesFile {
  active: string;
  profiles: Record<string, Profile>;
}

export function profilesPath(): string {
  if (platform() === "win32") {
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "conversiontools", "profiles.toml");
  }
  const xdgHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdgHome, "conversiontools", "profiles.toml");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseProfilesFile(raw: string): ProfilesFile {
  const parsed = parse(raw);
  const active = typeof parsed["active"] === "string" ? parsed["active"] : "default";
  const profilesRaw = parsed["profiles"];
  const profiles: Record<string, Profile> = {};

  if (isPlainObject(profilesRaw)) {
    for (const [name, value] of Object.entries(profilesRaw)) {
      if (!isPlainObject(value)) continue;
      const token = value["token"];
      const region = value["region"];
      const email = value["email"];
      if (typeof token !== "string" || typeof region !== "string" || !isRegion(region)) continue;
      profiles[name] = {
        token,
        region,
        ...(typeof email === "string" ? { email } : {}),
      };
    }
  }

  return { active, profiles };
}

export async function loadProfiles(): Promise<ProfilesFile> {
  const path = profilesPath();
  try {
    const raw = await readFile(path, "utf8");
    return parseProfilesFile(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { active: "default", profiles: {} };
    }
    throw new IoError(`Failed to read profiles at ${path}: ${(err as Error).message}`);
  }
}

export async function saveProfiles(data: ProfilesFile): Promise<void> {
  const path = profilesPath();
  await mkdir(dirname(path), { recursive: true });
  const content = stringify({
    active: data.active,
    profiles: data.profiles,
  });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  if (platform() !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch (err) {
      throw new IoError(
        `Failed to set 0600 permissions on ${path}: ${(err as Error).message}`,
        "Refusing to leave the profile world-readable. Fix the perms and retry.",
      );
    }
  }
}

export function getActiveProfile(file: ProfilesFile): Profile | undefined {
  return file.profiles[file.active];
}

export function getProfile(file: ProfilesFile, name: string): Profile | undefined {
  return file.profiles[name];
}
