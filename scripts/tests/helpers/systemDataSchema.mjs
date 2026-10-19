/**
 * Заглушки соседних таблиц для миграций «единого механизма» (20261020120000 и
 * дальше): SQL-функции карточки системы, прогресса и проектов ссылаются на
 * каталог, кольцо, проекты, станции, авианосцы и т. д. Колонки — только те,
 * что читают функции. Общие для unified-system-data и powerplay-owner.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SYSTEM_DATA_STUBS = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
CREATE TABLE public.galaxy_systems(id bigserial, id64 text UNIQUE, name text, name_lc text UNIQUE, x float8, y float8, z float8,
  main_star text, star_type text, star_giant_class text, needs_permit boolean, distance_from_sols float8, distance_from_sgra float8);
CREATE TABLE public.system_progress(system_name text PRIMARY KEY, progress int, updated_at timestamptz DEFAULT now(), data jsonb);
CREATE TABLE public.colonisation_sites(market_id bigint PRIMARY KEY, system_name text NOT NULL, construction_id bigint, construction_name text,
  construction_progress numeric(5,2), resources_total jsonb NOT NULL DEFAULT '[]', event_timestamp timestamptz NOT NULL, user_id uuid);
CREATE TABLE public.system_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text NOT NULL,
  system_name_lc text GENERATED ALWAYS AS (lower(trim(system_name))) STORED, title text DEFAULT '', author_id uuid NOT NULL,
  author_name text DEFAULT '', visibility text DEFAULT 'private', plan jsonb NOT NULL DEFAULT '{}', site_count int DEFAULT 0,
  haul_tons bigint DEFAULT 0, catalogue_version int DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.system_architects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text, system_name_lc text UNIQUE,
  user_id uuid, architect_name text DEFAULT '', assigned_by_name text DEFAULT '', updated_at timestamptz DEFAULT now());
CREATE TABLE public.squadrons(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
CREATE TABLE public.squadron_members(user_id uuid, squadron_id bigint, rank_id bigint);
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
CREATE TABLE public.projects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, status text DEFAULT 'active', color text,
  squadron_id bigint, created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.project_members(project_id bigint, user_id uuid, role text DEFAULT 'member');
CREATE TABLE public.project_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id bigint, system_name text NOT NULL,
  route_system_id bigint, planned_status text NOT NULL DEFAULT 'planned', priority int DEFAULT 1, target_date date, assigned_to uuid);
CREATE TABLE public.architect_projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, status text DEFAULT 'active', color text,
  progress_summary jsonb, progress_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.architect_project_members(project_id uuid, user_id uuid, role text DEFAULT 'member');
CREATE TABLE public.architect_project_systems(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, system_name text NOT NULL,
  system_name_lc text GENERATED ALWAYS AS (lower(btrim(system_name))) STORED, stage text DEFAULT 'planned', priority smallint DEFAULT 2, target_date date);
CREATE TABLE public.route_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, sort_order int, status text DEFAULT 'planned',
  progress int DEFAULT 0, x float8, y float8, z float8);
CREATE TABLE public.hubs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, system_name text NOT NULL, status text, progress int,
  segment_order int, x float8, y float8, z float8);
CREATE TABLE public.station_commerce(station_key text PRIMARY KEY, market_id text, system_name text, system_lc text, station_name text,
  station_type text, metadata jsonb DEFAULT '{}', observed_at timestamptz, source text);
CREATE TABLE public.station_inventory_snapshots(station_key text, kind text, items jsonb, observed_at timestamptz, source text);
CREATE TABLE public.community_goals(id serial, cg_id int, title text, system_name text, station_name text, objective text, tier_current int,
  tier_max int, contributors int, expiry_date timestamptz, is_complete boolean DEFAULT false, is_colonisation_related boolean DEFAULT false);
CREATE TABLE public.deliveries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid, system_name text, amount int,
  delivered_at timestamptz, is_construction boolean);
CREATE TABLE public.system_scans(id bigserial, system_name text, body_name text, updated_at timestamptz DEFAULT now());
CREATE TABLE public.user_notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL,
  title text NOT NULL, body text, href text, metadata jsonb NOT NULL DEFAULT '{}', is_read boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE public.fleet_carriers(carrier_id bigint PRIMARY KEY, carrier_type text DEFAULT 'FleetCarrier', callsign text, name text,
  owner_id uuid, squadron_id bigint, system_name text, system_address bigint, body_name text, x float8, y float8, z float8,
  location_at timestamptz, location_source text, jump_system_name text, jump_system_address bigint, jump_body_name text,
  jump_departure_at timestamptz, jump_requested_at timestamptz, docking_access text, allow_notorious boolean,
  pending_decommission boolean DEFAULT false, decommission_at timestamptz, services jsonb, station_services jsonb, updated_at timestamptz DEFAULT now());
`;

/** Миграции слоёв PowerPlay и фракций по порядку (до `upTo` включительно). */
export const SYSTEM_DATA_MIGRATIONS = [
  '20261018120000_powerplay_systems.sql',
  '20261018180000_powerplay_sync_progress.sql',
  '20261019120000_minor_factions.sql',
  '20261020120000_unified_system_data.sql',
  '20261021120000_powerplay_owner.sql',
  '20261021130000_eddn_listener.sql',
];

export function readMigration(root, file) {
  return readFileSync(join(root, 'supabase', 'migrations', file), 'utf8');
}
