// Fetch helper: shows the last saved response instantly, then the fresh one.

const PREFIX = 'blu-site-cache:';

function readCache(url) {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + url) || 'null');
  } catch {
    return null;
  }
}

function writeCache(url, data) {
  try {
    localStorage.setItem(PREFIX + url, JSON.stringify(data));
  } catch {
    // Storage full or blocked: drop older cached pages and carry on without caching.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    } catch {}
  }
}

// Tells the shell whether we're showing live or saved data (offline banner).
const signal = (online) => window.dispatchEvent(new CustomEvent('blu:net', { detail: { online } }));

export async function getJSON(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    signal(false);
    throw Object.assign(new Error("Can't reach the server. Check your connection."), { offline: true });
  }
  signal(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/**
 * Calls render(data) with the cached copy (if any) and again with the fresh one
 * when it differs. Resolves with the fresh data.
 */
export async function load(url, render, { cache = true } = {}) {
  const cached = cache ? readCache(url) : null;
  if (cached) render(cached, { stale: true });
  try {
    const fresh = await getJSON(url);
    if (cache) writeCache(url, fresh);
    if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) render(fresh, { stale: false });
    return fresh;
  } catch (err) {
    if (!cached) throw err;
    return cached; // offline: keep showing the saved copy
  }
}
