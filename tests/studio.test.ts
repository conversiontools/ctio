import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/studio";

const { planStudio, unswapStdio } = __testables;

describe("planStudio: run", () => {
  test("converter_id + file + output", () => {
    expect(planStudio("run", "cid", "in.csv", "out.json")).toEqual({
      action: "run",
      converterId: "cid",
      file: "in.csv",
      output: "out.json",
    });
  });

  test("output is optional", () => {
    expect(planStudio("run", "cid", "in.csv", undefined)).toEqual({
      action: "run",
      converterId: "cid",
      file: "in.csv",
    });
  });

  test("throws when converter_id is missing", () => {
    expect(() => planStudio("run", undefined, undefined, undefined)).toThrow(/Missing <converter_id>/);
  });

  test("throws when file is missing", () => {
    expect(() => planStudio("run", "cid", undefined, undefined)).toThrow(/Missing <file>/);
  });
});

describe("planStudio: download", () => {
  test("converter_id + output", () => {
    expect(planStudio("download", "cid", "out.json", undefined)).toEqual({
      action: "download",
      converterId: "cid",
      output: "out.json",
    });
  });

  test("output is optional (SDK derives a name)", () => {
    expect(planStudio("download", "cid", undefined, undefined)).toEqual({
      action: "download",
      converterId: "cid",
    });
  });

  test("stdout output is carried through", () => {
    expect(planStudio("download", "cid", "-", undefined)).toEqual({
      action: "download",
      converterId: "cid",
      output: "-",
    });
  });

  test("throws when converter_id is missing", () => {
    expect(() => planStudio("download", undefined, undefined, undefined)).toThrow(/Missing <converter_id>/);
  });
});

describe("planStudio: list", () => {
  test("no search term", () => {
    expect(planStudio("list", undefined, undefined, undefined)).toEqual({ action: "list" });
  });

  test("optional search term", () => {
    expect(planStudio("list", "invoice", undefined, undefined)).toEqual({ action: "list", search: "invoice" });
  });
});

describe("planStudio: invalid", () => {
  test("unknown action throws", () => {
    expect(() => planStudio("frobnicate", "x", undefined, undefined)).toThrow(/Unknown studio action/);
  });

  test("missing action throws", () => {
    expect(() => planStudio(undefined, undefined, undefined, undefined)).toThrow(/Missing studio action/);
  });
});

describe("unswapStdio", () => {
  test("maps the stdio sentinel back to '-'", () => {
    expect(unswapStdio("__ctio_stdio__")).toBe("-");
  });
  test("passes other values through unchanged", () => {
    expect(unswapStdio("out.json")).toBe("out.json");
    expect(unswapStdio(undefined)).toBeUndefined();
  });
});
