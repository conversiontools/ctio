import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/convert";

const {
  normalizeType,
  parseOptionFlags,
  coerceValue,
  resolvePollInterval,
  pickUploadInput,
  resolvePositionals,
  buildTaskOptions,
  unknownOptionKeys,
} = __testables;

describe("normalizeType", () => {
  test("prepends `convert.` when missing", () => {
    expect(normalizeType("json_to_excel")).toBe("convert.json_to_excel");
  });
  test("keeps prefix when already present", () => {
    expect(normalizeType("convert.json_to_excel")).toBe("convert.json_to_excel");
  });
});

describe("coerceValue", () => {
  test("booleans stay real booleans (the API accepts true/false, not \"true\")", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
  });
  // Numeric-looking values MUST stay strings: several options are string enums
  // of digits, and a JSON number never matches, so the API silently replaced
  // the value with that option's default (--option version=1 ran as version 2).
  test("digits stay strings", () => {
    expect(coerceValue("1")).toBe("1");
    expect(coerceValue("42")).toBe("42");
    expect(coerceValue("-7")).toBe("-7");
    expect(coerceValue("3.14")).toBe("3.14");
  });
  test("strings pass through, including yes/no", () => {
    expect(coerceValue("yes")).toBe("yes");
    expect(coerceValue("no")).toBe("no");
    expect(coerceValue("comma")).toBe("comma");
    expect(coerceValue("")).toBe("");
  });
});

// Regression pin for the silent-wrong-engine bug: assert the OUTGOING PAYLOAD,
// not the exit code - the exit code was SUCCESS the whole time the bug existed.
describe("outgoing payload (buildTaskOptions)", () => {
  test('--option version=1 sends version: "1" (string), not 1', () => {
    const payload = buildTaskOptions({
      fileId: "abc123",
      options: parseOptionFlags(["version=1"]),
    });
    expect(payload["version"]).toBe("1");
    expect(payload["version"]).not.toBe(1);
    expect(payload).toEqual({ file_id: "abc123", version: "1" });
  });

  test("multi-flag invocation keeps both values (the case that already worked)", () => {
    const payload = buildTaskOptions({
      fileId: "abc123",
      options: parseOptionFlags(["version=1", "password=secret123"]),
    });
    expect(payload).toEqual({ file_id: "abc123", version: "1", password: "secret123" });
  });

  test("other digit-valued string enums keep their exact value", () => {
    const payload = buildTaskOptions({
      fileId: "f",
      options: parseOptionFlags(["bitrate=128", "sampling_rate=44100", "audio_channels=2", "bit_depth=24", "image_resolution=300"]),
    });
    expect(payload).toEqual({
      file_id: "f",
      bitrate: "128",
      sampling_rate: "44100",
      audio_channels: "2",
      bit_depth: "24",
      image_resolution: "300",
    });
  });

  test("user options win over anything else in the payload", () => {
    const payload = buildTaskOptions({
      fileId: "abc123",
      options: parseOptionFlags(["file_id=user-wins"]),
    });
    expect(payload["file_id"]).toBe("user-wins");
  });

  test("url input carries through", () => {
    expect(buildTaskOptions({ url: "https://example.com", options: {} })).toEqual({
      url: "https://example.com",
    });
  });
});

describe("unknownOptionKeys", () => {
  test("flags a key the converter does not list", () => {
    expect(unknownOptionKeys("convert.pdf_to_excel", ["versoin"])).toEqual(["versoin"]);
  });
  test("accepts a known key", () => {
    expect(unknownOptionKeys("convert.pdf_to_excel", ["version"])).toEqual([]);
  });
  test("never flags sandbox (a ctio-level flag, not a catalog option)", () => {
    expect(unknownOptionKeys("convert.pdf_to_excel", ["sandbox"])).toEqual([]);
  });
  test("stays silent for an unknown converter (catalog is advisory, not authority)", () => {
    expect(unknownOptionKeys("convert.not_a_real_converter", ["anything"])).toEqual([]);
  });
});

