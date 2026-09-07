const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const repo = process.env.GITHUB_REPOSITORY
const tag = process.env.RELEASE_TAG
const expected = process.env.EXPECTED_SHA256
if (repo !== '494086366/hemusic-downloads' || !/^v3\.0\.0-r\d+$/.test(tag || '') || !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Invalid release inputs')
const jsonApi = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`], { encoding: 'utf8' }))
const release = jsonApi('releases?per_page=100').find(item => item.tag_name === tag)
if (!release?.draft) throw new Error('Assembly is permitted only in a private draft')
const download = asset => execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], { maxBuffer: 10 * 1024 * 1024 })
const manifestAsset = release.assets.find(asset => asset.name === 'HEmusic-arm64-parts.json')
if (!manifestAsset) throw new Error('Parts manifest is missing')
const manifest = JSON.parse(download(manifestAsset).toString('utf8'))
if (manifest.sha256 !== expected || manifest.filename !== 'HEmusic-3.0.0-mac-arm64-local-sign.tar.gz' || !Array.isArray(manifest.parts) || manifest.parts.length > 64) throw new Error('Invalid parts manifest')
const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'hemusic-assembly-'))
const output = path.join(directory, manifest.filename)
const digest = crypto.createHash('sha256')
const seen = new Set()
let size = 0
const fd = fs.openSync(output, 'wx')
try {
  for (const part of manifest.parts) {
    if (!/^HEmusic-arm64-r10\.part-\d{3}$/.test(part.name) || seen.has(part.name)) throw new Error('Invalid or repeated part')
    seen.add(part.name)
    const asset = release.assets.find(asset => asset.name === part.name)
    if (!asset || asset.state !== 'uploaded') throw new Error(`Missing part: ${part.name}`)
    const bytes = download(asset)
    if (bytes.length !== part.size || crypto.createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error(`Part integrity failure: ${part.name}`)
    fs.writeSync(fd, bytes)
    digest.update(bytes)
    size += bytes.length
  }
} finally { fs.closeSync(fd) }
if (size !== manifest.size || digest.digest('hex') !== expected) throw new Error('Final archive checksum mismatch')
const existing = release.assets.find(asset => asset.name === manifest.filename)
if (existing?.state === 'starter' && existing.size === 0) execFileSync('gh', ['api', '-X', 'DELETE', `repos/${repo}/releases/assets/${existing.id}`])
else if (existing) throw new Error('A complete archive already exists; refusing to overwrite it')
execFileSync('gh', ['release', 'upload', tag, output, '--repo', repo], { stdio: 'inherit' })
const uploaded = jsonApi(`releases/${release.id}/assets`).find(asset => asset.name === manifest.filename)
if (uploaded?.digest !== `sha256:${expected}`) throw new Error('Uploaded archive checksum mismatch')
console.log(`Verified complete ARM64 archive: ${expected}`)
