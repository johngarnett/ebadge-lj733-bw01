const fs = require('fs')

const LOG_FILE = '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log.last'

function parseBtsnoop(filePath) {
   const buf = fs.readFileSync(filePath)
   const magic = buf.slice(0, 8).toString('ascii')
   if (!magic.startsWith('btsnoop')) throw new Error('Bad magic')
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

function extractAttWrites(records) {
   const attWrites = []
   const fragments = {}
   for (const { flags, data } of records) {
      if (flags & 1) continue
      if (data.length < 1 || data[0] !== 0x02) continue
      if (data.length < 5) continue
      const aclHeader = data.readUInt16LE(1)
      const handle    = aclHeader & 0x0FFF
      const pb        = (aclHeader >> 12) & 0x3
      const dataLen   = data.readUInt16LE(3)
      const payload   = data.slice(5, 5 + dataLen)
      if (pb === 0x2 || pb === 0x0) {
         fragments[handle] = Buffer.from(payload)
      } else if (pb === 0x1) {
         if (fragments[handle]) fragments[handle] = Buffer.concat([fragments[handle], payload])
      }
      const frag = fragments[handle]
      if (!frag || frag.length < 4) continue
      const l2capLen = frag.readUInt16LE(0)
      const l2capCid = frag.readUInt16LE(2)
      if (frag.length < 4 + l2capLen) continue
      if (l2capCid !== 0x0004) { delete fragments[handle]; continue }
      const att = frag.slice(4, 4 + l2capLen)
      delete fragments[handle]
      if (att.length < 3) continue
      const opcode = att[0]
      if (opcode !== 0x52 && opcode !== 0x12) continue
      const attHandle = att.readUInt16LE(1)
      const value     = att.slice(3)
      if (value.length === 0) continue
      attWrites.push({ attHandle, value })
   }
   return attWrites
}

const records = parseBtsnoop(LOG_FILE)
const writes  = extractAttWrites(records)

// Show first 30 writes with hex preview
console.log('First 30 ATT writes:')
for (let i = 0; i < Math.min(30, writes.length); i++) {
   const { attHandle, value } = writes[i]
   console.log(`  #${i} handle=${attHandle} len=${value.length} hex=${value.slice(0,24).toString('hex')}`)
}

// Find all writes starting with CD
console.log('\nWrites starting with CD:')
let cdCount = 0
for (let i = 0; i < writes.length; i++) {
   if (writes[i].value[0] === 0xCD) {
      const v = writes[i].value
      console.log(`  #${i} handle=${writes[i].attHandle} len=${v.length} hex=${v.slice(0,32).toString('hex')}`)
      if (++cdCount > 30) { console.log('  (truncated)'); break }
   }
}

// Find all writes starting with DC
console.log('\nWrites starting with DC:')
let dcCount = 0
for (let i = 0; i < writes.length; i++) {
   if (writes[i].value[0] === 0xDC) {
      const v = writes[i].value
      console.log(`  #${i} handle=${writes[i].attHandle} len=${v.length} hex=${v.slice(0,32).toString('hex')}`)
      if (++dcCount > 10) { console.log('  (truncated)'); break }
   }
}

// Summarize handle 6 writes (likely the bulk data)
const h6 = writes.filter(w => w.attHandle === 6)
console.log(`\nHandle 6: ${h6.length} writes`)
if (h6.length > 0) {
   const first = h6[0].value
   const last  = h6[h6.length-1].value
   console.log(`  First write: len=${first.length} hex=${first.slice(0,32).toString('hex')}`)
   console.log(`  Last  write: len=${last.length}  hex=${last.slice(0,32).toString('hex')}`)
   // Check for CD marker
   const cdWrites = h6.filter(w => w.value[0] === 0xCD)
   console.log(`  CD-starting writes: ${cdWrites.length}`)
}

// Handle 130 summary
const h130 = writes.filter(w => w.attHandle === 130)
console.log(`\nHandle 130: ${h130.length} writes`)
if (h130.length > 0) {
   const first = h130[0].value
   const last  = h130[h130.length-1].value
   console.log(`  First write: len=${first.length} hex=${first.slice(0,32).toString('hex')}`)
   console.log(`  Last  write: len=${last.length}  hex=${last.slice(0,32).toString('hex')}`)
}
