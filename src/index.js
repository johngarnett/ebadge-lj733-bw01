const path = require('path')
const { BleClient } = require('./ble/BleClient')
const { FileTransfer } = require('./protocol/fileTransfer')
const { MediaManagement } = require('./protocol/mediaManagement')
const { requestDeviceInfo } = require('./protocol/systemInfo')

const FILE_TYPE_NAME = { 1: 'IMAGE', 2: 'VIDEO', 3: 'ANIMATION' }

const USAGE = `
Usage: node src/index.js <command> [options]

Commands:
  send <image-file> [badge-name]   Send an image to the badge
  list [badge-name]                List all media stored on the badge
  delete <media-id> [badge-name]   Delete a media file by ID
  info <media-id> [badge-name]     Show metadata for a media file
`.trim()

async function main() {
   const [cmd, ...rest] = process.argv.slice(2)

   if (!cmd) {
      console.error(USAGE)
      process.exit(1)
   }

   switch (cmd) {
      case 'send':   return cmdSend(rest)
      case 'list':   return cmdList(rest)
      case 'delete': return cmdDelete(rest)
      case 'info':   return cmdInfo(rest)
      default:
         console.error(`Unknown command: ${cmd}\n\n${USAGE}`)
         process.exit(1)
   }
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdSend([imagePath, badgeName = null]) {
   if (!imagePath) {
      console.error('Usage: node src/index.js send <image-file> [badge-name]')
      process.exit(1)
   }

   const ble      = new BleClient()
   const transfer = new FileTransfer(ble)

   transfer.on('status', buf => console.log('Badge status:', buf.toString('hex')))
   ble.on('disconnect', onUnexpectedDisconnect)

   try {
      await ble.connect(badgeName)
      console.log(`\nSending ${path.resolve(imagePath)}…\n`)
      await transfer.sendFile(path.resolve(imagePath))
      console.log('\nTransfer complete ✓')
   } catch (err) {
      console.error('\nError:', err.message)
      console.error('Tip: transfers fail when the badge battery is low or the badge is charging.')
      process.exit(1)
   } finally {
      ble.removeListener('disconnect', onUnexpectedDisconnect)
      await ble.disconnect()
      process.exit(0)
   }
}

async function cmdList([badgeName = null]) {
   const { ble, media } = await connect(badgeName)
   try {
      const result = await media.requestList()
      if (Array.isArray(result)) {
         if (result.length === 0) {
            console.log('No media files on device.')
         } else {
            console.log(`\n${result.length} file(s) on device:\n`)
            for (const f of result) printFileInfo(f)
         }
      } else {
         // Badge responded but format is not a parsed file list (device capabilities response).
         console.log('\nDevice capabilities response (raw):')
         console.log(`  ${result._raw || JSON.stringify(result)}`)
         if (result._parseError) console.log(`  (parse note: ${result._parseError})`)
      }
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   } finally {
      await ble.disconnect()
      process.exit(0)
   }
}

async function cmdDelete([mediaId, badgeName = null]) {
   if (!mediaId) {
      console.error('Usage: node src/index.js delete <media-id> [badge-name]')
      process.exit(1)
   }

   const { ble, media } = await connect(badgeName)
   try {
      const result = await media.deleteMedia(Number(mediaId))
      if (result.success) {
         console.log(`Deleted ${mediaId} ✓`)
      } else {
         console.error(`Delete failed: ${result.message || '(no message)'}`)
         process.exit(1)
      }
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   } finally {
      await ble.disconnect()
      process.exit(0)
   }
}

async function cmdInfo([mediaId, badgeName = null]) {
   if (!mediaId) {
      console.error('Usage: node src/index.js info <media-id> [badge-name]')
      process.exit(1)
   }

   const { ble, media } = await connect(badgeName)
   try {
      const info = await media.requestInfo(Number(mediaId))
      console.log()
      printFileInfo(info)
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   } finally {
      await ble.disconnect()
      process.exit(0)
   }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function connect(badgeName) {
   const ble   = new BleClient()
   const media = new MediaManagement(ble)
   ble.on('disconnect', onUnexpectedDisconnect)
   try {
      await ble.connect(badgeName)
      try {
         const info = await requestDeviceInfo(ble)
         if (info) {
            console.log(`Device: ${info.deviceName}  fw:${info.deviceVersion}  proto:${info.protocolVersion}`)
            console.log(`Storage: ${info.freeStorage} / ${info.storageCapacity} bytes free`)
         }
      } catch (infoErr) {
         console.log(`Note: device info unavailable (${infoErr.message})`)
      }
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   }
   return { ble, media }
}

function printFileInfo(f) {
   const typeName = FILE_TYPE_NAME[f.fileType] || `0x${f.fileType.toString(16)}`
   const date     = new Date(f.timestamp * 1000).toISOString()
   console.log(`  ID:        ${f.mediaId}`)
   console.log(`  File:      ${f.fileName}`)
   console.log(`  Type:      ${typeName}`)
   console.log(`  Size:      ${f.fileSize} bytes`)
   console.log(`  Checksum:  0x${(f.checksum >>> 0).toString(16)}`)
   console.log(`  Timestamp: ${date}`)
   if (f.previewSize > 0)    console.log(`  Preview:   ${f.previewSize} bytes`)
   if (f.backgroundSize > 0) console.log(`  BG:        ${f.backgroundSize} bytes`)
   const meta = Object.entries(f.metadata)
   if (meta.length > 0)      console.log(`  Metadata:  ${meta.map(([k, v]) => `${k}=${v}`).join('; ')}`)
   console.log()
}

function onUnexpectedDisconnect() {
   console.error('Badge disconnected unexpectedly')
   process.exit(1)
}

main().catch(err => {
   console.error('\nFatal:', err.message)
   process.exit(1)
})
