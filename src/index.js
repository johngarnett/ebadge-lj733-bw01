const path = require('path')
const { BleClient } = require('./ble/BleClient')
const { FileTransfer } = require('./protocol/fileTransfer')

async function main() {
   const args = process.argv.slice(2)

   if (args.length === 0) {
      console.error('Usage: node src/index.js <image-file> [badge-name]')
      console.error('  image-file  path to a JPEG image (360x360 recommended)')
      console.error('  badge-name  optional: filter scan by BLE device name')
      process.exit(1)
   }

   const imagePath  = path.resolve(args[0])
   const badgeName  = args[1] || null

   const ble      = new BleClient()
   const transfer = new FileTransfer(ble)

   transfer.on('status', buf => {
      console.log('Badge status:', buf.toString('hex'))
   })

   ble.on('disconnect', () => {
      console.error('Badge disconnected unexpectedly')
      process.exit(1)
   })

   try {
      await ble.connect(badgeName)
      console.log(`\nSending ${imagePath}…\n`)
      await transfer.sendFile(imagePath)
      console.log('\nTransfer complete ✓')
   } catch (err) {
      console.error('\nError:', err.message)
      process.exit(1)
   } finally {
      await ble.disconnect()
      process.exit(0)
   }
}

main()
