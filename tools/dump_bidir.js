#!/usr/bin/env node
// Bidirectional BTSnoop dump: all packets from start until 500ms after MM announce

const fs = require('fs')

const LOG_FILES = [
  '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log',
  '/Users/garnett/claude/ebadge/foo/FS/data/misc/bluetooth/logs/btsnoop_hci.log.last',
]

function parseBtSnoop(filePath) {
  const buf = fs.readFileSync(filePath)
  const magic = buf.slice(0, 8).toString('ascii')
  if (!magic.startsWith('btsnoop')) throw new Error('Not a BTSnoop file: ' + filePath)
  const records = []
  let offset = 16
  while (offset + 24 <= buf.length) {
    const origLen = buf.readUInt32BE(offset)
    const inclLen = buf.readUInt32BE(offset + 4)
    const flags   = buf.readUInt32BE(offset + 8)
    const tsHi    = buf.readUInt32BE(offset + 16)
    const tsLo    = buf.readUInt32BE(offset + 20)
    const ts      = tsHi * 4294967296 + tsLo
    offset += 24
    if (offset + inclLen > buf.length) break
    const data = buf.slice(offset, offset + inclLen)
    offset += inclLen
    records.push({ origLen, inclLen, flags, ts, data })
  }
  return records
}

function extractAttPackets(records) {
  const reassembly = {}
  const packets = []
  for (const rec of records) {
    const { flags, ts, data } = rec
    const toController = (flags & 1) === 0
    if (data.length < 1 || data[0] !== 0x02) continue
    if (data.length < 5) continue
    const handleWord = data.readUInt16LE(1)
    const connHandle = handleWord & 0x0FFF
    const pb = (handleWord >> 12) & 0x3
    const aclLen = data.readUInt16LE(3)
    const aclPayload = data.slice(5, 5 + aclLen)
    let assembled
    if (pb === 0x2) {
      reassembly[connHandle] = Buffer.from(aclPayload)
      assembled = reassembly[connHandle]
    } else if (pb === 0x1) {
      if (reassembly[connHandle]) {
        reassembly[connHandle] = Buffer.concat([reassembly[connHandle], aclPayload])
        assembled = reassembly[connHandle]
      } else continue
    } else {
      assembled = aclPayload
    }
    if (assembled.length < 4) continue
    const l2capLen = assembled.readUInt16LE(0)
    if (assembled.length < 4 + l2capLen) continue
    const cid = assembled.readUInt16LE(2)
    if (cid !== 0x0004) continue
    const attPayload = assembled.slice(4, 4 + l2capLen)
    if (attPayload.length < 3) continue
    const opcode = attPayload[0]
    const attHandle = attPayload.readUInt16LE(1)
    const value = attPayload.slice(3)
    const isWrite  = opcode === 0x52 || opcode === 0x12 || opcode === 0x13
    const isNotify = opcode === 0x1B || opcode === 0x1D || opcode === 0x1E
    const isCCCD   = opcode === 0x52 && value.length === 2 && (value[0] === 0x01 || value[0] === 0x00) && value[1] === 0x00
    if (!isWrite && !isNotify) continue
    packets.push({ ts, dir: toController ? '→badge' : '←badge', handle: attHandle, opcode, value, isCCCD })
    delete reassembly[connHandle]
  }
  return packets
}

const MODULE_NAMES = {
  0x01: 'FILE_TRANSFER', 0x02: 'MEDIA_MGMT', 0x03: 'SYSTEM_INFO',
  0x06: '?0x06', 0x0a: '?0x0a', 0x0c: '?0x0c', 0x0d: '?0x0d',
  0x10: '?0x10', 0x15: '?0x15', 0x1c: '?0x1c', 0x1f: '?0x1f',
  0x65: '?0x65', 0xff: '?0xff',
}

