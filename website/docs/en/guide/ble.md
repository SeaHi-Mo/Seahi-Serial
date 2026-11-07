# Bluetooth

The Bluetooth panel provides central-role functions: scanning for nearby BLE devices, establishing connections, reading and writing GATT services, and subscribing to notifications and indications.

<GuideMedia
  src="/img/guide/ble.mp4"
  poster="/img/guide/ble.png"
  caption="The device list updates while the scan is running."
/>

## Panel layout

The left side contains the device list, with the Start scan / Stop scan button, the scan duration dropdown, the connect-by-MAC input and the filter entry at the top. The right side contains device details: advertising data, the GATT service tree and the data log. Clicking the write icon on a characteristic opens the write panel on the right side of the details.

## Scanning

Clicking Start scan changes the button to Stop scan, and the device list refreshes every 2 seconds, sorted by RSSI from strongest to weakest.

The scan duration can be 5, 15, 30 or 60 seconds, or continuous; the default is 15 seconds. When the configured duration is reached the scan stops automatically and shows one notice; with continuous selected, the scan runs until stopped manually.

With multiple Bluetooth adapters, all adapters scan at the same time and the results are merged into one list after de-duplication by MAC address. The filter matches device names or MAC addresses, and the counter above the list shows "N/M matched". When scanning fails or the system has no available Bluetooth adapter, the list area shows "Bluetooth is not compatible on this computer".

Each device card shows the name, MAC address, RSSI value and a signal bar. A connected device that has stopped advertising is added back to the list and marked Connected, so the details panel can still render. The device type (standard BLE, Apple, iBeacon, PC, Mesh) is determined by the backend from advertising content and affects only the icon and label.

## Connecting

Clicking a device card performs selection only and displays its details; establishing a connection requires clicking Connect device in the details.

The connection process has a latch: repeated clicks while connecting only show "Connecting, please wait…". The backend connect timeout is 10 seconds, after which it disconnects and settles the state; the frontend adds a 15 second guard so the UI does not remain in the connecting state. When the device is offline or its random address has rotated and cannot be found, the error message states that the device is offline or the address has changed, and a new scan is required.

After a successful connection the details area loads the GATT service tree and MTU, starts 250 ms notification polling and 3 second RSSI refresh, and marks the device card Connected. A successful connection also stops scanning; scanning is still allowed while connected to find other devices, and the next connection also stops scanning. Only one device is connected at a time.

Disconnect device in the details disconnects the current connection and clears the service tree, subscription state, data log and write panel; the backend retains the peripheral object so an immediate reconnect does not need to wait for advertising again.

When the device disconnects on its own (powered off, out of range or connected by another host), RSSI polling returns the link state, the UI switches to disconnected, clears the current session data and keeps one Disconnected line with the reason.

## Connecting by MAC address

Devices that have been paired with Windows or connected by another host and have stopped advertising do not appear in the scan list. In this case Connect by MAC can be used: enter a six-segment address such as `A4:C1:38:11:14:2B` and click Direct connect.

Direct connect does not rely on advertising; the backend connects through a device object already known to the system. Before using direct connect for the first time, Start scan must have been clicked once to initialize the adapters, otherwise the app prompts to scan first. When the address does not match the six-segment structure, the app performs a basic validation, shows an example and does not send it to the backend.

## GATT tree

When the connected device is being viewed, the service tree comes from the actual GATT discovery result; when an unconnected device or another device is viewed, only the service UUIDs carried in its advertising are shown, with a prompt that characteristics require a connection.

Service and characteristic names come from the Bluetooth SIG UUID tables, which contain 78 services and 512 characteristics. Services not present in the tables are shown as `Custom Service`, and characteristics not present show only their UUIDs.

Clicking a service row expands its characteristics, and the icons on a characteristic row indicate read, write, notify and indicate properties. `write` and `write_without_response` share one write icon, and the response mode is selected in the write panel. Expanding a characteristic row also shows its descriptors; descriptor permissions are fixed by the specification: `0x2901` is read-only, `0x2902` and `0x2903` are read-write, the rest follow the built-in table, and unknown descriptors are treated as read-only to avoid accidental writes to the device.

