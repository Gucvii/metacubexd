#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { root, data, readJSON, json, hash, session } from './runtime.mjs'

try {
  const kernel = readJSON(join(data, 'kernel-install.json'))
  assert.equal(
    hash(kernel.binary),
    kernel.binary_sha256,
    'Independent kernel integrity check failed',
  )
  const desktop = join(root, 'apps/desktop')
  const destination = join(homedir(), 'Applications/MetaCubeXD Local.app')
  const replacing = existsSync(destination)
  if (replacing) {
    assert(
      process.argv.includes('--replace-local'),
      'The local application is already installed; stop it and use --replace-local for a reviewed update',
    )
    assert.equal(
      readJSON(join(data, 'app-install.json')).appPath,
      destination,
      'Refusing to replace an unmanaged application',
    )
    let running = false
    try {
      session()
      running = true
    } catch {
      /* Stopped or stale session. */
    }
    assert(!running, 'Stop the local application before replacing its bundle')
  }
  copyFileSync(kernel.binary, join(desktop, 'resources/mihomo'))
  chmodSync(join(desktop, 'resources/mihomo'), 0o755)
  writeFileSync(join(desktop, 'resources/.mihomo-target'), 'darwin-arm64')
  if (!process.argv.includes('--install-built'))
    execFileSync(
      'pnpm',
      [
        'exec',
        'electron-builder',
        '--dir',
        '--mac',
        '--arm64',
        '--publish',
        'never',
        '--config',
        'electron-builder.local.cjs',
      ],
      {
        cwd: desktop,
        env: { ...process.env, MIHOMO_VERSION: kernel.version },
        stdio: 'inherit',
      },
    )
  const artifact = join(desktop, 'dist/mac-arm64/metacubexd.app')
  assert(existsSync(artifact), 'Packaged application was not generated')
  assert.equal(
    hash(join(artifact, 'Contents/Resources/mihomo')),
    kernel.binary_sha256,
    'Bundled kernel differs from the verified release',
  )
  mkdirSync(join(homedir(), 'Applications'), { recursive: true })
  const backup = join(data, 'previous-apps', `${Date.now()}.app`)
  if (replacing) {
    mkdirSync(join(data, 'previous-apps'), { recursive: true, mode: 0o700 })
    renameSync(destination, backup)
  }
  try {
    execFileSync('/usr/bin/ditto', [artifact, destination])
  } catch (error) {
    rmSync(destination, { recursive: true, force: true })
    if (replacing) renameSync(backup, destination)
    throw error
  }
  const executableName = execFileSync(
    '/usr/libexec/PlistBuddy',
    [
      '-c',
      'Print :CFBundleExecutable',
      join(destination, 'Contents/Info.plist'),
    ],
    { encoding: 'utf8' },
  ).trim()
  const install = {
    appPath: destination,
    executablePath: join(destination, 'Contents/MacOS', executableName),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    kernelVersion: kernel.version,
    defaultMode: 'manual',
  }
  json(join(data, 'app-install.json'), install)
  console.log(
    `Installed ${destination}; Open the app and enable system proxy/TUN manually in the GUI.`,
  )
} catch (error) {
  console.error(error.message.split('\n')[0])
  process.exitCode = 1
}
