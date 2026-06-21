const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')
const { createHash } = require('crypto')
const { EventEmitter } = require('events')

const {
   MODULE, CMD_FILE, FILE_TYPE, MAX_CHUNK_SIZE,
   buildPacket, parsePacket,
   buildFileInfoPayload, buildChunkPayload, parseNextChunkRequest,
} = require('./packet')

const ACK_TIMEOUT_MS   = 5000
const CHUNK_DELAY_MS   = 20   // small gap between chunks to avoid flooding the BLE queue

class FileTransfer extends EventEmitter {
   constructor(bleClient) {
      super()
      this._ble    = bleClient
      this._fileId = null
      this._chunks = null
      this._resolve = null
      this._reject  = null
      this._ackTimer = null
      this._waitingForAck = false
   }

   // Public: send a JPEG (or any image) file to the badge
   async sendFile(filePath) {
      const data     = fs.readFileSync(filePath)
      const filename = path.basename(filePath)
      const fileSize = data.length
      const checksum = crc32(data)
      const fileId   = Date.now()   // unique enough for our purposes

      console.log(`Sending ${filename} (${fileSize} bytes, CRC32=0x${(checksum >>> 0).toString(16)})`)

      this._fileId = fileId
      this._chunks = splitChunks(data, MAX_CHUNK_SIZE)

      return new Promise((resolve, reject) => {
         this._resolve = resolve
         this._reject  = reject

         this._ble.onNotify(buf => this._onNotify(buf))

         const fileInfoPayload = buildFileInfoPayload(
            fileId, fileSize, FILE_TYPE.IMAGE, checksum >>> 0, filename
         )
         const startPacket = buildPacket(MODULE.FILE_TRANSFER, CMD_FILE.TRANSFER_START, fileInfoPayload)

         console.log('→ TRANSFER_START')
         this._waitForAck('TRANSFER_START')
         this._ble.write(startPacket)
      })
   }

   _onNotify(buf) {
      const pkt = parsePacket(buf)
      if (!pkt || pkt.moduleId !== MODULE.FILE_TRANSFER) return

      this._clearAckTimer()

      switch (pkt.command) {
         case CMD_FILE.TRANSFER_ACK:
            this._handleAck()
            break
         case CMD_FILE.TRANSFER_NACK:
            this._fail('Badge sent TRANSFER_NACK')
            break
         case CMD_FILE.NEXT_CHUNK_REQ: {
            const req = parseNextChunkRequest(pkt.payload)
            if (req) {
               console.log(`← NEXT_CHUNK_REQUEST idx=${req.chunkIndex}`)
               this._sendChunk(req.chunkIndex)
            }
            break
         }
         case CMD_FILE.RETRY_REQUEST:
            console.log('← RETRY_REQUEST — resending last chunk')
            this._sendChunk(this._lastChunkIndex)
            break
         case CMD_FILE.VERIFICATION_RESULT:
            if (pkt.payload.length > 0 && pkt.payload[0] === 0x01) {
               console.log('← VERIFICATION_RESULT: pass ✓')
               this._resolve()
            } else {
               this._fail('Checksum verification failed on badge')
            }
            break
         case CMD_FILE.STATUS:
            this.emit('status', pkt.payload)
            break
         default:
            console.log(`← unknown command 0x${pkt.command.toString(16)}`)
      }
   }

   _handleAck() {
      if (this._pendingComplete) {
         // ACK after TRANSFER_COMPLETE — wait for VERIFICATION_RESULT, which may
         // arrive as a separate packet; if badge sends both together, resolve here
         console.log('← TRANSFER_ACK (post-complete)')
         this._pendingComplete = false
         return
      }
      console.log('← TRANSFER_ACK — starting chunk stream')
      this._sendAllChunks()
   }

   async _sendAllChunks() {
      for (let i = 0; i < this._chunks.length; i++) {
         this._lastChunkIndex = i
         await this._sendChunk(i)
         if (i < this._chunks.length - 1) await sleep(CHUNK_DELAY_MS)
      }
      console.log('→ TRANSFER_COMPLETE')
      this._pendingComplete = true
      this._waitForAck('TRANSFER_COMPLETE')
      this._ble.write(buildPacket(MODULE.FILE_TRANSFER, CMD_FILE.TRANSFER_COMPLETE))
   }

   _sendChunk(index) {
      const chunk  = this._chunks[index]
      const isLast = index === this._chunks.length - 1
      const payload = buildChunkPayload(this._fileId, index, chunk, isLast)
      console.log(`→ FILE_DATA chunk ${index + 1}/${this._chunks.length} (${chunk.length} bytes)${isLast ? ' [LAST]' : ''}`)
      this._ble.write(buildPacket(MODULE.FILE_TRANSFER, CMD_FILE.FILE_DATA, payload))
   }

   _waitForAck(label) {
      this._waitingForAck = true
      this._ackTimer = setTimeout(() => {
         this._fail(`Timeout waiting for ACK after ${label}`)
      }, ACK_TIMEOUT_MS)
   }

   _clearAckTimer() {
      if (this._ackTimer) {
         clearTimeout(this._ackTimer)
         this._ackTimer = null
      }
   }

   _fail(reason) {
      this._clearAckTimer()
      console.error(`Transfer failed: ${reason}`)
      if (this._reject) this._reject(new Error(reason))
      this._resolve = null
      this._reject  = null
   }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function splitChunks(buf, size) {
   const chunks = []
   for (let offset = 0; offset < buf.length; offset += size) {
      chunks.push(buf.slice(offset, offset + size))
   }
   return chunks
}

// CRC32 using Node's built-in zlib checksum (matches Java's java.util.zip.CRC32)
function crc32(buf) {
   return zlib.crc32(buf)
}

function sleep(ms) {
   return new Promise(r => setTimeout(r, ms))
}

module.exports = { FileTransfer }
