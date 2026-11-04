import { get } from './sleeper.ts';

const QUOTE_TTL = 15 * 60e3;

export interface PoolConfig {
  ticker: string;
  buyPrice: number;
  invested: number;
  shares?: number | null; // override (e.g. after reinvested dividends); otherwise invested / buyPrice
}

/** Current value of the league pool, priced from Yahoo Finance. Null if not configured or unreachable. */
export async function poolValue(cfg: PoolConfig | null | undefined) {
  if (!cfg?.ticker || !cfg.buyPrice || !cfg.invested) return null;
  try {
    const q = await get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.ticker)}?range=1d&interval=1d`,
      QUOTE_TTL,
      (raw: any) => {
        const m = raw.chart.result[0].meta;
        return { price: m.regularMarketPrice as number, time: (m.regularMarketTime as number) * 1000 };
      },
    );
    const shares = cfg.shares || cfg.invested / cfg.buyPrice;
    const value = Math.round(shares * q.price * 100) / 100;
    return {
      ticker: cfg.ticker,
      price: q.price,
      priceTime: q.time,
      buyPrice: cfg.buyPrice,
      shares: Math.round(shares * 1e6) / 1e6,
      invested: cfg.invested,
      value,
      change: Math.round((value - cfg.invested) * 100) / 100,
      pct: Math.round(((value - cfg.invested) / cfg.invested) * 10000) / 100,
    };
  } catch {
    return null;
  }
}
