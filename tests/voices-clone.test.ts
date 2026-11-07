import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consentProblem, planVoices } from "@/commands/voices";
import { UsageError } from "@/lib/errors";

const STATEMENT = "I confirm this is my own voice, or I have the speaker's explicit permission to clone it.";
const VOICE_ID = "01a0de0f-045e-73e9-acd2-2510425cdd6d";

describe("planVoices", () => {
  test("lists voices with no action, as before", () => {
    expect(planVoices(undefined, undefined, {})).toEqual({ action: "list" });
    expect(planVoices("list", undefined, {})).toEqual({ action: "list" });
  });

  test("clones a sample with its name, tone and consent", () => {
    expect(planVoices("clone", "me.wav", { name: " My narrator ", tone: "calm", consent: STATEMENT })).toEqual({
      action: "clone",
      file: "me.wav",
      name: "My narrator",
      tone: "calm",
      consent: STATEMENT,
    });
  });

  test("keeps a numeric name as text", () => {
    expect(planVoices("clone", "me.wav", { name: 2026 })).toMatchObject({ name: "2026" });
  });

  test("needs a sample and a name to clone", () => {
    expect(() => planVoices("clone", undefined, { name: "n" })).toThrow(UsageError);
    expect(() => planVoices("clone", "me.wav", {})).toThrow("Missing --name");
    expect(() => planVoices("clone", "me.wav", { name: "  " })).toThrow("Missing --name");
  });

  test("deletes only with --yes", () => {
    expect(planVoices("delete", VOICE_ID, { yes: true })).toEqual({ action: "delete", id: VOICE_ID });
    expect(() => planVoices("delete", VOICE_ID, {})).toThrow("Deleting a voice cannot be undone.");
    expect(() => planVoices("delete", undefined, { yes: true })).toThrow(UsageError);
  });

  test("refuses an unknown action", () => {
    expect(() => planVoices("copy", "x", {})).toThrow('Unknown voices action "copy".');
  });
});

describe("consentProblem", () => {
  test("accepts the statement, word for word", () => {
    expect(consentProblem(STATEMENT, STATEMENT)).toBeNull();
    expect(consentProblem(`  ${STATEMENT} `, STATEMENT)).toBeNull();
  });

  test.each([
    ["missing", undefined, "Cloning a voice needs the speaker's consent."],
    ["a yes", "yes", "The --consent text does not match the consent statement."],
  ])("refuses consent that is %s, and shows the exact flag to add", (_label, consent, message) => {
    const problem = consentProblem(consent, STATEMENT);
    expect(problem).toBeInstanceOf(UsageError);
    expect(problem?.message).toBe(message);
    expect(problem?.hint).toContain(`--consent "${STATEMENT}"`);
  });
});

