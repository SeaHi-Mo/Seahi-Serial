# ADB debugging

The ADB panel debugs Android devices without using a local COM port. It communicates with the device through the adb command in the bundled `platform-tools`, and provides device listing, an interactive shell and command execution.

## Opening the panel

Click the ADB icon in the title bar. While the panel is open the icon reads Back to serial debugger; clicking it again, or clicking the app icon at the left of the title bar, returns to the serial page.

The panel has two areas. The top device bar lists device cards horizontally with a Refresh button at the right; the session area below shows "Select a device above to start a debug session" when no session exists. The panel is created on first open and reused across page switches; each return refreshes the device list and restores background session polling to 120 ms.

While the ADB page is open, the Open extra monitor button in the title bar is greyed out with the tooltip "ADB UI unavailable".

## Walkthrough

1. Connect the Android device with a USB cable and enable USB debugging in developer options.
2. Click the ADB icon in the title bar; the device list refreshes automatically.
3. Allow USB debugging for this computer on the device; the card state changes from `unauthorized` to `device`.
4. Click a card whose state is `device` and wait for the terminal prompt in the session area.
5. Enter commands in the terminal; output is displayed on the same canvas.
6. To switch devices, click another card; the current session is closed and reclaimed first.
7. Click the ADB icon or the app icon to return to the serial page; the session stays open in the background with slower output polling.

## Device list

The device list refreshes immediately when the panel opens and then every 5 seconds while the panel remains open, because ADB devices are not covered by serial plug/unplug notifications. The Refresh button fetches it manually.

Each card shows the device model (or the serial number when no model is available) and a status dot. Clicking a card creates a session for that device; clicking the same device again only returns focus to the existing terminal and does not connect twice. Clicking another device closes and reclaims the current session before creating a terminal for the new device, and only one ADB session is kept at a time.

The status dot is coloured from the state returned by `adb devices -l`:

| State | Colour | Meaning |
|---|---|---|
| `device` | green | Device available |
| `unauthorized` | red | USB debugging has not been allowed on the device |
| `offline` | orange | Device not responding; replug it or restart the adb server |
| `no` / `no-permissions` | red | No permission to access the device |
| `recovery` / `sideload` / `bootloader` / `connecting` / `authorizing` | orange | Device in a transitional state |
| `error` / `failed` / `unknown` | red | State could not be read |

An empty list shows "No ADB devices detected"; when adb is unavailable, the panel prompts to check whether adb is installed.

## Opening a shell

Clicking a device card creates an xterm terminal in the session area, and the backend runs `adb -s <serial> shell` in a pseudo terminal (PTY). The PTY environment is `TERM=xterm-256color` and `COLORTERM=truecolor` with working directory `C:\`; its initial size is 40 rows by 120 columns, and output reading starts after 1.5 seconds. Once the frontend receives the PTY session id it gives focus to the terminal, and all subsequent keystrokes are written to that PTY.

If opening fails, the terminal area shows a red line "Connection failed: …" and the failure reason is retained for the UI state. The terminal keeps the last 1000 lines of scrollback, and its colours are fixed to the dark palette rather than following the app theme.

A session is closed by switching to another device: the app ends the old session's child process, disposes the terminal instance and removes the PTY session from the backend. Leaving the ADB page does not close the background session; it only changes the output polling interval from 120 ms to 2000 ms, and returning restores it.

## Input and output

- Keystrokes are written directly to the PTY and interpreted by the shell on the device. The ADB panel has no send input box, line buffering or send history, and Enter sends `CR` from the terminal.
- Output is polled by the frontend every 120 ms and passed to xterm, which handles ANSI colour, cursor movement and full-screen programs; new output scrolls to the bottom.
- While the page is hidden, the polling interval changes to 2000 ms so the backend is not accessed at high frequency after leaving the panel.
- When the frontend cannot drain output in time, the backend PTY output queue holds at most 512 blocks and drops the oldest blocks with a counter. The terminal displays a yellow notice that reports the number of dropped blocks.
- Terminal size is calculated from the actual container pixels and sent to the backend PTY with `adb_shell_resize`. While the panel is hidden the container size is zero, so no measurement or synchronization is performed in that round, avoiding a 2×2 shell that would damage its buffer.
- Pasted content is sent through the same write command; multi-line content is written once and parsed by the shell on the device.

## Inside the terminal

- Keyboard input is written to the PTY unchanged: Tab is passed to the device shell for completion, and arrow keys, Ctrl combinations and full-screen program keys are not intercepted locally.
- The terminal does not maintain command history; history is maintained by the readline implementation on the device, and `↑` reads commands recorded by the device.
- The canvas can be scrolled with the mouse wheel through the last 1000 lines, and new output returns to the bottom automatically.
- The terminal provides no Copy all or Save log buttons; content exists only in the terminal buffer and is not retained after the app closes.

## Differences from the serial terminal

| Item | ADB terminal | Serial pane terminal mode |
|---|---|---|
| Input mode | Keys written to the PTY unchanged | Direct send or line buffering |
| Scrollback | 1000 lines | 5000 lines |
| Colours | Fixed dark palette | Follows the current theme |
| Output polling | 120 ms visible, 2000 ms hidden | 25 ms visible, 500 ms hidden |
| Closing a session | Reclaimed when switching devices | Instance disposed when the pane closes |
| Session cache | No log-cache file is written | Written to log-cache |

## The adb tool

The app searches for `adb.exe` in the following order:

1. `platform-tools\adb.exe` in the app directory; the installer distributes `platform-tools` to this location.
2. Walking up from the app directory through parent directories to find `platform-tools\adb.exe`, which covers running build output directly from the development tree.
3. `adb.exe` in the system `PATH`.

When none of these locations contains adb, the device list prompts to check whether adb is installed. The installer provides the optional task "Add ADB tools (platform-tools) to the system PATH", after which `adb` can be called directly from a terminal or script.

The app provides no adb server start or stop button: the first execution of `adb devices` or `adb shell` starts the resident server process through adb itself. During installation and uninstallation, the installer first ends adb processes whose image path is under this app's `platform-tools`, so they do not lock files and cause an upgrade failure; adb from Android Studio or other sources is not affected.

Common messages and handling:

| Message | Cause | Handling |
|---|---|---|
| `No adb executable found` | adb is absent from all three locations | Reinstall or add platform-tools to PATH |
| `adb devices timed out` | The command did not return within 5 seconds | The adb server is stuck or the device is not responding; restart the adb server and retry |
| `No ADB devices detected` | The list is empty or adb is unavailable | Check the USB cable, the USB debugging switch and device authorization |
| `unauthorized` | The device has not allowed this computer for debugging | Allow USB debugging on the Android device |
| `offline` | The device is not responding | Replug the device or restart the adb server and retry |
| Terminal shows `Connection failed: …` | `adb shell` could not be established | Follow the reason in the red text |
| Terminal shows `N blocks of output were dropped` | The frontend cannot drain in time | Stop the command that produces heavy output, or use a device with less output |

## Notes

- The panel provides only a device list and an interactive shell; file transfer and log capture are outside its scope.
- Only one session is maintained at a time; switching devices ends the old shell instead of keeping multiple PTYs in the background.
- The terminal colours are fixed to the dark palette and, unlike the serial pane's terminal mode, do not follow the app theme.
- The adb lookup does not read environment variables such as `ANDROID_HOME`; only the three locations above are checked.
- The 5 second device list refresh runs only while the ADB page is open and stops when the page is left.
