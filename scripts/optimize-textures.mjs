import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();

const TEXTURES_DIR = path.join(ROOT, "public", "textures", "fabric");
const BACKUP_DIR = path.join(ROOT, "texture-source-files", "fabric-original-before-optimize");

// Bezpečný limit pro web.
// 1024 je první opatrný pokus pro látky.
const MAX_SIZE = 1024;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg"]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...await walk(full));
      continue;
    }

    if (entry.isFile()) {
      out.push(full);
    }
  }

  return out;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function fileSize(file) {
  const stat = await fs.stat(file);
  return stat.size;
}

async function optimizeImage(file) {
  const ext = path.extname(file).toLowerCase();

  if (!IMAGE_EXTS.has(ext)) {
    return null;
  }

  const before = await fileSize(file);
  const tmp = `${file}.tmp-optimize`;

  let pipeline = sharp(file, {
    limitInputPixels: false,
  }).rotate();

  const meta = await pipeline.metadata();

  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);

  const shouldResize =
    width > MAX_SIZE ||
    height > MAX_SIZE;

  if (shouldResize) {
    pipeline = pipeline.resize({
      width: MAX_SIZE,
      height: MAX_SIZE,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    pipeline = pipeline.jpeg({
      quality: 82,
      progressive: true,
      mozjpeg: true,
    });
  } else if (ext === ".png") {
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      effort: 10,
    });
  }

  await pipeline.toFile(tmp);

  const after = await fileSize(tmp);

  // Když by optimalizace náhodou vytvořila větší soubor, necháme původní.
  if (after >= before) {
    await fs.unlink(tmp);
    return {
      file,
      skipped: true,
      before,
      after: before,
      reason: "optimized file was not smaller",
    };
  }

  await fs.rename(tmp, file);

  return {
    file,
    skipped: false,
    before,
    after,
    saved: before - after,
    resized: shouldResize,
    width,
    height,
  };
}

async function main() {
  console.log("Texture optimizer");
  console.log("Source:", TEXTURES_DIR);
  console.log("Backup:", BACKUP_DIR);
  console.log("");

  if (!await exists(TEXTURES_DIR)) {
    throw new Error(`Folder not found: ${TEXTURES_DIR}`);
  }

  if (!await exists(BACKUP_DIR)) {
    console.log("Creating backup...");
    await fs.mkdir(path.dirname(BACKUP_DIR), { recursive: true });
    await fs.cp(TEXTURES_DIR, BACKUP_DIR, { recursive: true });
    console.log("Backup created.");
    console.log("");
  } else {
    console.log("Backup already exists, skipping backup creation.");
    console.log("");
  }

  const files = await walk(TEXTURES_DIR);
  const images = files.filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase()));

  console.log(`Found ${images.length} images.`);
  console.log("");

  let totalBefore = 0;
  let totalAfter = 0;
  let optimizedCount = 0;
  let skippedCount = 0;

  for (const file of images) {
    try {
      const result = await optimizeImage(file);
      if (!result) continue;

      totalBefore += result.before;
      totalAfter += result.after;

      const relative = path.relative(TEXTURES_DIR, file);

      if (result.skipped) {
        skippedCount++;
        console.log(`SKIP ${relative} | ${formatMb(result.before)}`);
      } else {
        optimizedCount++;
        const resizeText = result.resized
          ? ` | resized ${result.width}x${result.height} -> max ${MAX_SIZE}`
          : "";
        console.log(
          `OK   ${relative} | ${formatMb(result.before)} -> ${formatMb(result.after)}${resizeText}`
        );
      }
    } catch (err) {
      console.warn(`FAIL ${file}`);
      console.warn(err?.message || err);
    }
  }

  console.log("");
  console.log("Done.");
  console.log(`Optimized: ${optimizedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Before: ${formatMb(totalBefore)}`);
  console.log(`After:  ${formatMb(totalAfter)}`);
  console.log(`Saved:  ${formatMb(totalBefore - totalAfter)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});