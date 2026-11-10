import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizedImagePath, publishImmutableAlias, readImageFile, saveImageFile } from '../src/store.ts'

const control = vi.hoisted(() => ({
  linkError: '',
  renameError: '',
  unreadablePath: '',
  directoryError: 'EACCES',
  fileSyncError: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const failure = (code: string) => Object.assign(new Error(code), { code })
  return {
    ...actual,
    async link(...args: Parameters<typeof actual.link>) {
      if (control.linkError) throw failure(control.linkError)
      return actual.link(...args)
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      if (control.renameError) throw failure(control.renameError)
      return actual.rename(...args)
    },
    async open(...args: Parameters<typeof actual.open>) {
      if (args[1] === constants.O_RDONLY && String(args[0]) === control.unreadablePath) {
        throw failure(control.directoryError)
      }
      const handle = await actual.open(...args)
      if (control.fileSyncError && args[1] !== constants.O_RDONLY) {
        vi.spyOn(handle, 'sync').mockRejectedValue(failure(control.fileSyncError))
      }
      return handle
    },
  }
})

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))
const limits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}
const policy = { maxPixels: 2048 * 2048, maxDimension: 8192, maxBytes: 1024 * 1024 }
const roots: string[] = []

async function storage() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-android-store-'))
  roots.push(base)
  return { base, root: join(base, 'home', 'attachments', 'v1') }
}

function save(root: string) {
  return saveImageFile(root, { data: PNG, mediaType: 'image/png' }, limits, policy)
}

afterEach(async () => {
  control.linkError = ''
  control.renameError = ''
  control.unreadablePath = ''
  control.directoryError = 'EACCES'
  control.fileSyncError = ''
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('attachment publication on restricted filesystems', () => {
  it.skipIf(process.platform === 'win32').each(['EACCES', 'EPERM'])('accepts a traverse-only home ancestor: %s', async (code) => {
    const { root, base } = await storage()
    control.unreadablePath = base
    control.directoryError = code
    const ref = await save(root)
    await expect(readImageFile(root, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it.each(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'])('publishes and deduplicates when hard links fail: %s', async (code) => {
    const { root } = await storage()
    control.linkError = code
    const first = await save(root)
    const second = await save(root)
    expect(second.attachmentId).toBe(first.attachmentId)
    await expect(readImageFile(root, second)).resolves.toEqual({ ref: second, data: PNG })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('handles both Android blockers in one image publication', async () => {
    const { root, base } = await storage()
    control.unreadablePath = base
    control.linkError = 'EPERM'
    const ref = await save(root)
    await expect(readImageFile(root, ref)).resolves.toEqual({ ref, data: PNG })
  })

  it('keeps concurrent publications readable and leaves no staging files', async () => {
    const { root } = await storage()
    control.linkError = 'EPERM'
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    const target = join(root, 'objects', sha256.slice(0, 2), sha256)
    let finished = false
    const writers = Promise.all(Array.from({ length: 16 }, () => save(root)))
      .finally(() => { finished = true })
    while (!finished) {
      try {
        expect(new Uint8Array(await readFile(target))).toEqual(PNG)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      await setImmediate()
    }
    const refs = await writers
    expect(new Set(refs.map(ref => ref.attachmentId)).size).toBe(1)
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('preserves an existing corrupt object instead of replacing it', async () => {
    const { root } = await storage()
    control.linkError = 'EPERM'
    const ref = await save(root)
    const path = normalizedImagePath(root, ref)
    await chmod(path, 0o600)
    await writeFile(path, 'corrupt')
    await expect(save(root)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    expect(await readFile(path, 'utf8')).toBe('corrupt')
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('publishes a verified alias without hard links', async () => {
    const { root } = await storage()
    control.linkError = 'EPERM'
    const ref = await save(root)
    const source = normalizedImagePath(root, ref)
    const target = join(root, 'aliases', 'pixel.png')
    const sha256 = createHash('sha256').update(PNG).digest('hex')
    await publishImmutableAlias(root, source, target, sha256)
    await publishImmutableAlias(root, source, target, sha256)
    expect(new Uint8Array(await readFile(target))).toEqual(PNG)
    expect(new Uint8Array(await readFile(source))).toEqual(PNG)
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('checks alias source bytes before publication', async () => {
    const { root } = await storage()
    control.linkError = 'EPERM'
    const ref = await save(root)
    await expect(publishImmutableAlias(root, normalizedImagePath(root, ref), join(root, 'aliases', 'wrong'), '0'.repeat(64)))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    expect(await readdir(join(root, 'aliases'))).toEqual([])
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('reports errors syncing the publication directory', async () => {
    const { root } = await storage()
    const ref = await save(root)
    control.unreadablePath = dirname(normalizedImagePath(root, ref))
    await expect(save(root)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: { code: 'EACCES' } })
  })

  it.skipIf(process.platform === 'win32')('does not suppress ancestor I/O failures', async () => {
    const { root, base } = await storage()
    control.unreadablePath = base
    control.directoryError = 'EIO'
    await expect(save(root)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('retains file-fsync failures and cleans the stage', async () => {
    const { root } = await storage()
    control.fileSyncError = 'EIO'
    await expect(save(root)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: { code: 'EIO' } })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('does not replace an unknown link error with a fallback', async () => {
    const { root } = await storage()
    control.linkError = 'EIO'
    await expect(save(root)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: { code: 'EIO' } })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })

  it('reports rename failure and removes the staging file', async () => {
    const { root } = await storage()
    control.linkError = 'EPERM'
    control.renameError = 'ENOSPC'
    await expect(save(root)).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: { code: 'ENOSPC' } })
    expect(await readdir(join(root, 'tmp'))).toEqual([])
  })
})
