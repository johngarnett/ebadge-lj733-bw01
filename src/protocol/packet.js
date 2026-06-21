// Wire-protocol constants observed from BLE snoop log analysis.
// Service byte (byte[3]) = 0x1F for phone->badge packets.
// Badge->phone CD-format packets use 0x20; DC-format acks use 0x1F.

const START_MARKER = 0xCD
const DC_MARKER    = 0xDC
const SERVICE_TX   = 0x25   // phone -> badge (observed from badge echo byte)
const PROTO_VER    = 0x01

const MODULE = {
   FILE_TRANSFER:    0x01,
   MEDIA_MANAGEMENT: 0x02,
   SYSTEM_INFO:      0x03,
}

// All observed protocol commands use command byte 0x00
const CMD = {
   REQUEST: 0x00,
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
   buf.writeUInt16BE(contentLen, 1)
   buf[3] = SERVICE_TX
   buf[4] = PROTO_VER
   buf[5] = moduleId
   buf.writeUInt16BE(payloadLenField, 6)
   buf[8] = command
   if (payload.length > 0) payload.copy(buf, 9)
   return buf
}

// Build a DC-format acknowledgment packet (always 8 bytes).
// Layout: [DC][00][05][service][01][00][0C][01]
// service = 0x20 for file-transfer acks, 0x1F for initial media-mgmt ack
function buildDcAck(serviceByte) {
   if (serviceByte === undefined) serviceByte = 0x20
   return Buffer.from([0xDC, 0x00, 0x05, serviceByte, 0x01, 0x00, 0x0C, 0x01])
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
// Bytes[10-11] carry (fileSize + 4) as a big-endian 16-bit value;
// the +4 accounts for the 4-byte checksum appended to the JPEG.
function buildMediaManagementPayload(fileSize) {
   const buf = Buffer.from([
      0x00, 0x15, 0xa2, 0x02,
      0x08, 0x00, 0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,             // filled below
      0x00, 0x00, 0x00, 0x00,
   ])
   const total = fileSize + 4
   buf[10] = (total >>> 8) & 0xFF
   buf[11] = total & 0xFF
   return buf
}

// Transfer checksum: simple unsigned byte-sum of
// [fileSize as 4 bytes BE] + [all jpeg bytes].  (type byte 0x01 is NOT included)
// Verified against a captured transfer in the BLE snoop log.
function computeChecksum(jpegData) {
   const sz = jpegData.length
   let sum  = 0
   sum += (sz >>> 24) & 0xFF
   sum += (sz >>> 16) & 0xFF
   sum += (sz >>>  8) & 0xFF
   sum +=  sz         & 0xFF
   for (const b of jpegData) sum += b
   return sum >>> 0
}

// TRANSFER_START payload:
// [0x01][fileSize BE 4 bytes][jpeg_data][checksum BE 4 bytes]
function buildTransferStartPayload(jpegData) {
   const chk = computeChecksum(jpegData)
   const sz  = jpegData.length
   const buf = Buffer.allocUnsafe(1 + 4 + sz + 4)
   let off = 0
   buf[off++] = 0x01
   buf.writeUInt32BE(sz, off)   ; off += 4
   jpegData.copy(buf, off)      ; off += sz
   buf.writeUInt32BE(chk, off)
   return buf
}

// SYSTEM_INFO post-transfer payload (3 bytes):
// [dcAckByte][checksum_byte2][checksum_byte3]
// dcAckByte = argByte from the badge's DC ack to MEDIA_MANAGEMENT.
// checksum bytes 2-3 = the lower two bytes of the 4-byte transfer checksum.
function buildSystemInfoPayload(dcAckByte, checksum) {
   return Buffer.from([
      dcAckByte,
      (checksum >>> 8) & 0xFF,
      checksum & 0xFF,
   ])
}

module.exports = {
   MODULE,
   CMD,
   CMD_SYS,
   dcAckError,
   buildPacket,
   buildDcAck,
   parseNotification,
   buildMediaManagementPayload,
   buildTransferStartPayload,
   buildSystemInfoPayload,
   computeChecksum,
}
