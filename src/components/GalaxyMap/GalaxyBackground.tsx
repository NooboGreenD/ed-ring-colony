"use client";

import { StarField } from "./StarField";
import { GalaxyPlane } from "./GalaxyPlane";

export function GalaxyBackground() {
  // Фон (плоскость галактики + звёздное поле) уже сгенерирован
  // вокруг (0,0,0). В системе eliteToThreeCentered точка (0,0,0)
  // Three.js соответствует SAGA, поэтому сдвигать ничего не нужно.
  return (
    <group>
      <GalaxyPlane />
      <StarField />
    </group>
  );
}