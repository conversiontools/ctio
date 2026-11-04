import { describe, expect, test } from "bun:test";

const HINT = '<claude-code-hint v="1" type="plugin" value="conversiontools@claude-plugins-official" />';

// Runs the real CLI. `describe` reads the bundled catalog, so no network or token.
function run(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/index.ts", ...args],
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, CLAUDECODE: undefined, ...env },
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("Claude Code plugin hint", () => {
  // Programs that run ctio and show its stderr as the failure reason showed the
  // hint tag instead of the error.
  test("a failing command prints only the error, no hint", () => {
    const { exitCode, stderr } = run(["describe", "no_such_converter"], { CLAUDECODE: "1" });
    expect(exitCode).not.toBe(0);
    expect(stderr.split("\n")[0]).toStartWith("error: ");
    expect(stderr).not.toContain("claude-code-hint");
  });

  test("a successful command ends stderr with the hint, on its own line", () => {
    const { exitCode, stderr } = run(["describe", "ai_text_to_mp3"], { CLAUDECODE: "1" });
    expect(exitCode).toBe(0);
    expect(stderr.trimEnd().split("\n").at(-1)).toBe(HINT);
  });

  test("outside Claude Code there is no hint", () => {
    const { exitCode, stderr } = run(["describe", "ai_text_to_mp3"], {});
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("claude-code-hint");
  });
});
