const path = require('path')
const { EventEmitter } = require('events')

const {
   MODULE, CMD_SYS,
   buildPacket, buildDcAck, buildCompactPacket, buildModuleAck, parseNotification,
   buildMediaManagementPayload, buildTransferStartPayload,
   buildSystemInfoPayload, computeCrc32,
} = require('./packet')

const BADGE_IMAGE_SIZE = 360
const WRITE_CHUNK_SIZE = 487
const STEP_TIMEOUT_MS       = 12000
const FINAL_STEP_TIMEOUT_MS = 30000

// ── Streaming protocol (verified + end-to-end tested) ────────────────────────
//
//  0a. CAPS_QUERY (module=0x02 compact) → capabilities → DC module ack
//  0b. STORAGE_QUERY (module=0x03 compact) → storage info → DC module ack
//   1. MEDIA_MANAGEMENT payload bytes[10-11] = (fileSize + 4) as uint16 BE
//
//  Path A (empty badge): FT status=N  (N < 1000, slot assigned)
//  Path B (badge with files): DC_ACK(MM) → FT status=1000
//
//   2. DC_ACK
//   3. JPEG payload: [0x01][fileSize 4B BE][jpeg_bytes][last4 4B BE]
//      last4 = bytesum(magic1 + fileSize_bytes + jpeg_bytes) as uint32
//      (badge validates last4; missing last4 causes rejection at step 7)
//   4. FT status=1001  (all data received)
//   5. DC_ACK
//   6. SYSTEM_INFO cmd=0x00, payload = 3 bytes
//      SYSTEM_INFO = (last4 - 1) & 0xFFFFFF = bytesum(fileSize_bytes + jpeg_bytes)
//   7. FT status=2  (committed to cycling gallery ✓)
//   8. DC_ACK

class FileTransfer extends EventEmitter {
   constructor(bleClient) {
      super()
      this._ble           = bleClient
      this._resolve       = null
      this._reject        = null
      this._timer         = null
      this._state         = 'idle'
      this._slotId        = 0
      this._checksum           = 0
      this._jpegData           = null
      this._allWritesSent      = false
      this._pendingCommit      = false   // status=1001 arrived while writes in flight
      this._pendingMod0cCommit = false   // mod=0x0C arrived while writes in flight (Path A)
   }

   async sendFile(filePath) {
      const filename = path.basename(filePath)
      console.log(`Preprocessing ${filename} → ${BADGE_IMAGE_SIZE}×${BADGE_IMAGE_SIZE} JPEG…`)
      const jpegData = await preprocessImage(filePath)
      this._checksum = computeCrc32(jpegData)
      this._jpegData = jpegData

      console.log(`Sending ${filename} (${jpegData.length} bytes, crc32=0x${this._checksum.toString(16).toUpperCase()})`)

      return new Promise((resolve, reject) => {
         this._resolve = resolve
         this._reject  = reject

         this._allWritesSent      = false
         this._pendingMod0cCommit = false
         this._pendingCommit = false
         this._ble.onNotify(buf => this._onNotify(buf))

         console.log('→ CAPS_QUERY')
         this._ble.write(buildCompactPacket(MODULE.MEDIA_MANAGEMENT, 0x00))
         this._setState('wait_caps', 'Capabilities query sent')
      })
   }

