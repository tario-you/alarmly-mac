import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));
process.env.WAKE_STATE_DIR = tmp;
process.env.WAKE_CONFIG = path.join(tmp, 'none.json');
const { DEFAULTS, loadConfig, merge } = await import('../triggers/config.mjs');
const { holdReason, idleMs, inQuietHours, ring, ringUrl } = await import('../triggers/wake-ring.mjs');
const { bplist, handle, newMessages, notice } = await import('../triggers/notify-watch.mjs');
const { upsertTasks } = await import('../triggers/super-productivity.mjs');
const { GROUP, HIDDEN, SHOWN, SLACK } = await import('./fixtures.mjs');
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const min = 60e3;
const cfgWith = (over = {}) => { const f = path.join(tmp, `c${Math.random()}.json`); writeFileSync(f, JSON.stringify(over)); return loadConfig(f); };

function logDb(rows) {
  const db = path.join(mkdtempSync(path.join(tmp, 'db-')), 'db'), w = new DatabaseSync(db);
  w.exec('create table app (app_id integer, identifier text); create table record (rec_id integer, app_id integer, delivered_date real, data blob)');
  w.exec("insert into app values (7, 'com.tencent.xinwechat'), (8, 'com.apple.mail'), (9, 'com.tinyspeck.slackmacgap')");
  const add = w.prepare('insert into record values (?, ?, ?, ?)');
  for (const r of rows) add.run(...r);
  w.close();
  return db;
}
const apple = (s) => Date.UTC(2001, 0, 1) + s * 1000;

