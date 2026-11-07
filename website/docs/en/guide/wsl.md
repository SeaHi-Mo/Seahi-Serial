# WSL port mapping

The WSL port mapping button in the title bar maps USB devices into WSL so the device can be accessed as a `/dev/tty*` serial port inside WSL. Mapping requires [usbipd-win](https://github.com/dorssel/usbipd-win), which is included in the installer.

## Opening the panel

Click the WSL icon in the title bar; the icon changes to Back to serial debugger, and clicking it again or clicking the app icon returns to the serial page. Serial panes remain connected while hidden; the receive polling interval changes from 25 ms to 500 ms and returns to normal when the serial page is shown again.

The Open extra monitor button on the WSL page adds a WSL pane and is greyed out while WSL is not running.

## Distributions

The top of the panel lists every distribution from the actual output of `wsl --list --verbose`:

- Each card has a status dot: green for running, grey for stopped. The default distribution is marked as default in the Map to dropdown.
- A running card shows `UP`, its uptime refreshed every second, and a Stop button.
- A stopped card shows a Start button.
- The terminal icon at the right opens the distribution in Windows Terminal; the button is unavailable while the distribution is stopped.

Before starting a distribution, the app verifies that its name exists in the list returned by WSL. Windows Terminal is preferred, with `wt -p <distro>` plus an explicit `wsl.exe -d <distro>`, so a mismatched profile name cannot start the wrong program; when `wt.exe` is unavailable, the app falls back to `conhost.exe`. A failed launch shows a notice and does not start a window.

Stopping a distribution runs `wsl --terminate <distro>`. Mapped devices revert to unmapped in the list, and WSL panes are greyed out and disconnected.

When the distribution list cannot be read, the panel displays WSL's raw error text and does not generate distribution cards. A background check runs every 2 seconds and pushes status changes to the UI.

The Map to dropdown selects the target distribution: an empty value means the default distribution; with multiple distributions, mapping explicitly passes `--distribution <name>`.

<GuideMedia
  src="/img/guide/wsl-quick.mp4"
  poster="/img/guide/wsl-quick.png"
  caption="Real app: starting Ubuntu-20.04 from the WSL panel; the status and uptime update immediately."
/>

## Device list

The table is built from `usbipd list` and refreshes every 5 seconds; plugging or unplugging a device also triggers an immediate refresh.

| Column | Description |
|---|---|
| BUSID | usbipd device id, for example `1-4` |
| Port | When mapped, the WSL device path such as `/dev/ttyUSB0`; otherwise `—` |
| Device name | USB device name, with VID:PID and serial number below it |
| State | Green for free; yellow when the port is used by a monitor; red when mapped but the WSL path was not resolved |
| Auto | Records automatic mapping on plug-in by VID:PID |
| Map | Tick to map the device, untick to unmap it |

Serial ports, Bluetooth devices, built-in HID devices, USB network adapters, fingerprint devices and cameras do not appear in this table. Serial ports and Bluetooth use their own panels; a network adapter mapped into WSL overrides WSL's own network configuration; mapping a fingerprint device prevents Windows Hello from using the local fingerprint reader. When no device appears, running the app as administrator can be attempted.

Two checks run before mapping:

- While WSL is not running, the Map checkbox is greyed out and cannot be ticked.
- When `usbipd` is not installed or not in PATH, the mapping operation returns an error and asks to install usbipd-win first.

## Mapping and unmapping

Ticking Map attaches the device to WSL:

- When the device has not been shared through usbipd yet, `bind` runs first and then `attach`; this step requires administrator rights.
- A shared device can be attached directly without elevation.
- When the target COM port is still being monitored, the app stops that pane's monitoring before attaching, so the read loop does not report continuous errors.
- Elevation uses a two-stage flow: the app probes permissions first, and when elevation is required it shows an in-app Authorization dialog. The system UAC prompt appears only after Authorize and map is clicked; leaving the dialog untouched for 60 seconds is treated as cancel.
- After mapping, the device row shows the WSL path. Path resolution can be delayed, so the app retries up to 4 times at 1 second intervals.

Unticking Map performs detach:

- When a WSL pane is using that path, the app disconnects the pane first and then detaches.
- Detach can also require elevation.

Automatic mapping follows these rules:

- Turning on the Auto switch for a device records a rule by VID:PID. While the device is not mapped, a background check runs every 15 seconds, and a plug/unplug event triggers an immediate check.
- When automatic mapping requires elevation it triggers the system UAC prompt directly without showing the in-app confirmation dialog.
- After three consecutive failures the rule pauses and shows one notice to avoid repeated UAC prompts; toggling the switch again resets the counter.

<GuideMedia
  src="/img/guide/wsl.mp4"
  poster="/img/guide/wsl.png"
  caption="The WSL mapping panel listing usbipd devices and the installed distribution."
/>

## Debugging from a WSL pane

The lower half of the panel is the WSL pane. Its default height is 300 px and it can be resized by dragging the middle splitter; the minimum is 120 px, and the height is saved in the configuration.

The WSL pane toolbar matches the serial pane and includes view mode, port, refresh, baud rate, line ending, start/stop monitoring, clear output, auto-scroll, auto-reconnect, terminal mode, line buffering, line numbers, timestamps, message echo and more settings. Line buffering is off by default because a Linux shell relies on readline and arrow keys; it can be enabled manually when sending AT-style whole-line commands.

The port list comes from `/dev/ttyACM*`, `/dev/ttyUSB*` and `/dev/ttyS*` inside WSL. The dropdown shows "path (device name)" while expanded and only the path once selected; a path used by another pane is marked in use and cannot be selected; an empty list shows "No ports available", and the distribution must be running and the device mapped.

On connect the backend performs the following operations:

- It locates a running distribution, starts the default distribution when none is running, and deploys the bridge script to `/tmp` in WSL.
- It starts the bridge with `python3`. It uses `sg` only when switching to the `dialout` group can be done non-interactively; otherwise it runs `python3` directly so `sg` does not stop at a password prompt.
- It waits for the bridge to print `ready` for up to 5 seconds; all traffic then goes through that pipe.

When connecting fails, the message identifies the cause:

- Missing `python3`: install `python3` and `python3-serial` in the distribution.
- Missing `sg`: install the `shadow` package and reconnect; the app then switches to that path automatically.
- Mismatched `dialout` group: some distributions name the serial group `uucp` or `tty`, or the current user is not in the group.
- Bridge startup timeout: the script was not written to `/tmp`, or `/tmp` is not writable or is full; reconnecting deploys it again.

Link loss is determined as follows: each read poll has a 3 second timeout, and three consecutive failures mark the device as disconnected. The app then disconnects, ends the session cache, switches the UI back to disconnected and shows one notice; the notice is a popup only and is not written to the log window, while technical details remain in the console.

Auto-reconnect is off by default. When enabled it retries up to 10 times with a delay of 3 seconds multiplied by the attempt number, capped at 30 seconds; the reconnect process and its result are not written to the log either.

Sending, receive history, session log cache, workflows and terminal mode in a WSL pane behave the same as in a serial pane. After a mapped device is detached, its `/dev/tty*` node disappears inside WSL, and consecutive read failures trigger the link-loss handling described above.

## Troubleshooting

- The port list stays empty: confirm that the distribution is running rather than only a Windows Terminal window; check the mapping state and WSL path in the panel; click refresh; unmap and map again if necessary; or run `ls /dev/ttyUSB* /dev/ttyACM*` inside WSL to confirm the node exists.
- The Map checkbox is grey: WSL is not running; start a distribution first.
- Mapping fails: check whether the authorization dialog was cancelled, whether usbipd is installed and whether the device is still connected; release the device first if another program is using it.
- Opening a terminal fails: a notice appears in the card area; follow it to check `wt.exe` and the distribution state.
- The distribution list cannot be read: the panel shows WSL's raw error; common causes are WSL not installed, no distributions, or `wsl --list --verbose` being denied.
