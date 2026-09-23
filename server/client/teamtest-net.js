/* The Team Test — client network layer.
 *
 * Drop-in transport the prototype already calls. With no server running it
 * stays in mock mode and just logs; point it at a WebSocket and the same
 * events go over the wire unchanged.
 *
 *   TeamTestNet.connect('ws://localhost:8787');   // your server
 *   TeamTestNet.onMessage(fn);                    // inbound
 *   TeamTestNet.send('task.submit', { choice: 2 });
 *
 * Every frame is: { v, seq, t, roomId, playerId, type, payload }
 * See PROTOCOL.md for the full event contract and a minimal Node server.
 */
(function (global) {
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  var Net = {
    version: 1,
    url: null,
    socket: null,
    mode: 'mock',
    state: 'idle',
    roomId: null,
    playerId: null,
    seq: 0,
    queue: [],
    history: [],
    maxHistory: 500,
    logLevel: 'info',
    console: true,
    handlers: [],
    watchers: [],

    configure: function (opts) {
      Object.keys(opts || {}).forEach(function (k) { Net[k] = opts[k]; });
      return Net;
    },

    identify: function (roomId, playerId) {
      Net.roomId = roomId;
      Net.playerId = playerId;
      Net.log('info', 'identify', { roomId: roomId, playerId: playerId });
      return Net;
    },

    connect: function (url) {
      Net.url = url;
      if (!global.WebSocket || !url) {
        Net.mode = 'mock';
        Net.state = 'mock';
        Net.log('warn', 'net.mock', { reason: url ? 'no WebSocket' : 'no url given' });
        return Net;
      }
      Net.mode = 'live';
      Net.state = 'connecting';
      try {
        var s = new WebSocket(url);
        Net.socket = s;
        s.onopen = function () {
          Net.state = 'open';
          Net.log('info', 'net.open', { url: url });
          var q = Net.queue.splice(0);
          q.forEach(function (f) { s.send(JSON.stringify(f)); });
          if (q.length) Net.log('info', 'net.flush', { frames: q.length });
          Net.emitLocal('net.open', { url: url });
        };
        s.onclose = function (e) {
          Net.state = 'closed';
          Net.log('warn', 'net.close', { code: e.code });
          Net.emitLocal('net.close', { code: e.code });
          if (Net.reconnect !== false) setTimeout(function () { Net.connect(url); }, 1500);
        };
        s.onerror = function () {
          Net.state = 'error';
          Net.log('error', 'net.error', { url: url });
        };
        s.onmessage = function (e) {
          var frame;
          try { frame = JSON.parse(e.data); } catch (err) {
            Net.log('error', 'net.bad_frame', { raw: String(e.data).slice(0, 120) });
            return;
          }
          Net.record('in', frame);
          Net.handlers.forEach(function (h) { h(frame.type, frame.payload, frame); });
        };
      } catch (err) {
        Net.mode = 'mock';
        Net.state = 'mock';
        Net.log('error', 'net.connect_failed', { message: String(err) });
      }
      return Net;
    },

    disconnect: function () {
      Net.reconnect = false;
      if (Net.socket) Net.socket.close();
      Net.socket = null;
      Net.state = 'idle';
      return Net;
    },

    send: function (type, payload) {
      var frame = {
        v: Net.version,
        seq: ++Net.seq,
        t: Date.now(),
        roomId: Net.roomId,
        playerId: Net.playerId,
        type: type,
        payload: payload || {},
      };
      Net.record('out', frame);
      if (Net.mode === 'live' && Net.socket && Net.state === 'open') {
        Net.socket.send(JSON.stringify(frame));
      } else if (Net.mode === 'live') {
        Net.queue.push(frame);
        if (Net.queue.length > 200) Net.queue.shift();
      }
      return frame;
    },

    /* Inbound events the client generated locally while in mock mode —
       the same shape the server will eventually push down. */
    emitLocal: function (type, payload) {
      var frame = {
        v: Net.version, seq: ++Net.seq, t: Date.now(),
        roomId: Net.roomId, playerId: Net.playerId,
        type: type, payload: payload || {}, local: true,
      };
      Net.record('in', frame);
      Net.handlers.forEach(function (h) { h(frame.type, frame.payload, frame); });
      return frame;
    },

    onMessage: function (fn) { Net.handlers.push(fn); return Net; },
    onRecord: function (fn) { Net.watchers.push(fn); return Net; },

    record: function (dir, frame) {
      var entry = { dir: dir, frame: frame };
      Net.history.push(entry);
      if (Net.history.length > Net.maxHistory) Net.history.shift();
      Net.log('debug', (dir === 'out' ? '→ ' : '← ') + frame.type, frame.payload);
      Net.watchers.forEach(function (w) { w(dir, frame); });
    },

    log: function (level, msg, data) {
      if (!Net.console) return;
      if ((LEVELS[level] || 0) < (LEVELS[Net.logLevel] || 20)) return;
      var line = '[TT ' + level.toUpperCase() + '] ' + msg;
      var fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      if (global.console && global.console[fn]) global.console[fn](line, data || '');
    },

    /* Dump the whole session as NDJSON — paste into a file and replay it
       against your server, or diff two runs. */
    dump: function () {
      return Net.history.map(function (e) {
        return JSON.stringify({ dir: e.dir, frame: e.frame });
      }).join('\n');
    },

    download: function (name) {
      var blob = new Blob([Net.dump()], { type: 'application/x-ndjson' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name || 'teamtest-session') + '.ndjson';
      a.click();
    },

    clear: function () { Net.history.length = 0; return Net; },
  };

  global.TeamTestNet = Net;
})(typeof window !== 'undefined' ? window : this);
