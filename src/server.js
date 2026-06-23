const express = require('express')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')

const { BleClient }    = require('./ble/BleClient')
const { FileTransfer } = require('./protocol/fileTransfer')
const { queryCaps }    = require('./protocol/deviceQuery')

const PORT        = 3000
const TARGET_NAME = process.argv[2] || 'BW01'
const TMP_DIR     = path.join(__dirname, '../uploads')
const RECONNECT_DELAY_MS = 5000

const app    = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10_000_000 } })

app.use(express.json())
app.use(express.static(path.join(__dirname, 'web')))

// ── Badge state ──────────────────────────────────────────────────────────────

let ble      = null
let transfer = null

const badge = {
   connected:    false,
   connecting:   false,
   busy:         false,
   name:         null,
   address:      null,
   battery:      null,
   manufacturer: null,
   firmware:     null,
   hardware:     null,
   model:        null,
   screenWidth:  null,
   screenHeight: null,
   maxFileSize:  null,
}

// ── Connection management ────────────────────────────────────────────────────

async function connectBadge() {
   if (badge.connected || badge.connecting) return
   badge.connecting = true
   console.log(`Scanning for badge "${TARGET_NAME}"…`)

   try {
      ble      = new BleClient()
      transfer = new FileTransfer(ble)

      ble.once('disconnect', () => {
         badge.connected    = false
         badge.connecting   = false
         badge.battery      = null
         console.log('Badge disconnected — reconnecting in 5 s…')
         setTimeout(connectBadge, RECONNECT_DELAY_MS)
      })

      await ble.connect(TARGET_NAME)

      badge.name    = ble.advertisedName || TARGET_NAME
      badge.address = ble.address

      badge.battery = await ble.readBatteryLevel()

      const info = await ble.readDeviceInfo()
      badge.manufacturer = info.manufacturer
      badge.firmware     = info.firmware
      badge.hardware     = info.hardware
      badge.model        = info.model

      try {
         const caps = await queryCaps(ble)
         badge.screenWidth  = caps.width
         badge.screenHeight = caps.height
         badge.maxFileSize  = caps.maxFileSize
      } catch (capsErr) {
         console.warn('CAPS query failed (non-fatal):', capsErr.message)
      }

      badge.connected  = true
      badge.connecting = false
      const batt = badge.battery !== null ? `${badge.battery}%` : 'unknown'
      console.log(`Ready: ${badge.name} (${badge.address}), battery: ${batt}`)

   } catch (err) {
      badge.connecting = false
      console.error('Connection failed:', err.message)
      setTimeout(connectBadge, RECONNECT_DELAY_MS)
   }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireConnected(res) {
   if (!badge.connected) {
      res.status(503).json({ error: 'Badge not connected' })
      return false
   }
   return true
}

function requireNotBusy(res) {
   if (badge.busy) {
      res.status(409).json({ error: 'Badge is busy with another operation' })
      return false
   }
   return true
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
   if (badge.connected && ble) {
      try {
         badge.battery = await ble.readBatteryLevel()
      } catch {}
   }
   res.json({ ...badge })
})

app.get('/api/battery', async (req, res) => {
   if (!requireConnected(res)) return
   try {
      const level = await ble.readBatteryLevel()
      badge.battery = level
      res.json({ level })
   } catch (err) {
      res.status(500).json({ error: err.message })
   }
})


app.post('/api/send', upload.single('image'), async (req, res) => {
   if (!req.file) return res.status(400).json({ error: 'No image file provided' })
   if (!requireConnected(res) || !requireNotBusy(res)) return

   badge.busy = true
   fs.mkdirSync(TMP_DIR, { recursive: true })

   const ext     = path.extname(req.file.originalname) || '.jpg'
   const tmpPath = path.join(TMP_DIR, `upload_${Date.now()}${ext}`)

   try {
      fs.writeFileSync(tmpPath, req.file.buffer)
      const crop = (req.body.cropX != null)
         ? { x: Number(req.body.cropX), y: Number(req.body.cropY), size: Number(req.body.cropSize) }
         : null
      const { quality, size } = await transfer.sendFile(tmpPath, { crop })
      badge.battery = await ble.readBatteryLevel().catch(() => badge.battery)
      res.json({ success: true, quality, size })
   } catch (err) {
      res.status(500).json({ error: err.message })
   } finally {
      badge.busy = false
      fs.unlink(tmpPath, () => {})
   }
})


// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
   console.log(`Badge Manager running at http://localhost:${PORT}`)
   connectBadge()
})
