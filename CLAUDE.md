# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Node.js tool for pushing JPEG images to a BW01 e-ink badge over BLE. The badge uses a JL/Jieli LJ733 chip and speaks a proprietary protocol over Nordic UART Service (NUS). The protocol was discovered by examining Bluetooth snoop traces and by examining the Android APK.

## Commands

```bash
# CLI: send an image
node src/index.js send <image-file> [badge-name]

# CLI: check battery level
node src/index.js battery [badge-name]

# Web UI + REST API (badge name optional, defaults to BW01)
npm run server [-- BW01]
# then open http://localhost:3000
```

No test suite. No linter configured.

## Architecture

```
src/
  index.js              CLI entry point (send, battery commands)
  server.js             Express REST API + serves src/web/index.html
  web/index.html        Single-page browser UI (crop, preview, send)
  ble/
    BleClient.js        noble wrapper — scan, connect, write, notify callbacks
  protocol/
    packet.js           All packet builders and the notification parser
    fileTransfer.js     State machine that drives the full image transfer sequence
    deviceQuery.js      CAPS_QUERY and STORAGE_QUERY (compact packet format)
```

`BleClient` emits raw notify bytes to registered callbacks. `FileTransfer` registers one such callback and drives the transfer state machine. `server.js` creates one `BleClient` + `FileTransfer` on startup and reuses them across HTTP requests.

## BLE protocol — verified facts

**This is the ground truth.** `docs/protocol.md` is an APK-derived reference but describes an unverified chunked protocol that does NOT work on this badge. Use the notes below and the comments in `fileTransfer.js` instead.

### Services and characteristics

| Role | UUID |
|------|------|
| Write (app → badge) | `7E400002-...` |
| Notify (badge → app) | `7E400003-...` |
| Extra notify | `7E400004-...` |

Both notify characteristics dispatch to the same callback pool.

### Packet formats

**CD packet (app → badge):**
`[CD][len_hi][len_lo][service][01][moduleId][plen_hi][plen_lo][cmd][payload...]`
- service=`0x1F` for file transfer and media management (full packets via `buildPacket`)
- service=`0x20` for CAPS_QUERY and STORAGE_QUERY (compact 8-byte packets via `buildCompactPacket`)

**DC ack (app → badge):** `[DC][00][05][svc][moduleId][00][argByte][01]` — built by `buildModuleAck(moduleId)` or `buildDcAck(0x20)`.

**Module IDs:** FILE_TRANSFER=`0x01`, MEDIA_MANAGEMENT=`0x02`, SYSTEM_INFO=`0x03`

### Verified transfer sequence

The full sequence is documented in the comment block at the top of `fileTransfer.js`. High-level:

1. CAPS_QUERY (compact, module=0x02) → badge returns screen info → DC ack
2. STORAGE_QUERY (compact, module=0x03) → badge returns storage info → DC ack
3. MEDIA_MANAGEMENT announce (service=0x1F, 16-byte payload with fileSize+4 at bytes 10-11)
4. Badge replies via one of two paths:
   - **Path A** (badge has available slots): FT status < 1000 → DC_ACK → send JPEG stream → mod=0x0C → SYSTEM_INFO commit
   - **Path B** (badge full): DC_ACK(MM) → FT status=1000 → DC_ACK → send JPEG stream → FT status=1001 → DC_ACK → SYSTEM_INFO commit
5. Badge confirms with FT status=2

JPEG payload format: `[0x01][fileSize 4B BE][jpeg_bytes][last4 4B BE]` where `last4 = bytesum(0x01 + fileSize_bytes + jpeg_bytes) as uint32`.

SYSTEM_INFO payload (3 bytes): `bytesum(fileSize_bytes + jpeg_bytes) & 0xFFFFFF` = `(last4 - 1) & 0xFFFFFF`.

The full JPEG packet is sent as a stream of 487-byte BLE ATT writes via `_writeChunked()`.

### What the badge does NOT support over BLE

- File listing, file count, file delete, file metadata — not exposed. The companion app tracks uploads client-side. `docs/protocol.md` documents these commands from the APK but they return DEVICE_BUSY on this badge.
- The chunked file transfer protocol (MEDIA_ID_REQUEST → TRANSFER_START → FILE_DATA chunks) from `docs/file-xfer-2-part.md` was attempted and did not work.

### Known operational constraints

- Transfers fail when the badge battery is low or when the badge is charging.
- module=0x0C packets arrive spontaneously ~every 46s and must be ACKed with `buildModuleAck(0x0C)` (service=0x15).

### Image preprocessing

`preprocessImage()` in `fileTransfer.js` resizes the input to 360×360, then binary-searches JPEG quality (7 iterations) to find the highest quality whose encoded size is ≤ `SINGLE_PART_MAX` (24996 bytes). It accepts an optional `crop` region `{x, y, size}` in source-image pixels applied before resize.
