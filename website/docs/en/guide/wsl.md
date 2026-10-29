# WSL port mapping

The **WSL port mapping** button in the title bar maps a USB serial port into WSL so the device can be used directly inside WSL.

## Starting WSL quickly

The top of the WSL panel lists the distributions installed on this machine. The names come from the real output of `wsl --list --verbose`; you do not need to open Windows Terminal first.

- A stopped distribution shows **Start**. Click it to start that distribution.
- A running distribution shows **Stop** and its uptime. **Stop** shuts the distribution down.
- The terminal icon opens that distribution in Windows Terminal.
- With multiple distributions, use the **Map to** dropdown to choose the target; leaving it empty uses the default distribution.
- While WSL is stopped, device mapping and the WSL pane's **Start monitoring** button are unavailable. Start a distribution first.

<GuideMedia
  src="/img/guide/wsl-quick.mp4"
  poster="/img/guide/wsl-quick.png"
  caption="Real app: starting Ubuntu-20.04 from the WSL panel; the status and uptime update immediately."
/>

## Mapping a device

- It requires [usbipd-win](https://github.com/dorssel/usbipd-win), which is included in the installer. Binding and attaching need administrator privileges.
- Automatic mapping and manual binding are both supported. Windows shows an authorisation dialog during binding that must be confirmed.
- If the target COM port is being monitored in a pane, the app stops that pane before mapping the device.
- After mapping, WSL should show a new `/dev/ttyUSB*` or `/dev/ttyACM*` device.

<GuideMedia
  src="/img/guide/wsl.mp4"
  poster="/img/guide/wsl.png"
  caption="The WSL mapping panel listing usbipd devices and the installed distribution."
/>

## After mapping: debugging from a WSL pane

Once the device is mapped, the WSL pane is the serial console for it; you do not need to keep a Windows-side monitor open.

1. Make sure the distribution is running (see **Starting WSL quickly**). The pane stays unavailable while WSL is stopped.
2. Tick **Map** on the target device in the WSL device list. The first time, Windows asks for administrator approval; wait until the state shows mapped.
3. The device row shows its WSL path, for example `/dev/ttyUSB0`. It can take a few seconds to appear after mapping; the list refreshes automatically.
4. In the WSL pane below, click the refresh button next to the port dropdown and choose that `/dev/ttyUSB*` or `/dev/ttyACM*` port.
5. Set the baud rate, line ending and view mode, then click **Start monitoring**. Sending and receiving work like a normal serial pane: text/HEX send, send history and the session log cache are all available.
6. For an interactive terminal, turn on the pane's terminal mode. The WSL pane uses direct send by default, so keys go to the Linux-side device unchanged; enable line buffering if the device expects whole lines.
7. When the device disconnects, the pane shows *Waiting for connection*. Check that the device is still plugged in and still mapped, then map it again and refresh the port list if needed.

If the WSL pane's port list stays empty:

- Check that the distribution is actually running, not just that a Windows Terminal window opened.
- Go back to the WSL panel and confirm the device is mapped and its WSL path has appeared.
- Click refresh in the WSL pane; or unmap and map the device again.
- Inside WSL, run `ls /dev/ttyUSB* /dev/ttyACM*` to confirm the device node exists.
