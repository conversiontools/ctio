let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function isVerbose(): boolean {
  return verbose;
}

export function maskToken(token: string | undefined | null): string {
  if (!token) return "(none)";
  if (token.length <= 4) return "***";
  return `${token.slice(0, 4)}***`;
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

export function debug(message: string): void {
  if (!verbose) return;
  process.stderr.write(`[debug] ${message}\n`);
}
