import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AuthMissingError } from "@/lib/errors";
import { loadProfiles, profilesPath, saveProfiles } from "@/lib/profile";
import { resolveAuth } from "@/lib/token";

import { useTempConfig } from "./helpers/config";

describe("profiles.toml with a Parse key", () => {
  const config = useTempConfig();

  test("keeps the Parse key as parse_token next to the API token", async () => {
    const file = {
      active: "default",
      profiles: {
        default: { token: "ct-token", parseToken: "pk-key", region: "auto" as const, email: "user@example.com" },
        parse_only: { parseToken: "pk-other", region: "auto" as const },
      },
    };
    await saveProfiles(file);
    expect(profilesPath()).toBe(config.profilesFile);
    const raw = readFileSync(config.profilesFile, "utf8");
    expect(raw).toContain('parse_token = "pk-key"');
    expect(raw).not.toContain("parseToken");
    expect(await loadProfiles()).toEqual(file);
  });

  test("drops a profile that holds neither key", async () => {
    config.writeProfiles('active = "default"\n[profiles.default]\ntoken = "ct-token"\nregion = "auto"\n[profiles.empty]\nregion = "auto"\n');
    expect(Object.keys((await loadProfiles()).profiles)).toEqual(["default"]);
  });

  test("a profile with only a Parse key has no API token", async () => {
    config.writeProfiles('active = "default"\n[profiles.default]\nparse_token = "pk-key"\nregion = "auto"\n');
    await expect(resolveAuth({})).rejects.toBeInstanceOf(AuthMissingError);
  });
});

// The real CLI against a fake API: what it checks, what it saves, what it prints.
describe("ctio auth with a Parse key", () => {
  const config = useTempConfig();
  const KEY = "pk-live-key-1234";

  interface Received {
    method: string;
    path: string;
    auth: string | null;
  }
  let server: ReturnType<typeof Bun.serve>;
  let received: Received[] = [];
  let usageAnswer: { status: number; body: unknown };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        received.push({ method: req.method, path: pathname, auth: req.headers.get("authorization") });
        if (req.method === "GET" && pathname === "/v1/usage") {
          return Response.json(usageAnswer.body, { status: usageAnswer.status });
        }
        if (req.method === "GET" && pathname === "/v1/auth") {
          return Response.json({ error: null, email: "user@example.com" });
        }
        if (req.method === "POST" && pathname === "/v1/extract") {
          return Response.json({ success: true, id: "6f1c0e5a9b2d4c7e8a1b3c5d7e9f0a2b", status: "completed", data: { total: 1 }, pages_used: 1 });
        }
        return Response.json({ error: "Bad request" }, { status: 400 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    received = [];
    usageAnswer = {
      status: 200,
      body: { success: true, plan: "pro", pages_used: 800, pages_limit: 5000, pages_remaining: 4200 },
    };
  });

  async function ctio(args: string[], stdin = "") {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "src/index.ts", ...args, "--base-url", `http://127.0.0.1:${server.port}/v1`],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, CLAUDECODE: undefined },
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  const withApiToken = 'active = "default"\n[profiles.default]\ntoken = "ct-token"\nregion = "auto"\nemail = "user@example.com"\n';

  test("login --parse checks the key with Parse and saves it next to the API token", async () => {
    config.writeProfiles(withApiToken);
    const { exitCode, stdout, stderr } = await ctio(["auth", "login", "--parse"], `${KEY}\n`);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("✓ Parse key works (pro plan, 4,200 of 5,000 pages left this month)");
    expect(received).toEqual([{ method: "GET", path: "/v1/usage", auth: `Bearer ${KEY}` }]);
    expect((await loadProfiles()).profiles["default"]).toEqual({
      token: "ct-token",
      parseToken: KEY,
      region: "auto",
      email: "user@example.com",
    });
    expect(stdout + stderr).not.toContain(KEY);
  });

  test("a key Parse refuses is not saved", async () => {
    usageAnswer = { status: 401, body: { error: "Invalid API key", param: "authorization" } };
    const { exitCode, stderr } = await ctio(["auth", "login", "--parse"], `${KEY}\n`);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("Invalid API key");
    expect(existsSync(config.profilesFile)).toBe(false);
  });

  test("an empty key is refused before anything is sent", async () => {
    const { exitCode, stderr } = await ctio(["auth", "login", "--parse"], "\n");
    expect(exitCode).toBe(2);
    expect(stderr).toContain("cannot be empty");
    expect(received).toEqual([]);
  });

  test("without any profile, login --parse creates one that holds only the Parse key", async () => {
    expect((await ctio(["auth", "login", "--parse"], `${KEY}\n`)).exitCode).toBe(0);
    expect((await loadProfiles()).profiles).toEqual({ default: { parseToken: KEY, region: "auto" } });
    const status = await ctio(["auth", "status", "--format", "json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ active: "default", token: "(none)", parseToken: "pk-l***" });
  });

  test("ctio parse uses the saved key", async () => {
    config.writeProfiles(`${withApiToken}parse_token = "pk-saved"\n`);
    const doc = join(config.dir, "invoice.pdf");
    writeFileSync(doc, new Uint8Array([37, 80, 68, 70]));
    const { exitCode, stdout } = await ctio(["parse", doc]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ total: 1 });
    expect(received).toEqual([{ method: "POST", path: "/v1/extract", auth: "Bearer pk-saved" }]);
  });

  test("without a saved key, ctio parse says how to save one and sends nothing", async () => {
    const doc = join(config.dir, "invoice.pdf");
    writeFileSync(doc, new Uint8Array([37, 80, 68, 70]));
    const { exitCode, stderr } = await ctio(["parse", doc]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("No Parse API key found.");
    expect(stderr).toContain("ctio auth login --parse");
    expect(received).toEqual([]);
  });

  test("logging in to Conversion Tools again keeps the saved Parse key", async () => {
    config.writeProfiles('active = "default"\n[profiles.default]\ntoken = "ct-old"\nparse_token = "pk-saved"\nregion = "auto"\n');
    const { exitCode } = await ctio(["auth", "login", "--token", "ct-new"], "\n");
    expect(exitCode).toBe(0);
    expect((await loadProfiles()).profiles["default"]).toEqual({
      token: "ct-new",
      parseToken: "pk-saved",
      region: "auto",
      email: "user@example.com",
    });
  });

  test("logout --parse removes only the Parse key", async () => {
    config.writeProfiles(`${withApiToken}parse_token = "pk-saved"\n`);
    const { exitCode, stderr } = await ctio(["auth", "logout", "--parse"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('Removed the Parse API key from profile "default".');
    expect((await loadProfiles()).profiles["default"]).toEqual({ token: "ct-token", region: "auto", email: "user@example.com" });
  });

  test("logout --parse removes a profile that held only the Parse key", async () => {
    config.writeProfiles('active = "default"\n[profiles.default]\nparse_token = "pk-saved"\nregion = "auto"\n');
    expect((await ctio(["auth", "logout", "--parse"])).exitCode).toBe(0);
    expect((await loadProfiles()).profiles).toEqual({});
  });

  test("logout --parse without a saved key is an error", async () => {
    config.writeProfiles(withApiToken);
    const { exitCode, stderr } = await ctio(["auth", "logout", "--parse"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("has no saved Parse API key");
  });
});
