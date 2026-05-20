import type { CAC } from "cac";

export function registerList(cli: CAC): void {
  cli.command("list", "List available converters").action(() => {
    process.stderr.write("ctio list: not yet implemented (Phase 1 in progress)\n");
    process.exit(1);
  });
}
