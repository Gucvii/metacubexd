#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(root, 'packages/agent/package.json'))
const yaml = require('yaml')
const data =
  process.env.MCXD_DATA_DIR ||
  join(homedir(), 'Library/Application Support/MetaCubeXD Local')
const sparkle = join(homedir(), 'Library/Application Support/sparkle')
const home = join(data, 'mihomo-home')
const sessionFile = join(data, 'local-session.json')
const auditDir = join(data, 'audit')
process.umask(0o077)
assert(isAbsolute(data), 'MCXD_DATA_DIR must be absolute')

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}
function write(path, value) {
  privateDir(dirname(path))
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}
function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}
function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function command(bin, args) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function unixJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/tmp/sparkle-mihomo-api.sock', path },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200)
            resolve(JSON.parse(Buffer.concat(chunks)))
          } catch {
            reject(new Error('Sparkle API request failed'))
          }
        })
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error('Sparkle API timeout')))
    req.on('error', reject)
  })
}

const trackedSparkleFiles = [
  'mihomo.yaml',
  'config.yaml',
  'profile.yaml',
  'override.yaml',
  'work/config.yaml',
  'override/19fb0e5a7c9.js',
  'substore/sub-store.json',
]
async function sparkleState() {
  const [proxyState, config] = await Promise.all([
    unixJSON('/proxies'),
    unixJSON('/configs'),
  ])
  const proxies = proxyState.proxies
  return {
    tun_enabled: config.tun?.enable === true,
    hashes: Object.fromEntries(
      trackedSparkleFiles
        .filter((f) => existsSync(join(sparkle, f)))
        .map((f) => [f, hash(join(sparkle, f))]),
    ),
    selections: Object.fromEntries(
      Object.entries(proxies)
        .filter(([, p]) => p.now !== undefined)
        .map(([n, p]) => [n, p.now]),
    ),
    system_proxy: command('/usr/sbin/scutil', ['--proxy']),
    default_route: command('/sbin/route', ['-n', 'get', 'default']),
  }
}

