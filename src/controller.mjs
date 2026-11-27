import 'dotenv/config'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'

const token = process.env.BOT_QR_TOKEN
if (!token || token.length < 24) throw new Error('BOT_QR_TOKEN precisa ter pelo menos 24 caracteres.')
const port = Number(process.env.PORT || 3000)
const childPort = Number(process.env.BOT_INTERNAL_PORT || 3001)
const allowedOrigin = process.env.PANEL_ORIGIN
let child = null
let lastError = ''
let stopping = false

function authorized(value) {
  const actual = Buffer.from(value || '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function startBot() {
  if (child) return
  stopping = false
  const processChild = spawn(process.execPath, ['src/index.mjs'], {
    env: { ...process.env, PORT: String(childPort) }, stdio: ['ignore', 'pipe', 'pipe']
  })
  child = processChild
  processChild.stdout.on('data', chunk => process.stdout.write(chunk))
  processChild.stderr.on('data', chunk => { lastError = 'O bot encontrou um erro. Consulte os logs do serviço.'; process.stderr.write(chunk) })
  processChild.on('error', error => { lastError = error.message })
  processChild.on('exit', code => { if (child === processChild) child = null; if (!stopping) lastError = `O bot parou inesperadamente (código ${code}).` })
}
function stopBot() { if (child) { stopping = true; child.kill('SIGINT') } }
async function childRequest(path) {
  return fetch(`http://127.0.0.1:${childPort}${path}`, { signal: AbortSignal.timeout(4000) })
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  if (origin && origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.writeHead(origin === allowedOrigin ? 204 : 403); return res.end() }
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/health' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
  if (!authorized(req.headers.authorization)) { res.writeHead(401); return res.end('Não autorizado') }
  if (path === '/api/status' && req.method === 'GET') {
    let connected = false
    if (child) try { connected = (await (await childRequest('/health')).json()).whatsappConnected === true } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ running: !!child, connected, error: lastError }))
  }
  if (path === '/api/start' && req.method === 'POST') { lastError = ''; startBot(); res.writeHead(202); return res.end() }
  if (path === '/api/stop' && req.method === 'POST') { stopBot(); res.writeHead(202); return res.end() }
  if (path === '/api/qr' && req.method === 'GET') {
    if (!child) { res.writeHead(409); return res.end('Inicie o bot primeiro.') }
    try {
      const response = await childRequest(`/qr?token=${encodeURIComponent(token)}`)
      const html = await response.text()
      const image = html.match(/src="(data:image\/png;base64,[^"]+)"/)?.[1]
      if (!image) { res.writeHead(404); return res.end('QR ainda não disponível.') }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ image }))
    } catch { res.writeHead(503); return res.end('Bot ainda está iniciando.') }
  }
  res.writeHead(404); res.end('Não encontrado')
})
server.listen(port, '0.0.0.0', () => { console.log(`Controlador escutando na porta ${port}`); startBot() })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopBot(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref() })
