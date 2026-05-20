import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/convert";

const { normalizeType, parseOptionFlags, coerceValue } = __testables;

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
