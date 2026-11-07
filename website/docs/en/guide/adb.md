# ADB debugging

The ADB panel is for debugging Android devices without using a local COM port. It talks to the device through the `platform-tools` bundled with the installer: list devices, open an interactive shell, and type commands inside it.

## Opening the panel

Click the ADB icon in the title bar. While the panel is open the icon reads **Back to serial debugger**; click it again, or click the app icon on the left of the title bar, to return to the serial page.

The panel has two parts:

- A device bar at the top with device cards in a horizontal row and a **Refresh** button at the right.
- A session area below it. With no session it reads **Select a device above to start a debug session**.

The panel is built on first open and reused afterwards; switching away and back does not rebuild it. Each return refreshes the device list and restores background session polling to 120 ms.

While the ADB page is open, the **Open extra monitor** button in the title bar is greyed out with the tooltip **ADB UI unavailable**.

## Walkthrough

1. Connect the Android device with a USB cable and enable USB debugging in developer options.
2. Click the ADB icon in the title bar; the device list refreshes once automatically.
3. Allow USB debugging for this computer on the device; the card state changes from `unauthorized` to `device`.
4. Click a card whose state is `device` and wait for the terminal prompt.
5. Type commands in the terminal; their output is drawn on the same canvas.
6. To switch devices, click another card; the current session is closed and disposed first.
7. Click the ADB icon or the app icon to return to the serial page. The session stays open in the background with slower output polling.

## Device list

The list refreshes as soon as the panel opens, and then every 5 seconds while it stays open, because ADB devices are not covered by the COM port plug/unplug notifications. **Refresh** fetches it manually.

Each card shows the device model (or the serial number when there is no model) and a status dot. Clicking a card opens a session for that device:

- Clicking the same device again only returns focus to its terminal; it does not connect twice.
- Clicking another device closes and disposes the current session first, then builds a terminal for the new device (one ADB session at a time).

The dot is coloured from the state reported by `adb devices -l`:

| State | Colour | Meaning |
|---|---|---|
| `device` | green | Usable |
| `unauthorized` | red | USB debugging has not been allowed on the device yet |
| `offline` | orange | The device is not responding; replug it or restart the adb server |
| `no` / `no-permissions` | red | No permission to access the device |
| `recovery` / `sideload` / `bootloader` / `connecting` / `authorizing` | orange | The device is in a transitional state |
| `error` / `failed` / `unknown` | red | The state could not be read |

An empty list shows **No ADB devices detected**; when adb itself cannot be found, the panel asks you to check whether adb is installed.

## Opening a shell

Clicking a device card creates an xterm terminal in the session area. The backend runs `adb -s <serial> shell` inside a pseudo terminal (PTY):

