export type OutputFormat = "json" | "pretty" | "ndjson";

const FORMATS: readonly OutputFormat[] = ["json", "pretty", "ndjson"] as const;

export function isOutputFormat(v: string): v is OutputFormat {
  return (FORMATS as readonly string[]).includes(v);
}

export function emit(value: unknown, format: OutputFormat): void {
  if (format === "ndjson") {
    if (Array.isArray(value)) {
      for (const item of value) {
        process.stdout.write(`${JSON.stringify(item)}\n`);
      }
      return;
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
