const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const nodemailer = require("nodemailer");
const puppeteer = require("puppeteer");

const PORT = Number(process.env.PDF_PORT || 3001);
const MAX_BODY_SIZE = 50 * 1024 * 1024;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const ENV_PATH = path.resolve(__dirname, ".env");

let browserPromise = null;
const optimizedAssetCache = new Map();

async function loadLocalEnv() {
  try {
    const raw = await fs.readFile(ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(".env load failed:", error.message);
    }
  }
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendText(res, statusCode, text, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...getCorsHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res, statusCode, buffer, contentType, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...getCorsHeaders(),
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=31536000, immutable",
    ...extraHeaders,
  });
  res.end(buffer);
}

function sanitizeFilename(filename) {
  const clean = String(filename || "rekapitulace.pdf")
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .trim();

  if (!clean) return "rekapitulace.pdf";
  return clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
}

function toAsciiFilename(filename) {
  const ascii = sanitizeFilename(filename)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/"/g, "")
    .trim();

  return ascii || "rekapitulace.pdf";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getMailConfig() {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || user;
  const to = process.env.INQUIRY_TO || "info@madros.cz";
  const secureValue = String(process.env.SMTP_SECURE || "").toLowerCase();
  const secure = secureValue
    ? ["1", "true", "yes"].includes(secureValue)
    : port === 465;

  return { from, host, pass, port, secure, to, user };
}

function assertMailConfigured() {
  const config = getMailConfig();
  const missing = [];

  if (!config.host) missing.push("SMTP_HOST");
  if (!config.user) missing.push("SMTP_USER");
  if (!config.pass) missing.push("SMTP_PASS");
  if (!config.from) missing.push("MAIL_FROM");

  if (missing.length) {
    const error = new Error(`Email není nakonfigurovaný. Chybí: ${missing.join(", ")}.`);
    error.statusCode = 501;
    throw error;
  }

  return config;
}

function createMailTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }

  return browserPromise;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function resolvePublicAssetPath(src) {
  if (!src) return null;

  let pathname = "";
  try {
    pathname = new URL(src, "http://localhost").pathname;
  } catch (error) {
    return null;
  }

  pathname = decodeURIComponent(pathname).replace(/\\/g, "/");

  if (!pathname.startsWith("/images/") && !pathname.startsWith("/textures/")) {
    return null;
  }

  const assetPath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!assetPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;

  return assetPath;
}

function parsePositiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function optimizeImageBuffer(buffer, mimeType, maxSize, quality, format = "jpeg") {
  if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) return { buffer, mimeType };

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const base64 = buffer.toString("base64");
    const result = await page.evaluate(async ({ dataUrl, format, maxSize, quality }) => {
      const img = new Image();
      img.decoding = "async";

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });

      const sourceWidth = img.naturalWidth || img.width || maxSize;
      const sourceHeight = img.naturalHeight || img.height || maxSize;
      const ratio = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * ratio));
      const height = Math.max(1, Math.round(sourceHeight * ratio));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const usePng = format === "png";
      const ctx = canvas.getContext("2d", { alpha: usePng });
      if (!usePng) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, width, height);

      return canvas
        .toDataURL(usePng ? "image/png" : "image/jpeg", quality)
        .split(",")[1];
    }, {
      dataUrl: `data:${mimeType};base64,${base64}`,
      format,
      maxSize,
      quality,
    });

    return {
      buffer: Buffer.from(result, "base64"),
      mimeType: format === "png" ? "image/png" : "image/jpeg",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function handlePdfAssetRequest(req, res) {
  try {
    const requestUrl = new URL(req.originalUrl || req.url || "", "http://localhost");
    const src = requestUrl.searchParams.get("src") || "";
    const maxSize = parsePositiveNumber(requestUrl.searchParams.get("w"), 360, 64, 1200);
    const quality = parsePositiveNumber(requestUrl.searchParams.get("q"), 0.68, 0.35, 0.92);
    const format = requestUrl.searchParams.get("format") === "png" ? "png" : "jpeg";
    const assetPath = resolvePublicAssetPath(src);

    if (!assetPath) {
      sendText(res, 400, "Invalid asset path");
      return;
    }

    const stat = await fs.stat(assetPath);
    if (!stat.isFile()) {
      sendText(res, 404, "Asset not found");
      return;
    }

    const sourceMime = getMimeType(assetPath);
    const cacheKey = `${assetPath}:${stat.mtimeMs}:${stat.size}:${maxSize}:${quality}:${format}`;
    const cached = optimizedAssetCache.get(cacheKey);

    if (cached) {
      sendBuffer(res, 200, cached.buffer, cached.mimeType);
      return;
    }

    const sourceBuffer = await fs.readFile(assetPath);
    const optimized = await optimizeImageBuffer(sourceBuffer, sourceMime, maxSize, quality, format);
    optimizedAssetCache.set(cacheKey, optimized);

    sendBuffer(res, 200, optimized.buffer, optimized.mimeType);
  } catch (error) {
    console.error("PDF asset error:", error);
    sendText(res, 500, "PDF asset failed");
  }
}

function getBaseHrefFromHtml(html) {
  const match = String(html || "").match(/<base\s+[^>]*href=["']([^"']+)["']/i);
  return match?.[1] || "";
}

async function waitForPdfAssets(page) {
  await page.evaluate(async () => {
    const timeout = new Promise((resolve) => setTimeout(resolve, 30000));

    const imagePromises = Array.from(document.images || []).map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();

      return new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    });

    const backgroundUrls = new Set();
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none") continue;

      for (const match of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        const url = match[1];
        if (!url || /^data:/i.test(url)) continue;
        backgroundUrls.add(url);
      }
    }

    const backgroundPromises = Array.from(backgroundUrls).map((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = resolve;
      img.src = url;
    }));

    const fontsReady = document.fonts?.ready?.catch(() => {}) || Promise.resolve();
    await Promise.race([
      Promise.all([...imagePromises, ...backgroundPromises, fontsReady]),
      timeout,
    ]);
  });
}

