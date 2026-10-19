#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  data,
  root,
  session,
  api,
  sparkleState,
  json,
  auditDir,
} from './runtime.mjs'

const require = createRequire(join(root, 'packages/ui/package.json'))
const { _electron: electron } = require('playwright')
const env = { ...process.env, MCXD_DATA_DIR: data, MCXD_PARALLEL_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
let stage = 'launch'
let diagnostics
try {
  const before = await sparkleState()
  app = await electron.launch({
    executablePath: join(
      root,
      'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
    args: [join(root, 'apps/desktop')],
    env,
  })
  const page = await app.firstWindow()
  let pageErrors = 0
  page.on('pageerror', () => {
    pageErrors++
  })
  await page.waitForURL('**/overview', { timeout: 30000 })
  stage = 'overview'
  assert(
    await page.evaluate(() => !!window.metacubexd?.isDesktop),
    'Official desktop bridge missing',
  )
  const overview = new URL(page.url()).pathname
  const s = session()
  let state
  for (let i = 0; i < 30; i++) {
    state = await api(s, '/api/control/kernel/status')
    if (state.status === 'running') break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(
    state.status,
    'running',
    `Kernel status during desktop verification: ${state.status}`,
  )
  stage = 'control-navigation'
  await page.locator('a[href$="/control"]').first().click()
  diagnostics = await page.evaluate(async () => {
    const control = window.metacubexd?.control
    const result = await fetch(`${control?.base}/info`, {
      headers: { Authorization: `Bearer ${control?.token}` },
    })
    const info = await result.json()
    return {
      path: location.pathname,
      desktopBridge: !!window.metacubexd?.isDesktop,
      controlTokenPresent: !!control?.token,
      controlStatus: result.status,
      hasAgent: !!info.hasAgent,
      kernelControlAvailable: info.features?.includes('kernel-control'),
    }
  })
  stage = 'kernel-version'
  await page
    .getByText('v1.19.32', { exact: true })
    .first()
    .waitFor({ timeout: 15000 })
  stage = 'proxies-navigation'
  await page.locator('a[href$="/proxies"]').first().click()
  stage = 'proxy-group'
  await page
    .getByText('BWG 自动切换', { exact: true })
    .first()
    .waitFor({ timeout: 15000 })
  await page.screenshot({ path: join(auditDir, 'proxies.png'), fullPage: true })
  assert.equal(pageErrors, 0, 'Renderer emitted an uncaught page error')
  await app.close()
  app = undefined
  const after = await sparkleState()
  const unchanged =
    JSON.stringify(before.hashes) === JSON.stringify(after.hashes) &&
    before.system_proxy === after.system_proxy
  assert(unchanged, 'Sparkle or OS proxy changed during desktop start/quit')
  const result = {
    timestamp: new Date().toISOString(),
    overview,
    proxies: '/proxies',
    officialDesktopBridge: true,
    kernelVersionShown: true,
    uncaughtPageErrors: pageErrors,
    sparkleAndSystemProxyUnchangedAcrossQuit: unchanged,
  }
  json(join(auditDir, 'ui-verification.json'), result)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(
    `Desktop verification failed at ${stage}: ${error.message.split('\n')[0]}`,
  )
  if (diagnostics) console.error(JSON.stringify(diagnostics))
  process.exitCode = 1
} finally {
  if (app) await app.close()
}
