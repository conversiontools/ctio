import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/list";

const { filterConverters } = __testables;

function entry(over: Partial<{
  type: string;
  from: string | null;
  to: string | null;
  ai: boolean;
  custom: boolean;
}> = {}) {
  return {
    type: "convert.json_to_excel",
    url: "json-to-excel",
    from: "json",
    to: "excel",
    title: "JSON to Excel",
    description: "",
    options: [],
    ai: false,
    custom: false,
    batch: false,
    comingSoon: false,
    registrationRequired: false,
    groups: [],
    ...over,
  };
}

const sample = [
  entry({ type: "convert.json_to_excel", from: "json", to: "excel" }),
  entry({ type: "convert.xml_to_csv", from: "xml", to: "csv" }),
  entry({ type: "convert.json_to_xml", from: "json", to: "xml" }),
  entry({ type: "convert.ocr_pdf_to_text", from: "ocr_pdf", to: "text", ai: true }),
  entry({ type: "convert.ai_pdf_to_json", from: "ai_pdf", to: "json", ai: true }),
  entry({ type: "convert.sdimedia.export_xml_to_csv", from: "sdimedia.export_xml", to: "csv", custom: true }),
  entry({ type: "convert.format_json", from: null, to: null }),
];

describe("filterConverters", () => {
  test("no filters returns all", () => {
    expect(filterConverters(sample, {})).toHaveLength(7);
  });

  test("from filter", () => {
    const result = filterConverters(sample, { from: "json" });
    expect(result.map((c) => c.type)).toEqual([
      "convert.json_to_excel",
      "convert.json_to_xml",
    ]);
  });

  test("to filter", () => {
    const result = filterConverters(sample, { to: "csv" });
    expect(result.map((c) => c.type)).toEqual([
      "convert.xml_to_csv",
      "convert.sdimedia.export_xml_to_csv",
    ]);
  });

  test("from + to combined", () => {
    const result = filterConverters(sample, { from: "json", to: "excel" });
    expect(result.map((c) => c.type)).toEqual(["convert.json_to_excel"]);
  });

  test("ai filter (proper boolean flag, not prefix heuristic)", () => {
    const result = filterConverters(sample, { ai: true });
    expect(result.map((c) => c.type)).toEqual([
      "convert.ocr_pdf_to_text",
      "convert.ai_pdf_to_json",
    ]);
  });

  test("custom filter", () => {
    const result = filterConverters(sample, { custom: true });
    expect(result.map((c) => c.type)).toEqual([
      "convert.sdimedia.export_xml_to_csv",
    ]);
  });

  test("from is case-insensitive", () => {
    expect(filterConverters(sample, { from: "JSON" })).toHaveLength(2);
  });

  test("non-matching filter returns empty", () => {
    expect(filterConverters(sample, { from: "nonsense" })).toHaveLength(0);
  });
});
