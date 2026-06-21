const { MODULE, CMD_SYS, buildPacket, parseNotification, dcAckError } = require('./packet')

const CMD_TIMEOUT_MS = 5000

// Send DEVICE_INFO_REQUEST and return a parsed DeviceInfo object (or null on
// empty payload). DC acks from the badge are silently ignored while waiting.
function requestDeviceInfo(bleClient) {
   return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
         bleClient.removeNotifyListener(handler)
         reject(new Error('Timeout waiting for DEVICE_INFO_RESPONSE'))
      }, CMD_TIMEOUT_MS)

      function handler(buf) {
         const pkt = parseNotification(buf)
         if (!pkt) return

         if (pkt.type === 'dc_ack') {
            // Badge sends two dc_acks: provisional (lastByte=0x00) then final (lastByte=0x01).
            // Only act on the final one to avoid double-rejecting.
            if (pkt.module !== MODULE.SYSTEM_INFO || pkt.lastByte !== 0x01) return
            const errName = dcAckError(pkt.argByte)
            if (errName) {
               clearTimeout(timer)
               bleClient.removeNotifyListener(handler)
               reject(new Error(`Badge error: ${errName}`))
            }
            return
         }

         if (pkt.type !== 'cd_packet') return
         if (pkt.moduleId !== MODULE.SYSTEM_INFO) return
         if (pkt.command !== CMD_SYS.DEVICE_INFO_RESPONSE &&
             pkt.command !== CMD_SYS.DEVICE_INFO_REQUEST) return

         clearTimeout(timer)
         bleClient.removeNotifyListener(handler)

         try {
            resolve(parseDeviceInfo(pkt.payload))
         } catch (err) {
            reject(err)
         }
      }

      bleClient.onNotify(handler)
      bleClient.write(buildPacket(MODULE.SYSTEM_INFO, CMD_SYS.DEVICE_INFO_REQUEST))
   })
}

// Wire format from SystemInfoService.parseDeviceInfo in the APK:
//   4B nameLen + name (UTF-8)
//   4B versionLen + version (UTF-8)
//   4B protoVersionLen + protoVersion (UTF-8)
//   8B storageCapacity + 8B freeStorage (int64 BE each)
//   4B fileTypeCount + N×1B fileType
//   8B maxFileSize (int64 BE)
//   4B featureCount + N×(4B len + string)
function parseDeviceInfo(buf) {
   if (!buf || buf.length === 0) return null
   let offset = 0

   function readString() {
      const len = buf.readInt32BE(offset)
      offset += 4
      const str = buf.toString('utf8', offset, offset + len)
      offset += len
      return str
   }

   const deviceName      = readString()
   const deviceVersion   = readString()
   const protocolVersion = readString()

   const storageCapacity = Number(buf.readBigInt64BE(offset));  offset += 8
   const freeStorage     = Number(buf.readBigInt64BE(offset));  offset += 8

   const fileTypeCount = buf.readInt32BE(offset);  offset += 4
   const fileTypes = []
   for (let i = 0; i < fileTypeCount; i++) fileTypes.push(buf[offset++])

   const maxFileSize = Number(buf.readBigInt64BE(offset));  offset += 8

   const featureCount = buf.readInt32BE(offset);  offset += 4
   const features = []
   for (let i = 0; i < featureCount; i++) features.push(readString())

   return { deviceName, deviceVersion, protocolVersion, storageCapacity, freeStorage, fileTypes, maxFileSize, features }
}

module.exports = { requestDeviceInfo }
