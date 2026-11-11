// Settings for the triggers, read from ~/.config/wake/config.json (or $WAKE_CONFIG). Every key is optional; missing keys take
// the defaults below. See config.example.json and the README's "Customize" section.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = process.env.WAKE_CONFIG || path.join(os.homedir(), '.config/wake/config.json');
export const STATE_DIR = process.env.WAKE_STATE_DIR || path.join(os.homedir(), '.local/state/wake');

export const DEFAULTS = {
  // Which apps' notifications count, by bundle id -> the name shown on the alarm and in the task title.
  // Find an app's id with: osascript -e 'id of app "Slack"'
  apps: { 'com.tencent.xinWeChat': 'WeChat' },
  // Per-chat names. Keys are WeChat chat ids (wxid_..., NNN@chatroom) or, for other apps, the notification title.
  // A name of "-" mutes that chat (never rings, never makes a task). `node triggers/notify-watch.mjs peek` lists ids.
  names: {},
  // "all": every chat rings. "named": only chats listed in `names` ring (everything else is ignored).
  ringFor: 'all',
  // Keep the notification's text in the task notes: "all", "named" (only for named chats), or "none".
  saveText: 'all',
  ring: {
    enabled: true,
    problems: 2,          // math problems to stop it (1-10)
    gapMinutes: 10,       // at most one ring per this many minutes
    awayMinutes: 15,      // ring only when the Mac has had no keyboard/mouse input this long (0 = always ring)
    quietHours: null,     // e.g. { "from": "09:00", "to": "23:00" } = never ring between these local times
  },
  superProductivity: {
    enabled: true,
    url: 'http://127.0.0.1:3876',
    projectId: 'INBOX_PROJECT',   // or a project's id from GET /projects
    tokenFile: path.join(os.homedir(), 'Library/Application Support/superProductivity/local-rest-api-token'),
  },
  pollSeconds: 5,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(file = CONFIG_PATH) {
  let user = {};
  try { user = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`); }
  const cfg = merge(DEFAULTS, user);
  if (user.apps) cfg.apps = user.apps;   // (a user's app list replaces the default one, it does not add to it)
  // Bundle ids are matched case-insensitively (macOS logs WeChat as com.tencent.xinwechat).
  cfg.apps = Object.fromEntries(Object.entries(cfg.apps).map(([k, v]) => [k.toLowerCase(), v]));
  return cfg;
}
