// `npm run refresh`: force a full history refresh.
// Asks the running server to do it (so its in-memory data updates too). If no
// server is running, refreshes the disk cache directly so the next start is fresh.
import { PORT } from './config.ts';
import { refreshHistory } from './history.ts';

const url = `${process.env.REFRESH_URL ?? `http://localhost:${PORT}`}/api/admin/refresh?wait=1`;
const token = process.env.REFRESH_TOKEN;

let res: Response | null = null;
try {
  res = await fetch(url, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
} catch {
  // Server not running.
}

if (res) {
  const body = (await res.json()) as { error?: string | null; seconds?: number; seasons?: number[] };
  if (!res.ok || body.error) {
    console.error(`Refresh failed: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  console.log(`Server refreshed in ${body.seconds}s (seasons ${body.seasons?.join(', ')}).`);
} else {
  console.log(`No server at ${url}, refreshing the cache directly…`);
  const t0 = Date.now();
  const h = await refreshHistory();
  console.log(`Cache refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s (seasons ${h.seasons.map((s) => s.season).join(', ')}).`);
}
