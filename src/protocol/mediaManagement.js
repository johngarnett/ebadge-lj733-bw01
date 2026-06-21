const { EventEmitter } = require('events')
const { MODULE, CMD_MEDIA, buildPacket, parsePacket } = require('./packet')

const CMD_TIMEOUT_MS = 5000

class MediaManagement extends EventEmitter {
   constructor(bleClient) {
      super()
      this._ble     = bleClient
      this._pending = null   // { cmdIn, resolve, reject, timer, parser }
      this._ble.onNotify(buf => this._onNotify(buf))
   }

   // Resolves with an array of MediaFileInfo objects
   requestList() {
      return this._send(CMD_MEDIA.LIST_REQUEST, CMD_MEDIA.LIST_RESPONSE, null, parseMediaList)
   }

   // Resolves with a single MediaFileInfo object
   requestInfo(mediaId) {
      return this._send(
         CMD_MEDIA.INFO_REQUEST, CMD_MEDIA.INFO_RESPONSE,
         mediaIdBuf(mediaId),
         buf => parseMediaInfo(buf, 0).info
      )
   }

   // Resolves with { mediaId, success, message }
   deleteMedia(mediaId) {
      return this._send(CMD_MEDIA.DELETE, CMD_MEDIA.DELETE, mediaIdBuf(mediaId), parseStatusResponse)
   }

   // Resolves with { mediaId, data: Buffer|null }
   requestPreview(mediaId) {
      return this._send(CMD_MEDIA.PREVIEW_REQUEST, CMD_MEDIA.PREVIEW_RESPONSE, mediaIdBuf(mediaId), parseDataResponse)
   }

   // Resolves with { mediaId, data: Buffer|null }
   requestBackground(mediaId) {
      return this._send(CMD_MEDIA.BACKGROUND_REQUEST, CMD_MEDIA.BACKGROUND_RESPONSE, mediaIdBuf(mediaId), parseDataResponse)
   }

   // Ask the badge to allocate a new media ID. Resolves with { mediaId, success, message }.
   requestMediaId() {
      return this._send(CMD_MEDIA.ID_REQUEST, CMD_MEDIA.ID_RESPONSE, null, parseStatusResponse)
   }

   // Resolves with { pendingIds: number[], previews: [{ mediaId, data }] }
   requestBatchPreviewInfo() {
      return this._send(
         CMD_MEDIA.BATCH_PREVIEW_INFO_REQUEST,
         CMD_MEDIA.BATCH_PREVIEW_INFO_RESPONSE,
         null,
         parseBatchPreviewInfo
      )
   }

   // ── private ──────────────────────────────────────────────────────────────

   _send(cmdOut, cmdIn, payload, parser) {
      if (this._pending) {
         return Promise.reject(new Error('A media management command is already in progress'))
      }
      return new Promise((resolve, reject) => {
         const timer = setTimeout(() => {
            this._pending = null
            reject(new Error(`Timeout waiting for response to media command 0x${cmdOut.toString(16)}`))
         }, CMD_TIMEOUT_MS)

         this._pending = { cmdOut, cmdIn, resolve, reject, timer, parser }
         this._ble.write(buildPacket(MODULE.MEDIA_MANAGEMENT, cmdOut, payload || Buffer.alloc(0)))
      })
   }

   _onNotify(buf) {
      const pkt = parsePacket(buf)
      if (!pkt || pkt.moduleId !== MODULE.MEDIA_MANAGEMENT) return

      const p = this._pending
      // Badge echoes the request command byte in error/short responses; also accept the
      // designated response command byte for normal successful responses.
      if (!p || (pkt.command !== p.cmdIn && pkt.command !== p.cmdOut)) return

      this._pending = null
      clearTimeout(p.timer)

      const err = decodeError(pkt.payload)
      if (err) {
         p.reject(new Error(`Badge error: ${err}`))
         return
      }

      try {
         p.resolve(p.parser(pkt.payload))
      } catch (parseErr) {
         p.reject(parseErr)
      }
   }
}

