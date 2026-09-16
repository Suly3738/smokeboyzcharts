// Robi przezroczyste logo.png z logo-original.png (czarne tło -> alfa).
// Drobne napisy w dolnej części grafiki są szare, więc dostają mocniejsze krycie.
// Uruchom z folderu projektu: node tools/make-logo.mjs [podglad.png]   (wymaga: npm install --no-save sharp)
import sharp from 'sharp';

const img = sharp('logo-original.png').ensureAlpha();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const SMALL_FROM = Math.round(H * 0.69); // poniżej "STUDIO": linia z ✦, MUSIC ✦ PEOPLE ✦ HIGHER VISION, globus, EST. 2024

for (let y = 0; y < H; y++) {
  const small = y >= SMALL_FROM;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const lum = Math.max(data[i], data[i + 1], data[i + 2]);
    let a;
    if (lum < 12) a = 0;
    else if (small) a = Math.min(255, Math.round(255 * Math.pow(lum / 255, 0.42) * 1.15)); // mocne wzmocnienie drobnych napisów
    else a = Math.round(255 * Math.pow(lum / 255, 0.85)); // lekkie wzmocnienie liter i dymu
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
  }
}

const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).trim({ threshold: 10 }).png({ compressionLevel: 9 }).toFile('logo.png');
console.log('logo.png', out.width, 'x', out.height, out.size, 'B');

if (process.argv[2]) {
  await sharp({ create: { width: out.width, height: out.height, channels: 4, background: '#0b0a1c' } })
    .composite([{ input: 'logo.png' }]).png().toFile(process.argv[2]);
  console.log('podgląd:', process.argv[2]);
}
