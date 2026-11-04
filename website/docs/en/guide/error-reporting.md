# Error reporting

The app collects runtime errors and sends them to a self-hosted collection service so problems can be diagnosed and fixed. This page covers what is sent, when, where it goes and how to turn it off.

## What is sent

Three kinds of failures are reported:

- Crashes (panics) on any thread.
- Backend runtime errors: opening, reading and writing serial ports, DTR/RTS, Bluetooth connection and GATT operations, ADB sessions, WSL mapping and update checks.
- Frontend script errors: uncaught JS errors, unhandled promise rejections, and errors already shown in the UI.

Each report contains:

| Field | Content |
|---|---|
| App version | e.g. `0.5.23` |
| OS | e.g. `windows` |
| Error message | error text, truncated when too long |
| Stack | where it happened; a JS call stack, or file and line for Rust |
| Context tag | the feature involved, e.g. `send_data`, `open_wsl_serial`, `connectPort` |

Serial traffic, log contents, device data and configuration files are **never** sent. Stack traces may contain source file paths, which are used to locate the fault and never include device payloads.

## When reports are sent

Errors are queued and delivered by a background thread, so serial I/O is never blocked. The same error (context plus first line) is reported at most once every 5 minutes; merged counts are recorded in the local log.

Failed reports (offline, or rejected by the server) only add one line to the local log — no dialog and no effect on normal use.

## Where the data goes

To the author's self-hosted collector (Cloudflare Workers + D1). No third-party error platform is involved. The server groups by error and stack, keeping the last 100 details per group.

## Turning it off

Set the `SEAHI_ERROR_REPORT=0` environment variable before launching the app:

- Temporarily (PowerShell, current session): run `$env:SEAHI_ERROR_REPORT="0"`, then start the app.
- Permanently: `Win + R` → `sysdm.cpl` → Advanced → Environment Variables → create a user variable `SEAHI_ERROR_REPORT` with the value `0`, then sign out or restart the app.

`false` and `off` work as well.

## Local log

Errors are still written to `%TEMP%\seahi-serial-debug.log` (rotated at 4 MB, one `.1` kept) when reporting is off or the upload fails. Type `%TEMP%` into `Win + R` to open the folder.

The MCP log centre also exposes a dedicated `error` channel, readable by AI clients through `log_tail`.
