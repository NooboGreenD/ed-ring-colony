#!/usr/bin/env node
/**
 * Компиляция GLSL-шейдеров слоя туманностей настоящим компилятором (glslang,
 * тот же фронтенд, которым драйверы и ANGLE валидируют ESSL).
 *
 * Зачем: слой собирается инстанс-мешем с ShaderMaterial. Если вершинный или
 * фрагментный шейдер не компилируется, three рисует пустоту, а подписи
 * туманностей остаются — именно так выглядела поломка «видны только имена».
 * CPU-превью (`preview-nebulae.mjs`) эту ошибку поймать не может, поэтому
 * шейдеры прогоняются через glslang напрямую.
 *
 * Шейдеры извлекаются из `NebulaField.tsx` как есть и оборачиваются тем же
 * префиксом, который добавляет three r185 (WebGLProgram.js): GLSL1-текст
 * превращается в `#version 300 es` с `#define attribute in` и т.д. То есть
 * проверяется ровно то, что уходит в драйвер.
 *
 * Запуск: node scripts/check-nebula-shaders.mjs   (ненулевой код при ошибке)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src/components/GalaxyMap/NebulaField.tsx');

export function extractShaders(text) {
  const extract = (name) => {
    const start = text.indexOf(`const ${name} = /* glsl */ \``);
    if (start < 0) throw new Error(`шейдер не найден в NebulaField.tsx: ${name}`);
    const from = text.indexOf('`', start) + 1;
    const to = text.indexOf('`', from);
    return text.slice(from, to);
  };
  return { vertex: extract('VERTEX_SHADER'), fragment: extract('FRAGMENT_SHADER') };
}

// Префикс three.js r185 для ShaderMaterial (WebGLProgram.js, конверсия GLSL→GLSL3)
// + встроенные объявления, которые three добавляет в вершинный/фрагментный текст.
export const PREFIX_VERTEX = `#define attribute in
#define varying out
#define texture2D texture
precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
in vec3 position;
in vec3 normal;
in vec2 uv;
`;

export const PREFIX_FRAGMENT = `#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
precision highp float;
precision highp int;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

/**
 * Прогоняет оба шейдера через glslang (ESSL 300) и возвращает список
 * диагностик. Пустой список — шейдеры компилируются и линкуются.
 */
export async function validateNebulaShaders() {
  const { createValidator } = await import('glslang-wasm-validator');
  const { vertex, fragment } = extractShaders(fs.readFileSync(SOURCE, 'utf8'));
  const validator = await createValidator();
  try {
    const result = validator.checkPass({
      vertex: { name: 'NebulaField.vert', source: PREFIX_VERTEX + vertex },
      fragment: { name: 'NebulaField.frag', source: PREFIX_FRAGMENT + fragment },
    });
    return { status: result.status, diagnostics: result.diagnostics };
  } finally {
    validator.dispose();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { status, diagnostics } = await validateNebulaShaders();
    if (status === 'pass' && diagnostics.every((d) => d.severity !== 'error')) {
      console.log('шейдеры слоя туманностей: компиляция OK');
    } else {
      for (const d of diagnostics) {
        console.log(`${d.severity} ${d.stage} ${d.line ?? '-'}: ${d.message}`);
      }
      console.error(`шейдеры слоя туманностей: ${status}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`не удалось проверить шейдеры: ${error.message}`);
    process.exit(2);
  }
}
