# Plan: Chunked BLE Transfer for Large Images

## Context
The web app (previous plan) is complete. The badge crashes when receiving JPEG files larger than ~25 KB
in a single stream. The APK implements a separate chunked protocol using `FILE_DATA` (cmd=0x0A)
packets where the badge pulls 200-byte chunks one at a time. This plan implements that protocol
so larger images (richer detail) can be sent without crashing the badge.

## NOTE

This plan is included for reference only. I was unable to make this protocol work with the LJ733 badge.

---

## Protocol Discovered from APK Decompile

### Command bytes (FileTransferCommand enum, fully verified)
| Name | Byte | Direction |
|------|------|-----------|
| TRANSFER_START | 0x00 | Phone→Badge |
| TRANSFER_ACK | 0x02 | Badge→Phone |
| NEXT_CHUNK_REQUEST | 0x04 | Badge→Phone |
| RETRY_REQUEST | 0x05 | Badge→Phone |
| TRANSFER_COMPLETE | 0x06 | Phone→Badge |
| FILE_DATA | 0x0A | Phone→Badge |
| VERIFICATION_RESULT | 0x0E | Badge→Phone |

### MediaManagementCommand (new ones used here)
- MEDIA_ID_REQUEST = 0x0D (Phone→Badge, no payload)
- MEDIA_ID_RESPONSE = 0x0E (Badge→Phone, payload=[mediaId 8B][success 1B])

### Full chunked protocol sequence
1. Phone → `MEDIA_ID_REQUEST` (module=0x02, cmd=0x0D, no payload)
2. Badge → `MEDIA_ID_RESPONSE` (module=0x02, cmd=0x0E, payload=[mediaId 8B][success 1B])
3. Phone → `TRANSFER_START` (module=0x01, cmd=0x00, 14-byte TLV payload)
4. Badge → `TRANSFER_ACK` (module=0x01, cmd=0x02)
5. Phone → `FILE_DATA` chunk 0 (module=0x01, cmd=0x0A, ChunkInfo payload)
6. Badge → `NEXT_CHUNK_REQUEST` (module=0x01, cmd=0x04, payload=[fileId 8B][nextIdx 4B])
7. Repeat steps 5-6 for all chunks
8. Phone → `TRANSFER_COMPLETE` (module=0x01, cmd=0x06, payload=[fileId 8B][crc32 4B])
9. Badge → `VERIFICATION_RESULT` (module=0x01, cmd=0x0E, payload=[fileId 8B][success 1B])

### Packet payload formats

**TRANSFER_START TLV payload (14 bytes, from FileTransferService.buildFileInfoPayload):**
```
[0x07][fileSize 4B BE][0x08][0x01=IMAGE][0x0A][0x01=BACKGROUND][0x09][mediaId 4B BE]
```

**FILE_DATA ChunkInfo payload (from FileTransferService.buildChunkPayload):**
```
[fileId 8B BE][chunkIndex 4B BE][chunkSize 4B BE][isLastChunk 1B][chunkData ≤200B]
```
MAX_CHUNK_SIZE = 200 bytes (ProtocolConstants.MAX_CHUNK_SIZE)

**TRANSFER_COMPLETE payload (12 bytes, from sendTransferCompleteWithChecksum):**
```
[fileId 8B BE][crc32 4B BE]
```

**IDs:**
- `mediaId` = from MEDIA_ID_RESPONSE payload[0..7] cast to int32 (badge-assigned slot)
- `fileId` = `Date.now()` as uint64 (phone-generated per-transfer session ID)

---

## Files to Change

### 1. `src/protocol/packet.js`
Add constants and three new builder functions:

```javascript
const CMD_FT = {
  TRANSFER_ACK:        0x02,
  NEXT_CHUNK_REQUEST:  0x04,
  TRANSFER_COMPLETE:   0x06,
  FILE_DATA:           0x0A,
  VERIFICATION_RESULT: 0x0E,
}

// Phone→Badge: allocate a media slot
function buildMediaIdRequest() {
  return buildPacket(MODULE.MEDIA_MANAGEMENT, 0x0D, Buffer.alloc(0))
}

// Phone→Badge: announce the file (14-byte TLV)
function buildTransferStartPacketChunked(fileSize, mediaId) {
  const payload = Buffer.alloc(14)
  payload[0] = 0x07; payload.writeUInt32BE(fileSize, 1)
  payload[5] = 0x08; payload[6] = 0x01        // IMAGE
  payload[7] = 0x0A; payload[8] = 0x01        // BACKGROUND
  payload[9] = 0x09; payload.writeInt32BE(mediaId, 10)
  return buildPacket(MODULE.FILE_TRANSFER, 0x00, payload)
}

// Phone→Badge: one data chunk
function buildFileDataPacket(fileId, chunkIndex, chunkData, isLastChunk) {
  const payload = Buffer.allocUnsafe(17 + chunkData.length)
  payload.writeBigUInt64BE(BigInt(fileId), 0)
  payload.writeUInt32BE(chunkIndex, 8)
  payload.writeUInt32BE(chunkData.length, 12)
  payload[16] = isLastChunk ? 1 : 0
  chunkData.copy(payload, 17)
  return buildPacket(MODULE.FILE_TRANSFER, 0x0A, payload)
}
```

