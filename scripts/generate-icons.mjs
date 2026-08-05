/**
 * Verifies the committed Star of Life PWA icon variants.
 *
 * The source artwork is kept in apps/web/public/icons/star-of-life.png. Regenerate the
 * variants with an image editor when the source artwork changes.
 */
import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'icons');
const icons = ['star-of-life.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

for (const icon of icons) accessSync(join(iconsDir, icon));
console.log('Star of Life PWA icons are ready.');
