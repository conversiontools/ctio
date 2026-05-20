# ctio

Composable CLI for the [Conversion Tools](https://conversiontools.io) API.

Single-binary client. Pipe-friendly. Multi-region. MIT licensed.

```bash
# Convert a file
ctio convert -t json_to_excel data.json out.xlsx

# Pipe through stdin/stdout
cat data.json | ctio convert -t json_to_excel - - > out.xlsx

# Compose
ctio parse invoice.pdf --schema purchase-invoice \
  | jq '.line_items' \
  | ctio convert -t json_to_excel - out.xlsx
```

> **Status:** Phase 1 MVP — in active development.

## Install

Binary releases (GitHub Releases), Homebrew tap, and scoop bucket arrive with v0.1.0. For now, run from source:

```bash
git clone git@github.com:conversiontools/ctio.git
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

## License

MIT
