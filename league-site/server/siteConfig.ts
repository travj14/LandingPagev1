import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolConfig } from './pool.ts';
import type { Model } from './sim.ts';

// data/site.config.json: site-wide defaults. Viewers can override the look
// (theme, apple, smoothScroll, glide, reveal) and model on their own device.
export interface SiteConfig {
  siteTitle: string;
  theme: string;
  apple: boolean;
  smoothScroll: boolean;
  glide: number; // 0–1 momentum strength
  reveal: boolean;
  model: Model;
  sampleSize: number;
  offseasonWeight: number;
  tradeDeadline: string | null; // ISO time, entered by hand
  rookieDraft: string | null; // ISO time, entered by hand
  pool: PoolConfig | null; // league pool investment, priced live
}

const DEFAULTS: SiteConfig = {
  siteTitle: 'League',
  theme: 'Midnight',
  apple: true,
  smoothScroll: true,
  glide: 0.45,
  reveal: true,
  model: 'coin',
  sampleSize: 8,
  offseasonWeight: 0.5,
  tradeDeadline: null,
  rookieDraft: null,
  pool: null,
};

const FILE = path.resolve(import.meta.dirname, '../data/site.config.json');
let cached: { at: number; value: SiteConfig } | null = null;

/** Site config, re-read at most every 10 s so edits apply without a restart. */
export async function siteConfig(): Promise<SiteConfig> {
  if (cached && Date.now() - cached.at < 10e3) return cached.value;
  let file: Partial<SiteConfig> = {};
  try {
    file = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Bad data/site.config.json:', err);
  }
  const value = { ...DEFAULTS, ...file };
  if (value.model !== 'coin' && value.model !== 'sample') value.model = 'coin';
  cached = { at: Date.now(), value };
  return value;
}
