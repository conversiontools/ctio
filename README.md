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
ctio parse invoice.pdf --schema purchase-invoice \
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

## Text to speech

Narrate a text, Markdown, Word or PDF file:

```bash
ctio convert -t ai_text_to_mp3 script.txt narration.mp3 --option voice_tts=en_paul_neutral
ctio convert -t ai_pdf_to_mp3 handbook.pdf handbook.wav --option voice_tts=gb_jane_neutral
```

- **Voices.** `ctio voices --format pretty` lists the built-in voices (`gb_oliver_neutral`,
  `en_paul_neutral`, `gb_jane_neutral`, `fr_marie_neutral`, and other speaking styles of
  each) and the voices you cloned. A cloned voice's ID is shown next to it on the
  [voice.conversiontools.io](https://voice.conversiontools.io) dashboard; it works from
  the account that cloned it. An unknown voice is an error, never a silent fallback.
- **Format.** MP3 or WAV, taken from the output file name (`narration.wav`), or set with
  `--option output_tts=wav`. Writing to stdout (`-`) gives MP3 unless `output_tts`
  says otherwise.
- **Names.** `ai_text_to_speech`, `ai_docx_to_speech`, `ai_pdf_to_speech` and
  `ai_md_to_speech` work as converter names too.

- **Sound.** The audio comes out at spoken-word loudness (about -16 LUFS), 24 kHz mono in both
  formats, so it can go straight into a video. MP3s report their true duration.

Text to speech uses AI credits (10 per 1,000 characters).

## License

MIT
