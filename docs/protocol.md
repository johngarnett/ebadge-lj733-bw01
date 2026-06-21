# LJ733 BW01 eBadge BLE Protocol

Reverse-engineered from `com.legend.smartwatch.electronicbadge.android` (SuperBand app).
Source: `com.baji.protocol` library within the APK.

---

## BLE GATT Services & Characteristics

| Role | UUID |
|------|------|
| Main service | `7E400001-B5A3-F393-E0A9-E50E24DCCA9D` |
| Write (app → badge) | `7E400002-B5A3-F393-E0A9-E50E24DCCA9D` |
| Notify (badge → app) | `7E400003-B5A3-F393-E0A9-E50E24DCCA9D` |
| Extra characteristic | `7E400004-B5A3-F393-E0A9-E50E24DCCA9D` |
| CCCD descriptor | `00002902-0000-1000-8000-00805F9B34FB` |
| Device Info service | `0000180A-0000-1000-8000-00805F9B34FB` |
| Battery service | `0000180F-0000-1000-8000-00805F9B34FB` |

**Setup:** Subscribe to notifications on `7E400003` (write `0x0100` to its CCCD).
All commands are written to `7E400002`. All responses arrive on `7E400003`.

---

## Packet Format

All multi-byte integers are **big-endian**.

```
Offset  Size  Field
  0      1    Start marker: 0xCD
  1      2    Content length = payload_len + 6  (uint16)
  3      1    Product ID: 0x25
  4      1    Protocol version: 0x01
  5      1    Module ID
  6      2    payload_len + 1  (uint16)
  8      1    Command byte
  9+     N    Payload
```

- Minimum packet: 9 bytes (empty payload).
- Maximum packet: 512 bytes → max payload = 503 bytes.
- Practical chunk size used by the app: **200 bytes** per FILE_DATA payload.

### Pseudo-code to build a packet

```python
def build_packet(module_id, command, payload=b''):
    content_len = len(payload) + 6
    payload_len_field = len(payload) + 1
    return (
        b'\xcd'
        + content_len.to_bytes(2, 'big')
        + b'\x25\x01'
        + bytes([module_id])
        + payload_len_field.to_bytes(2, 'big')
        + bytes([command])
        + payload
    )
```

---

## Module IDs

| Name | Value |
|------|-------|
| FILE_TRANSFER | `0x01` |
| MEDIA_MANAGEMENT | `0x02` |
| SYSTEM_INFO | `0x03` |

---

## File Transfer Commands (Module 0x01)

| Command | Value | Direction | Description |
|---------|-------|-----------|-------------|
| TRANSFER_START | `0x00` | app → badge | Begin transfer, send file metadata |
| TRANSFER_STOP | `0x01` | app → badge | Abort transfer |
| TRANSFER_ACK | `0x02` | badge → app | Acknowledged |
| TRANSFER_NACK | `0x03` | badge → app | Not acknowledged (retry or abort) |
| NEXT_CHUNK_REQUEST | `0x04` | badge → app | Badge requests a specific chunk index |
| RETRY_REQUEST | `0x05` | badge → app | Badge requests retransmit of current chunk |
| TRANSFER_COMPLETE | `0x06` | app → badge | All chunks sent |
| FILE_DATA | `0x0A` | app → badge | One chunk of file data |
| STATUS | `0x0B` | badge → app | Transfer status update |
| RECEIVED_CHECKSUM | `0x0C` | badge → app | Badge reports received checksum |
| TOTAL_TRANSFERRED | `0x0D` | badge → app | Badge reports total bytes received |
| VERIFICATION_RESULT | `0x0E` | badge → app | Badge reports checksum verification pass/fail |

---

## File Types

| Name | Value |
|------|-------|
| IMAGE | `0x01` |
| VIDEO | `0x02` |
| ANIMATION | `0x03` |

---

## Payload Formats

### TRANSFER_START payload (FileInfo)

