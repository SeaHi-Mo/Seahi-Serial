# ADB debugging

The ADB panel is for debugging Android devices without using a local COM port.

## Device list

Open the ADB panel and click refresh to get the device list. Devices with status `device` can be used. A status of `unauthorized` means USB debugging has not been allowed on the device yet.

## Open a terminal

Select a device and open the terminal. It works like the serial terminal: type commands, watch the PTY output, resize the terminal or close the session.

## platform-tools

The installer bundles `platform-tools`. The adb server is a background process that keeps files under `platform-tools` open, which can make an upgrade fail while the files are in use. The installer stops only adb processes whose image path is inside the app directory, so adb from Android Studio or other sources is not affected.
