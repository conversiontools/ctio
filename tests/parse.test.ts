import { afterEach, describe, expect, test } from "bun:test";

import { __testables } from "@/commands/parse";
import { resolveParseToken } from "@/lib/token";

const { loadFields } = __testables;

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
    expect(resolveParseToken({}).baseUrl).toBe("https://api.conversiontools.io/v1");
    expect(resolveParseToken({ baseUrlFlag: "http://localhost:6082/v1" }).baseUrl).toBe(
      "http://localhost:6082/v1",
    );
  });
});
