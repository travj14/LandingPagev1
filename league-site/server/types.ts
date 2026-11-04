// Subset of the Sleeper API response shapes that we actually use.

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: 'pre_draft' | 'drafting' | 'in_season' | 'post_season' | 'complete' | string;
  scoring_settings?: Record<string, number>;
  previous_league_id: string | null;
  total_rosters: number;
  roster_positions: string[];
  settings: Record<string, number>;
}

export interface SleeperUser {
  user_id: string;
  display_name: string;
  avatar: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  custom_points: number | null;
  players: string[] | null;
  starters: string[] | null;
  starters_points: number[] | null;
  players_points: Record<string, number> | null;
}

export interface SleeperDraftPick {
  season: string;
  round: number;
  roster_id: number; // original owner
  owner_id: number; // current owner
  previous_owner_id: number;
}

export interface SleeperTransaction {
  transaction_id: string;
  type: 'trade' | 'waiver' | 'free_agent' | 'commissioner' | string;
  status: string;
  leg: number;
  created: number;
  status_updated: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: SleeperDraftPick[];
  waiver_budget: { sender: number; receiver: number; amount: number }[];
  settings?: { waiver_bid?: number } | null;
}

export interface SleeperBracketMatch {
  r: number; // round
  m: number; // match id
  t1: number | null; // roster ids
  t2: number | null;
  w: number | null; // winner roster id
  l: number | null;
  p?: number; // placement decided: 1 = championship, 3 = third place, ...
}

export interface SleeperState {
  week: number;
  display_week: number;
  season: string;
  season_type: string;
}

export interface PlayerInfo {
  name: string;
  pos: string;
  positions: string[];
  team: string | null;
}
