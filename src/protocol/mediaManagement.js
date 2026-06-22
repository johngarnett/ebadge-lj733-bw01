// NOTE: The list/info/delete commands in this module use packet formats
// derived from APK decompile only and have NOT been verified against
// the actual badge protocol via snoop log capture. Use with caution.

const { EventEmitter } = require('events')
const { MODULE, CMD, buildPacket, buildModuleAck, parseNotification, dcAckError } = require('./packet')

const CMD_MEDIA = {
   LIST_REQUEST:                0x00,
   LIST_RESPONSE:               0x01,
   DELETE:                      0x02,
   INFO_REQUEST:                0x03,
   INFO_RESPONSE:               0x04,
   PREVIEW_REQUEST:             0x05,
   PREVIEW_RESPONSE:            0x06,
   ID_REQUEST:                  0x0D,
   ID_RESPONSE:                 0x0E,
}

const CMD_TIMEOUT_MS = 5000

class MediaManagement extends EventEmitter {
   constructor(bleClient) {
      super()
      this._ble     = bleClient
      this._pending = null
      this._ble.onNotify(buf => this._onNotify(buf))
   }

   requestList() {
      return this._send(CMD_MEDIA.LIST_REQUEST, CMD_MEDIA.LIST_RESPONSE, null, parseMediaList)
   }

   requestInfo(mediaId) {
      return this._send(
         CMD_MEDIA.INFO_REQUEST, CMD_MEDIA.INFO_RESPONSE,
         mediaIdBuf(mediaId),
         buf => parseMediaInfo(buf, 0).info
      )
   }

   deleteMedia(mediaId) {
      return this._send(CMD_MEDIA.DELETE, CMD_MEDIA.DELETE, mediaIdBuf(mediaId), parseStatusResponse)
   }

   requestMediaId() {
      return this._send(CMD_MEDIA.ID_REQUEST, CMD_MEDIA.ID_RESPONSE, null, parseStatusResponse)
   }

   _send(cmdOut, cmdIn, payload, parser) {
      if (this._pending) {
         return Promise.reject(new Error('A media management command is already in progress'))
      }
      return new Promise((resolve, reject) => {
         const timer = setTimeout(() => {
            this._pending = null
            reject(new Error(`Timeout waiting for media command 0x${cmdOut.toString(16)} response`))
         }, CMD_TIMEOUT_MS)

         this._pending = { cmdOut, cmdIn, resolve, reject, timer, parser }
         this._ble.write(buildPacket(MODULE.MEDIA_MANAGEMENT, cmdOut, payload || Buffer.alloc(0)))
      })
   }

   _onNotify(buf) {
      const p = this._pending
      if (!p) return
      const pkt = parseNotification(buf)
      if (!pkt) return

      if (pkt.type === 'dc_ack') {
         // Only act on the final dc_ack (lastByte=0x01) to avoid double-reject.
         if (pkt.module !== MODULE.MEDIA_MANAGEMENT || pkt.lastByte !== 0x01) return
         const errName = dcAckError(pkt.argByte)
         if (errName) {
            this._pending = null
            clearTimeout(p.timer)
            p.reject(new Error(`Badge error: ${errName}`))
         }
         return
      }

      if (pkt.type !== 'cd_packet') return
      if (pkt.moduleId !== MODULE.MEDIA_MANAGEMENT) return
      if (pkt.command !== p.cmdIn && pkt.command !== p.cmdOut) return

      // Send module ack before resolving (verified from snoop: phone always acks badge responses).
      this._ble.write(buildModuleAck(MODULE.MEDIA_MANAGEMENT))

      this._pending = null
      clearTimeout(p.timer)

      try {
         p.resolve(p.parser(pkt.payload))
      } catch (parseErr) {
         p.reject(new Error(`Response parse failed: ${parseErr.message}`))
      }
   }
}

// ── parsers ──────────────────────────────────────────────────────────────────

function parseMediaInfo(buf, offset) {
   const mediaId     = Number(buf.readBigInt64BE(offset))
   const filenameLen = buf.readInt32BE(offset + 8)
   const fileName    = buf.toString('utf8', offset + 12, offset + 12 + filenameLen)
   const t           = offset + 12 + filenameLen
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

function parseStatusResponse(buf) {
   return {
      mediaId: Number(buf.readBigInt64BE(0)),
      success: buf[8] !== 0,
      message: buf.length > 9 ? buf.toString('utf8', 9) : '',
   }
}

function parseMetadata(str) {
   const result = {}
   for (const pair of str.split(';')) {
      const eq = pair.indexOf('=')
      if (eq !== -1) result[pair.slice(0, eq)] = pair.slice(eq + 1)
   }
   return result
}

function mediaIdBuf(mediaId) {
   const buf = Buffer.allocUnsafe(8)
   buf.writeBigInt64BE(BigInt(mediaId))
   return buf
}

module.exports = { MediaManagement }
