export const LEAGUE_ID = process.env.LEAGUE_ID ?? '1311995439410581504';
export const PORT = Number(process.env.PORT ?? 3457);

// Playoff odds Monte Carlo runs.
export const SIM_COUNT = 10_000;

// Sleeper username (lowercased) -> real name. See important_info.md.
export const OWNER_NAMES: Record<string, string> = {
  travj14: 'Travis',
  drocks: 'Derek',
  drocks02: 'Derek',
  henrick69: 'Henry',
  yajatnarayn: 'Yajat',
  yajatnarayan: 'Yajat',
  walljumpersunit: 'Antonio',
  '49erskittle': 'Josh',
  xx49erskittlexx: 'Josh',
  fartsniffer3billion: 'Caden',
};
