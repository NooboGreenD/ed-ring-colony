import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as THREE from 'three';

const componentUrl = new URL('../../src/components/GalaxyMap/RingZone.tsx', import.meta.url);
const source = readFileSync(componentUrl, 'utf8');
const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(createRequire(componentUrl), module, module.exports);
const { RingZone } = module.exports;

function parts(props = {}) {
  const mesh = RingZone(props);
  const [geometry, material] = mesh.props.children;
  return { mesh, geometry, material };
}

test('orange belt is a tube centered on the galactic origin, spanning 24500–25500 ly', () => {
  const { mesh, geometry } = parts();
  assert.deepEqual(mesh.props.position, [0, 0, 0]);
  assert.deepEqual(mesh.props.rotation, [-Math.PI / 2, 0, 0]);
  assert.equal(mesh.props.scale, undefined, 'radial bounds must not pulse');
  assert.equal(mesh.props.raycast(), null, 'belt must not intercept star selection');
  assert.equal(geometry.type, 'torusGeometry');
  assert.deepEqual(geometry.props.args, [25000, 500, 32, 256]);

  const torus = new THREE.TorusGeometry(...geometry.props.args);
  torus.rotateX(mesh.props.rotation[0]);
  const positions = torus.getAttribute('position');
  let minRadius = Infinity;
  let maxRadius = 0;
  let maxHeight = 0;
  for (let i = 0; i < positions.count; i++) {
    const radius = Math.hypot(positions.getX(i), positions.getZ(i));
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);
    maxHeight = Math.max(maxHeight, Math.abs(positions.getY(i)));
  }
  assert.ok(Math.abs(minRadius - 24500) < 0.01);
  assert.ok(Math.abs(maxRadius - 25500) < 0.01);
  assert.ok(Math.abs(maxHeight - 500) < 0.01, 'tube must have a round, volumetric cross-section');
  torus.dispose();
});

test('belt remains orange but is more transparent and does not hide stars', () => {
  const { material } = parts();
  assert.equal(material.props.color, '#e67e22');
  assert.equal(material.props.transparent, true);
  assert.ok(material.props.opacity > 0 && material.props.opacity < 0.06);
  assert.equal(material.props.depthWrite, false);
  assert.equal(material.props.side, THREE.DoubleSide);
  assert.equal(material.props.blending, THREE.AdditiveBlending);
});

test('custom radii and segment count still define the tube geometry', () => {
  const { geometry } = parts({ innerRadius: 10000, outerRadius: 12000, segments: 128 });
  assert.deepEqual(geometry.props.args, [11000, 1000, 32, 128]);
});
