import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HELPER_RUNTIME_RESOURCES } from './helperRuntimeResources';

const SERVER_SOURCE_EXCLUDE = new Set(['build_exe.py', 'build_bundle.py', 'launcher.py', 'updater.py']);

/**
 * Собрать исходники прямо из установленной вместе с сайтом папки uploader.
 * Номер VERSION меняется только в содержимом релиза: администратору не нужно
 * править файл на сервере или предварительно собирать каталог на компьютере.
 */
export async function serverSourceFiles(version: string, t: (key: string, params?: Record<string, string | number>) => string): Promise<Map<string, Buffer>> {
  const root = join(process.cwd(), 'uploader');
  const entries = await readdir(root, { withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.py') && !HELPER_RUNTIME_RESOURCES.includes(entry.name)) || SERVER_SOURCE_EXCLUDE.has(entry.name)) continue;
    let data = await readFile(join(root, entry.name));
    if (entry.name === 'colonial_helper.py') {
      const source = data.toString('utf8');
      if (!/^VERSION\s*=\s*["'][^"']+["']/m.test(source)) {
        throw new Error(t('adm.sourceVersionMissing'));
      }
      data = Buffer.from(source.replace(/^VERSION\s*=\s*["'][^"']+["']/m, `VERSION = "${version}"`), 'utf8');
    }
    files.set(entry.name, data);
  }
  if (files.size === 0) throw new Error(t('adm.sourceDirEmpty', { root }));
  return files;
}

