import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(__dirname, '../public/icon.svg'), 'utf-8');

const sizes = [16, 32, 48, 96, 128];

for (const size of sizes) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(resolve(__dirname, `../public/icon/${size}.png`));
  console.log(`Generated ${size}x${size} icon`);
}

console.log('All icons generated!');
