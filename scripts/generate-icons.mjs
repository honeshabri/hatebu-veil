import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = path.join(projectRoot, 'assets', 'icon-source.png');
const outputDirectory = path.join(projectRoot, 'assets', 'icons');
const sizes = [16, 32, 48, 128];

async function generateIcons() {
  try {
    await access(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('元画像が見つかりません: assets/icon-source.png');
    }
    throw error;
  }

  let image;
  let metadata;
  try {
    image = sharp(sourcePath);
    metadata = await image.metadata();
  } catch {
    throw new Error('元画像を読み込めません。assets/icon-source.png に有効なPNG画像を配置してください。');
  }

  if (!metadata.width || !metadata.height) {
    throw new Error('元画像の幅または高さを取得できません。');
  }

  if (metadata.width !== metadata.height) {
    throw new Error(`元画像は正方形にしてください（現在: ${metadata.width}×${metadata.height}px）。画像は歪ませず、生成を中止しました。`);
  }

  try {
    await sharp(sourcePath).raw().toBuffer();
  } catch {
    throw new Error('元画像のデータを読み込めません。PNGが壊れていないか確認してください。');
  }

  if (metadata.width < 256) {
    console.warn(`警告: 元画像は${metadata.width}×${metadata.height}pxです。256×256px以上の画像を推奨します。`);
    if (metadata.width < 128) {
      console.warn('警告: 128px未満の画像は、生成後のアイコンがぼやけることがあります。');
    }
  }

  await mkdir(outputDirectory, { recursive: true });

  for (const size of sizes) {
    const filename = `icon-${size}.png`;
    await image
      .clone()
      .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(path.join(outputDirectory, filename));
  }

  console.log('Generated:');
  for (const size of sizes) {
    console.log(`- assets/icons/icon-${size}.png`);
  }
}

generateIcons().catch((error) => {
  console.error(`アイコンを生成できませんでした: ${error.message}`);
  process.exitCode = 1;
});
