const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')
const agentRequire = createRequire(
  join(__dirname, '../../packages/agent/package.json'),
)
const { parse } = agentRequire('yaml')
const upstream = parse(
  readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'),
)

// Read upstream settings directly: electron-builder concatenates protocol arrays
// in `extends`, so an empty child array would still register upstream schemes.
module.exports = {
  ...upstream,
  appId: 'app.gucvii.metacubexd.local',
  productName: 'MetaCubeXD Local',
  extraMetadata: {
    ...upstream.extraMetadata,
    name: 'metacubexd-local',
    productName: 'MetaCubeXD Local',
  },
  electronDist: join(__dirname, 'node_modules/electron/dist'),
  protocols: [],
}
