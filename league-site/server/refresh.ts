import { timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import { refreshHistory } from './history.ts';

/** The nightly refresh runs at midnight in this time zone. */
export const REFRESH_TZ = process.env.REFRESH_TZ ?? 'America/New_York';
const TOKEN = process.env.REFRESH_TOKEN ?? '';

const status = {
  running: false,
  trigger: null as 'nightly' | 'manual' | null,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  seconds: null as number | null,
  seasons: null as number[] | null,
  error: null as string | null,
};

const listeners: (() => unknown)[] = [];
/** Run `fn` after every successful full refresh (e.g. to warm caches). */
export const onRefreshed = (fn: () => unknown) => listeners.push(fn);

/** Full history refresh with status tracking. Overlapping calls share the one in progress. */
export async function runRefresh(trigger: 'nightly' | 'manual') {
  if (!status.running) {
    Object.assign(status, { running: true, trigger, startedAt: new Date().toISOString(), error: null });
    console.log(`[refresh] ${trigger} refresh started`);
  }
  const t0 = Date.now();
  try {
    const h = await refreshHistory();
    if (status.running) {
      Object.assign(status, { seasons: h.seasons.map((s) => s.season), seconds: Math.round((Date.now() - t0) / 100) / 10 });
      console.log(`[refresh] done in ${status.seconds}s (${status.seasons?.join(', ')})`);
    }
    for (const fn of listeners) await fn();
  } catch (err) {
    status.error = (err as Error).message;
    console.error('[refresh] failed:', err);
  } finally {
    if (status.running) Object.assign(status, { running: false, finishedAt: new Date().toISOString() });
  }
  return { ...status };
}

const dayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

/** Refresh everything once each night, when the date rolls over in REFRESH_TZ. */
export function scheduleNightlyRefresh() {
  let day = dayIn(REFRESH_TZ);
  const timer = setInterval(() => {
    const now = dayIn(REFRESH_TZ);
    if (now === day) return;
    day = now;
    void runRefresh('nightly');
  }, 60e3);
  timer.unref();
}

function tokenMatches(header: string | undefined) {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * GET  /api/admin/refresh          → status of the last refresh
 * POST /api/admin/refresh          → start a full refresh (202, runs in background)
 * POST /api/admin/refresh?wait=1   → start one and respond when it finishes
 *
 * With REFRESH_TOKEN set, requests need `Authorization: Bearer <token>`. Without
 * it, only requests from this machine are allowed. The public site must set a
 * token: behind nginx every request arrives from loopback.
 */
export function registerRefreshRoutes(app: Express, { requireToken = false } = {}) {
  if (requireToken && !TOKEN) {
    console.warn('[refresh] REFRESH_TOKEN is not set, so the manual refresh endpoint is disabled.');
  }
  const allowed = (req: Request) => (TOKEN ? tokenMatches(req.get('authorization')) : !requireToken && LOOPBACK.has(req.socket.remoteAddress ?? ''));

  app.get('/api/admin/refresh', (req, res) => {
    if (!allowed(req)) {
      res.status(401).json({ error: 'Not allowed.' });
      return;
    }
    res.json({ ...status, timeZone: REFRESH_TZ });
  });

  app.post('/api/admin/refresh', async (req, res) => {
    if (!allowed(req)) {
      res.status(401).json({ error: 'Not allowed.' });
      return;
    }
    const done = runRefresh('manual');
    if (req.query.wait) {
      res.json(await done);
      return;
    }
    res.status(202).json({ ...status, timeZone: REFRESH_TZ });
  });
}
