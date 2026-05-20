export type Region = "auto" | "us" | "eu" | "ap";

const REGIONS: readonly Region[] = ["auto", "us", "eu", "ap"] as const;

const REGION_HOSTS: Record<Exclude<Region, "auto">, string> = {
  us: "https://us.api.conversiontools.io/v1",
  eu: "https://eu.api.conversiontools.io/v1",
  ap: "https://ap.api.conversiontools.io/v1",
};

const GEO_BASE_URL = "https://api.conversiontools.io/v1";

export function isRegion(v: string): v is Region {
  return (REGIONS as readonly string[]).includes(v);
}

export function regionToBaseUrl(region: Region): string {
  if (region === "auto") return GEO_BASE_URL;
  return REGION_HOSTS[region];
}

export function listRegions(): readonly Region[] {
  return REGIONS;
}
