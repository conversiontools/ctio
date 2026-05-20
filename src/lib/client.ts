import { ConversionToolsClient } from "conversiontools";

import { warn } from "./logger";
import { regionToBaseUrl, type Region } from "./region";

export interface ClientOptions {
  token: string;
  region: Region;
  baseUrlOverride?: string;
  insecure?: boolean;
}

export function createClient(opts: ClientOptions): ConversionToolsClient {
  const baseURL = opts.baseUrlOverride ?? regionToBaseUrl(opts.region);

  if (opts.baseUrlOverride) {
    warn(`Using custom base URL: ${opts.baseUrlOverride}`);
  }

  if (opts.insecure) {
    warn("TLS verification is disabled (--insecure). Do not use against production.");
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  }

  return new ConversionToolsClient({
    apiToken: opts.token,
    baseURL,
  });
}
