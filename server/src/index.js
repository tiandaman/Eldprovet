'use strict';
/* The Team Test — game server.
 *
 *   npm install && npm start            # ws://localhost:8787
 *
 * One port serves both the WebSocket (any path) and a few HTTP endpoints:
 *   GET /                  reference browser client (client/index.html)
 *   GET /healthz           liveness
 *   GET /stats             connection / room counts
 *   GET /leaderboard       private-room leaderboard (JSON)
 *   GET /join/:code        invite-link target: room info (JSON)
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Hub } = require('./hub');
const { Store } = require('./store');

function createServer(options) {
  const opts = Object.assign({
    port: Number(process.env.PORT) || 8787,
    host: process.env.HOST || '0.0.0.0',
    dataFile: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
    publicUrl: process.env.PUBLIC_URL || null,
    queueBotFillMs: process.env.QUEUE_BOT_FILL_MS != null ? Number(process.env.QUEUE_BOT_FILL_MS) : 0,
    queueBotButtonMs: process.env.QUEUE_BOT_BUTTON_MS != null ? Number(process.env.QUEUE_BOT_BUTTON_MS) : 10000,
    room: {},
    quiet: false,
  }, options || {});
  if (process.env.SOLO_PHASE_MS && opts.room.soloPhaseMs == null) {
    opts.room = Object.assign({}, opts.room, { soloPhaseMs: Number(process.env.SOLO_PHASE_MS) });
  }
  if (process.env.DRAIN_GROWTH && opts.room.drainGrowth == null) {
    opts.room = Object.assign({}, opts.room, { drainGrowth: Number(process.env.DRAIN_GROWTH) });
  }
  if (process.env.COOP_VARIANT && opts.room.coopVariant == null) {
    opts.room = Object.assign({}, opts.room, { coopVariant: process.env.COOP_VARIANT }); // dev: force tokens|hold|relay
  }

  const log = opts.quiet ? () => {} : (msg, data) => console.log('[tt]', msg, data ? JSON.stringify(data) : '');
  const store = new Store(opts.dataFile);
  const hub = new Hub({
    store, log,
    config: {
      queueBotFillMs: opts.queueBotFillMs,
      queueBotButtonMs: opts.queueBotButtonMs,
      publicUrl: opts.publicUrl || 'http://localhost:' + opts.port,
      room: opts.room,
    },
  });

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };

  // Reference browser client + the scripts it loads.
  const STATIC = {
    '/': [path.join(__dirname, '..', 'client', 'index.html'), 'text/html; charset=utf-8'],
    '/shared/tasks.js': [path.join(__dirname, '..', 'shared', 'tasks.js'), 'text/javascript; charset=utf-8'],
    '/teamtest-net.js': [path.join(__dirname, '..', 'client', 'teamtest-net.js'), 'text/javascript; charset=utf-8'], // copy of ../teamtest-net.js so server/ deploys on its own
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const file = STATIC[url.pathname];
    if (file) {
      return fs.readFile(file[0], (err, body) => {
        if (err) return json(res, 404, { error: 'not_found' });
        res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
        res.end(body);
      });
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/stats') return json(res, 200, hub.stats());
    if (url.pathname === '/leaderboard') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20);
      return json(res, 200, { rows: store.leaderboard(limit) });
    }
    const join = /^\/join\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (join) {
      let code = join[1].toUpperCase();
      if (!code.startsWith('TT-')) code = 'TT-' + code;
      const info = hub.roomInfo(code);
      return info ? json(res, 200, info) : json(res, 404, { error: 'no_such_room' });
    }
    json(res, 404, { error: 'not_found' });
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => hub.attach(ws));
  const beat = setInterval(() => hub.heartbeat(), 15000);
  beat.unref();

  return {
    server, wss, hub, store,
    listen() {
      return new Promise((resolve) => server.listen(opts.port, opts.host, () => {
        const addr = server.address();
        log('listening', { port: addr.port });
        resolve(addr.port);
      }));
    },
    close() {
      clearInterval(beat);
      hub.close();
      for (const c of wss.clients) c.terminate();
      store.flush();
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}

module.exports = { createServer };

if (require.main === module) {
  const app = createServer();
  app.listen();
  const stop = () => { app.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
