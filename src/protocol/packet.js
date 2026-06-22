// Wire-protocol constants verified from BLE snoop log.
// SERVICE_TX=0x1F is used by the phone app for all CD packets (MEDIA_MANAGEMENT,
// FILE_TRANSFER, SYSTEM_INFO). DC_ACKs from the phone use service=0x20.

const START_MARKER = 0xCD
const DC_MARKER    = 0xDC
const SERVICE_TX   = 0x1F   // phone -> badge (verified from snoop log)
const PROTO_VER    = 0x01

const MODULE = {
   FILE_TRANSFER:    0x01,
   MEDIA_MANAGEMENT: 0x02,
   SYSTEM_INFO:      0x03,
}

const CMD = {
   REQUEST:             0x00,
   TRANSFER_COMPLETE:   0x06,   // FILE_TRANSFER: phone→badge, payload=[fileId 8B][crc32 4B]
   VERIFICATION_RESULT: 0x0E,   // FILE_TRANSFER: phone→badge, payload=[fileId 8B][success 1B]
}

// Error codes from com.baji.protocol.model.ErrorCode (APK decompile)
const ERROR_NAMES = {
   0x01: 'INVALID_PACKET',
   0x02: 'UNSUPPORTED_COMMAND',
   0x03: 'INVALID_PARAMETER',
   0x04: 'FILE_NOT_FOUND',
   0x05: 'FILE_TOO_LARGE',
   0x06: 'INSUFFICIENT_STORAGE',
   0x07: 'TRANSFER_TIMEOUT',
   0x08: 'CHECKSUM_MISMATCH',
   0x09: 'DEVICE_BUSY',
   0x0A: 'FILE_SIZE_MISMATCH',
   0x0B: 'VERIFICATION_FAILED',
   0x0C: 'INVALID_PAYLOAD',
   0xFF: 'UNKNOWN_ERROR',
}

// Returns the error name if argByte is a known badge error code, otherwise null.
function dcAckError(argByte) {
   return ERROR_NAMES[argByte] || null
}

// SYSTEM_INFO module commands (from APK decompile)
const CMD_SYS = {
   DEVICE_INFO_REQUEST:  0x00,
   DEVICE_INFO_RESPONSE: 0x01,
}

// Build a Baji CD-format packet to send to the badge.
// Layout: [CD][len_hi][len_lo][1F][01][module][plen_hi][plen_lo][cmd][payload...]
// content_len  = payload.length + 6
// plen_field   = payload.length + 1
function buildPacket(moduleId, command, payload) {
   if (!payload) payload = Buffer.alloc(0)
   const contentLen      = payload.length + 6
   const payloadLenField = payload.length + 1
   const buf = Buffer.allocUnsafe(9 + payload.length)
   buf[0] = START_MARKER
   buf.writeUInt16BE(contentLen & 0xFFFF, 1)   // mask: large payloads wrap; badge uses announce size for reassembly
   buf[3] = SERVICE_TX
   buf[4] = PROTO_VER
   buf[5] = moduleId
   buf.writeUInt16BE(payloadLenField & 0xFFFF, 6)
   buf[8] = command
   if (payload.length > 0) payload.copy(buf, 9)
   return buf
}

// Build a DC-format acknowledgment packet (always 8 bytes).
// Layout: [DC][00][05][service][01][00][0C][01]
// Used for file-transfer step ACKs (service=0x20).
function buildDcAck(serviceByte) {
   if (serviceByte === undefined) serviceByte = 0x20
   return Buffer.from([0xDC, 0x00, 0x05, serviceByte, 0x01, 0x00, 0x0C, 0x01])
}

// Module-specific argBytes for acknowledging badge CD responses (from snoop log).
const MODULE_ACK_ARG = {
   0x01: 0x0C,  // FILE_TRANSFER
   0x02: 0x28,  // MEDIA_MANAGEMENT
   0x03: 0x12,  // SYSTEM_INFO
   0x0C: 0x1E,  // post-transfer notification (btsnoop: dc0005150c001e01)
}

// Modules whose DC ack uses service=0x15 instead of the default 0x20.
const MODULE_ACK_SERVICE = {
   0x0C: 0x15,
}

// Build a DC-format ack for a specific badge module response (8 bytes).
// Layout: [DC][00][05][svc][module][00][argByte][01]
// Service byte defaults to 0x20; module=0x0C uses 0x15 (verified from btsnoop).
function buildModuleAck(moduleId) {
   const arg = MODULE_ACK_ARG[moduleId] !== undefined ? MODULE_ACK_ARG[moduleId] : 0x0C
   const svc = MODULE_ACK_SERVICE[moduleId] || 0x20
   return Buffer.from([0xDC, 0x00, 0x05, svc, moduleId, 0x00, arg, 0x01])
}