Clicking the notify or indicate icon subscribes or unsubscribes. After subscription, notifications are polled by the frontend every 250 ms; disconnecting clears the subscription state.

## Data log

The data log below the details records read, write, notification and descriptor operations for the current device connection:

- The log keeps at most 400 entries and is cleared by Clear; it is also cleared when switching devices or disconnecting, and retained when switching pages.
- Content that can be read as text is shown as text with a grey HEX suffix; binary content is shown as HEX.
- Notifications identify their source service and characteristic, for example `[Notification] 0x180A Device Information · 0x2A29:`.

The notification buffer has a limit: the backend queue holds at most 2000 entries and drops the oldest records with a counter when exceeded. The log displays a buffer overflow notice with the number of dropped entries.

## Write panel

Clicking the write icon on a characteristic opens the write panel on the right side of the device details. Each send card is bound to one target characteristic, or to a descriptor for descriptor writes; multiple cards pointing to different characteristics can exist at the same time.

Each card contains the following settings:

- Content: text or HEX. HEX ignores whitespace and a `0x` prefix; text supports `\r`, `\n`, `\t` and `\\` escapes.
- Line ending: CRLF, LF, CR or none, appended in text mode only.
- Write type: with response or without response, depending on the properties supported by the characteristic.
- Repeat sending: sends repeatedly at the configured interval, from 20 to 60000 ms, default 1000 ms. When enabled the card is locked, and closing the panel, disconnecting or a failed send in any round stops repeating.

Both successful and failed sends are written to the data log; on failure the input is retained so it can be corrected and resent. Press `Esc` to close the entire write panel.

## Time service

The app recognizes the Current Time Service (`0x1805`):

| Characteristic | Length | Content |
|---|---|---|
| `0x2A2B` | 10 bytes | Current time |
| `0x2A0F` | 2 bytes | Time zone and daylight saving time |
| `0x2A14` | 4 bytes | Time source, accuracy and time since last update |

When these values are read or received, the data log appends a readable line after the raw HEX, for example:

```
→ 2026-12-17T15:45:58.500Z (Thursday) · device clock is ahead of this computer …
```

Fields are recognized by length: decoding is performed only when the length matches, otherwise no guess is made. When a field is not provided, is out of range or uses a reserved value, the UI shows "not provided"; `0` is a valid value and is not used to mean "unknown". After subscription, changes to the device clock can be observed.

## Device names

After a successful connection, Windows overwrites the device name with a system-cached name. That name may differ from the name actually advertised by the device and may never have been used by the device, so the UI does not treat it as the primary name and does not display it separately.

The name displayed by the UI follows the advertised name; the system name is used only when the device does not advertise a name at all. To confirm the name reported by the device, read the Device Name characteristic (`0x2A00`) under the `0x1800` service.

## Pairing

WinRT pairing is initiated only when the connection error is confirmed to be insufficient authentication or encryption, or when the device is not paired; ordinary timeouts or an out-of-range device do not trigger the pairing flow.

During pairing the app shows an in-app pairing window covering four cases: confirm on the device, display a pairing code to the user, compare the same pairing code on both ends, or enter the pairing code shown on the device in the app. The backend waits at most 60 seconds, and a timeout is treated as cancel.

After successful pairing the app reconnects once. A device that is already paired is treated as successful; when a device does not support custom pairing, the app reports that the pairing code cannot be confirmed in the app.

## Troubleshooting

- No devices in the scan list: when a device is paired with Windows, connected by another host or does not advertise at all, it does not appear in the list; use Connect by MAC.
- The device is in range but is not discovered: set the scan duration to 30 seconds or continuous; low-power peripherals can advertise at intervals of several seconds, which requires a longer scan window.
- RSSI shows —: after a connected device stops advertising no new RSSI is produced, and the list keeps showing —. To refresh signal strength, disconnect and scan again, or run another scan.
- A write fails: check the MTU first; with the default MTU of 23 the payload is 20 bytes, and long data must be sent in parts. The details header shows the current MTU and payload size.

## Peripheral mode

BLE peripheral mode has been removed. The adapter reports support for the peripheral role, but advertising could not be started in testing, so the feature was removed rather than keeping an entry that does not work. Only the central role is supported.
