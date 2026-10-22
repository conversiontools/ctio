import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/voices";

const { renderTable } = __testables;

describe("voices table", () => {
  const table = renderTable([
    { id: "default", name: "Default (Oliver - Excited, EN)", type: "builtin" },
    { id: "en_paul_neutral", name: "Paul - Neutral (EN)", type: "builtin" },
    { id: "01a0de0f-045e-73e9-acd2-2510425cdd6d", name: "Narrator", type: "clone", created: "2026-09-26T14:12:01.000Z" },
  ]);
  const lines = table.trimEnd().split("\n");

  test("has an ID / NAME / TYPE header", () => {
    expect(lines[0]).toMatch(/^ID\s+NAME\s+TYPE$/);
  });

  test("lists clones first, with their full id", () => {
    expect(lines[1]).toMatch(/^01a0de0f-045e-73e9-acd2-2510425cdd6d\s+Narrator\s+clone$/);
    expect(lines.slice(2).every((l) => l.endsWith("builtin"))).toBe(true);
  });

  test("aligns the columns", () => {
    const nameColumn = lines.map((l) => l.indexOf(l.trim().split(/\s{2,}/)[1] ?? ""));
    expect(new Set(nameColumn).size).toBe(1);
  });
});
