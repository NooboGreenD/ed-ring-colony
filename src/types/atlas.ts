export type WorldType =
  | 'earth_like' | 'water_world' | 'ammonia' | 'terraformable'
  | 'neutron_star' | 'black_hole' | 'white_dwarf' | 'wolf_rayet'
  | 'herbig_ae_be' | 't_tauri' | 'proto_star' | 'carbon_star'
  | 'supergiant' | 'giant'
  | 'rocky_atmosphere' | 'rocky_bio';

export interface AtlasSearchParams {
  reference_system: string;
  cube_size_ly: number;
  world_types: WorldType[];
  require_landable?: boolean;
  min_estimated_value?: number;
  max_distance_to_arrival?: number;
}

export interface AtlasCandidate {
  id: string;
  search_id: string;
  system_name: string;
  x: number; y: number; z: number;
  edsm_id?: number; id64?: number;
  world_type: WorldType;
  body_name?: string;
  distance_from_ref: number;
  distance_to_arrival?: number;
  estimated_value?: number;
  is_main_star?: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface AtlasSearchSession {
  id: string;
  reference_system: string;
  reference_x?: number; reference_y?: number; reference_z?: number;
  cube_size_ly: number;
  world_types: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  completed_at?: string;
}

export interface SpanshSystem {
  name: string; id64?: number; x?: number; y?: number; z?: number;
  bodies?: SpanshBody[];
  allegiance?: string; government?: string; population?: number;
  primary_star?: { type: string; name: string; is_scoopable: boolean };
}

export interface SpanshBody {
  name: string; id64?: number; type: string; subtype?: string;
  distance_to_arrival?: number;
  estimated_mapping_value?: number; estimated_scan_value?: number;
  is_main_star?: boolean; is_terraformable?: boolean;
  gravity?: number; temperature?: number; atmosphere?: string; volcanism?: string;
  landmarks?: string[]; materials?: Record<string, number>;
  rings?: Array<{ name: string; type: string; mass?: number; inner_radius?: number; outer_radius?: number }>;
}

export interface SpanshBodiesSearchResult {
  count: number; from: number; size: number;
  reference?: { id64: number; name: string; x: number; y: number; z: number };
  results: SpanshBody[];
}

export interface EDSMSystem {
  name: string; id?: number; coords?: { x: number; y: number; z: number }; distance?: number;
  information?: { allegiance?: string; government?: string; faction?: string; factionState?: string; population?: number; security?: string; economy?: string };
  primaryStar?: { type: string; name: string; isScoopable: boolean };
}

export interface RouteWaypoint {
  system_name: string; x: number; y: number; z: number;
  distance_from_prev: number; cumulative_distance: number; estimated_jumps?: number;
}

export interface AtlasRoute {
  id: string; name: string; from_system: string; to_system: string;
  engine: 'greedy' | 'weighted_astar' | 'neutron';
  jump_range: number; waypoints: RouteWaypoint[];
  total_distance_ly: number; estimated_jumps: number; created_at: string;
}

export interface EDDNMessage {
  $schemaRef: string;
  header: { uploaderID: string; softwareName: string; softwareVersion: string; gameversion?: string; gamebuild?: string };
  message: Record<string, unknown>;
}

// === Дополнения ===

export interface AtlasFavorite {
  id: string;
  user_id: string;
  candidate_id?: string;
  search_id?: string;
  system_name: string;
  x: number; y: number; z: number;
  world_type: WorldType;
  body_name?: string;
  note?: string;
  created_at: string;
}

export interface AtlasRouteSaved {
  id: string;
  user_id: string;
  name: string;
  from_system: string;
  to_system: string;
  engine: 'greedy' | 'weighted_astar' | 'neutron';
  jump_range: number;
  waypoints: RouteWaypoint[];
  total_distance_ly: number;
  estimated_jumps: number;
  created_at: string;
  is_public: boolean;
}

export interface UserPOI {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  system_name: string;
  x: number; y: number; z: number;
  poi_type: 'general' | 'engineer' | 'thargoid' | 'resource' | 'danger';
  is_public: boolean;
  created_at: string;
}

export interface HubGoal {
  id: number;
  hub_id: number;
  commodity: string;
  target_amount: number;
  current_amount: number;
  unit: string;
  deadline?: string;
  created_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  cmdr_name: string;
  total_amount: number;
  deliveries_count: number;
  hubs_visited: number;
  route_systems_visited: number;
  systems_visited?: number;
  commodities?: { commodity: string; amount: number }[];
  avatar_url?: string | null;
}

export interface Badge {
  id: number;
  slug: string;
  name: string;
  description?: string;
  icon_url?: string;
  condition_type: string;
  condition_value: number;
}

export interface UserBadge {
  id: string;
  user_id: string;
  badge_id: number;
  awarded_at: string;
  badge?: Badge;
}
