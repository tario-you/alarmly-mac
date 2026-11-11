#!/usr/bin/env node
// Ring Wake now, through its URL trigger (wake://ring?label=...&problems=N), with the guards from config.ring:
// at most one ring per gapMinutes, only while you are away from the Mac (no input for awayMinutes), never in quietHours.
//   node triggers/wake-ring.mjs ring "WeChat: Alice" [--force] [--dry-run]
//   node triggers/wake-ring.mjs why      (would it ring right now, and if not, why)
// State: ~/.local/state/wake/ring.json { last, label }
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, STATE_DIR } from './config.mjs';

const STATE = path.join(STATE_DIR, 'ring.json');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Milliseconds since the last keyboard or mouse input, from the HID system's idle clock (ns). */
export function idleMs(ioreg = run('ioreg', ['-c', 'IOHIDSystem'])) {
  const m = ioreg.match(/"HIDIdleTime" = (\d+)/);
  return m ? Number(BigInt(m[1]) / 1000000n) : 0;
}

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
/** Is local time `d` inside { from, to } (which may wrap past midnight)? */
export function inQuietHours(q, d = new Date()) {
  if (!q?.from || !q?.to) return false;
  const t = d.getHours() * 60 + d.getMinutes(), a = minutesOf(q.from), b = minutesOf(q.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Why it does not ring now, or '' when it does. */
export function holdReason({ now, last, idle, ring, date = new Date(now) }) {
  if (!ring.enabled) return 'ringing is off (ring.enabled)';
  if (inQuietHours(ring.quietHours, date)) return `quiet hours ${ring.quietHours.from}-${ring.quietHours.to}`;
  if (last && now - last < ring.gapMinutes * 60e3) return `rang ${Math.round((now - last) / 60e3)} min ago`;
  if (ring.awayMinutes > 0 && idle < ring.awayMinutes * 60e3) return `you are at the Mac (input ${Math.round(idle / 60e3)} min ago)`;
  return '';
}

export function ringUrl(label, problems) {
  return `wake://ring?label=${encodeURIComponent(String(label).slice(0, 80))}&problems=${Math.min(10, Math.max(1, problems | 0))}`;
}

export function ring(label, { cfg = loadConfig(), now = Date.now(), dryRun = false, force = false, idle, open = (u) => run('open', ['-g', u]) } = {}) {
  let st = {}; try { st = JSON.parse(readFileSync(STATE, 'utf8')); } catch {}
  const hold = force ? '' : holdReason({ now, last: st.last, idle: idle ?? idleMs(), ring: cfg.ring });
  if (hold) return { rang: false, skipped: hold };
  const url = ringUrl(label, cfg.ring.problems);
  if (dryRun) return { rang: false, dryRun: true, url };
  open(url);
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, JSON.stringify({ last: now, label }), { mode: 0o600 });
  return { rang: true, url };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, label] = process.argv.slice(2), flag = (f) => process.argv.includes(f);
  if (cmd === 'ring') console.log(JSON.stringify(ring(label || 'Wake up', { dryRun: flag('--dry-run'), force: flag('--force') })));
  else if (cmd === 'why') console.log(JSON.stringify(ring('check', { dryRun: true })));
  else { console.error('usage: wake-ring.mjs ring "LABEL" [--force] [--dry-run] | why'); process.exitCode = 2; }
}