describe("resolvePollInterval", () => {
  test("undefined returns default 500", () => {
    expect(resolvePollInterval(undefined)).toBe(500);
  });
  test("accepts numeric string", () => {
    expect(resolvePollInterval("1000")).toBe(1000);
  });
  test("accepts number", () => {
    expect(resolvePollInterval(2500)).toBe(2500);
  });
  test("accepts the minimum (100ms)", () => {
    expect(resolvePollInterval(100)).toBe(100);
  });
  test("rejects below minimum", () => {
    expect(() => resolvePollInterval(99)).toThrow(/Invalid --poll-interval/);
    expect(() => resolvePollInterval(50)).toThrow();
    expect(() => resolvePollInterval(0)).toThrow();
  });
  test("rejects non-numeric input", () => {
    expect(() => resolvePollInterval("fast")).toThrow(/Invalid --poll-interval/);
  });
});

describe("pickUploadInput", () => {
  test("file source with a path returns path choice (so SDK can extract basename)", () => {
    expect(pickUploadInput({ kind: "file", path: "/tmp/some_real_input.xlsx" })).toEqual({
      kind: "path",
      path: "/tmp/some_real_input.xlsx",
    });
  });

  test("file source with path on Windows-style path", () => {
    expect(pickUploadInput({ kind: "file", path: "C:/repo/ct/sample.json" })).toEqual({
      kind: "path",
      path: "C:/repo/ct/sample.json",
    });
  });

  test("stdin source returns stream choice", () => {
    expect(pickUploadInput({ kind: "stdin" })).toEqual({ kind: "stream" });
  });

  test("defensive: file source without a path falls back to stream choice", () => {
    expect(pickUploadInput({ kind: "file" })).toEqual({ kind: "stream" });
  });

  test("defensive: file source with empty string path falls back to stream choice", () => {
    expect(pickUploadInput({ kind: "file", path: "" })).toEqual({ kind: "stream" });
  });
});

describe("parseOptionFlags", () => {
  test("undefined returns empty object", () => {
    expect(parseOptionFlags(undefined)).toEqual({});
  });
  test("single string entry", () => {
    expect(parseOptionFlags("header=yes")).toEqual({ header: "yes" });
  });
  // Numbers stay strings (only booleans are coerced) - see coerceValue: a JSON
  // number never matches the API's string enums and was silently replaced by
  // the option's default.
  test("array of entries: digits stay strings, booleans become booleans", () => {
    expect(
      parseOptionFlags(["header=yes", "count=12", "enabled=true", "scale=1.5"]),
    ).toEqual({
      header: "yes",
      count: "12",
      enabled: true,
      scale: "1.5",
    });
  });
  test("throws on malformed entry", () => {
    expect(() => parseOptionFlags(["nokey"])).toThrow();
    expect(() => parseOptionFlags(["=value"])).toThrow();
  });
});

describe("resolvePositionals", () => {
  // The bug: `ctio convert -t xml_to_excel out.xlsx --url <URL>` bound out.xlsx
  // to input, leaving no output. With --url set, a lone positional is the output.
  test("--url + single positional -> positional becomes output", () => {
    expect(resolvePositionals("out.xlsx", undefined, true)).toEqual({
      input: undefined,
      output: "out.xlsx",
    });
  });

  test("--url + single positional '-' -> stdout output", () => {
    expect(resolvePositionals("-", undefined, true)).toEqual({
      input: undefined,
      output: "-",
    });
  });

  test("--url + no positionals -> unchanged (runConvert reports missing output)", () => {
    expect(resolvePositionals(undefined, undefined, true)).toEqual({
      input: undefined,
      output: undefined,
    });
  });

  test("--url + two positionals -> unchanged (runConvert rejects input + url together)", () => {
    expect(resolvePositionals("in.xml", "out.xlsx", true)).toEqual({
      input: "in.xml",
      output: "out.xlsx",
    });
  });

  test("no --url + single positional -> unchanged (stays as input)", () => {
    expect(resolvePositionals("data.json", undefined, false)).toEqual({
      input: "data.json",
      output: undefined,
    });
  });

  test("no --url + two positionals -> unchanged (normal file->file)", () => {
    expect(resolvePositionals("data.json", "out.xlsx", false)).toEqual({
      input: "data.json",
      output: "out.xlsx",
    });
  });
});
