import { AuthMissingError, UsageError } from "./errors";
import { getActiveProfile, getProfile, loadProfiles, type Profile } from "./profile";
import { isRegion, type Region } from "./region";

export interface ResolveOptions {
  tokenFlag?: string | undefined;
  profileFlag?: string | undefined;
  regionFlag?: string | undefined;
  baseUrlFlag?: string | undefined;
}

export interface ResolvedAuth {
  token: string;
  region: Region;
  baseUrlOverride?: string;
  source: "flag" | "env" | "profile";
  profileName?: string;
}

export async function resolveAuth(opts: ResolveOptions): Promise<ResolvedAuth> {
  const baseUrlOverride = opts.baseUrlFlag;

  const regionFromFlag = opts.regionFlag;
  if (regionFromFlag !== undefined && !isRegion(regionFromFlag)) {
    throw new UsageError(
      `Invalid --region "${regionFromFlag}".`,
      "Use one of: auto, us, eu, ap.",
    );
  }

  if (opts.tokenFlag) {
    return finalize({
      token: opts.tokenFlag,
      profileRegion: undefined,
      regionFlag: regionFromFlag as Region | undefined,
      baseUrlOverride,
      source: "flag",
    });
  }

  const envToken = process.env["CT_API_TOKEN"];
  if (envToken) {
    return finalize({
      token: envToken,
      profileRegion: undefined,
      regionFlag: regionFromFlag as Region | undefined,
      baseUrlOverride,
      source: "env",
    });
  }

  const file = await loadProfiles();
  const profileName =
    opts.profileFlag ?? process.env["CT_PROFILE"] ?? file.active;

  const profile: Profile | undefined =
    opts.profileFlag ?? process.env["CT_PROFILE"]
      ? getProfile(file, profileName)
      : getActiveProfile(file);

  if (!profile) {
    if (Object.keys(file.profiles).length === 0) {
      throw new AuthMissingError();
    }
    throw new UsageError(
      `Profile "${profileName}" not found.`,
      `Available profiles: ${Object.keys(file.profiles).join(", ")}.`,
    );
  }

  return finalize({
    token: profile.token,
    profileRegion: profile.region,
    regionFlag: regionFromFlag as Region | undefined,
    baseUrlOverride,
    source: "profile",
    profileName,
  });
}

function finalize(args: {
  token: string;
  profileRegion: Region | undefined;
  regionFlag: Region | undefined;
  baseUrlOverride: string | undefined;
  source: ResolvedAuth["source"];
  profileName?: string;
}): ResolvedAuth {
  const region: Region = args.regionFlag ?? args.profileRegion ?? "auto";
  return {
    token: args.token,
    region,
    ...(args.baseUrlOverride ? { baseUrlOverride: args.baseUrlOverride } : {}),
    source: args.source,
    ...(args.profileName ? { profileName: args.profileName } : {}),
  };
}

export interface ResolvedParseAuth {
  parseToken: string;
  baseUrl: string;
  source: "flag" | "env";
}

// The Parse API is served from its own host.
const PARSE_BASE_URL = "https://api-parse.conversiontools.io/v1";

/**
 * Resolve the Parse API key. Parse uses its own API keys, created at
 * https://parse.conversiontools.io. Precedence: --parse-token flag >
 * CT_PARSE_TOKEN env. The base URL is the Parse host unless --base-url overrides.
 */
export function resolveParseToken(opts: {
  parseTokenFlag?: string | undefined;
  baseUrlFlag?: string | undefined;
}): ResolvedParseAuth {
  const baseUrl = opts.baseUrlFlag ?? PARSE_BASE_URL;

  if (opts.parseTokenFlag) {
    return { parseToken: opts.parseTokenFlag, baseUrl, source: "flag" };
  }
  const env = process.env["CT_PARSE_TOKEN"];
  if (env) {
    return { parseToken: env, baseUrl, source: "env" };
  }
  throw new UsageError(
    "No Parse API key found.",
    "Pass --parse-token <key> or set CT_PARSE_TOKEN. Create a key at https://parse.conversiontools.io.",
  );
}
