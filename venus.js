'use strict'
/**
 * Venus Service Client for Wyze Robot Vacuum
 * 
 * Ported from Python wyze-sdk (shauntarves/wyze-sdk)
 * Handles Signature2 authentication and vacuum control commands.
 */
const axios = require('axios')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')

const VENUS_BASE_URL = 'https://wyze-venus-service-vn.wyzecam.com'
const VENUS_APP_ID = 'venp_4c30f812828de875'
const VENUS_SIGNING_SECRET = 'CVCSNoa0ALsNEpgKls6ybVTVOmGzFoiq'
const VENUS_APP_VERSION = '2.19.14'

// Control request types
const ControlType = {
  GLOBAL_SWEEPING: 0,
  RETURN_TO_CHARGING: 3,
  AREA_CLEAN: 6,
  QUICK_MAPPING: 7,
}

// Control request values
const ControlValue = {
  STOP: 0,
  START: 1,
  PAUSE: 2,
  FALSE_PAUSE: 3,
}

// Vacuum work status modes
const VacuumMode = {
  IDLE: [0, 14, 29, 35, 40],
  CLEANING: [1, 30, 1101, 1201, 1301, 1401],
  PAUSED: [4, 31, 1102, 1202, 1302, 1402],
  RETURNING_TO_CHARGE: [5],
  FINISHED_RETURNING: [10, 32, 1103, 1203, 1303, 1403],
  DOCKED_NOT_COMPLETE: [11, 33, 1104, 1204, 1304, 1404],
  SWEEPING: [7, 25, 36],
}

class VenusService {
  constructor(accessToken) {
    this.accessToken = accessToken
    this.phoneId = uuidv4()
    this.baseUrl = VENUS_BASE_URL
  }

  _md5(data) {
    return crypto.createHash('md5').update(data).digest('hex')
  }

  _nonce() {
    return Date.now()
  }

  _requestId(nonce) {
    return this._md5(this._md5(String(nonce)))
  }

  _generateSignature2(nonce, body) {
    const secret = this._md5(`${this.accessToken}${VENUS_SIGNING_SECRET}`)
    return crypto.createHmac('md5', secret).update(body).digest('hex')
  }

  _getHeaders(nonce, signature2) {
    return {
      'Accept-Encoding': 'gzip',
      'User-Agent': `wyze_android_${VENUS_APP_VERSION}`,
      'appid': VENUS_APP_ID,
      'appinfo': `wyze_android_${VENUS_APP_VERSION}`,
      'phoneid': this.phoneId,
      'access_token': this.accessToken,
      'requestid': this._requestId(nonce),
      'signature2': signature2,
    }
  }

  async _post(endpoint, json = {}) {
    const nonce = this._nonce()
    json.nonce = String(nonce)
    const body = JSON.stringify(json)
    const signature2 = this._generateSignature2(nonce, body)
    const headers = this._getHeaders(nonce, signature2)
    headers['Content-Type'] = 'application/json;charset=utf-8'

    const result = await axios.post(`${this.baseUrl}${endpoint}`, body, { headers })
    return result.data
  }

  async _get(endpoint, params = {}) {
    const nonce = this._nonce()
    params.nonce = nonce
    const sortedParams = Object.keys(params).sort()
      .map(k => `${k}=${params[k]}`).join('&')
    const signature2 = this._generateSignature2(nonce, sortedParams)
    const headers = this._getHeaders(nonce, signature2)

    const result = await axios.get(`${this.baseUrl}${endpoint}`, { headers, params })
    return result.data
  }

  // ── Vacuum Control ──

  async control(did, type, value, rooms = null) {
    const json = { type, value, vacuumMopMode: 0 }
    if (rooms) {
      json.rooms_id = Array.isArray(rooms) ? rooms : [rooms]
    }
    return this._post(`/plugin/venus/${did}/control`, json)
  }

  async clean(did) {
    return this.control(did, ControlType.GLOBAL_SWEEPING, ControlValue.START)
  }

  async pause(did) {
    return this.control(did, ControlType.GLOBAL_SWEEPING, ControlValue.PAUSE)
  }

  async dock(did) {
    return this.control(did, ControlType.RETURN_TO_CHARGING, ControlValue.START)
  }

  async stopDocking(did) {
    return this.control(did, ControlType.RETURN_TO_CHARGING, ControlValue.STOP)
  }

  async sweepRooms(did, roomIds) {
    return this.control(did, ControlType.GLOBAL_SWEEPING, ControlValue.START, roomIds)
  }

  // ── Vacuum Status & Info ──

  async getStatus(did) {
    return this._get(`/plugin/venus/${did}/status`)
  }

  async getIotProp(did, keys) {
    const keysStr = Array.isArray(keys) ? keys.join(',') : keys
    return this._get('/plugin/venus/get_iot_prop', { did, keys: keysStr })
  }

  async getDeviceInfo(did, keys) {
    const keysStr = Array.isArray(keys) ? keys.join(',') : keys
    return this._get('/plugin/venus/device_info', { device_id: did, keys: keysStr })
  }

  async getCurrentPosition(did) {
    return this._get('/plugin/venus/memory_map/current_position', { did })
  }

  async getCurrentMap(did) {
    return this._get('/plugin/venus/memory_map/current_map', { did })
  }

  async getMaps(did) {
    return this._get('/plugin/venus/memory_map/list', { did })
  }

  async getSweepRecords(did, limit = 10) {
    return this._get('/plugin/venus/sweep_record/query_data', { did, limit })
  }

  async setCurrentMap(did, mapId) {
    return this._post('/plugin/venus/memory_map/set_current_map', { did, map_id: mapId })
  }

  /**
   * Area clean with x,y map coordinates.
   * Note: May require firmware >= 1.6.173 for full coordinate support.
   * @param {string} did - Device MAC
   * @param {Array<{x: number, y: number}>} points - Map coordinates
   */
  async areaClean(did, points) {
    return this._post(`/plugin/venus/${did}/control`, {
      type: ControlType.AREA_CLEAN,
      value: ControlValue.START,
      vacuumMopMode: 0,
      area_point_list: points,
    })
  }

  // ── IoT Actions ──

  async setIotAction(did, model, cmd, params) {
    const paramsList = Array.isArray(params) ? params : [params]
    return this._post('/plugin/venus/set_iot_action', {
      cmd, did, model, is_sub_device: 0, params: paramsList,
    })
  }

  async setSuctionLevel(did, model, level) {
    // level: 1=quiet, 2=standard, 3=strong
    return this.setIotAction(did, model, 'set_preference', { ctrltype: 1, value: level })
  }

  async setMode(did, model, type, value) {
    return this.setIotAction(did, model, 'set_mode', { type, value })
  }
}

module.exports = { VenusService, ControlType, ControlValue, VacuumMode }