async function prepare() {
  assert(
    !existsSync(join(home, 'profiles/index.json')),
    'An existing local profile is present; refusing to overwrite it',
  )
  const kernel = readJSON(join(data, 'kernel-install.json'))
  assert.equal(
    hash(kernel.binary),
    kernel.binary_sha256,
    'Independent kernel hash mismatch',
  )
  const before = await sparkleState()
  if (!existsSync(join(auditDir, 'before.json')))
    json(join(auditDir, 'before.json'), before)
  const original = yaml.parse(
    readFileSync(join(sparkle, 'work/config.yaml'), 'utf8'),
  )
  const config = structuredClone(original)
  // Mihomo 1.19.32 removed this global option. Preserve its intent per node.
  if (config['global-client-fingerprint']) {
    for (const proxy of config.proxies || []) {
      if (
        ['vless', 'vmess', 'trojan'].includes(proxy.type) &&
        !proxy['client-fingerprint']
      )
        proxy['client-fingerprint'] = config['global-client-fingerprint']
    }
    delete config['global-client-fingerprint']
  }
  const iface = /interface:\s*(\S+)/.exec(before.default_route)?.[1]
  assert(
    iface && !iface.startsWith('utun'),
    'A physical default interface is required for parallel testing',
  )
  const removed = [
    'external-controller-unix',
    'external-controller-pipe',
    'external-controller-tls',
    'external-ui',
    'external-ui-url',
    'external-ui-name',
    'listeners',
  ]
  for (const key of removed) delete config[key]
  Object.assign(config, {
    'external-controller': '127.0.0.1:21001',
    secret: '',
    'mixed-port': 21002,
    port: 0,
    'socks-port': 0,
    'redir-port': 0,
    'tproxy-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'interface-name': iface,
    'external-controller-cors': {
      'allow-origins': ['http://127.0.0.1:*'],
      'allow-private-network': true,
    },
  })
  config.tun = {
    ...config.tun,
    enable: false,
    'auto-route': false,
    'auto-redirect': false,
    'auto-detect-interface': false,
  }
  if (config.dns) config.dns.listen = '127.0.0.1:15353'
  for (const key of ['rule-providers', 'proxy-providers']) {
    for (const provider of Object.values(config[key] || {})) {
      if (!provider.path) continue
      assert(
        !isAbsolute(provider.path),
        'Provider cache paths must be relative',
      )
      const suffix = relative(
        join(sparkle, 'work'),
        resolve(sparkle, 'work', provider.path),
      )
      assert(
        !suffix.startsWith('..') && !isAbsolute(suffix),
        'Provider path escapes the source directory',
      )
      const source = join(sparkle, 'work', suffix)
      if (existsSync(source)) {
        const dest = join(home, suffix)
        privateDir(dirname(dest))
        copyFileSync(source, dest)
        chmodSync(dest, 0o600)
      }
    }
  }
  for (const name of [
    'geoip.dat',
    'geosite.dat',
    'country.mmdb',
    'ASN.mmdb',
    'geoip.metadb',
  ]) {
    if (existsSync(join(sparkle, 'work', name))) {
      privateDir(home)
      copyFileSync(join(sparkle, 'work', name), join(home, name))
      chmodSync(join(home, name), 0o600)
    }
  }
  const profileID = 'sparkle-snapshot'
  const content = `# Local migration snapshot. No merge/script overlays. Credentials stay on this Mac.\n${yaml.stringify(config)}`
  write(join(home, 'profiles', `${profileID}.yaml`), content)
  write(join(home, 'config.yaml'), content)
  json(join(home, 'profiles/index.json'), [
    {
      id: profileID,
      name: 'Sparkle 迁移快照 · 独立内核',
      type: 'local',
      updatedAt: Date.now(),
    },
  ])
  json(join(home, 'profiles/state.json'), { activeId: profileID })
  write(join(data, 'mihomo-bin-override.txt'), `${kernel.binary}\n`)
  json(join(data, 'desktop-settings.json'), {
    silentUpdateCheck: false,
    tunAutoRestore: false,
    showTraySpeed: false,
  })
  json(join(auditDir, 'manual-selections.json'), before.selections)
  const differences = Object.fromEntries(
    [...new Set([...Object.keys(original), ...Object.keys(config)])]
      .filter((k) => JSON.stringify(original[k]) !== JSON.stringify(config[k]))
      .map((k) => [k, { changed: true }]),
  )
  const report = {
    sourceSHA256: hash(join(sparkle, 'work/config.yaml')),
    profileID,
    kernelVersion: kernel.version,
    interface: iface,
    counts: {
      nodes: config.proxies?.length || 0,
      groups: config['proxy-groups']?.length || 0,
      rules: config.rules?.length || 0,
      ruleProviders: Object.keys(config['rule-providers'] || {}).length,
    },
    changedTopLevelKeys: Object.keys(differences),
    subscriptionAutoUpdate: false,
    overlays: 0,
  }
  json(join(auditDir, 'migration.json'), report)
  console.log(JSON.stringify(report, null, 2))
}

