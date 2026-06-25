# ebadge

Push JPEG images to a BW01 LCD badge (360×360 display) over BLE. Supports a CLI for scripting and a browser-based UI for interactive use.

> **Primary platform:** macOS. BLE support depends on `@abandonware/noble`. See [Platform notes](#platform-notes) for Linux and Windows.

## Device details

This app was developed and tested targeting the following hardware and firmware:

| Field | Value |
|-------|-------|
| Name | BW01 |
| Manufacturer | LJ733\_V1\_BadgeOK |
| Firmware | V33940 |
| Hardware | LJ733\_MB\_V1.1 |
| Screen | 360 × 360 px |

## Other badges

If you are looking for code to control an E87 badge, then see this github project instead:

  https://github.com/hybridherbst/web-bluetooth-e87

## Installation

```bash
npm install
```

This compiles a native Node add-on for BLE. You will need Xcode Command Line Tools (`xcode-select --install`) and must grant Bluetooth permission to Terminal (System Settings → Privacy & Security → Bluetooth) the first time you run a command.

## CLI

### Send an image

```bash
node src/index.js send <image-file> [badge-name]
```

- `image-file` — any format Sharp can decode (JPEG, PNG, WebP, …)
- `badge-name` — optional; scans for a BLE device whose name contains this string (default: `BW01`)

The image is resized to 360×360 and JPEG-compressed to fit within the badge's 24.5 KB limit before sending.

### Check battery level

```bash
node src/index.js battery [badge-name]
```

## Web server

```bash
npm run server             # scans for any device named BW01
npm run server -- MyBadge  # scans for a device whose name contains "MyBadge"
```

The server starts on **http://localhost:3000** and connects to the badge in the background. It reconnects automatically if the badge disconnects.

## Web app

Open **http://localhost:3000** in a browser.

### Status header

The header shows live badge status:
- **Green dot** — connected and ready
- **Amber dot** (pulsing) — scanning / connecting
- **Red dot** — disconnected

Battery level, model, firmware, and screen resolution are displayed once connected.

### Sending an image

1. **Drop an image** onto the drop zone, or click it to open a file picker.
2. The image opens in a **crop editor**. Draw a square selection by dragging. To reposition it, drag from inside the selection. Press **Escape** to clear the selection and use the full image instead.
3. A **360×360 thumbnail** on the right shows a live preview of exactly what will be sent to the badge.
4. Click **Send to Badge** to transfer. The button shows progress and the result (quality percentage and final file size) when done.

### Tips

- Transfers fail if the badge battery is low or the badge is charging — check the battery gauge before sending.
- The badge cycles through all stored images automatically. New images are appended; there is no way to delete individual images over BLE.
- The image is sent as a full-color JPEG regardless of the source format.

## Platform notes

### Linux

`@abandonware/noble` supports Linux via BlueZ and works well with no code changes needed.

1. Install BlueZ and build tools:
   ```bash
   sudo apt-get install bluetooth libbluetooth-dev build-essential
   ```
2. Grant the node binary raw socket access (or run as root):
   ```bash
   sudo setcap cap_net_raw+eip $(which node)
   ```
3. Run `npm install` and use the app normally.

### Windows

Noble's Windows support is experimental. Two options:

- **`@abandonware/noble` with WinRT** — requires Windows 10+ and a compatible BLE adapter. May work without code changes but is not well tested.
- **Switch BLE libraries** — replacing `@abandonware/noble` with a library that has mature Windows support (such as `webbluetooth`) would be more reliable but requires rewriting `src/ble/BleClient.js`.

| Platform | Effort | Code changes |
|----------|--------|-------------|
| macOS | Ready to run | None |
| Linux | Low — a few setup steps | None |
| Windows | High — library may need replacing | `BleClient.js` rewrite if switching libraries |
