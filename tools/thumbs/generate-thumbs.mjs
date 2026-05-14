import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import serveHandler from "serve-handler";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_NAME = String(process.argv[2] || "Mendoza").trim();
const MODELS_DIR = path.resolve(__dirname, `../../public/models/${MODEL_NAME}`);
const OUT_DIR = path.resolve(__dirname, `../../public/thumbs/${MODEL_NAME}`);
const PORT = 4173;

fs.mkdirSync(OUT_DIR, { recursive: true });

const publicRoot = path.resolve(__dirname, "../../public");
const threeRoot = path.resolve(__dirname, "../../node_modules/three");

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/vendor/three/")) {
    if (req.url && req.url.startsWith("/vendor/three/")) {
      req.url = req.url.slice("/vendor/three".length);
      return serveHandler(req, res, { public: threeRoot });
    }
    return serveHandler(req, res, { public: threeRoot });
  }
  return serveHandler(req, res, { public: publicRoot });
});

server.listen(PORT, async () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL_NAME}`);

  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();

  page.on("console", (msg) => console.log("[browser]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("requestfailed", (req) => console.log("[requestfailed]", req.url(), req.failure()?.errorText));

  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/thumbgen/`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__renderThumb === "function", { timeout: 30000 });

  const files = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith(".glb")).sort();

  for (const file of files) {
    const glbUrl = `/models/${MODEL_NAME}/${file}`;
    const outPng = path.join(OUT_DIR, file.replace(/\.glb$/i, ".png"));

    console.log(`Render: ${file} -> ${path.basename(outPng)}`);

    const dataUrl = await page.evaluate(async (url) => {
      return await window.__renderThumb(url);
    }, glbUrl);

    const base64 = dataUrl.split(",")[1];
    fs.writeFileSync(outPng, Buffer.from(base64, "base64"));
  }

  await browser.close();
  server.close();
  console.log("DONE");
});
