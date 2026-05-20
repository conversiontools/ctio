import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/convert";

const { normalizeType, parseOptionFlags, coerceValue, resolvePollInterval } = __testables;

describe("normalizeType", () => {
  test("prepends `convert.` when missing", () => {
    expect(normalizeType("json_to_excel")).toBe("convert.json_to_excel");
  });
  test("keeps prefix when already present", () => {
    expect(normalizeType("convert.json_to_excel")).toBe("convert.json_to_excel");
  });
});

describe("coerceValue", () => {
  test("booleans", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
  });
  test("integers and floats", () => {
    expect(coerceValue("42")).toBe(42);
    expect(coerceValue("-7")).toBe(-7);
    expect(coerceValue("3.14")).toBe(3.14);
  });
  test("strings pass through, including yes/no", () => {
    expect(coerceValue("yes")).toBe("yes");
    expect(coerceValue("no")).toBe("no");
    expect(coerceValue("comma")).toBe("comma");
    expect(coerceValue("")).toBe("");
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

describe("parseOptionFlags", () => {
  test("undefined returns empty object", () => {
    expect(parseOptionFlags(undefined)).toEqual({});
  });
  test("single string entry", () => {
    expect(parseOptionFlags("header=yes")).toEqual({ header: "yes" });
  });
  test("array of entries with coercion", () => {
    expect(
      parseOptionFlags(["header=yes", "count=12", "enabled=true", "scale=1.5"]),
    ).toEqual({
      header: "yes",
      count: 12,
      enabled: true,
      scale: 1.5,
    });
  });
  test("throws on malformed entry", () => {
    expect(() => parseOptionFlags(["nokey"])).toThrow();
    expect(() => parseOptionFlags(["=value"])).toThrow();
  });
});