   _onNotify(buf) {
      const pkt = parseNotification(buf)
      if (!pkt) {
         console.log(`  ← [raw] ${buf.toString('hex')}`)
         return
      }

      if (this._state === 'wait_caps') {
         if (pkt.type === 'cd_packet' && pkt.moduleId === MODULE.MEDIA_MANAGEMENT) {
            console.log(`  ← caps [${buf.toString('hex')}]`)
            this._clearTimer()
            this._ble.write(buildModuleAck(MODULE.MEDIA_MANAGEMENT))
            console.log('→ STORAGE_QUERY')
            this._ble.write(buildCompactPacket(MODULE.SYSTEM_INFO, 0x00))
            this._setState('wait_storage', 'Storage query sent')
         } else if (pkt.type === 'cd_packet') {
            console.log(`  ← [wait_caps] unsolicited mod=0x${pkt.moduleId.toString(16)} — ACKing [${buf.toString('hex')}]`)
            this._ble.write(buildModuleAck(pkt.moduleId))
            this._resetTimer()
         } else {
            console.log(`  ← [wait_caps] unexpected ${pkt.type} [${buf.toString('hex')}]`)
         }
         return
      }

      if (this._state === 'wait_storage') {
         if (pkt.type === 'cd_packet' && pkt.moduleId === MODULE.SYSTEM_INFO) {
            console.log(`  ← storage [${buf.toString('hex')}]`)
            this._clearTimer()
            this._ble.write(buildModuleAck(MODULE.SYSTEM_INFO))
            this._sendMediaManagement()
            this._setState('wait_mm_ack', 'MM announce sent')
         } else if (pkt.type === 'cd_packet') {
            console.log(`  ← [wait_storage] unsolicited mod=0x${pkt.moduleId.toString(16)} — ACKing [${buf.toString('hex')}]`)
            this._ble.write(buildModuleAck(pkt.moduleId))
            this._resetTimer()
         } else {
            console.log(`  ← [wait_storage] unexpected ${pkt.type} [${buf.toString('hex')}]`)
         }
         return
      }

      if (pkt.type === 'dc_ack') {
         const argHex  = pkt.argByte.toString(16).padStart(2, '0')
         const lastHex = pkt.lastByte.toString(16).padStart(2, '0')
         console.log(`  ← DC svc=0x${pkt.service.toString(16)} mod=0x${pkt.module.toString(16)} arg=0x${argHex} last=0x${lastHex} [${buf.toString('hex')}]`)
         this._handleDcAck(pkt)
         return
      }

      if (pkt.type === 'cd_packet' && pkt.moduleId === MODULE.FILE_TRANSFER) {
         const len = pkt.payload.length
         const val = len > 0 ? pkt.payload.readUIntBE(0, Math.min(len, 6)) : -1
         console.log(`  ← FT status=${val} [${buf.toString('hex')}]`)
         this._handleFtStatus(val)
         return
      }

      // Module 0x0C in wait_data_ack = Path A "JPEG received" signal (replaces status=1001
      // for badge-with-files transfers). Send correct service=0x15 ack, then commit.
      if (pkt.type === 'cd_packet' && pkt.moduleId === 0x0C && this._state === 'wait_data_ack') {
         console.log(`  ← mod=0x0C (Path A JPEG receipt) — committing [${buf.toString('hex')}]`)
         this._ble.write(buildModuleAck(0x0C))
         if (this._allWritesSent) {
            this._clearTimer()
            this._setState('wait_final_ack', 'Waiting for badge to confirm commit', FINAL_STEP_TIMEOUT_MS)
            setImmediate(() => this._sendSystemInfo())
         } else {
            this._pendingMod0cCommit = true
            this._resetTimer()
         }
         return
      }

      if (pkt.type === 'cd_packet') {
         console.log(`  ← svc=0x${pkt.service.toString(16)} mod=0x${pkt.moduleId.toString(16)} cmd=0x${pkt.command.toString(16)} [${buf.toString('hex')}]`)
         this._ble.write(buildModuleAck(pkt.moduleId))
         this._resetTimer()
         return
      }

      console.log(`  ← ${pkt.type} [${buf.toString('hex')}]`)
   }

   // Path B: DC_ACK(MM) from badge — record it, then wait for FT status=1000.
   _handleDcAck(pkt) {
      if (pkt.lastByte !== 0x01) return
      if (this._state === 'wait_mm_ack' && pkt.module === MODULE.MEDIA_MANAGEMENT) {
         this._clearTimer()
         console.log(`  (DC_ACK(MM) — waiting for FT status=1000)`)
         this._setState('wait_ft_ready', 'MM ack received, waiting for FT status=1000')
      }
   }

