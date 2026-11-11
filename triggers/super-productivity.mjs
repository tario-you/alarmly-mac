// Super Productivity (https://github.com/super-productivity/super-productivity) through its Local REST API.
// Turn it on in the desktop app: Settings -> Misc -> Local REST API. The app writes its token to
// ~/Library/Application Support/superProductivity/local-rest-api-token; it is read at each call and never printed.
import { readFileSync } from 'node:fs';

/** call(method, route, body) -> data, or throws. Loopback only, so no proxy sees the token. */
export function client(sp, { fetchFn = fetch } = {}) {
  return async (method, route, body) => {
    const token = readFileSync(sp.tokenFile, 'utf8').trim();
    const r = await fetchFn(sp.url + route, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const v = await r.json().catch(() => null);
    if (!v?.ok) throw new Error(`${method} ${route}: ${v?.error?.code ?? r.status}`);
    return v.data;
  };
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** One open task per chat: the first message makes it, later ones update its count and append to its notes, and once you tick
 *  it done the next message makes a new one. `tasks` is { [chatKey]: { id, n, first, notes } }, kept in the watcher's state.
 *  -> the names whose task was made or changed. */
export async function upsertTasks(items, tasks, { call, projectId = 'INBOX_PROJECT' }) {
  const groups = new Map();
  for (const it of items) { const k = it.key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const out = [];
  for (const [k, its] of groups) {
    let e = tasks[k];
    if (e?.id) { const t = await call('GET', `/tasks/${e.id}`).catch(() => null); if (!t || t.isDone) e = null; }
    const last = its.at(-1), n = (e?.n ?? 0) + its.length, first = e?.first ?? its[0].at;
    const title = `${day(first)}: ${last.name} wrote on ${last.app}, ${n} new since ${hhmm(first)}`;
    const lines = its.map((it) => `${hhmm(it.at)} ${it.text ?? ''}`.trim());
    const notes = [e?.notes, ...lines].filter(Boolean).join('\n').slice(-4000);
    if (e?.id) await call('PATCH', `/tasks/${e.id}`, { title, notes, isIgnoreShortSyntax: true });
    else e = { id: (await call('POST', '/tasks', { title, notes, isIgnoreShortSyntax: true, projectId })).id };
    tasks[k] = { id: e.id, n, first, notes };
    out.push(last.name);
  }
  return out;
}
