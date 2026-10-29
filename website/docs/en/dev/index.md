# Development

For people changing this repository: environment, commands, tests, layout, release. **The project rules in [`AGENTS.md`](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/AGENTS.md) are authoritative**; this page is the minimal path in.

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

## Release

The version must match in **five places** (CI checks it):

1. `src-tauri/Cargo.toml` — `version`
2. `src-tauri/tauri.conf.json` — `version`
3. `installer.iss` — `MyAppVersion`
4. `package.json` — `version`
5. `src-tauri/Cargo.lock` — the `seahi-serial` entry

```bash
# bump the five version strings, update RELEASE_NOTES.md (features only)
git commit -am "chore(release): v0.x.y" && git push

git tag v0.x.y
git push origin v0.x.y   # CI builds and publishes the release
```

⚠️ The version is baked into the binary at compile time — changing files without rebuilding ships the old number.

## Use the skills

`skills/` contains development handbooks for AI agents: constraints, commands and known pitfalls. Have your assistant read the relevant `SKILL.md` before editing. See [skills](/en/dev/skills).