```
Bytes  0– 7   fileId          int64, big-endian (arbitrary unique ID)
Bytes  8–11   fileSize        int32, big-endian (total bytes)
Byte  12      fileType        0x01=IMAGE, 0x02=VIDEO, 0x03=ANIMATION
Bytes 13–16   checksum        int32, big-endian (CRC32 of full file data)
Bytes 17–20   timestamp       int32, big-endian (Unix seconds)
Bytes 21–24   filenameLen     int32, big-endian
Bytes 25+     filename        UTF-8, filenameLen bytes
After filename:
  4 bytes     metadataLen     int32, big-endian
  N bytes     metadata        UTF-8, key=value pairs separated by ;
```

### FILE_DATA payload (ChunkInfo)

```
Bytes  0– 7   fileId          int64, big-endian (same as TRANSFER_START)
Bytes  8–11   chunkIndex      int32, big-endian (0-based)
Bytes 12–15   chunkSize       int32, big-endian (bytes in this chunk)
Byte  16      isLastChunk     0x01 if this is the final chunk, else 0x00
Bytes 17+     chunkData       raw file bytes for this chunk
```

### NEXT_CHUNK_REQUEST payload (badge → app)

```
Bytes  0– 7   fileId          int64, big-endian
Bytes  8–11   chunkIndex      int32, big-endian (index the badge wants next)
```

---

## Image Transfer Flow

```
App                                    Badge
 |                                       |
 |-- TRANSFER_START (FileInfo) --------> |
 |                                       |
 |<-- TRANSFER_ACK -------------------- |  (or TRANSFER_NACK → abort)
 |                                       |
 |-- FILE_DATA chunk 0 ----------------> |
 |-- FILE_DATA chunk 1 ----------------> |
 |-- FILE_DATA chunk 2 ----------------> |
 |   ... (200-byte chunks)               |
 |                                       |
 |    (badge may send at any time)       |
 |<-- NEXT_CHUNK_REQUEST (index N) ----- |  → resend chunk N
 |<-- RETRY_REQUEST ------------------- |  → resend last chunk
 |                                       |
 |-- TRANSFER_COMPLETE ----------------> |  (after last chunk)
 |                                       |
 |<-- TRANSFER_ACK -------------------- |
 |<-- VERIFICATION_RESULT ------------- |  (CRC32 pass/fail)
```

---

## Checksum

CRC32 using Java's `java.util.zip.CRC32` (standard IEEE polynomial, 0xEDB88320).
Computed over the entire raw file byte array.

---

## Example: Sending a JPEG image

```python
import struct, zlib, time

PRODUCT_ID   = 0x25
PROTO_VER    = 0x01
START_MARKER = 0xCD

MODULE_FILE_TRANSFER = 0x01
CMD_TRANSFER_START   = 0x00
CMD_FILE_DATA        = 0x0A
CMD_TRANSFER_COMPLETE= 0x06
FILE_TYPE_IMAGE      = 0x01
CHUNK_SIZE           = 200

def build_packet(module_id, command, payload=b''):
    content_len = len(payload) + 6
    return (bytes([START_MARKER])
            + content_len.to_bytes(2, 'big')
            + bytes([PRODUCT_ID, PROTO_VER, module_id])
            + (len(payload) + 1).to_bytes(2, 'big')
            + bytes([command])
            + payload)

def send_image(jpeg_bytes, ble_write):
    file_id   = int(time.time())
    checksum  = zlib.crc32(jpeg_bytes) & 0xFFFFFFFF
    timestamp = int(time.time())
    filename  = b'image.jpg'

    # Build TRANSFER_START payload
    meta = b''
    payload = (
        struct.pack('>q', file_id)        # fileId   (8)
        + struct.pack('>i', len(jpeg_bytes)) # fileSize (4)
        + bytes([FILE_TYPE_IMAGE])        # fileType (1)
        + struct.pack('>i', checksum)     # checksum (4)
        + struct.pack('>i', timestamp)    # timestamp(4)
        + struct.pack('>i', len(filename))# fnLen    (4)
        + filename                        # filename
        + struct.pack('>i', len(meta))    # metaLen  (4)
        + meta
    )
    ble_write(build_packet(MODULE_FILE_TRANSFER, CMD_TRANSFER_START, payload))
    # → wait for TRANSFER_ACK on notify characteristic

    # Send chunks
    offset = 0
    idx = 0
    while offset < len(jpeg_bytes):
        chunk = jpeg_bytes[offset:offset + CHUNK_SIZE]
        is_last = 0x01 if (offset + CHUNK_SIZE >= len(jpeg_bytes)) else 0x00
        chunk_payload = (
            struct.pack('>q', file_id)
            + struct.pack('>i', idx)
            + struct.pack('>i', len(chunk))
            + bytes([is_last])
            + chunk
        )
        ble_write(build_packet(MODULE_FILE_TRANSFER, CMD_FILE_DATA, chunk_payload))
        offset += CHUNK_SIZE
        idx += 1

    ble_write(build_packet(MODULE_FILE_TRANSFER, CMD_TRANSFER_COMPLETE))
    # → wait for TRANSFER_ACK + VERIFICATION_RESULT
```

