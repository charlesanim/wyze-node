#!/usr/bin/env node
/**
 * Xbox Controller Input Handler
 * Reads Xbox controller input and maps it to vacuum commands.
 * 
 * Uses the Web Gamepad API via SDL2 bindings (node-sdl2)
 * or falls back to raw HID reading.
 * 
 * Usage: node tools/xbox-controller.js
 */
'use strict'

const DEAD_ZONE = 0.15
const POLL_RATE_MS = 50 // 20Hz

// Controller button mapping (Xbox layout)
const BUTTONS = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  BACK: 6,
  START: 7,
  LEFT_STICK: 8,
  RIGHT_STICK: 9,
  DPAD_UP: 11,
  DPAD_DOWN: 12,
  DPAD_LEFT: 13,
  DPAD_RIGHT: 14,
}

// Axis mapping
const AXES = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
  LEFT_TRIGGER: 4,
  RIGHT_TRIGGER: 5,
}

class XboxController {
  constructor() {
    this.gamepad = null
    this.lastState = {
      leftStick: { x: 0, y: 0 },
      rightStick: { x: 0, y: 0 },
      buttons: {},
      triggers: { left: 0, right: 0 },
    }
    this.listeners = new Map()
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push(callback)
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || []
    callbacks.forEach(cb => cb(data))
  }

  applyDeadZone(value) {
    if (Math.abs(value) < DEAD_ZONE) return 0
    // Rescale so that just outside dead zone starts near 0
    const sign = value > 0 ? 1 : -1
    return sign * ((Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE))
  }

  /**
   * Convert joystick X/Y to vacuum movement command
   * Returns: { direction: 'forward'|'backward'|'left'|'right'|'stop', speed: 0-100, turnRate: -100 to 100 }
   */
  joystickToMovement(x, y) {
    const ax = this.applyDeadZone(x)
    const ay = this.applyDeadZone(-y) // Invert Y (stick up = forward)

    const magnitude = Math.min(1, Math.sqrt(ax * ax + ay * ay))
    const angle = Math.atan2(ax, ay) // radians, 0 = forward

    if (magnitude < 0.01) {
      return { direction: 'stop', speed: 0, turnRate: 0, raw: { x: ax, y: ay } }
    }

    const speed = Math.round(magnitude * 100)
    const turnRate = Math.round(ax * 100)

    let direction
    if (ay > 0.3) direction = 'forward'
    else if (ay < -0.3) direction = 'backward'
    else if (ax > 0.3) direction = 'right'
    else if (ax < -0.3) direction = 'left'
    else direction = 'forward'

    return {
      direction,
      speed,
      turnRate,
      angle: (angle * 180 / Math.PI),
      raw: { x: ax, y: ay },
    }
  }
}

// Try different gamepad libraries
async function createController() {
  const controller = new XboxController()
  
  // Try node-hid for raw HID access
  let HID
  try {
    HID = require('node-hid')
  } catch (e) {
    // Will install below
  }

  if (!HID) {
    console.log('📦 node-hid not found. Install it with: npm install node-hid')
    console.log('   Or for better support: npm install sdl2-gamepad')
    console.log()
  }

  // List available HID devices
  if (HID) {
    const devices = HID.devices()
    const gamepads = devices.filter(d => {
      const name = ((d.product || '') + (d.manufacturer || '')).toLowerCase()
      return name.includes('xbox') || name.includes('gamepad') || 
             name.includes('controller') || name.includes('joystick') ||
             // Xbox vendor IDs
             d.vendorId === 0x045e || // Microsoft
             d.vendorId === 0x0738 || // Mad Catz
             d.vendorId === 0x0e6f || // PDP
             d.vendorId === 0x1532    // Razer
    })

    if (gamepads.length > 0) {
      console.log('🎮 Found controller(s):')
      gamepads.forEach((g, i) => {
        console.log(`  [${i}] ${g.manufacturer || 'Unknown'} - ${g.product || 'Unknown'}`)
        console.log(`      VID: 0x${g.vendorId.toString(16)} PID: 0x${g.productId.toString(16)}`)
        console.log(`      Path: ${g.path}`)
      })
      console.log()
      return { controller, devices: gamepads, HID }
    }
  }

  console.log('🎮 No controller detected via HID.')
  console.log('   Falling back to keyboard simulation for testing.\n')
  return { controller, devices: [], HID }
}

