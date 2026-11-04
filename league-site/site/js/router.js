// Hash routes: #home, #standings?p=9-1:henry, #teams/henry ...
export const ROUTES = ['home', 'standings', 'matchups', 'teams', 'history'];

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, query = ''] = raw.split('?');
  const [name, ...args] = path.split('/');
  return { name: ROUTES.includes(name) ? name : 'home', args: args.map(decodeURIComponent), query: new URLSearchParams(query) };
}

/** Update the URL's query without re-rendering (e.g. what-if picks). */
export function setQuery(params) {
  const { name, args } = parseHash();
  const q = new URLSearchParams(params).toString();
  history.replaceState(null, '', `#${[name, ...args].join('/')}${q ? `?${q}` : ''}`);
}
