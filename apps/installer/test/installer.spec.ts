import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('installer worker', () => {
  it('serves the install script at /install with a shell content-type', async () => {
    const res = await SELF.fetch('https://openconsensus.dev/install')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('shellscript')
    const body = await res.text()
    // Retargeted to this repo, and defaults to the latest release (no redeploy
    // needed per CLI release — D-PKG9).
    expect(body).toContain('OWNER="davidkelley"')
    expect(body).toContain('REPO="open-consensus"')
    expect(body).toContain('releases/latest/download')
    expect(body).toContain('${OPEN_CONSENSUS_VERSION:-latest}')
  })

  it('serves at the root path too', async () => {
    const res = await SELF.fetch('https://openconsensus.dev/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('REPO="open-consensus"')
  })

  it('templates an explicit ?version pin into the script default', async () => {
    const res = await SELF.fetch('https://openconsensus.dev/install?version=1.2.3')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('${OPEN_CONSENSUS_VERSION:-1.2.3}')
    expect(body).not.toContain('${OPEN_CONSENSUS_VERSION:-latest}')
  })

  it('accepts a v-prefixed and pre-release version', async () => {
    expect((await SELF.fetch('https://openconsensus.dev/install?version=v0.1.0')).status).toBe(200)
    expect((await SELF.fetch('https://openconsensus.dev/install?version=1.2.3-rc.1')).status).toBe(
      200,
    )
  })

  it('rejects an invalid version (no shell injection via the query)', async () => {
    const res = await SELF.fetch('https://openconsensus.dev/install?version=1;rm%20-rf')
    expect(res.status).toBe(400)
  })

  it('contains the version-template marker exactly once (so ?version templating is total)', async () => {
    const body = await (await SELF.fetch('https://openconsensus.dev/install')).text()
    const count = body.split('${OPEN_CONSENSUS_VERSION:-latest}').length - 1
    expect(count).toBe(1)
  })

  it('404s an unknown path and 405s a non-GET method', async () => {
    expect((await SELF.fetch('https://openconsensus.dev/other')).status).toBe(404)
    expect(
      (await SELF.fetch('https://openconsensus.dev/install', { method: 'POST' })).status,
    ).toBe(405)
  })
})
