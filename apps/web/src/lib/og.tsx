import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OG_SIZE = { width: 1200, height: 630 };

/** Static Archivo Bold Condensed instances (generated from the OFL variable font) for next/og. */
export async function ogFonts() {
  const dir = join(process.cwd(), 'src', 'fonts');
  const [latin, ext] = await Promise.all([
    readFile(join(dir, 'archivo-latin-og.ttf')),
    readFile(join(dir, 'archivo-latin-ext-og.ttf')),
  ]);
  return [
    { name: 'Archivo', data: latin, weight: 700 as const, style: 'normal' as const },
    { name: 'Archivo', data: ext, weight: 700 as const, style: 'normal' as const },
  ];
}

export const OG = {
  bg: '#0D1A2B',
  surface: '#142338',
  text: '#F2F5F9',
  text2: '#93A4BA',
  accent: '#FFB648',
  gain: '#3DDC97',
  loss: '#FF6B6B',
};
