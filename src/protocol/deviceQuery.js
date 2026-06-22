const { MODULE, buildCompactPacket, buildModuleAck, parseNotification } = require('./packet')

const QUERY_TIMEOUT_MS = 5000

function queryCompact(ble, moduleId) {
   return new Promise((resolve, reject) => {
      let done = false

      const timer = setTimeout(() => {
         if (done) return
         done = true
         ble.removeNotifyListener(handler)
         reject(new Error(`Query timeout for module 0x${moduleId.toString(16)}`))
      }, QUERY_TIMEOUT_MS)

      const handler = (buf) => {
         if (done) return
         const pkt = parseNotification(buf)
         if (!pkt || pkt.type !== 'cd_packet' || pkt.moduleId !== moduleId) return
         done = true
         clearTimeout(timer)
         ble.removeNotifyListener(handler)
         ble.write(buildModuleAck(moduleId))
         resolve(pkt.payload)
      }

      ble.onNotify(handler)
      ble.write(buildCompactPacket(moduleId, 0x00))
   })
}

async function queryCaps(ble) {
   const payload = await queryCompact(ble, MODULE.MEDIA_MANAGEMENT)
   return {
      width:       payload.readUInt16BE(1),
      height:      payload.readUInt16BE(3),
      maxFileSize: payload.readUInt16BE(payload.length - 2),
   }
}

async function queryStorage(ble) {
   const payload = await queryCompact(ble, MODULE.SYSTEM_INFO)
   return {
      usedBytes: payload.readUInt32BE(2),
   }
}

module.exports = { queryCaps, queryStorage }
