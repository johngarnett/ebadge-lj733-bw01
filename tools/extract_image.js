const fs   = require('fs')
const path = require('path')

const LOG_FILES = [
   // Try .log.last first — it has multiple clean transfers
   '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log.last',
   '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log',
]

function parseBtsnoop(filePath) {
   const buf = fs.readFileSync(filePath)
   if (!buf.slice(0, 8).toString('ascii').startsWith('btsnoop'))
      throw new Error(`Bad magic in ${filePath}`)
   const records = []
   let offset = 16
   while (offset + 24 <= buf.length) {
      const inclLen = buf.readUInt32BE(offset + 4)
      const flags   = buf.readUInt32BE(offset + 8)
      const data    = buf.slice(offset + 24, offset + 24 + inclLen)
      offset += 24 + inclLen
      records.push({ flags, data })
   }
   return records
}

// Returns { sent: [{attHandle, value}], received: [{attHandle, value}] }
function extractAttTraffic(records) {
   const sent     = []
   const received = []
   const frags    = {}    // key = `${connHandle}:${dir}`

   for (const { flags, data } of records) {
      const dir = flags & 1   // 0=sent (host→ctrl), 1=received (ctrl→host)
      if (data.length < 1 || data[0] !== 0x02) continue
      if (data.length < 5) continue
      const aclHeader  = data.readUInt16LE(1)
      const connHandle = aclHeader & 0x0FFF
      const pb         = (aclHeader >> 12) & 0x3
      const dataLen    = data.readUInt16LE(3)
      const payload    = data.slice(5, 5 + dataLen)
      const key = `${connHandle}:${dir}`

      if (pb === 0x2 || pb === 0x0) {
         frags[key] = Buffer.from(payload)
      } else if (pb === 0x1) {
         if (frags[key]) frags[key] = Buffer.concat([frags[key], payload])
      }

      const frag = frags[key]
      if (!frag || frag.length < 4) continue
      const l2capLen = frag.readUInt16LE(0)
      const l2capCid = frag.readUInt16LE(2)
      if (frag.length < 4 + l2capLen) continue
      if (l2capCid !== 0x0004) { delete frags[key]; continue }

      const att = frag.slice(4, 4 + l2capLen)
      delete frags[key]
      if (att.length < 3) continue

      const opcode    = att[0]
      // Write Command/Request (sent) or Handle Value Notification/Indication (received)
      if (dir === 0 && opcode !== 0x52 && opcode !== 0x12) continue
      if (dir === 1 && opcode !== 0x1B && opcode !== 0x1D && opcode !== 0x1E) continue
      const attHandle = att.readUInt16LE(1)
      const value     = att.slice(3)
      if (value.length === 0) continue

      if (dir === 0) sent.push({ attHandle, value })
      else           received.push({ attHandle, value })
   }
   return { sent, received }
}

