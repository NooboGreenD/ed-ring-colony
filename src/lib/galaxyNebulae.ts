// Major in-game nebula reference systems and their Elite Dangerous coordinates.
// Coordinates are taken from EDSM/EDAstro catalogue entries; the sprite is
// centered on the catalogue reference system, as in the galaxy map.
export type GalaxyNebula = {
  name: string;
  x: number;
  y: number;
  z: number;
  color: string;
  size: number;
};

export const GALAXY_NEBULAE: GalaxyNebula[] = [
  { name: 'Witch Head Nebula', x: 359.84375, y: -385.53125, z: -718.375, color: '#e78cff', size: 1100 },
  { name: 'Orion Nebula', x: 593.3125, y: -433.53125, z: -1065.03125, color: '#ff9b72', size: 1250 },
  { name: 'Flaming Star Emission Nebula', x: -233.5, y: -67.1875, z: -1681.3125, color: '#ffb14e', size: 1150 },
  { name: 'Trifid of the North', x: -649.59375, y: -416.75, z: -2474.6875, color: '#ff6b7d', size: 1200 },
  { name: 'NGC 1501', x: -2071.59375, y: 413.75, z: -2915.03125, color: '#69d7ff', size: 900 },
  { name: 'Fireflies Nebula', x: -4192.71875, y: 114.5, z: -4190.625, color: '#72f0c0', size: 1050 },
  { name: 'IC 1805 Nebula', x: -4337.375, y: 12.3125, z: -4425.40625, color: '#ff668d', size: 1500 },
  { name: 'Heart Nebula', x: -5150.90625, y: 98.625, z: -5326.6875, color: '#f05c83', size: 1550 },
  { name: 'Soul Nebula', x: -5303.78125, y: 130.34375, z: -5305.40625, color: '#8c9dff', size: 1250 },
  { name: 'Chi Persei Nebula', x: -5381.90625, y: -472.78125, z: -5383.59375, color: '#ffd166', size: 900 },
  { name: 'NGC 7822', x: 4948.47, y: 165.062, z: 20654.5, color: '#72b7ff', size: 1450 },
  { name: 'Eskimo Nebula', x: 234.625, y: 239.21875, z: -726.46875, color: '#a6f6ff', size: 650 },
];
