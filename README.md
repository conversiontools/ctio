# ctio

Composable CLI for the [Conversion Tools](https://conversiontools.io) API.

Single-binary client. Pipe-friendly. Multi-region. MIT licensed.

```bash
# Convert a file
ctio convert -t json_to_excel data.json out.xlsx

# Pipe through stdin/stdout
cat data.json | ctio convert -t json_to_excel - - > out.xlsx

# Converters that take more than one file get the rest with --file
ctio convert -t validate_xml_xsd data.xml report.txt --file schema.xsd

# Compose
ctio parse invoice.pdf --schema fields.json \
  | jq '.line_items' \
  | ctio convert -t json_to_excel - out.xlsx
```

## Install

**Windows** ([scoop](https://scoop.sh)):

```powershell
scoop bucket add conversiontools https://github.com/conversiontools/scoop-bucket
scoop install ctio
```

**macOS and Linux** ([Homebrew](https://brew.sh)):

```bash
brew install conversiontools/tap/ctio
```

**Any platform, direct download:** grab the binary for your platform from
[GitHub Releases](https://github.com/conversiontools/ctio/releases/latest)
(`ctio-darwin-arm64`, `ctio-darwin-x64`, `ctio-linux-x64`, `ctio-windows-x64.exe`),
rename it to `ctio` (`ctio.exe` on Windows) and put it on your `PATH`:

```bash
chmod +x ctio
# macOS only: the binaries are not notarized, so clear the download quarantine once
xattr -d com.apple.quarantine ctio
```

**From source** (needs [Bun](https://bun.sh)):

```bash
git clone https://github.com/conversiontools/ctio.git
cd ctio
bun install
bun run dev -- convert -t json_to_excel data.json out.xlsx
```

## Auth

Get your API token at <https://conversiontools.io/profile> → "API tokens".

```bash
ctio auth login        # paste token, validates against the API
ctio auth status       # shows active profile + masked token
```

Token resolution order: `--token` flag > `CT_API_TOKEN` env > `--profile <name>` > active profile.

## Converters and options

```bash
ctio list --from pdf                 # what converts from PDF
ctio list --to wav --format pretty   # what produces WAV
ctio describe xml_to_csv --format pretty   # options, allowed values, defaults
```

## Extract data from documents

Pull structured data out of a PDF, scan or photo with [Parse](https://parse.conversiontools.io).
Parse uses its own API key: create one at parse.conversiontools.io and pass it as
`CT_PARSE_TOKEN` (or `--parse-token`).

```bash
ctio parse invoice.pdf                                   # schema-less: Parse picks the fields
ctio parse contract.pdf --schema fields.json -o out.json # just the fields you list
ctio parse --id <extraction_id>                          # fetch an earlier extraction
```

- **Fields.** `fields.json` is a JSON array of fields, or an object with a `fields` array (the
  shape Parse exports), e.g. `[{"name": "total", "type": "number"}, {"name": "due_date", "type": "date"}]`.
  `--schema-id` uses a schema saved in Parse instead.
- **Waiting.** ctio waits until the extraction finishes and prints the data. A long document
  can take a few minutes; `--format pretty` shows the progress. `--timeout <sec>` caps the wait
  (default 1800, `0` = no cap). If it runs out, ctio prints the extraction id, and
  `ctio parse --id <id>` picks it up later.
- **Failures.** A failed extraction exits non-zero with the reason. ctio never prints `null`
  for a result it did not get.
- **Repeats.** The same document with the same fields returns the stored result, and no
  pages are charged.

## Text to speech

Narrate a text, Markdown, Word or PDF file:

```bash
ctio convert -t ai_text_to_mp3 script.txt narration.mp3 --option voice_tts=en_paul_neutral
ctio convert -t ai_pdf_to_mp3 handbook.pdf handbook.wav --option voice_tts=gb_jane_neutral
```

- **Voices.** `ctio voice --format pretty` (or `ctio voices`) lists the 66 built-in voices in 21 languages
  (`voice_478` Sheila, `en_paul_neutral`, `gb_jane_neutral`, `fr_marie_neutral`, `voice_3133`
  Haruto, ...) and the voices you cloned (see [Clone your voice](#clone-your-voice)). A cloned
  voice works from the account that cloned it. An unknown voice is an error, never a silent
  fallback.
- **Language.** Each built-in voice lists the `language_tts` code it speaks (`ja` for
  Haruto). Set `--option language_tts=<code>` to the language your text is written in, and
  pick a voice that speaks it. `ctio describe ai_text_to_mp3` lists all 38 codes.
- **Format.** MP3 or WAV, taken from the output file name (`narration.wav`), or set with
  `--option output_tts=wav`. Writing to stdout (`-`) gives MP3 unless `output_tts`
  says otherwise.
- **Names.** `ai_text_to_speech`, `ai_docx_to_speech`, `ai_pdf_to_speech` and
  `ai_md_to_speech` work as converter names too.

- **Sound.** The audio comes out at spoken-word loudness (about -16 LUFS), 24 kHz mono in both
  formats, so it can go straight into a video. MP3s report their true duration.

Text to speech uses AI credits (10 per 1,000 characters).

## Clone your voice

Record about 10 seconds of clear speech (one speaker, a quiet room), then clone it and narrate
in it:

```bash
ctio voice clone my-voice.wav --name "My narrator" --tone calm \
  --consent "I confirm this is my own voice, or I have the speaker's explicit permission to clone it."
ctio convert -t ai_text_to_mp3 script.txt narration.mp3 --option voice_tts=<voice_id>
ctio voice delete <voice_id> --yes
```

- **Consent.** `--consent` takes the consent statement word for word (`ctio voice` prints it
  as `consent_statement`). Without it ctio stops before the sample leaves your machine. Clone
  only your own voice, or a voice whose speaker gave you explicit permission.
- **Sample.** MP3, WAV, M4A, FLAC, OGG or WebM. 3 seconds minimum, about 10 seconds works
  best. Up to 512 KB on the free Voice plan, 2 MB on paid plans.
- **Tone.** A label for the sample's mood: `normal`, `excited`, `cheerful`, `confident`,
  `curious`, `calm`, `sad`, `angry` or `frustrated`. The clone copies the mood and pace of the
  recording itself, so record in the mood you want to hear.
- **Slots.** 1 cloned voice on the free Voice plan, 5 on Starter, 20 on Pro. Deleting a voice
  frees its slot.
- Voices cloned with ctio show up on the [voice.conversiontools.io](https://voice.conversiontools.io)
  dashboard, and voices cloned there show up in `ctio voice`. You can also record a sample
  right in the dashboard.

## License

MIT