// The real CLI against a fake API: what reaches the server, and what does not.
describe("ctio voice clone / delete against an API", () => {
  interface Received {
    method: string;
    path: string;
    auth: string | null;
    fields?: Record<string, string>;
    file?: { name: string; size: number };
  }

  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let samplePath: string;
  let received: Received[] = [];
  let cloneAnswer: { status: number; body: unknown } = { status: 201, body: {} };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctio-voices-"));
    samplePath = join(dir, "my-voice.wav");
    writeFileSync(samplePath, new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const entry: Received = { method: req.method, path: pathname, auth: req.headers.get("authorization") };
        received.push(entry);
        if (req.method === "GET" && pathname === "/v1/voices") {
          return Response.json({ error: null, voices: [], formats: ["mp3", "wav"], languages: [], consent_statement: STATEMENT });
        }
        if (req.method === "POST" && pathname === "/v1/voices") {
          const form = await req.formData();
          entry.fields = {};
          for (const key of ["name", "tone", "consent"]) {
            const value = form.get(key);
            if (typeof value === "string") entry.fields[key] = value;
          }
          const file = form.get("file");
          if (file instanceof File) entry.file = { name: file.name, size: file.size };
          return Response.json(cloneAnswer.body, { status: cloneAnswer.status });
        }
        if (req.method === "DELETE" && pathname === `/v1/voices/${VOICE_ID}`) {
          return Response.json({ error: null, deleted: VOICE_ID });
        }
        return Response.json({ error: "Bad request" }, { status: 400 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
    cloneAnswer = {
      status: 201,
      body: { error: null, voice: { id: VOICE_ID, name: "My narrator", type: "clone", tone: "calm", created: "2026-11-07T21:00:00.000Z" } },
    };
  });

  async function ctio(args: string[]) {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "src/index.ts", ...args, "--base-url", `http://127.0.0.1:${server.port}/v1`, "--token", "test-token"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, CLAUDECODE: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test("without --consent nothing is uploaded, and the exact flag is shown", async () => {
    const { exitCode, stderr } = await ctio(["voices", "clone", samplePath, "--name", "My narrator"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Cloning a voice needs the speaker's consent.");
    expect(stderr).toContain(`--consent "${STATEMENT}"`);
    expect(received.map((r) => r.method)).toEqual(["GET"]);
  });

  test("with a consent text that is not the statement nothing is uploaded", async () => {
    const { exitCode } = await ctio(["voices", "clone", samplePath, "--name", "My narrator", "--consent", "yes"]);
    expect(exitCode).toBe(2);
    expect(received.map((r) => r.method)).toEqual(["GET"]);
  });

  test("clones: sends the sample, name, tone and statement, prints the new voice", async () => {
    const { exitCode, stdout } = await ctio(["voices", "clone", samplePath, "--name", "My narrator", "--tone", "calm", "--consent", STATEMENT]);
    expect(exitCode).toBe(0);
    const post = received.find((r) => r.method === "POST");
    expect(post?.auth).toBe("Bearer test-token");
    expect(post?.fields).toEqual({ name: "My narrator", tone: "calm", consent: STATEMENT });
    expect(post?.file).toEqual({ name: "my-voice.wav", size: 8 });
    expect(JSON.parse(stdout)).toEqual({
      voice: { id: VOICE_ID, name: "My narrator", type: "clone", tone: "calm", created: "2026-11-07T21:00:00.000Z" },
    });
  });

  test("pretty output names the voice ID and how to speak with it", async () => {
    const { exitCode, stdout, stderr } = await ctio(["voices", "clone", samplePath, "--name", "My narrator", "--consent", STATEMENT, "--format", "pretty"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`Cloned "My narrator" (calm). Voice ID: ${VOICE_ID}\n`);
    expect(stderr).toContain(`--option voice_tts=${VOICE_ID}`);
  });

  test("passes the API's refusal on, word for word", async () => {
    cloneAnswer = { status: 403, body: { error: "All your voice slots are in use (1 on the free plan).", code: "voice_slots_full" } };
    const { exitCode, stderr } = await ctio(["voices", "clone", samplePath, "--name", "My narrator", "--consent", STATEMENT]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain("All your voice slots are in use (1 on the free plan).");
  });

  test("a missing sample file is reported before anything is uploaded", async () => {
    const { exitCode, stderr } = await ctio(["voices", "clone", join(dir, "nope.wav"), "--name", "n", "--consent", STATEMENT]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain("File not found");
    expect(received.some((r) => r.method === "POST")).toBe(false);
  });

  test("deletes with --yes, and not without", async () => {
    const refused = await ctio(["voices", "delete", VOICE_ID]);
    expect(refused.exitCode).toBe(2);
    expect(received).toEqual([]);

    const { exitCode, stdout } = await ctio(["voices", "delete", VOICE_ID, "--yes"]);
    expect(exitCode).toBe(0);
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([`DELETE /v1/voices/${VOICE_ID}`]);
    expect(JSON.parse(stdout)).toEqual({ deleted: VOICE_ID });
  });

  test("`ctio voice` lists, now with the consent statement", async () => {
    const { exitCode, stdout } = await ctio(["voice"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).consent_statement).toBe(STATEMENT);
  });

  test("`ctio voices`, the name before cloning arrived, still works for every action", async () => {
    expect((await ctio(["voices"])).exitCode).toBe(0);
    const { exitCode, stdout } = await ctio(["voices", "delete", VOICE_ID, "--yes"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ deleted: VOICE_ID });
  });
});
