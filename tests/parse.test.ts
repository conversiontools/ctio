import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testables } from "@/commands/parse";
import { CtioError, UsageError } from "@/lib/errors";
import { resolveParseToken } from "@/lib/token";

const { inlineWaitSeconds, loadFields, planParse, readOutcome, resolveTimeout } = __testables;

describe("loadFields", () => {
  test("accepts a bare array of fields", () => {
    expect(loadFields('[{"name":"total"}]')).toEqual([{ name: "total" }]);
  });
  test("accepts an object with a fields array (Parse export shape)", () => {
    expect(loadFields('{"fields":[{"name":"total"}]}')).toEqual([{ name: "total" }]);
  });
  test("throws on invalid JSON", () => {
    expect(() => loadFields("not json")).toThrow(/valid JSON/);
  });
  test("throws when neither an array nor a fields object", () => {
    expect(() => loadFields('{"foo":1}')).toThrow(/array of fields/);
  });
});

describe("resolveParseToken", () => {
  afterEach(() => {
    delete process.env["CT_PARSE_TOKEN"];
  });

  test("prefers the --parse-token flag over the env", () => {
    process.env["CT_PARSE_TOKEN"] = "env-key";
    const r = resolveParseToken({ parseTokenFlag: "flag-key" });
    expect(r.parseToken).toBe("flag-key");
    expect(r.source).toBe("flag");
  });
  test("falls back to CT_PARSE_TOKEN", () => {
    process.env["CT_PARSE_TOKEN"] = "env-key";
    const r = resolveParseToken({});
    expect(r.parseToken).toBe("env-key");
    expect(r.source).toBe("env");
  });
  test("throws a helpful error when no key is set", () => {
    delete process.env["CT_PARSE_TOKEN"];
    expect(() => resolveParseToken({})).toThrow(/No Parse API key/);
  });
  test("defaults to the geo base URL and honors --base-url", () => {
    process.env["CT_PARSE_TOKEN"] = "k";
    expect(resolveParseToken({}).baseUrl).toBe("https://api-parse.conversiontools.io/v1");
    expect(resolveParseToken({ baseUrlFlag: "http://localhost:6082/v1" }).baseUrl).toBe(
      "http://localhost:6082/v1",
    );
  });
});

describe("planParse", () => {
  test("a document starts a new extraction", () => {
    expect(planParse("invoice.pdf", { schema: "fields.json" })).toEqual({ source: "file", file: "invoice.pdf" });
  });
  test("--id follows an earlier extraction", () => {
    expect(planParse(undefined, { id: "abc123" })).toEqual({ source: "id", id: "abc123" });
  });
  test("needs a document or an id, not both and not neither", () => {
    expect(() => planParse(undefined, {})).toThrow(UsageError);
    expect(() => planParse("invoice.pdf", { id: "abc123" })).toThrow("not both");
  });
  test("an id the option parser read as a number is refused, not taken as missing", () => {
    expect(() => planParse(undefined, { id: 0 })).toThrow("--id 0 is not an extraction id.");
    expect(() => planParse(undefined, { id: 1.2345e31 })).toThrow(/not an extraction id/);
  });
  test("a schema only applies to a new extraction", () => {
    expect(() => planParse(undefined, { id: "abc123", schema: "fields.json" })).toThrow(UsageError);
    expect(() => planParse(undefined, { id: "abc123", schemaId: "s1" })).toThrow(UsageError);
  });
});

describe("resolveTimeout / inlineWaitSeconds", () => {
  test("defaults to 30 minutes, 0 means no cap", () => {
    expect(resolveTimeout(undefined)).toBe(1800);
    expect(resolveTimeout("0")).toBe(0);
    expect(resolveTimeout(90)).toBe(90);
  });
  test("refuses a negative or non-numeric timeout", () => {
    expect(() => resolveTimeout("-1")).toThrow(UsageError);
    expect(() => resolveTimeout("soon")).toThrow(UsageError);
  });
  test("the inline wait never runs past the overall cap", () => {
    expect(inlineWaitSeconds(1800)).toBe(30);
    expect(inlineWaitSeconds(0)).toBe(30);
    expect(inlineWaitSeconds(5)).toBe(5);
  });
});

