# Bluetooth

The Bluetooth panel covers the central role only: scan for nearby BLE devices, connect, read and write GATT characteristics, and subscribe to notifications and indications.

<GuideMedia
  src="/img/guide/ble.mp4"
  poster="/img/guide/ble.png"
  caption="The device list updates while the scan is running."
/>

## Panel layout

The left side is the device list, with the **Start scan / Stop scan** button, the scan duration dropdown, the connect-by-MAC input and the filter entry at the top. The right side is the device detail: advertising data, the GATT service tree and the data log. Clicking the write icon on a characteristic also opens the write panel to the right of the detail.

## Scanning

- Click **Start scan**. The button becomes **Stop scan**, and the list refreshes every 2 seconds, sorted from strongest to weakest RSSI.
- The scan duration can be 5, 15, 30 or 60 seconds, or continuous; the default is 15 seconds. The scan stops automatically and shows one message when the time is up; continuous keeps scanning until you stop it.
- With several Bluetooth adapters, all of them scan at the same time and their results are merged and de-duplicated by MAC address.
- The filter matches device names or MAC addresses and shows **N/M matched** above the list.
- If scanning fails or the system has no Bluetooth adapter, the list area shows **Bluetooth is not compatible on this computer**.

Each card shows the name, MAC address, RSSI value and a signal bar. A connected device that has stopped advertising is added back to the list and marked **Connected**, so the detail panel never goes blank. The device type (standard BLE, Apple, iBeacon, PC, Mesh) is derived by the backend from the advertising data and only affects the icon and label.

## Connecting

Clicking a device card only **selects** it and shows its details; the actual connection starts from **Connect device** in the detail panel.

- A connection latch prevents repeated clicks: while connecting, further clicks only show **Connecting, please wait…**.
- The backend has an explicit 10 second timeout and disconnects on timeout, so the state cannot stay ambiguous; the frontend adds a 15 second guard so the UI does not sit on **Connecting** forever.
- When the device is out of range or its random address has rotated, the error says the device is offline or the address changed; rescan and try again.
- On success the detail loads the GATT tree and MTU, notification polling (250 ms) and RSSI refresh (3 s) start, and the card is marked **Connected**.
- A successful connection also stops scanning. Scanning while connected is allowed, for example to look for the next device; the next connection stops the scan too.
- One device is connected at a time. **Disconnect device** drops the current connection and clears the service tree, subscription state, data log and write panel. The backend keeps the peripheral object so an immediate reconnect does not have to wait for advertising again.

When the device disconnects on its own (powered off, out of range, taken by another host), the RSSI poll reports the link state, the UI switches to disconnected, clears the current session data, and leaves one **Disconnected** line with the address.

## Connecting by MAC address

Devices that have been paired with Windows or connected by another host often stop advertising, so they never appear in the scan list. Use **Connect by MAC** instead: enter a six-segment address such as `A4:C1:38:11:14:2B` and click **Direct connect**.

- Direct connect does not rely on advertising; the backend reaches the device through an object the system already knows.
- Start a scan once first to initialise the adapters, otherwise the app asks you to scan before connecting.
- A malformed address only gets a six-segment check and an example; it is not sent to the backend.

## GATT tree

- When you are looking at the connected device, the tree comes from the real GATT discovery. When you look at an unconnected device or a different one, only the service UUIDs from its advertising are shown, with a hint that characteristics need a connection.
- Service and characteristic names come from the Bluetooth SIG UUID tables, which include 78 services and 512 characteristics. Unknown services are shown as `Custom Service`; unknown characteristics keep only the raw UUID; the app never guesses names.
- Click a service row to expand its characteristics. Icons on a characteristic row indicate read, write, notify and indicate.
- `write` and `write_without_response` share one write icon; the response mode is chosen in the write panel.
- Expanding a characteristic row also shows its descriptors. Descriptor permissions are fixed by the specification: `0x2901` is read-only, `0x2902` / `0x2903` are read-write, the rest follow the built-in table; unknown descriptors are treated as read-only so a device is never written by accident.
- Click the notify / indicate icon to subscribe or unsubscribe. Notifications are polled by the frontend every 250 ms; disconnecting clears the subscription state.

