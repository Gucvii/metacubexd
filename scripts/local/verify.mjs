#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import {
  api,
  session,
  sparkleState,
  readJSON,
  json,
  home,
  auditDir,
  data,
  yaml,
  hash,
} from './runtime.mjs'

const s = session()
const report = {
  timestamp: new Date().toISOString(),
  mode: s.parallelTestMode ? 'parallel-test' : 'manual',
  checks: {},
  warnings: [],
}
const check = (name, condition) => {
  report.checks[name] = !!condition
  assert(condition, name)
}

try {
  const [info, state, config, profiles, providers] = await Promise.all([
    api(s, '/api/control/info'),
    api(s, '/api/control/kernel/status'),
    api(s, '/configs', { core: true }),
    api(s, '/api/control/profiles'),
    api(s, '/providers/rules', { core: true }),
  ])
  const manifest = readJSON(join(data, 'kernel-install.json'))
  check(
    'officialKernelUnmodified',
    hash(s.binaryPath) === manifest.binary_sha256,
  )
  check(
    'independentKernel',
    !s.binaryPath.includes('Sparkle.app') && state.version === manifest.version,
  )
  check('kernelRunning', state.status === 'running')
  check('tunOff', config.tun?.enable === false)
  if (s.parallelTestMode) {
    check(
      'strictTestControlsHidden',
      !info.features.includes('system-proxy') && !info.features.includes('tun'),
    )
  } else {
    check(
      'officialNetworkControlsAvailable',
      info.features.includes('system-proxy') && info.features.includes('tun'),
    )
    const [proxy, tun] = await Promise.all([
      api(s, '/api/control/sysproxy'),
      api(s, '/api/control/tun'),
    ])
    check('manualSystemProxyOff', proxy.enabled === false)
    check('manualTunOff', tun.enabled === false && tun.mode === 'sidecar')
  }
  check('loopbackController', state.externalController.startsWith('127.0.0.1:'))
  check(
    'loopbackProxy',
    config['allow-lan'] === false && config['bind-address'] === '127.0.0.1',
  )
  check(
    'dedicatedProxyPort',
    config['mixed-port'] === s.mixedPort && s.mixedPort !== 7890,
  )
  check(
    'oneLocalProfileNoOverlays',
    profiles.length === 1 && profiles[0].type === 'local' && profiles[0].active,
  )
  const loaded = Object.values(providers.providers)
  check(
    'all26RulesetsLoaded',
    loaded.length === 26 && loaded.every((p) => p.ruleCount > 0),
  )
  check(
    'controllerRequiresAuth',
    (await fetch(`${s.clashURL}/version`)).status === 401,
  )
  check(
    'agentRequiresAuth',
    (await fetch(`${s.controlURL}/api/control/kernel/status`)).status === 401,
  )
  const cors = await fetch(`${s.clashURL}/version`, {
    headers: { Authorization: `Bearer ${s.clashSecret}`, Origin: s.controlURL },
  })
  check(
    'dashboardCors',
    cors.headers.get('access-control-allow-origin') === s.controlURL ||
      cors.headers.get('access-control-allow-origin') === '*',
  )

  const snapshot = yaml.parse(
    readFileSync(join(home, 'profiles/sparkle-snapshot.yaml'), 'utf8'),
  )
  let proxies = (await api(s, '/proxies', { core: true })).proxies
  if (process.argv.includes('--restore-selections')) {
    const selected = readJSON(join(auditDir, 'manual-selections.json'))
    for (const [name, desired] of Object.entries(selected)) {
      const p = proxies[name]
      if (
        p?.type === 'Selector' &&
        p.all.includes(desired) &&
        p.now !== desired
      )
        await api(s, `/proxies/${encodeURIComponent(name)}`, {
          core: true,
          method: 'PUT',
          body: { name: desired },
        })
    }
    proxies = (await api(s, '/proxies', { core: true })).proxies
  }
  const graph = new Map(
    Object.entries(proxies)
      .filter(([n]) => n !== 'GLOBAL')
      .map(([n, p]) => [n, [...(p.all || [])]]),
  )
  for (const p of snapshot.proxies || [])
    if (p['dialer-proxy']) graph.set(p.name, [p['dialer-proxy']])
  const seen = new Set(),
    visiting = new Set()
  function visit(n) {
    if (visiting.has(n))
      throw new Error('Current route graph contains a dependency cycle')
    if (seen.has(n)) return
    visiting.add(n)
    for (const child of graph.get(n) || []) visit(child)
    visiting.delete(n)
    seen.add(n)
  }
  for (const n of graph.keys()) visit(n)
  check('currentRouteGraphAcyclic', true)
  for (const [name, p] of Object.entries(proxies))
    if (p.all?.length === 1 && p.all[0] === 'COMPATIBLE')
      report.warnings.push({
        group: name,
        reason: 'No matching node; inherited from the source configuration',
      })

  report.nodeConnectivity = []
  const policyPath = join(auditDir, 'health-policy.json')
  const excluded = existsSync(policyPath)
    ? readJSON(policyPath).excludedNodes || []
    : []
  for (const p of snapshot.proxies || []) {
    const exclusion = excluded.find((n) => n.name === p.name)
    if (exclusion) {
      report.nodeConnectivity.push({
        name: p.name,
        protocol: p.type,
        skipped: true,
        reason: exclusion.reason,
      })
      continue
    }
    let ok = false
    try {
      const result = await api(
        s,
        `/proxies/${encodeURIComponent(p.name)}/delay?timeout=10000&url=${encodeURIComponent('https://cp.cloudflare.com/generate_204')}`,
        { core: true },
      )
      ok = typeof result.delay === 'number' && result.delay > 0
    } catch {
      /* Report a failed node without serializing its definition. */
    }
    report.nodeConnectivity.push({ name: p.name, protocol: p.type, ok })
  }
  report.connectivityMethod =
    'One Mihomo delay probe per non-excluded node, HTTPS generate_204, timeout 10s, sequential; reachability only, not a bandwidth benchmark.'
  check(
    'bwgVlessReachable',
    report.nodeConnectivity.some((p) => p.name === 'local | bwg' && p.ok),
  )
  check(
    'bwgHy2Reachable',
    report.nodeConnectivity.some((p) => p.name === 'local | bwg-Hy2' && p.ok),
  )
  check(
    'laChainReachable',
    report.nodeConnectivity.some(
      (p) => p.name === 'local | US-LA-Exit' && p.ok,
    ),
  )
  const failed = report.nodeConnectivity.filter((p) => !p.ok && !p.skipped)
  if (failed.length)
    report.warnings.push({
      reason: 'Some imported nodes failed this one-shot probe',
      nodes: failed.map((p) => p.name),
    })

  for (const protocol of ['http', 'socks5h']) {
    const output = execFileSync(
      '/usr/bin/curl',
      [
        '--silent',
        '--show-error',
        '--head',
        '--max-time',
        '20',
        '--noproxy',
        '',
        '--proxy',
        `${protocol}://127.0.0.1:${s.mixedPort}`,
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        'https://cp.cloudflare.com/generate_204',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    check(`${protocol}ProxyRequest`, output.trim() === '204')
  }
  await new Promise((resolve, reject) => {
    let socket
    let done = false
    const req = http.request(`${s.clashURL}/traffic`, {
      agent: false,
      headers: {
        Authorization: `Bearer ${s.clashSecret}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      socket?.destroy()
      req.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(
      () => finish(new Error('Traffic WebSocket timeout')),
      5000,
    )
    req.on('error', () => finish(new Error('Traffic WebSocket failed')))
    req.on('response', (response) => {
      response.destroy()
      finish(new Error('Traffic WebSocket upgrade rejected'))
    })
    req.on('upgrade', (response, upgraded, head) => {
      socket = upgraded
      let buffer = head
      const parseFrame = () => {
        if (buffer.length < 2) return
        let length = buffer[1] & 127,
          offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        }
        if (length === 127)
          return finish(new Error('Unexpected large WebSocket frame'))
        if (buffer.length < offset + length) return
        try {
          const v = JSON.parse(
            buffer.subarray(offset, offset + length).toString(),
          )
          check(
            'trafficWebSocket',
            response.statusCode === 101 &&
              typeof v.up === 'number' &&
              typeof v.down === 'number',
          )
          finish()
        } catch {
          finish(new Error('Traffic WebSocket invalid frame'))
        }
      }
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        parseFrame()
      })
      socket.on('error', () => finish(new Error('Traffic WebSocket failed')))
      parseFrame()
    })
    req.end()
  })
  const after = await sparkleState()
  const before = readJSON(join(auditDir, 'before.json'))
  check(
    'sparkleFilesUnchanged',
    JSON.stringify(before.hashes) === JSON.stringify(after.hashes),
  )
  const manualNames = (snapshot['proxy-groups'] || [])
    .filter((g) => g.type === 'select')
    .map((g) => g.name)
  check(
    'sparkleManualSelectionsUnchanged',
    manualNames.every((n) => before.selections[n] === after.selections[n]),
  )
  check('systemProxyUnchanged', before.system_proxy === after.system_proxy)
  check(
    'defaultInterfaceUnchanged',
    /interface:\s*(\S+)/.exec(before.default_route)?.[1] ===
      /interface:\s*(\S+)/.exec(after.default_route)?.[1],
  )
  report.kernelVersion = state.version
  report.nodeCount = snapshot.proxies.length
  report.ruleCount = (await api(s, '/rules', { core: true })).rules.length
  json(join(auditDir, 'verification.json'), report)
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.failure = error.message.split('\n')[0]
  json(join(auditDir, 'verification.json'), report)
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
}
