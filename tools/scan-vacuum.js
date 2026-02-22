#!/usr/bin/env node
/**
 * Vacuum Property Scanner
 * Discovers all properties/capabilities of your Wyze robot vacuum
 * 
 * Usage: WYZE_EMAIL=you@email.com WYZE_PASSWORD=yourpass node tools/scan-vacuum.js
 */
'use strict'
const Wyze = require('../index')

async function main() {
  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY

  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/scan-vacuum.js')
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
  console.log('✅ Logged in\n')

  // Get all devices
  console.log('📋 Fetching device list...')
  const devices = await wyze.getDeviceList()

  // Find vacuum(s) - vacuum product types/models
  const vacuumKeywords = ['vacuum', 'robot', 'vac', 'sweep', 'jaro', 'ja_ro']
  const vacuums = devices.filter(d => {
    const type = (d.product_type || '').toLowerCase()
    const model = (d.product_model || '').toLowerCase()
    const name = (d.nickname || '').toLowerCase()
    return vacuumKeywords.some(k => type.includes(k) || model.includes(k) || name.includes(k))
  })

  if (vacuums.length === 0) {
    console.log('⚠️  No vacuum found by keyword match. Listing ALL devices:\n')
    devices.forEach((d, i) => {
      console.log(`  [${i}] ${d.nickname}`)
      console.log(`      MAC: ${d.mac}`)
      console.log(`      Model: ${d.product_model}`)
      console.log(`      Type: ${d.product_type}`)
      console.log(`      Params: ${JSON.stringify(d.device_params, null, 2)}`)
      console.log()
    })
    console.log('👆 Which one is your vacuum? Set VACUUM_MAC env var to its MAC address and re-run.')
    console.log('   Or set VACUUM_NAME to its nickname.')
    return
  }

  for (const vacuum of vacuums) {
    console.log(`🤖 Found vacuum: "${vacuum.nickname}"`)
    console.log(`   MAC: ${vacuum.mac}`)
    console.log(`   Model: ${vacuum.product_model}`)
    console.log(`   Type: ${vacuum.product_type}`)
    console.log()

    // Dump device params
    console.log('📊 Device Params:')
    console.log(JSON.stringify(vacuum.device_params, null, 2))
    console.log()

    // Get detailed device info
    console.log('🔍 Getting device info...')
    try {
      const info = await wyze.getDeviceInfo(vacuum.mac, vacuum.product_model)
      console.log('Device Info:')
      console.log(JSON.stringify(info, null, 2))
      console.log()
    } catch (e) {
      console.log(`   ❌ getDeviceInfo failed: ${e.message}`)
    }

    // Get property list - THIS IS THE KEY DATA
    console.log('🔑 Getting property list (this reveals controllable features)...')
    try {
      const props = await wyze.getPropertyList(vacuum.mac, vacuum.product_model)
      console.log(`Found ${props.length} properties:\n`)
      props.forEach(p => {
        console.log(`  📌 ${p.pid}`)
        console.log(`     Value: ${p.value}`)
        if (p.ts) console.log(`     Updated: ${new Date(p.ts).toISOString()}`)
        console.log()
      })

      // Look for movement-related properties
      const movementKeywords = ['move', 'motor', 'wheel', 'direction', 'speed', 'drive', 'forward', 'backward', 'turn', 'rotate', 'manual', 'control', 'navigate']
      const movementProps = props.filter(p => {
        const pid = (p.pid || '').toLowerCase()
        return movementKeywords.some(k => pid.includes(k))
      })

      if (movementProps.length > 0) {
        console.log('🎯 MOVEMENT-RELATED PROPERTIES FOUND:')
        movementProps.forEach(p => console.log(`   ${p.pid} = ${p.value}`))
      } else {
        console.log('⚠️  No obvious movement properties found in property list.')
        console.log('   This means directional control likely goes through a different API endpoint.')
      }
    } catch (e) {
      console.log(`   ❌ getPropertyList failed: ${e.message}`)
    }

    console.log('\n' + '='.repeat(60))
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message)
  process.exit(1)
})
