const START_MARKER    = 0xCD   // command packets  (app → badge)
const RESPONSE_MARKER = 0xDC   // response packets (badge → app)
const PRODUCT_ID      = 0x25
const PROTO_VER       = 0x01

const MODULE = {
   FILE_TRANSFER:    0x01,
   MEDIA_MANAGEMENT: 0x02,
   SYSTEM_INFO:      0x03,
}

const CMD_FILE = {
   TRANSFER_START:    0x00,
   TRANSFER_STOP:     0x01,
   TRANSFER_ACK:      0x02,
   TRANSFER_NACK:     0x03,
   NEXT_CHUNK_REQ:    0x04,
   RETRY_REQUEST:     0x05,
   TRANSFER_COMPLETE: 0x06,
   FILE_DATA:         0x0A,
   STATUS:            0x0B,
   RECEIVED_CHECKSUM: 0x0C,
   TOTAL_TRANSFERRED: 0x0D,
   VERIFICATION_RESULT: 0x0E,
}

const CMD_MEDIA = {
   LIST_REQUEST:                0x00,
   LIST_RESPONSE:               0x01,
   DELETE:                      0x02,
   INFO_REQUEST:                0x03,
   INFO_RESPONSE:               0x04,
   PREVIEW_REQUEST:             0x05,
   PREVIEW_RESPONSE:            0x06,
   PREVIEW_PUSH_REQUEST:        0x07,
   PREVIEW_PUSH_RESPONSE:       0x08,
   BACKGROUND_REQUEST:          0x09,
   BACKGROUND_RESPONSE:         0x0A,
   BACKGROUND_PUSH_REQUEST:     0x0B,
   BACKGROUND_PUSH_RESPONSE:    0x0C,
   ID_REQUEST:                  0x0D,
   ID_RESPONSE:                 0x0E,
   BATCH_PREVIEW_INFO_REQUEST:  0x0F,
   BATCH_PREVIEW_INFO_RESPONSE: 0x10,
   BATCH_PREVIEW_DATA_REQUEST:  0x11,
   BATCH_PREVIEW_DATA_RESPONSE: 0x12,
}

const FILE_TYPE = {
   IMAGE:     0x01,
   VIDEO:     0x02,
   ANIMATION: 0x03,
}

const MAX_CHUNK_SIZE = 200

function buildPacket(moduleId, command, payload = Buffer.alloc(0)) {
   const contentLen = payload.length + 6
   const payloadLenField = payload.length + 1
   const buf = Buffer.allocUnsafe(9 + payload.length)
   buf[0] = START_MARKER
   buf.writeUInt16BE(contentLen, 1)
   buf[3] = PRODUCT_ID
   buf[4] = PROTO_VER
   buf[5] = moduleId
   buf.writeUInt16BE(payloadLenField, 6)
   buf[8] = command
   if (payload.length > 0) payload.copy(buf, 9)
   return buf
}

function parsePacket(buf) {
   if (buf.length < 6) return null
   if (buf[3] !== PRODUCT_ID) return null

   if (buf[0] === START_MARKER && buf.length >= 9) {
      // Command format (app → badge):
      // CD contentLen(2) PRODUCT_ID PROTO_VER MODULE payloadLenField(2) CMD [payload...]
      return { moduleId: buf[5], command: buf[8], payload: buf.length > 9 ? buf.slice(9) : Buffer.alloc(0) }
   }

   if (buf[0] === RESPONSE_MARKER) {
      // Response format (badge → app):
      // DC contentLen(2) PRODUCT_ID MODULE CMD [payload...]
      return { moduleId: buf[4], command: buf[5], payload: buf.length > 6 ? buf.slice(6) : Buffer.alloc(0) }
   }

   return null
}

// Build the TRANSFER_START payload from a FileInfo descriptor
function buildFileInfoPayload(fileId, fileSize, fileType, checksum, filename = 'image.jpg') {
   const nameBuf = Buffer.from(filename, 'utf8')
   const metaBuf = Buffer.alloc(0)
   const buf = Buffer.allocUnsafe(8 + 4 + 1 + 4 + 4 + 4 + nameBuf.length + 4 + metaBuf.length)
   let offset = 0
   buf.writeBigInt64BE(BigInt(fileId), offset);      offset += 8
   buf.writeInt32BE(fileSize, offset);               offset += 4
   buf[offset++] = fileType
   buf.writeInt32BE(checksum, offset);               offset += 4
   buf.writeInt32BE(Math.floor(Date.now() / 1000), offset); offset += 4
   buf.writeInt32BE(nameBuf.length, offset);         offset += 4
   nameBuf.copy(buf, offset);                        offset += nameBuf.length
   buf.writeInt32BE(metaBuf.length, offset);         offset += 4
   return buf
}

// Build the FILE_DATA payload for one chunk
function buildChunkPayload(fileId, chunkIndex, chunkData, isLast) {
   const buf = Buffer.allocUnsafe(8 + 4 + 4 + 1 + chunkData.length)
   let offset = 0
   buf.writeBigInt64BE(BigInt(fileId), offset);      offset += 8
   buf.writeInt32BE(chunkIndex, offset);             offset += 4
   buf.writeInt32BE(chunkData.length, offset);       offset += 4
   buf[offset++] = isLast ? 0x01 : 0x00
   chunkData.copy(buf, offset)
   return buf
}

// Parse a NEXT_CHUNK_REQUEST payload from the badge
function parseNextChunkRequest(payload) {
   if (payload.length < 12) return null
   return {
      fileId:     Number(payload.readBigInt64BE(0)),
      chunkIndex: payload.readInt32BE(8),
   }
}

module.exports = {
   MODULE,
   CMD_FILE,
   CMD_MEDIA,
   FILE_TYPE,
   MAX_CHUNK_SIZE,
   buildPacket,
   parsePacket,
   buildFileInfoPayload,
   buildChunkPayload,
   parseNextChunkRequest,
}
