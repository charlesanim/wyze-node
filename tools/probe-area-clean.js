#!/usr/bin/env node
/**
 * Probe different area_clean coordinate formats to find what works.
 * Tries various payload structures against the Venus API.
 *
 * Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/probe-area-clean.js
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue } = require('../venus')

async function main() {
  const wyze = new Wyze({ keyId: process.env.WYZE_KEY_ID, apiKey: process.env.WYZE_API_KEY })
  console.log('🔑 Logging in...')
  await wyze.login()

  const devices = await wyze.getDeviceList()
  const vacuum = devices.find(d => `${d.product_type} ${d.product_model}`.toLowerCase().includes('ja_ro'))
  if (!vacuum) { console.error('❌ No vacuum'); process.exit(1) }

  const did = vacuum.mac
  const model = vacuum.product_model
  const venus = new VenusService(wyze.accessToken)

  console.log(`🤖 ${vacuum.nickname} (${did})`)

  // Get current position and map info for reference
  console.log('\n📍 Getting current position...')
  let currentPos = null
  try {
    const posRes = await venus.getCurrentPosition(did)
    if (posRes.data && Array.isArray(posRes.data) && posRes.data.length > 0) {
      currentPos = posRes.data[0]
      console.log(`   Position: x=${currentPos.x}, y=${currentPos.y}, pose_id=${currentPos.pose_id}`)
    } else {
      console.log('   No position data (vacuum may be docked)')
    }
  } catch (e) { console.log(`   Error: ${e.message}`) }

  console.log('\n🗺️  Getting current map info...')
  let mapId = null
  try {
    const mapRes = await venus.getCurrentMap(did)
    if (mapRes.data) {
      mapId = mapRes.data.mapId
      console.log(`   Map ID: ${mapId}, Name: ${mapRes.data.user_map_name}`)
      console.log(`   Map data length: ${(mapRes.data.map || '').length} chars`)
    }
  } catch (e) { console.log(`   Error: ${e.message}`) }

  // First, make sure vacuum is in a state that can accept commands
  console.log('\n📊 Status...')
  const statusRes = await venus.getStatus(did)
  const hb = statusRes.data?.heartBeat || {}
  console.log(`   Mode: ${hb.mode}, Battery: ${hb.battery}%, Fault: ${hb.fault_code}`)

  // If we have a position, compute a nearby target
  const targetMeters = currentPos
    ? { x: currentPos.x + 0.5, y: currentPos.y }  // 0.5m to the right
    : { x: 2.0, y: 0.0 }  // default

  // Scale to possible pixel formats (common: 20px/meter, 50px/meter, 100px/meter)
  const targetPx20 = { x: Math.round(targetMeters.x * 20), y: Math.round(targetMeters.y * 20) }
  const targetPx50 = { x: Math.round(targetMeters.x * 50), y: Math.round(targetMeters.y * 50) }
  const targetPx100 = { x: Math.round(targetMeters.x * 100), y: Math.round(targetMeters.y * 100) }

  console.log(`\n🎯 Target (meters): (${targetMeters.x.toFixed(2)}, ${targetMeters.y.toFixed(2)})`)
  console.log(`   Target (px*20):  (${targetPx20.x}, ${targetPx20.y})`)
  console.log(`   Target (px*50):  (${targetPx50.x}, ${targetPx50.y})`)
  console.log(`   Target (px*100): (${targetPx100.x}, ${targetPx100.y})`)

  // ── Test different payload formats ──
  console.log('\n' + '='.repeat(60))
  console.log('🧪 TESTING AREA CLEAN FORMATS')
  console.log('='.repeat(60))

  const tests = [
    // Format 1: Our current format (float meters)
    {
      name: 'Float meters, area_point_list',
      body: { type: 6, value: 1, vacuumMopMode: 0, area_point_list: [targetMeters] }
    },
    // Format 2: Integer pixels (20x scale)
    {
      name: 'Int px*20, area_point_list',
      body: { type: 6, value: 1, vacuumMopMode: 0, area_point_list: [targetPx20] }
    },
    // Format 3: Integer pixels (50x scale)
    {
      name: 'Int px*50, area_point_list',
      body: { type: 6, value: 1, vacuumMopMode: 0, area_point_list: [targetPx50] }
    },
    // Format 4: With map_id
    {
      name: 'Float meters + map_id',
      body: { type: 6, value: 1, vacuumMopMode: 0, map_id: mapId, area_point_list: [targetMeters] }
    },
    // Format 5: latest_area_point_list key
    {
      name: 'Float meters, latest_area_point_list',
      body: { type: 6, value: 1, vacuumMopMode: 0, latest_area_point_list: [targetMeters] }
    },
    // Format 6: points as arrays
    {
      name: 'Array format [x,y]',
      body: { type: 6, value: 1, vacuumMopMode: 0, area_point_list: [[targetMeters.x, targetMeters.y]] }
    },
    // Format 7: Rectangular zone (two corners)
    {
      name: 'Zone [x1,y1,x2,y2]',
      body: {
        type: 6, value: 1, vacuumMopMode: 0,
        area_point_list: [
          { x: targetMeters.x - 0.3, y: targetMeters.y - 0.3 },
          { x: targetMeters.x + 0.3, y: targetMeters.y + 0.3 }
        ]
      }
    },
    // Format 8: With current_map_id
    {
      name: 'Float meters + current_map_id',
      body: { type: 6, value: 1, vacuumMopMode: 0, current_map_id: mapId, area_point_list: [targetMeters] }
    },
    // Format 9: As "point" not "area_point_list"
    {
      name: 'point key (single object)',
      body: { type: 6, value: 1, vacuumMopMode: 0, point: targetMeters }
    },
    // Format 10: "clean_point"
    {
      name: 'clean_point key',
      body: { type: 6, value: 1, vacuumMopMode: 0, clean_point: targetMeters }
    },
    // Format 11: Float meters * 1000 (millimeters)
    {
      name: 'Millimeters (x1000)',
      body: {
        type: 6, value: 1, vacuumMopMode: 0,
        area_point_list: [{ x: Math.round(targetMeters.x * 1000), y: Math.round(targetMeters.y * 1000) }]
      }
    },
    // Format 12: Try via set_iot_action instead of control endpoint
    {
      name: 'set_iot_action: set_area_clean',
      iot: true,
      cmd: 'set_area_clean',
      params: { area_point_list: [targetMeters] }
    },
    // Format 13: set_iot_action with goto_point
    {
      name: 'set_iot_action: goto_point',
      iot: true,
      cmd: 'goto_point',
      params: { x: targetMeters.x, y: targetMeters.y }
    },
    // Format 14: set_iot_action with navigate
    {
      name: 'set_iot_action: navigate',
      iot: true,
      cmd: 'navigate',
      params: { x: targetMeters.x, y: targetMeters.y }
    },
  ]

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]
    console.log(`\n[${i + 1}/${tests.length}] ${test.name}`)

    try {
      let result
      if (test.iot) {
        result = await venus.setIotAction(did, model, test.cmd, test.params)
      } else {
        result = await venus._post(`/plugin/venus/${did}/control`, test.body)
      }

      const code = result.code
      const msg = result.message || ''
      const data = result.data ? JSON.stringify(result.data).substring(0, 200) : 'null'
      console.log(`   ✅ code:${code} msg:"${msg}" data:${data}`)

      // If it worked, wait a moment and check if mode changed
      if (code === 1) {
        await new Promise(r => setTimeout(r, 3000))
        const st = await venus.getStatus(did)
        const newMode = st.data?.heartBeat?.mode
        console.log(`   → Mode after 3s: ${newMode}`)

        // If vacuum started moving, pause it and we found our format!
        if (newMode === 1 || newMode === 7 || newMode === 30 || newMode === 36) {
          console.log(`   🎯 VACUUM MOVED! This format works!`)
          await venus.pause(did)
          console.log(`   ⏸️  Paused`)
        }
      }
    } catch (e) {
      const status = e.response?.status || '?'
      const msg = e.response?.data?.message || e.message
      console.log(`   ❌ (${status}) ${msg.substring(0, 150)}`)
    }

    // Small delay between tests
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log('\n' + '='.repeat(60))
  console.log('Done! Check above for which format triggered vacuum movement.')
}

main().catch(e => { console.error(`💥 ${e.message}`); process.exit(1) })
