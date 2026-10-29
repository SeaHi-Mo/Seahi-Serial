# Skills

`skills/` at the repository root is not for end users — it is a set of **development handbooks for AI agents**: project constraints, commands, and pitfalls that have already been hit once.

Have the assistant read the relevant skill before editing. It is cheaper than re-explaining the rules, and it stops the assistant from inventing an approach that conflicts with the repository.

## How to use them

Skills are plain Markdown; there is nothing to install.

**1. Point the assistant at the file** (works everywhere)

> Read `skills/seahi-serial-dev/SKILL.md`, then change `src/js/10-monitor.js`.

**2. Clients with a rules/custom-instructions directory**

Claude Code, Cline and similar let you add project rules — point them at `skills/` or paste the constraints. In DeepSeek Harness you can reference `@skills/seahi-serial-dev/SKILL.md` directly.

**3. Keep the constraints resident**

Copy the "must follow" section into `AGENTS.md` or the client's custom instructions so every turn carries them.

## Available skills

### `seahi-serial-dev`

**When**: any frontend, backend or MCP change.

It covers the project layout (no frontend build step, shared global scope), commands and test requirements, the hard constraints (five-place version bump, MCP transport/session rules, non-blocking log side channel, no AI traces in `config.json`), and known pitfalls.

### `win-build-access-denied`

**When**: `npm run dev` shows no window, `cargo build` fails with "access denied / OS Error 5", or build scripts cannot read `tauri.conf.json`.

**Confirm the build actually failed before suspecting the app** — most "no window" reports are build failures whose errors are buried in a wall of logs. The skill gives a decision tree, an error-to-fix table, and repairs for NTFS low-integrity labels and directory permission pollution.

## Suggested flow

1. Read `AGENTS.md`.
2. Pick a skill: everyday work → `seahi-serial-dev`; build errors → `win-build-access-denied`.
3. Make the change.
4. Run the tests: backend unit tests + frontend assertions (plus `mcp_smoke.js` for MCP changes).
5. If the version changed, follow the version checklist in `AGENTS.md`.