function session() {
  const s = readJSON(sessionFile)
  const allowed = [
    realpathSync(
      join(
        root,
        'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ),
    ),
  ]
  const installed = join(data, 'app-install.json')
  if (existsSync(installed))
    allowed.push(realpathSync(readJSON(installed).executablePath))
  const actual = command('/bin/ps', ['-p', String(s.pid), '-o', 'comm=']).trim()
  assert(
    allowed.includes(realpathSync(actual)),
    'Saved PID is not this fork’s Electron executable',
  )
  return s
}

function launchTarget() {
  const installed = join(data, 'app-install.json')
  return existsSync(installed)
    ? { app: readJSON(installed).appPath, args: [] }
    : {
        app: join(root, 'apps/desktop/node_modules/electron/dist/Electron.app'),
        args: [join(root, 'apps/desktop')],
      }
}
async function api(s, path, { core = false, method = 'GET', body } = {}) {
  const response = await fetch(`${core ? s.clashURL : s.controlURL}${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${core ? s.clashSecret : s.controlToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  assert(response.ok, `${method} ${path} returned HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

async function start(normal = true) {
  assert(
    existsSync(join(root, 'apps/desktop/out/main/index.js')),
    'Build the desktop app first',
  )
  assert(
    existsSync(join(root, 'apps/desktop/renderer/index.html')),
    'Build and copy the UI first',
  )
  try {
    const current = session()
    if (current.parallelTestMode === !normal) {
      command('/usr/bin/open', ['-a', launchTarget().app])
      console.log(`Already running: ${current.controlURL}`)
      return
    }
    throw new Error('A different mode is running; stop it before changing mode')
  } catch (error) {
    if (
      !['ENOENT', 'ESRCH'].includes(error.code) &&
      !String(error.message).includes('Command failed: /bin/ps')
    )
      throw error
  }
  const target = launchTarget()
  command('/usr/bin/open', [
    '-n',
    '-a',
    target.app,
    '--env',
    `MCXD_DATA_DIR=${data}`,
    '--env',
    `MCXD_PARALLEL_TEST=${normal ? '0' : '1'}`,
    '--env',
    'ELECTRON_RUN_AS_NODE',
    '--args',
    ...target.args,
  ])
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const current = session()
      const state = await api(current, '/api/control/kernel/status')
      if (current.parallelTestMode === !normal && state.status === 'running') {
        ready = true
        break
      }
    } catch {
      /* The desktop is still booting. */
    }
  }
  assert(
    ready,
    'Desktop launched, but the independent kernel did not become ready within 30 seconds',
  )
  console.log(
    normal
      ? 'Started normal desktop mode; enable system proxy/TUN manually in the app.'
      : 'Started parallel test mode; OS proxy and TUN controls are disabled.',
  )
}

async function status() {
  const s = session()
  const [state, info, config] = await Promise.all([
    api(s, '/api/control/kernel/status'),
    api(s, '/api/control/info'),
    api(s, '/configs', { core: true }),
  ])
  console.log(
    JSON.stringify(
      {
        mode: s.parallelTestMode ? 'parallel-test' : 'normal',
        controlURL: s.controlURL,
        clashURL: s.clashURL,
        mixedPort: s.mixedPort,
        kernelStatus: state.status,
        kernelVersion: state.version,
        kernelPID: state.pid,
        kernelBinary: s.binaryPath,
        tunEnabled: config.tun?.enable,
        features: info.features,
      },
      null,
      2,
    ),
  )
}

async function stop() {
  const s = session()
  // The application’s SIGTERM handler performs its own bounded shutdown.
  process.kill(s.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      process.kill(s.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
        console.log('Stopped this fork’s desktop and kernel.')
        return
      }
      throw error
    }
  }
  throw new Error(
    'Desktop shutdown is still pending; no unrelated process was killed',
  )
}

export {
  api,
  session,
  sparkleState,
  readJSON,
  json,
  home,
  auditDir,
  data,
  root,
  yaml,
  hash,
}

const action = process.argv[2] || 'status'
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    if (action === 'prepare') await prepare()
    else if (action === 'start') await start(!process.argv.includes('--test'))
    else if (action === 'status') await status()
    else if (action === 'stop') await stop()
    else
      throw new Error('Usage: runtime.mjs prepare|start [--test]|status|stop')
  } catch (error) {
    // Never serialize errors/response bodies that could contain imported nodes.
    console.error(
      error instanceof assert.AssertionError
        ? error.message.split('\n')[0]
        : error.message,
    )
    process.exitCode = 1
  }