// Build a compact 8-byte query packet (verified from snoop: list/info requests use this format).
// Layout: [CD][00][05][20][01][module][cmd][00]
function buildCompactPacket(moduleId, cmd) {
   return Buffer.from([0xCD, 0x00, 0x05, 0x20, 0x01, moduleId, cmd & 0xFF, 0x00])
}

// Parse a notification Buffer received from the badge.
// Returns a structured object or null on unrecognized input.
function parseNotification(buf) {
   if (!buf || buf.length < 4) return null

   if (buf[0] === DC_MARKER) {
      // DC ack/error: [DC][00][05][service][module][00][argByte][lastByte]
      // lastByte=0x00 is provisional; lastByte=0x01 is final.
      // argByte=known error code → badge error response.
      if (buf.length < 8) return null
      return {
         type:     'dc_ack',
         service:  buf[3],
         module:   buf[4],
         byte5:    buf[5],
         argByte:  buf[6],
         lastByte: buf[7],
      }
   }

   if (buf[0] === START_MARKER) {
      if (buf.length < 9) return null
      const payload = buf.length > 9 ? buf.slice(9) : Buffer.alloc(0)
      return {
         type:     'cd_packet',
         service:  buf[3],
         moduleId: buf[5],
         command:  buf[8],
         payload,
      }
   }

   return null
}

// MEDIA_MANAGEMENT pre-announce payload (16 bytes).
// Bytes 10-11 carry (fileSize + 4) as a big-endian 16-bit value.
// Verified from snoop: 25829-byte JPEG → bytes[10-11] = 0x64E9 (= 25833 = 25829+4).
// The +4 corresponds to the 4-byte trailing field at the end of the two-part transfer.
function buildMediaManagementPayload(fileSize) {
   const buf = Buffer.from([
      0x00, 0x15, 0xa2, 0x02,
      0x08, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,  // bytes 10-11: filled below (16-bit), 12-13: zero
      0x00, 0x00, 0x00, 0x00,
   ])
   buf.writeUInt16BE(fileSize + 4, 10)
   return buf
}

// CRC32 of the JPEG data bytes (matches java.util.zip.CRC32 used in the APK).
function computeCrc32(jpegData) {
   return require('zlib').crc32(jpegData) >>> 0
}

// TRANSFER_START payload: [0x01][fileSize BE 4 bytes][jpeg_data][last4 BE 4 bytes]
// last4 = bytesum(magic1 + fileSize_bytes + jpeg) as uint32 BE.
// The badge validates last4 on receipt before accepting the commit (SYSTEM_INFO).
// Missing last4 causes the badge to send FT status=1 and reject the SYSTEM_INFO commit.
function buildTransferStartPayload(jpegData) {
   const sz = jpegData.length
   let bsum = 1  // magic1=0x01
   bsum += ((sz >>> 24) & 0xFF) + ((sz >>> 16) & 0xFF) + ((sz >>> 8) & 0xFF) + (sz & 0xFF)
   for (let i = 0; i < jpegData.length; i++) bsum += jpegData[i]
   const last4 = bsum >>> 0  // uint32
   const buf = Buffer.allocUnsafe(1 + 4 + sz + 4)
   buf[0] = 0x01
   buf.writeUInt32BE(sz, 1)
   jpegData.copy(buf, 5)
   buf.writeUInt32BE(last4, 5 + sz)
   return buf
}

// Confirmed from 3 single-part transfers: SYSTEM_INFO = bytesum(fileSize_bytes + jpeg) & 0xFFFFFF
// Equals (last4 - magic1) since last4 = bytesum(magic1 + fileSize_bytes + jpeg) as uint32.
function buildSystemInfoPayload(jpegData) {
   const sz = jpegData.length
   let bsum = ((sz >>> 24) & 0xFF) + ((sz >>> 16) & 0xFF) + ((sz >>> 8) & 0xFF) + (sz & 0xFF)
   for (let i = 0; i < jpegData.length; i++) bsum += jpegData[i]
   return Buffer.from([(bsum >>> 16) & 0xFF, (bsum >>> 8) & 0xFF, bsum & 0xFF])
}

// TRANSFER_COMPLETE payload: [fileId 8B BE][crc32 4B BE]
// Sent after JPEG upload in TLV two-phase protocol (APK: sendTransferCompleteWithChecksum).
function buildTransferCompletePayload(fileId, crc32) {
   const buf = Buffer.allocUnsafe(12)
   buf.writeBigUInt64BE(BigInt(fileId), 0)
   buf.writeUInt32BE(crc32 >>> 0, 8)
   return buf
}

module.exports = {
   MODULE,
   CMD,
   CMD_SYS,
   dcAckError,
   buildPacket,
   buildDcAck,
   buildModuleAck,
   buildCompactPacket,
   parseNotification,
   buildMediaManagementPayload,
   buildTransferStartPayload,
   buildTransferCompletePayload,
   buildSystemInfoPayload,
   computeCrc32,
}
