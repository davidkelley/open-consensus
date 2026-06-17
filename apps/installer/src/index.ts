// Cloudflare Worker for openconsensus.dev/install (plan D-PKG9). It serves the
// install.sh EMBEDDED at build time (wrangler `Text` rule), so the script is
// edge-served + versioned with the worker — no dependency on raw.githubusercontent
// at install time. The DEFAULT script downloads `releases/latest/download/...`, so
// a new CLI release needs NO worker redeploy; only a script change does. An
// explicit `?version=X` pins the install by templating the script's default.
import installScript from '../install.sh'

// Accept `0.1.0`, `v0.1.0`, `1.2.3-rc.1` — the script normalizes the `v` prefix.
const VERSION_RE = /^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // The route is `openconsensus.dev/install*`, but 404 anything else defensively.
    if (url.pathname !== '/install' && url.pathname !== '/') {
      return new Response('Not found\n', { status: 404 })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405 })
    }

    let body = installScript
    const version = url.searchParams.get('version')
    if (version !== null) {
      if (!VERSION_RE.test(version)) {
        return new Response('invalid version (expected e.g. 0.1.0)\n', { status: 400 })
      }
      // Replace the script's default so a pinned install is reproducible while a
      // user's own OPEN_CONSENSUS_VERSION env still wins.
      body = installScript.replace(
        '${OPEN_CONSENSUS_VERSION:-latest}',
        `\${OPEN_CONSENSUS_VERSION:-${version}}`,
      )
    }

    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'text/x-shellscript; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  },
}
