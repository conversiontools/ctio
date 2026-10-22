import converterData from "@/data/conversions.json" with { type: "json" };

/**
 * A single converter option, with its allowed values and default. This is what
 * lets `ctio describe` and `ctio list --detail` show, e.g.,
 * `delimiter: comma | semicolon | vertical_bar | tabulation` instead of just the
 * option name - so an agent never has to guess a value.
 */
export interface OptionSpec {
  name: string;
  title?: string;
  type?: string;
  default?: string | number | boolean;
  /** What the option accepts beyond `values` (e.g. voice_tts also takes your cloned voices' ids). */
  description?: string;
  values?: string[];
}

/**
 * One file a multi-file converter needs, in order: the first is the positional
 * input, the rest are passed with `--file` (e.g. the XML/XSD validator's
 * `file_id1` "XSD schema").
 */
export interface FileInputSpec {
  key: string;
  description: string;
}

export interface ConverterEntry {
  type: string;
  url: string;
  from: string | null;
  to: string | null;
  title: string;
  description: string;
  options: string[];
  optionSpecs?: OptionSpec[];
  /** Only on converters that take more than one file. */
  fileInputs?: FileInputSpec[];
  /** Other ids the API accepts for this converter (convert.ai_text_to_speech). */
  typeAliases?: string[];
  /** Input format synonyms beyond `from` (txt for text). */
  inputAliases?: string[];
  /** Output format synonyms beyond `to`, incl. formats an option selects (wav for text to speech). */
  outputAliases?: string[];
  ai: boolean;
  custom: boolean;
  batch: boolean;
  comingSoon: boolean;
  registrationRequired: boolean;
  groups: string[];
}

export const CONVERTERS: readonly ConverterEntry[] = (
  converterData as { converters: ConverterEntry[] }
).converters;

/** Normalize a type: accept both "xml_to_csv" and "convert.xml_to_csv". */
export function normalizeType(type: string): string {
  const t = type.trim();
  return t.startsWith("convert.") ? t : `convert.${t}`;
}

/** Find a converter by type or alias, accepting the short form (without the convert. prefix). */
export function findConverter(type: string): ConverterEntry | undefined {
  const full = normalizeType(type);
  return CONVERTERS.find((c) => c.type === full || (c.typeAliases ?? []).includes(full));
}