   _handleFtStatus(val) {
      // ── Path A: badge assigned a slot directly (fresh/empty badge) ────────
      if (this._state === 'wait_mm_ack' && val > 0 && val < 1000) {
         this._slotId = val
         console.log(`  (slot ${val} — Path A, streaming protocol)`)
         this._clearTimer()
         this._setState('wait_data_ack', `Sending DC_ACK + JPEG (slotId=${val})`)
         setImmediate(() => {
            this._sendDcAck()
            this._sendTransferStart()
         })
         return
      }

      // ── Path B: status=1000 after DC_ACK(MM) ──────────────────────────────
      if (this._state === 'wait_ft_ready' && val === 1000) {
         this._slotId = val
         console.log('  (status=1000 — Path B, streaming protocol)')
         this._clearTimer()
         this._setState('wait_data_ack', 'Sending DC_ACK + JPEG')
         setImmediate(() => {
            this._sendDcAck()
            this._sendTransferStart()
         })
         return
      }

      // ── Small-file path: badge buffered the JPEG, CRC pending ────────────
      // status=1 arrives after all writes complete (file ≤ 25 000 bytes,
      // single-packet path).  Just ACK it and wait for status=1001 to commit.
      if (this._state === 'wait_data_ack' && val === 1) {
         console.log('  (status=1 — JPEG data received, awaiting CRC check)')
         this._sendDcAck()
         this._resetTimer()
         return
      }

      // ── JPEG verified / ready to commit ───────────────────────────────────
      // status=1001 can arrive before all ATT writes complete (large-file path).
      // In that case, defer the commit until writes finish (_pendingCommit flag).
      // status=1002 means the badge received everything — commit immediately.
      if (this._state === 'wait_data_ack' && val === 1001 && !this._allWritesSent) {
         console.log('  (status=1001 mid-transfer ACK — writes still in flight, will commit when done)')
         this._pendingCommit = true
         this._sendDcAck()
         this._resetTimer()
         return
      }

      if (this._state === 'wait_data_ack' && (val === 1001 || val === 1002)) {
         this._clearTimer()
         console.log(`  (JPEG complete (status=${val}) — sending DC_ACK + SYSTEM_INFO to commit)`)
         this._setState('wait_final_ack', 'Waiting for badge to confirm commit', FINAL_STEP_TIMEOUT_MS)
         setImmediate(() => {
            this._sendDcAck()
            this._sendSystemInfo()
         })
         return
      }

      // ── Badge committed to cycling gallery ────────────────────────────────
      if (this._state === 'wait_final_ack' && val === 2) {
         this._clearTimer()
         this._sendDcAck()
         console.log('  (badge committed to cycling gallery ✓)')
         this._finish(null)
         return
      }

      // Any other response during wait_final_ack — badge may emit extra status frames
      if (this._state === 'wait_final_ack') {
         console.log(`  (wait_final_ack: ignoring extra status=${val})`)
         this._sendDcAck()
         this._resetTimer()
         return
      }

      console.log(`  (unhandled status=${val} in state ${this._state})`)
   }

   _sendMediaManagement() {
      const payload = buildMediaManagementPayload(this._jpegData.length)
      const pkt     = buildPacket(MODULE.MEDIA_MANAGEMENT, 0x00, payload)
      console.log(`→ MEDIA_MANAGEMENT (fileSize=${this._jpegData.length})`)
      this._ble.write(pkt)
   }

   _sendDcAck() {
      console.log('→ DC_ACK')
      this._ble.write(buildDcAck(0x20))
   }

   // JPEG payload: [0x01][fileSize 4B BE][JPEG data]
   // Sent immediately after DC_ACK — no TLV, no trailing CRC32 in payload.
   _sendTransferStart() {
      const payload = buildTransferStartPayload(this._jpegData)
      const pkt     = buildPacket(MODULE.FILE_TRANSFER, 0x00, payload)
      const last4hex = pkt.slice(pkt.length - 4).toString('hex')
      console.log(`→ JPEG DATA (${pkt.length}B total, ${this._jpegData.length}B jpeg, last4=0x${last4hex})`)
      this._writeChunked(pkt)
   }

