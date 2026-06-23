# ebadge

Push JPEG images to a BW01 e-ink badge (360×360 display) over BLE. Supports a CLI for scripting and a browser-based UI for interactive use.

> **Platform:** macOS only. BLE support depends on `@abandonware/noble`, which uses CoreBluetooth.

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

The image is resized to 360×360 and JPEG-compressed to fit within the badge's 24 KB limit before sending.

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
