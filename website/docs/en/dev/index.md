# Development

For people changing this repository: environment, commands, tests and layout. **The project rules in [`AGENTS.md`](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/AGENTS.md) are authoritative**; this page is the minimal path in.

## Requirements

| Dependency | Notes |
|---|---|
| **Rust** | https://rustup.rs/ |
| **Node.js 18+** | https://nodejs.org/ |
| **Visual Studio Build Tools 2022** | with the "Desktop development with C++" workload |
| **WebView2** | usually preinstalled on Windows 10/11 |

## Run it

```bash
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd Seahi-Serial

npm install          # only @tauri-apps/cli
npm run dev          # dev mode (hot reload)
npm run build        # release build → src-tauri/target/release/seahi-serial.exe
```

If `npm run dev` finishes without a window, **check the build output for `error` / access denied first** — it usually failed while building, not at runtime. See [skills → access denied on Windows](/en/dev/skills#win-build-access-denied).

## Tests

| Command | Covers |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | backend unit tests (incl. MCP tool contracts) |
| `node .walkthrough/gen_ble_preview.js` | frontend headless assertions (real handlers in a sandbox) |
| `node .walkthrough/mcp_smoke.js` | calls every MCP tool against the **running app** |

No lint, type check or formatter. **Run the assertion suite after touching the frontend**, and `mcp_smoke.js` after touching MCP.

## Layout

```
Seahi-Serial/
├── src/                  # frontend: index.html + css/ + js/ + vendor/xterm
├── src-tauri/            # Rust backend: src/main.rs, src/mcp/, vendor/btleplug, wsl-daemon
├── npm/seahi-serial-mcp/ # MCP client config installer (npx)
├── skills/               # development handbooks for AI agents
├── .walkthrough/         # frontend assertions, MCP smoke test, generators
├── doc/                  # architecture, frontend layout, MCP design, signing
└── installer.iss         # Inno Setup script
```

The frontend has **no build step**: `index.html` loads `css/*.css` and `js/*.js` in order.

## Pull requests

### Before you start

1. **Branch from the latest `main`.** One PR does one thing.
2. **It builds and runs**: `npm run build` succeeds; `npm run dev` opens; click through the UI if your change touches it.
3. **Tests pass**:
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `node .walkthrough/gen_ble_preview.js` (required for frontend changes)
   - `node .walkthrough/mcp_smoke.js` (required for MCP changes; needs the app running)
   - `npm run docs:build` when you change the docs site — it checks for dead links
4. **The version is unchanged** unless the PR *is* a release: the five version strings are only touched by release commits, and CI verifies they match.
5. **No unrelated churn**: drive-by formatting, editor config or blank-line cleanup makes review painful.

### Requirements

**Title**: `type(scope): what changed` using `feat` / `fix` / `docs` / `chore` / `refactor` / `test`, for example:

```
fix(logs): clear the on-disk session cache when clearing output
docs(dev): add development guide and skills walkthrough
```

**Description**: say why (symptom or issue), what changed, and how you verified it. Paste the error text, reproduction steps or a screenshot — far more useful than "fixed some issues".

**Do not commit**:

- generated files: `node_modules/`, `dist/`, `website/docs/mcp/tools.md`, `website/docs/changelog.md`, `*.generated.ts` (built automatically and covered by `.gitignore`);
- machine-specific paths, tokens, or `config.json` contents;
- reformatting unrelated to the change.

**Before pushing**:

```bash
git diff --stat          # is the scope what you expect?
git status               # any stray files?
npm run docs:build       # dead-link check if you touched docs
cargo test --manifest-path src-tauri/Cargo.toml
```

**Merging**: the maintainer reviews and merges. CI runs the build and tests on the PR — fix red checks before asking for review. Changes that affect release artifacts (version, installer, CI) need a note about their impact.
## Use the skills

`skills/` contains development handbooks for AI agents: constraints, commands and known pitfalls. Have your assistant read the relevant `SKILL.md` before editing. See [skills](/en/dev/skills).