function findTransfer(logPath) {
   console.log(`\nParsing ${path.basename(logPath)} …`)
   const records        = parseBtsnoop(logPath)
   const { sent, received } = extractAttTraffic(records)
   console.log(`  ${sent.length} sent, ${received.length} received ATT values`)

   // Merge into timeline preserving relative order (not possible without timestamps here;
   // just use sent for command extraction and received separately for badge responses)

   // Find MEDIA_MANAGEMENT announce (sent): CD [len] [svc] 01 02 ... len>=25
   let mmIdx = -1, mmServiceByte = null
   for (let i = 0; i < sent.length; i++) {
      const v = sent[i].value
      if (v.length >= 25 && v[0] === 0xCD && v[4] === 0x01 && v[5] === 0x02) {
         mmIdx = i; mmServiceByte = v[3]; break
      }
   }
   if (mmIdx === -1) {
      console.log('  ✗ No MEDIA_MANAGEMENT announce found')
      return null
   }

   const mmValue    = sent[mmIdx].value
   const mmPayload  = mmValue.slice(9, 25)          // 16-byte MM payload
   const mmFileSize = mmValue.readUInt32BE(17)       // bytes[8-11] of payload = bytes[17-20] of packet
   console.log(`  ✓ MEDIA_MANAGEMENT announce at sent[#${mmIdx}] (service=0x${mmServiceByte.toString(16)})`)
   console.log(`    payload:      ${mmPayload.toString('hex')}`)
   console.log(`    totalSize:    ${mmFileSize} (jpegSize + 4 checksum)`)

   // Find badge's DC ack for MEDIA_MANAGEMENT (received, module=0x02 or argByte field)
   // DC format: DC 00 05 [svc] [module] [b5] [argByte] [lastByte]
   let badgeMmAckArgByte = null
   for (const { value: v } of received) {
      if (v.length >= 8 && v[0] === 0xDC && v[4] === 0x02 && v[7] === 0x01) {
         badgeMmAckArgByte = v[6]
         console.log(`  Badge MM DC ack: argByte=0x${badgeMmAckArgByte.toString(16).padStart(2,'0')} (raw: ${v.toString('hex')})`)
         break
      }
   }

   // Find TRANSFER_START (sent): CD [len] [svc] 01 01 [plen] 00 01 [size 4B] [JPEG...]
   let tsIdx = -1
   for (let i = mmIdx + 1; i < sent.length; i++) {
      const v = sent[i].value
      if (v.length >= 20 && v[0] === 0xCD && v[4] === 0x01 && v[5] === 0x01 && v[9] === 0x01) {
         tsIdx = i; break
      }
   }
   if (tsIdx === -1) {
      console.log('  ✗ No TRANSFER_START found')
      return null
   }

   const tsValue      = sent[tsIdx].value
   const declaredSize = tsValue.readUInt32BE(10)
   const totalExpected = declaredSize + 4  // JPEG + 4-byte checksum
   console.log(`  ✓ TRANSFER_START at sent[#${tsIdx}]`)
   console.log(`    declared JPEG size: ${declaredSize}`)
   console.log(`    header: ${tsValue.slice(0, 14).toString('hex')}`)

   // Collect data: first chunk starts at byte 14 of the TS packet
   const chunks = []
   if (tsValue.length > 14) chunks.push(tsValue.slice(14))
   let bytesCollected = chunks.reduce((s, c) => s + c.length, 0)

   let sysInfoPayload = null
   for (let i = tsIdx + 1; i < sent.length && bytesCollected < totalExpected; i++) {
      const v = sent[i].value
      // SYSTEM_INFO: CD byte[4]=01 byte[5]=03
      if (v.length >= 10 && v[0] === 0xCD && v[4] === 0x01 && v[5] === 0x03) {
         sysInfoPayload = v.slice(9)
         console.log(`  ✓ SYSTEM_INFO at sent[#${i}]: payload=${sysInfoPayload.toString('hex')} (${sysInfoPayload.length} bytes)`)
         break
      }
      if (v[0] === 0xDC) continue  // skip DC acks mid-stream
      chunks.push(v)
      bytesCollected += v.length
   }

   if (!sysInfoPayload) {
      // Look after all data too
      for (let i = tsIdx + 1; i < sent.length; i++) {
         const v = sent[i].value
         if (v.length >= 10 && v[0] === 0xCD && v[4] === 0x01 && v[5] === 0x03) {
            sysInfoPayload = v.slice(9)
            console.log(`  ✓ SYSTEM_INFO (late) at sent[#${i}]: payload=${sysInfoPayload.toString('hex')}`)
            break
         }
      }
   }

   const rawStream  = Buffer.concat(chunks)
   console.log(`  raw bytes collected: ${rawStream.length}  (expected: ${totalExpected})`)

   if (rawStream.length < 4) { console.log('  ✗ Not enough data'); return null }

   // Trim or pad: use exactly totalExpected bytes
   const trimmed    = rawStream.slice(0, totalExpected)
   const checksum4B = trimmed.slice(trimmed.length - 4)
   const imageBytes = trimmed.slice(0, trimmed.length - 4)

   // Check JPEG magic
   const isJpeg = imageBytes[0] === 0xFF && imageBytes[1] === 0xD8
   const hasJpegEoi = imageBytes[imageBytes.length - 2] === 0xFF && imageBytes[imageBytes.length - 1] === 0xD9

   // Compute checksum variants
   function byteSum(buf) {
      let s = 0
      for (const b of buf) s += b
      return s >>> 0
   }
   const sz    = imageBytes.length
   const szBuf = Buffer.from([(sz>>>24)&0xFF,(sz>>>16)&0xFF,(sz>>>8)&0xFF,sz&0xFF])

   const chkA = (byteSum(szBuf) + byteSum(imageBytes)) >>> 0        // [size]+[jpeg]
   const chkB = (0x01 + byteSum(szBuf) + byteSum(imageBytes)) >>> 0 // [type]+[size]+[jpeg]
   const streamChk = checksum4B.readUInt32BE(0)

   console.log(`\n  === Transfer Results ===`)
   console.log(`  SERVICE_TX:         0x${mmServiceByte.toString(16)}`)
   console.log(`  Declared JPEG size: ${declaredSize}`)
   console.log(`  Actual image bytes: ${imageBytes.length}`)
   console.log(`  Is JPEG:            ${isJpeg}`)
   console.log(`  Has JPEG EOI (FFD9):${hasJpegEoi}`)
   console.log(`  Stream checksum:    0x${streamChk.toString(16).padStart(8,'0')} (${checksum4B.toString('hex')})`)
   console.log(`  chk=[size]+[jpeg]:  0x${chkA.toString(16).padStart(8,'0')}  match=${chkA === streamChk}`)
   console.log(`  chk=[01]+[sz]+[jp]: 0x${chkB.toString(16).padStart(8,'0')}  match=${chkB === streamChk}`)
   if (sysInfoPayload) {
      console.log(`  SYSTEM_INFO:        ${sysInfoPayload.toString('hex')} (${sysInfoPayload.length} bytes)`)
      if (badgeMmAckArgByte !== null)
         console.log(`  dcAckByte from badge: 0x${badgeMmAckArgByte.toString(16).padStart(2,'0')}`)
   }
   console.log(`  First 16 bytes:     ${imageBytes.slice(0, 16).toString('hex')}`)
   console.log(`  Last   8 bytes:     ${imageBytes.slice(-8).toString('hex')}`)

   return {
      mmServiceByte, mmPayload, mmFileSize, declaredSize,
      imageBytes, checksum4B, streamChk, sysInfoPayload,
      badgeMmAckArgByte,
      checksumMatchA: chkA === streamChk,
      checksumMatchB: chkB === streamChk,
   }
}

let result = null
let sourceFile = null
for (const logPath of LOG_FILES) {
   try {
      const r = findTransfer(logPath)
      if (r) { result = r; sourceFile = logPath; break }
   } catch (err) {
      console.log(`  Error: ${err.message}`)
   }
}

if (!result) {
   console.log('\n✗ No transfer found.')
   process.exit(1)
}

const outPath = '/Users/garnett/claude/ebadge/tools/extracted_image.bin'
fs.writeFileSync(outPath, result.imageBytes)
console.log(`\nSaved ${result.imageBytes.length} bytes → ${outPath}`)
console.log(`Source: ${path.basename(sourceFile)}`)
