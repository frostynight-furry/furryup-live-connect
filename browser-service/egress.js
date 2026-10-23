'use strict'
const http = require('node:http')
const net = require('node:net')
const dns = require('node:dns').promises

// Public page scripts/API hosts only. Not configurable by request input.
const HOSTS = ['douyin.com', 'douyinstatic.com', 'douyinpic.com', 'byteimg.com', 'bytegoofy.com', 'bytescm.com', 'ibytedtos.com', 'pstatp.com']
function allowedHost(host) { return HOSTS.some(suffix => host === suffix || host.endsWith('.' + suffix)) }
function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false
  const [a, b, c] = ip.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
}
async function resolveTarget(authority, lookup = dns.lookup) {
  const match = /^([a-z0-9.-]+):443$/i.exec(authority || '')
  if (!match || !allowedHost(match[1].toLowerCase())) throw new Error('EGRESS_DENIED')
  const addresses = await lookup(match[1], { all: true, family: 4 })
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error('EGRESS_DENIED')
  // Connect to this validated numeric address, never resolve the host a second time.
  return addresses[0].address
}
async function createEgressProxy() {
  const sockets = new Set()
  const server = http.createServer((_, response) => { response.writeHead(403); response.end() })
  server.maxConnections = 128
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  server.on('connect', (request, socket, head) => {
    let upstream
    const stop = () => { socket.destroy(); if (upstream) upstream.destroy() }
    socket.setTimeout(15000, stop); socket.on('error', stop); socket.on('close', () => { if (upstream) upstream.destroy() })
    resolveTarget(request.url).then(address => {
      if (socket.destroyed) return
      upstream = net.connect({ host: address, port: 443, family: 4 })
      sockets.add(upstream); upstream.on('close', () => { sockets.delete(upstream); socket.destroy() })
      upstream.setTimeout(15000, stop); upstream.on('error', stop)
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
    }).catch(stop)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: 'http://127.0.0.1:' + server.address().port, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)) } }
}
module.exports = { allowedHost, publicIPv4, resolveTarget, createEgressProxy }
