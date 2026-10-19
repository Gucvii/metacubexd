import type { SystemProxyController } from '@metacubexd/agent/types'
import { describe, expect, it, vi } from 'vitest'
import { runShutdownCleanup } from '../cleanup'
import { localRuntimeOptions, protectSystemProxy } from '../parallel-test'

describe('local desktop runtime defaults', () => {
  const base = { appName: 'MetaCubeXD', appData: '/user/appdata' }
  it('preserves the upstream application defaults', () => {
    expect(localRuntimeOptions(base)).toEqual({
      localDataDir: undefined,
      parallelTestMode: false,
    })
  })
  it('opens the local packaged app in parallel mode even from Finder', () => {
    expect(
      localRuntimeOptions({ ...base, appName: 'MetaCubeXD Local' }),
    ).toEqual({
      localDataDir: '/user/appdata/MetaCubeXD Local',
      parallelTestMode: true,
    })
  })
  it('defaults an explicitly isolated data directory to parallel mode', () => {
    expect(
      localRuntimeOptions({ ...base, dataDir: '/isolated' }).parallelTestMode,
    ).toBe(true)
  })
  it('requires an explicit normal-mode request to expose OS controls', () => {
    expect(
      localRuntimeOptions({
        ...base,
        appName: 'MetaCubeXD Local',
        parallel: '0',
      }).parallelTestMode,
    ).toBe(false)
  })
})

function controller(): SystemProxyController {
  return {
    isEnabled: vi.fn(async () => true),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    setAutoProxy: vi.fn(async () => {}),
    disableAutoProxy: vi.fn(async () => {}),
    describe: () => ({ port: 21002, bypass: [] }),
  }
}

describe('parallel test system proxy protection', () => {
  it('does not resume another client’s enabled proxy at boot', async () => {
    const original = controller()
    const protectedProxy = protectSystemProxy(original, true)
    if (await protectedProxy.isEnabled()) await protectedProxy.enable()
    expect(original.isEnabled).not.toHaveBeenCalled()
    expect(original.enable).not.toHaveBeenCalled()
  })

  it('rejects fixed/PAC enable without touching OS settings', async () => {
    const original = controller()
    const protectedProxy = protectSystemProxy(original, true)
    await expect(protectedProxy.enable()).rejects.toThrow('parallel test')
    await expect(
      protectedProxy.setAutoProxy('http://127.0.0.1/pac'),
    ).rejects.toThrow('parallel test')
    expect(original.enable).not.toHaveBeenCalled()
    expect(original.setAutoProxy).not.toHaveBeenCalled()
  })

  it('stops its kernel on quit without clearing another client’s proxy', async () => {
    const original = controller()
    const stopKernel = vi.fn(async () => {})
    await runShutdownCleanup({
      systemProxy: protectSystemProxy(original, true),
      stopKernel,
      stopControlServer: async () => {},
    })
    await protectSystemProxy(original, true).disableAutoProxy()
    expect(original.disable).not.toHaveBeenCalled()
    expect(original.disableAutoProxy).not.toHaveBeenCalled()
    expect(stopKernel).toHaveBeenCalledOnce()
  })

  it('preserves the official controller outside parallel mode', () => {
    const original = controller()
    expect(protectSystemProxy(original, false)).toBe(original)
  })
})
