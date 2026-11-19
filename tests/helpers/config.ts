import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_VARS = ["APPDATA", "XDG_CONFIG_HOME"] as const;
const AUTH_VARS = ["CT_PROFILE", "CT_API_TOKEN", "CT_PARSE_TOKEN"] as const;

export interface TempConfig {
  readonly dir: string;
  readonly profilesFile: string;
  writeProfiles(toml: string): void;
}

/**
 * Each test gets its own empty config folder and no ctio auth env vars, so no
 * test reads or writes the real profiles.toml. Spawned ctio processes inherit it.
 */
export function useTempConfig(): TempConfig {
  let dir = "";
  let original: Record<string, string | undefined> = {};

  beforeEach(() => {
    original = Object.fromEntries([...CONFIG_VARS, ...AUTH_VARS].map((k) => [k, process.env[k]]));
    dir = mkdtempSync(join(tmpdir(), "ctio-config-"));
    for (const k of CONFIG_VARS) process.env[k] = dir;
    for (const k of AUTH_VARS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    get profilesFile() {
      return join(dir, "conversiontools", "profiles.toml");
    },
    writeProfiles(toml: string) {
      mkdirSync(join(dir, "conversiontools"), { recursive: true });
      writeFileSync(join(dir, "conversiontools", "profiles.toml"), toml);
    },
  };
}
