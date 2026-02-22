#!/usr/bin/env node
/**
 * Vacuum Telemetry Capture
 *
 * Rapidly polls the Venus API while the vacuum is cleaning to capture:
 * - Real-time position (x,y coordinates)
 * - Status changes (mode, heartbeat)
 * - Map data updates (cleaning path)
 * - IoT property changes
 *
 * This data reveals whether synthetic directional control is feasible.
 *
 * Usage:
 *   WYZE_KEY_ID=x WYZE_API_KEY=x node tools/telemetry-capture.js
 *
 * Options:
 *   --room <name>   Start cleaning a specific room (default: start full clean)
 *   --poll <ms>     Poll interval in ms (default: 2000)
 *   --duration <s>  Capture duration in seconds (default: 120)
 *   --no-clean      Don't start cleaning, just capture (vacuum must already be running)
 *   --try-area      Try AREA_CLEAN with test coordinates
 */
'use strict'

const Wyze = require('../index')
const { VenusService, ControlType, ControlValue } = require('../venus')
const fs = require('fs')
const path = require('path')

// Parse args
const args = process.argv.slice(2)
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return defaultVal
  if (typeof defaultVal === 'boolean') return true
  return args[idx + 1] || defaultVal
}

const POLL_MS = parseInt(getArg('poll', '2000'))
const DURATION_S = parseInt(getArg('duration', '120'))
const ROOM_NAME = getArg('room', null)
const NO_CLEAN = args.includes('--no-clean')
const TRY_AREA = args.includes('--try-area')

