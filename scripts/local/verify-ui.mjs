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
const { expect } = require('@playwright/test')
const env = { ...process.env, MCXD_DATA_DIR: data, MCXD_PARALLEL_TEST: '0' }
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
  // Test user interactions through the real renderer, intercepting every
  // system-proxy/TUN write. No OS setting or helper is touched by this test.
  const interactions = {}
  const exerciseToggle = async (toggle, endpoint, status) => {
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    let writes = 0
    let enabled = false
    let reject = true
    let release
    const pattern = `**/api/control/${endpoint}`
    await page.route(pattern, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: status(enabled) })
        return
      }
      assert.equal(route.request().method(), 'POST')
      const body = route.request().postDataJSON()
      assert.equal(typeof body.enabled, 'boolean')
      writes++
      await new Promise((resolve) => {
        release = resolve
      })
      if (reject) {
        await route.fulfill({
          status: 409,
          json: { statusMessage: 'Simulated enable failure' },
        })
        return
      }
      enabled = body.enabled
      await route.fulfill({ json: status(enabled) })
    })
    await toggle.click()
    await expect.poll(() => typeof release).toBe('function')
    await expect(toggle).toBeDisabled()
    release()
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    reject = false
    release = undefined
    await toggle.focus()
    await toggle.press('Space')
    await expect.poll(() => typeof release).toBe('function')
    await expect(toggle).toBeDisabled()
    release()
    await expect(toggle).toBeEnabled()
    await expect(toggle).toBeChecked()
    release = undefined
    await toggle.click()
    await expect.poll(() => typeof release).toBe('function')
    await expect(toggle).toBeDisabled()
    release()
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    await page.waitForTimeout(300)
    await expect(toggle).not.toBeChecked()
    assert.equal(writes, 3)
    await page.unroute(pattern)
    interactions[endpoint] = {
      visible: true,
      initiallyOff: true,
      failureReverted: true,
      pendingDisabled: true,
      keyboardEnable: true,
      mouseDisable: true,
      interceptedWrites: writes,
    }
  }
  stage = 'system-proxy-control'
  const sysProxy = page.getByRole('checkbox', {
    name: /Enable system proxy|启用系统代理/,
  })
  const actualProxy = await api(s, '/api/control/sysproxy')
  assert.equal(actualProxy.enabled, false)
  await exerciseToggle(sysProxy, 'sysproxy', (enabled) => ({
    ...actualProxy,
    enabled,
  }))
  await sysProxy
    .locator('..')
    .locator('..')
    .screenshot({ path: join(auditDir, 'control.png'), animations: 'disabled' })
  stage = 'tun-navigation'
  await page.locator('a[href$="/config"]').first().click()
  const tun = page.getByRole('checkbox', {
    name: /Enable TUN Device|开启 TUN 转发/,
  })
  const actualTun = await api(s, '/api/control/tun')
  assert.equal(actualTun.enabled, false)
  await exerciseToggle(tun, 'tun', (enabled) => ({
    enabled,
    mode: enabled ? 'tun' : 'sidecar',
    ...(enabled ? { stack: 'mixed' } : {}),
  }))
  await page.screenshot({
    path: join(auditDir, 'tun.png'),
    fullPage: true,
    animations: 'disabled',
  })
  assert.equal((await api(s, '/api/control/sysproxy')).enabled, false)
  assert.equal((await api(s, '/api/control/tun')).enabled, false)
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
    before.system_proxy === after.system_proxy &&
    before.tun_enabled === after.tun_enabled
  assert(unchanged, 'Sparkle or OS proxy changed during desktop start/quit')
  const result = {
    timestamp: new Date().toISOString(),
    overview,
    proxies: '/proxies',
    officialDesktopBridge: true,
    interactions,
    networkToggleTestsIntercepted: true,
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