## Data log

The data log below the detail records reads, writes, notifications and descriptor operations for the current device and connection:

- It keeps the latest 400 entries. **Clear** empties it; switching device or disconnecting also clears it, while switching pages keeps it.
- Content that decodes as text is shown as text with a grey HEX suffix; binary content is shown as HEX.
- Notifications name their service and characteristic, for example `[Notification] 0x180A Device Information · 0x2A29:`.

The notification buffer is bounded: the backend queue holds at most 2000 entries, dropping the oldest and counting them. The log shows **⚠ N notifications dropped by buffer overflow** rather than pretending the data is complete.

## Write panel

Click the write icon on a characteristic to open the write panel to the right of the device detail. Each send card is bound to one target characteristic (or to a descriptor, for descriptor writes), and several cards can point at different characteristics at once.

Each card has its own settings:

- Payload: text or HEX. HEX ignores whitespace and a `0x` prefix; text supports `\r`, `\n`, `\t` and `\\` escapes.
- Line ending: CRLF, LF, CR or none; appended in text mode only.
- Write type: with response or without response, depending on what the characteristic supports.
- Repeat sending: send again at a fixed interval between 20 and 60000 ms, default 1000 ms. While repeating, the card is locked; closing the panel, disconnecting or a failed send stops it automatically.

Successful and failed sends are both written to the data log; a failure keeps the payload so it can be corrected and resent. Press `Esc` to close the whole write panel.

## Time service

The app recognises the Current Time Service (`0x1805`):

| Characteristic | Length | Content |
|---|---|---|
| `0x2A2B` | 10 bytes | Current time |
| `0x2A0F` | 2 bytes | Time zone and daylight saving time |
| `0x2A14` | 4 bytes | Time source, accuracy and time since last update |

When these values are read or received, the data log adds a readable line after the raw HEX, for example:

```
→ 2026-12-17T15:45:58.500Z (Thursday) · device clock is ahead of this computer …
```

Fields are recognised by length: a value is decoded only when its length matches exactly, otherwise the app does not guess. If a field was not provided, is out of range or uses a reserved value, the UI shows “not provided”; `0` is a valid value and is never used to mean “unknown”. After subscribing, you can watch the device clock change.

## Device names

After a connection is established, Windows overwrites the device name with a name cached by the system. That name may differ from what the device advertises and may never have been used by the device itself, so the UI neither treats it as the primary name nor displays it separately.

The UI shows the advertised name; the system name is only used as a fallback when the device does not advertise a name at all. To check the name a device reports, read the Device Name characteristic (`0x2A00`) under the `0x1800` service.

## Pairing

The app only starts WinRT pairing when the connection error really means insufficient authentication or encryption, or that the device is not paired. Ordinary timeouts or an out-of-range device never trigger the pairing ritual.

The app shows its own pairing dialog and covers four cases: confirm on the device, display a PIN for the user, compare a PIN shown on both ends, or enter the PIN shown on the device. The backend waits at most 60 seconds; a timeout counts as cancel.

A successful pairing reconnects once. A device that is already paired counts as success; a device that does not support custom pairing gets a message saying the PIN cannot be confirmed in the app.

## Troubleshooting

- **No devices in the scan list**: the device may have been paired with Windows, taken by another host, or simply not advertising; use **Connect by MAC**.
- **Nothing found although the device is nearby**: set the scan duration to 30 seconds or continuous; low-power peripherals can advertise at long intervals.
- **RSSI shows —**: connected devices often stop advertising, and without advertising packets there is no fresh RSSI, so the list may keep showing —. To refresh the signal strength, disconnect and scan again, or start another scan.
- **Writes fail**: check the MTU first. With the default MTU of 23 the payload is only 20 bytes, so long data must be split. The detail header shows the current MTU and payload size.

## Peripheral mode

BLE peripheral mode has been removed. The adapter reports support for the peripheral role, but advertising could not be started in testing, so the feature was removed rather than leaving an entry that does not work. Only the central role is supported.
