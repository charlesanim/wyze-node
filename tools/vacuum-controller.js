#!/usr/bin/env node
/**
 * Wyze Vacuum Controller — Xbox / Keyboard Remote Control
 *
 * Full remote control of your Wyze robot vacuum via an Xbox controller
 * or keyboard. Supports clean, pause, dock, room selection, suction
 * levels, and real-time status monitoring.
 *
 * Usage:
 *   WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue, VacuumMode } = require('../venus')
const readline = require('readline')

// ── Status helpers ──

const SUCTION_LABELS = ['', 'Quiet', 'Standard', 'Strong']
const MODE_LABELS = {
  0: 'Idle', 14: 'Idle', 29: 'Idle', 35: 'Idle', 40: 'Idle',
  1: 'Cleaning', 30: 'Cleaning', 1101: 'Cleaning', 1201: 'Cleaning', 1301: 'Cleaning', 1401: 'Cleaning',
  4: 'Paused', 31: 'Paused', 1102: 'Paused', 1202: 'Paused', 1302: 'Paused', 1402: 'Paused',
  5: 'Returning to dock',
  7: 'Sweeping', 25: 'Sweeping', 36: 'Sweeping',
  10: 'Finished (returning)', 32: 'Finished (returning)', 1103: 'Finished (returning)',
  11: 'Docked (incomplete)', 33: 'Docked (incomplete)',
}

function modeLabel(code) {
  return MODE_LABELS[code] || `Unknown (${code})`
}

// ── Controller ──

class VacuumController {
  constructor(wyze, venus, vacuumDevice) {
    this.wyze = wyze
    this.venus = venus
    this.vacuum = vacuumDevice
    this.suctionLevel = 3 // loaded from heartbeat
    this.rooms = []       // [{room_id, room_name}]
    this.currentMapId = null
    this.heartbeat = null
    this.busy = false     // prevents concurrent API calls
  }

  get did() { return this.vacuum.mac }
  get model() { return this.vacuum.product_model }

  /** Load maps/rooms and current status */
  async init() {
    try {
      const [statusRes, mapsRes] = await Promise.all([
        this.venus.getStatus(this.did),
        this.venus.getMaps(this.did),
      ])

      // Parse heartbeat
      this.heartbeat = statusRes.data?.heartBeat || {}
      this.suctionLevel = this.heartbeat.clean_level || 3
      this.currentMapId = this.heartbeat.current_map_id

      // Load rooms from current map
      if (mapsRes.data) {
        const maps = Array.isArray(mapsRes.data) ? mapsRes.data : [mapsRes.data]
        const currentMap = maps.find(m => m.current_map) || maps.find(m => m.map_id === this.currentMapId) || maps[0]
        if (currentMap) {
          this.rooms = currentMap.room_info_list || []
          this.currentMapName = currentMap.user_map_name || currentMap.mapName || ''
        }
      }
    } catch (e) {
      console.error(`⚠️  Init warning: ${e.response?.data?.message || e.message}`)
    }
  }

  printStatus() {
    const hb = this.heartbeat || {}
    const mode = modeLabel(hb.mode)
    const battery = hb.battery || '?'
    const charging = hb.charge_state === 1 ? ' ⚡' : ''
    const suction = SUCTION_LABELS[hb.clean_level] || '?'
    const fault = hb.fault_code ? ` | fault: ${hb.fault_code}` : ''

    console.log(`\n📊 ${this.vacuum.nickname}`)
    console.log(`   Mode: ${mode} | Battery: ${battery}%${charging} | Suction: ${suction}${fault}`)
    if (this.currentMapName) {
      console.log(`   Map: ${this.currentMapName}`)
    }
    if (this.rooms.length) {
      console.log(`   Rooms: ${this.rooms.map(r => `${r.room_name}(${r.room_id})`).join(', ')}`)
    }
  }

  async refreshStatus() {
    try {
      const res = await this.venus.getStatus(this.did)
      this.heartbeat = res.data?.heartBeat || this.heartbeat
      this.suctionLevel = this.heartbeat.clean_level || this.suctionLevel
    } catch (e) {
      console.error(`⚠️  Status error: ${e.response?.data?.message || e.message}`)
    }
  }

  /** Execute an action (debounced to prevent concurrent API calls) */
  async exec(label, fn) {
    if (this.busy) {
      console.log('   ⏳ Please wait...')
      return
    }
    this.busy = true
    process.stdout.write(`${label}`)
    try {
      const result = await fn()
      console.log(' ✅')
      return result
    } catch (e) {
      const msg = e.response?.data?.message || e.message
      console.log(` ❌ ${msg}`)
    } finally {
      this.busy = false
    }
  }

  /** Start the interactive controller */
  start() {
    this.printStatus()
    this.printControls()

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

    process.stdin.on('keypress', async (str, key) => {
      if (!key) return
      if (key.ctrl && key.name === 'c') {
        console.log('\n👋 Goodbye!')
        process.exit()
      }

      switch (key.name) {
        // ── Cleaning ──
        case '1':
          await this.exec('\n🧹 Starting full clean...', () => this.venus.clean(this.did))
          break
        case '2':
          await this.exec('\n⏸️  Pausing...', () => this.venus.pause(this.did))
          break
        case '3':
          await this.exec('\n🏠 Returning to dock...', () => this.venus.dock(this.did))
          break

        // ── Room cleaning (number keys 7-0 map to rooms) ──
        case '7': case '8': case '9': case '0': {
          const roomIdx = key.name === '0' ? 3 : parseInt(key.name) - 7
          const room = this.rooms[roomIdx]
          if (room) {
            await this.exec(`\n🚪 Cleaning "${room.room_name}"...`, () =>
              this.venus.sweepRooms(this.did, [room.room_id]))
          } else {
            console.log(`\n❓ No room at index ${roomIdx}`)
          }
          break
        }

        // ── Suction ──
        case '4':
          this.suctionLevel = Math.max(1, this.suctionLevel - 1)
          await this.exec(`\n🔈 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break
        case '5':
          this.suctionLevel = Math.min(3, this.suctionLevel + 1)
          await this.exec(`\n🔊 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break

        // ── Status ──
        case '6':
          await this.refreshStatus()
          this.printStatus()
          break

        // ── Help ──
        case 'h':
          this.printControls()
          break

        // ── Quick mapping ──
        case 'm':
          await this.exec('\n🗺️  Starting quick mapping...', () =>
            this.venus.control(this.did, ControlType.QUICK_MAPPING, ControlValue.START))
          break

        // ── Stop everything ──
        case 'space':
          await this.exec('\n⏹️  Stopping...', () =>
            this.venus.control(this.did, ControlType.GLOBAL_SWEEPING, ControlValue.STOP))
          break
      }
    })

    // Periodic status refresh (every 30s)
    this._statusInterval = setInterval(async () => {
      if (!this.busy) {
        await this.refreshStatus()
        const hb = this.heartbeat || {}
        const mode = modeLabel(hb.mode)
        const batt = hb.battery || '?'
        process.stdout.write(`\r💡 ${mode} | ${batt}%  `)
      }
    }, 30000)
  }

  printControls() {
    console.log('')
    console.log('╔══════════════════════════════════════════════════╗')
    console.log('║  🎮 WYZE VACUUM CONTROLLER                     ║')
    console.log('╠══════════════════════════════════════════════════╣')
    console.log('║  1 = Start Clean (full house)                   ║')
    console.log('║  2 = Pause / Resume                             ║')
    console.log('║  3 = Return to Dock                             ║')
    console.log('║  4 = Suction ↓    5 = Suction ↑                 ║')
    console.log('║  6 = Refresh Status                             ║')
    if (this.rooms.length) {
      console.log('║                                                  ║')
      console.log('║  Room Cleaning:                                  ║')
      this.rooms.forEach((r, i) => {
        const key = i <= 2 ? String(i + 7) : '0'
        const line = `║  ${key} = Clean "${r.room_name}"`
        console.log(line.padEnd(51) + '║')
      })
    }
    console.log('║                                                  ║')
    console.log('║  m = Quick Map    Space = Stop    h = Help       ║')
    console.log('║  Ctrl+C = Quit                                   ║')
    console.log('╚══════════════════════════════════════════════════╝')
    console.log('')
  }

  stop() {
    if (this._statusInterval) clearInterval(this._statusInterval)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  }
}