---

## Media Management Commands (Module 0x02)

| Command | Value | Direction | Description |
|---------|-------|-----------|-------------|
| MEDIA_LIST_REQUEST | `0x00` | app → badge | Request list of all stored media files |
| MEDIA_LIST_RESPONSE | `0x01` | badge → app | Returns list of MediaFileInfo records |
| MEDIA_DELETE | `0x02` | app → badge | Delete a media file by ID; badge echoes result |
| MEDIA_INFO_REQUEST | `0x03` | app → badge | Request metadata for a specific file |
| MEDIA_INFO_RESPONSE | `0x04` | badge → app | Returns one MediaFileInfo record |
| MEDIA_PREVIEW_REQUEST | `0x05` | app → badge | Request thumbnail/preview bytes for a file |
| MEDIA_PREVIEW_RESPONSE | `0x06` | badge → app | Returns preview image bytes |
| MEDIA_PREVIEW_PUSH_REQUEST | `0x07` | app → badge | Push a preview to the badge |
| MEDIA_PREVIEW_PUSH_RESPONSE | `0x08` | badge → app | Acknowledgement of pushed preview |
| MEDIA_BACKGROUND_REQUEST | `0x09` | app → badge | Request background image bytes for a file |
| MEDIA_BACKGROUND_RESPONSE | `0x0A` | badge → app | Returns background image bytes |
| MEDIA_BACKGROUND_PUSH_REQUEST | `0x0B` | app → badge | Push a background image to the badge |
| MEDIA_BACKGROUND_PUSH_RESPONSE | `0x0C` | badge → app | Acknowledgement of pushed background |
| MEDIA_ID_REQUEST | `0x0D` | app → badge | Request badge to allocate a new media ID |
| MEDIA_ID_RESPONSE | `0x0E` | badge → app | Returns the newly allocated media ID |
| MEDIA_BATCH_PREVIEW_INFO_REQUEST | `0x0F` | app → badge | Request batch preview info |
| MEDIA_BATCH_PREVIEW_INFO_RESPONSE | `0x10` | badge → app | Returns pending IDs + available previews |
| MEDIA_BATCH_PREVIEW_DATA_REQUEST | `0x11` | app → badge | Request batch preview data (not fully documented) |
| MEDIA_BATCH_PREVIEW_DATA_RESPONSE | `0x12` | badge → app | Returns batch preview data (not fully documented) |

---

## Media Management Payload Formats

### Request payloads (app → badge)

Most app-side requests carry only an 8-byte mediaId, or no payload at all:

| Command | Payload |
|---------|---------|
| MEDIA_LIST_REQUEST | _(empty)_ |
| MEDIA_DELETE | `mediaId` — int64, big-endian (8 bytes) |
| MEDIA_INFO_REQUEST | `mediaId` — int64, big-endian (8 bytes) |
| MEDIA_PREVIEW_REQUEST | `mediaId` — int64, big-endian (8 bytes) |
| MEDIA_BACKGROUND_REQUEST | `mediaId` — int64, big-endian (8 bytes) |
| MEDIA_ID_REQUEST | _(empty)_ |

