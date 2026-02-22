# wyze-node
This is an unofficial Wyze API. This library uses the internal APIs from the Wyze mobile app. A list of all Wyze devices can be retrieved to check the status of Wyze Cameras, Wyze Sense, Wyze Bulbs, Wyze Plugs and possibly Wyze locks (untested). This API can turn on and off cameras, lightbulbs and smart plugs.

## Setup
`npm install wyze-node --save`

## Example
```
const Wyze = require('wyze-node')

const options = {
  username: process.env.username,
  password: process.env.password,
  keyId: process.env.WYZE_KEY_ID,     // from https://developer-api-console.wyze.com
  apiKey: process.env.WYZE_API_KEY,   // from https://developer-api-console.wyze.com
}
const wyze = new Wyze(options)

  ; (async () => {
    let device, state, result

    // Get all Wyze devices
    const devices = await wyze.getDeviceList()
    console.log(devices)

    // Get a Wyze Bulb by name and turn it off.
    device = await wyze.getDeviceByName('Porch Light')
    result = await wyze.turnOff(device)
    console.log(result)

    // Get the state of a Wyze Sense contact sensor
    device = await wyze.getDeviceByName('Front Door')
    state = await wyze.getDeviceState(device)
    console.log(`${device.nickname} is ${state}`)

  })()
```

## Run
`username=first.last@email.om password=123456 node index.js`

## Helper methods

Use this helper methods to interact with wyze-node.

- wyze.getDeviceList()
- wyze.getDeviceByName(nickname)
- wyze.getDeviceByMac(mac)
- wyze.getDevicesByType(type)
- wyze.getDevicesByModel(model)
- wyze.getDeviceGroupsList()
- wyze.getDeviceSortList()
- wyze.turnOn(device)
- wyze.turnOff(device)
- wyze.getDeviceStatus(device)
- wyze.getDeviceState(device)



## Internal methods

- wyze.login()
- wyze.getRefreshToken()
- wyze.getObjectList()
- wyze.runAction(instanceId, providerKey, actionKey)
- wyze.getDeviceInfo(deviceMac, deviceModel)
- wyze.getPropertyList(deviceMac, deviceModel)
- wyze.setProperty(deviceMac, deviceModel, propertyId, propertyValue)


## 🤖 Vacuum Xbox Controller (WIP)

Control your Wyze robot vacuum with an Xbox controller for real-time directional movement.

### Tools

**1. Scan your vacuum's capabilities:**
```bash
WYZE_EMAIL=x WYZE_PASSWORD=x WYZE_KEY_ID=x WYZE_API_KEY=x node tools/scan-vacuum.js
```

**2. Intercept Wyze app traffic (discover movement protocol):**
```bash
./tools/start-capture.sh
```
Then configure your phone to proxy through your Mac and interact with the vacuum in the Wyze app.

**3. Test Xbox controller input:**
```bash
node tools/xbox-controller.js
```
Uses keyboard (WASD) as fallback if no controller detected.

**4. Drive the vacuum (once protocol is discovered):**
```bash
WYZE_EMAIL=x WYZE_PASSWORD=x WYZE_KEY_ID=x WYZE_API_KEY=x node tools/vacuum-controller.js
```