- Environment: `TERM=xterm-256color`, `COLORTERM=truecolor`; working directory `C:\`.
- The PTY starts at 40 rows × 120 columns, waits 1.5 seconds for the shell, and then starts reading output.
- Once the frontend receives the PTY session id it gives the terminal focus, and every keystroke goes into that PTY.

If the shell cannot be opened, the terminal keeps a red line **Connection failed: …**, so the reason does not stay hidden in the console.

The terminal keeps the last 1000 lines of scrollback. Its colours are fixed to the dark palette and do not follow the app theme.

To close a session, switch to another device: the old child process is killed, the terminal instance is disposed, and the PTY entry is removed from the backend. Leaving the ADB page does not close the session; it only slows output polling from 120 ms to 2000 ms, and switching back restores it.

## Input and output

- Type directly in the terminal. Keystrokes are written to the PTY unchanged and interpreted by the shell on the device. The ADB panel has no send input box, no line buffering and no send history; Enter sends `CR` from the terminal.
- The frontend polls output every 120 ms and hands it to xterm, which handles ANSI colour, cursor movement and full-screen programs. New output scrolls to the bottom.
- While the page is hidden, polling drops to 2000 ms so the backend is not polled in the background at full rate.
- If the UI cannot keep up, the backend PTY queue holds at most 512 blocks; beyond that the oldest blocks are dropped and counted. The terminal prints a yellow **N blocks of output were dropped** line instead of pretending the data is complete.
- Terminal size is computed from the real container pixels and sent to the backend PTY with `adb_shell_resize`. While the panel is hidden the container has zero size, so the size is not measured or sent for that round; that avoids shrinking the shell to 2×2 and crushing its buffer.
- Pasted text uses the same write command and goes into the PTY unchanged; multi-line content is written in one go and parsed by the shell on the device.

## Inside the terminal

- Keystrokes go into the PTY unchanged: Tab is left to the device shell for completion, and arrow keys, Ctrl combinations and full-screen program keys are never intercepted locally.
- The terminal keeps no command history; history belongs to the shell's readline on the device, so `↑` recalls what the device recorded.
- The mouse wheel scrolls back through the last 1000 lines; new output returns to the bottom automatically.
- There are no **Copy all** or **Save log** buttons in the terminal. Content lives only in the terminal buffer and is not kept after the app closes.

## Differences from the serial terminal

| Item | ADB terminal | Serial pane terminal mode |
|---|---|---|
| Input mode | Keystrokes go into the PTY unchanged | Direct send or line buffering |
| Scrollback | 1000 lines | 5000 lines |
| Colours | Fixed dark palette | Follows the current theme |
| Output polling | 120 ms visible, 2000 ms hidden | 25 ms visible, 500 ms hidden |
| Closing a session | Reclaimed when another device is clicked | Instance disposed when the pane closes |
| Session cache | No log-cache file is written | Written to log-cache |

## The adb tool

`adb.exe` is looked up in this order:

1. `platform-tools\adb.exe` next to the app executable. The installer ships `platform-tools` there.
2. Walking up from the app directory through parent directories, looking for `platform-tools\adb.exe`, which covers running a build output from the development tree.
3. `adb.exe` anywhere in `PATH`.

When all three miss, the device list asks you to check whether adb is installed. The installer offers the optional task **Add ADB tools (platform-tools) to the system PATH**, after which `adb` also works from a terminal or script.

The app has no separate adb server start/stop button: the first `adb devices` or `adb shell` starts the resident server process. During install and uninstall the installer first stops adb processes whose image path is inside this app's `platform-tools`, so they do not lock files and break an upgrade; adb from Android Studio or other sources is not touched.

Common messages and what to do:

| Message | Cause | Action |
|---|---|---|
| **No adb executable found** | None of the three lookup locations has adb | Reinstall, or add platform-tools to PATH |
| **adb devices timed out** | The command did not return within 5 seconds | The adb server is stuck or the device is unresponsive; restart the adb server and refresh |
| **No ADB devices detected** | The list is empty, or adb is unavailable | Check the USB cable, USB debugging and whether this computer was authorised on the device |
| `unauthorized` | The device has not allowed this computer for debugging | Allow USB debugging on the Android device |
| `offline` | The device is not responding | Replug the device, or restart the adb server and refresh |
| **Connection failed: …** in the terminal | `adb shell` could not start | Follow the red text; usually the device disconnected or is unauthorised |
| **N blocks of output were dropped** in the terminal | The UI cannot drain fast enough | Stop the command flooding the output, or use a device with less output |

## Notes

- The panel provides a device list and an interactive shell only; file transfer and log capture are not part of it.
- Only one session is kept at a time. Switching devices ends the old shell instead of leaving several PTYs in the background.
- The terminal colours are fixed to the dark palette. Unlike the serial pane's terminal mode, the ADB terminal does not follow the app theme.
- adb lookup does not read environment variables such as `ANDROID_HOME`; only the three locations above are checked.
- The 5 second device list refresh runs only while the ADB page is open; leaving the page stops it.
