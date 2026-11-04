import { describe, expect, test } from "bun:test";

import { __testables } from "@/commands/voices";

const { renderTable } = __testables;

describe("voices table", () => {
  const table = renderTable([
    { id: "default", name: "Default (Oliver - Excited, English UK)", type: "builtin", language: "en" },
    { id: "voice_3133", name: "Haruto (Japanese)", type: "builtin", language: "ja" },
    { id: "01a0de0f-045e-73e9-acd2-2510425cdd6d", name: "Narrator", type: "clone", created: "2026-09-26T14:12:01.000Z" },
  ]);
  const lines = table.trimEnd().split("\n");

  test("has an ID / NAME / LANGUAGE / TYPE header", () => {
    expect(lines[0]).toMatch(/^ID\s+NAME\s+LANGUAGE\s+TYPE$/);
  });

  test("shows the language_tts code of each built-in voice", () => {
    expect(lines.find((l) => l.startsWith("voice_3133"))).toMatch(/^voice_3133\s+Haruto \(Japanese\)\s+ja\s+builtin$/);
  });

  test("lists clones first, with their full id", () => {
    expect(lines[1]).toMatch(/^01a0de0f-045e-73e9-acd2-2510425cdd6d\s+Narrator\s+-\s+clone$/);
    expect(lines.slice(2).every((l) => l.endsWith("builtin"))).toBe(true);
  });

  test("aligns the columns", () => {
    const nameColumn = lines.map((l) => l.indexOf(l.trim().split(/\s{2,}/)[1] ?? ""));
    expect(new Set(nameColumn).size).toBe(1);
  });
});
