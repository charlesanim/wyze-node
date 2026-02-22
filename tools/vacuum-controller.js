#!/usr/bin/env node
/**
 * Wyze Vacuum Controller - Main Entry Point
 * Connects Xbox controller input to Wyze vacuum movement commands.
 * 
 * Usage:
 *   WYZE_EMAIL=you@email.com WYZE_PASSWORD=yourpass node tools/vacuum-controller.js
 * 
 * This is the integration layer that will be completed once we discover
 * the movement protocol from mitmproxy analysis.
 */
'use strict'

const Wyze = require('../index')
const { XboxController } = require('./xbox-controller')

class VacuumController {
  constructor(wyze, vacuumDevice) {
    this.wyze = wyze
    this.vacuum = vacuumDevice
    this.controller = new XboxController()
    this.isMoving = false
    this.lastCommand = null
    this.commandInterval = null
  }

  /**
   * Send a movement command to the vacuum.
   * TODO: Replace with actual API calls once we discover the protocol.
   */
  async sendMovement(movement) {
    if (movement.direction === 'stop' && !this.isMoving) return
    
    const mac = this.vacuum.mac
    const model = this.vacuum.product_model

    // PLACEHOLDER: These property IDs and values need to be discovered
    // via mitmproxy traffic analysis. The actual implementation depends on
    // what we find in the captured API calls.
    //
    // Possible approaches:
    // 1. setProperty() with discovered movement property IDs
    // 2. runAction() with discovered action keys
    // 3. Direct venus-service API calls (requires Signature2)
    // 4. Local MQTT/UDP commands

    console.log(`[VACUUM] ${movement.direction} speed:${movement.speed} turn:${movement.turnRate}`)

    // Example of what the final implementation might look like:
    // await this.wyze.setProperty(mac, model, 'P1612', movement.speed)
    // await this.wyze.setProperty(mac, model, 'P1613', movement.turnRate)
    // 
    // Or:
    // await this.wyze.runAction(mac, model, `manual_${movement.direction}`)
    //
    // Or for venus-service:
    // await this.sendVenusCommand({ type: 'move', x: movement.raw.x, y: movement.raw.y })

    this.isMoving = movement.direction !== 'stop'
    this.lastCommand = movement
  }

  /**
   * High-level vacuum actions
   */
  async executeAction(action) {
    const mac = this.vacuum.mac
    const model = this.vacuum.product_model

    switch (action.action) {
      case 'start_clean':
        console.log('[VACUUM] Starting clean cycle...')
        await this.wyze.runAction(mac, model, 'power_on')
        break
      case 'pause':
        console.log('[VACUUM] Pausing...')
        // TODO: discover pause action key
        break
      case 'dock':
        console.log('[VACUUM] Returning to dock...')
        // TODO: discover dock action key
        break
      case 'suction_up':
        console.log('[VACUUM] Suction level up')
        // TODO: discover suction property
        break
      case 'suction_down':
        console.log('[VACUUM] Suction level down')
        break
      default:
        console.log(`[VACUUM] Unknown action: ${action.action}`)
    }
  }

  /**
   * Start the control loop
   */
  start() {
    this.controller.on('movement', (data) => this.sendMovement(data))
    this.controller.on('action', (data) => this.executeAction(data))

    // Safety: auto-stop if no commands received for 500ms
    let lastCommandTime = Date.now()
    this.controller.on('movement', () => { lastCommandTime = Date.now() })

    setInterval(() => {
      if (this.isMoving && Date.now() - lastCommandTime > 500) {
        console.log('\n⚠️  Safety stop: no controller input for 500ms')
        this.sendMovement({ direction: 'stop', speed: 0, turnRate: 0 })
      }
    }, 100)

    console.log('🎮 Vacuum controller active. Use controller/keyboard to drive.')
  }
}

async function main() {
  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY

  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js')
    console.error('Get your keys at: https://developer-api-console.wyze.com')
    process.exit(1)
  }

  const wyze = new Wyze({
    keyId, apiKey,
    username: process.env.WYZE_EMAIL,
    password: process.env.WYZE_PASSWORD,
  })

  console.log('🔑 Logging in...')
  await wyze.login()

  console.log('📋 Finding vacuum...')
  const devices = await wyze.getDeviceList()
  
  // Try env var first, then auto-detect
  const vacuumMac = process.env.VACUUM_MAC
  const vacuumName = process.env.VACUUM_NAME

  let vacuum
  if (vacuumMac) {
    vacuum = devices.find(d => d.mac === vacuumMac)
  } else if (vacuumName) {
    vacuum = devices.find(d => d.nickname.toLowerCase() === vacuumName.toLowerCase())
  } else {
    // Auto-detect: look for vacuum-like devices
    const vacuumKeywords = ['vacuum', 'robot', 'vac', 'sweep']
    vacuum = devices.find(d => {
      const searchStr = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
      return vacuumKeywords.some(k => searchStr.includes(k))
    })
  }

  if (!vacuum) {
    console.error('❌ Could not find vacuum. Run scan-vacuum.js first to identify it.')
    console.error('   Then set VACUUM_MAC or VACUUM_NAME env var.')
    process.exit(1)
  }

  console.log(`🤖 Found: "${vacuum.nickname}" (${vacuum.mac})\n`)

  const vc = new VacuumController(wyze, vacuum)
  vc.start()
}

module.exports = { VacuumController }

if (require.main === module) {
  main().catch(console.error)
}
