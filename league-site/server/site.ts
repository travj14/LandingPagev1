import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PORT } from './config.ts';
import { context, draft, home, meta, oddsHistory, parseModel, parsePicks, standings, whatIf } from './api.ts';
import { loadHistory, refreshState } from './history.ts';
import { historyPage, recordBook, weekMilestones } from './archive.ts';
import { h2hGrid, rivalry, weekList, weekPage } from './matchups.ts';
import { teamPage, teamsIndex } from './teams.ts';
import { onRefreshed, registerRefreshRoutes, scheduleNightlyRefresh } from './refresh.ts';
import { registerProjectionRoutes, startProjections } from './projections.ts';

// Public, read-only league site. Nothing here writes files except the Sleeper cache.
const app = express();
app.disable('x-powered-by');
app.use(compression());

// Uptime check for nginx / monitoring: 200 once history has loaded, 503 before.
const started = Date.now();
let ready = false;
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({ ok: ready, uptime: Math.round((Date.now() - started) / 1000), ...refreshState() });
});

// The page itself, with link-preview URLs made absolute. SITE_URL wins; otherwise the request's own host
// (behind nginx, X-Forwarded-Proto/Host from the local proxy are trusted).
const SITE_DIR = path.resolve(import.meta.dirname, '../site');
app.set('trust proxy', 'loopback');
const page = (file: string) => async (req: Request, res: Response) => {
  const origin = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const html = (await fs.readFile(path.join(SITE_DIR, file), 'utf8')).replaceAll('%ORIGIN%', origin);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
};
app.get(['/', '/index.html'], page('index.html'));
// payrollgm.com/projections: live matchup projections for BLU and El Diablo (server/projections.ts).
app.get(['/projections', '/projections/'], page('projections.html'));

// Static files revalidate every load (cheap 304s) so a deploy shows up right away; images can sit for a day.
app.use(
  express.static(SITE_DIR, {
    index: false,
    setHeaders: (res, file) => res.setHeader('Cache-Control', /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(file) ? 'public, max-age=86400' : 'no-cache'),
  }),
);

const api = (fn: (c: Awaited<ReturnType<typeof context>>, req: Request) => unknown) => async (req: Request, res: Response) => {
  const c = await context(await loadHistory());
  res.set('Cache-Control', 'no-cache');
  res.json(await fn(c, req));
};

app.get('/api/site/meta', api((c) => meta(c)));
app.get('/api/site/home', api(async (c, req) => ({ ...(await home(c, parseModel(req.query.model, c))), weekMilestones: weekMilestones(c) })));
app.get('/api/site/standings', api((c, req) => standings(c, parseModel(req.query.model, c))));
app.get('/api/site/whatif', api((c, req) => whatIf(c, parseModel(req.query.model, c), parsePicks(c, req.query.picks))));
app.get('/api/site/odds-history', api((c, req) => oddsHistory(c, parseModel(req.query.model, c))));
app.get('/api/site/draft', api((c, req) => draft(c, parseModel(req.query.model, c))));
app.get('/api/site/teams', api((c, req) => teamsIndex(c, parseModel(req.query.model, c))));
app.get('/api/site/team/:slug', async (req, res) => {
  const c = await context(await loadHistory());
  const page = teamPage(c, String(req.params.slug), parseModel(req.query.model, c));
  if (!page) {
    res.status(404).json({ error: 'No team by that name.' });
    return;
  }
  res.set('Cache-Control', 'no-cache').json(page);
});
app.get('/api/site/weeks', api((c) => weekList(c)));
const orNotFound = (res: Response, body: unknown, msg: string) => {
  if (!body) {
    res.status(404).json({ error: msg });
    return;
  }
  res.set('Cache-Control', 'no-cache').json(body);
};
app.get('/api/site/week/:season/:week', async (req, res) => {
  const c = await context(await loadHistory());
  orNotFound(res, weekPage(c, Number(req.params.season), Number(req.params.week)), 'No games that week.');
});
app.get('/api/site/h2h', api((c) => h2hGrid(c)));
app.get('/api/site/rivalry/:a/:b', async (req, res) => {
  const c = await context(await loadHistory());
  orNotFound(res, rivalry(c, String(req.params.a), String(req.params.b)), 'Unknown teams.');
});
app.get('/api/site/records', api((c) => recordBook(c)));
app.get('/api/site/history', api((c) => historyPage(c)));
registerProjectionRoutes(app);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// In production the refresh endpoint needs REFRESH_TOKEN: behind nginx every request looks local.
registerRefreshRoutes(app, { requireToken: process.env.NODE_ENV === 'production' });
scheduleNightlyRefresh();

/** Build the expensive pages ahead of time so the first visitor after a start or refresh doesn't wait. */
async function warm() {
  const t0 = Date.now();
  const c = await context(await loadHistory());
  ready = true;
  for (const model of ['coin', 'sample'] as const) {
    await home(c, model);
    await standings(c, model);
    await oddsHistory(c, model);
    await draft(c, model);
  }
  recordBook(c);
  await historyPage(c);
  h2hGrid(c);
  console.log(`Caches warm in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
onRefreshed(() => warm().catch((err) => console.error('Warm-up failed:', err)));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`League site running at http://localhost:${PORT}`);
  warm().catch((err) => console.error('Initial warm-up failed:', err));
  startProjections();
});
