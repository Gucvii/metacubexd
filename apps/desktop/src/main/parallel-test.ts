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
    parallelTestMode:
      input.parallel === '1' || (!!localDataDir && input.parallel !== '0'),
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
