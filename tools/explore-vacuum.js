#!/usr/bin/env node
/**
 * Deep Vacuum Explorer
 * Uses the Venus service API to discover ALL vacuum capabilities,
 * IoT properties, maps, rooms, and status.
 * 
 * Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/explore-vacuum.js
 */
'use strict'
const Wyze = require('../index')
const { VenusService, VacuumMode } = require('../venus')

function getModeLabel(statusCode) {
  for (const [name, codes] of Object.entries(VacuumMode)) {
    if (Array.isArray(codes) && codes.includes(statusCode)) return name
    if (codes === statusCode) return name
  }
  return `UNKNOWN(${statusCode})`
}

async function main() {
  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY
  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/explore-vacuum.js')
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
  const vacuumKeywords = ['vacuum', 'robot', 'vac', 'sweep', 'ja_ro']
  let vacuum = devices.find(d => {
    const s = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
    return vacuumKeywords.some(k => s.includes(k))
  })
  if (!vacuum) {
    // If VACUUM_MAC is set, use that
    const mac = process.env.VACUUM_MAC
    if (mac) vacuum = devices.find(d => d.mac === mac)
  }
  if (!vacuum) {
    console.error('❌ No vacuum found. Set VACUUM_MAC env var.')
    devices.forEach(d => console.log(`  ${d.nickname} (${d.mac}) model:${d.product_model}`))
    process.exit(1)
  }

  const did = vacuum.mac
  const model = vacuum.product_model
  console.log(`\n🤖 Vacuum: "${vacuum.nickname}" (${did}) model:${model}`)
  console.log(`   Status code: ${vacuum.device_params.vacuum_work_status} → ${getModeLabel(vacuum.device_params.vacuum_work_status)}`)
  console.log(`   Battery: ${vacuum.device_params.electricity}%`)
  console.log(`   Connected: ${vacuum.device_params.connection_state === 1 ? 'Yes' : 'No'}`)

  // Now use Venus service for deep exploration
  const venus = new VenusService(wyze.accessToken)

  console.log('\n' + '='.repeat(60))
  console.log('🔍 VENUS SERVICE - Deep Device Exploration')
  console.log('='.repeat(60))

  // 1. Get full status
  console.log('\n📊 Status (venus):')
  try {
    const status = await venus.getStatus(did)
    console.log(JSON.stringify(status, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // 2. Get IoT properties - these are the deep vacuum properties
  console.log('\n🔑 IoT Properties:')
  const iotKeys = [
    'iot_state', 'sweep_mode', 'suction', 'water_level',
    'clean_time', 'clean_size', 'fault', 'work_mode',
    'charge_state', 'battery', 'voice_switch', 'voice_language',
    'do_not_disturb', 'led_switch', 'side_brush_life',
    'main_brush_life', 'filter_life', 'carpet_boost',
    'map_update', 'current_map_id', 'rooms',
  ]
  try {
    const iotProps = await venus.getIotProp(did, iotKeys)
    console.log(JSON.stringify(iotProps, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // 3. Get device info from venus
  console.log('\n📋 Device Info (venus):')
  try {
    const info = await venus.getDeviceInfo(did, [
      'device_name', 'firmware_version', 'model', 'mac',
      'ip', 'ssid', 'timezone', 'language',
    ])
    console.log(JSON.stringify(info, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // 4. Get maps
  console.log('\n🗺️  Maps:')
  try {
    const maps = await venus.getMaps(did)
    console.log(JSON.stringify(maps, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // 5. Get current position
  console.log('\n📍 Current Position:')
  try {
    const pos = await venus.getCurrentPosition(did)
    console.log(JSON.stringify(pos, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // 6. Get current map
  console.log('\n🗺️  Current Map:')
  try {
    const map = await venus.getCurrentMap(did)
    console.log(JSON.stringify(map, null, 2))
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  console.log('\n' + '='.repeat(60))
  console.log('✅ Exploration complete!')
  console.log('')
  console.log('Next: Try controlling the vacuum:')
  console.log('  WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js')
}

main().catch(e => {
  console.error('Fatal:', e.response?.data || e.message)
  process.exit(1)
})