describe("readOutcome", () => {
  test("completed carries the data", () => {
    expect(readOutcome({ id: "e1", status: "completed", data: { total: 1 } })).toEqual({
      kind: "completed",
      data: { total: 1 },
    });
  });
  test("processing and pending are still running", () => {
    expect(readOutcome({ id: "e1", status: "processing" })).toEqual({ kind: "running", id: "e1" });
    expect(readOutcome({ id: "e1", status: "pending" })).toEqual({ kind: "running", id: "e1" });
  });
  test("failed is an error with the API's reason, even inside a 200", () => {
    expect(() => readOutcome({ success: true, id: "e1", status: "failed", error: "Unreadable scan" })).toThrow(
      "Extraction e1 failed: Unreadable scan",
    );
  });
  test("completed without a result is an error, never null", () => {
    expect(() => readOutcome({ id: "e1", status: "completed", data: null })).toThrow(CtioError);
    expect(() => readOutcome({ id: "e1", status: "completed", data: null, data_expired: true })).toThrow(/expired/);
  });
  test("an unknown status or a running answer without an id is an error", () => {
    expect(() => readOutcome({ id: "e1", status: "queued" })).toThrow(/unexpected extraction status/);
    expect(() => readOutcome({ status: "processing" })).toThrow(/no extraction id/);
  });
});

