import { z } from 'zod';

export const atlasSearchSchema = z.object({
  reference_system: z.string().min(1).max(100),
  cube_size_ly: z.number().min(1).max(5000),
  world_types: z.array(z.string()).min(1),
  require_landable: z.boolean().optional(),
  min_estimated_value: z.number().min(0).optional(),
  max_distance_to_arrival: z.number().min(0).optional(),
});

export const deliveryImportSchema = z.object({
  cmdr: z.string().min(1).max(100).optional(),
  deliveries: z.array(z.object({
    systemName: z.string().min(1),
    commodity: z.string().min(1),
    amount: z.number().positive(),
    timestamp: z.string().datetime(),
  })).optional(),
  access_token: z.string().optional(),
});

export const forumPostSchema = z.object({
  thread_id: z.number().int().positive(),
  content: z.string().min(1).max(10000),
  parent_post_id: z.number().int().positive().optional(),
});

export const forumReportSchema = z.object({
  post_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  reason: z.string().min(1).max(1000),
});

export const poiSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  system_name: z.string().min(1).max(100),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  poi_type: z.enum(['general', 'engineer', 'thargoid', 'resource', 'danger']).default('general'),
  is_public: z.boolean().default(false),
});
