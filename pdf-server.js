const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");

/*
  Render + mail.webglobe.cz:
  snažíme se všude preferovat IPv4, protože IPv6 spojení padá na ENETUNREACH.
*/
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (error) {
  console.warn("DNS ipv4first setup failed:", error.message);
}

const nodemailer = require("nodemailer");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

const PORT = Number(process.env.PDF_PORT || 3001);
const MAX_BODY_SIZE = 50 * 1024 * 1024;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const ENV_PATH = path.resolve(__dirname, ".env");
const SHARE_CONFIG_DIR = path.resolve(__dirname, ".share-configs");
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{6,32}$/;

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

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  sendBuffer(res, statusCode, body, "application/json; charset=utf-8", {
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
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

  /*
    Když SMTP_HOST nastavíme na IPv4 adresu, TLS certifikát pořád patří
    doméně mail.webglobe.cz. Proto potřebujeme servername zvlášť.
  */
  const servername =
    process.env.SMTP_TLS_SERVERNAME ||
    process.env.SMTP_SERVERNAME ||
    host;

  const secureValue = String(process.env.SMTP_SECURE || "").toLowerCase();
  const secure = secureValue
    ? ["1", "true", "yes"].includes(secureValue)
    : port === 465;

  return { from, host, pass, port, secure, servername, to, user };
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
  const smtpHost = String(config.host || "").trim();
  const smtpServername = String(config.servername || smtpHost).trim();
  const isSecurePort = Number(config.port) === 465;

  return nodemailer.createTransport({
    host: smtpHost,
    port: config.port,

    /*
      465 = přímé TLS, secure true
      587 = STARTTLS, secure false + requireTLS true
    */
    secure: isSecurePort,

    /*
      DŮLEŽITÉ PRO RENDER:
      vynutíme IPv4, aby se znovu nepoužil IPv6 záznam.
    */
    family: 4,

    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { family: 4, all: false }, callback);
    },

    /*
      Pro 587 chceme STARTTLS.
      Pro 465 už je TLS od začátku.
    */
    requireTLS: !isSecurePort,

    tls: {
      servername: smtpServername,
      minVersion: "TLSv1.2",
    },

    auth: {
      user: config.user,
      pass: config.pass,
    },

    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });
}

function parseEmailAddress(value, fallbackEmail = "") {
  const raw = String(value || "").trim();

  const match = raw.match(/^(.*?)<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^["']|["']$/g, "") || undefined,
      email: match[2].trim(),
    };
  }

  return {
    email: raw || fallbackEmail,
  };
}

function toAttachmentBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (content instanceof ArrayBuffer) return Buffer.from(new Uint8Array(content));
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }

  return Buffer.from(String(content || ""), "utf8");
}

