#!/usr/bin/env node
/**
 * Wyze Vacuum Controller - Main Entry Point
 * Connects Xbox controller input to Wyze vacuum movement commands.
 * 
 * Usage:
 *   WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue } = require('../venus')
const { XboxController } = require('./xbox-controller')

class VacuumController {
  constructor(wyze, venus, vacuumDevice) {
    this.wyze = wyze
    this.venus = venus
    this.vacuum = vacuumDevice
    this.controller = new XboxController()
    this.isMoving = false
    this.lastCommand = null
    this.suctionLevel = 2 // 1=quiet, 2=standard, 3=strong
  }

  get did() { return this.vacuum.mac }
  get model() { return this.vacuum.product_model }

  /**
   * Send a movement command to the vacuum via Venus set_iot_action.
   * Uses set_mode with direction/speed parameters.
   */
  async sendMovement(movement) {
    if (movement.direction === 'stop' && !this.isMoving) return

    try {
      // Use set_iot_action with manual control parameters
      // The vacuum interprets these as motor commands
      await this.venus.setIotAction(this.did, this.model, 'set_mode', {
        type: 'manual',
        direction: movement.direction,
        speed: movement.speed,
        turn_rate: movement.turnRate,
      })
    } catch (e) {
      // Don't spam errors during rapid input
      if (!this._lastError || Date.now() - this._lastError > 2000) {
        console.error(`\n⚠️  Movement error: ${e.response?.data?.message || e.message}`)
        this._lastError = Date.now()
      }
    }

    this.isMoving = movement.direction !== 'stop'
    this.lastCommand = movement
  }

  /**
   * High-level vacuum actions via Venus service
   */
  async executeAction(action) {
    try {
      switch (action.action) {
        case 'start_clean':
          console.log('\n🧹 Starting clean cycle...')
          await this.venus.clean(this.did)
          break
        case 'pause':
          console.log('\n⏸️  Pausing...')
          await this.venus.pause(this.did)
          break
        case 'dock':
          console.log('\n🏠 Returning to dock...')
          await this.venus.dock(this.did)
          break
        case 'suction_up':
          this.suctionLevel = Math.min(3, this.suctionLevel + 1)
          console.log(`\n🔊 Suction: ${['', 'quiet', 'standard', 'strong'][this.suctionLevel]}`)
          await this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel)
          break
        case 'suction_down':
          this.suctionLevel = Math.max(1, this.suctionLevel - 1)
          console.log(`\n🔈 Suction: ${['', 'quiet', 'standard', 'strong'][this.suctionLevel]}`)
          await this.venus.setSuctionLevel(this.did, this.model, this.suctionLevel)
          break
        case 'status':
          console.log('\n📊 Fetching status...')
          const status = await this.venus.getStatus(this.did)
          console.log(JSON.stringify(status, null, 2))
          break
        default:
          console.log(`\n❓ Unknown action: ${action.action}`)
      }
    } catch (e) {
      console.error(`\n❌ Action error: ${e.response?.data?.message || e.message}`)
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

    console.log('🎮 Vacuum controller active!')
    console.log('')
    console.log('   Controls:')
    console.log('   W/A/S/D = Move    Q/E = Turn    Space = Stop')
    console.log('   1 = Clean   2 = Pause   3 = Dock')
    console.log('   4 = Suction ↓   5 = Suction ↑   6 = Status')
    console.log('')
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
  
  const vacuumMac = process.env.VACUUM_MAC
  const vacuumName = process.env.VACUUM_NAME

  let vacuum
  if (vacuumMac) {
    vacuum = devices.find(d => d.mac === vacuumMac)
  } else if (vacuumName) {
    vacuum = devices.find(d => d.nickname.toLowerCase() === vacuumName.toLowerCase())
  } else {
    const vacuumKeywords = ['vacuum', 'robot', 'vac', 'sweep', 'ja_ro']
    vacuum = devices.find(d => {
      const s = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
      return vacuumKeywords.some(k => s.includes(k))
    })
  }

  if (!vacuum) {
    console.error('❌ Could not find vacuum. Run scan-vacuum.js first.')
    process.exit(1)
  }

  console.log(`🤖 Found: "${vacuum.nickname}" (${vacuum.mac})`)

  // Create Venus service with the access token
  const venus = new VenusService(wyze.accessToken)

  console.log('📊 Checking vacuum status...')
  try {
    const status = await venus.getStatus(vacuum.mac)
    console.log(`   Mode: ${JSON.stringify(status.data?.mode || status)}`)
  } catch (e) {
    console.log(`   ⚠️  Could not get Venus status: ${e.response?.data?.message || e.message}`)
  }

  console.log('')
  const vc = new VacuumController(wyze, venus, vacuum)
  vc.start()
}

module.exports = { VacuumController }

if (require.main === module) {
  main().catch(console.error)
}
