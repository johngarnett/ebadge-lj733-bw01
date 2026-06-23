'use strict'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const {
   MODULE,
   dcAckError,
   buildPacket,
   buildDcAck,
   buildModuleAck,
   buildCompactPacket,
   parseNotification,
   buildMediaManagementPayload,
   buildTransferStartPayload,
   buildSystemInfoPayload,
   computeCrc32,
} = require('../src/protocol/packet')

const hex = buf => buf.toString('hex')

describe('dcAckError', () => {
   test('returns error name for known codes', () => {
      assert.equal(dcAckError(0x01), 'INVALID_PACKET')
      assert.equal(dcAckError(0x09), 'DEVICE_BUSY')
      assert.equal(dcAckError(0xFF), 'UNKNOWN_ERROR')
   })

   test('returns null for unknown codes', () => {
      assert.equal(dcAckError(0x00), null)
      assert.equal(dcAckError(0x42), null)
   })
})

describe('buildCompactPacket', () => {
   test('CAPS_QUERY (module=MEDIA_MANAGEMENT, cmd=0x00)', () => {
      assert.equal(hex(buildCompactPacket(MODULE.MEDIA_MANAGEMENT, 0x00)), 'cd00052001020000')
   })

   test('STORAGE_QUERY (module=SYSTEM_INFO, cmd=0x00)', () => {
      assert.equal(hex(buildCompactPacket(MODULE.SYSTEM_INFO, 0x00)), 'cd00052001030000')
   })

   test('is always 8 bytes', () => {
      assert.equal(buildCompactPacket(0x01, 0x00).length, 8)
   })
})

describe('buildModuleAck', () => {
   test('FILE_TRANSFER (0x01): service=0x20, arg=0x0C', () => {
      assert.equal(hex(buildModuleAck(0x01)), 'dc00052001000c01')
   })

   test('MEDIA_MANAGEMENT (0x02): service=0x20, arg=0x28', () => {
      assert.equal(hex(buildModuleAck(0x02)), 'dc00052002002801')
   })

   test('SYSTEM_INFO (0x03): service=0x20, arg=0x12', () => {
      assert.equal(hex(buildModuleAck(0x03)), 'dc00052003001201')
   })

   test('module 0x0C: service=0x15 (not 0x20), arg=0x1E', () => {
      // 0x0C uses a different service byte — critical for the Path A commit step
      assert.equal(hex(buildModuleAck(0x0C)), 'dc0005150c001e01')
   })

   test('is always 8 bytes', () => {
      assert.equal(buildModuleAck(MODULE.FILE_TRANSFER).length, 8)
   })
})

describe('buildDcAck', () => {
   test('produces same bytes as buildModuleAck(FILE_TRANSFER) for service=0x20', () => {
      assert.equal(hex(buildDcAck(0x20)), hex(buildModuleAck(MODULE.FILE_TRANSFER)))
   })
})

describe('buildPacket', () => {
   test('no payload: correct header and length fields', () => {
      assert.equal(hex(buildPacket(MODULE.FILE_TRANSFER, 0x00)), 'cd00061f0101000100')
   })

   test('with payload: contentLen and payloadLenField account for payload size', () => {
      const pkt = buildPacket(MODULE.MEDIA_MANAGEMENT, 0x00, Buffer.from([0xAA, 0xBB]))
      assert.equal(hex(pkt), 'cd00081f0102000300aabb')
   })
})

