# Error reporting

The application collects runtime errors and sends them to a self-hosted collection service for problem diagnosis and resolution. This page describes the reported content, reporting timing, data destination and the disabling procedure.

## What is reported

Reports fall into three categories:

- Crashes (panics): panics on any thread are captured.
- Backend runtime errors: failures in serial port opening, reading and writing, DTR/RTS, Bluetooth connection and read/write operations, ADB sessions, WSL mapping and update checks.
- Frontend script errors: uncaught JavaScript errors, unhandled Promise rejections and errors already shown in the interface.

Each report contains the following fields:

| Field | Content |
|---|---|
| App version | For example `0.5.23` |
| Operating system | For example `windows` |
| Error message | Error text, truncated when too long |
| Stack | Fault location; a JavaScript call stack for the frontend, or file and line for the backend |
| Context tag | The affected feature, for example `send_data`, `open_wsl_serial` and `connectPort` |

Serial traffic, log contents, device data and configuration file contents are not reported. Stack traces may contain source file paths used for fault location and do not include device interaction content.

## Reporting timing

Errors are queued on creation and sent by a background thread without blocking serial I/O. The same type of error (context plus the first line of the error) is reported at most once every 5 minutes to limit duplicate reports; merged counts are written to the local log.

When a report fails (network unavailable or server rejection), one line `[report] 上报失败（上下文）` is written to the local log. No dialog is shown and normal use is unaffected.

## Data destination

Data is sent to the author's self-hosted error collection service (Cloudflare Workers + D1) and does not pass through a third-party error platform. The server groups records by error and stack and retains the most recent 100 details per group.

## Disabling reporting

Set the `SEAHI_ERROR_REPORT=0` environment variable before starting the application:

1. Temporary: run `$env:SEAHI_ERROR_REPORT="0"` in PowerShell, then start the application. The setting applies only to the current session.
2. Persistent: run `sysdm.cpl` from `Win + R` to open System Properties, go to Advanced → Environment Variables, create a user variable named `SEAHI_ERROR_REPORT` with the value `0`, then sign out or restart the application.

`false` and `off` are equivalent to `0`.

## Local log

When reporting is disabled or a report fails, errors are still written to the local debug log `%TEMP%\seahi-serial-debug.log` (automatically rotated at 4 MB with one `.1` file retained). Enter `%TEMP%` in `Win + R` to open the containing directory.

The MCP log centre also provides a dedicated `error` channel, which AI clients can read through `log_tail`.