async function main() {
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  📡 VACUUM TELEMETRY CAPTURE                    ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log(`   Poll: ${POLL_MS}ms | Duration: ${DURATION_S}s`)
  console.log('')

  const keyId = process.env.WYZE_KEY_ID
  const apiKey = process.env.WYZE_API_KEY
  if (!keyId || !apiKey) {
    console.error('Usage: WYZE_KEY_ID=x WYZE_API_KEY=x node tools/telemetry-capture.js')
    process.exit(1)
  }

  // Login
  const wyze = new Wyze({ keyId, apiKey })
  console.log('🔑 Logging in...')
  await wyze.login()

  // Find vacuum
  console.log('📋 Finding vacuum...')
  const devices = await wyze.getDeviceList()
  const keywords = ['vacuum', 'robot', 'vac', 'sweep', 'ja_ro']
  const vacuum = devices.find(d => {
    const s = `${d.product_type} ${d.product_model} ${d.nickname}`.toLowerCase()
    return keywords.some(k => s.includes(k))
  })
  if (!vacuum) { console.error('❌ No vacuum found.'); process.exit(1) }

  const did = vacuum.mac
  const model = vacuum.product_model
  console.log(`🤖 ${vacuum.nickname} (${did})`)

  const venus = new VenusService(wyze.accessToken)

  // ── Phase 1: Baseline capture (before cleaning) ──
  console.log('\n━━━ Phase 1: Baseline (before cleaning) ━━━')

  const baseline = {}

  console.log('📊 Status...')
  try {
    baseline.status = await venus.getStatus(did)
    const hb = baseline.status.data?.heartBeat || {}
    console.log(`   Mode: ${hb.mode} | Battery: ${hb.battery}% | Fault: ${hb.fault_code}`)
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  console.log('📍 Position...')
  try {
    baseline.position = await venus.getCurrentPosition(did)
    console.log(`   Position data: ${JSON.stringify(baseline.position.data)}`)
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  console.log('🗺️  Current map...')
  try {
    baseline.map = await venus.getCurrentMap(did)
    const mapData = baseline.map.data
    if (mapData) {
      console.log(`   Map ID: ${mapData.mapId} | Name: ${mapData.user_map_name || mapData.mapName}`)
      console.log(`   Map data length: ${(mapData.map || '').length} chars`)
      console.log(`   Update time: ${new Date(mapData.updateTime).toISOString()}`)
    }
  } catch (e) {
    console.log(`   ❌ ${e.response?.data?.message || e.message}`)
  }

  // Probe additional endpoints
  console.log('🔍 Probing undocumented endpoints...')

  const probeEndpoints = [
    { name: 'clean_path', fn: () => venus._get(`/plugin/venus/memory_map/clean_path`, { did }) },
    { name: 'realtime_map', fn: () => venus._get(`/plugin/venus/memory_map/realtime_map`, { did }) },
    { name: 'device_position', fn: () => venus._get(`/plugin/venus/${did}/position`) },
    { name: 'current_path', fn: () => venus._get(`/plugin/venus/${did}/current_path`) },
    { name: 'sweep_record', fn: () => venus._get('/plugin/venus/sweep_record/query_data', { did, limit: 1 }) },
    { name: 'iot_props_all', fn: () => venus.getIotProp(did, 'current_map_id,iot_state,robot_x,robot_y,robot_direction,clean_path,robot_position') },
  ]

  for (const probe of probeEndpoints) {
    try {
      const result = await probe.fn()
      baseline[probe.name] = result
      const hasData = result.data !== null && result.data !== undefined
      console.log(`   ✅ ${probe.name}: ${hasData ? JSON.stringify(result.data).substring(0, 200) : 'null'}`)
    } catch (e) {
      const code = e.response?.status || e.code || '?'
      const msg = e.response?.data?.message || e.message
      console.log(`   ❌ ${probe.name} (${code}): ${msg.substring(0, 100)}`)
    }
  }

  // ── Phase 2: Start cleaning (optional) ──
  if (!NO_CLEAN) {
    console.log('\n━━━ Phase 2: Starting vacuum ━━━')

    if (TRY_AREA) {
      // Try AREA_CLEAN with test coordinates
      console.log('🧪 Trying AREA_CLEAN (type 6) with test coordinates...')
      const testCoords = [
        // Try different coordinate formats the API might accept
        { type: 6, value: 1, vacuumMopMode: 0, area_point_list: [{ x: 100, y: 100 }] },
        { type: 6, value: 1, vacuumMopMode: 0, latest_area_point_list: [{ x: 100, y: 100 }] },
        { type: 6, value: 1, vacuumMopMode: 0, point: { x: 100, y: 100 } },
        { type: 6, value: 1, vacuumMopMode: 0, points: [[100, 100]] },
      ]

      for (const body of testCoords) {
        try {
          const result = await venus._post(`/plugin/venus/${did}/control`, body)
          console.log(`   ✅ Format worked: ${JSON.stringify(body)}`)
          console.log(`   Response: ${JSON.stringify(result)}`)
          // If it worked, pause immediately so we don't actually clean
          await new Promise(r => setTimeout(r, 2000))
          await venus.pause(did)
          break
        } catch (e) {
          console.log(`   ❌ ${JSON.stringify(body).substring(0, 80)} → ${e.response?.data?.message || e.message}`)
        }
      }
    } else if (ROOM_NAME) {
      // Get rooms and find the target
      const maps = await venus.getMaps(did)
      const allRooms = []
      if (maps.data) {
        const mapList = Array.isArray(maps.data) ? maps.data : [maps.data]
        for (const m of mapList) {
          if (m.current_map && m.room_info_list) {
            allRooms.push(...m.room_info_list)
          }
        }
      }
      const room = allRooms.find(r => r.room_name.toLowerCase() === ROOM_NAME.toLowerCase())
      if (room) {
        console.log(`🚪 Starting room clean: "${room.room_name}" (ID: ${room.room_id})`)
        const result = await venus.sweepRooms(did, [room.room_id])
        console.log(`   Result: ${JSON.stringify(result).substring(0, 200)}`)
      } else {
        console.log(`❌ Room "${ROOM_NAME}" not found. Available: ${allRooms.map(r => r.room_name).join(', ')}`)
        console.log('   Starting full clean instead...')
        await venus.clean(did)
      }
    } else {
      console.log('🧹 Starting full clean...')
      const result = await venus.clean(did)
      console.log(`   Result: ${JSON.stringify(result).substring(0, 200)}`)
    }

    // Wait for vacuum to start moving
    console.log('⏳ Waiting 5s for vacuum to begin...')
    await new Promise(r => setTimeout(r, 5000))
  }

  // ── Phase 3: Rapid telemetry capture ──
  console.log(`\n━━━ Phase 3: Capturing telemetry (${DURATION_S}s at ${POLL_MS}ms) ━━━`)
  console.log('   Ctrl+C to stop early\n')

  const telemetry = []
  const startTime = Date.now()
  let pollCount = 0
  let lastPositionData = null

  const stopCapture = () => {
    // Save results
    const outFile = path.join(__dirname, '..', `telemetry-${Date.now()}.json`)
    const output = {
      vacuum: { mac: did, model, name: vacuum.nickname },
      settings: { pollMs: POLL_MS, durationS: DURATION_S },
      baseline,
      telemetry,
      summary: {
        totalPolls: pollCount,
        durationMs: Date.now() - startTime,
        uniquePositions: new Set(telemetry.filter(t => t.position?.data).map(t => JSON.stringify(t.position.data))).size,
        modeChanges: telemetry.filter((t, i) =>
          i > 0 && t.status?.data?.heartBeat?.mode !== telemetry[i - 1].status?.data?.heartBeat?.mode
        ).length,
      },
    }

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2))
    console.log(`\n\n📁 Saved to: ${outFile}`)
    console.log(`📊 Summary:`)
    console.log(`   Total polls: ${output.summary.totalPolls}`)
    console.log(`   Duration: ${(output.summary.durationMs / 1000).toFixed(1)}s`)
    console.log(`   Unique positions: ${output.summary.uniquePositions}`)
    console.log(`   Mode changes: ${output.summary.modeChanges}`)

    // Analysis
    const positions = telemetry.filter(t => t.position?.data !== null && t.position?.data !== undefined)
    if (positions.length > 0) {
      console.log(`\n🎯 POSITION DATA FOUND! (${positions.length} samples)`)
      console.log('   First position:', JSON.stringify(positions[0].position.data))
      console.log('   Last position:', JSON.stringify(positions[positions.length - 1].position.data))
      console.log('\n   ✅ Synthetic directional control IS feasible!')
    } else {
      console.log('\n   ⚠️  No position data received during capture.')
      console.log('   Position tracking may not be available via cloud API.')
    }

    // Check if any probe endpoints returned useful data
    const usefulEndpoints = Object.entries(baseline)
      .filter(([k, v]) => v?.data && k !== 'status' && k !== 'map' && k !== 'position')
    if (usefulEndpoints.length > 0) {
      console.log(`\n   📡 Useful endpoints found: ${usefulEndpoints.map(([k]) => k).join(', ')}`)
    }
  }

  process.on('SIGINT', () => {
    console.log('\n\n⏹️  Capture interrupted')
    stopCapture()
    process.exit(0)
  })

  // Poll loop
  while (Date.now() - startTime < DURATION_S * 1000) {
    pollCount++
    const sample = { ts: Date.now(), elapsed: Date.now() - startTime }

    // Parallel fetch: status + position + map updates
    const [statusRes, positionRes] = await Promise.allSettled([
      venus.getStatus(did),
      venus.getCurrentPosition(did),
    ])

    if (statusRes.status === 'fulfilled') {
      sample.status = statusRes.value
      const hb = statusRes.value.data?.heartBeat || {}
      const mode = hb.mode
      const pos = positionRes.status === 'fulfilled' ? positionRes.value.data : null

      // Compact log line
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      const posStr = pos ? `pos:(${JSON.stringify(pos).substring(0, 60)})` : 'pos:null'
      const changed = pos && JSON.stringify(pos) !== JSON.stringify(lastPositionData) ? ' 🔄' : ''
      process.stdout.write(`\r[${elapsed}s] #${pollCount} mode:${mode} batt:${hb.battery}% ${posStr}${changed}        `)

      if (pos) lastPositionData = pos
    } else {
      sample.statusError = statusRes.reason?.message
    }

    if (positionRes.status === 'fulfilled') {
      sample.position = positionRes.value
    } else {
      sample.positionError = positionRes.reason?.message
    }

    // Every 10th poll, also grab map data and IoT props to look for path data
    if (pollCount % 10 === 0) {
      try {
        const mapRes = await venus.getCurrentMap(did)
        sample.mapUpdateTime = mapRes.data?.updateTime
        // Check if map data changed (indicates active path drawing)
        const mapLen = (mapRes.data?.map || '').length
        process.stdout.write(` map:${mapLen}ch`)
      } catch (e) { /* ignore */ }

      try {
        const iotRes = await venus.getIotProp(did, 'current_map_id,iot_state')
        sample.iotProps = iotRes.data?.props
      } catch (e) { /* ignore */ }
    }

    telemetry.push(sample)

    await new Promise(r => setTimeout(r, POLL_MS))
  }

  console.log('\n\n⏱️  Capture complete!')
  stopCapture()

  // Pause the vacuum if we started it
  if (!NO_CLEAN) {
    console.log('\n⏸️  Pausing vacuum...')
    try {
      await venus.pause(did)
      console.log('   ✅ Paused')
    } catch (e) {
      console.log(`   ⚠️  ${e.response?.data?.message || e.message}`)
    }
  }
}

main().catch(e => {
  console.error(`\n💥 Fatal: ${e.message}`)
  process.exit(1)
})
