import type { SystemProxyController } from '@metacubexd/agent/types'
import { join } from 'node:path'

export function localRuntimeOptions(input: {
  dataDir?: string
  parallel?: string
  appName: string
  appData: string
}): { localDataDir?: string; parallelTestMode: boolean } {
  const localBuild = ['MetaCubeXD Local', 'metacubexd-local'].includes(
    input.appName,
  )
  const localDataDir =
    input.dataDir ||
    (localBuild ? join(input.appData, 'MetaCubeXD Local') : undefined)
  return {
    localDataDir,
    // Finder launches expose the official controls. Strict test mode is opt-in.
    parallelTestMode: input.parallel === '1',
  }
}

/** Only an explicit action in this app acquires the system proxy. */
export function manualSystemProxy(
  controller: SystemProxyController,
): SystemProxyController {
  let acquired = false
  return {
    ...controller,
    isEnabled: async () => acquired && controller.isEnabled(),
    enable: async (bypass) => {
      // Retain cleanup responsibility even if an OS command partially fails.
      acquired = true
      await controller.enable(bypass)
    },
    setAutoProxy: async (url) => {
      acquired = true
      await controller.setAutoProxy(url)
    },
    disable: async () => {
      if (!acquired) return
      await controller.disable()
      acquired = false
    },
    disableAutoProxy: async () => {
      if (acquired) await controller.disableAutoProxy()
    },
  }
}

/** A parallel instance never acquires or clears another client's OS proxy. */
export function protectSystemProxy(
  controller: SystemProxyController,
  parallel: boolean,
): SystemProxyController {
  if (!parallel) return controller
  const denied = async (): Promise<void> => {
    throw new Error('System proxy changes are disabled in parallel test mode')
  }
  return {
    ...controller,
    isEnabled: async () => false,
    enable: denied,
    setAutoProxy: denied,
    // Upstream cleanup calls disable even if this instance never enabled it.
    disable: async () => {},
    disableAutoProxy: async () => {},
  }
}