function parseBajiPacket(buf) {
  if (buf.length < 1) return 'empty'
  if (buf[0] === 0xCD) {
    if (buf.length < 9) return `CD partial (${buf.length}B) ${buf.toString('hex')}`
    const svc    = buf[3]
    const module = buf[5]
    const plen   = buf.readUInt16BE(6)
    const cmd    = buf[8]
    const pl     = buf.slice(9)
    const mname  = MODULE_NAMES[module] || `0x${module.toString(16)}`
    if (module === 0x02 && pl.length >= 16) {
      return `CD MEDIA_MGMT svc=0x${svc.toString(16)} cmd=0x${cmd.toString(16)} payload=${pl.toString('hex')}`
    }
    if (module === 0x01 && pl.length >= 3) {
      const val = pl.readUIntBE(0, Math.min(pl.length, 4))
      return `CD FILE_TRANSFER svc=0x${svc.toString(16)} cmd=0x${cmd.toString(16)} val=${val} pl(${pl.length}B)=${pl.toString('hex')}`
    }
    return `CD ${mname} svc=0x${svc.toString(16)} plen=${plen} cmd=0x${cmd.toString(16)} pl(${pl.length}B)=${pl.slice(0,12).toString('hex')}${pl.length>12?'…':''}`
  }
  if (buf[0] === 0xDC) {
    if (buf.length < 8) return `DC partial ${buf.toString('hex')}`
    const svc  = buf[3]; const mod = buf[4]; const b5 = buf[5]
    const arg  = buf[6]; const lst = buf[7]
    const mname = MODULE_NAMES[mod] || `0x${mod.toString(16)}`
    return `DC ${mname} svc=0x${svc.toString(16)} b5=0x${b5.toString(16)} arg=0x${arg.toString(16)} last=0x${lst.toString(16)}`
  }
  return `raw(${buf.length}B): ${buf.slice(0,24).toString('hex')}${buf.length>24?'…':''}`
}

function run() {
  // Load and merge both log files
  let allPackets = []
  for (const f of LOG_FILES) {
    try {
      const records = parseBtSnoop(f)
      const pkts = extractAttPackets(records)
      for (const p of pkts) p.file = f.split('/').pop()
      allPackets = allPackets.concat(pkts)
    } catch (e) {
      console.error('Skip', f, ':', e.message)
    }
  }
  allPackets.sort((a, b) => a.ts - b.ts)

  // Find the real MM announce: CD packet, svc=0x1F, module=0x02, 25-byte payload with 16B payload
  let mmIdx = -1, mmTs = 0
  for (let i = 0; i < allPackets.length; i++) {
    const v = allPackets[i].value
    if (v.length >= 25 && v[0] === 0xCD && v[3] === 0x1F && v[5] === 0x02) {
      mmIdx = i; mmTs = allPackets[i].ts
      break
    }
  }

  const baseTs = allPackets.length > 0 ? allPackets[0].ts : 0
  const endTs  = mmIdx >= 0 ? mmTs + 500_000 : baseTs + 60_000_000

  console.log(`Total ATT packets: ${allPackets.length}`)
  if (mmIdx >= 0) {
    console.log(`MM announce at index ${mmIdx}, +${((mmTs-baseTs)/1000).toFixed(0)}ms from start`)
  } else {
    console.log('MM announce not found — dumping all')
  }
  console.log('')

  let shown = 0
  for (let i = 0; i < allPackets.length; i++) {
    const p = allPackets[i]
    if (p.ts > endTs) break
    const ms = ((p.ts - baseTs) / 1000).toFixed(0)
    const mmMark = i === mmIdx ? ' ◄ MM ANNOUNCE' : ''
    if (p.isCCCD) {
      console.log(`+${String(ms).padStart(6)}ms #${i} ${p.dir} h=${p.handle} CCCD enable${mmMark}`)
    } else {
      const hex = p.value.slice(0,28).toString('hex') + (p.value.length > 28 ? `…(${p.value.length}B)` : '')
      const parsed = parseBajiPacket(p.value)
      console.log(`+${String(ms).padStart(6)}ms #${i} ${p.dir} h=${p.handle} ${parsed}${mmMark}`)
      if (p.value.length <= 28) console.log(`         hex: ${hex}`)
    }
    shown++
  }
  console.log(`\nShown: ${shown} packets`)
}

run()
