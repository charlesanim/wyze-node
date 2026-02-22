#!/usr/bin/env node
/**
 * Wyze Vacuum Directional Controller
 *
 * Synthetic directional control using real-time position tracking + area clean.
 *
 * How it works:
 *   1. Start the vacuum cleaning (full or room)
 *   2. Poll getCurrentPosition() every ~2s to get x,y coordinates
 *   3. Map joystick/keyboard input to a direction vector
 *   4. Compute target = current_position + direction_offset
 *   5. Send areaClean(target) to steer the vacuum toward the target
 *   6. Repeat — the vacuum continuously navigates toward the joystick direction
 *
 * Position data format (from telemetry):
 *   [{x: 1.278, y: -2.065, task_id: ..., pose_id: ..., is_show: 0}]
 *   Coordinates are in METERS. Updates ~every 2 seconds during cleaning.
 *
 * Usage:
 *   WYZE_KEY_ID=x WYZE_API_KEY=x node tools/directional-controller.js
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue } = require('../venus')
const readline = require('readline')

// ── Config ──
const POSITION_POLL_MS = 2000  // How often to poll position
const STEP_DISTANCE = 0.5     // Meters to move per joystick command
const MIN_MOVE_DIST = 0.15    // Ignore moves smaller than this
const SUCTION_LABELS = ['', 'Quiet', 'Standard', 'Strong']
const MODE_LABELS = {
  0: 'Idle', 1: 'Cleaning', 4: 'Paused', 5: 'Returning',
  7: 'Sweeping', 10: 'Finished', 11: 'Docked', 14: 'Idle',
}

// ── Directional Controller ──

class DirectionalController {
  constructor(venus, did, model, nickname) {
    this.venus = venus
    this.did = did
    this.model = model
    this.nickname = nickname

    // State
    this.position = null      // {x, y, pose_id, task_id}
    this.targetDir = null     // {dx, dy} normalized direction vector
    this.suctionLevel = 3
    this.mode = 0
    this.battery = 100
    this.rooms = []
    this.currentMapName = ''
    this.busy = false
    this.driving = false      // Are we in directional driving mode?
    this.positionHistory = [] // Track movement for display
  }

  /** Initialize: load status, rooms, start position polling */
  async init() {
    const [statusRes, mapsRes] = await Promise.allSettled([
      this.venus.getStatus(this.did),
      this.venus.getMaps(this.did),
    ])

    if (statusRes.status === 'fulfilled') {
      const hb = statusRes.value.data?.heartBeat || {}
      this.mode = hb.mode || 0
      this.battery = hb.battery || 0
      this.suctionLevel = hb.clean_level || 3
    }

    if (mapsRes.status === 'fulfilled' && mapsRes.value.data) {
      const maps = Array.isArray(mapsRes.value.data) ? mapsRes.value.data : [mapsRes.value.data]
      const current = maps.find(m => m.current_map) || maps[0]
      if (current) {
        this.rooms = current.room_info_list || []
        this.currentMapName = current.user_map_name || ''
      }
    }
  }

  /** Start position polling loop */
  startPositionPolling() {
    this._pollInterval = setInterval(async () => {
      try {
        const res = await this.venus.getCurrentPosition(this.did)
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          const pos = res.data[0]
          const prevPos = this.position
          this.position = { x: pos.x, y: pos.y, pose_id: pos.pose_id, task_id: pos.task_id }

          // Track movement
          if (prevPos) {
            const dist = Math.sqrt((pos.x - prevPos.x) ** 2 + (pos.y - prevPos.y) ** 2)
            if (dist > 0.01) {
              this.positionHistory.push({ ...this.position, ts: Date.now() })
              if (this.positionHistory.length > 50) this.positionHistory.shift()
            }
          } else {
            this.positionHistory.push({ ...this.position, ts: Date.now() })
          }

          // Update status display
          this._updateStatusLine()

          // If we're driving and have a target direction, send the next move
          if (this.driving && this.targetDir) {
            await this._executeMove()
          }
        }
      } catch (e) {
        // Silently retry — position may not be available when docked
      }
    }, POSITION_POLL_MS)
  }

  /** Compute target from current position + direction and send area clean */
  async _executeMove() {
    if (!this.position || !this.targetDir || this.busy) return

    const target = {
      x: this.position.x + this.targetDir.dx * STEP_DISTANCE,
      y: this.position.y + this.targetDir.dy * STEP_DISTANCE,
    }

    this.busy = true
    try {
      // Try area clean with coordinates
      await this.venus.areaClean(this.did, [target])
      process.stdout.write(` → (${target.x.toFixed(2)}, ${target.y.toFixed(2)})`)
    } catch (e) {
      // Area clean may not work on this firmware — log once
      if (!this._areaCleanFailed) {
        console.log(`\n⚠️  Area clean failed: ${e.response?.data?.message || e.message}`)
        console.log('   Firmware may not support coordinate-based movement.')
        console.log('   Falling back to room-level control only.')
        this._areaCleanFailed = true
        this.driving = false
      }
    } finally {
      this.busy = false
    }
  }

  /** Set directional target from keyboard input */
  setDirection(dx, dy) {
    if (dx === 0 && dy === 0) {
      this.targetDir = null
      return
    }
    // Normalize
    const mag = Math.sqrt(dx * dx + dy * dy)
    this.targetDir = { dx: dx / mag, dy: dy / mag }
  }

  _updateStatusLine() {
    if (!this.position) return
    const pos = `(${this.position.x.toFixed(2)}, ${this.position.y.toFixed(2)})`
    const dir = this.targetDir
      ? `→ (${(this.position.x + this.targetDir.dx * STEP_DISTANCE).toFixed(2)}, ${(this.position.y + this.targetDir.dy * STEP_DISTANCE).toFixed(2)})`
      : ''
    const mode = this.driving ? '🚗 DRIVING' : MODE_LABELS[this.mode] || `mode:${this.mode}`
    process.stdout.write(`\r📍 ${pos} ${dir} | ${mode} | 🔋${this.battery}%    `)
  }

  /** Safely execute a Venus API command */
  async exec(label, fn) {
    if (this.busy) return
    this.busy = true
    process.stdout.write(`\n${label}`)
    try {
      await fn()
      console.log(' ✅')
    } catch (e) {
      console.log(` ❌ ${e.response?.data?.message || e.message}`)
    } finally {
      this.busy = false
    }
  }

  async refreshStatus() {
    try {
      const res = await this.venus.getStatus(this.did)
      const hb = res.data?.heartBeat || {}
      this.mode = hb.mode || this.mode
      this.battery = hb.battery || this.battery
      this.suctionLevel = hb.clean_level || this.suctionLevel
    } catch (e) { /* ignore */ }
  }

  printStatus() {
    const mode = MODE_LABELS[this.mode] || `Unknown(${this.mode})`
    console.log(`\n📊 ${this.nickname}`)
    console.log(`   Mode: ${mode} | Battery: ${this.battery}% | Suction: ${SUCTION_LABELS[this.suctionLevel]}`)
    if (this.currentMapName) console.log(`   Map: ${this.currentMapName}`)
    if (this.rooms.length) console.log(`   Rooms: ${this.rooms.map(r => r.room_name).join(', ')}`)
    if (this.position) console.log(`   Position: (${this.position.x.toFixed(4)}, ${this.position.y.toFixed(4)}) pose:${this.position.pose_id}`)
    else console.log('   Position: not available (start cleaning to enable tracking)')
  }

  printControls() {
    console.log('')
    console.log('╔══════════════════════════════════════════════════════╗')
    console.log('║  🎮 DIRECTIONAL VACUUM CONTROLLER                   ║')
    console.log('╠══════════════════════════════════════════════════════╣')
    console.log('║                                                      ║')
    console.log('║  Cleaning:                                           ║')
    console.log('║    1 = Start Clean    2 = Pause    3 = Dock          ║')
    console.log('║    4 = Suction ↓      5 = Suction ↑                  ║')
    console.log('║    6 = Status         Space = Stop                   ║')
    console.log('║                                                      ║')
    console.log('║  Directional Driving (while cleaning):               ║')
    console.log('║    W = Forward    S = Backward                       ║')
    console.log('║    A = Left      D = Right                           ║')
    console.log('║    Q = Fwd-Left  E = Fwd-Right                       ║')
    console.log('║    X = Stop driving                                  ║')
    console.log('║                                                      ║')
    if (this.rooms.length) {
      console.log('║  Room Cleaning:                                      ║')
      this.rooms.forEach((r, i) => {
        const key = i <= 2 ? String(i + 7) : '0'
        const line = `║    ${key} = "${r.room_name}"`
        console.log(line.padEnd(55) + ' ║')
      })
      console.log('║                                                      ║')
    }
    console.log('║  m = Quick Map    h = Help    Ctrl+C = Quit          ║')
    console.log('╚══════════════════════════════════════════════════════╝')
    console.log('')
  }

  /** Start interactive keyboard control */
  start() {
    this.printStatus()
    this.printControls()
    this.startPositionPolling()

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

    process.stdin.on('keypress', async (str, key) => {
      if (!key) return
      if (key.ctrl && key.name === 'c') {
        console.log('\n\n👋 Stopping...')
        if (this._pollInterval) clearInterval(this._pollInterval)
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        process.exit()
      }

      switch (key.name) {
        // ── Directional driving ──
        case 'w':
          this.driving = true
          this.setDirection(0, 1)   // Forward (+Y)
          console.log('\n⬆️  Driving FORWARD')
          break
        case 's':
          this.driving = true
          this.setDirection(0, -1)  // Backward (-Y)
          console.log('\n⬇️  Driving BACKWARD')
          break
        case 'a':
          this.driving = true
          this.setDirection(-1, 0)  // Left (-X)
          console.log('\n⬅️  Driving LEFT')
          break
        case 'd':
          this.driving = true
          this.setDirection(1, 0)   // Right (+X)
          console.log('\n➡️  Driving RIGHT')
          break
        case 'q':
          this.driving = true
          this.setDirection(-0.707, 0.707)  // Forward-left
          console.log('\n↖️  Driving FORWARD-LEFT')
          break
        case 'e':
          this.driving = true
          this.setDirection(0.707, 0.707)   // Forward-right
          console.log('\n↗️  Driving FORWARD-RIGHT')
          break
        case 'x':
          this.driving = false
          this.targetDir = null
          console.log('\n⏹️  Driving stopped')
          break

        // ── Standard controls ──
        case '1':
          await this.exec('🧹 Starting clean...', () => this.venus.clean(this.did))
          this.mode = 1
          break
        case '2':
          await this.exec('⏸️  Pausing...', () => this.venus.pause(this.did))
          this.driving = false
          this.targetDir = null
          break
        case '3':
          await this.exec('🏠 Returning to dock...', () => this.venus.dock(this.did))
          this.driving = false
          this.targetDir = null
          break
        case '4':
          this.suctionLevel = Math.max(1, this.suctionLevel - 1)
          await this.exec(`🔈 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break
        case '5':
          this.suctionLevel = Math.min(3, this.suctionLevel + 1)
          await this.exec(`🔊 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break
        case '6':
          await this.refreshStatus()
          this.printStatus()
          break
        case 'space':
          this.driving = false
          this.targetDir = null
          await this.exec('⏹️  Stopping...', () =>
            this.venus.control(this.did, ControlType.GLOBAL_SWEEPING, ControlValue.STOP))
          break
        case 'h':
          this.printControls()
          break
        case 'm':
          await this.exec('🗺️  Quick mapping...', () =>
            this.venus.control(this.did, ControlType.QUICK_MAPPING, ControlValue.START))
          break

        // ── Room cleaning ──
        case '7': case '8': case '9': case '0': {
          const idx = key.name === '0' ? 3 : parseInt(key.name) - 7
          const room = this.rooms[idx]
          if (room) {
            await this.exec(`🚪 Cleaning "${room.room_name}"...`, () =>
              this.venus.sweepRooms(this.did, [room.room_id]))
          }
          break
        }
      }
    })

    // Refresh status every 30s
    setInterval(async () => {
      if (!this.busy) await this.refreshStatus()
    }, 30000)
  }
}