// The real CLI against a fake Parse API: what it sends, how it waits, what it prints.
describe("ctio parse against an API", () => {
  interface Answer {
    status: number;
    body: unknown;
  }
  interface Received {
    method: string;
    path: string;
    auth: string | null;
    userAgent: string | null;
    fields?: Record<string, string>;
    file?: { name: string; size: number };
  }

  const ID = "6f1c0e5a9b2d4c7e8a1b3c5d7e9f0a2b";
  const DATA = { parties: [{ name: "Example Supplier Ltd" }], total_value: 90000 };
  const processing = (progress = 0): Answer => ({
    status: 200,
    body: { success: true, id: ID, status: "processing", progress, data: null, error: null },
  });
  const completed: Answer = {
    status: 200,
    body: { success: true, id: ID, status: "completed", progress: 100, data: DATA, pages_used: 3, error: null },
  };

  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let docPath: string;
  let fieldsPath: string;
  let received: Received[] = [];
  let postAnswer: Answer;
  let getAnswers: Answer[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctio-parse-"));
    docPath = join(dir, "contract.pdf");
    writeFileSync(docPath, new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]));
    fieldsPath = join(dir, "fields.json");
    writeFileSync(fieldsPath, JSON.stringify({ fields: [{ name: "total_value", type: "number" }] }));
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const entry: Received = {
          method: req.method,
          path: pathname,
          auth: req.headers.get("authorization"),
          userAgent: req.headers.get("user-agent"),
        };
        received.push(entry);
        if (req.method === "POST" && pathname === "/v1/extract") {
          const form = await req.formData();
          entry.fields = {};
          for (const key of ["fields", "schema_id", "wait"]) {
            const value = form.get(key);
            if (typeof value === "string") entry.fields[key] = value;
          }
          const file = form.get("file");
          if (file instanceof File) entry.file = { name: file.name, size: file.size };
          return Response.json(postAnswer.body, { status: postAnswer.status });
        }
        if (req.method === "GET" && pathname.startsWith("/v1/extractions/")) {
          const polls = received.filter((r) => r.method === "GET").length;
          const answer = getAnswers[Math.min(polls, getAnswers.length) - 1] ?? completed;
          return Response.json(answer.body, { status: answer.status });
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
    postAnswer = completed;
    getAnswers = [completed];
  });

  async function ctio(args: string[]) {
    const proc = Bun.spawn({
      cmd: [
        process.execPath, "run", "src/index.ts", "parse", ...args,
        "--base-url", `http://127.0.0.1:${server.port}/v1`,
        "--parse-token", "test-key",
        "--poll-interval", "100",
      ],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, CLAUDECODE: undefined, CT_PARSE_TOKEN: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  const calls = () => received.map((r) => `${r.method} ${r.path}`);

  test("a quick extraction comes back inline: sends the document, fields and wait, prints the data", async () => {
    const { exitCode, stdout, stderr } = await ctio([docPath, "--schema", fieldsPath]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
    expect(stderr).toContain("Extracted 3 page(s).");
    expect(calls()).toEqual(["POST /v1/extract"]);
    const post = received[0];
    expect(post?.auth).toBe("Bearer test-key");
    expect(post?.userAgent).toStartWith("ctio/");
    expect(post?.file).toEqual({ name: "contract.pdf", size: 8 });
    expect(post?.fields).toEqual({ fields: JSON.stringify([{ name: "total_value", type: "number" }]), wait: "30" });
  });

  test("a long extraction is polled until it completes", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing", message: "Extraction started." } };
    getAnswers = [processing(40), completed];
    const { exitCode, stdout, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
    expect(stderr).toContain(`Extraction ${ID} is processing, waiting for the result...`);
    expect(calls()).toEqual(["POST /v1/extract", `GET /v1/extractions/${ID}`, `GET /v1/extractions/${ID}`]);
  });

  test("a document already running is followed by its id (pending)", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "pending", message: "Already being extracted." } };
    const { exitCode, stdout } = await ctio([docPath]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
  });

  test("pretty output shows the progress and ends the line", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing" } };
    getAnswers = [processing(40), completed];
    const { exitCode, stderr } = await ctio([docPath, "--format", "pretty"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("processing 40%");
    expect(stderr).toContain("   \nExtracted 3 page(s).");
  });

  test("a failure inside the wait window exits non-zero with the API's reason", async () => {
    postAnswer = { status: 200, body: { success: true, id: ID, status: "failed", data: null, error: "The document is password protected." } };
    const { exitCode, stdout, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Extraction ${ID} failed: The document is password protected.`);
  });

  test("a failure found while polling exits non-zero with the API's reason", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing" } };
    getAnswers = [processing(10), { status: 200, body: { success: true, id: ID, status: "failed", progress: null, data: null, error: "No text found." } }];
    const { exitCode, stdout, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Extraction ${ID} failed: No text found.`);
  });

  test("gives up at --timeout, names the id and how to fetch it later", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing" } };
    getAnswers = [processing(5)];
    const { exitCode, stdout, stderr } = await ctio([docPath, "--timeout", "1"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Extraction ${ID} is still processing after 1s.`);
    expect(stderr).toContain(`ctio parse --id ${ID}`);
    expect(received[0]?.fields?.["wait"]).toBe("1");
  });

  test("--id fetches an earlier extraction without uploading anything", async () => {
    const { exitCode, stdout } = await ctio(["--id", ID]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
    expect(calls()).toEqual([`GET /v1/extractions/${ID}`]);
  });

  test("--id waits for an extraction that is still running", async () => {
    getAnswers = [processing(20), processing(70), completed];
    const { exitCode, stdout } = await ctio(["--id", ID]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
    expect(calls()).toHaveLength(3);
  });

  test("--id for an unknown extraction exits 4 with the API's message", async () => {
    getAnswers = [{ status: 404, body: { error: "Extraction not found", param: "id", value: ID } }];
    const { exitCode, stderr } = await ctio(["--id", ID]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain("Extraction not found");
  });

  test("a passing server error while polling is retried", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing" } };
    getAnswers = [{ status: 503, body: { error: "Service Unavailable" } }, completed];
    const { exitCode, stdout } = await ctio([docPath]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
  });

  test("repeated server errors while polling stop with the id to fetch it later", async () => {
    postAnswer = { status: 202, body: { success: true, id: ID, status: "processing" } };
    getAnswers = [{ status: 503, body: { error: "Service Unavailable" } }];
    const { exitCode, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain("Service Unavailable");
    expect(stderr).toContain(`ctio parse --id ${ID}`);
    expect(calls().filter((c) => c.startsWith("GET"))).toHaveLength(3);
  });

  test("a stored result is reported as such, not as new pages", async () => {
    postAnswer = { status: 200, body: { ...(completed.body as object), cached: true } };
    const { exitCode, stdout, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(DATA);
    expect(stderr).toContain("returning the stored result (no pages charged)");
    expect(stderr).not.toContain("Extracted 3 page(s).");
  });

  test("an expired result is an error, not null", async () => {
    getAnswers = [{ status: 200, body: { success: true, id: ID, status: "completed", data: null, data_expired: true } }];
    const { exitCode, stdout, stderr } = await ctio(["--id", ID]);
    expect(exitCode).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain("has expired");
  });

  test("-o writes the data to a file", async () => {
    const out = join(dir, "out.json");
    const { exitCode, stdout } = await ctio([docPath, "-o", out]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(DATA);
  });

  test("a rejected key exits 3 and names the key flags", async () => {
    postAnswer = { status: 401, body: { error: "Invalid API key" } };
    const { exitCode, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("Invalid API key");
    expect(stderr).toContain("--parse-token / CT_PARSE_TOKEN");
  });

  test("a plan limit shows the API's user-facing sentence", async () => {
    postAnswer = { status: 403, body: { error: "Page limit exceeded", code: "page_limit", message: "You have used all 30 pages this month." } };
    const { exitCode, stderr } = await ctio([docPath]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain("You have used all 30 pages this month.");
  });

  test("a missing --schema file is a usage error and nothing is uploaded", async () => {
    const { exitCode, stderr } = await ctio([docPath, "--schema", join(dir, "nope.json")]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Cannot read schema file");
    expect(received).toEqual([]);
  });

  test("without a document or --id nothing is sent", async () => {
    const { exitCode, stderr } = await ctio([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Missing the document to extract.");
    expect(received).toEqual([]);
  });

  test("an all-digit --id is refused before anything is sent", async () => {
    const { exitCode, stderr } = await ctio(["--id", "00000000000000000000000000000000"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("is not an extraction id");
    expect(received).toEqual([]);
  });
});
