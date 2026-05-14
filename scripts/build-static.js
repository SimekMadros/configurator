const fs = require("fs");
const path = require("path");
const webpack = require("webpack");
const configFactory = require("../webpack.config");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

const EXCLUDED_EXTENSIONS = new Set([
  ".blend",
  ".blend1",
  ".zip",
  ".tiff",
  ".tif",
  ".obj",
  ".mtl",
  ".usdc",
  ".tres",
  ".bak",
]);

function shouldCopyFile(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  return !EXCLUDED_EXTENSIONS.has(ext);
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || !shouldCopyFile(sourcePath)) continue;
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function runWebpack() {
  const config = configFactory({}, { mode: "production" });
  config.mode = "production";
  config.devtool = false;

  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }

      if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ colors: false, errors: true })));
        return;
      }

      process.stdout.write(stats.toString({ colors: true, assets: true, chunks: false, modules: false }) + "\n");
      resolve();
    });
  });
}

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  await runWebpack();
  copyDirectory(publicDir, distDir);

  fs.writeFileSync(path.join(distDir, ".nojekyll"), "");

  console.log(`Static export ready: ${distDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