async function sendBrevoEmail({ from, to, replyTo, subject, text, html, attachments = [] }) {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    throw new Error("Chybí BREVO_API_KEY v Render Environment.");
  }

  const sender = parseEmailAddress(from, "info@madros.cz");

  const recipients = String(to || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  if (!recipients.length) {
    throw new Error("Chybí příjemce e-mailu.");
  }

  const payload = {
    sender,
    to: recipients,
    subject,
    textContent: text || "",
    htmlContent: html || "",
  };

  if (replyTo) {
    payload.replyTo = parseEmailAddress(replyTo);
  }

  if (attachments.length) {
    payload.attachment = attachments.map((item) => ({
      name: item.filename || "priloha.pdf",
      content: toAttachmentBuffer(item.content).toString("base64"),
    }));
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Brevo API error ${response.status}: ${responseText}`);
  }

  return responseText ? JSON.parse(responseText) : { ok: true };
}

async function sendCustomerInquiryEmail({ config, customerEmail, summary, attachment }) {
  const subject = "Děkujeme za poptávku | MADROS";
  const text = buildCustomerEmailText({ summary });
  const html = buildCustomerEmailHtml({ summary });

  try {
    const transporter = createMailTransport(config);
    const info = await transporter.sendMail({
      from: config.from,
      to: customerEmail,
      replyTo: config.from,
      subject,
      text,
      html,
      attachments: [attachment],
    });

    return {
      provider: "smtp",
      result: {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
    };
  } catch (smtpError) {
    console.error("[Inquiry] Customer SMTP send failed, trying Brevo:", {
      name: smtpError.name,
      code: smtpError.code,
      command: smtpError.command,
      responseCode: smtpError.responseCode,
      response: smtpError.response,
      message: smtpError.message,
    });

    const brevoInfo = await sendBrevoEmail({
      from: config.from,
      to: customerEmail,
      replyTo: config.from,
      subject,
      text,
      html,
      attachments: [attachment],
    });

    return {
      provider: "brevo",
      result: brevoInfo,
    };
  }
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

function createShareToken() {
  return crypto.randomBytes(7)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getShareFilePath(token) {
  const clean = String(token || "").trim();
  if (!SHARE_TOKEN_RE.test(clean)) return null;
  return path.join(SHARE_CONFIG_DIR, `${clean}.json`);
}

function getModelFromSharedState(state) {
  const fromRoute = String(state?.route?.model || "").trim().toUpperCase();
  if (fromRoute && fromRoute !== "CUSTOM") return fromRoute;

  const firstVariant = String(state?.modules?.[0]?.variantId || "").trim();
  if (firstVariant.includes("_")) return firstVariant.split("_")[0].toUpperCase();

  return fromRoute || "";
}

function validateSharedConfigurationState(state) {
  if (!state || typeof state !== "object" || state.version !== 1) {
    const error = new Error("Sdílená konfigurace nemá platný formát.");
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(state.modules) || state.modules.length < 1) {
    const error = new Error("Sdílená konfigurace neobsahuje žádné moduly.");
    error.statusCode = 400;
    throw error;
  }

  return state;
}

function buildShareUrl(urlBase, token, state) {
  const model = getModelFromSharedState(state);
  let url;

  try {
    url = new URL(urlBase || "http://localhost:8080/");
  } catch (error) {
    url = new URL("http://localhost:8080/");
  }

  url.hash = "";
  url.search = "";
  url.searchParams.set("share", token);
  if (model) url.searchParams.set("model", model);

  return url.href;
}

function hasShareTokenUrl(urlValue) {
  try {
    return Boolean(new URL(urlValue).searchParams.get("share"));
  } catch (error) {
    return false;
  }
}

async function saveSharedConfigurationState(state) {
  validateSharedConfigurationState(state);
  await fs.mkdir(SHARE_CONFIG_DIR, { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    const token = createShareToken();
    const filePath = getShareFilePath(token);
    const payload = {
      version: 1,
      createdAt: new Date().toISOString(),
      state,
    };

    try {
      await fs.writeFile(filePath, JSON.stringify(payload), { flag: "wx" });
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  throw new Error("Nepodařilo se vytvořit krátký odkaz.");
}

async function readSharedConfigurationState(token) {
  const filePath = getShareFilePath(token);
  if (!filePath) {
    const error = new Error("Neplatný odkaz na sestavu.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return validateSharedConfigurationState(parsed?.state);
  } catch (error) {
    if (error.code === "ENOENT") {
      error.statusCode = 404;
      error.message = "Sestava pro tento odkaz nebyla nalezena.";
    }
    throw error;
  }
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

  try {
    const usePng = format === "png";
    let pipeline = sharp(buffer, {
      animated: false,
      limitInputPixels: 60 * 1000 * 1000,
    })
      .rotate()
      .resize({
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      });

    if (usePng) {
      pipeline = pipeline.png({
        compressionLevel: 6,
        adaptiveFiltering: false,
        effort: 4,
      });
    } else {
      pipeline = pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({
          quality: Math.round(quality * 100),
          mozjpeg: true,
          progressive: false,
        });
    }

    return {
      buffer: await pipeline.toBuffer(),
      mimeType: usePng ? "image/png" : "image/jpeg",
    };
  } catch (error) {
    console.warn("[PDF ASSET] sharp optimize failed, using original", {
      message: error?.message || String(error),
      mimeType,
      maxSize,
      quality,
      format,
    });
    return { buffer, mimeType };
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
    /*
      Zrychlení PDF:
      Původně se čekalo až 30 sekund na všechny obrázky/backgroundy/fonty.
      Na Render free to zbytečně prodlužovalo generování PDF.
    */
    const timeout = new Promise((resolve) => setTimeout(resolve, 1800));

    const imagePromises = Array.from(document.images || []).map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();

      return new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    });

    const fontsReady = document.fonts?.ready?.catch(() => {}) || Promise.resolve();

    await Promise.race([
      Promise.all([...imagePromises, fontsReady]),
      timeout,
    ]);
  });
}

async function renderPdfFromHtml(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setCacheEnabled(true).catch(() => {});

    await page.setViewport({
      width: 794,
      height: 1123,

      /*
        1 je rychlejší než 2.
        PDF bude pořád použitelné, ale Render nebude tolik trpět.
      */
      deviceScaleFactor: 1,
    });

    await page.emulateMediaType("print");

    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    await waitForPdfAssets(page);

    const pdfBuffer = await page.pdf({
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

    return toAttachmentBuffer(pdfBuffer);
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
    `Odkaz na sestavu: ${summary?.url || "Neuvedeno"}`,
    "",
    "Rekapitulace konfigurace je v příloze.",
  ];

  return lines.join("\n");
}

async function handleShareCreateRequest(req, res) {
  try {
    const { state, urlBase } = await readJsonBody(req);
    const token = await saveSharedConfigurationState(state);
    sendJson(res, 200, {
      ok: true,
      token,
      url: buildShareUrl(urlBase, token, state),
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Share config create error:", error);
    sendText(res, statusCode, error.message || "Krátký odkaz se nepodařilo vytvořit.");
  }
}

async function handleShareReadRequest(req, res, token) {
  try {
    const state = await readSharedConfigurationState(token);
    sendJson(res, 200, {
      ok: true,
      state,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Share config read error:", error);
    sendText(res, statusCode, error.message || "Sestavu se nepodařilo načíst.");
  }
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
    summary?.url ? `Odkaz na sestavu: ${summary.url}` : "",
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
      ${summary?.url ? `<p><strong>Odkaz na sestavu:</strong> <a href="${escapeHtml(summary.url)}">Otevřít sestavu v konfigurátoru</a></p>` : ""}
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
      <p><strong>Odkaz na sestavu:</strong> ${summary?.url ? `<a href="${escapeHtml(summary.url)}">Otevřít sestavu v konfigurátoru</a>` : "Neuvedeno"}</p>
      <p>Rekapitulace konfigurace je v příloze.</p>
    </div>
  `;
}

function decodePdfBase64Attachment(value) {
  const clean = String(value || "")
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/\s+/g, "");

  if (!clean) return null;

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("PDF příloha má neplatný formát.");
  }

  const buffer = Buffer.from(clean, "base64");

  if (!buffer.length) {
    throw new Error("PDF příloha je prázdná.");
  }

  return buffer;
}

