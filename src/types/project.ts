export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type ProjectMemberRole = 'leader' | 'officer' | 'member';
export type ProjectSystemStatus = 'planned' | 'preparing' | 'building' | 'done' | 'on_hold';

export interface Project {
  id: number;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  status: ProjectStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  // joined fields
  member_count?: number;
  system_count?: number;
  systems_done?: number;
  systems_building?: number;
  latest_target_date?: string | null;
}

export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: string;
  role: ProjectMemberRole;
  callsign: string | null;
  joined_at: string;
  // joined fields
  profile?: {
    cmdr_name: string | null;
    avatar_url: string | null;
    squadron: string | null;
  };
}

export interface ProjectSystem {
  id: number;
  project_id: number;
  system_name: string;
  route_system_id: number | null;
  hub_id: number | null;
  sort_order: number;
  planned_status: ProjectSystemStatus;
  priority: number;
  notes: string | null;
  assigned_to: string | null;
  target_date: string | null;
  added_at: string;
  // joined fields
  assignee?: {
    cmdr_name: string | null;
  };
  route_system?: {
    status: string;
    progress: number | null;
    x: number;
    y: number;
    z: number;
  };
  hub?: {
    status: string;
    progress: number | null;
    x: number;
    y: number;
    z: number;
  };
  raven_data?: {
    progress: number | null;
    siteName: string | null;
    architectName: string | null;
    projects: any[];
    resources: any[];
  };
}

export interface ProjectBuildPlan {
  id: number;
  project_system_id: number;
  build_type: string;
  priority: number;
  planned_start: string | null;
  planned_end: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProjectRoutePoint {
  system_name: string;
  x: number;
  y: number;
  z: number;
  sort_order: number;
  distance_from_prev: number;
  cumulative_distance: number;
}

export interface ProjectWithDetails {
  project: Project;
  members: ProjectMember[];
  systems: ProjectSystem[];
  route: ProjectRoutePoint[];
}