async function renderPdfFromHtml(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    const baseHref = getBaseHrefFromHtml(html);
    if (/^https?:\/\//i.test(baseHref)) {
      try {
        await page.goto(baseHref, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
      } catch (error) {
        console.warn("PDF base page preload failed:", error.message);
      }
    }

    await page.emulateMediaType("print");
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await waitForPdfAssets(page);

    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
      },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function handlePdfExportRequest(req, res) {
  try {
    const { html, filename } = await readJsonBody(req);

    if (!html || typeof html !== "string") {
      sendText(res, 400, "Missing HTML");
      return;
    }

    const safeFilename = sanitizeFilename(filename);
    const asciiFilename = toAsciiFilename(safeFilename);
    const pdfBuffer = await renderPdfFromHtml(html);

    res.writeHead(200, {
      ...getCorsHeaders(),
      "Content-Type": "application/pdf",
      "Content-Length": pdfBuffer.length,
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    });
    res.end(pdfBuffer);
  } catch (error) {
    console.error("PDF export error:", error);
    sendText(res, 500, "PDF export failed");
  }
}

function buildInquiryEmailText({ customerEmail, summary }) {
  const lines = [
    "Nová poptávka z 3D konfigurátoru.",
    "",
    `Email zákazníka: ${customerEmail}`,
    `Model: ${summary?.sofaName || "Neuvedeno"}`,
    `Typ sestavy: ${summary?.assemblyType || "Neuvedeno"}`,
    `Sestava: ${summary?.assemblyText || "Neuvedeno"}`,
    `Cena po slevě: ${summary?.totalPrice || "Neuvedeno"}`,
    `Odkaz na konfiguraci: ${summary?.url || "Neuvedeno"}`,
    "",
    "Rekapitulace konfigurace je v příloze.",
  ];

  return lines.join("\n");
}

function buildCustomerEmailText({ summary }) {
  return [
    "Dobrý den,",
    "",
    "děkujeme za Vaši poptávku. Rekapitulaci konfigurace posíláme v příloze.",
    "Co nejdříve se Vám ozveme a doladíme s Vámi další postup.",
    "",
    summary?.sofaName ? `Konfigurace: ${summary.sofaName}` : "",
    summary?.assemblyText ? `Sestava: ${summary.assemblyText}` : "",
    summary?.totalPrice ? `Cena po slevě: ${summary.totalPrice}` : "",
    "",
    "S pozdravem",
    "MADROS",
  ].filter(Boolean).join("\n");
}

function buildCustomerEmailHtml({ summary }) {
  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5">
      <p>Dobrý den,</p>
      <p>děkujeme za Vaši poptávku. Rekapitulaci konfigurace posíláme v příloze.</p>
      <p>Co nejdříve se Vám ozveme a doladíme s Vámi další postup.</p>
      ${summary?.sofaName ? `<p><strong>Konfigurace:</strong> ${escapeHtml(summary.sofaName)}</p>` : ""}
      ${summary?.assemblyText ? `<p><strong>Sestava:</strong> ${escapeHtml(summary.assemblyText)}</p>` : ""}
      ${summary?.totalPrice ? `<p><strong>Cena po slevě:</strong> ${escapeHtml(summary.totalPrice)}</p>` : ""}
      <p>S pozdravem<br>MADROS</p>
    </div>
  `;
}

function buildInquiryEmailHtml({ customerEmail, summary }) {
  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5">
      <h2>Nová poptávka z 3D konfigurátoru</h2>
      <p><strong>Email zákazníka:</strong> ${escapeHtml(customerEmail)}</p>
      <p><strong>Model:</strong> ${escapeHtml(summary?.sofaName || "Neuvedeno")}</p>
      <p><strong>Typ sestavy:</strong> ${escapeHtml(summary?.assemblyType || "Neuvedeno")}</p>
      <p><strong>Sestava:</strong> ${escapeHtml(summary?.assemblyText || "Neuvedeno")}</p>
      <p><strong>Cena po slevě:</strong> ${escapeHtml(summary?.totalPrice || "Neuvedeno")}</p>
      <p><strong>Odkaz na konfiguraci:</strong> ${summary?.url ? `<a href="${escapeHtml(summary.url)}">${escapeHtml(summary.url)}</a>` : "Neuvedeno"}</p>
      <p>Rekapitulace konfigurace je v příloze.</p>
    </div>
  `;
}

async function handleInquiryRequest(req, res) {
  try {
    await loadLocalEnv();
    const { customerEmail, filename, html, summary } = await readJsonBody(req);
    const email = String(customerEmail || "").trim();

    if (!isValidEmail(email)) {
      sendText(res, 400, "Zadejte prosím platný email.");
      return;
    }

    if (!html || typeof html !== "string") {
      sendText(res, 400, "Missing HTML");
      return;
    }

    const config = assertMailConfigured();
    const transporter = createMailTransport(config);
    const safeFilename = sanitizeFilename(filename || "rekapitulace.pdf");
    const pdfBuffer = await renderPdfFromHtml(html);
    const attachment = {
      filename: safeFilename,
      content: pdfBuffer,
      contentType: "application/pdf",
    };
    const sofaName = summary?.sofaName || "konfigurace";

    await transporter.sendMail({
      from: config.from,
      to: email,
      subject: "Děkujeme za poptávku | MADROS",
      text: buildCustomerEmailText({ summary }),
      html: buildCustomerEmailHtml({ summary }),
      attachments: [attachment],
    });

    await transporter.sendMail({
      from: config.from,
      to: config.to,
      replyTo: email,
      subject: `Nová poptávka na pohovku - ${sofaName}`,
      text: buildInquiryEmailText({ customerEmail: email, summary }),
      html: buildInquiryEmailHtml({ customerEmail: email, summary }),
      attachments: [attachment],
    });

    res.writeHead(200, {
      ...getCorsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Inquiry email error:", error);
    sendText(res, statusCode, error.message || "Poptávku se nepodařilo odeslat.");
  }
}

function startPdfServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, getCorsHeaders());
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "", "http://localhost");

    if (req.method === "GET" && requestUrl.pathname === "/api/pdf-asset") {
      await handlePdfAssetRequest(req, res);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/export-recap-pdf") {
      await handlePdfExportRequest(req, res);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/send-recap-inquiry") {
      await handleInquiryRequest(req, res);
      return;
    }

    sendText(res, 404, "Not found");
  });

  server.listen(PORT, () => {
    console.log(`PDF export server listening on http://localhost:${PORT}`);
  });

  return server;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  await browser?.close().catch(() => {});
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});

if (require.main === module) {
  startPdfServer();
}

module.exports = {
  closeBrowser,
  handlePdfAssetRequest,
  handlePdfExportRequest,
  handleInquiryRequest,
  startPdfServer,
};