async function buildInquiryPdfAttachment({ pdfBuffer, pdfBase64, html, safeFilename }) {
  const uploadedPdf = pdfBuffer || decodePdfBase64Attachment(pdfBase64);
  const attachmentBuffer = uploadedPdf || await renderPdfFromHtml(html);

  if (attachmentBuffer.subarray(0, 5).toString("utf8") !== "%PDF-") {
    throw new Error("Vygenerovaná PDF příloha nemá platný PDF formát.");
  }

  return {
    filename: safeFilename,
    content: attachmentBuffer,
    contentType: "application/pdf",
  };
}

async function handleInquiryRequestLegacy(req, res) {
  try {
    await loadLocalEnv();
    const { customerEmail, filename, html, pdfBase64, summary, shareState, shareUrlBase } = await readJsonBody(req);
    const email = String(customerEmail || "").trim();

    if (!isValidEmail(email)) {
      sendText(res, 400, "Zadejte prosím platný email.");
      return;
    }

    const hasPdfAttachment = Boolean(String(pdfBase64 || "").trim());

    if (!hasPdfAttachment && (!html || typeof html !== "string")) {
      sendText(res, 400, "Missing HTML");
      return;
    }

    const uploadedPdfBuffer = hasPdfAttachment ? decodePdfBase64Attachment(pdfBase64) : null;

    const config = assertMailConfigured();
    const transporter = createMailTransport(config);
    const emailSummary = { ...(summary || {}) };

    if (shareState && !hasShareTokenUrl(emailSummary.url)) {
      const token = await saveSharedConfigurationState(shareState);
      emailSummary.url = buildShareUrl(shareUrlBase || summary?.url, token, shareState);
    }

    const safeFilename = sanitizeFilename(filename || "rekapitulace.pdf");
    const pdfBuffer = await renderPdfFromHtml(html);
    const attachment = {
      filename: safeFilename,
      content: pdfBuffer,
      contentType: "application/pdf",
    };
    const sofaName = emailSummary?.sofaName || "konfigurace";

    await transporter.sendMail({
      from: config.from,
      to: email,
      subject: "Děkujeme za poptávku | MADROS",
      text: buildCustomerEmailText({ summary: emailSummary }),
      html: buildCustomerEmailHtml({ summary: emailSummary }),
      attachments: [attachment],
    });

    await transporter.sendMail({
      from: config.from,
      to: config.to,
      replyTo: email,
      subject: `Nová poptávka na pohovku - ${sofaName}`,
      text: buildInquiryEmailText({ customerEmail: email, summary: emailSummary }),
      html: buildInquiryEmailHtml({ customerEmail: email, summary: emailSummary }),
      attachments: [attachment],
    });

    res.writeHead(200, {
      ...getCorsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ ok: true, url: emailSummary.url || "" }));
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Inquiry email error:", error);
    sendText(res, statusCode, error.message || "Poptávku se nepodařilo odeslat.");
  }
}

