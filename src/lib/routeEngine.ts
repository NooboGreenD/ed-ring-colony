import type { RouteWaypoint } from '@/types/atlas';

export interface RoutePoint { system_name: string; x: number; y: number; z: number; }

function dist3(a: RoutePoint, b: RoutePoint): number {
  return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
}

export function greedyRoute(points: RoutePoint[], start?: RoutePoint): RouteWaypoint[] {
  if (points.length === 0) return [];
  const unvisited = [...points];
  const route: RouteWaypoint[] = [];
  let current = start || unvisited.shift()!;
  let cumulative = 0;
  while (unvisited.length > 0) {
    let nearestIdx = 0, nearestDist = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      const d = dist3(current, unvisited[i]);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    const next = unvisited.splice(nearestIdx, 1)[0];
    cumulative += nearestDist;
    route.push({ system_name: next.system_name, x: next.x, y: next.y, z: next.z,
      distance_from_prev: nearestDist, cumulative_distance: cumulative });
    current = next;
  }
  return route;
}

export function weightedAStarRoute(points: RoutePoint[], from: RoutePoint, to: RoutePoint, jumpRange: number = 30, weight: number = 1.2): RouteWaypoint[] {
  const allPoints = [from, ...points.filter(p => p.system_name !== from.system_name && p.system_name !== to.system_name), to];
  const n = allPoints.length;
  const fromIdx = 0, toIdx = n - 1;
  const distMatrix: number[][] = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = dist3(allPoints[i], allPoints[j]);
    distMatrix[i][j] = d; distMatrix[j][i] = d;
  }
  const gScore = Array(n).fill(Infinity), fScore = Array(n).fill(Infinity), cameFrom = Array(n).fill(-1);
  const openSet = new Set<number>([fromIdx]);
  gScore[fromIdx] = 0;
  fScore[fromIdx] = dist3(allPoints[fromIdx], allPoints[toIdx]);
  while (openSet.size > 0) {
    let current = -1, minF = Infinity;
    for (const node of openSet) { if (fScore[node] < minF) { minF = fScore[node]; current = node; } }
    if (current === -1 || current === toIdx) break;
    openSet.delete(current);
    for (let neighbor = 0; neighbor < n; neighbor++) {
      if (neighbor === current) continue;
      const d = distMatrix[current][neighbor];
      if (d > jumpRange * 10) continue;
      const tentativeG = gScore[current] + d;
      if (tentativeG < gScore[neighbor]) {
        cameFrom[neighbor] = current;
        gScore[neighbor] = tentativeG;
        fScore[neighbor] = tentativeG + weight * dist3(allPoints[neighbor], allPoints[toIdx]);
        openSet.add(neighbor);
      }
    }
  }
  const path: number[] = [];
  let cur = toIdx;
  while (cur !== -1) { path.unshift(cur); cur = cameFrom[cur]; }
  if (path[0] !== fromIdx) return [];
  const waypoints: RouteWaypoint[] = [];
  let cumulative = 0;
  for (let i = 1; i < path.length; i++) {
    const d = distMatrix[path[i-1]][path[i]];
    cumulative += d;
    const p = allPoints[path[i]];
    waypoints.push({ system_name: p.system_name, x: p.x, y: p.y, z: p.z,
      distance_from_prev: d, cumulative_distance: cumulative, estimated_jumps: Math.ceil(d / jumpRange) });
  }
  return waypoints;
}

export function neutronRouteEstimate(distanceLy: number, jumpRange: number = 300): number {
  return Math.ceil(distanceLy / jumpRange);
}
