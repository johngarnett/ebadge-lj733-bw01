const noble = require('@abandonware/noble')
const { EventEmitter } = require('events')

// UUIDs without dashes — noble requires this format on macOS
const SERVICE_UUID  = '7e400001b5a3f393e0a9e50e24dcca9d'
const WRITE_UUID    = '7e400002b5a3f393e0a9e50e24dcca9d'
const NOTIFY_UUID   = '7e400003b5a3f393e0a9e50e24dcca9d'

const SCAN_TIMEOUT_MS    = 15000
const CONNECT_TIMEOUT_MS = 10000

class BleClient extends EventEmitter {
   constructor() {
      super()
      this._peripheral      = null
      this._writeChar       = null
      this._notifyChar      = null
      this._notifyCallbacks = []
   }

   // Scan for the badge, connect, and set up characteristics.
   // Resolves when ready to send data.
   async connect(targetName = null) {
      await this._waitForPoweredOn()
      const peripheral = await this._scan(targetName)
      await this._connectPeripheral(peripheral)
      await this._setupCharacteristics()
      console.log('BLE ready — connected to', peripheral.advertisement.localName || peripheral.address)
   }

   async disconnect() {
      if (this._peripheral) {
         await this._peripheral.disconnectAsync()
         console.log('Disconnected')
      }
   }

   // Write a Buffer to the badge (no-response write for speed)
   write(buf) {
      if (!this._writeChar) throw new Error('Not connected')
      if (process.env.DEBUG) console.log('→ raw:', buf.toString('hex'))
      this._writeChar.write(buf, true)  // true = withoutResponse
   }

   // Register a callback for incoming notifications from the badge
   onNotify(fn) {
      this._notifyCallbacks.push(fn)
   }

   // Remove a previously registered notify callback
   removeNotifyListener(fn) {
      const idx = this._notifyCallbacks.indexOf(fn)
      if (idx !== -1) this._notifyCallbacks.splice(idx, 1)
   }

   // ── private ────────────────────────────────────────────────────────────────

   _waitForPoweredOn() {
      return new Promise((resolve, reject) => {
         if (noble.state === 'poweredOn') return resolve()
         noble.once('stateChange', state => {
            if (state === 'poweredOn') resolve()
            else reject(new Error(`Bluetooth state: ${state}. Make sure Bluetooth is enabled.`))
         })
      })
   }

   _scan(targetName) {
      return new Promise((resolve, reject) => {
         const timer = setTimeout(() => {
            noble.stopScanning()
            reject(new Error('Scan timeout — badge not found. Make sure it is nearby and awake.'))
         }, SCAN_TIMEOUT_MS)

         console.log('Scanning for badge…')

         noble.on('discover', peripheral => {
            const name = peripheral.advertisement.localName || ''
            console.log(`  Found: ${name || '(unnamed)'} [${peripheral.address}]`)

            const hasOurService = peripheral.advertisement.serviceUuids &&
               peripheral.advertisement.serviceUuids.some(u => u.toLowerCase().replace(/-/g, '') === SERVICE_UUID)

            const nameMatch = targetName
               ? name.toLowerCase().includes(targetName.toLowerCase())
               : true

            if (hasOurService || (targetName && nameMatch)) {
               clearTimeout(timer)
               noble.removeAllListeners('discover')
               noble.stopScanning()
               resolve(peripheral)
            }
         })

         noble.startScanning([], false)
      })
   }

   async _connectPeripheral(peripheral) {
      this._peripheral = peripheral

      peripheral.on('disconnect', () => {
         console.log('Badge disconnected')
         this.emit('disconnect')
      })

      console.log('Connecting…')
      const connectTimer = setTimeout(() => {
         throw new Error('Connection timeout')
      }, CONNECT_TIMEOUT_MS)

      await peripheral.connectAsync()
      clearTimeout(connectTimer)
      console.log('Connected')
   }

   async _setupCharacteristics() {
      const { characteristics } = await this._peripheral
         .discoverSomeServicesAndCharacteristicsAsync(
            [SERVICE_UUID],
            [WRITE_UUID, NOTIFY_UUID]
         )

      for (const char of characteristics) {
         const uuid = char.uuid.toLowerCase()
         if (uuid === WRITE_UUID)  this._writeChar  = char
         if (uuid === NOTIFY_UUID) this._notifyChar = char
      }

      if (!this._writeChar)  throw new Error('Write characteristic not found')
      if (!this._notifyChar) throw new Error('Notify characteristic not found')

      await this._notifyChar.subscribeAsync()
      this._notifyChar.on('data', buf => {
         if (process.env.DEBUG) console.log('← raw:', buf.toString('hex'))
         for (const fn of this._notifyCallbacks) fn(buf)
      })

      console.log('Characteristics ready')
   }
}

module.exports = { BleClient, SERVICE_UUID, WRITE_UUID, NOTIFY_UUID }