// ── Xbox Controller Support ──

let HID
try { HID = require('node-hid') } catch (e) { /* optional */ }

function detectGamepad() {
  if (!HID) return null
  const devices = HID.devices()
  return devices.find(d => {
    const name = ((d.product || '') + (d.manufacturer || '')).toLowerCase()
    return name.includes('xbox') || name.includes('gamepad') ||
           name.includes('controller') || name.includes('joystick') ||
           d.vendorId === 0x045e || d.vendorId === 0x0738 ||
           d.vendorId === 0x0e6f || d.vendorId === 0x1532
  })
}

function setupGamepad(vc) {
  const info = detectGamepad()
  if (!info) return false

  console.log(`🎮 Xbox controller detected: ${info.product || info.manufacturer || 'Unknown'}`)

  try {
    const device = new HID.HID(info.path)
    let lastButtons = 0

    device.on('data', (buf) => {
      // Parse Xbox controller buttons (byte varies by model, check common positions)
      const buttons = buf[3] || 0
      if (buttons === lastButtons) return
      lastButtons = buttons

      // A=0x01 B=0x02 X=0x04 Y=0x08 LB=0x10 RB=0x20
      if (buttons & 0x01) vc.exec('\n🧹 Starting clean...', () => vc.venus.clean(vc.did))
      if (buttons & 0x02) vc.exec('\n⏸️  Pausing...', () => vc.venus.pause(vc.did))
      if (buttons & 0x08) vc.exec('\n🏠 Returning to dock...', () => vc.venus.dock(vc.did))
      if (buttons & 0x10) { // LB = suction down
        vc.suctionLevel = Math.max(1, vc.suctionLevel - 1)
        vc.exec(`\n🔈 Suction → ${SUCTION_LABELS[vc.suctionLevel]}...`, () =>
          vc.venus.setSuctionLevel(vc.did, vc.model, vc.suctionLevel))
      }
      if (buttons & 0x20) { // RB = suction up
        vc.suctionLevel = Math.min(3, vc.suctionLevel + 1)
        vc.exec(`\n🔊 Suction → ${SUCTION_LABELS[vc.suctionLevel]}...`, () =>
          vc.venus.setSuctionLevel(vc.did, vc.model, vc.suctionLevel))
      }
    })

    device.on('error', (err) => {
      console.error(`\n🎮 Controller disconnected: ${err.message}`)
    })
    return true
  } catch (e) {
    console.log(`⚠️  Could not open controller: ${e.message}`)
    return false
  }
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  🤖 WYZE VACUUM REMOTE CONTROL                 ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log('')

  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY

  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js')
    console.error('Get your keys at: https://developer-api-console.wyze.com')
    process.exit(1)
  }

  const wyze = new Wyze({ keyId, apiKey })

  console.log('🔑 Logging in...')
  await wyze.login()

  console.log('📋 Finding vacuum...')
  const devices = await wyze.getDeviceList()

  const vacuumMac = process.env.VACUUM_MAC
  let vacuum
  if (vacuumMac) {
    vacuum = devices.find(d => d.mac === vacuumMac)
  } else {
    const keywords = ['vacuum', 'robot', 'vac', 'sweep', 'ja_ro']
    vacuum = devices.find(d => {
      const s = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
      return keywords.some(k => s.includes(k))
    })
  }

  if (!vacuum) {
    console.error('❌ No vacuum found. Set VACUUM_MAC or check device list.')
    process.exit(1)
  }

  console.log(`🤖 ${vacuum.nickname} (${vacuum.mac})`)

  const venus = new VenusService(wyze.accessToken)
  const vc = new VacuumController(wyze, venus, vacuum)

  console.log('📡 Loading status & maps...')
  await vc.init()

  // Try Xbox controller, fall back to keyboard
  const hasGamepad = setupGamepad(vc)
  if (!hasGamepad) {
    console.log('⌨️  Using keyboard controls (connect Xbox controller for gamepad support)')
  }

  vc.start()
}

module.exports = { VacuumController }

if (require.main === module) {
  main().catch(e => {
    console.error(`\n💥 Fatal: ${e.message}`)
    process.exit(1)
  })
}
