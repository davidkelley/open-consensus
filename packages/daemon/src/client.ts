import { request } from 'node:http'

export interface DaemonRequest {
  method: string
  path: string
  /** JSON body (POST). */
  body?: unknown
  headers?: Record<string, string>
  /**
   * Abort + reject after this many ms if the daemon accepts the connection but
   * never responds (keeps a health-poll bounded). Omit for an open-ended call
   * such as a long-poll, which legitimately blocks up to the server's wait_ms.
   */
  timeoutMs?: number
}

export interface DaemonResponse {
  status: number
  body: string
}

/** True for a loopback endpoint (`http://host:port`); else it's a socket path. */
function isHttpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('http://') || endpoint.startsWith('https://')
}

/**
 * One request/response round-trip to the daemon over its endpoint — a unix
 * socket path or a `http://host:port` loopback URL — with the bearer token
 * attached. A thin, dependency-free client shared by the health check, tests,
 * and the MCP server (Stage 6).
 */
export function daemonRequest(
  endpoint: string,
  token: string,
  req: DaemonRequest,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body)
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined
        ? {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          }
        : {}),
      ...req.headers,
    }
    const common = { method: req.method, path: req.path, headers }
    const options = isHttpEndpoint(endpoint)
      ? { ...common, ...hostPort(endpoint) }
      : { ...common, socketPath: endpoint }

    const clientReq = request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    clientReq.on('error', reject)
    if (req.timeoutMs !== undefined) {
      clientReq.setTimeout(req.timeoutMs, () => {
        clientReq.destroy(new Error(`daemon request timed out after ${req.timeoutMs}ms`))
      })
    }
    if (payload !== undefined) clientReq.write(payload)
    clientReq.end()
  })
}

function hostPort(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint)
  return { host: url.hostname, port: Number(url.port) }
}
