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
  test("finds a converter by one of its aliases", () => {
    expect(findConverter("ai_text_to_speech")?.type).toBe("convert.ai_text_to_mp3");
    expect(findConverter("convert.ai_pdf_to_speech")?.type).toBe("convert.ai_pdf_to_mp3");
  });
});

describe("text-to-speech option metadata", () => {
  const specs = findConverter("ai_text_to_mp3")?.optionSpecs ?? [];
  const spec = (name: string) => specs.find((o) => o.name === name);

  test("lists the voices, formats and languages", () => {
    expect(spec("voice_tts")?.values).toEqual(expect.arrayContaining(["default", "gb_oliver_neutral", "en_paul_neutral", "gb_jane_neutral", "fr_marie_neutral"]));
    expect(spec("output_tts")?.values).toEqual(["mp3", "wav"]);
    expect(spec("language_tts")?.values).toContain("fr");
  });

  test("says voice_tts also takes your cloned voices' ids", () => {
    expect(spec("voice_tts")?.description).toContain("cloned voices");
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

describe("multi-file converters", () => {
  test("the validator lists both of its files, in order", () => {
    expect(findConverter("validate_xml_xsd")?.fileInputs).toEqual([
      { key: "file_id", description: "XML file" },
      { key: "file_id1", description: "XSD schema" },
    ]);
  });

  test("single-file converters carry no fileInputs", () => {
    expect(findConverter("xml_to_csv")?.fileInputs).toBeUndefined();
  });

  test("the example passes the second file with --file", () => {
    const validator = findConverter("validate_xml_xsd");
    expect(validator && buildExample(validator, [])).toBe(
      "ctio convert -t validate_xml_xsd <xml-file> <output> --file <xsd-schema>",
    );
  });
});
