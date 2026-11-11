#!/usr/bin/env node
// Is anyone home? Wake rings to wake someone up, and when you have left, your phone has left with you. So before a ring the
// trigger looks for your phone on the Mac's network: it resolves the phone's Bonjour name, nudges it (a sleeping iPhone's
// Wi-Fi wakes for a packet to port 5353, the trick Home Assistant's iPhone presence checks use), and pings it for a few
// seconds. No answer from any listed device means nobody is home, so no ring. The message still goes on your list.
//   node triggers/presence.mjs            check now: {"home":true,"how":"moonshot.local 192.168.0.115 answered"}
//   node triggers/presence.mjs find       list iPhones/iPads advertising on this network, to pick a name for config
// Config: "presence": { "enabled": true, "devices": ["Your-iPhone.local"], "probeSeconds": 8 }
// The phone's Bonjour name is usually its device name with spaces as dashes, plus .local; `find` lists the ones around.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const sh = (cmd, args, timeout = 4000) => spawnSync(cmd, args, { encoding: 'utf8', timeout });

/** A host's addresses from the system resolver (mDNS for .local): { v4: [...], v6: [...] }. */
export function resolve(host, out = sh('/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', host]).stdout ?? '') {
  const v4 = [...out.matchAll(/^ip_address: (\S+)/gm)].map((m) => m[1]);
  const all6 = [...out.matchAll(/^ipv6_address: (\S+)/gm)].map((m) => m[1].toLowerCase());
  const v6 = all6.filter((a) => !a.startsWith('fe80')), link = all6.filter((a) => a.startsWith('fe80')).map((a) => a.split('::').pop());
  return { v4, v6, link };
}

/** Does the IPv6 neighbor table hold any of these addresses as reachable (state R, confirmed within the last ~30 s)? A dozing
 *  iPhone that ignores ping still answers neighbor discovery, so after a nudge this catches it. `link` holds link-local
 *  interface ids (the part after fe80::), matched on any interface. */
export function ndpReachable({ v6 = [], link = [] }, out = sh('/usr/sbin/ndp', ['-an'], 3000).stdout ?? '') {
  for (const line of out.split('\n')) {
    const [addr, , , , st] = line.trim().split(/\s+/);
    if (st !== 'R' || !addr) continue;
    const a = addr.toLowerCase().split('%')[0];
    if (v6.includes(a) || (a.startsWith('fe80') && link.some((id) => a.endsWith(`:${id}`)))) return a;
  }
  return '';
}

/** Wake a dozing phone's Wi-Fi with one UDP packet to its mDNS port. */
function nudge(ip, v6) { sh('/usr/bin/nc', ['-u', '-z', '-w', '1', ...(v6 ? ['-6'] : []), ip, '5353'], 2500); }

/** One ping with a 1 s wait. */
export function ping(ip, v6 = ip.includes(':')) {
  const r = v6 ? sh('/sbin/ping6', ['-c', '1', '-i', '1', ip], 2500) : sh('/sbin/ping', ['-c', '1', '-t', '1', ip], 2500);
  return r.status === 0;
}

/** { home: true|false, how } for the configured devices. home is true when presence is off or no device is set. */
export function atHome(presence, { resolveFn = resolve, pingFn = ping, nudgeFn = nudge, ndpFn = ndpReachable, now = Date.now } = {}) {
  if (!presence?.enabled || !presence.devices?.length) return { home: true, how: 'presence check off' };
  const end = now() + (presence.probeSeconds ?? 8) * 1000, tried = [];
  const targets = presence.devices.map((host) => ({ host, ...resolveFn(host) }));
  for (let round = 0; round === 0 || now() < end; round++) {
    for (const t of targets) {
      for (const ip of [...t.v4, ...t.v6]) {
        if (round === 0) nudgeFn(ip, ip.includes(':'));
        if (pingFn(ip)) return { home: true, how: `${t.host} ${ip} answered` };
        if (round === 0) tried.push(`${t.host} ${ip}`);
      }
      const n = ndpFn(t);
      if (n) return { home: true, how: `${t.host} ${n} reachable (neighbor discovery)` };
    }
    if (!targets.some((t) => t.v4.length || t.v6.length)) break;   // (no address at all: the phone is not on this network)
  }
  return { home: false, how: tried.length ? `no answer from ${tried.join(', ')}` : `${presence.devices.join(', ')} not on this network` };
}

/** Phones and tablets advertising Apple's remote-pairing service here, as Bonjour host names. */
export function find() {
  const browse = sh('/usr/bin/dns-sd', ['-B', '_remotepairing._tcp'], 4000).stdout ?? '';
  const names = [...new Set([...browse.matchAll(/Add\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s*$/gm)].map((m) => m[1]))];
  const hosts = [];
  for (const n of names) {
    const r = sh('/usr/bin/dns-sd', ['-L', n, '_remotepairing._tcp', 'local'], 3000).stdout ?? '';
    const m = r.match(/can be reached at (\S+?)\.?:\d+/);
    if (m) hosts.push(m[1]);
  }
  return [...new Set(hosts)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'find') console.log(find().join('\n') || 'none found');
  else { const cfg = loadConfig(); console.log(JSON.stringify(atHome({ ...cfg.presence, enabled: true }))); }
}