   // Commit: SYSTEM_INFO cmd=0x00, 3-byte bytesum payload.
   _sendSystemInfo() {
      const payload = buildSystemInfoPayload(this._jpegData)
      const pkt     = buildPacket(MODULE.SYSTEM_INFO, CMD_SYS.DEVICE_INFO_REQUEST, payload)
      console.log(`→ SYSTEM_INFO (payload=[${payload.toString('hex')}])`)
      this._ble.write(pkt)
   }

   _writeChunked(buf) {
      let offset = 0
      let n      = 0
      const total = Math.ceil(buf.length / WRITE_CHUNK_SIZE)

      const sendNext = () => {
         if (offset >= buf.length) {
            console.log(`  (sent ${n}/${total} ATT writes)`)
            this._allWritesSent = true
            if (this._pendingCommit && this._state === 'wait_data_ack') {
               this._pendingCommit = false
               console.log('  (all writes done — now committing deferred status=1001)')
               this._clearTimer()
               this._setState('wait_final_ack', 'Waiting for badge to confirm commit', FINAL_STEP_TIMEOUT_MS)
               setImmediate(() => {
                  this._sendDcAck()
                  this._sendSystemInfo()
               })
            }
            if (this._pendingMod0cCommit && this._state === 'wait_data_ack') {
               this._pendingMod0cCommit = false
               console.log('  (all writes done — now committing deferred mod=0x0C)')
               this._clearTimer()
               this._setState('wait_final_ack', 'Waiting for badge to confirm commit', FINAL_STEP_TIMEOUT_MS)
               setImmediate(() => this._sendSystemInfo())
            }
            return
         }
         const chunk = buf.slice(offset, offset + WRITE_CHUNK_SIZE)
         this._ble.write(chunk)
         offset += chunk.length
         n++
         setImmediate(sendNext)
      }

      sendNext()
   }

   _setState(newState, logMsg, timeoutMs = STEP_TIMEOUT_MS) {
      this._state = newState
      console.log(`  [${newState}] ${logMsg}`)
      this._clearTimer()
      const onTimeout = () => {
         this._timer = null
         if (newState === 'wait_final_ack') {
            this._finish(null)
         } else {
            this._finish(new Error(`Timeout in state ${newState}`))
         }
      }
      this._timer = setTimeout(onTimeout, timeoutMs)
   }

   _clearTimer() {
      if (this._timer) {
         clearTimeout(this._timer)
         this._timer = null
      }
   }

   _resetTimer() {
      this._clearTimer()
      const state = this._state
      const ms    = state === 'wait_final_ack' ? FINAL_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS
      this._timer = setTimeout(() => {
         this._timer = null
         if (state === 'wait_final_ack') {
            this._finish(null)
         } else {
            this._finish(new Error(`Timeout in state ${state}`))
         }
      }, ms)
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

// ── Image preprocessing ───────────────────────────────────────────────────────

async function preprocessImage(filePath) {
   const sharp = require('sharp')
   // Caps field 0x09 reports 0x61A8 = 25,000 as the badge limit.
   // Phone app sent 25,829 bytes (works); 28,305 bytes hard-crashes the badge.
   // Staying at 25,000 keeps us safely under the crash threshold.
   const MAX_FILE_BYTES = 25000
   let quality = 80
   let data = await sharp(filePath)
      .resize(BADGE_IMAGE_SIZE, BADGE_IMAGE_SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality })
      .toBuffer()
   while (data.length > MAX_FILE_BYTES && quality > 30) {
      quality -= 10
      data = await sharp(filePath)
         .resize(BADGE_IMAGE_SIZE, BADGE_IMAGE_SIZE, { fit: 'cover', position: 'centre' })
         .jpeg({ quality })
         .toBuffer()
   }
   console.log(`  (JPEG quality=${quality}, size=${data.length} bytes)`)
   return data
}

module.exports = { FileTransfer }