async function handleTestEmailRequest(req, res) {
  try {
    await loadLocalEnv();

    const config = assertMailConfigured();

    console.log("[TestEmail] SMTP config", {
      smtpHost: config.host,
      smtpServername: config.servername,
      smtpPort: config.port,
      smtpSecure: config.secure,
      from: config.from,
      to: config.to,
      user: config.user,
    });

    console.log("[TestEmail] Sending via Brevo API...");

    const info = await sendBrevoEmail({
      from: config.from,
      to: config.to,
      replyTo: "test@madros.cz",
      subject: "Test interního e-mailu z MADROS konfigurátoru",
      text: [
        "Toto je test interního e-mailu z konfigurátoru.",
        "",
        `Odesílatel: ${config.from}`,
        `Příjemce: ${config.to}`,
        "",
        "Pokud tento e-mail dorazil, interní příjem přes Brevo funguje.",
      ].join("\n"),
      html: `
        <p>Toto je test interního e-mailu z konfigurátoru.</p>
        <p><strong>Odesílatel:</strong> ${escapeHtml(config.from)}</p>
        <p><strong>Příjemce:</strong> ${escapeHtml(config.to)}</p>
        <p>Pokud tento e-mail dorazil, interní příjem přes Brevo funguje.</p>
      `,
    });

    console.log("[TestEmail] Brevo email sent", info);

    sendJson(res, 200, {
      ok: true,
      provider: "brevo",
      result: info,
      config: {
        from: config.from,
        to: config.to,
      },
    });
  } catch (error) {
    console.error("[TestEmail] Error:", {
      name: error.name,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode,
      response: error.response,
      message: error.message,
      stack: error.stack,
    });

    sendJson(res, 500, {
      ok: false,
      name: error.name,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode,
      response: error.response,
      message: error.message,
    });
  }
}