### MEDIA_DELETE response (badge → app)

```
Bytes  0– 7   mediaId         int64, big-endian (the ID that was deleted)
Byte   8      success         0x01 = success, 0x00 = failure
Bytes  9+     message         UTF-8 string (optional, describes the result)
```

### MediaFileInfo wire format (used in MEDIA_LIST_RESPONSE and MEDIA_INFO_RESPONSE)

The list response concatenates zero or more of these records back-to-back:

```
Bytes  0– 7   mediaId         int64, big-endian
Bytes  8–11   filenameLen     int32, big-endian
Bytes 12+     filename        UTF-8, filenameLen bytes

After filename (offset T = 12 + filenameLen):
  T+ 0..T+ 3   fileSize        int32, big-endian (total bytes)
  T+ 4         fileType        uint8 (0x01=IMAGE, 0x02=VIDEO, 0x03=ANIMATION)
  T+ 5..T+ 8   checksum        int32, big-endian (CRC32)
  T+ 9..T+12   timestamp       int32, big-endian (Unix seconds)
  T+13..T+16   previewSize     int32, big-endian (bytes of stored preview; 0 if none)
  T+17..T+20   backgroundSize  int32, big-endian (bytes of stored background; 0 if none)
  T+21..T+24   metadataLen     int32, big-endian
  T+25+        metadata        UTF-8, key=value pairs separated by ;
```

### MEDIA_PREVIEW_RESPONSE / MEDIA_BACKGROUND_RESPONSE (badge → app)

Both responses share the same shape:

```
Bytes  0– 7   mediaId         int64, big-endian
Bytes  8–11   dataSize        int32, big-endian (number of bytes that follow)
Bytes 12+     data            raw bytes (JPEG thumbnail or background image)
```

### MEDIA_ID_RESPONSE (badge → app)

```
Bytes  0– 7   mediaId         int64, big-endian (newly allocated ID)
Byte   8      success         0x01 = success, 0x00 = failure
Bytes  9+     message         UTF-8 string (optional)
```

### MEDIA_BATCH_PREVIEW_INFO_RESPONSE (badge → app)

```
Section 1 — IDs that have no preview yet:
  Bytes 0– 3   pendingCount    int32, big-endian
  For each (8 bytes × pendingCount):
    mediaId     int64, big-endian

Section 2 — IDs that have preview data ready:
  4 bytes      previewCount   int32, big-endian
  For each entry:
    8 bytes    mediaId        int64, big-endian
    4 bytes    previewSize    int32, big-endian
    N bytes    previewData    raw bytes
```

---

## Delete Flow

```
App                                    Badge
 |                                       |
 |-- MEDIA_DELETE (mediaId) -----------> |
 |                                       |
 |<-- MEDIA_DELETE (id + success + msg)- |
```

---

## Notes

- The BLE write characteristic has **no response** (WriteNoResponse) for data chunks; the
  TRANSFER_START likely uses Write with Response or relies on protocol-level ACK.
- The app uses a 4000 ms command timeout and retries up to 10 times per packet.
- Large payloads that exceed the BLE MTU are automatically split by the `CommandPool`
  before writing — the MTU negotiation determines the actual write size.
- The `7E400001` service UUID is a variant of the Nordic UART Service (which uses `6E400001`).
- `MEDIA_ID_REQUEST` / `MEDIA_ID_RESPONSE` let the badge allocate a canonical mediaId before a
  transfer begins. The current `fileTransfer.js` uses `Date.now()` as a client-side ID instead,
  which appears to work but may conflict with IDs the badge tracks internally.
- `MEDIA_BATCH_PREVIEW_DATA_REQUEST` and `MEDIA_BATCH_PREVIEW_DATA_RESPONSE` (0x11/0x12) are
  present in the APK but their handlers are stubs — payload format not yet determined.
