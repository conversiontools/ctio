# CLAUDE.md — ctio

Project conventions for Claude Code (and human contributors) working on this repo.

## What this is

`ctio` — single-binary, composable CLI for the [Conversion Tools](https://conversiontools.io) API. Third surface alongside the Node SDK (`conversiontools` on npm) and the MCP server.

## Locked decisions

- **Binary name:** `ctio` (the 2-char `ct` conflicts with too many existing tools — AIX/HP-UX BNU, Erlang Common Test, Bash Command Trace, Helm Chart Testing, CodeThreat).
- **Language:** Bun + TypeScript. Reuse the published `conversiontools` SDK directly — never reimplement upload/auth/polling.
- **License:** MIT, open source.
- **Distribution:** GitHub Releases primary; Homebrew tap + scoop bucket from v0.1.0.
- **CLI parser:** `cac` (small, TS-first).
- **TOML lib:** `smol-toml`.

## Hard security rules (read before any code that logs or echoes anything)

- **Never log token contents** — even in `--verbose`. Masking helper in `src/lib/logger.ts`.
- **Never log or echo file contents.** `--verbose` shows metadata only (size, type, status, timing).
- **No URL fetching unless explicit `--url` flag.**
- **TLS verification on by default.** `--insecure` exists but warns to stderr.
- **No destructive defaults.** Verbs like `task delete` require `--yes`.
- **Profile file is `0600` on Unix.** Refuse to write if `chmod` fails.

## Auth model

- API tokens (JWTs) come from <https://conversiontools.io/profile>. One token per user; "Regenerate" invalidates the old one.
- `ctio auth login` is interactive paste-token. No OAuth device flow in v1.
- Validation via `client.getUser()` from the SDK.
- Profiles live at `~/.config/conversiontools/profiles.toml` (Unix) or `%APPDATA%\conversiontools\profiles.toml` (Windows).

## Multi-region

- Default base: `https://api.conversiontools.io/v1` (geo-routed).
- `--region us|eu|ap` overrides to `https://{us,eu,ap}.api.conversiontools.io/v1`.
- `--base-url <URL>` is an escape hatch for staging/local dev (warns to stderr).
- Precedence: `--base-url` > `--region` flag > profile region > `auto`.

## Output

- **Default: JSON** to stdout (pipe-friendly). Status/progress to stderr.
- `--format pretty` for humans.
- `--format ndjson` for piping into `jq -s` / large lists.
- File output: path argument writes to that path. `-` writes to stdout.

## Streaming

- File path or `-` for stdin/stdout. **Never** buffer the whole file in memory.
- Uploads bypass the SDK's helper and POST chunked multipart directly, because the SDK helper accumulates the full body in RAM.

## Conventions

- **Commit style:** Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). One-line subject, bullets in body when needed. No `Co-Authored-By`. Never `--amend`.
- **No PII in commits / PR descriptions / comments.** Public repo — generic descriptors only.
- **New functionality ships with tests**, not as a follow-up.
- **Imports:** external packages first (alphabetical), blank line, `@/*` (local aliased), blank line, `../..`, `../`, `./`. Within a single import: `type` keyword first, then values, both alphabetical.
- **No `any`.** No workarounds. No hacks.
- **Line endings:** LF only.

## Layout

```
src/
  index.ts              # CLI entry — wires cac, dispatches to commands
  commands/             # one file per top-level verb
    convert.ts
    task.ts
    list.ts
    auth.ts
    version.ts
  lib/
    client.ts           # region-aware ConversionToolsClient factory
    profile.ts          # read/write profiles.toml (0600)
    token.ts            # token resolution chain
    region.ts           # region → base URL mapping
    output.ts           # json | pretty | ndjson printer
    streams.ts          # `-` stdin/stdout helpers
    upload.ts           # chunked multipart upload (bypasses SDK buffering)
    errors.ts           # typed errors + exit codes
    logger.ts           # verbose hygiene
tests/                  # bun test
```

## Test conventions

- `bun test` is the runner. Built-in, no extra dep.
- Tests live next to the surface they verify — `tests/convert-args.test.ts` for arg parsing in `commands/convert.ts`.
- For end-to-end tests against the real API, set `CT_API_TOKEN` to a personal token from <https://conversiontools.io/profile>. Conversions consume quota (cheap). `sandbox: true` skips the actual conversion, so it cannot validate the full path.

## What NOT to do

- Don't add backwards-compat shims, feature flags, or `_unused` renames for code we removed.
- Don't add comments explaining what well-named code already does.
- Don't add docstrings beyond a single short line.
- Don't fetch user-supplied URLs from any tool (curl, WebFetch, Bash) during dev work either.
- Don't paste customer data, file contents, or token values into commits, comments, or PR bodies.
