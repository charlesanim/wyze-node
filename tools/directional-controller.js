#!/usr/bin/env node
/**
 * Wyze Vacuum — Xbox Controller with Directional Driving
 *
 * Drive your Wyze robot vacuum with an Xbox controller using synthetic
 * directional control powered by real-time position tracking.
 *
 * How it works:
 *   1. Start the vacuum cleaning (A button or room select)
 *   2. Poll getCurrentPosition() every ~2s to get x,y in meters
 *   3. Left stick → direction vector → target = position + offset
 *   4. Send areaClean(target) to steer the vacuum
 *   5. Repeat — vacuum continuously navigates toward the stick direction
 *
 * Xbox Controller Layout:
 *   Left Stick   — Directional driving (all 360°)
 *   A            — Start cleaning
 *   B            — Pause
 *   X            — Stop driving
 *   Y            — Return to dock
 *   LB / RB      — Suction down / up
 *   D-Pad Up/Dn  — Select room
 *   D-Pad Right  — Clean selected room
 *   Start        — Refresh status
 *   Back         — Quick mapping
 *
 * Falls back to keyboard (WASD) if no controller connected.
 *
 * Usage:
 *   WYZE_KEY_ID=x WYZE_API_KEY=x node tools/directional-controller.js
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue } = require('../venus')
const readline = require('readline')

// ── Config ──
const POSITION_POLL_MS = 2000
const GAMEPAD_POLL_MS = 50    // 20Hz input polling
const STEP_DISTANCE = 0.5    // Meters per directional command
const DEAD_ZONE = 0.25       // High dead zone — Xbox Series X sticks drift
const DRIVE_THRESHOLD = 0.4  // Stick must be pushed past this to engage driving
const SUCTION_LABELS = ['', 'Quiet', 'Standard', 'Strong']
const MODE_LABELS = {
  0: 'Idle', 1: 'Cleaning', 4: 'Paused', 5: 'Returning',
  7: 'Sweeping', 9: 'Paused', 10: 'Finished', 11: 'Docked',
  14: 'Idle', 25: 'Sweeping', 27: 'Paused', 29: 'Idle',
  30: 'Cleaning', 31: 'Paused', 32: 'Returning', 35: 'Idle',
  36: 'Sweeping', 37: 'Paused', 39: 'Breakpoint', 40: 'Idle',
  45: 'Mapping',
}

// Standard Gamepad button indices (W3C mapping)
const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
}

// ── Controller ──

class DirectionalController {
  constructor(venus, did, model, nickname) {
    this.venus = venus
    this.did = did
    this.model = model
    this.nickname = nickname

    this.position = null
    this.direction = { dx: 0, dy: 0 }
    this.suctionLevel = 3
    this.mode = 0
    this.battery = 100
    this.rooms = []
    this.currentMapName = ''
    this.selectedRoom = 0
    this.busy = false
    this.driving = false
    this._areaCleanFailed = false
    this._lastBtnState = {}
  }

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

  // ── Position Tracking ──

  startPositionPolling() {
    this._posPoll = setInterval(async () => {
      try {
        const res = await this.venus.getCurrentPosition(this.did)
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          this.position = { x: res.data[0].x, y: res.data[0].y, pose_id: res.data[0].pose_id }
          if (this.driving && (this.direction.dx !== 0 || this.direction.dy !== 0)) {
            await this._executeMove()
          }
        }
      } catch (e) { /* position not available when docked */ }
    }, POSITION_POLL_MS)
  }

  async _executeMove() {
    if (!this.position || this.busy || this._areaCleanFailed) return
    if (this.direction.dx === 0 && this.direction.dy === 0) return

    const target = {
      x: this.position.x + this.direction.dx * STEP_DISTANCE,
      y: this.position.y + this.direction.dy * STEP_DISTANCE,
    }

    this.busy = true
    try {
      const result = await this.venus.areaClean(this.did, [target])
      // Check if the API actually acted on it (code 1 = success, but vacuum may ignore coords)
      if (result.code !== 1) {
        console.log(`\n⚠️  Area clean response code: ${result.code} — ${result.message}`)
      }
    } catch (e) {
      if (!this._areaCleanFailed) {
        console.log(`\n⚠️  Area clean not supported: ${e.response?.data?.message || e.message}`)
        console.log('   Your firmware (1.6.55) may not support coordinate-based steering.')
        console.log('   Firmware 1.6.173+ required. Use room-level control instead.')
        this._areaCleanFailed = true
        this.driving = false
      }
    } finally {
      this.busy = false
    }
  }

  // ── Xbox Controller Input ──

  processGamepadInput(gamepad) {
    // Left stick → direction (with aggressive dead zone)
    let lx = gamepad.axes[0] || 0
    let ly = gamepad.axes[1] || 0
    lx = Math.abs(lx) < DEAD_ZONE ? 0 : lx
    ly = Math.abs(ly) < DEAD_ZONE ? 0 : -ly  // invert Y: stick up = forward

    const mag = Math.min(1, Math.sqrt(lx * lx + ly * ly))

    if (mag > DRIVE_THRESHOLD) {
      // Stick pushed hard enough — engage/update driving
      if (!this.driving) {
        this.driving = true
        const angle = (Math.atan2(lx, ly) * 180 / Math.PI).toFixed(0)
        console.log(`\n🚗 Driving engaged (${angle}°)`)
      }
      this.direction = { dx: lx / mag, dy: ly / mag }
      this._stickReleaseTime = null
    } else if (this.driving) {
      // Stick returned to center — auto-disengage after 500ms
      if (!this._stickReleaseTime) {
        this._stickReleaseTime = Date.now()
      } else if (Date.now() - this._stickReleaseTime > 500) {
        this.driving = false
        this.direction = { dx: 0, dy: 0 }
        this._stickReleaseTime = null
        // Don't spam "stopped" messages
        if (!this._lastStopMsg || Date.now() - this._lastStopMsg > 2000) {
          console.log('\n⏹️  Stick released — driving stopped')
          this._lastStopMsg = Date.now()
        }
      }
    }

    // Button presses (edge-triggered: fire only on press, not hold)
    const pressed = (idx) => {
      const now = gamepad.buttons[idx] ? gamepad.buttons[idx].pressed : false
      const was = this._lastBtnState[idx] || false
      this._lastBtnState[idx] = now
      return now && !was
    }

    if (pressed(BTN.A)) this.exec('🧹 Clean...', () => this.venus.clean(this.did))
    if (pressed(BTN.B)) {
      this.driving = false
      this.direction = { dx: 0, dy: 0 }
      this.exec('⏸️  Pause...', () => this.venus.pause(this.did))
    }
    if (pressed(BTN.X)) {
      this.driving = false
      this.direction = { dx: 0, dy: 0 }
      console.log('\n⏹️  Driving stopped')
    }
    if (pressed(BTN.Y)) {
      this.driving = false
      this.direction = { dx: 0, dy: 0 }
      this.exec('🏠 Dock...', () => this.venus.dock(this.did))
    }
    if (pressed(BTN.LB)) {
      this.suctionLevel = Math.max(1, this.suctionLevel - 1)
      this.exec(`🔈 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
        this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
    }
    if (pressed(BTN.RB)) {
      this.suctionLevel = Math.min(3, this.suctionLevel + 1)
      this.exec(`🔊 Suction → ${SUCTION_LABELS[this.suctionLevel]}...`, () =>
        this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
    }
    if (pressed(BTN.DPAD_UP) && this.rooms.length) {
      this.selectedRoom = (this.selectedRoom - 1 + this.rooms.length) % this.rooms.length
      console.log(`\n📌 Room: ${this.rooms[this.selectedRoom].room_name} [D-Pad → to clean]`)
    }
    if (pressed(BTN.DPAD_DOWN) && this.rooms.length) {
      this.selectedRoom = (this.selectedRoom + 1) % this.rooms.length
      console.log(`\n📌 Room: ${this.rooms[this.selectedRoom].room_name} [D-Pad → to clean]`)
    }
    if (pressed(BTN.DPAD_RIGHT)) {
      const room = this.rooms[this.selectedRoom]
      if (room) {
        this.exec(`🚪 "${room.room_name}"...`, () =>
          this.venus.sweepRooms(this.did, [room.room_id]))
      }
    }
    if (pressed(BTN.START)) {
      this.refreshStatus().then(() => this.printStatus())
    }
    if (pressed(BTN.BACK)) {
      this.exec('🗺️  Mapping...', () =>
        this.venus.control(this.did, ControlType.QUICK_MAPPING, ControlValue.START))
    }

    this._updateHUD(mag)
  }

  _updateHUD(stickMag) {
    const pos = this.position
      ? `(${this.position.x.toFixed(2)},${this.position.y.toFixed(2)})`
      : '(—,—)'
    const modeStr = this.driving
      ? '🚗 DRIVE'
      : (MODE_LABELS[this.mode] || `mode:${this.mode}`)
    const stick = stickMag > DEAD_ZONE
      ? ` 🕹️${(Math.atan2(this.direction.dx, this.direction.dy) * 180 / Math.PI).toFixed(0)}° ${(stickMag * 100).toFixed(0)}%`
      : ''
    const room = this.rooms[this.selectedRoom]
      ? ` [${this.rooms[this.selectedRoom].room_name}]`
      : ''
    process.stdout.write(`\r📍${pos} ${modeStr} 🔋${this.battery}%${stick}${room}          `)
  }

  // ── Keyboard Fallback ──

  startKeyboard() {
    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)

    process.stdin.on('keypress', async (str, key) => {
      if (!key) return
      if (key.ctrl && key.name === 'c') { this.shutdown(); process.exit() }

      const dirs = {
        w: { dx: 0, dy: 1 }, s: { dx: 0, dy: -1 },
        a: { dx: -1, dy: 0 }, d: { dx: 1, dy: 0 },
        q: { dx: -0.707, dy: 0.707 }, e: { dx: 0.707, dy: 0.707 },
      }

      if (dirs[key.name]) {
        this.driving = true
        this.direction = dirs[key.name]
        const labels = { w: '⬆️ FWD', s: '⬇️ BACK', a: '⬅️ LEFT', d: '➡️ RIGHT', q: '↖️ FWD-L', e: '↗️ FWD-R' }
        console.log(`\n${labels[key.name]}`)
      }

      switch (key.name) {
        case 'x':
          this.driving = false
          this.direction = { dx: 0, dy: 0 }
          console.log('\n⏹️  Driving stopped')
          break
        case 'space':
          this.driving = false
          this.direction = { dx: 0, dy: 0 }
          await this.exec('⏹️  Stop...', () =>
            this.venus.control(this.did, ControlType.GLOBAL_SWEEPING, ControlValue.STOP))
          break
        case '1': await this.exec('🧹 Clean...', () => this.venus.clean(this.did)); break
        case '2':
          this.driving = false
          await this.exec('⏸️  Pause...', () => this.venus.pause(this.did))
          break
        case '3':
          this.driving = false
          await this.exec('🏠 Dock...', () => this.venus.dock(this.did))
          break
        case '4':
          this.suctionLevel = Math.max(1, this.suctionLevel - 1)
          await this.exec(`🔈 Suction → ${SUCTION_LABELS[this.suctionLevel]}`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break
        case '5':
          this.suctionLevel = Math.min(3, this.suctionLevel + 1)
          await this.exec(`🔊 Suction → ${SUCTION_LABELS[this.suctionLevel]}`, () =>
            this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel))
          break
        case '6': await this.refreshStatus(); this.printStatus(); break
        case 'h': this.printControls(); break
        case '7': case '8': case '9': case '0': {
          const idx = key.name === '0' ? 3 : parseInt(key.name) - 7
          const room = this.rooms[idx]
          if (room) await this.exec(`🚪 "${room.room_name}"...`, () =>
            this.venus.sweepRooms(this.did, [room.room_id]))
          break
        }
      }
    })
  }

  // ── Helpers ──

  async exec(label, fn) {
    if (this.busy) return
    this.busy = true
    process.stdout.write(`\n${label}`)
    try { await fn(); console.log(' ✅') }
    catch (e) { console.log(` ❌ ${e.response?.data?.message || e.message}`) }
    finally { this.busy = false }
  }

  async refreshStatus() {
    try {
      const res = await this.venus.getStatus(this.did)
      const hb = res.data?.heartBeat || {}
      this.mode = hb.mode ?? this.mode
      this.battery = hb.battery ?? this.battery
      this.suctionLevel = hb.clean_level ?? this.suctionLevel
    } catch (e) { /* ignore */ }
  }

  printStatus() {
    const mode = MODE_LABELS[this.mode] || `Unknown(${this.mode})`
    console.log(`\n📊 ${this.nickname}`)
    console.log(`   Mode: ${mode} | Battery: ${this.battery}% | Suction: ${SUCTION_LABELS[this.suctionLevel]}`)
    if (this.currentMapName) console.log(`   Map: ${this.currentMapName}`)
    if (this.rooms.length) {
      this.rooms.forEach((r, i) => {
        const sel = i === this.selectedRoom ? ' ◀' : ''
        console.log(`   ${i === this.selectedRoom ? '→' : ' '} ${r.room_name}${sel}`)
      })
    }
    if (this.position) console.log(`   Position: (${this.position.x.toFixed(4)}, ${this.position.y.toFixed(4)})`)
    else console.log('   Position: not available (start cleaning to enable tracking)')
  }

  printControls() {
    console.log('')
    console.log('╔══════════════════════════════════════════════════════════╗')
    console.log('║  🎮 XBOX CONTROLLER                                     ║')
    console.log('║                                                          ║')
    console.log('║  A = Start Clean       B = Pause                        ║')
    console.log('║  Y = Return to Dock    X = Stop driving                 ║')
    console.log('║  LB = Suction ↓        RB = Suction ↑                    ║')
    console.log('║  D-Pad ↑↓ = Select room                                 ║')
    console.log('║  D-Pad →  = Clean selected room                         ║')
    console.log('║  Start = Status        Back = Quick Map                 ║')
    console.log('║                                                          ║')
    console.log('║  Left Stick = Directional steering *                    ║')
    console.log('║  * Requires firmware ≥ 1.6.173 for coordinate steering  ║')
    console.log('╠══════════════════════════════════════════════════════════╣')
    console.log('║  ⌨️  KEYBOARD: WASD=Drive  1=Clean 2=Pause 3=Dock       ║')
    console.log('║  4/5=Suction  6=Status  7-0=Rooms  h=Help  Ctrl+C=Quit ║')
    console.log('╚══════════════════════════════════════════════════════════╝')
    console.log('')
  }

  shutdown() {
    if (this._posPoll) clearInterval(this._posPoll)
    if (this._gpPoll) clearInterval(this._gpPoll)
    if (this._statusPoll) clearInterval(this._statusPoll)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    console.log('\n👋 Goodbye!')
  }

  start(gamepadAvailable) {
    this.printStatus()
    this.printControls()
    this.startPositionPolling()
    this.startKeyboard()

    this._statusPoll = setInterval(async () => {
      if (!this.busy) await this.refreshStatus()
    }, 30000)

    if (gamepadAvailable) {
      console.log('🎮 Xbox controller connected! Use left stick to drive.\n')
    } else {
      console.log('⌨️  No controller detected — using keyboard (WASD).')
      console.log('   Connect Xbox controller via Bluetooth/USB and restart.\n')
    }
  }
}

// ── Gamepad Setup (uses gamepad-node / W3C Gamepad API) ──

function setupGamepad(ctrl) {
  let gp
  try {
    gp = require('gamepad-node')
    gp.installNavigatorShim()
  } catch (e) {
    console.log('⚠️  gamepad-node not available. Install: npm install gamepad-node')
    return false
  }

  // Check for initial connection
  const pads = navigator.getGamepads()
  const initial = pads.find(p => p)
  if (initial) {
    console.log(`🎮 ${initial.id} (${initial.buttons.length} buttons, ${initial.axes.length} axes)`)
  }

  // Poll gamepad at 20Hz
  ctrl._gpPoll = setInterval(() => {
    const pads = navigator.getGamepads()
    const pad = pads.find(p => p)
    if (pad) {
      ctrl.processGamepadInput(pad)
    }
  }, GAMEPAD_POLL_MS)

  return !!initial
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  🤖 WYZE VACUUM — XBOX CONTROLLER                      ║')
  console.log('║  Directional driving with real-time position tracking   ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
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

  const hasGamepad = setupGamepad(ctrl)
  ctrl.start(hasGamepad)

  process.on('SIGINT', () => { ctrl.shutdown(); process.exit() })
}

module.exports = { DirectionalController }

if (require.main === module) {
  main().catch(e => { console.error(`\n💥 ${e.message}`); process.exit(1) })
}
