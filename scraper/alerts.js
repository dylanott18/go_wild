// Push alerts through ntfy (https://ntfy.sh): free, no account. Install the
// ntfy app, subscribe to your topic, and you get a phone notification when
// GoWild seats open, run low or sell out on a watched route.
//
// The topic name works like a password, so keep it in the NTFY_TOPIC repo
// secret rather than in config.json (the repo is public).

import { matchesWatch } from '../web/lib/planner.js';
import { fmtClock } from '../web/lib/time.js';

const LABEL = { opened: 'GoWild open', low: 'Almost gone', soldout: 'Sold out' };

export function buildAlerts(events, rules = []) {
  const out = [];
  for (const rule of rules) {
    const kinds = rule.notify ?? ['opened', 'low'];
    const hits = events.filter((e) => kinds.includes(e.type) && matchesWatch(rule, e.it, e.date));
    if (!hits.length) continue;
    hits.sort((a, b) => (a.it.dep < b.it.dep ? -1 : 1));
    const lines = hits.slice(0, 12).map((e) => {
      const it = e.it;
      const seats = e.type === 'soldout' ? '' : it.gws != null ? ` · ${it.gws} left` : '';
      const fare = it.gw != null ? ` $${it.gw.toFixed(2)}` : '';
      return `${LABEL[e.type]}: ${it.o}→${it.d} ${e.date.slice(5)} ${fmtClock(it.dep)}${it.st ? ` (${it.st} stop)` : ''}${fare}${seats}`;
    });
    if (hits.length > 12) lines.push(`…and ${hits.length - 12} more`);
    const opened = hits.some((e) => e.type === 'opened');
    out.push({
      title: rule.name ?? `${rule.from ?? '*'} to ${rule.to ?? '*'}`,
      message: lines.join('\n'),
      priority: opened ? 4 : 3,
      tags: opened ? 'airplane,green_circle' : 'airplane',
      first: hits[0],
    });
  }
  return out;
}

export async function sendAlerts(alerts, { topic, server = 'https://ntfy.sh', siteUrl = '' } = {}) {
  if (!topic || !alerts.length) return 0;
  let sent = 0;
  for (const a of alerts) {
    const click = siteUrl ? `${siteUrl}#o=${a.first.it.o}&m=from&d=${a.first.date}` : undefined;
    try {
      const res = await fetch(`${(server || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          Title: a.title.replace(/[^\x20-\x7E]/g, '-'),
          Priority: String(a.priority),
          Tags: a.tags,
          ...(click ? { Click: click } : {}),
        },
        body: a.message,
      });
      if (res.ok) sent++;
      else console.log(`ntfy responded ${res.status}`);
    } catch (e) {
      console.log(`ntfy failed: ${e.message}`);
    }
  }
  return sent;
}