async function handleInquiryRequest(req, res) {
  let responseSent = false;

  try {
    await loadLocalEnv();
    const { customerEmail, filename, html, pdfBase64, summary, shareState, shareUrlBase } = await readJsonBody(req);
    const email = String(customerEmail || "").trim();

    if (!isValidEmail(email)) {
      sendText(res, 400, "Zadejte prosím platný email.");
      return;
    }

    const hasPdfAttachment = Boolean(String(pdfBase64 || "").trim());

    if (!hasPdfAttachment && (!html || typeof html !== "string")) {
      sendText(res, 400, "Missing HTML");
      return;
    }

    const uploadedPdfBuffer = hasPdfAttachment ? decodePdfBase64Attachment(pdfBase64) : null;

    const config = assertMailConfigured();
    const emailSummary = { ...(summary || {}) };

    if (shareState && !hasShareTokenUrl(emailSummary.url)) {
      const token = await saveSharedConfigurationState(shareState);
      emailSummary.url = buildShareUrl(shareUrlBase || summary?.url, token, shareState);
    }

    const safeFilename = sanitizeFilename(filename || "rekapitulace.pdf");
    const sofaName = emailSummary?.sofaName || "konfigurace";

    sendJson(res, 200, {
      ok: true,
      queued: true,
      url: emailSummary.url || "",
    });
    responseSent = true;

    setImmediate(async () => {
      try {
        console.log("[Inquiry] Background send started", {
          toCustomer: email,
          toInternal: config.to,
          from: config.from,
          smtpHost: config.host,
          smtpServername: config.servername,
          smtpPort: config.port,
          smtpSecure: config.secure,
        });

        console.log("[Inquiry] Rendering PDF attachment...");

        const attachment = await buildInquiryPdfAttachment({
          pdfBuffer: uploadedPdfBuffer,
          pdfBase64,
          html,
          safeFilename,
        });

        console.log("[Inquiry] PDF attachment ready", {
          filename: safeFilename,
          sizeBytes: attachment.content.length,
        });

        console.log("[Inquiry] Sending customer email with PDF...");

        const customerInfo = await sendCustomerInquiryEmail({
          config,
          customerEmail: email,
          subject: "Děkujeme za poptávku | MADROS",
          summary: emailSummary,
          attachment,
        });

        console.log("[Inquiry] Customer email sent", customerInfo);

        console.log("[Inquiry] Sending internal email via Brevo with PDF...");

        const internalInfo = await sendBrevoEmail({
          from: config.from,
          to: config.to,
          replyTo: email,
          subject: `Nová poptávka na pohovku - ${sofaName}`,
          text: buildInquiryEmailText({ customerEmail: email, summary: emailSummary }),
          html: buildInquiryEmailHtml({ customerEmail: email, summary: emailSummary }),
          attachments: [attachment],
        });

        console.log("[Inquiry] Internal email sent via Brevo", {
          to: config.to,
          from: config.from,
          result: internalInfo,
        });

      } catch (error) {
        console.error("Inquiry email background send error:", {
          name: error.name,
          code: error.code,
          command: error.command,
          responseCode: error.responseCode,
          response: error.response,
          message: error.message,
          stack: error.stack,
        });
      }
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Inquiry email error:", error);
    if (!responseSent) {
      sendText(res, statusCode, error.message || "Poptávku se nepodařilo odeslat.");
    }
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

    if (req.method === "POST" && requestUrl.pathname === "/api/share-config") {
      await handleShareCreateRequest(req, res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/share-config/")) {
      const token = decodeURIComponent(requestUrl.pathname.slice("/api/share-config/".length));
      await handleShareReadRequest(req, res, token);
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

    if (req.method === "GET" && requestUrl.pathname === "/api/test-email") {
      await handleTestEmailRequest(req, res);
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
  handleShareCreateRequest,
  handleShareReadRequest,
  handleInquiryRequest,
  handleTestEmailRequest,
  startPdfServer,
};