// ── parsers ──────────────────────────────────────────────────────────────────

// Parse one MediaFileInfo record from buf starting at offset.
// Returns { info, nextOffset }.
function parseMediaInfo(buf, offset) {
   const mediaId     = Number(buf.readBigInt64BE(offset))
   const filenameLen = buf.readInt32BE(offset + 8)
   const fileName    = buf.toString('utf8', offset + 12, offset + 12 + filenameLen)
   const t           = offset + 12 + filenameLen   // base of fixed-size fields after filename
   const fileSize       = buf.readInt32BE(t)
   const fileType       = buf[t + 4]
   const checksum       = buf.readInt32BE(t + 5)
   const timestamp      = buf.readInt32BE(t + 9)
   const previewSize    = buf.readInt32BE(t + 13)
   const backgroundSize = buf.readInt32BE(t + 17)
   const metadataLen    = buf.readInt32BE(t + 21)
   const metadata       = metadataLen > 0
      ? parseMetadata(buf.toString('utf8', t + 25, t + 25 + metadataLen))
      : {}
   return {
      info: { mediaId, fileName, fileSize, fileType, checksum, timestamp, previewSize, backgroundSize, metadata },
      nextOffset: t + 25 + metadataLen,
   }
}

// MEDIA_LIST_RESPONSE: concatenated MediaFileInfo records
function parseMediaList(buf) {
   const list = []
   let offset = 0
   while (offset < buf.length) {
      const { info, nextOffset } = parseMediaInfo(buf, offset)
      list.push(info)
      offset = nextOffset
   }
   return list
}

// Used by MEDIA_DELETE and MEDIA_ID_RESPONSE
function parseStatusResponse(buf) {
   return {
      mediaId: Number(buf.readBigInt64BE(0)),
      success: buf[8] !== 0,
      message: buf.length > 9 ? buf.toString('utf8', 9) : '',
   }
}

// Used by MEDIA_PREVIEW_RESPONSE and MEDIA_BACKGROUND_RESPONSE
function parseDataResponse(buf) {
   const dataSize = buf.readInt32BE(8)
   return {
      mediaId: Number(buf.readBigInt64BE(0)),
      data:    dataSize > 0 ? buf.slice(12, 12 + dataSize) : null,
   }
}

// MEDIA_BATCH_PREVIEW_INFO_RESPONSE
function parseBatchPreviewInfo(buf) {
   const pendingCount = buf.readInt32BE(0)
   let offset = 4
   const pendingIds = []
   for (let i = 0; i < pendingCount; i++) {
      pendingIds.push(Number(buf.readBigInt64BE(offset)))
      offset += 8
   }

   const previewCount = buf.readInt32BE(offset)
   offset += 4
   const previews = []
   for (let i = 0; i < previewCount; i++) {
      const mediaId    = Number(buf.readBigInt64BE(offset))
      const dataSize   = buf.readInt32BE(offset + 8)
      const data       = dataSize > 0 ? buf.slice(offset + 12, offset + 12 + dataSize) : null
      previews.push({ mediaId, data })
      offset += 12 + dataSize
   }

   return { pendingIds, previews }
}

// Badge error codes (from com.baji.protocol.model.ErrorCode)
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

// Returns an error name if the payload looks like a badge error response, null otherwise.
// Error responses are short (≤ 4 bytes) and start with a known non-zero error code.
function decodeError(payload) {
   if (payload.length === 0 || payload.length > 4) return null
   const code = payload[0]
   return ERROR_NAMES[code] || null
}

// Metadata is key=value pairs separated by ;
function parseMetadata(str) {
   const result = {}
   for (const pair of str.split(';')) {
      const eq = pair.indexOf('=')
      if (eq !== -1) result[pair.slice(0, eq)] = pair.slice(eq + 1)
   }
   return result
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mediaIdBuf(mediaId) {
   const buf = Buffer.allocUnsafe(8)
   buf.writeBigInt64BE(BigInt(mediaId))
   return buf
}

module.exports = { MediaManagement }
