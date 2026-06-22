const fs = require('fs')

const LOG_FILE = '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log.last'

function parseBtsnoop(filePath) {
   const buf = fs.readFileSync(filePath)
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

function extractAttAll(records) {
   const attAll = []
   const fragments = {}
   for (const { flags, data } of records) {
      if (data.length < 1 || data[0] !== 0x02) continue
      if (data.length < 5) continue
      const aclHeader = data.readUInt16LE(1)
      const connHandle = aclHeader & 0x0FFF
      const pb        = (aclHeader >> 12) & 0x3
      const dataLen   = data.readUInt16LE(3)
      const payload   = data.slice(5, 5 + dataLen)
      const dir = flags & 1    // 0=host→ctrl (sent), 1=ctrl→host (received)
      const key = `${connHandle}:${dir}`
      if (pb === 0x2 || pb === 0x0) {
         fragments[key] = Buffer.from(payload)
      } else if (pb === 0x1) {
         if (fragments[key]) fragments[key] = Buffer.concat([fragments[key], payload])
      }
      const frag = fragments[key]
      if (!frag || frag.length < 4) continue
      const l2capLen = frag.readUInt16LE(0)
      const l2capCid = frag.readUInt16LE(2)
      if (frag.length < 4 + l2capLen) continue
      if (l2capCid !== 0x0004) { delete fragments[key]; continue }
      const att = frag.slice(4, 4 + l2capLen)
      const savedFrag = Buffer.from(frag)  // save before delete
      delete fragments[key]
      if (att.length < 1) continue
      // Extract ATT attribute handle for write opcodes
      let attHandle = null
      if ((att[0] === 0x52 || att[0] === 0x12) && att.length >= 3) {
         attHandle = att.readUInt16LE(1)
      } else if ((att[0] === 0x1b || att[0] === 0x1d) && att.length >= 3) {
         // Notifications/indications have handle too
         attHandle = att.readUInt16LE(1)
      }
      attAll.push({ connHandle, dir, opcode: att[0], attHandle, att })
   }
   return attAll
}

const records = parseBtsnoop(LOG_FILE)
const attAll  = extractAttAll(records)

// Show all ATT traffic where ATT attribute handle is 47
const ATT_HANDLE = 47
console.log(`All ATT traffic with ATT attribute handle ${ATT_HANDLE}:\n`)
let idx = 0
for (const { connHandle, dir, opcode, attHandle, att } of attAll) {
   if (attHandle !== ATT_HANDLE) continue
   const dirStr = dir === 0 ? '→badge' : '←badge'
   const value = att.slice(3)
   const hex = value.slice(0, 40).toString('hex')
   console.log(`  #${idx++} ${dirStr} conn=${connHandle} op=0x${opcode.toString(16).padStart(2,'0')} len=${value.length} hex=${hex}${value.length > 40 ? '…' : ''}`)
   if (idx > 300) { console.log('  (truncated at 300)'); break }
}

// Also show by connection handle - all distinct connections
const connDirs = {}
for (const { connHandle, dir, opcode } of attAll) {
   const k = `${connHandle}:${dir === 0 ? 'sent' : 'recv'}`
   connDirs[k] = (connDirs[k] || 0) + 1
}
console.log('\nAll connections (connHandle:dir count):')
for (const [k, v] of Object.entries(connDirs)) {
   console.log(`  ${k}: ${v}`)
}