test('config: defaults, nested merge, app ids lower-cased, a user app list replaces the default', () => {
  const c = loadConfig(path.join(tmp, 'missing.json'));
  assert.deepEqual(c.apps, { 'com.tencent.xinwechat': 'WeChat' });
  assert.equal(c.ring.problems, 2);
  const u = cfgWith({ apps: { 'com.tinyspeck.slackmacgap': 'Slack' }, ring: { problems: 5 } });
  assert.deepEqual(u.apps, { 'com.tinyspeck.slackmacgap': 'Slack' });
  assert.equal(u.ring.problems, 5); assert.equal(u.ring.gapMinutes, 10);
  assert.deepEqual(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});

test('notices: WeChat chat id from the keyed archive, banner text, other apps by title', () => {
  assert.equal(bplist(HIDDEN).app, 'com.tencent.xinwechat');
  assert.deepEqual(notice(HIDDEN), { chat: 'wxid_fixture', title: '', text: "You've received a message" });
  assert.equal(notice(GROUP).chat, '12345@chatroom');
  assert.deepEqual(notice(SHOWN), { chat: 'wxid_fixture', title: 'Alice', text: 'Alice | See you at 9' });
  assert.deepEqual(notice(SLACK), { chat: '', title: 'Bob', text: 'Bob | deploy is red' });
  assert.deepEqual(notice(Buffer.from('bplist00 nope')), { chat: '', title: '', text: '' });
});

test('watcher: each message once, a muted chat skipped, other apps ignored unless configured', () => {
  const db = logDb([[1, 7, 815000000, SHOWN], [2, 7, 815000000.4, SHOWN], [3, 8, 815000001, SHOWN], [4, 7, 815000060, GROUP], [5, 7, 815000090, HIDDEN], [6, 9, 815000100, SLACK]]);
  const cfg = cfgWith({ names: { '12345@chatroom': '-' } }), state = { lastRec: 0 };
  const items = newMessages(state, cfg, { db });
  assert.deepEqual(items.map((i) => [i.chat, i.name, i.at, i.text]), [
    ['wxid_fixture', 'Alice', apple(815000000), 'Alice | See you at 9'],
    ['wxid_fixture', 'wxid_fixture', apple(815000090), "You've received a message"],
  ]);
  assert.equal(state.lastRec, 5);   // (Slack is not configured here)
  assert.deepEqual(newMessages(state, cfg, { db }), []);
  const both = cfgWith({ apps: { 'com.tencent.xinWeChat': 'WeChat', 'com.tinyspeck.slackmacgap': 'Slack' } });
  const all = newMessages({ lastRec: 0 }, both, { db });
  assert.deepEqual(all.at(-1), { key: 'Slack:Bob', app: 'Slack', chat: 'Bob', name: 'Bob', named: false, group: false, at: apple(815000100), text: 'Bob | deploy is red' });
});

test('watcher: ringFor "named" and saveText "named" keep unnamed chats out', () => {
  const db = logDb([[1, 7, 815000000, SHOWN], [2, 7, 815000060, GROUP]]);
  const only = newMessages({ lastRec: 0 }, cfgWith({ ringFor: 'named', names: { '12345@chatroom': 'Team' } }), { db });
  assert.deepEqual(only.map((i) => i.name), ['Team']);
  const quiet = newMessages({ lastRec: 0 }, cfgWith({ saveText: 'named' }), { db });
  assert.equal(quiet[0].text, undefined);
});

test('watcher: rows numbered lower than the cursor still count by delivery time', () => {
  const db = logDb([[10, 7, 815000000, HIDDEN]]), cfg = cfgWith(), now = apple(815000000);
  const state = { lastRec: 0 };
  assert.equal(newMessages(state, cfg, { db, now }).length, 1);
  state.lastRec = 365;
  const w = new DatabaseSync(db); const add = w.prepare('insert into record values (?, ?, ?, ?)');
  add.run(11, 7, 815000300, HIDDEN); add.run(12, 7, 815000400, GROUP); w.close();
  assert.deepEqual(newMessages(state, cfg, { db, now }).map((i) => i.chat), ['wxid_fixture', '12345@chatroom']);
  assert.deepEqual(newMessages(state, cfg, { db, now }), []);
});

test('ring guards: gap, away-from-Mac, quiet hours, off switch', () => {
  const now = Date.UTC(2026, 10, 11, 18), r = DEFAULTS.ring;
  assert.equal(holdReason({ now, last: 0, idle: 40 * min, ring: r }), '');
  assert.match(holdReason({ now, last: 0, idle: 2 * min, ring: r }), /^you are at the Mac/);
  assert.equal(holdReason({ now, last: 0, idle: 0, ring: { ...r, awayMinutes: 0 } }), '');
  assert.match(holdReason({ now, last: now - 4 * min, idle: 40 * min, ring: r }), /^rang 4 min ago/);
  assert.match(holdReason({ now, last: 0, idle: 40 * min, ring: { ...r, enabled: false } }), /off/);
  const q = { from: '23:00', to: '07:00' };
  assert.equal(inQuietHours(q, new Date(2026, 0, 1, 2, 0)), true);
  assert.equal(inQuietHours(q, new Date(2026, 0, 1, 12, 0)), false);
  assert.equal(inQuietHours({ from: '09:00', to: '17:00' }, new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(inQuietHours(null), false);
});

test('ring: opens wake://ring with the label and problem count, then holds for the gap', () => {
  assert.equal(ringUrl('WeChat: Alice & Bob', 3), 'wake://ring?label=WeChat%3A%20Alice%20%26%20Bob&problems=3');
  assert.equal(ringUrl('x', 99), 'wake://ring?label=x&problems=10');
  const opened = [], open = (u) => opened.push(u), cfg = cfgWith(), now = Date.now();
  assert.deepEqual(ring('WeChat: Alice', { cfg, now, idle: 60 * min, open }), { rang: true, url: 'wake://ring?label=WeChat%3A%20Alice&problems=2' });
  assert.match(ring('again', { cfg, now: now + min, idle: 60 * min, open }).skipped, /^rang 1 min ago/);
  assert.equal(ring('forced', { cfg, now: now + min, idle: 0, open, force: true }).rang, true);
  assert.equal(opened.length, 2);
});

test('HID idle time reads in ns', () => {
  assert.equal(idleMs('  |   "HIDIdleTime" = 905000000000\n'), 905000);
  assert.equal(idleMs(''), 0);
});

test('Super Productivity: one open task per chat, updated, a new one after you tick it', async () => {
  const done = new Set(), calls = [];
  const call = async (m, r, b) => { calls.push([m, r, b]); if (m === 'GET') { const id = r.split('/').pop(); return { id, isDone: done.has(id) }; } return { id: `t${calls.length}` }; };
  const at = new Date(2026, 10, 11, 23, 30).getTime(), tasks = {};
  const msg = (n) => ({ key: 'WeChat:wxid_a', app: 'WeChat', name: 'Alice', at: at + n * min, text: `m${n}` });
  assert.deepEqual(await upsertTasks([msg(0)], tasks, { call }), ['Alice']);
  assert.deepEqual(calls[0].slice(0, 2), ['POST', '/tasks']);
  assert.equal(calls[0][2].title, 'Nov 11: Alice wrote on WeChat, 1 new since 23:30');
  assert.equal(calls[0][2].projectId, 'INBOX_PROJECT');
  await upsertTasks([msg(1)], tasks, { call });
  assert.equal(calls.at(-1)[0], 'PATCH'); assert.match(calls.at(-1)[2].title, /2 new since 23:30$/);
  assert.equal(calls.at(-1)[2].notes, '23:30 m0\n23:31 m1');
  done.add(tasks['WeChat:wxid_a'].id);
  await upsertTasks([msg(2)], tasks, { call });
  assert.equal(calls.at(-1)[0], 'POST'); assert.match(calls.at(-1)[2].title, /1 new since 23:32$/);
});

test('handle: tasks then one ring for the batch; Super Productivity down still rings', async () => {
  const cfg = cfgWith(), rings = [], logs = [];
  const items = [{ key: 'WeChat:a', app: 'WeChat', name: 'Alice', at: Date.now() }, { key: 'WeChat:b', app: 'WeChat', name: 'Bob', at: Date.now() }];
  const state = {};
  await handle(state, items, { cfg, call: async () => ({ id: 'x', isDone: false }), ring: (l) => { rings.push(l); return { rang: true, url: 'u' }; }, log: (s) => logs.push(s) });
  assert.deepEqual(rings, ['WeChat: Alice, Bob']);
  assert.deepEqual(Object.keys(state.tasks), ['WeChat:a', 'WeChat:b']);
  await handle({}, items, { cfg, call: async () => { throw new Error('ECONNREFUSED'); }, ring: (l) => { rings.push(l); return { rang: false, skipped: 'x' }; }, log: (s) => logs.push(s) });
  assert.equal(rings.length, 2);
  assert.ok(logs.some((l) => /super productivity: ECONNREFUSED/.test(l)));
});

test('presence: home when any address answers, gone when none do or the phone is not on the network', async () => {
  const { atHome, resolve } = await import('../triggers/presence.mjs');
  assert.deepEqual(resolve('p.local', 'name: p.local\nip_address: 192.168.0.9\nipv6_address: fe80:e::1\nipv6_address: 2001:db8::5\n'), { v4: ['192.168.0.9'], v6: ['2001:db8::5'], link: ['1'] });
  assert.equal(atHome({ enabled: false, devices: ['p.local'] }).home, true);
  assert.equal(atHome({ enabled: true, devices: [] }).home, true);
  let t = 0; const clock = () => (t += 500), nudges = [];
  const there = atHome({ enabled: true, devices: ['p.local'], probeSeconds: 8 }, { resolveFn: () => ({ v4: ['10.0.0.9'], v6: [] }), pingFn: (ip) => (t > 2000), nudgeFn: (ip) => nudges.push(ip), ndpFn: () => '', now: clock });
  assert.deepEqual(there, { home: true, how: 'p.local 10.0.0.9 answered' });
  assert.deepEqual(nudges, ['10.0.0.9']);   // (one nudge, then pings until it wakes)
  t = 0;
  const gone = atHome({ enabled: true, devices: ['p.local'], probeSeconds: 3 }, { resolveFn: () => ({ v4: ['10.0.0.9'], v6: [] }), pingFn: () => false, nudgeFn: () => {}, ndpFn: () => '', now: clock });
  assert.deepEqual(gone, { home: false, how: 'no answer from p.local 10.0.0.9' });
  const { ndpReachable } = await import('../triggers/presence.mjs');
  const table = 'Neighbor Linklayer Address Netif Expire St Flgs Prbs\n2001:db8::5 aa:bb en0 18s S\nfe80::1c4b:f328:25af:3d82%en0 aa:bb en0 20s R\n';
  assert.equal(ndpReachable({ v6: ['2001:db8::5'], link: [] }, table), '');   // (stale is not proof)
  assert.equal(ndpReachable({ v6: [], link: ['1c4b:f328:25af:3d82'] }, table), 'fe80::1c4b:f328:25af:3d82');
  t = 0;
  assert.deepEqual(atHome({ enabled: true, devices: ['p.local'], probeSeconds: 3 }, { resolveFn: () => ({ v4: ['10.0.0.9'], v6: [], link: ['1c4b'] }), pingFn: () => false, nudgeFn: () => {}, ndpFn: () => 'fe80::1c4b', now: clock }),
    { home: true, how: 'p.local fe80::1c4b reachable (neighbor discovery)' });
  const off = atHome({ enabled: true, devices: ['p.local'] }, { resolveFn: () => ({ v4: [], v6: [], link: [] }), pingFn: () => true, nudgeFn: () => {}, ndpFn: () => '' });
  assert.deepEqual(off, { home: false, how: 'p.local not on this network' });
});

test('ring: nobody home means no ring (the guards before it still decide first); --force skips the check', () => {
  const cfg = cfgWith({ ring: { gapMinutes: 0 } }), opened = [], open = (u) => opened.push(u);   // (gap 0: earlier rings in this file do not hold these)
  const away = ring('x', { cfg, now: Date.now(), idle: 60 * min, open, home: () => ({ home: false, how: 'no answer from p.local' }) });
  assert.deepEqual(away, { rang: false, skipped: 'nobody home (no answer from p.local)' });
  let asked = 0;
  const atMac = ring('x', { cfg, now: Date.now(), idle: 0, open, home: () => { asked++; return { home: true }; } });
  assert.match(atMac.skipped, /at the Mac/); assert.equal(asked, 0);
  assert.equal(ring('x', { cfg, now: Date.now(), idle: 60 * min, open, home: () => ({ home: true, how: 'ok' }) }).rang, true);
  assert.equal(ring('x', { cfg, now: Date.now(), idle: 0, open, force: true, home: () => ({ home: false }) }).rang, true);
});
