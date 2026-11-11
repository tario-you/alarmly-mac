#!/usr/bin/env node
// The watcher: reads macOS's notification log (the same rows Notification Center shows) for the apps in config.apps. Each new
// message goes on your Super Productivity list (one open task per chat) and rings Wake, within the guards in config.ring.
// Nothing leaves the Mac: it reads a local SQLite file, calls Super Productivity on 127.0.0.1, and opens wake://ring.
//
// WeChat: each row names the chat (a wxid, a WeChat id, or NNN@chatroom for a group) and carries what the banner shows: the
// message itself while WeChat's "message preview" is on, a bare "You've received a message" while it is off.
// Other apps (Messages, Slack, Telegram, ...): the banner's title is used as the chat.
//
// Reading the log needs Full Disk Access for the program running node (Terminal, iTerm, or node itself under launchd).
//   node triggers/notify-watch.mjs run              watch until stopped (what the LaunchAgent runs)
//   node triggers/notify-watch.mjs peek [--hours H] print what is new (or from the last H hours), change nothing
//   node triggers/notify-watch.mjs test "Alice" "hello"   push one fake message through the whole chain (task + ring)
// State: ~/.local/state/wake/watch.json (0600), log: ~/.local/state/wake/watch.log
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig, STATE_DIR } from './config.mjs';
import { client, upsertTasks } from './super-productivity.mjs';
import { ring as ringWake } from './wake-ring.mjs';

