import type { CAC } from "cac";

export function registerTask(cli: CAC): void {
  cli.command("task <id>", "Inspect a task by ID").action(() => {
    process.stderr.write("ctio task: not yet implemented (Phase 1 in progress)\n");
    process.exit(1);
  });
}