// ── Xbox Controller Support ──

let HID
try { HID = require('node-hid') } catch (e) { /* optional */ }

function setupGamepad(ctrl) {
  if (!HID) return false
  const devices = HID.devices()
  const gp = devices.find(d => {
    const name = ((d.product || '') + (d.manufacturer || '')).toLowerCase()
    return name.includes('xbox') || name.includes('gamepad') ||
           name.includes('controller') || d.vendorId === 0x045e
  })
  if (!gp) return false

  console.log(`🎮 Controller: ${gp.product || gp.manufacturer || 'Xbox Controller'}`)
  try {
    const device = new HID.HID(gp.path)
    const DEAD_ZONE = 0.15

    device.on('data', (buf) => {
      // Parse left stick (common Xbox HID format)
      const rawX = (buf[1] | (buf[2] << 8)) / 32767 - 1
      const rawY = (buf[3] | (buf[4] << 8)) / 32767 - 1

      const x = Math.abs(rawX) < DEAD_ZONE ? 0 : rawX
      const y = Math.abs(rawY) < DEAD_ZONE ? 0 : -rawY // invert Y

      if (x !== 0 || y !== 0) {
        ctrl.driving = true
        ctrl.setDirection(x, y)
      } else if (ctrl.driving) {
        // Stick returned to center — keep current direction
        // (user releases stick = vacuum keeps going in that direction until X pressed)
      }

      // Parse buttons
      const buttons = buf[3] || 0
      if (buttons & 0x01) ctrl.exec('🧹 Clean...', () => ctrl.venus.clean(ctrl.did))
      if (buttons & 0x02) {
        ctrl.exec('⏸️  Pause...', () => ctrl.venus.pause(ctrl.did))
        ctrl.driving = false
        ctrl.targetDir = null
      }
      if (buttons & 0x08) {
        ctrl.exec('🏠 Dock...', () => ctrl.venus.dock(ctrl.did))
        ctrl.driving = false
        ctrl.targetDir = null
      }
    })

    device.on('error', () => console.log('\n🎮 Controller disconnected'))
    return true
  } catch (e) {
    console.log(`⚠️  Controller error: ${e.message}`)
    return false
  }
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  🤖 WYZE VACUUM DIRECTIONAL CONTROLLER              ║')
  console.log('║  Real-time position tracking + synthetic steering    ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log('')

  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY
  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/directional-controller.js')
    process.exit(1)
  }

  const wyze = new Wyze({ keyId, apiKey })
  console.log('🔑 Logging in...')
  await wyze.login()

  console.log('📋 Finding vacuum...')
  const devices = await wyze.getDeviceList()
  const vacuum = devices.find(d => {
    const s = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
    return ['vacuum', 'robot', 'ja_ro'].some(k => s.includes(k))
  })
  if (!vacuum) { console.error('❌ No vacuum found.'); process.exit(1) }

  console.log(`🤖 ${vacuum.nickname} (${vacuum.mac})`)

  const venus = new VenusService(wyze.accessToken)
  const ctrl = new DirectionalController(venus, vacuum.mac, vacuum.product_model, vacuum.nickname)

  console.log('📡 Loading status & maps...')
  await ctrl.init()

  setupGamepad(ctrl)
  ctrl.start()
}

module.exports = { DirectionalController }

if (require.main === module) {
  main().catch(e => {
    console.error(`\n💥 Fatal: ${e.message}`)
    process.exit(1)
  })
}