export const NOTE_DB = process.env.WAKE_NOTE_DB || path.join(os.homedir(), 'Library/Group Containers/group.com.apple.usernoted/db2/db');
const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const STATE = path.join(STATE_DIR, 'watch.json'), LOG = path.join(STATE_DIR, 'watch.log');
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { writeFileSync(`${f}.tmp`, JSON.stringify(v), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };

/** A binary property list (bplist00) as plain values: dicts as objects, arrays, strings, numbers, Buffers for data, and
 *  { UID: n } for a keyed archive's references. */
export function bplist(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.subarray(buf.length - 32), offSize = t[6], refSize = t[7];
  const num = Number(t.readBigUInt64BE(8)), top = Number(t.readBigUInt64BE(16)), tableAt = Number(t.readBigUInt64BE(24));
  const uint = (at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[at + i]; return v; };
  const offsets = Array.from({ length: num }, (_, i) => uint(tableAt + i * offSize, offSize));
  const read = (ref) => {
    const at = offsets[ref], marker = buf[at], type = marker >> 4, info = marker & 15;
    const len = () => { if (info !== 15) return [info, at + 1]; const n = 1 << (buf[at + 1] & 15); return [uint(at + 2, n), at + 2 + n]; };
    const refs = (s, n, k = 0) => Array.from({ length: n }, (_, i) => read(uint(s + (k + i) * refSize, refSize)));
    switch (type) {
      case 0: return info === 8 ? false : info === 9 ? true : null;
      case 1: return (1 << info) === 8 ? Number(buf.readBigInt64BE(at + 1)) : uint(at + 1, 1 << info);
      case 2: return info === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 3: return buf.readDoubleBE(at + 1);
      case 4: { const [n, s] = len(); return buf.subarray(s, s + n); }
      case 5: { const [n, s] = len(); return buf.subarray(s, s + n).toString('latin1'); }
      case 6: { const [n, s] = len(); return Buffer.from(buf.subarray(s, s + 2 * n)).swap16().toString('utf16le'); }
      case 8: return { UID: uint(at + 1, info + 1) };
      case 10: case 12: { const [n, s] = len(); return refs(s, n); }
      case 13: { const [n, s] = len(); const ks = refs(s, n), vs = refs(s, n, n); return Object.fromEntries(ks.map((k, i) => [k, vs[i]])); }
      default: throw new Error(`bplist marker ${marker.toString(16)} at ${at}`);
    }
  };
  return read(top);
}

/** A notification row as { chat, title, text }: WeChat's chat id from the keyed archive in its user data (empty for other
 *  apps), the banner's title, and what the banner shows (title | subtitle | body). */
export function notice(blob) {
  let req = {};
  try { req = bplist(Buffer.from(blob)).req ?? {}; } catch { return { chat: '', title: '', text: '' }; }
  const str = (s) => (typeof s === 'string' && s.trim() ? s.trim() : '');
  const title = str(req.titl), text = [req.titl, req.subt, req.body].map(str).filter(Boolean).join(' | ');
  try {
    const a = bplist(Buffer.from(req.usda)), o = a.$objects, root = o[a.$top.root.UID];
    const keys = root['NS.keys'].map((k) => o[k.UID]), vals = root['NS.objects'].map((v) => o[v.UID]);
    return { chat: String(vals[keys.indexOf('chatname')] ?? ''), title, text };
  } catch { return { chat: '', title, text }; }
}

/** New notification rows for the configured apps since the cursor in `state`, one item per message:
 *  { key, app, chat, name, named, group, at, text? }. A chat named "-" is skipped. Moves the cursor on.
 *  A row is new by its number or its delivery time: macOS can reuse lower row numbers, so the time cursor carries on. */
export function newMessages(state, cfg, { db = NOTE_DB, sinceMs = 0, now = Date.now() } = {}) {
  const con = new DatabaseSync(db, { readOnly: true });
  try {
    const appOf = new Map(con.prepare('select app_id, identifier from app').all()
      .filter((r) => cfg.apps[String(r.identifier).toLowerCase()]).map((r) => [r.app_id, cfg.apps[String(r.identifier).toLowerCase()]]));
    if (!appOf.size) return [];
    const of = `app_id in (${[...appOf.keys()].join(',')})`;
    const from = (now - sinceMs - APPLE_EPOCH) / 1000;
    let last = state.lastRec ?? con.prepare(`select max(rec_id) as m from record where ${of} and delivered_date < ?`).get(from)?.m ?? 0;
    let lastAt = state.lastAt ?? from;
    const top = con.prepare(`select max(rec_id) as m from record where ${of}`).get()?.m ?? 0;
    if (last > top) last = top;
    const seen = new Set(state.seen ?? []), out = [];
    for (const r of con.prepare(`select rec_id, app_id, delivered_date, data from record where ${of} and (rec_id > ? or delivered_date > ?) order by rec_id`).all(last, lastAt)) {
      last = Math.max(last, r.rec_id);
      if (r.delivered_date > lastAt) lastAt = r.delivered_date;
      const n = notice(r.data), app = appOf.get(r.app_id), at = r.delivered_date ? Math.round(APPLE_EPOCH + r.delivered_date * 1000) : now;
      const chat = n.chat || n.title || app, key = `${app}:${chat}`;
      if (seen.has(`${key}@${Math.floor(at / 1000)}`)) continue;   // (one message can be posted twice in the same second)
      seen.add(`${key}@${Math.floor(at / 1000)}`);
      const given = cfg.names[chat];
      if (given === '-') continue;
      if (cfg.ringFor === 'named' && !given) continue;
      const name = given || (n.chat && n.title) || chat;
      const keepText = cfg.saveText === 'all' || (cfg.saveText === 'named' && given);
      out.push({ key, app, chat, name, named: Boolean(given), group: chat.endsWith('@chatroom'), at, ...(keepText && n.text ? { text: n.text } : {}) });
    }
    state.lastRec = last; state.lastAt = lastAt; state.seen = [...seen].slice(-500);
    return out;
  } finally { con.close(); }
}

/** One pass on a batch of new messages: tasks first, then one ring naming every chat in the batch. */
export async function handle(state, items, { cfg, call, ring, log = () => {} }) {
  if (!items.length) return;
  const tasks = state.tasks ?? {};
  let who = [...new Set(items.map((i) => i.name))];
  if (cfg.superProductivity.enabled) {
    try { who = await upsertTasks(items, tasks, { call, projectId: cfg.superProductivity.projectId }); log(`tasks: ${who.join(', ')}`); }
    catch (e) { log(`super productivity: ${e.message}`); }
  }
  state.tasks = tasks;
  const apps = [...new Set(items.map((i) => i.app))].join('/');
  const r = ring(`${apps}: ${[...new Set(items.map((i) => i.name))].join(', ')}`);
  log(`ring: ${r.rang ? r.url : `skipped (${r.skipped})`}`);
}

async function main(args) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const cfg = loadConfig(), log = (s) => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, { mode: 0o600 });
  const call = client(cfg.superProductivity), ring = (label) => ringWake(label, { cfg });
  if (args[0] === 'peek') {
    const hours = Number(args[args.indexOf('--hours') + 1]) || 0, state = hours ? {} : readJson(STATE, {});
    for (const it of newMessages(state, cfg, { sinceMs: hours * 3600e3 })) console.log(JSON.stringify(it));
    return 0;
  }
  if (args[0] === 'test') {
    const item = { key: `test:${args[1] || 'Test'}`, app: 'Test', chat: args[1] || 'Test', name: args[1] || 'Test', at: Date.now(), text: args[2] || 'test message' };
    const state = readJson(STATE, {});
    await handle(state, [item], { cfg, call, ring: (l) => ringWake(l, { cfg, force: true }), log: (s) => { log(s); console.log(s); } });
    writeJson(STATE, state);
    return 0;
  }
  if (args[0] !== 'run') { console.error('usage: notify-watch.mjs run | peek [--hours H] | test NAME TEXT'); return 2; }
  log(`run: apps ${Object.values(cfg.apps).join(', ')}`);
  for (;;) {
    const state = readJson(STATE, {});
    let items = [];
    try { items = newMessages(state, cfg); } catch (e) { log(`notification log unreadable (Full Disk Access?): ${e.message}`); }
    await handle(state, items, { cfg, call, ring, log });
    writeJson(STATE, state);
    await new Promise((res) => setTimeout(res, cfg.pollSeconds * 1000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
