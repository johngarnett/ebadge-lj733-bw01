const fs   = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const {
   MODULE, CMD,
   buildPacket, buildDcAck, parseNotification,
   buildMediaManagementPayload, buildTransferStartPayload,
   buildSystemInfoPayload, computeChecksum,
} = require('./packet')

// Maximum bytes of Baji data per ATT Write Command.
// Derived from the observed 490-byte ATT MTU (490 - 3 = 487).
// Using 512 here; the OS L2CAP layer handles HCI fragmentation transparently.
const WRITE_CHUNK_SIZE = 512

// How long to wait for each expected badge response.
const STEP_TIMEOUT_MS = 8000

// ── transfer state machine ────────────────────────────────────────────────────
//
// Protocol flow (observed in BLE snoop log):
//
//  1. Phone → Badge: MEDIA_MANAGEMENT request (announces incoming file size)
//  2. Badge → Phone: DC ack  [dc 00 05 1f 02 00 XX 01]  (XX = badge ID byte)
//  3. Badge → Phone: FILE_TRANSFER status, payload value ~1000
//  4. Phone → Badge: DC ack  [dc 00 05 20 01 00 0c 01]
//  5. Phone → Badge: TRANSFER_START  (full JPEG + checksum, fragmented)
//  6. Badge → Phone: FILE_TRANSFER status, payload value ~1001
//  7. Phone → Badge: DC ack
//  8. Phone → Badge: SYSTEM_INFO  [dcAckByte, chk[2], chk[3]]
//  9. Badge → Phone: FILE_TRANSFER status, payload value 2  (done)
// 10. Phone → Badge: DC ack

class FileTransfer extends EventEmitter {
   constructor(bleClient) {
      super()
      this._ble      = bleClient
      this._resolve  = null
      this._reject   = null
      this._timer    = null
      this._state    = 'idle'
      this._dcAckByte = 0
      this._checksum  = 0
   }

   async sendFile(filePath) {
      const jpegData = fs.readFileSync(filePath)
      const filename  = path.basename(filePath)
      this._checksum  = computeChecksum(jpegData)

      console.log(`Preparing ${filename} (${jpegData.length} bytes, checksum=0x${this._checksum.toString(16).toUpperCase()})`)

      return new Promise((resolve, reject) => {
         this._resolve = resolve
         this._reject  = reject

         this._ble.onNotify(buf => this._onNotify(buf))

         this._sendMediaManagement(jpegData.length)
         this._setState('wait_dc_ack', 'MEDIA_MANAGEMENT sent, awaiting DC ack')

         this._jpegData = jpegData
      })
   }

   // ── private ────────────────────────────────────────────────────────────────

   _onNotify(buf) {
      const pkt = parseNotification(buf)
      if (!pkt) {
         console.log(`  ← [raw] ${buf.toString('hex')}`)
         return
      }

      if (pkt.type === 'dc_ack') {
         console.log(`  ← DC_ACK service=0x${pkt.service.toString(16)} module=0x${pkt.module.toString(16)} argByte=0x${pkt.argByte.toString(16).padStart(2,'0')}`)
         this._handleDcAck(pkt)
         return
      }

      // CD-format status packet from badge
      if (pkt.type === 'cd_packet' && pkt.moduleId === MODULE.FILE_TRANSFER) {
         const val = pkt.payload.length >= 4 ? pkt.payload.readUInt32BE(0) : -1
         console.log(`  ← FILE_TRANSFER status value=${val}`)
         this._handleStatus(val)
         return
      }

      console.log(`  ← unhandled pkt type=${pkt.type} module=0x${(pkt.moduleId||0).toString(16)}`)
   }

   _handleDcAck(pkt) {
      if (this._state !== 'wait_dc_ack') return
      this._clearTimer()
      this._dcAckByte = pkt.argByte
      console.log(`  (badge assigned ID byte 0x${this._dcAckByte.toString(16).padStart(2,'0')})`)
      this._setState('wait_status_1000', 'waiting for FILE_TRANSFER status ~1000')
   }

   _handleStatus(val) {
      switch (this._state) {
         case 'wait_status_1000':
            this._clearTimer()
            this._sendDcAck(0x20)
            this._sendTransferStart()
            this._setState('wait_status_1001', 'TRANSFER_START sent, waiting for status ~1001')
            break

         case 'wait_status_1001':
            this._clearTimer()
            this._sendDcAck(0x20)
            this._sendSystemInfo()
            this._setState('wait_status_2', 'SYSTEM_INFO sent, waiting for status 2')
            break

         case 'wait_status_2':
            this._clearTimer()
            this._sendDcAck(0x20)
            console.log('  Transfer complete ✓')
            this._finish(null)
            break

         default:
            console.log(`  (unexpected status ${val} in state ${this._state})`)
      }
   }

   _sendMediaManagement(fileSize) {
      const payload = buildMediaManagementPayload(fileSize)
      const pkt     = buildPacket(MODULE.MEDIA_MANAGEMENT, CMD.REQUEST, payload)
      console.log(`→ MEDIA_MANAGEMENT (fileSize=${fileSize})`)
      this._ble.write(pkt)
   }

   _sendDcAck(serviceByte) {
      const ack = buildDcAck(serviceByte)
      console.log(`→ DC_ACK service=0x${serviceByte.toString(16)}`)
      this._ble.write(ack)
   }

   _sendTransferStart() {
      const payload = buildTransferStartPayload(this._jpegData)
      const pkt     = buildPacket(MODULE.FILE_TRANSFER, CMD.REQUEST, payload)
      console.log(`→ TRANSFER_START (${pkt.length} bytes total, sending in ${WRITE_CHUNK_SIZE}-byte chunks)`)
      this._writeChunked(pkt)
   }

   _sendSystemInfo() {
      const payload = buildSystemInfoPayload(this._dcAckByte, this._checksum)
      const pkt     = buildPacket(MODULE.SYSTEM_INFO, CMD.REQUEST, payload)
      console.log(`→ SYSTEM_INFO [${payload.toString('hex')}]`)
      this._ble.write(pkt)
   }

   // Fragment a large buffer into WRITE_CHUNK_SIZE slices and write each one.
   // The badge reassembles consecutive ATT writes into the full Baji packet.
   _writeChunked(buf) {
      let offset = 0
      let chunkNum = 0
      const total = Math.ceil(buf.length / WRITE_CHUNK_SIZE)
      while (offset < buf.length) {
         const chunk = buf.slice(offset, offset + WRITE_CHUNK_SIZE)
         this._ble.write(chunk)
         offset += chunk.length
         chunkNum++
      }
      console.log(`  (sent ${chunkNum}/${total} chunks)`)
   }

   _setState(newState, logMsg) {
      this._state = newState
      console.log(`  [${newState}] ${logMsg}`)
      this._clearTimer()
      this._timer = setTimeout(() => {
         this._finish(new Error(`Timeout in state ${newState}`))
      }, STEP_TIMEOUT_MS)
   }

   _clearTimer() {
      if (this._timer) {
         clearTimeout(this._timer)
         this._timer = null
      }
   }

   _finish(err) {
      this._clearTimer()
      this._state   = 'idle'
      const resolve = this._resolve
      const reject  = this._reject
      this._resolve = null
      this._reject  = null
      if (err) {
         console.error(`Transfer failed: ${err.message}`)
         if (reject) reject(err)
      } else {
         if (resolve) resolve()
      }
   }
}

module.exports = { FileTransfer }
