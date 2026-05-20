import type { CAC } from "cac";

import { resolveAuth } from "@/lib/token";
import { regionToBaseUrl } from "@/lib/region";

export function registerVersion(cli: CAC, version: string): void {
  cli.command("version", "Print version and resolved API endpoint").action(async (opts: Record<string, unknown>) => {
    let endpoint: string;
    try {
      const auth = await resolveAuth({
        tokenFlag: typeof opts["token"] === "string" ? opts["token"] : undefined,
        profileFlag: typeof opts["profile"] === "string" ? opts["profile"] : undefined,
        regionFlag: typeof opts["region"] === "string" ? opts["region"] : undefined,
        baseUrlFlag: typeof opts["baseUrl"] === "string" ? opts["baseUrl"] : undefined,
      });
      endpoint = auth.baseUrlOverride ?? regionToBaseUrl(auth.region);
    } catch {
      endpoint = regionToBaseUrl("auto");
    }
    process.stdout.write(`ctio ${version}\nendpoint: ${endpoint}\n`);
  });
}
