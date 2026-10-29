# WSL port mapping

The **WSL port mapping** button in the title bar maps a USB serial port into WSL so the device can be used directly inside WSL.

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

## Debugging from a WSL pane

A WSL pane can open a serial port inside WSL and send or receive data directly. It uses a Python bridge with a persistent shell to avoid process startup overhead on every operation.

The **Launch** button opens the distribution in Windows Terminal. The distribution name comes from the real output of `wsl --list --verbose`; if parsing fails, the panel shows the original WSL error instead of launching with a wrong name.

If read polling fails repeatedly, the pane is treated as disconnected and shows *Waiting for connection*. If a loop is running, it stops as well.

When `sg` is unavailable or the user is not in the `dialout` group, the bridge only uses `sg` when it can switch groups non-interactively; otherwise it runs `python3` directly. A missing `sg` does not prevent startup. If the user is not in `dialout`, add the user to the group or attach the device through usbipd.
