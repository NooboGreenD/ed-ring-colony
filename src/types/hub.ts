export interface Hub {
  id: number;
  system_name: string;
  name: string;
  status: 'planned' | 'building' | 'done';
  progress?: number | null;
  x: number;
  y: number;
  z: number;
  goals?: { id: number; commodity: string; target_amount: number; current_amount: number; unit: string }[];
}

export interface RouteSystem {
  id: number;
  system_name: string;
  sort_order: number;
  status: 'planned' | 'building' | 'done';
  progress?: number | null;
  x: number;
  y: number;
  z: number;
  total_delivered?: number;
  isHub?: boolean;
}
