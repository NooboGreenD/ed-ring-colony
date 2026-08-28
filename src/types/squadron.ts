export type SquadronStatus = 'active' | 'recruiting' | 'closed' | 'disbanded';

export interface Squadron {
  id: number;
  name: string;
  tag: string | null;
  description: string | null;
  color: string;
  icon: string;
  status: SquadronStatus;
  allegiance: string | null;
  power: string | null;
  language: string | null;
  timezone: string | null;
  member_limit: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  member_count?: number;
  project_count?: number;
  // Extended settings
  name_changed_at: string | null;
  discord_url: string | null;
  website_url: string | null;
  recruitment_message: string | null;
  activity_type: string | null;
  is_open_recruitment: boolean;
  home_system: string | null;
}

export interface SquadronRank {
  id: number;
  squadron_id: number;
  name: string;
  sort_order: number;
  is_default: boolean;
  can_manage_projects: boolean;
  can_manage_members: boolean;
  can_manage_ranks: boolean;
  can_edit_squadron: boolean;
  created_at: string;
}

export interface SquadronMember {
  id: number;
  squadron_id: number;
  user_id: string;
  rank_id: number | null;
  callsign: string | null;
  joined_at: string;
  rank?: SquadronRank;
  profile?: {
    cmdr_name: string | null;
    avatar_url: string | null;
  };
}

export interface SquadronMemberDetail {
  id: number;
  squadron_id: number;
  user_id: string;
  rank_id: number | null;
  callsign: string | null;
  joined_at: string;
  rank_name: string | null;
  rank_order: number | null;
  is_default: boolean | null;
  can_manage_projects: boolean | null;
  can_manage_members: boolean | null;
  can_manage_ranks: boolean | null;
  can_edit_squadron: boolean | null;
  cmdr_name: string | null;
  avatar_url: string | null;
}

export interface SquadronWithDetails {
  squadron: Squadron;
  members: SquadronMemberDetail[];
  ranks: SquadronRank[];
  projects: any[];
}

export const DEFAULT_RANK_NAMES = [
  'Командир эскадрильи',
  'Заместитель командира',
  'Офицер',
  'Ветеран',
  'Пилот',
] as const;
