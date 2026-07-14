const path = require('path')
const { BleClient } = require('./ble/BleClient')
const { FileTransfer } = require('./protocol/fileTransfer')

const USAGE = `
Usage: node src/index.js <command> [options]

Commands:
  send <image-file> [badge-name]   Send an image to the badge
  battery [badge-name]             Show battery level
`.trim()

async function main() {
   const [cmd, ...rest] = process.argv.slice(2)

   if (!cmd) {
      console.error(USAGE)
      process.exit(1)
   }

   switch (cmd) {
      case 'send':    return cmdSend(rest)
      case 'battery': return cmdBattery(rest)
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
      const batt = await ble.readBatteryLevel()
      if (batt !== null) {
         const warn = batt < 20 ? ' ⚠ LOW — transfer may fail' : ''
         console.log(`Battery: ${batt}%${warn}`)
      }
      console.log(`\nSending ${path.resolve(imagePath)}…\n`)
      await transfer.sendFile(path.resolve(imagePath), { allowSourceAsIs: true })
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

async function cmdBattery([badgeName = null]) {
   const ble = new BleClient()
   ble.on('disconnect', onUnexpectedDisconnect)
   try {
      await ble.connect(badgeName)
      const batt = await ble.readBatteryLevel()
      if (batt === null) {
         console.log('Battery level unavailable (badge does not expose Battery Service)')
      } else {
         console.log(`Battery: ${batt}%`)
      }
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   } finally {
      ble.removeListener('disconnect', onUnexpectedDisconnect)
      await ble.disconnect()
      process.exit(0)
   }
}

function onUnexpectedDisconnect() {
   console.error('Badge disconnected unexpectedly')
   process.exit(1)
}

main().catch(err => {
   console.error('\nFatal:', err.message)
   process.exit(1)
})