describe('parseNotification', () => {
   test('returns null for null input', () => {
      assert.equal(parseNotification(null), null)
   })

   test('returns null for buffer shorter than 4 bytes', () => {
      assert.equal(parseNotification(Buffer.from([0xCD, 0x00, 0x06])), null)
   })

   test('returns null for unrecognized start byte', () => {
      assert.equal(parseNotification(Buffer.from([0x42, 0x00, 0x05, 0x20, 0x01, 0x02, 0x00, 0x00])), null)
   })

   test('parses DC ack fields correctly', () => {
      const buf = buildModuleAck(MODULE.FILE_TRANSFER)   // dc 00 05 20 01 00 0c 01
      const pkt = parseNotification(buf)
      assert.equal(pkt.type, 'dc_ack')
      assert.equal(pkt.service, 0x20)
      assert.equal(pkt.module, 0x01)
      assert.equal(pkt.byte5, 0x00)
      assert.equal(pkt.argByte, 0x0C)
      assert.equal(pkt.lastByte, 0x01)
   })

   test('returns null for DC packet shorter than 8 bytes', () => {
      assert.equal(parseNotification(Buffer.from([0xDC, 0x00, 0x05, 0x20])), null)
   })

   test('parses CD packet with no payload', () => {
      const buf = buildPacket(MODULE.FILE_TRANSFER, 0x00)
      const pkt = parseNotification(buf)
      assert.equal(pkt.type, 'cd_packet')
      assert.equal(pkt.service, 0x1F)
      assert.equal(pkt.moduleId, MODULE.FILE_TRANSFER)
      assert.equal(pkt.command, 0x00)
      assert.equal(pkt.payload.length, 0)
   })

   test('parses CD packet and extracts payload bytes', () => {
      const payload = Buffer.from([0xAA, 0xBB, 0xCC])
      const buf = buildPacket(MODULE.SYSTEM_INFO, 0x01, payload)
      const pkt = parseNotification(buf)
      assert.equal(pkt.type, 'cd_packet')
      assert.equal(pkt.moduleId, MODULE.SYSTEM_INFO)
      assert.equal(pkt.command, 0x01)
      assert.equal(hex(pkt.payload), 'aabbcc')
   })

   test('returns null for CD packet shorter than 9 bytes', () => {
      assert.equal(parseNotification(Buffer.from([0xCD, 0x00, 0x06, 0x1F, 0x01, 0x01, 0x00, 0x01])), null)
   })
})

describe('buildMediaManagementPayload', () => {
   test('is 16 bytes', () => {
      assert.equal(buildMediaManagementPayload(1000).length, 16)
   })

   test('encodes fileSize+4 at bytes 10-11 (snoop-verified: 25829 → 0x64E9)', () => {
      const buf = buildMediaManagementPayload(25829)
      assert.equal(buf.readUInt16BE(10), 25829 + 4)
   })

   test('fixed header bytes match snoop log', () => {
      const buf = buildMediaManagementPayload(0)
      assert.equal(hex(buf.slice(0, 4)), '0015a202')
      assert.equal(buf[4], 0x08)
   })
})

describe('buildTransferStartPayload', () => {
   test('structure: magic byte, fileSize BE, jpeg data, last4', () => {
      const jpeg = Buffer.from([0x01, 0x02, 0x03])
      const pkt = buildTransferStartPayload(jpeg)
      assert.equal(pkt.length, 1 + 4 + jpeg.length + 4)
      assert.equal(pkt[0], 0x01)
      assert.equal(pkt.readUInt32BE(1), jpeg.length)
      assert.deepEqual(pkt.slice(5, 5 + jpeg.length), jpeg)
   })

   test('last4 = bytesum(magic1 + fileSize bytes + jpeg bytes)', () => {
      const jpeg = Buffer.from([0x01, 0x02, 0x03])
      const pkt = buildTransferStartPayload(jpeg)
      const last4 = pkt.readUInt32BE(pkt.length - 4)
      // 1 (magic) + (0+0+0+3) (sz) + (1+2+3) (jpeg) = 10
      assert.equal(last4, 10)
   })
})

describe('buildSystemInfoPayload', () => {
   test('is 3 bytes', () => {
      assert.equal(buildSystemInfoPayload(Buffer.from([0xFF])).length, 3)
   })

   test('invariant: value equals (last4 from transfer payload - 1) & 0xFFFFFF', () => {
      const jpeg = Buffer.alloc(50, 0xAB)
      const transfer = buildTransferStartPayload(jpeg)
      const last4 = transfer.readUInt32BE(transfer.length - 4)
      const sysInfo = buildSystemInfoPayload(jpeg)
      const sysVal = (sysInfo[0] << 16) | (sysInfo[1] << 8) | sysInfo[2]
      assert.equal(sysVal, (last4 - 1) & 0xFFFFFF)
   })
})

describe('computeCrc32', () => {
   test('standard check vector: CRC32("123456789") = 0xCBF43926', () => {
      assert.equal(computeCrc32(Buffer.from('123456789', 'ascii')), 0xCBF43926)
   })

   test('returns a number', () => {
      assert.equal(typeof computeCrc32(Buffer.from([0x01])), 'number')
   })
})
