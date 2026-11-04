import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlayerInfo } from './types.ts';

const BASE = 'https://api.sleeper.app/v1';
const CACHE_DIR = path.resolve(import.meta.dirname, '../data/cache');

const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

// Cache entries written before this moment are stale whatever their TTL.
// A forced refresh moves it to "now", so even finished seasons are re-fetched.
let staleBefore = 0;

/** Treat everything cached so far as stale. The next reads re-fetch from Sleeper. */
export function invalidateCache() {
  staleBefore = Date.now();
  mem.clear();
}

function fresh(at: number, ttlMs: number) {
  return at >= staleBefore && (ttlMs === Infinity || Date.now() - at < ttlMs);
}

async function readCache(file: string) {
  try {
    const stat = await fs.stat(file);
    return { at: stat.mtimeMs, value: JSON.parse(await fs.readFile(file, 'utf8')) as unknown };
  } catch {
    return null;
  }
}

async function writeCache(file: string, value: unknown) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

/**
 * GET a Sleeper endpoint with a memory + disk cache. Completed data can use
 * ttl=Infinity. If Sleeper is unreachable, falls back to stale cache.
 */
export async function get<T>(endpoint: string, ttlMs: number, transform?: (raw: any) => T): Promise<T> {
  const key = endpoint.replace(/[^a-z0-9]+/gi, '_').replace(/^_/, '') + (transform ? '_slim' : '');
  const hit = mem.get(key);
  if (hit && fresh(hit.at, ttlMs)) return hit.value as T;

  // Concurrent loads of the same endpoint share one request.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = load<T>(key, endpoint, ttlMs, transform).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function load<T>(key: string, endpoint: string, ttlMs: number, transform?: (raw: any) => T): Promise<T> {
  const file = path.join(CACHE_DIR, `${key}.json`);
  const disk = await readCache(file);
  if (disk && fresh(disk.at, ttlMs)) {
    mem.set(key, disk);
    return disk.value as T;
  }

  try {
    const res = await fetch(endpoint.startsWith('http') ? endpoint : BASE + endpoint);
    if (!res.ok) throw new Error(`Sleeper ${endpoint} -> HTTP ${res.status}`);
    const raw = await res.json();
    const value = transform ? transform(raw) : raw;
    mem.set(key, { at: Date.now(), value });
    await writeCache(file, value);
    return value as T;
  } catch (err) {
    if (disk) return disk.value as T;
    throw err;
  }
}

// Per-player weekly stat lines we keep (the full response is ~1MB per week).
export const STAT_KEYS = [
  'pass_yd', 'pass_td', 'pass_int', 'pass_sack', 'pass_td_lng',
  'rush_yd', 'rush_td', 'rush_att', 'rush_td_lng', 'rush_40p',
  'rec', 'rec_yd', 'rec_td', 'rec_tgt', 'rec_drop', 'rec_td_lng', 'rec_40p',
  'fum_lost',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatLine = Partial<Record<StatKey, number>>;

export function getWeekStats(season: number, week: number, ttlMs: number) {
  return get<Record<string, StatLine>>(`/stats/nfl/regular/${season}/${week}`, ttlMs, (raw: Record<string, Record<string, number>>) => {
    const out: Record<string, StatLine> = {};
    for (const [pid, line] of Object.entries(raw ?? {})) {
      const slim: StatLine = {};
      for (const k of STAT_KEYS) if (line[k]) slim[k] = line[k];
      if (Object.keys(slim).length) out[pid] = slim;
    }
    return out;
  });
}

const PROJ_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position%5B%5D=${p}`).join('&');

/**
 * Sleeper's projected points per player for a week, scored with the league's own settings.
 * For past weeks this is each player's last projection before kickoff.
 */
export function getWeekProjections(season: number, week: number, leagueId: string, scoring: Record<string, number>, ttlMs: number) {
  // leagueId in the URL only keys the cache to this league's scoring; Sleeper ignores it.
  const url = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${PROJ_POSITIONS}&league=${leagueId}`;
  return get<Record<string, number>>(url, ttlMs, (raw: { player_id: string; stats?: Record<string, number> }[]) => {
    const out: Record<string, number> = {};
    for (const p of raw ?? []) {
      let pts = 0;
      for (const [k, v] of Object.entries(p.stats ?? {})) if (scoring[k] != null) pts += v * scoring[k];
      if (pts) out[p.player_id] = Math.round(pts * 1e4) / 1e4; // keep precision; team totals are rounded once
    }
    return out;
  });
}

/** Sleeper's full player DB is ~10MB, so we keep a slim copy refreshed daily. */
export async function getPlayers(): Promise<Record<string, PlayerInfo>> {
  const key = 'players_slim';
  const ttl = 24 * 3600e3;
  const hit = mem.get(key);
  if (hit && fresh(hit.at, ttl)) return hit.value as Record<string, PlayerInfo>;

  const file = path.join(CACHE_DIR, `${key}.json`);
  const disk = await readCache(file);
  if (disk && fresh(disk.at, ttl)) {
    mem.set(key, disk);
    return disk.value as Record<string, PlayerInfo>;
  }

  try {
    const res = await fetch(`${BASE}/players/nfl`);
    if (!res.ok) throw new Error(`Sleeper /players/nfl -> HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, any>;
    const slim: Record<string, PlayerInfo> = {};
    for (const [id, p] of Object.entries(raw)) {
      const pos = p.position ?? '';
      slim[id] = {
        name: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? id,
        pos,
        positions: p.fantasy_positions?.length ? p.fantasy_positions : [pos],
        team: p.team ?? null,
      };
    }
    mem.set(key, { at: Date.now(), value: slim });
    await writeCache(file, slim);
    return slim;
  } catch (err) {
    if (disk) return disk.value as Record<string, PlayerInfo>;
    throw err;
  }
}
