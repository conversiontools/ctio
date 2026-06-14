import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/describe";
import { CONVERTERS, findConverter, normalizeType } from "@/lib/converters";

const { buildExample } = __testables;

describe("normalizeType", () => {
  test("adds the convert. prefix when missing", () => {
    expect(normalizeType("xml_to_csv")).toBe("convert.xml_to_csv");
  });
  test("leaves a full type unchanged", () => {
    expect(normalizeType("convert.xml_to_csv")).toBe("convert.xml_to_csv");
  });
});

describe("findConverter", () => {
  test("accepts the short type form", () => {
    expect(findConverter("xml_to_csv")?.type).toBe("convert.xml_to_csv");
  });
  test("accepts the full type form", () => {
    expect(findConverter("convert.xml_to_csv")?.type).toBe("convert.xml_to_csv");
  });
  test("returns undefined for an unknown type", () => {
    expect(findConverter("nope_to_nope")).toBeUndefined();
  });
});

describe("bundled option metadata", () => {
  test("xml_to_csv exposes the delimiter enum values (the whole point of this feature)", () => {
    const delimiter = findConverter("xml_to_csv")?.optionSpecs?.find((o) => o.name === "delimiter");
    expect(delimiter?.values).toEqual(["comma", "semicolon", "vertical_bar", "tabulation"]);
  });
  test("boolean options carry their default", () => {
    const quote = findConverter("xml_to_csv")?.optionSpecs?.find((o) => o.name === "quote");
    expect(quote?.type).toBe("boolean");
    expect(quote?.default).toBe(true);
  });
  test("a meaningful share of converters carry optionSpecs", () => {
    const withSpecs = CONVERTERS.filter((c) => (c.optionSpecs?.length ?? 0) > 0);
    expect(withSpecs.length).toBeGreaterThan(10);
  });
});

describe("buildExample", () => {
  test("shows the --option syntax with a real enum value", () => {
    const c = findConverter("xml_to_csv")!;
    const ex = buildExample(c, c.optionSpecs ?? []);
    expect(ex).toContain("ctio convert -t xml_to_csv input.xml out.csv");
    expect(ex).toContain("--option delimiter=comma");
  });
  test("omits --option when the converter has no enum option", () => {
    const fake = { type: "convert.a_to_b", from: "a", to: "b" } as never;
    expect(buildExample(fake, [])).toBe("ctio convert -t a_to_b input.a out.b");
  });
});
