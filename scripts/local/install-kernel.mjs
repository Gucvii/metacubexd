#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Deliberately pinned; kernel changes are separate from upstream UI updates.
const version = process.argv[2] || 'v1.19.32'
const data =
  process.env.MCXD_DATA_DIR ||
  join(homedir(), 'Library/Application Support/MetaCubeXD Local')
const sha = (b) => createHash('sha256').update(b).digest('hex')
process.umask(0o077)
try {
  assert(
    process.platform === 'darwin' && process.arch === 'arm64',
    'This local bootstrap targets Apple Silicon macOS',
  )
  assert(
    /^v\d+\.\d+\.\d+$/.test(version),
    'Expected a stable vX.Y.Z release tag',
  )
  mkdirSync(data, { recursive: true, mode: 0o700 })
  const manifestPath = join(data, 'kernel-install.json')
  if (existsSync(manifestPath)) {
    const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (
      current.version === version &&
      existsSync(current.binary) &&
      sha(readFileSync(current.binary)) === current.binary_sha256
    ) {
      console.log(`Verified existing independent Mihomo ${version}`)
      process.exit(0)
    }
  }
  const release = JSON.parse(
    execFileSync(
      'gh',
      ['api', `repos/MetaCubeX/mihomo/releases/tags/${version}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  )
  const name = `mihomo-darwin-arm64-${version}.gz`
  const asset = release.assets.find((a) => a.name === name)
  assert(
    asset?.digest?.startsWith('sha256:'),
    'Official release has no SHA-256 digest for this asset',
  )
  assert(
    asset.browser_download_url ===
      `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${name}`,
    'Unexpected release asset URL',
  )
  const archive = join(data, `${name}.download`)
  execFileSync(
    '/usr/bin/curl',
    [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--retry',
      '2',
      '--connect-timeout',
      '15',
      '--max-time',
      '180',
      asset.browser_download_url,
      '--output',
      archive,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const compressed = readFileSync(archive)
  assert.equal(
    `sha256:${sha(compressed)}`,
    asset.digest,
    'Official release digest mismatch',
  )
  const binary = join(data, 'kernels', version, 'mihomo')
  mkdirSync(join(data, 'kernels', version), { recursive: true, mode: 0o700 })
  const bytes = gunzipSync(compressed)
  writeFileSync(binary, bytes, { mode: 0o700 })
  chmodSync(binary, 0o700)
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        repository: 'MetaCubeX/mihomo',
        version,
        asset: name,
        archive_sha256: sha(compressed),
        binary_sha256: sha(bytes),
        binary,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  unlinkSync(archive)
  console.log(`Installed official Mihomo ${version}; release digest verified.`)
} catch {
  console.error(
    'Kernel installation failed. Check GitHub access, gh authentication, and release asset integrity; no running kernel was switched.',
  )
  process.exitCode = 1
}