// Keyboard-based testing fallback
function startKeyboardMode(controller) {
  const readline = require('readline')
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  console.log('⌨️  Keyboard mode (for testing without controller):')
  console.log('   W/A/S/D = Direction   Q/E = Turn   Space = Stop')
  console.log('   1 = Start Clean   2 = Pause   3 = Dock')
  console.log('   Ctrl+C = Quit\n')

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') process.exit()

    const keyMap = {
      w: { direction: 'forward', speed: 60, turnRate: 0 },
      s: { direction: 'backward', speed: 60, turnRate: 0 },
      a: { direction: 'left', speed: 40, turnRate: -60 },
      d: { direction: 'right', speed: 40, turnRate: 60 },
      q: { direction: 'forward', speed: 30, turnRate: -80 },
      e: { direction: 'forward', speed: 30, turnRate: 80 },
      space: { direction: 'stop', speed: 0, turnRate: 0 },
    }

    const movement = keyMap[key.name]
    if (movement) {
      controller.emit('movement', movement)
      const arrow = { forward: '⬆️', backward: '⬇️', left: '⬅️', right: '➡️', stop: '⏹️' }
      process.stdout.write(`\r${arrow[movement.direction] || '?'} ${movement.direction.padEnd(10)} speed:${String(movement.speed).padStart(3)} turn:${String(movement.turnRate).padStart(4)}  `)
    }

    // Button actions
    if (key.name === '1') controller.emit('action', { action: 'start_clean' })
    if (key.name === '2') controller.emit('action', { action: 'pause' })
    if (key.name === '3') controller.emit('action', { action: 'dock' })
    if (key.name === '4') controller.emit('action', { action: 'suction_down' })
    if (key.name === '5') controller.emit('action', { action: 'suction_up' })
    if (key.name === '6') controller.emit('action', { action: 'status' })
  })
}

// Main
async function main() {
  console.log('🎮 Wyze Vacuum Xbox Controller')
  console.log('================================\n')

  const { controller, devices, HID } = await createController()

  // Set up event handlers
  controller.on('movement', (data) => {
    // This will be connected to the vacuum bridge
    // For now, just log
  })

  controller.on('action', (data) => {
    console.log(`\n🔘 Action: ${data.action}`)
  })

  if (devices.length > 0 && HID) {
    // Real controller mode
    const device = new HID.HID(devices[0].path)
    console.log(`✅ Connected to: ${devices[0].product}\n`)

    device.on('data', (buf) => {
      // Xbox controller HID report parsing varies by model
      // This handles the most common format
      const leftX = (buf[1] | (buf[2] << 8)) / 32767 - 1
      const leftY = (buf[3] | (buf[4] << 8)) / 32767 - 1
      const movement = controller.joystickToMovement(leftX, leftY)
      controller.emit('movement', movement)

      const arrow = { forward: '⬆️', backward: '⬇️', left: '⬅️', right: '➡️', stop: '⏹️' }
      process.stdout.write(`\r${arrow[movement.direction] || '?'} ${movement.direction.padEnd(10)} speed:${String(movement.speed).padStart(3)} turn:${String(movement.turnRate).padStart(4)}  `)
    })

    device.on('error', (err) => {
      console.error('Controller error:', err.message)
    })
  } else {
    startKeyboardMode(controller)
  }
}

// Export for use as module
module.exports = { XboxController }

// Run if called directly
if (require.main === module) {
  main().catch(console.error)
}
