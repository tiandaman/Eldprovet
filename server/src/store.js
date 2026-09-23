'use strict';
/* Persistence: accounts, runs, leaderboard.
 *
 * A single JSON file written atomically (tmp + rename), debounced. Enough for
 * a prototype and zero native deps; the interface is small so it can be
 * swapped for Postgres/SQLite later without touching game code.
 *
 *   accounts    — { id, handle, friends[], created }
 *   runs        — { roomId, private, started, ended, teamTime, tasksCleared,
 *                   cause, players: [{ playerId, gave, cost, finalLife }] }
 *   leaderboard — view over runs where the room was private
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { accounts: {}, runs: [] };
    this.timer = null;
    if (file) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        this.data.accounts = parsed.accounts || {};
        this.data.runs = parsed.runs || [];
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[store] failed to load', file, err.message);
      }
    }
  }

  // ── accounts ────────────────────────────────────────────
  ensureAccount(id) {
    let a = this.data.accounts[id];
    if (!a) {
      a = { id, handle: id, friends: [], created: Date.now() };
      this.data.accounts[id] = a;
      this.save();
    }
    return a;
  }

  getAccount(id) { return this.data.accounts[id] || null; }

  findByHandle(handle) {
    const h = String(handle || '').toLowerCase();
    return Object.values(this.data.accounts).find((a) => a.handle.toLowerCase() === h || a.id.toLowerCase() === h) || null;
  }

  setHandle(id, handle) {
    const a = this.ensureAccount(id);
    const clash = this.findByHandle(handle);
    if (clash && clash.id !== id) return false;
    a.handle = handle;
    this.save();
    return true;
  }

  addFriend(id, otherId) {
    if (id === otherId) return false;
    const a = this.ensureAccount(id);
    const b = this.ensureAccount(otherId);
    if (a.friends.indexOf(b.id) < 0) a.friends.push(b.id);
    if (b.friends.indexOf(a.id) < 0) b.friends.push(a.id);
    this.save();
    return true;
  }

  removeFriend(id, otherId) {
    const a = this.getAccount(id);
    const b = this.getAccount(otherId);
    if (a) a.friends = a.friends.filter((f) => f !== otherId);
    if (b) b.friends = b.friends.filter((f) => f !== id);
    this.save();
  }

  // ── runs ────────────────────────────────────────────────
  recordRun(run) {
    this.data.runs.push(run);
    this.save();
  }

  leaderboard(limit = 20) {
    return this.data.runs
      .filter((r) => r.private)
      .sort((a, b) => b.teamTime - a.teamTime || b.tasksCleared - a.tasksCleared)
      .slice(0, limit)
      .map((r) => ({
        roomId: r.roomId, teamTime: r.teamTime, tasksCleared: r.tasksCleared,
        ended: r.ended, players: r.players.map((p) => p.playerId),
        names: r.players.map((p) => (p.bot && p.playerId.startsWith('bot-') ? null : (this.getAccount(p.playerId) || { handle: p.playerId }).handle)),
      }));
  }

  // ── io ──────────────────────────────────────────────────
  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
  }

  flush() {
    if (!this.file) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
