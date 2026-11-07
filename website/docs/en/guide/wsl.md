# WSL port mapping

The **WSL port mapping** button in the title bar maps USB devices into WSL so the device can be used there as a `/dev/tty*` serial port. Mapping requires [usbipd-win](https://github.com/dorssel/usbipd-win), which is included in the installer.

## Opening the panel

Click the WSL icon in the title bar. While the panel is open the icon reads **Back to serial debugger**; click it again, or click the app icon, to return to the serial page. The serial panes are hidden but stay connected: receive polling drops from 25 ms to 500 ms and returns to normal when you go back.

The **Open extra monitor** button on this page adds a WSL pane; it is greyed out while WSL is not running.

## Distributions

The top of the panel lists every distribution, taken from the real output of `wsl --list --verbose`:

- Each card has a status dot: green when running, grey when stopped. The default distribution is marked as the default in the **Map to** dropdown.
- A running card shows `UP` and its uptime, updated every second; its button reads **Stop**.
- A stopped card shows **Start**.
- The terminal icon on the right opens that distribution in Windows Terminal; it is unavailable while the distribution is stopped.

Starting:

- The app checks that the name really appears in WSL's distribution list before starting anything.
- It prefers Windows Terminal (`wt -p <distro>` plus an explicit `wsl.exe -d <distro>`, so a mismatched profile name can never open PowerShell instead); without `wt.exe` it falls back to `conhost.exe`.
- A failed launch shows a message; it never opens the wrong window.

Stopping runs `wsl --terminate <distro>`. Mapped devices fall back to unmapped in the list, and the WSL panes are greyed out and disconnected.

When the distribution list cannot be read, the panel shows WSL's raw error instead of inventing cards. A background check runs every 2 seconds and pushes status changes to the UI.

The **Map to** dropdown picks the target distribution: empty means the default; with several distributions the mapping passes `--distribution <name>` explicitly.

<GuideMedia
  src="/img/guide/wsl-quick.mp4"
  poster="/img/guide/wsl-quick.png"
  caption="Real app: starting Ubuntu-20.04 from the WSL panel; the status and uptime update immediately."
/>

## Device list

The table comes from `usbipd list` and refreshes every 5 seconds; plugging or unplugging a device also triggers a refresh.

| Column | Description |
|---|---|
| BUSID | usbipd device id, for example `1-4` |
| Port | When mapped, the WSL device path such as `/dev/ttyUSB0`; otherwise `—` |
| Device name | USB device name, with VID:PID and serial number below it |
| State | Green: free; yellow: port in use by a monitor; red: mapped but the WSL path was not resolved |
| Auto | Remember "map automatically when plugged in", matched by VID:PID |
| Map | Tick to map, untick to unmap |

Serial ports, Bluetooth, built-in HID devices, USB network adapters, fingerprint readers and cameras are filtered out of this table: serial ports belong to the serial panel, Bluetooth to the Bluetooth panel, network adapters mapped into WSL would take over WSL's own networking, and mapping a fingerprint reader would steal Windows Hello. If no device appears, try running the app as administrator.

Two checks run before mapping:

- WSL is not running: the map checkbox is greyed out and cannot be ticked.
- `usbipd` is missing from PATH: the mapping reports an error and asks you to install usbipd-win.

## Mapping and unmapping

Ticking **Map** attaches the device to WSL:

- If the device is not shared with usbipd yet, it is bound first and then attached; this step needs administrator rights.
- An already shared device can be attached directly without elevation.
- If the target COM port is being monitored, that pane is stopped first, so its read loop does not start flooding errors after the attach.
- Elevation is two-stage: the app probes first, and when rights are needed it shows an in-app **Authorisation** dialog. Only after **Authorise and map** does the system UAC prompt appear; leaving the dialog untouched for 60 seconds counts as cancel.
- After mapping, the row shows the WSL path. Path resolution can lag, so the app retries up to 4 times, once per second.

Unticking unmaps:

- If a WSL pane is using that path, the app disconnects it first, then detaches.
- Detaching may also require elevation.

Automatic mapping:

- Turning on **Auto** for a device remembers a rule by VID:PID. While the device is not mapped, a background check runs every 15 seconds, and a plug/unplug event triggers it immediately.
- When automatic mapping needs elevation it goes straight to the system UAC prompt; no in-app confirmation dialog appears first. The UAC prompt is expected.
- Three consecutive failures pause that rule with one message, so it cannot keep popping UAC prompts; toggling the switch resets the counter.

<GuideMedia
  src="/img/guide/wsl.mp4"
  poster="/img/guide/wsl.png"
  caption="The WSL mapping panel listing usbipd devices and the installed distribution."
/>

## Debugging from a WSL pane

The lower half of the panel is the WSL pane. It starts at 300 px high and can be resized by dragging the splitter in the middle; the minimum is 120 px, and the height is saved with the configuration.

The WSL pane toolbar matches the serial pane: view mode, port, refresh, baud rate, line ending, start/stop monitoring, clear output, auto-scroll, auto-reconnect, terminal mode, line buffering, line numbers, timestamps, message echo and more settings all work. One difference: line buffering starts off, because a Linux shell needs readline and arrow keys; turn it on when sending AT-style whole-line commands.

The port list comes from `/dev/ttyACM*`, `/dev/ttyUSB*` and `/dev/ttyS*` inside WSL:

- The dropdown shows "path (device name)"; once selected, only the path is shown.
- A path used by another pane is marked **in use** and cannot be selected.
- An empty list shows **No ports available**; first check that the distribution is running and the device is mapped.

On connect the backend:

- Finds a running distribution (starting the default one if needed) and deploys the bridge script to `/tmp` inside WSL.
- Starts the bridge with `python3`. It uses `sg` only when switching to the `dialout` group can be done non-interactively; otherwise it runs `python3` directly, so `sg` never blocks on a password prompt.
- Waits up to 5 seconds for the bridge to print `ready`; after that, all traffic goes through that pipe.

Connect failures distinguish the cause:

- No `python3`: install `python3` and `python3-serial` in the distribution.
- No `sg`: install the `shadow` package; reconnect once and the app switches to it automatically.
- Wrong `dialout` group: some distributions call the serial group `uucp` or `tty`, or the current user is not in it.
- Bridge startup timed out: the script did not land in `/tmp`, or `/tmp` is not writable or is full; reconnecting deploys it again.

Link loss: each read poll has a 3 second timeout, and three consecutive failures mean the device is gone. The app disconnects, ends the session cache, switches the UI back to disconnected, and shows one message. That message is a popup only and is not written to the log window; technical details stay in the console.

Auto-reconnect is off by default. When enabled it retries up to 10 times with a delay of 3 seconds × attempt number, capped at 30 seconds; the process and its results are not written to the log either.

Sending, receive history, the session log cache, workflows and terminal mode in a WSL pane behave like a serial pane. After a mapped device is detached, its `/dev/tty*` node disappears; consecutive read failures then trigger the link-loss path above.

## Troubleshooting

- **The port list stays empty**: make sure the distribution is actually running, not just a Windows Terminal window. Go back to the panel and check the mapping state and WSL path, click refresh, unmap and remap if needed, or run `ls /dev/ttyUSB* /dev/ttyACM*` inside WSL to confirm the node exists.
- **The map checkbox is grey**: WSL is not running; start a distribution first.
- **Mapping fails**: check whether the authorisation dialog was cancelled, whether usbipd is installed, and whether the device is still plugged in; release it if another program is using it.
- **Opening a terminal fails**: a popup shows on the card; follow it to check `wt.exe` and the distribution.
- **The distribution list cannot be read**: the panel shows WSL's raw error. Common causes are WSL not installed, no distributions, or `wsl --list --verbose` being denied.