Export `CMD_FT`, `buildMediaIdRequest`, `buildTransferStartPacketChunked`, `buildFileDataPacket`.

### 2. `src/protocol/fileTransfer.js`
New constants at top:
```javascript
const SINGLE_PART_MAX = 24000  // safe threshold; badge crashes on single-stream >~25 KB
const CHUNK_SIZE      = 200    // matches APK MAX_CHUNK_SIZE
```

New instance fields in constructor: `_fileId = 0`, `_mediaId = 0`, `_chunks = []`, `_chunksSent = 0`

**`sendFile()` modified:** branch immediately after `preprocessImage()`:
```javascript
if (jpegData.length > SINGLE_PART_MAX) {
  return this._sendChunkedFile()
} else {
  return this._sendStreamingFile()  // existing code, renamed
}
```

**New `_sendChunkedFile()`:** sets up Promise, splits jpeg into 200-byte chunks stored in `this._chunks`,
sets `this._fileId = Date.now()`, sends `buildMediaIdRequest()`, sets state `wait_media_id`.

**New states in `_onNotify()`:**

| State | Packet match | Action |
|-------|-------------|--------|
| `wait_media_id` | module=0x02, cmd=0x0E | Parse `mediaId = payload.readInt32BE(4)` (lower 4B of the 8B field); send `buildTransferStartPacketChunked()`; → `wait_transfer_ack` |
| `wait_transfer_ack` | module=0x01, cmd=0x02 | Send chunk 0 via `_sendChunk(0)`; → `wait_chunk_ack` |
| `wait_chunk_ack` | module=0x01, cmd=0x04 (NEXT_CHUNK_REQUEST) | Read `nextIdx = payload.readUInt32BE(8)`; send `_sendChunk(nextIdx)`; if that was last chunk → `wait_verification` |
| `wait_chunk_ack` | module=0x01, cmd=0x02 (TRANSFER_ACK) | Badge confirmed last chunk; send TRANSFER_COMPLETE; → `wait_verification` |
| `wait_chunk_ack` | module=0x01, cmd=0x0E | Badge sent VERIFICATION_RESULT without waiting for TRANSFER_COMPLETE; parse & finish |
| `wait_chunk_ack` | module=0x01, cmd=0x05 (RETRY_REQUEST) | Read `retryIdx = payload.readUInt32BE(8)`; resend `_sendChunk(retryIdx)` |
| `wait_verification` | module=0x01, cmd=0x0E | Parse `success = payload[8]`; finish with null (success) or Error |

**`_sendChunk(index)`:** calls `buildFileDataPacket(this._fileId, index, chunkData, isLast)` and writes it. isLast = (index === this._chunks.length - 1).

**TRANSFER_COMPLETE** sent via existing `buildTransferCompletePayload(this._fileId, this._checksum)` (already in packet.js).

Timeouts use existing `_setState()` / `_resetTimer()` — same 12s step timeout, 30s for `wait_verification`.

---

## Risk
The badge (V33940) may not support this protocol. In that case `wait_media_id` times out in 12 s
and the user sees "Timeout in state wait_media_id" in the UI. Old streaming protocol is untouched.

---

## Verification
1. `npm run server`
2. Upload a JPEG that compresses to ≤24 KB → uses old path, succeeds as before (regression check)
3. Upload a high-detail 360×360 image that would compress to >24 KB → chunked path
4. Console should show: `→ MEDIA_ID_REQUEST`, `← MEDIA_ID_RESPONSE`, `→ TRANSFER_START`, `→ CHUNK 0/N`, `← NEXT_CHUNK_REQUEST`, …, `→ TRANSFER_COMPLETE`, `← VERIFICATION_RESULT ✓`
5. Confirm image appears on badge
