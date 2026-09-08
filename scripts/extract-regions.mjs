import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const data = require(process.env.TEMP + '/RegionMapData.json');

const X0 = -49985;
const Z0 = -24105;
const CELL = 4096 / 83;
const SAGA = { x: 25.21875, z: 25899.96875 };
const W = 2048;
const H = 2048;
const DS = 8;
const gw = W / DS;
const gh = H / DS;

const full = new Uint8Array(W * H);
let i = 0;
for (const row of data.regionmap) {
  for (const [len, id] of row) {
    full.fill(id, i, i + len);
    i += len;
  }
}

const grid = new Uint8Array(gw * gh);
const counts = Array.from({ length: gw * gh }, () => new Uint16Array(43));
for (let z = 0; z < H; z++) {
  const gz = (z / DS) | 0;
  for (let x = 0; x < W; x++) {
    const gx = (x / DS) | 0;
    const id = full[z * W + x];
    counts[gz * gw + gx][id]++;
  }
}
for (let p = 0; p < gw * gh; p++) {
  const c = counts[p];
  let best = 0;
  let bv = 0;
  for (let id = 1; id <= 42; id++) {
    if (c[id] > bv) {
      bv = c[id];
      best = id;
    }
  }
  grid[p] = best;
}

function pixelToLy(px, pz) {
  return [X0 + px * DS * CELL, Z0 + pz * DS * CELL];
}

function extractRing(id) {
  const key = (x1, z1, x2, z2) => `${x1},${z1}>${x2},${z2}`;
  const edges = new Map();
  const add = (x1, z1, x2, z2) => {
    const rev = key(x2, z2, x1, z1);
    if (edges.has(rev)) edges.delete(rev);
    else edges.set(key(x1, z1, x2, z2), [x1, z1, x2, z2]);
  };
  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      if (grid[z * gw + x] !== id) continue;
      add(x, z, x + 1, z);
      add(x + 1, z, x + 1, z + 1);
      add(x + 1, z + 1, x, z + 1);
      add(x, z + 1, x, z);
    }
  }
  const startOf = new Map();
  for (const e of edges.values()) {
    const sk = `${e[0]},${e[1]}`;
    if (!startOf.has(sk)) startOf.set(sk, []);
    startOf.get(sk).push(e);
  }
  const used = new Set();
  const rings = [];
  for (const e0 of edges.values()) {
    const k0 = key(e0[0], e0[1], e0[2], e0[3]);
    if (used.has(k0)) continue;
    const ring = [];
    let cur = e0;
    let guard = 0;
    while (cur && guard++ < 20000) {
      const ck = key(cur[0], cur[1], cur[2], cur[3]);
      if (used.has(ck)) break;
      used.add(ck);
      ring.push([cur[0], cur[1]]);
      const nk = `${cur[2]},${cur[3]}`;
      const cands = (startOf.get(nk) || []).filter(
        (e) => !used.has(key(e[0], e[1], e[2], e[3])),
      );
      if (!cands.length) break;
      cur = cands[0];
      if (cur[2] === ring[0][0] && cur[3] === ring[0][1] && ring.length > 2) {
        used.add(key(cur[0], cur[1], cur[2], cur[3]));
        break;
      }
    }
    if (ring.length > 8) rings.push(ring);
  }
  rings.sort((a, b) => b.length - a.length);
  return rings[0] || [];
}

function simplify(ring) {
  if (ring.length < 3) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const a = out[out.length - 1];
    const b = ring[i];
    const c = ring[(i + 1) % ring.length];
    const col =
      (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (col) continue;
    out.push(b);
  }
  return out;
}

const regions = [];
for (let id = 1; id <= 42; id++) {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let z = 0; z < gh; z++) {
    for (let x = 0; x < gw; x++) {
      if (grid[z * gw + x] !== id) continue;
      sx += x + 0.5;
      sz += z + 0.5;
      n++;
    }
  }
  const ring = simplify(extractRing(id));
  const pts = ring.map(([x, z]) => {
    const [lx, lz] = pixelToLy(x, z);
    return [Math.round(lx - SAGA.x), Math.round(lz - SAGA.z)];
  });
  const [cx, cz] = pixelToLy(sx / Math.max(n, 1), sz / Math.max(n, 1));
  regions.push({
    id,
    name: data.regions[id],
    cx: Math.round(cx - SAGA.x),
    cz: Math.round(cz - SAGA.z),
    path: pts,
  });
  console.log(id, data.regions[id], 'pts', pts.length, 'cells', n);
}

const outPath = new URL('../src/lib/galacticRegions.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify({ regions }));
console.log('wrote', outPath.pathname, 'bytes', fs.statSync(outPath).size);
