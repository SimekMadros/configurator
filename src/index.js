
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  modulesCatalog,
  moduleVariantIds,
  getCatalog,
  getModulePrice,
  formatCzk,
  bboxSizeCmFromThreeSize,
  FABRICS,
} from "./catalogue.js";
import {
  filterVariantIdsForPicker,
  canAttach,
  shouldHaveButtons,
  getRole
} from "./connectionRules.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getVariantIdsForSofa, normalizeSofaKey } from "./catalogue.js";

const LOCAL_ASSET_ROOTS = ["/images/", "/textures/", "/models/", "/thumbs/", "/sw.js"];

const API_BASE_URL = "https://madros-configurator-api.onrender.com";

function apiUrl(path) {
  const raw = String(path || "");
  if (!raw) return API_BASE_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${API_BASE_URL}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

const DEBUG_LOGS =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search || "").has("debug");
const ORIGINAL_CONSOLE_LOG =
  typeof console !== "undefined" && console?.log?.bind
    ? console.log.bind(console)
    : null;

function debugLog(...args) {
  if (DEBUG_LOGS && ORIGINAL_CONSOLE_LOG) ORIGINAL_CONSOLE_LOG(...args);
}

function getAppBasePath() {
  if (typeof window === "undefined") return "/";
  const path = window.location.pathname || "/";
  return path.endsWith("/") ? path : path.replace(/\/[^/]*$/, "/");
}

function isLocalRootAssetPath(url) {
  const raw = String(url || "");
  return LOCAL_ASSET_ROOTS.some((prefix) => raw.startsWith(prefix));
}

function assetUrl(url) {
  const raw = String(url || "");
  if (!raw || typeof window === "undefined") return raw;
  if (/^(?:data:|blob:|https?:|mailto:|tel:|#)/i.test(raw)) return raw;
  if (!isLocalRootAssetPath(raw)) return raw;
  return `${getAppBasePath()}${raw.replace(/^\/+/, "")}`;
}

function rewriteLocalAssetUrlsInCss(value) {
  const raw = String(value || "");
  if (!raw || !raw.includes("url(")) return raw;

  return raw.replace(/url\(\s*(['"]?)([^"')]+)\1\s*\)/g, (full, _quote, url) => {
    const next = assetUrl(url.trim());
    return next === url ? full : `url("${next.replace(/"/g, "%22")}")`;
  });
}

function normalizeLocalAssetUrls(root = document) {
  if (!root?.querySelectorAll) return;

  const elements = [
    ...(root.nodeType === 1 ? [root] : []),
    ...root.querySelectorAll("*"),
  ];

  elements.forEach((el) => {
    const current = el.getAttribute("src");
    const next = current ? assetUrl(current) : current;
    if (next && next !== current) el.setAttribute("src", next);

    const style = el.getAttribute("style");
    const nextStyle = style ? rewriteLocalAssetUrlsInCss(style) : style;
    if (nextStyle && nextStyle !== style) el.setAttribute("style", nextStyle);
  });
}

if (typeof window !== "undefined") {
  THREE.DefaultLoadingManager.setURLModifier((url) => assetUrl(url));

  window.madrosAssetUrl = assetUrl;

  document.addEventListener("DOMContentLoaded", () => {
    normalizeLocalAssetUrls(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          normalizeLocalAssetUrls(mutation.target?.parentElement || document);
          continue;
        }

        mutation.addedNodes.forEach((node) => {
          if (node?.nodeType !== 1) return;
          normalizeLocalAssetUrls(node);
        });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style"],
    });
  });
}

// =======================
// DISCOUNT (jedno ÄŤĂ­slo)
// =======================
const DISCOUNT_PERCENT = 20; // <- zmÄ›Ĺ jen tohle (0 = bez slevy, 15 = -15%, ...)

function getDiscountPercent() {
  const p = Number(DISCOUNT_PERCENT);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(99, Math.round(p)));
}

function getDiscountedAmount(amount) {
  const p = getDiscountPercent();
  const base = Number(amount) || 0;
  if (p <= 0) return { hasDiscount: false, base, final: base, percent: 0 };

  // zaokrouhlenĂ­ na celĂ© KÄŤ (kdyĹľ chceĹˇ jinak, Ĺ™ekni a upravĂ­m)
  const final = Math.round(base * (1 - p / 100));
  return { hasDiscount: true, base, final, percent: p };
}

/**
 * VykreslĂ­ cenu do elementu:
 * - bez slevy: ÄŤistĂ˝ text jako dĹ™Ă­v
 * - se slevou: starĂˇ pĹ™eĹˇkrtnutĂˇ + novĂˇ + badge "-XX%"
 */
function renderPriceWithDiscount(el, amount, { prefix = "" } = {}) {
  if (!el) return;

  const d = getDiscountedAmount(amount);

  // 0% â†’ zachovat pĹ™esnÄ› starĂ© chovĂˇnĂ­ (jen textContent)
  if (!d.hasDiscount) {
    el.classList.remove("hasDiscount");
    el.textContent = `${prefix}${formatCzk(d.base)}`;
    return;
  }

  el.classList.add("hasDiscount");
  el.innerHTML = "";

  const wrap = document.createElement("span");
  wrap.className = "priceWithDiscount";

  const oldEl = document.createElement("span");
  oldEl.className = "priceOld";
  oldEl.textContent = `${prefix}${formatCzk(d.base)}`;

  const newEl = document.createElement("span");
  newEl.className = "priceNew";
  newEl.textContent = `${prefix}${formatCzk(d.final)}`;

  const badge = document.createElement("span");
  badge.className = "discountBadge";
  badge.textContent = `-${d.percent}%`;

  wrap.appendChild(oldEl);
  wrap.appendChild(newEl);
  wrap.appendChild(badge);
  el.appendChild(wrap);
}

// ===== APP ROUTER (landing <-> configurator + steps) =====

const appState = {
  step: 1,
  model: null,
  unlockedStep: 1, // đź‘ nejvyĹˇĹˇĂ­ odemÄŤenĂ˝ krok
};

function pushRoute(replace = false) {
  const state = {
    view: document.getElementById("viewConfigurator").classList.contains("activeView")
      ? "configurator"
      : "landing",
    step: appState.step,
    model: appState.model,
    unlockedStep: appState.unlockedStep,
  };

  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  url.searchParams.set("step", String(state.step));
  url.searchParams.set("unlocked", String(state.unlockedStep || 1));
  if (state.model) url.searchParams.set("model", state.model);
  else url.searchParams.delete("model");

  history[replace ? "replaceState" : "pushState"](state, "", url);
}

function showView(viewName, { push = true } = {}) {

  document.documentElement.setAttribute("data-view", viewName);

  const landing = document.getElementById("viewLanding");
  const configurator = document.getElementById("viewConfigurator");

  if (viewName === "landing") {
    landing.classList.add("activeView");
    configurator.classList.remove("activeView");
  } else {
    landing.classList.remove("activeView");
    configurator.classList.add("activeView");

    setTimeout(() => {
      if (renderer && camera) {
        const root = document.getElementById("threeRoot");
        const w = root.clientWidth;
        const h = root.clientHeight;

        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }, 50);
  }

  if (push) pushRoute(false);
}

function getStepEl(barSelector, step) {
  return document.querySelector(`${barSelector} .step[data-step="${step}"]`);
}

// ===== STEP HINT PORTAL (VARIANTA A) =====

let _portalEl = null;
let _portalBubble = null;
let _hideT = null;
let _anchorEl = null;

function ensureStepHintPortal() {
  if (_portalEl && _portalBubble) return _portalBubble;

  _portalEl = document.getElementById("stepHintPortal");
  if (!_portalEl) {
    console.warn('Chybí <div id="stepHintPortal"></div> v HTML.');
    return null;
  }

  _portalBubble = document.createElement("div");
  _portalBubble.className = "stepHint";
  _portalBubble.style.display = "none";
  _portalEl.appendChild(_portalBubble);

  // pĹ™i resize/scroll pĹ™epoÄŤĂ­tat pozici (kdyĹľ je vidÄ›t)
  const reposition = () => {
    if (_portalBubble.style.display === "none") return;
    if (!_anchorEl) return;
    positionPortalHint(_anchorEl);
  };

  window.addEventListener("resize", reposition, { passive: true });
  window.addEventListener("scroll", reposition, { passive: true });

  return _portalBubble;
}

function hidePortalHint() {
  const bubble = ensureStepHintPortal();
  if (!bubble) return;
  bubble.style.display = "none";
  bubble.textContent = "";
  _anchorEl = null;
  if (_hideT) clearTimeout(_hideT);
  _hideT = null;
}

function positionPortalHint(anchorEl) {
  const bubble = _portalBubble;
  if (!bubble || !anchorEl) return;

  const r = anchorEl.getBoundingClientRect();

  // nejdĹ™Ă­v zobrazĂ­me, aĹĄ znĂˇme rozmÄ›ry bubliny
  bubble.style.display = "block";
  bubble.style.left = "0px";
  bubble.style.top = "0px";

  const br = bubble.getBoundingClientRect();

  // vĂ˝chozĂ­ pozice: NAD stepem (aby to bylo nad Ĺˇipkou i nad stepbarem)
  const gap = 12;
  let x = r.left + r.width / 2 - br.width / 2;
  let y = r.top - br.height - gap;

  // kdyĹľ by to nahoĹ™e nevlezlo, hoÄŹ to POD step
  if (y < 8) y = r.bottom + gap;

  // clamp do viewportu
  const pad = 12;
  x = Math.max(pad, Math.min(x, window.innerWidth - br.width - pad));
  y = Math.max(pad, Math.min(y, window.innerHeight - br.height - pad));

  bubble.style.left = `${Math.round(x)}px`;
  bubble.style.top = `${Math.round(y)}px`;
}

function showHintUnderStep(stepEl, text) {
  const bubble = ensureStepHintPortal();
  if (!bubble || !stepEl) return;

  // nastav obsah
  bubble.textContent = text;

  // uloĹľit anchor pro reposition
  _anchorEl = stepEl;

  // spoÄŤĂ­tat pozici
  positionPortalHint(stepEl);

  // auto-hide po chvilce
  if (_hideT) clearTimeout(_hideT);
  _hideT = setTimeout(() => {
    hidePortalHint();
  }, 3000);
}

function pulseStep(stepEl) {
  if (!stepEl) return;
  stepEl.classList.remove("stepWarn");
  void stepEl.offsetWidth; // restart animace
  stepEl.classList.add("stepWarn");
  clearTimeout(stepEl._t);
  stepEl._t = setTimeout(() => stepEl.classList.remove("stepWarn"), 700);
}

function updateStepLocks() {
  const unlocked = appState.unlockedStep || 1;

  ["#stepBar", "#stepBarLanding"].forEach(sel => {
    document.querySelectorAll(`${sel} .step`).forEach(el => {
      const s = Number(el.dataset.step);
      el.classList.toggle("locked", s > unlocked);
      el.classList.toggle("highest", s === unlocked);
    });
  });
}

function unlockStep(step) {
  appState.unlockedStep = Math.max(appState.unlockedStep || 1, step);
  updateStepLocks();
  saveStateDebounced();
}

function setUnlockedStep(step) {
  appState.unlockedStep = Math.max(1, step);
  updateStepLocks();
  saveStateDebounced();
}

function unlockStepWhenContinueReady(nextStep) {
  if ((appState.unlockedStep || 1) >= nextStep) return;
  unlockStep(nextStep);
}

function unlockMaterialStepsWhenReady() {
  if (isRestoringState) return;
  if (!activeModules.length) return;
  if (!areExtrasSelectionsComplete()) return;

  unlockStepWhenContinueReady(4);

  try {
    reapplyCurrentFabricAndPaspuleIfSelected?.();
  } catch (e) {
    console.warn("Reapply fabric/paspule before material unlock failed:", e);
  }

  const materialValidation = getStep4MaterialValidation?.();
  if (materialValidation?.ok) {
    unlockStepWhenContinueReady(5);
  }
}

let isReconcilingStepLocks = false;

function relockStepsAfter(step, { redirect = true } = {}) {
  const cap = Math.max(1, Number(step) || 1);
  const currentUnlocked = appState.unlockedStep || 1;
  const needsRouteUpdate = currentUnlocked > cap;

  if (needsRouteUpdate) {
    setUnlockedStep(cap);
  }

  if (redirect && appState.step > cap) {
    setStep(cap, { push: false });
    pushRoute(true);
    return;
  }

  if (needsRouteUpdate) {
    pushRoute(true);
  }
}

function reconcileStepLocksWithCurrentValidity() {
  if (isRestoringState) return;
  if (isReconcilingStepLocks) return;

  isReconcilingStepLocks = true;
  try {
    if (activeModules.length < 1) {
      relockStepsAfter(2);
      return;
    }

    if (!areExtrasSelectionsComplete()) {
      relockStepsAfter(3);
      return;
    }

    unlockMaterialStepsWhenReady();

    const materialValidation = getStep4MaterialValidation?.();
    if (materialValidation && !materialValidation.ok) {
      relockStepsAfter(4);
    }
  } finally {
    isReconcilingStepLocks = false;
  }
}

function refreshStepValidityAfterCompositionChange() {
  try { updateStep2ContinueUI(); } catch (e) {}
  try { updateStep3ContinueUI(); } catch (e) {}
  try { updateStep4ContinueUI(); } catch (e) {}
  try { reconcileStepLocksWithCurrentValidity(); } catch (e) {}
}

function requiredTextForStep(targetStep) {
  // targetStep = zamÄŤenĂ˝, unlocked = nejvyĹˇĹˇĂ­ hotovĂ˝
  const unlocked = appState.unlockedStep || 1;

  // Krok 1/2 gating â€“ podle toho co popisujeĹˇ
  if (unlocked < 2) return "Nejdřív vyberte typ sedací soupravy v kroku 1.";
  if (unlocked < 3) return "Nejdřív v kroku 2 sestavte pohovku.";
  if (unlocked < 4) return "Nejdřív dokončete krok 3 (vybavení).";
  if (unlocked < 5) {
    const validation = getStep4MaterialValidation?.();
    return validation?.message || "Nejdřív dokončete krok 4 (materiál).";
  }

  return "Nejdřív dokončete předchozí krok.";
}

async function handleStepClick(targetStep, originBarSelector) {
  const unlocked = appState.unlockedStep || 1;

  // Krok 1 = landing (3D stav se nemaĹľe â€“ jen pĹ™epne view)
  if (targetStep === 1) {
    showView("landing", { push: false });
    setStep(1, { push: false });
    pushRoute(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  // zamÄŤeno?
  if (targetStep > unlocked) {
    const clickedEl = getStepEl(originBarSelector, targetStep);
    const highestEl = getStepEl(originBarSelector, unlocked);

    showHintUnderStep(clickedEl, requiredTextForStep(targetStep));
    pulseStep(highestEl);
    return;
  }

  if (targetStep >= 4 && !areExtrasSelectionsComplete()) {
    const clickedEl = getStepEl(originBarSelector, targetStep);
    showHintUnderStep(clickedEl, "Nejdřív prosím vyberte příplatky u všech modulů.");
    pulseStep(getStepEl(originBarSelector, 3));
    reconcileStepLocksWithCurrentValidity();
    return;
  }

  if (appState.step === 3 && targetStep >= 4) {
    const legsOk = await confirmLegsBeforeLeavingStep3();
    if (!legsOk) return;
  }

  if (targetStep === 5) {
    const validation = getStep4MaterialValidation();
    if (!validation.ok) {
      const clickedEl = getStepEl(originBarSelector, targetStep);
      showHintUnderStep(clickedEl, validation.message);
      pulseStep(getStepEl(originBarSelector, 4));
      return;
    }
  }

  // kdyĹľ odchĂˇzĂ­m z kroku 2 do jinĂ©ho kroku v topbaru,
  // nejdĹ™Ă­v spusĹĄ canonical rebuild flow stejnÄ› jako na "PokraÄŤovat"
  if (appState.step === 2 && targetStep >= 3) {
    await runCanonicalRebuildBeforeLeavingStep2(targetStep);

    // kdyĹľ jdu do 3+, chci mĂ­t aspoĹ odemÄŤenĂ˝ krok 3
    unlockStep(3);
    reconcileStepLocksWithCurrentValidity();

    if (targetStep >= 4 && !areExtrasSelectionsComplete()) {
      const clickedEl = getStepEl(originBarSelector, targetStep);
      showHintUnderStep(clickedEl, "Nejdřív prosím vyberte příplatky u všech modulů.");
      pulseStep(getStepEl(originBarSelector, 3));
      return;
    }

    if (targetStep === 5) {
      const validation = getStep4MaterialValidation();
      if (!validation.ok) {
        const clickedEl = getStepEl(originBarSelector, targetStep);
        showHintUnderStep(clickedEl, validation.message);
        pulseStep(getStepEl(originBarSelector, 4));
        return;
      }
    }
  }

  // povoleno â†’ konfigurĂˇtor
  showView("configurator", { push: false });
  await setStep(targetStep, { push: false });
  pushRoute(false);
}

async function setStep(step, { push = true } = {}) {
  if (appState.step === 5 && step !== 5 && recapDimsEditMode) {
    exitRecapDimsEditMode({ save: true, render: false });
  }

  appState.step = step;

  // update step bar in configurator
  document.querySelectorAll("#stepBar .step").forEach(el => {
    el.classList.toggle("active", Number(el.dataset.step) === step);
  });

  // update step bar in landing
  document.querySelectorAll("#stepBarLanding .step").forEach(el => {
    el.classList.toggle("active", Number(el.dataset.step) === step);
  });

  // pozdÄ›ji: stanice kamery
  // goToStation(step);

  updateStep2ContinueUI();
  updateStep3ContinueUI();
  updateStep4ContinueUI();

  const configuratorView = document.getElementById("viewConfigurator");
  const recapView = document.getElementById("recapView");
  configuratorView?.classList.toggle("is-recap", step === 5);
  recapView?.classList.toggle("hidden", step !== 5);
  if (step === 5) {
    requestAnimationFrame(() => {
      try { renderRecapView(); } catch (e) { console.error("renderRecapView failed:", e); }
    });
  }

  updateBottomBarUI();
  updateBuildModeUI();

  updateHeadrestDotsVisibility();

  // kdyĹľ se vrĂˇtĂ­m do kroku 3 a uĹľ jsem na tabu "PĹ™Ă­platky",
  // tak musĂ­m znovu pĹ™erenderovat seznam (protoĹľe ve 2. kroku se mohly zmÄ›nit moduly)
  if (isHeadrestStepActive() && currentEquipTabKey === "extras") {
    renderExtrasModuleList();
  }

  if (isBuildStepActive()) {
    updateButtons();
  }

  if (push) pushRoute(false);

  saveStateDebounced();

  document.getElementById("btnCamClearAll")?.classList.toggle("isHidden", !isBuildStepActive());
}

function updateStep2ContinueUI() {
  const btn = document.getElementById("btnStep2Continue");
  if (!btn) return;

  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");

  const shouldShow = isConfigurator && appState.step === 2;

  // show/hide
  btn.classList.toggle("hidden", !shouldShow);

  // enable only if there is 1+ module in scene
  const canContinue = activeModules.length >= 1;
  btn.disabled = !canContinue;

  if (shouldShow && canContinue) {
    unlockStepWhenContinueReady(3);
  }
}

function updateStep3ContinueUI() {
  const btn = document.getElementById("btnStep3Continue");
  if (!btn) return;

  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");

  const shouldShow = isConfigurator && appState.step === 3;

  // show/hide
  btn.classList.toggle("hidden", !shouldShow);

  // zĂˇkladnĂ­ podmĂ­nka: musĂ­ existovat aspoĹ 1 modul
  const baseOk = activeModules.length >= 1;

  // extra podmĂ­nka: pokud jsem v tabu PĹ™Ă­platky, musĂ­ mĂ­t kaĹľdĂ˝ eligible modul volbu
  const extrasOk = areExtrasSelectionsComplete();

  // POZOR: nechĂˇme disabled jen pro "baseOk" (kdyĹľ nejsou moduly).
  // KdyĹľ nejsou zvolenĂ© pĹ™Ă­platky, nechĂˇme tlaÄŤĂ­tko klikatelnĂ©, ale â€śzamÄŤenĂ©â€ť pĹ™es class + dataset,
  // aby Ĺˇla vypsat hlĂˇĹˇka po kliku.
  btn.disabled = !baseOk;

  const blockedByExtras = baseOk && !extrasOk;
  btn.classList.toggle("is-locked", blockedByExtras);
  btn.dataset.blockedByExtras = blockedByExtras ? "1" : "0";

  if (shouldShow && baseOk && extrasOk) {
    unlockMaterialStepsWhenReady();
  }

  reconcileStepLocksWithCurrentValidity();
}

function getSelectedMainFabricForStep4() {
  const tabKey = getAppliedFabricTabKey();
  const selected = getSelectedFabricForTabKey(tabKey);

  if (!isValidStep4FabricSelection(selected, "sofa")) return null;

  return { tabKey, selected };
}

function normalizeTextureUrlForValidation(url) {
  try {
    return new URL(String(url || ""), window.location.href)
      .pathname
      .replace(/\\/g, "/")
      .toLowerCase();
  } catch (e) {
    return String(url || "").replace(/\\/g, "/").toLowerCase();
  }
}

const DEFAULT_PASPULE_COLOR_URL = "/textures/fabric/basecolor/Paspule-default.png";
const DEFAULT_FABRIC_COLOR_URL = "/textures/fabric/basecolor/basecolor_COL_VAR2_2K.jpg";

function isDefaultStep4BaseColorUrl(url, target = "sofa") {
  const normalized = normalizeTextureUrlForValidation(url);
  if (!normalized) return true;

  if (target === "paspule") {
    return normalized.includes(DEFAULT_PASPULE_COLOR_URL.toLowerCase());
  }

  return normalized.includes(DEFAULT_FABRIC_COLOR_URL.toLowerCase());
}

function isValidStep4FabricSelection(selected, target = "sofa") {
  if (!selected?.fabricKey || !selected?.shade || !selected?.baseColorUrl) return false;
  return !isDefaultStep4BaseColorUrl(selected.baseColorUrl, target);
}

function isPaspuleRequiredForStep4() {
  if (getModelKey() !== "MELBOURNE") return false;
  return !!getSelectedMainFabricForStep4();
}

function isPaspuleCompleteForStep4() {
  if (!isPaspuleRequiredForStep4()) return true;

  const ctx = getPaspuleFabricContext();
  if (!ctx?.family) return false;

  return !!(
    isValidStep4FabricSelection(selectedPaspuleFabric, "paspule") &&
    selectedPaspuleFabric?.fabricKey === ctx.family.key
  );
}

function getStep4MaterialValidation() {
  if (!getSelectedMainFabricForStep4()) {
    return {
      ok: false,
      reason: "fabric",
      message: "Nejdřív prosím vyberte potahovou látku.",
    };
  }

  if (!isPaspuleCompleteForStep4()) {
    return {
      ok: false,
      reason: "paspule",
      message: "Nejdřív prosím vyberte barvu paspule.",
    };
  }

  return { ok: true, reason: "", message: "" };
}

function updateStep4ContinueUI() {
  const btn = document.getElementById("btnStep4Continue");
  if (!btn) return;

  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");

  const shouldShow = isConfigurator && appState.step === 4;
  btn.classList.toggle("hidden", !shouldShow);

  const validation = getStep4MaterialValidation();
  btn.disabled = false;
  btn.classList.toggle("is-locked", shouldShow && !validation.ok);
  btn.dataset.blockReason = validation.reason || "";
  btn.dataset.blockMessage = validation.message || "";

  if (shouldShow && validation.ok) {
    unlockMaterialStepsWhenReady();
  }

  reconcileStepLocksWithCurrentValidity();
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getVariantModelKey(variantId) {
  const value = String(variantId || "").trim();
  if (!value) return "";
  return value.split("_")[0].toUpperCase();
}

function isManchesterSharpArmrestSelection(armrestType = selectedArmrests, modelKey = getModelKey()) {
  return (
    String(modelKey || "").trim().toUpperCase() === "MANCHESTER" &&
    String(armrestType || "").trim().toLowerCase() === "sharp"
  );
}

function getManchesterArmrestPriceKey(
  variantId,
  fabricId,
  baseUpgradeKey = null,
  {
    armrestType = selectedArmrests,
    modelKey = getVariantModelKey(variantId) || getModelKey(),
    disabled = false,
  } = {}
) {
  if (disabled || baseUpgradeKey) return baseUpgradeKey || null;
  if (!isManchesterSharpArmrestSelection(armrestType, modelKey)) return baseUpgradeKey || null;

  const cat = getCatalog?.(variantId);
  const armrestPrice = cat?.upgradePrices?.armrest?.[fabricId];
  return Number(armrestPrice) > 0 ? "armrest" : (baseUpgradeKey || null);
}

function getConfiguredTotalPrice() {
  let total = 0;

  for (const rec of activeModules || []) {
    if (!rec?.name) continue;
    const upgradeKey = getUpgradeKeyForRec(rec);
    total += getSummaryPriceForRecSafe(rec, getAppliedFabricPriceGroup(), upgradeKey);
  }

  return total;
}

function getAssemblyTypeLabel() {
  const branches = Number(document.getElementById("sofaDimsRows")?.dataset?.branches || 1);

  if (branches >= 4) return "Rozšířená sestava";
  if (branches === 3) return "U sestava";
  if (branches === 2) return "Rohová sestava";

  return "Rovná sestava";
}

function getRecapLegMeta() {
  const modelConfig = MODEL_EQUIP_CONFIG[getModelKey()] || {};
  return (modelConfig.legs || []).find((item) => item.code === selectedLegs) || null;
}

function getRecapArmrestMeta() {
  const modelConfig = MODEL_EQUIP_CONFIG[getModelKey()] || {};
  return (modelConfig.armrests || []).find((item) => item.code === selectedArmrests) || null;
}

function getRecapArmrestWidthLabel() {
  const cleanWidthText = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";

    // vezme první hodnotu typu "13 cm", "20cm", "25 cm" apod.
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*cm/i);
    if (!match) return "";

    return `${String(match[1]).replace(",", ".")} cm`;
  };

  // 1) Pevná šířka - priorita je text přímo v aktivním tlačítku v kroku 3,
  // protože tam je skutečná hodnota, např. "13 cm".
  if (window.selectedArmrestWidthIsFixed) {
    const fixedBtnText = cleanWidthText(
      document.getElementById("armrestWidthFixedBtn")?.textContent
    );

    if (fixedBtnText) return fixedBtnText;

    const fixedLabelText = cleanWidthText(window.selectedArmrestWidthFixedLabel);
    if (fixedLabelText) return fixedLabelText;

    return "Pevná šířka";
  }

  // 2) Nastavitelná šířka - priorita je slider / uložená hodnota.
  const value =
    Number(window.selectedArmrestWidth) ||
    Number(window.selectedArmrestSharpWidthCm) ||
    Number(document.getElementById("armrestWidthRange")?.value) ||
    20;

  if (window.selectedArmrestWidthMode === "custom") {
    return `${value} cm na míru`;
  }

  return `${value} cm`;
}

function getRecapHingeLabel() {
  const modelConfig = MODEL_EQUIP_CONFIG[getModelKey()] || {};
  const hinge = (modelConfig.hinges || []).find((item) => item.code === selectedHinges);
  return hinge?.label || selectedHinges || "Standard";
}

function getRecapHingeMeta() {
  const raw = String(selectedHinges || "").trim().toLowerCase();
  const label = String(getRecapHingeLabel() || "").trim().toLowerCase();

  // ČERNÉ / MATNÉ PANTY
  // U tebe se černé panty podle screenshotu ukládají jako "softclose",
  // proto ho tady bereme jako matnou černou.
  if (
    raw.includes("softclose") ||
    raw.includes("soft_close") ||
    raw.includes("black") ||
    raw.includes("matte") ||
    raw.includes("matna") ||
    raw.includes("matná") ||
    raw.includes("cerne") ||
    raw.includes("čern") ||
    label.includes("softclose") ||
    label.includes("soft close") ||
    label.includes("black") ||
    label.includes("matn") ||
    label.includes("čern") ||
    label.includes("cern")
  ) {
    return {
      label: "Matná černá",
      img: "/textures/metal/matte_black/mate-black-image.png",
    };
  }

  // LESKLÝ CHROM
  // Sem dávám i "standard", "hidden", "skryté" a prázdnou hodnotu,
  // aby se ti v rekapitulaci už neukazovalo Skryté jako default.
  if (
    !raw ||
    raw.includes("standard") ||
    raw.includes("chrome") ||
    raw.includes("chrom") ||
    raw.includes("silver") ||
    raw.includes("leskl") ||
    raw.includes("hidden") ||
    raw.includes("skryt") ||
    label.includes("standard") ||
    label.includes("chrom") ||
    label.includes("leskl") ||
    label.includes("skryt")
  ) {
    return {
      label: "Lesklý chrom",
      img: "/textures/metal/chrome/chrome-image.jpg",
    };
  }

  return {
    label: "Lesklý chrom",
    img: "/textures/metal/chrome/chrome-image.jpg",
  };
}

function getRecapLegColorMeta() {
  const select = document.getElementById("legsColorSelect");
  const id = select?.value || "";
  const label = select?.selectedOptions?.[0]?.textContent || id || "Nezvoleno";

  const activeTile = document.querySelector(`#legsColorGrid .tileCard[data-color="${CSS.escape(id)}"]`);
  const img = activeTile?.querySelector("img")?.getAttribute("src") || "";

  return { id, label, img };
}

function getRecapShelfColorMeta() {
  const id = selectedShelfColor || document.getElementById("shelfColorSelect")?.value || "";
  const match = (WOOD_COLORS_ALL || []).find((item) => item.id === id);
  return {
    id,
    label: match?.label || id || "Nezvoleno",
    img: match?.img || "",
  };
}

function getRecapSelectedFabric() {
  const tabKey = getAppliedFabricTabKey();
  const selected = getSelectedFabricForTabKey(tabKey);
  if (!selected?.fabricName && !selected?.fabricKey) return null;

  const groupLabel =
    tabKey === "cat3" ? "Kategorie 3" :
    tabKey === "cat2" ? "Kategorie 2" :
    tabKey === "leather" ? "Kůže" :
    "Kategorie 1";

  return { tabKey, groupLabel, selected };
}

function clampRecapDescriptionText(text, maxChars = 255) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "";

  if (clean.length <= maxChars) return clean;

  const shortened = clean.slice(0, maxChars).trim();
  const lastSpace = shortened.lastIndexOf(" ");

  return `${shortened.slice(0, lastSpace > 120 ? lastSpace : maxChars).trim()}…`;
}

function getRecapFabricFamilyMeta(fabricRecap) {
  const selected = fabricRecap?.selected || null;
  const tabKey = fabricRecap?.tabKey || getAppliedFabricTabKey();

  if (!selected?.fabricKey) return null;

  const family =
    getFabricFamilyByKey(tabKey, selected.fabricKey) ||
    findFabricFamilyByKeyAny?.(selected.fabricKey)?.family ||
    null;

  const info = family?.info || {};
  const brand = info.brandKey
    ? FABRIC_BRAND_INFO?.[info.brandKey]
    : null;

  const statValue = (wantedLabel) => {
    const wanted = String(wantedLabel || "").toLowerCase();

    const row = (info.stats || [])
      .find((item) => String(item?.label || "").toLowerCase().includes(wanted));

    if (!row) return "";

    if (Array.isArray(row.value)) return row.value.join(", ");
    return String(row.value || "").trim();
  };

  const fabricSummary =
    family?.summary ||
    info?.summary ||
    family?.desc ||
    info?.desc ||
    "";

  const description = clampRecapDescriptionText(fabricSummary, 255);

  return {
    family,
    info,
    brand,
    brandLabel: brand?.label || info.brand || info.brandLabel || "Neuvedeno",
    composition: statValue("složení") || info.composition || "Neuvedeno",
    resistance: statValue("odolnost") || info.resistance || "Neuvedeno",
    weight: statValue("gramáž") || info.weight || "Neuvedeno",
    care: brand?.maintenanceValue || family?.care || info.care || "Dle doporučení výrobce",
    category: fabricRecap?.groupLabel || "Neuvedeno",
    description,
  };
}

function renderRecapMaterial(host, fabricRecap) {
  if (!host) return;

  const selected = fabricRecap?.selected || null;

  if (!selected?.baseColorUrl) {
    host.innerHTML = `<div class="recapRow"><span>Zatím není vybráno</span><strong>-</strong></div>`;
    return;
  }

  const meta = getRecapFabricFamilyMeta(fabricRecap);
  const fabricName = `${selected.fabricName || selected.fabricKey || ""} ${selected.shade || ""}`.trim();

  const modelKey = getModelKey();

  const shouldShowMaterialDescription =
    modelKey !== "MANCHESTER" &&
    (
      modelKey !== "MELBOURNE" ||
      isMelbourneShelfAvailable()
    );

  const materialDescription = shouldShowMaterialDescription
    ? (
      meta?.description ||
      "Potahová látka vhodná pro každodenní používání s důrazem na komfort, odolnost a snadnou údržbu."
    )
    : "";

  const shouldShowPaspule =
    getModelKey() === "MELBOURNE" &&
    !!selectedPaspuleFabric?.baseColorUrl;

  const paspuleName = shouldShowPaspule
    ? `${selectedPaspuleFabric.fabricName || selectedPaspuleFabric.fabricKey || ""} ${selectedPaspuleFabric.shade || ""}`.trim()
    : "";

  const rows = [
    { label: "Značka", value: meta?.brandLabel || "Neuvedeno" },
    { label: "Složení", value: meta?.composition || "Neuvedeno" },
    { label: "Odolnost", value: meta?.resistance || "Neuvedeno" },
    { label: "Gramáž", value: meta?.weight || "Neuvedeno" },
    { label: "Údržba", value: meta?.care || "Dle doporučení výrobce" },
    { label: "Kategorie", value: meta?.category || fabricRecap?.groupLabel || "Neuvedeno" },
  ];

  host.innerHTML = `
    <div class="recapMaterialMain">
      <div class="recapMaterialSwatch" style="background-image:url('${escapeHtmlText(assetUrl(selected.baseColorUrl))}')"></div>

      <div class="recapMaterialHead">
        <span>Hlavní potah</span>
        <strong>${escapeHtmlText(fabricName || "Nezvoleno")}</strong>
      </div>

      ${shouldShowMaterialDescription ? `
        <div class="recapMaterialDescription">
          ${escapeHtmlText(materialDescription)}
        </div>
      ` : ""}

      <div class="recapMaterialInfo">
        ${rows.map((row) => `
          <div class="recapMaterialInfoRow">
            <span>${escapeHtmlText(row.label)}</span>
            <strong>${escapeHtmlText(row.value)}</strong>
          </div>
        `).join("")}
      </div>
    </div>

    ${shouldShowPaspule ? `
      <div class="recapMaterialPaspule">
        <div class="recapMaterialSwatch is-small" style="background-image:url('${escapeHtmlText(assetUrl(selectedPaspuleFabric.baseColorUrl))}')"></div>
        <div class="recapMaterialHead">
          <span>Paspule</span>
          <strong>${escapeHtmlText(paspuleName || "Nezvoleno")}</strong>
        </div>
      </div>
    ` : ""}
  `;
}

function getUpgradeLabelForRec(rec) {
  const choice = rec?.mesh ? (extrasChoiceByModuleUuid.get(rec.mesh.uuid) || "unset") : "unset";
  if (choice === "storage") return "Úložný prostor";
  if (choice === "bed") return getModelKey() === "MELBOURNE" ? "Rozklad (Belgický)" : "Rozklad (Manila)";
  if (choice === "bed2") return "Rozklad (Belgický)";
  return "";
}

function getRecapPartCode(variantId) {
  const raw = String(variantId || "").trim();
  const withoutModel = raw.includes("_") ? raw.split("_").slice(1).join("_") : raw;
  const normalized = withoutModel
    .replace(/^roh_[lp]$/i, "ROH")
    .replace(/_/g, "")
    .toUpperCase();

  return normalized || raw.toUpperCase();
}

let recapDimsEditMode = false;
let recapDimsEditDraft = {};
let recapImageCaptureSeq = 0;

function renderRecapRows(host, rows) {
  if (!host) return;
  const safeRows = (rows || []).filter(Boolean);

  host.innerHTML = safeRows.length
    ? safeRows.map((row) => `
      <div class="recapRow${row.className ? ` ${escapeHtmlText(row.className)}` : ""}">
        <span>${escapeHtmlText(row.label)}</span>
        <strong>${escapeHtmlText(row.value)}</strong>
      </div>
    `).join("")
    : `<div class="recapRow"><span>Zatím není vybráno</span><strong>-</strong></div>`;
}

function renderRecapDimensions(host, rows) {
  if (!host) return;
  const safeRows = (rows || []).filter(Boolean);

  if (!safeRows.length) {
    host.innerHTML = `<div class="recapRow"><span>Zatím není vybráno</span><strong>-</strong></div>`;
    return;
  }

  host.classList.toggle("is-editing", recapDimsEditMode);

  host.innerHTML = safeRows.map((row) => {
    if (!recapDimsEditMode) {
      return `
        <div class="recapRow">
          <span>${escapeHtmlText(row.label)}</span>
          <strong>${escapeHtmlText(row.value)}</strong>
        </div>
      `;
    }

    const draftValue = recapDimsEditDraft[row.dim] ?? row.valueNumber ?? "";

    return `
      <label class="recapDimEditRow" data-dim="${escapeHtmlText(row.dim)}">
        <span>
          ${escapeHtmlText(row.title)}
          <small>${escapeHtmlText(row.range || "")}</small>
        </span>
        <input
          class="recapDimInput"
          type="text"
          inputmode="numeric"
          value="${escapeHtmlText(draftValue)}"
          data-dim="${escapeHtmlText(row.dim)}"
          data-min="${escapeHtmlText(row.min)}"
          data-max="${escapeHtmlText(row.max)}"
          aria-label="${escapeHtmlText(row.title)}"
        />
      </label>
    `;
  }).join("") + (recapDimsEditMode ? `
    <div class="recapDimActions">
      <button type="button" class="recapDimCancelBtn" id="recapDimsCancelBtn">Zrušit</button>
      <button type="button" class="recapDimSaveBtn" id="recapDimsSaveBtn">Potvrdit rozměry</button>
    </div>
  ` : "");
}

function waitRecapFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function applyCurrentMaterialsBeforeRecapCapture() {
  const tabKey = getAppliedFabricTabKey();
  const selected = getSelectedFabricForTabKey(tabKey);

  if (selected?.baseColorUrl) {
    const family = getFabricFamilyByKey(tabKey, selected.fabricKey);
    await applyFabricToSofaByMaterialMap({
      fabricKey: selected.fabricKey || "",
      baseColorUrl: selected.baseColorUrl,
      normalUrl: selected.normalUrl,
      roughnessUrl: selected.roughnessUrl,
      repeat: family?.repeat ?? 2,
      normalScale: family?.normalScale ?? null,
    });
  }

  if (getModelKey() === "MELBOURNE" && selectedPaspuleFabric?.baseColorUrl) {
    const ctx = getPaspuleFabricContext();
    if (ctx?.family && ctx.family.key === selectedPaspuleFabric.fabricKey) {
      await applyFabricToPaspuleByMaterialMap({
        fabricKey: selectedPaspuleFabric.fabricKey || "",
        baseColorUrl: selectedPaspuleFabric.baseColorUrl,
        normalUrl: selectedPaspuleFabric.normalUrl,
        roughnessUrl: selectedPaspuleFabric.roughnessUrl,
        repeat: ctx.family.repeat ?? 2,
        normalScale: ctx.family.normalScale ?? null,
      });
    }
  }
}

async function renderRecapSofaImageDeferred() {
  const imageEl = document.getElementById("recapSofaImage");
  if (!imageEl) return;

  const seq = ++recapImageCaptureSeq;

  try {
    await applyCurrentMaterialsBeforeRecapCapture();
    await waitRecapFrame();
    await waitRecapFrame();

    if (seq !== recapImageCaptureSeq || appState.step !== 5) return;

    const img = captureRecapSofaImage();
    if (img) imageEl.src = img;
    else imageEl.removeAttribute("src");
  } catch (e) {
    console.warn("Recap deferred image capture failed:", e);
    if (seq === recapImageCaptureSeq) imageEl.removeAttribute("src");
  }
}

function renderRecapTiles(host, tiles) {
  if (!host) return;
  const safeTiles = (tiles || []).filter(Boolean);

  host.innerHTML = safeTiles.length
    ? safeTiles.map((tile) => {
      const media = tile.img
        ? `<img src="${escapeHtmlText(assetUrl(tile.img))}" alt="">`
        : "";
      const style = tile.swatch ? ` style="background-image:url('${escapeHtmlText(assetUrl(tile.swatch))}')"` : "";
      
      const mediaClass = [
        "recapTileMedia",
        tile.swatch ? "is-swatch" : "",
        tile.mediaClass || "",
      ].filter(Boolean).join(" ");

      const details = Array.isArray(tile.details) && tile.details.length
        ? `
          <div class="recapTileDetails">
            ${tile.details.filter(Boolean).map((detail) => `
              <div class="recapTileDetail">
                <span>${escapeHtmlText(detail.label)}</span>
                <strong>${escapeHtmlText(detail.value)}</strong>
              </div>
            `).join("")}
          </div>
        `
        : `<strong>${escapeHtmlText(tile.value)}</strong>`;

      return `
        <div class="recapTile${tile.className ? ` ${escapeHtmlText(tile.className)}` : ""}">
          <div class="${mediaClass}"${style}>${media}</div>
          <div class="recapTileText">
            <span>${escapeHtmlText(tile.label)}</span>
            ${details}
          </div>
        </div>
      `;
    }).join("")
    : `<div class="recapRow"><span>Zatím není vybráno</span><strong>-</strong></div>`;
}

function getRecapBranchCountSafe() {
  try {
    if (typeof detectBranchCount === "function") {
      return Math.max(1, Number(detectBranchCount() || 1));
    }
  } catch (e) {}

  try {
    if (typeof window !== "undefined" && typeof window.detectBranchCount === "function") {
      return Math.max(1, Number(window.detectBranchCount() || 1));
    }
  } catch (e) {}

  try {
    const fromDims = Number(document.getElementById("sofaDimsRows")?.dataset?.branches || 1);
    if (fromDims) return Math.max(1, fromDims);
  } catch (e) {}

  try {
    const topo =
      typeof window !== "undefined" && typeof window.__getPlanTopology === "function"
        ? window.__getPlanTopology()
        : null;

    return Math.max(1, Number(topo?.branchCount || 1));
  } catch (e) {}

  return 1;
}

function getRecapTopologySafe() {
  try {
    if (typeof window !== "undefined" && typeof window.__getPlanTopology === "function") {
      return window.__getPlanTopology();
    }
  } catch (e) {}

  try {
    if (typeof getPlanTopology === "function") {
      return getPlanTopology();
    }
  } catch (e) {}

  return null;
}

function getRecapLShapeCameraMeta() {
  const names = (activeModules || [])
    .map((rec) => String(
      rec?.name ||
      rec?.variantId ||
      rec?.mesh?.userData?.variantId ||
      ""
    ).trim())
    .filter(Boolean);

  const hasRightCorner = names.some((name) =>
    /_roh_p$/i.test(name)
  );

  const hasLeftCorner = names.some((name) =>
    /_roh_l$/i.test(name)
  );

  const hasRightDualAxis = names.some((name) =>
    /_1x?d_p$/i.test(name) ||
    /_1x?dp$/i.test(name)
  );

  const hasLeftDualAxis = names.some((name) =>
    /_1x?d_l$/i.test(name) ||
    /_1x?dl$/i.test(name)
  );

  // Směr:
  // P varianta = kamera tak, jak ti teď funguje dobře
  // L varianta = zrcadlově otočená kamera
  let sideSign = 1;
  let sideSource = "topology";

  if (hasRightCorner || hasRightDualAxis) {
    sideSign = -1;
    sideSource = "module-p";
  } else if (hasLeftCorner || hasLeftDualAxis) {
    sideSign = 1;
    sideSource = "module-l";
  } else {
    const topo = getRecapTopologySafe();
    const lSide = String(topo?.lSide || "left").toLowerCase();
    sideSign = lSide === "right" ? -1 : 1;
  }

  const endpointKind =
    (hasRightCorner || hasLeftCorner)
      ? "corner"
      : (hasRightDualAxis || hasLeftDualAxis)
        ? "dualAxis"
        : "unknown";

  // TADY SI LADÍŠ ÚHEL:
  // dualAxis = 1D / 1XD sestavy
  // corner = klasický roh_L / roh_P
  const dims = window.__sofaDims || {};
  const width = Number(dims.W || dims.width || 0);
  const depth = Math.max(
    Number(dims.L || 0),
    Number(dims.R || 0),
    Number(dims.D || dims.depth || 0)
  );

  const depthRatio =
    width > 0 && depth > 0
      ? THREE.MathUtils.clamp(depth / width, 0.35, 1.15)
      : 0.65;

  // 0 = dlouhá hlavní větev + krátká boční větev
  // 1 = větve jsou podobně dlouhé / hluboké L
  const shapeDepthFactor = THREE.MathUtils.smoothstep(depthRatio, 0.42, 1.00);

  const autoCornerAmount = THREE.MathUtils.lerp(0.34, 0.60, shapeDepthFactor);
  const autoDualAxisAmount = THREE.MathUtils.lerp(0.20, 0.32, shapeDepthFactor);

  const xAmount =
    endpointKind === "corner" ? autoCornerAmount :
    endpointKind === "dualAxis" ? autoDualAxisAmount :
    THREE.MathUtils.lerp(0.26, 0.44, shapeDepthFactor);

  // Výška kamery:
  // když je L mělké, kamera může být níž,
  // když jsou větve podobně dlouhé, musí jít víc shora.
  const yAmount =
    endpointKind === "corner"
      ? THREE.MathUtils.lerp(0.34, 0.58, shapeDepthFactor)
      : endpointKind === "dualAxis"
        ? THREE.MathUtils.lerp(0.30, 0.46, shapeDepthFactor)
        : THREE.MathUtils.lerp(0.32, 0.52, shapeDepthFactor);

  return {
    sideSign,
    endpointKind,
    xAmount,
    yAmount,
    depthRatio,
    shapeDepthFactor,
    names,
    sideSource,
    hasExplicitSideModule: sideSource === "module-p" || sideSource === "module-l",
  };
}

function getRecapLShapeCameraSideSign() {
  return getRecapLShapeCameraMeta().sideSign;
}

function getRecapCaptureAspect() {
  try {
    const wrap = document.querySelector(".recapHeroImageWrap");
    const rect = wrap?.getBoundingClientRect?.();
    if (rect?.width > 0 && rect?.height > 0) {
      return rect.width / rect.height;
    }
  } catch (e) {}

  return 1500 / 780;
}

function getRecapCaptureSize() {
  const aspect = getRecapCaptureAspect();
  const width = 1500;
  const height = Math.max(620, Math.round(width / aspect));

  return { width, height, aspect };
}

function getRecapCaptureBackgroundColor() {
  try {
    const wrap = document.querySelector(".recapHeroImageWrap");
    const color = wrap ? getComputedStyle(wrap).backgroundColor : "";
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      return new THREE.Color(color);
    }
  } catch (e) {}

  return new THREE.Color(0xffffff);
}

function getRecapPreferredSideSign() {
  const moduleMeta = getRecapLShapeCameraMeta();
  if (moduleMeta.hasExplicitSideModule) {
    return moduleMeta.sideSign;
  }

  try {
    const topo = getRecapTopologySafe();
    const lSide = String(topo?.lSide || "").toLowerCase();
    if (lSide === "right") return -1;
    if (lSide === "left") return 1;
  } catch (e) {}

  return moduleMeta.sideSign;
}

function getRecapShapeDepthFactor() {
  const dims = window.__sofaDims || {};
  const width = Math.max(
    Number(dims.W || 0),
    Number(dims.width || 0),
    1
  );

  const depth = Math.max(
    Number(dims.L || 0),
    Number(dims.R || 0),
    Number(dims.D || 0),
    Number(dims.depth || 0),
    1
  );

  const ratio = THREE.MathUtils.clamp(depth / width, 0.20, 1.25);
  return THREE.MathUtils.smoothstep(ratio, 0.38, 0.95);
}

function getRecapDirectionFromAngles(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(el);

  return new THREE.Vector3(
    Math.sin(az) * horizontal,
    Math.sin(el),
    Math.cos(az) * horizontal
  ).normalize();
}

function getRecapCameraCandidates() {
  const branches = getRecapBranchCountSafe();
  const sideSign = getRecapPreferredSideSign();
  const depthFactor = getRecapShapeDepthFactor();

  const candidates = [];
  const push = (azimuth, elevation, weight = 0) => {
    candidates.push({
      branches,
      azimuth,
      elevation,
      weight,
      direction: getRecapDirectionFromAngles(azimuth, elevation),
    });
  };

  if (branches <= 1) {
    [10, 13, 16].forEach((el) => {
      push(0, el, el === 13 ? 0.25 : 0);
    });

    return candidates;
  }

  if (branches === 2) {
    const baseEl = THREE.MathUtils.lerp(12, 18, depthFactor);
    const azOffsets = [-10, -5, 0, 5, 10];
    const elOffsets = [-3, 0, 3];
    const sign = sideSign || 1;
    const baseAz = THREE.MathUtils.lerp(24, 38, depthFactor) * sign;

    for (const azOffset of azOffsets) {
      for (const elOffset of elOffsets) {
        const az = baseAz + (azOffset * sign);
        const el = THREE.MathUtils.clamp(baseEl + elOffset, 10, 24);
        const nearBase = Math.abs(azOffset) <= 5 && Math.abs(elOffset) <= 1;
        push(az, el, nearBase ? 0.28 : 0);
      }
    }

    return candidates;
  }

  if (branches === 3) {
    const dims = window.__sofaDims || {};
    const leftDepth = Number(dims.L || 0);
    const rightDepth = Number(dims.R || 0);
    const balanceSign =
      Math.abs(leftDepth - rightDepth) < 8
        ? 0
        : (leftDepth > rightDepth ? 1 : -1);

    [-16, -8, 0, 8, 16].forEach((az) => {
      [16, 20, 24].forEach((el) => {
        const sideWeight =
          balanceSign === 0
            ? (az === 0 ? 0.20 : 0)
            : (Math.sign(az) === balanceSign ? 0.18 : 0);
        push(az, el, sideWeight);
      });
    });

    return candidates;
  }

  [-20, -10, 0, 10, 20].forEach((az) => {
    [20, 25, 30].forEach((el) => {
      push(az, el, az === 0 && el === 25 ? 0.20 : 0);
    });
  });

  return candidates;
}

function getRecapCameraPreset(box, aspect = getRecapCaptureAspect()) {
  const branches = getRecapBranchCountSafe();
  const candidates = getRecapCameraCandidates();

  if (!box || box.isEmpty?.()) {
    return {
      branches,
      direction: candidates[0]?.direction?.clone?.() || new THREE.Vector3(0.18, 0.28, 1).normalize(),
      padding: branches >= 3 ? 1.10 : 1.08,
    };
  }

  let best = null;

  for (const candidate of candidates) {
    const bounds = getCameraSpaceBoundsForBox(box, candidate.direction);
    if (!bounds) continue;

    const projectedAspect = bounds.width / Math.max(bounds.height, 0.0001);
    const aspectFit = Math.min(projectedAspect / aspect, aspect / projectedAspect);
    const targetElevation =
      branches <= 1 ? 13 :
      branches === 2 ? THREE.MathUtils.lerp(12, 18, getRecapShapeDepthFactor()) :
      branches === 3 ? 20 :
      25;

    const elevationPenalty = Math.abs(candidate.elevation - targetElevation) / 36;
    const flatPenalty = bounds.height < 0.0001 ? 1 : 0;
    const score =
      (aspectFit * 2.2) +
      (candidate.weight || 0) -
      elevationPenalty -
      flatPenalty;

    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }

  const direction =
    best?.candidate?.direction?.clone?.() ||
    candidates[0]?.direction?.clone?.() ||
    new THREE.Vector3(0.18, 0.28, 1).normalize();

  return {
    branches,
    direction,
    padding:
      branches <= 1 ? 1.12 :
      branches === 2 ? 1.13 :
      branches === 3 ? 1.16 :
      1.18,
    fov:
      branches <= 1 ? 25 :
      branches === 2 ? 25 :
      branches === 3 ? 26 :
      27,
    cameraScore: best?.score || 0,
  };
}

function getRecapCameraDirection() {
  return getRecapCameraPreset().direction.clone();
}

function getBoxCornersForCameraFit(box) {
  const min = box.min;
  const max = box.max;

  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function getCameraSpaceBoundsForBox(box, direction) {
  if (!box || box.isEmpty?.()) return null;

  const center = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  box.getCenter(center);
  box.getBoundingSphere(sphere);

  const dir = direction.clone().normalize();
  const distance = Math.max(sphere.radius * 4, 10);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, distance + sphere.radius * 8);

  cam.position.copy(center).addScaledVector(dir, distance);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const corner of getBoxCornersForCameraFit(box)) {
    const local = corner.clone().applyMatrix4(cam.matrixWorldInverse);

    minX = Math.min(minX, local.x);
    maxX = Math.max(maxX, local.x);
    minY = Math.min(minY, local.y);
    maxY = Math.max(maxY, local.y);
    minZ = Math.min(minZ, local.z);
    maxZ = Math.max(maxZ, local.z);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: Math.max(0.0001, maxX - minX),
    height: Math.max(0.0001, maxY - minY),
    distance,
    radius: sphere.radius,
  };
}

function createRecapOrthographicCameraForBox(box, direction, aspect, {
  padding = 1.10,
  yBias = 0.01,
} = {}) {
  const center = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  box.getCenter(center);
  box.getBoundingSphere(sphere);

  const dir = direction.clone().normalize();
  const distance = Math.max(sphere.radius * 4, 10);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, distance + sphere.radius * 8);

  cam.position.copy(center).addScaledVector(dir, distance);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);

  const bounds = getCameraSpaceBoundsForBox(box, dir);
  if (!bounds) return cam;

  let viewW = bounds.width * padding;
  let viewH = bounds.height * padding;

  if (viewW / viewH < aspect) {
    viewW = viewH * aspect;
  } else {
    viewH = viewW / aspect;
  }

  const cx = bounds.centerX;
  const cy = bounds.centerY + viewH * yBias;

  cam.left = cx - viewW / 2;
  cam.right = cx + viewW / 2;
  cam.top = cy + viewH / 2;
  cam.bottom = cy - viewH / 2;
  cam.near = Math.max(0.01, distance - sphere.radius * 4);
  cam.far = distance + sphere.radius * 4;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  return cam;
}

function getPerspectiveCameraFitDistanceForBox(
  box,
  direction,
  aspect,
  fovDeg,
  target,
  padding = 1.14
) {
  const corners = getBoxCornersForCameraFit(box);
  const dir = direction.clone().normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);

  let right = new THREE.Vector3().crossVectors(worldUp, dir).normalize();
  if (!Number.isFinite(right.lengthSq()) || right.lengthSq() < 0.0001) {
    right = new THREE.Vector3(1, 0, 0);
  }

  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  let halfW = 0;
  let halfH = 0;
  let halfDepth = 0;

  for (const corner of corners) {
    const rel = corner.clone().sub(target);
    halfW = Math.max(halfW, Math.abs(rel.dot(right)));
    halfH = Math.max(halfH, Math.abs(rel.dot(up)));
    halfDepth = Math.max(halfDepth, Math.abs(rel.dot(dir)));
  }

  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distH = halfH / Math.tan(vFov / 2);
  const distW = halfW / Math.tan(hFov / 2);

  return Math.max(distH, distW, 1) * padding + halfDepth * 0.85;
}

function refineRecapPerspectiveCameraToBox(box, cam, target, {
  desiredMaxNdc = 1.76,
  maxIterations = 5,
} = {}) {
  if (!box || !cam || !target) return;

  for (let i = 0; i < maxIterations; i++) {
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const bounds = getProjectedBoxNdcBounds(box, cam);
    if (!bounds) return;

    const dist = cam.position.distanceTo(target);
    const vFov = THREE.MathUtils.degToRad(cam.fov);
    const halfViewH = Math.tan(vFov / 2) * dist;
    const halfViewW = halfViewH * cam.aspect;

    const viewDir = new THREE.Vector3();
    cam.getWorldDirection(viewDir);

    const right = new THREE.Vector3()
      .crossVectors(viewDir, cam.up)
      .normalize();

    const up = cam.up.clone().normalize();

    const pan = new THREE.Vector3()
      .addScaledVector(right, bounds.centerX * halfViewW)
      .addScaledVector(up, bounds.centerY * halfViewH);

    cam.position.add(pan);
    target.add(pan);

    const maxSize = Math.max(bounds.width, bounds.height);
    if (maxSize > desiredMaxNdc || maxSize < desiredMaxNdc * 0.88) {
      const away = cam.position.clone().sub(target).normalize();
      const scale = THREE.MathUtils.clamp(maxSize / desiredMaxNdc, 0.84, 1.18);
      const nextDist = Math.max(0.1, dist * scale);

      cam.position.copy(target).addScaledVector(away, nextDist);
    }
  }

  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
}

function createRecapPerspectiveCameraForBox(box, direction, aspect, {
  padding = 1.14,
  fov = 25,
  yBias = 0.03,
  desiredMaxNdc = 1.76,
} = {}) {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  const sphere = new THREE.Sphere();

  box.getCenter(center);
  box.getSize(size);
  box.getBoundingSphere(sphere);

  const target = center.clone();
  target.y += size.y * yBias;

  const dir = direction.clone().normalize();
  const distance = getPerspectiveCameraFitDistanceForBox(
    box,
    dir,
    aspect,
    fov,
    target,
    padding
  );

  const cam = new THREE.PerspectiveCamera(
    fov,
    aspect,
    Math.max(0.01, distance - sphere.radius * 5),
    distance + sphere.radius * 8
  );

  cam.position.copy(target).addScaledVector(dir, distance);
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  refineRecapPerspectiveCameraToBox(box, cam, target, {
    desiredMaxNdc,
    maxIterations: 5,
  });

  return cam;
}

function getProjectedBoxNdcBounds(box, cam) {
  const corners = getBoxCornersForCameraFit(box);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const corner of corners) {
    const p = corner.clone().project(cam);

    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function autoCenterRecapCameraToBox(box, cam, controls, {
  desiredMaxNdc = 1.72,
  maxIterations = 3,
} = {}) {
  if (!box || !cam || !controls) return;

  for (let i = 0; i < maxIterations; i++) {
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const bounds = getProjectedBoxNdcBounds(box, cam);
    if (!bounds) return;

    const dist = cam.position.distanceTo(controls.target);
    const vFov = THREE.MathUtils.degToRad(cam.fov);
    const halfViewH = Math.tan(vFov / 2) * dist;
    const halfViewW = halfViewH * cam.aspect;

    const viewDir = new THREE.Vector3();
    cam.getWorldDirection(viewDir);

    const right = new THREE.Vector3()
      .crossVectors(viewDir, cam.up)
      .normalize();

    const up = cam.up.clone().normalize();

    // Když je objekt v obraze víc vpravo, posuň kameru i target vpravo.
    // Tím se objekt opticky vrátí doleva do středu.
    const pan = new THREE.Vector3()
      .addScaledVector(right, bounds.centerX * halfViewW)
      .addScaledVector(up, bounds.centerY * halfViewH);

    cam.position.add(pan);
    controls.target.add(pan);

    // Když je objekt moc natěsno, lehce oddálíme kameru.
    const maxSize = Math.max(bounds.width, bounds.height);
    if (maxSize > desiredMaxNdc) {
      const away = cam.position.clone().sub(controls.target).normalize();
      const scale = Math.min(1.18, maxSize / desiredMaxNdc);
      const extraDist = dist * (scale - 1);

      cam.position.addScaledVector(away, extraDist);
    }

    controls.update();
  }
}

function getCameraFitDistanceForBox(box, direction, aspect, padding = 1.16) {
  const center = new THREE.Vector3();
  box.getCenter(center);

  const corners = getBoxCornersForCameraFit(box);

  const dir = direction.clone().normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(worldUp, dir).normalize();
  if (!Number.isFinite(right.lengthSq()) || right.lengthSq() < 0.0001) {
    right = new THREE.Vector3(1, 0, 0);
  }
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  let halfW = 0;
  let halfH = 0;
  let halfDepth = 0;

  for (const corner of corners) {
    const rel = corner.clone().sub(center);
    halfW = Math.max(halfW, Math.abs(rel.dot(right)));
    halfH = Math.max(halfH, Math.abs(rel.dot(up)));
    halfDepth = Math.max(halfDepth, Math.abs(rel.dot(dir)));
  }

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distH = halfH / Math.tan(vFov / 2);
  const distW = halfW / Math.tan(hFov / 2);

  // trochu větší bezpečnostní rezerva:
  // u dlouhých L/U sestav se jinak může stát, že kraj pohovky bude moc natěsno.
  const baseDistance = Math.max(distH, distW, 1);

  return baseDistance * padding + halfDepth * 0.20;
}

function captureRecapSofaImage(options = {}) {
  let restoreState = null;

  try {
    if (!renderer?.domElement || !camera || !scene || !activeModules?.length) return "";

    restoreState = {
      size: renderer.getSize(new THREE.Vector2()),
      pixelRatio: renderer.getPixelRatio(),
      sceneBackground: scene.background?.clone?.() || scene.background || null,
      clearColor: renderer.getClearColor(new THREE.Color()),
      clearAlpha: renderer.getClearAlpha(),
    };

    const box = new THREE.Box3();
    activeModules.forEach((rec) => {
      if (!rec?.mesh) return;
      rec.mesh.updateWorldMatrix?.(true, true);
      box.expandByObject(rec.mesh);
    });

    if (box.isEmpty()) return "";

    const captureSize = options.captureSize || getRecapCaptureSize();
    const cameraPreset = getRecapCameraPreset(box, captureSize.aspect);
    const captureBackground = getRecapCaptureBackgroundColor();
    const recapCamera = createRecapPerspectiveCameraForBox(
      box,
      cameraPreset.direction,
      captureSize.aspect,
      {
        padding: cameraPreset.padding,
        fov: cameraPreset.fov || 25,
        yBias: 0.03,
        desiredMaxNdc: 1.76,
      }
    );

    renderer.setPixelRatio(1);
    renderer.setSize(captureSize.width, captureSize.height, false);
    renderer.setClearColor(captureBackground, 1);
    scene.background = captureBackground;

    renderer.render(scene, recapCamera);

    const dataUrl = renderer.domElement.toDataURL(
      options.mimeType || "image/png",
      options.quality
    );

    return dataUrl || "";
  } catch (e) {
    console.warn("Recap image capture failed:", e);
    return "";
  } finally {
    if (restoreState) {
      renderer.setPixelRatio(restoreState.pixelRatio);
      renderer.setSize(restoreState.size.x, restoreState.size.y, false);
      renderer.setClearColor(restoreState.clearColor, restoreState.clearAlpha);
      scene.background = restoreState.sceneBackground;
      camera.updateProjectionMatrix?.();
      controls?.update?.();
    }
  }
}

function copyCurrentPlanToRecap() {
  const source = document.getElementById("sofaPlanSvg");
  const target = document.getElementById("recapPlanSvg");
  if (!source || !target) return;

  target.innerHTML = source.innerHTML || "";
  target.setAttribute("viewBox", source.getAttribute("viewBox") || "0 0 520 260");
  target.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

function getRecapDimensionRows() {
  const rows = [];
  document.querySelectorAll("#sofaDimsRows .dimsRow").forEach((row) => {
    const dim = row.getAttribute("data-dim") || "";
    const title = row.querySelector(".dimsTitle")?.textContent?.trim();
    const value = row.querySelector(".dimsValueInput")?.value?.trim();
    const range = row.querySelector(".dimsRange")?.textContent?.trim();
    if (!title || !value) return;
    rows.push({
      dim,
      title,
      range,
      min: Number(row.dataset.min),
      max: Number(row.dataset.max),
      valueNumber: Number(value),
      label: range ? `${title} (${range})` : title,
      value: `${value} cm`,
    });
  });
  return rows;
}

function getRecapModulePlanSortPoint(rec, nodes, orientation, fallbackIndex = 0) {
  const fallback = { left: fallbackIndex, right: fallbackIndex, x: fallbackIndex, z: 0, node: null };
  const root = getModuleRoot(rec?.mesh);
  if (!root) return fallback;

  try {
    const node = (nodes || []).find((n) => {
      const nodeRoot = getModuleRoot(n?.root || n?.rec?.mesh || n?.mesh);
      return n?.rec === rec || n?.rec?.mesh === rec?.mesh || nodeRoot === root;
    });

    if (
      node &&
      orientation &&
      typeof getNodePlanRectMapped === "function"
    ) {
      const rect = getNodePlanRectMapped(node, orientation);
      if (
        rect &&
        Number.isFinite(rect.minX) &&
        Number.isFinite(rect.maxX) &&
        Number.isFinite(rect.minZ) &&
        Number.isFinite(rect.maxZ)
      ) {
        return {
          left: rect.minX,
          right: rect.maxX,
          x: (rect.minX + rect.maxX) * 0.5,
          z: (rect.minZ + rect.maxZ) * 0.5,
          node,
        };
      }
    }

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();

    if (!box.isEmpty()) {
      box.getCenter(center);
    } else if (typeof root.getWorldPosition === "function") {
      root.getWorldPosition(center);
    }

    const mapped =
      orientation && typeof mapWorldPointToPlanAxes === "function"
        ? mapWorldPointToPlanAxes(center.x * 100, center.z * 100, orientation)
        : { x: center.x * 100, z: center.z * 100 };

    return {
      left: Number.isFinite(mapped?.x) ? mapped.x : fallback.x,
      right: Number.isFinite(mapped?.x) ? mapped.x : fallback.x,
      x: Number.isFinite(mapped?.x) ? mapped.x : fallback.x,
      z: Number.isFinite(mapped?.z) ? mapped.z : fallback.z,
      node: null,
    };
  } catch (e) {
    return fallback;
  }
}

function isRecapCornerSortItem(item) {
  const node = item?.point?.node;
  if (node && typeof isCornerModule === "function") return isCornerModule(node);
  return getRecapPartCode(item?.rec?.name) === "ROH";
}

function getRecapCornerSortSide(item) {
  const raw = String(item?.rec?.name || item?.rec?.model || "").trim();
  if (/_roh_p$/i.test(raw) || /roh_p$/i.test(raw)) return "P";
  if (/_roh_l$/i.test(raw) || /roh_l$/i.test(raw)) return "L";
  return "";
}

function areRecapSortItemsConnected(a, b) {
  const nodeA = a?.point?.node;
  const nodeB = b?.point?.node;
  if (!nodeA || !nodeB) {
    const meshA = a?.rec?.mesh;
    const meshB = b?.rec?.mesh;
    if (!meshA || !meshB) return false;

    return ["left", "right", "front", "back"].some((dir) => (
      a?.rec?.connections?.[dir] === meshB || b?.rec?.connections?.[dir] === meshA
    ));
  }

  return ["left", "right", "front", "back"].some((dir) => (
    nodeA.neighbors?.[dir] === nodeB || nodeB.neighbors?.[dir] === nodeA
  ));
}

function areRecapSortItemsInSameVisualColumn(a, b) {
  const aLeft = Number.isFinite(a?.point?.left) ? a.point.left : a?.point?.x;
  const bLeft = Number.isFinite(b?.point?.left) ? b.point.left : b?.point?.x;
  const aRight = Number.isFinite(a?.point?.right) ? a.point.right : a?.point?.x;
  const bRight = Number.isFinite(b?.point?.right) ? b.point.right : b?.point?.x;

  if (![aLeft, bLeft, aRight, bRight].every(Number.isFinite)) return false;

  const overlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  const minWidth = Math.max(1, Math.min(aRight - aLeft, bRight - bLeft));

  return Math.abs(aLeft - bLeft) <= 8 || overlap >= Math.min(35, minWidth * 0.45);
}

function compareRecapSortItemsByPlan(a, b) {
  const ax = Number.isFinite(a.point.left) ? a.point.left : a.point.x;
  const bx = Number.isFinite(b.point.left) ? b.point.left : b.point.x;
  const sameColumn = areRecapSortItemsInSameVisualColumn(a, b);
  const aCorner = isRecapCornerSortItem(a);
  const bCorner = isRecapCornerSortItem(b);

  if (sameColumn && aCorner !== bCorner && areRecapSortItemsConnected(a, b)) {
    const cornerItem = aCorner ? a : b;
    const cornerSide = getRecapCornerSortSide(cornerItem);
    const cornerFirst = cornerSide === "P";
    return aCorner
      ? (cornerFirst ? -1 : 1)
      : (cornerFirst ? 1 : -1);
  }

  const dx = ax - bx;
  if (Math.abs(dx) > 8) return dx;

  const dz = b.point.z - a.point.z;
  if (Math.abs(dz) > 1) return dz;

  return a.index - b.index;
}

function getRecapNodeKey(node) {
  const root = getModuleRoot(node?.root || node?.rec?.mesh || node?.mesh);
  return (
    root?.uuid ||
    node?.root?.uuid ||
    node?.mesh?.uuid ||
    node?.rec?.mesh?.uuid ||
    node?.rec?.name ||
    null
  );
}

function getRecapGraphNeighbors(item, itemByNodeKey) {
  const node = item?.point?.node;
  if (!node) return [];

  return ["left", "right", "front", "back"]
    .map((dir) => node.neighbors?.[dir])
    .filter(Boolean)
    .map((neighborNode) => itemByNodeKey.get(getRecapNodeKey(neighborNode)))
    .filter(Boolean);
}

function getRecapGraphOrderedItems(items) {
  const graphItems = items.filter((item) => item?.point?.node);
  if (graphItems.length !== items.length || graphItems.length <= 1) return null;

  const itemByNodeKey = new Map();
  for (const item of graphItems) {
    const key = getRecapNodeKey(item.point.node);
    if (!key || itemByNodeKey.has(key)) return null;
    itemByNodeKey.set(key, item);
  }

  const degreeOf = (item) => getRecapGraphNeighbors(item, itemByNodeKey).length;
  const endpoints = graphItems.filter((item) => degreeOf(item) <= 1);
  const startPool = endpoints.length ? endpoints : graphItems;
  const start = startPool.slice().sort(compareRecapSortItemsByPlan)[0];

  if (!start) return null;

  const ordered = [];
  const visited = new Set();

  const walk = (item) => {
    const key = getRecapNodeKey(item?.point?.node);
    if (!key || visited.has(key)) return;

    visited.add(key);
    ordered.push(item);

    const neighbors = getRecapGraphNeighbors(item, itemByNodeKey)
      .filter((neighbor) => !visited.has(getRecapNodeKey(neighbor?.point?.node)))
      .sort(compareRecapSortItemsByPlan);

    for (const neighbor of neighbors) {
      walk(neighbor);
    }
  };

  walk(start);

  if (ordered.length < graphItems.length) {
    const rest = graphItems
      .filter((item) => !visited.has(getRecapNodeKey(item?.point?.node)))
      .sort(compareRecapSortItemsByPlan);

    for (const item of rest) {
      walk(item);
    }
  }

  return ordered.length === items.length ? ordered : null;
}

function getRecapNodeNeighbors(node) {
  return [
    node?.neighbors?.left,
    node?.neighbors?.right,
    node?.neighbors?.front,
    node?.neighbors?.back,
  ].filter(Boolean);
}

function getRecapNodeDegree(node) {
  return getRecapNodeNeighbors(node).length;
}

function getRecapPathBetweenNodes(startNode, endNode, allowedNodes) {
  const allowed = new Map();
  for (const node of allowedNodes || []) {
    const key = getRecapNodeKey(node);
    if (key) allowed.set(key, node);
  }

  const startKey = getRecapNodeKey(startNode);
  const endKey = getRecapNodeKey(endNode);
  if (!startKey || !endKey || !allowed.has(startKey) || !allowed.has(endKey)) return [];

  const queue = [startNode];
  const visited = new Set([startKey]);
  const prev = new Map();

  while (queue.length) {
    const current = queue.shift();
    const currentKey = getRecapNodeKey(current);
    if (!currentKey) continue;
    if (currentKey === endKey) break;

    for (const neighbor of getRecapNodeNeighbors(current)) {
      const neighborKey = getRecapNodeKey(neighbor);
      if (!neighborKey || !allowed.has(neighborKey) || visited.has(neighborKey)) continue;

      visited.add(neighborKey);
      prev.set(neighborKey, currentKey);
      queue.push(neighbor);
    }
  }

  if (!visited.has(endKey)) return [];

  const pathKeys = [];
  let currentKey = endKey;

  while (currentKey) {
    pathKeys.push(currentKey);
    if (currentKey === startKey) break;
    currentKey = prev.get(currentKey) || null;
  }

  pathKeys.reverse();
  return pathKeys.map((key) => allowed.get(key)).filter(Boolean);
}

function getRecapDepthPathFromWidthAnchor(anchorNode, widthSet, orientation, side) {
  if (!anchorNode || !widthSet?.has(anchorNode)) return [];

  const anchorCenter =
    typeof getMappedPlanCenter === "function"
      ? getMappedPlanCenter(anchorNode, orientation)
      : { x: 0, z: 0 };

  const queue = [anchorNode];
  const visited = new Set([getRecapNodeKey(anchorNode)]);
  const prev = new Map();
  const reachable = [];

  while (queue.length) {
    const current = queue.shift();
    const currentKey = getRecapNodeKey(current);
    if (!currentKey) continue;

    if (current !== anchorNode && !widthSet.has(current)) {
      reachable.push(current);
    }

    for (const neighbor of getRecapNodeNeighbors(current)) {
      const neighborKey = getRecapNodeKey(neighbor);
      if (!neighborKey || visited.has(neighborKey)) continue;
      if (widthSet.has(neighbor) && neighbor !== anchorNode) continue;

      visited.add(neighborKey);
      prev.set(neighborKey, currentKey);
      queue.push(neighbor);
    }
  }

  if (!reachable.length) return [anchorNode];

  const scoreNode = (node) => {
    const c =
      typeof getMappedPlanCenter === "function"
        ? getMappedPlanCenter(node, orientation)
        : anchorCenter;
    const dx = Math.abs(c.x - anchorCenter.x);
    const dz = Math.abs(c.z - anchorCenter.z);
    const sideScore =
      side === "left"
        ? Math.max(0, anchorCenter.x - c.x)
        : Math.max(0, c.x - anchorCenter.x);

    return (
      dx +
      dz * 1.4 +
      sideScore * 0.2 +
      (c.z > anchorCenter.z + 1 ? 80 : 0) +
      (getRecapNodeDegree(node) <= 1 ? 120 : 0)
    );
  };

  const endNode = reachable
    .slice()
    .sort((a, b) => scoreNode(b) - scoreNode(a))[0];
  const endKey = getRecapNodeKey(endNode);
  if (!endKey) return [anchorNode];

  const pathKeys = [];
  let currentKey = endKey;

  while (currentKey) {
    pathKeys.push(currentKey);
    if (currentKey === getRecapNodeKey(anchorNode)) break;
    currentKey = prev.get(currentKey) || null;
  }

  pathKeys.reverse();

  const nodeByKey = new Map();
  for (const node of [anchorNode, ...reachable]) {
    const key = getRecapNodeKey(node);
    if (key) nodeByKey.set(key, node);
  }

  return pathKeys.map((key) => nodeByKey.get(key)).filter(Boolean);
}

function getRecapUShapeOrderedItems(items, nodes, orientation) {
  if (!Array.isArray(items) || !items.length || !Array.isArray(nodes) || nodes.length < 3) {
    return null;
  }

  const itemByNodeKey = new Map();
  for (const item of items) {
    const key = getRecapNodeKey(item?.point?.node);
    if (key) itemByNodeKey.set(key, item);
  }

  if (itemByNodeKey.size !== items.length) return null;

  let branchCount = 1;
  try {
    branchCount = Math.max(1, Number(detectBranchCount?.() || 1));
  } catch (e) {
    branchCount = 1;
  }

  const cornerCount = nodes.filter((node) => {
    if (typeof isCornerModule === "function") return isCornerModule(node);
    return /ROH/i.test(String(node?.rec?.name || ""));
  }).length;

  if (branchCount !== 3 && cornerCount < 2) return null;

  const getRect = (item) => {
    if (item?.point?.node && typeof getNodePlanRectMapped === "function") {
      return getNodePlanRectMapped(item.point.node, orientation);
    }

    const x = Number.isFinite(item?.point?.x) ? item.point.x : item?.index || 0;
    const z = Number.isFinite(item?.point?.z) ? item.point.z : 0;
    const left = Number.isFinite(item?.point?.left) ? item.point.left : x;
    const right = Number.isFinite(item?.point?.right) ? item.point.right : x;
    return { minX: left, maxX: right, minZ: z, maxZ: z };
  };

  const getCenter = (item) => {
    const rect = getRect(item);
    return {
      x: (rect.minX + rect.maxX) * 0.5,
      z: (rect.minZ + rect.maxZ) * 0.5,
    };
  };

  const cornerItems = items.filter(isRecapCornerSortItem);
  if (cornerItems.length < 2) return null;

  const sortedCorners = cornerItems
    .slice()
    .sort((a, b) => getCenter(a).x - getCenter(b).x);

  const leftCornerItem = sortedCorners[0];
  const rightCornerItem = sortedCorners[sortedCorners.length - 1];
  const leftCornerCenter = getCenter(leftCornerItem);
  const rightCornerCenter = getCenter(rightCornerItem);
  const mainZ = (leftCornerCenter.z + rightCornerCenter.z) * 0.5;
  const mainMinX = Math.min(leftCornerCenter.x, rightCornerCenter.x);
  const mainMaxX = Math.max(leftCornerCenter.x, rightCornerCenter.x);

  const heights = items
    .map((item) => {
      const rect = getRect(item);
      return Math.abs(rect.maxZ - rect.minZ);
    })
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 80;
  const rowTol = Math.max(
    14,
    Math.min(34, medianHeight * 0.32),
    Math.abs(leftCornerCenter.z - rightCornerCenter.z) + 8
  );
  const sideTol = Math.max(18, medianHeight * 0.25);

  const mainItems = items
    .filter((item) => {
      if (item === leftCornerItem || item === rightCornerItem) return true;
      const c = getCenter(item);
      const inMainRow = Math.abs(c.z - mainZ) <= rowTol;
      const inMainSpan = c.x >= mainMinX - sideTol && c.x <= mainMaxX + sideTol;
      return inMainRow && inMainSpan;
    })
    .sort((a, b) => getCenter(a).x - getCenter(b).x);

  if (mainItems.length < 2) return null;

  const mainSet = new Set(mainItems);
  const mainMidX =
    mainItems.reduce((sum, item) => sum + getCenter(item).x, 0) / Math.max(1, mainItems.length);

  const sideItems = items.filter((item) => !mainSet.has(item));
  const leftSideItems = sideItems
    .filter((item) => getCenter(item).x <= mainMidX)
    .sort((a, b) => {
      const da = Math.hypot(getCenter(a).x - leftCornerCenter.x, getCenter(a).z - leftCornerCenter.z);
      const db = Math.hypot(getCenter(b).x - leftCornerCenter.x, getCenter(b).z - leftCornerCenter.z);
      return db - da;
    });

  const rightSideItems = sideItems
    .filter((item) => getCenter(item).x > mainMidX)
    .sort((a, b) => {
      const da = Math.hypot(getCenter(a).x - rightCornerCenter.x, getCenter(a).z - rightCornerCenter.z);
      const db = Math.hypot(getCenter(b).x - rightCornerCenter.x, getCenter(b).z - rightCornerCenter.z);
      return da - db;
    });

  const maybePathOrderSide = (side, anchorItem, sideList) => {
    if (!sideList.length || !anchorItem?.point?.node) return sideList;

    const sideNodeSet = new Set(sideList.map((item) => item?.point?.node).filter(Boolean));
    const allowedNodes = [anchorItem.point.node, ...sideNodeSet];
    const endpoint = sideList
      .slice()
      .sort((a, b) => {
        const ac = getCenter(a);
        const bc = getCenter(b);
        const anchor = getCenter(anchorItem);
        const da = Math.hypot(ac.x - anchor.x, ac.z - anchor.z);
        const db = Math.hypot(bc.x - anchor.x, bc.z - anchor.z);
        return db - da;
      })[0];

    const path = getRecapPathBetweenNodes(anchorItem.point.node, endpoint?.point?.node, allowedNodes);
    if (path.length < 2) return sideList;

    const pathItems = path
      .map((node) => itemByNodeKey.get(getRecapNodeKey(node)))
      .filter((item) => item && sideList.includes(item));

    if (pathItems.length !== sideList.length) return sideList;
    return side === "left" ? pathItems.slice().reverse() : pathItems;
  };

  const orderedItemsByShape = [
    ...maybePathOrderSide("left", leftCornerItem, leftSideItems),
    ...mainItems,
    ...maybePathOrderSide("right", rightCornerItem, rightSideItems),
  ];

  const orderedItems = [];
  const used = new Set();

  const pushItem = (item) => {
    const key = getRecapNodeKey(item?.point?.node);
    if (!item || !key || used.has(key)) return;
    used.add(key);
    orderedItems.push(item);
  };

  for (const item of orderedItemsByShape) pushItem(item);

  const remaining = items
    .filter((item) => !used.has(getRecapNodeKey(item?.point?.node)))
    .sort(compareRecapSortItemsByPlan);

  for (const item of remaining) {
    const key = getRecapNodeKey(item?.point?.node);
    if (key && !used.has(key)) {
      used.add(key);
      orderedItems.push(item);
    }
  }

  return orderedItems.length === items.length ? orderedItems : null;
}

function getRecapAssemblyOrderedModules() {
  const modules = (activeModules || []).filter((rec) => rec?.name);
  let nodes = [];
  let orientation = null;

  try {
    nodes = typeof getConnectedPlanNodes === "function"
      ? (getConnectedPlanNodes() || [])
      : [];
    orientation = typeof getPlanRenderOrientation === "function"
      ? getPlanRenderOrientation(nodes)
      : null;
  } catch (e) {
    nodes = [];
    orientation = null;
  }

  const items = modules
    .map((rec, index) => ({
      rec,
      index,
      point: getRecapModulePlanSortPoint(rec, nodes, orientation, index),
    }));

  return (
    getRecapUShapeOrderedItems(items, nodes, orientation) ||
    getRecapGraphOrderedItems(items) ||
    items.slice().sort(compareRecapSortItemsByPlan)
  )
    .map((item) => item.rec);
}

function getRecapAssemblyPartRows() {
  return getRecapAssemblyOrderedModules().map((rec) => {
    const upgradeKey = getUpgradeKeyForRec(rec);
    const upgrade = getUpgradeLabelForRec(rec);
    const partCode = getRecapPartCode(rec.name);
    const label = upgrade ? `${partCode} - ${upgrade}` : partCode;
    const price = getSummaryPriceForRecSafe(rec, getAppliedFabricPriceGroup(), upgradeKey);
    const discountedPartPrice = getDiscountedAmount(price).final;

    return {
      label,
      value: formatCzk(discountedPartPrice),
      className: "is-part",
    };
  });
}

function getRecapAssemblyRows() {
  const rows = getRecapAssemblyPartRows();

  if (rows.length && getDiscountPercent() > 0) {
    rows.push({
      label: `Ceny modulů jsou uvedené po slevě ${getDiscountPercent()} %.`,
      value: "",
      className: "is-assembly-note",
    });
  }

  return rows;
}

function getRecapAssemblyText(separator = " - ") {
  return getRecapAssemblyPartRows()
    .map((row) => row.label)
    .filter(Boolean)
    .join(separator);
}

function renderRecapView() {
  const recap = document.getElementById("recapView");
  if (!recap) return;

  const sofaKey = getActiveSofaKeyFromScene();
  const meta = SOFA_SUMMARY_META[sofaKey] || SOFA_SUMMARY_META.Manila;
  const total = getConfiguredTotalPrice();
  const discounted = getDiscountedAmount(total);
  const fabric = getRecapSelectedFabric();
  const leg = getRecapLegMeta();
  const legColor = getRecapLegColorMeta();
  const armrest = getRecapArmrestMeta();
  const shelf = getRecapShelfColorMeta();
  const now = new Date();
  const dateText = now.toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "numeric" });

  const sofaNameEl = document.getElementById("recapSofaName");
  const subtitleEl = document.getElementById("recapSofaSubtitle");
  const dateEl = document.getElementById("recapDate");
  const headerPriceEl = document.getElementById("recapHeaderPrice");
  const imageEl = document.getElementById("recapSofaImage");
  const dimsEditBtn = document.getElementById("recapDimsEditBtn");

  if (sofaNameEl) sofaNameEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = getAssemblyTypeLabel();
  if (dateEl) dateEl.textContent = `Konfigurace: ${dateText}`;
  if (headerPriceEl) headerPriceEl.textContent = formatCzk(discounted.final);
  if (dimsEditBtn) dimsEditBtn.classList.toggle("is-active", recapDimsEditMode);

  if (imageEl) {
    renderRecapSofaImageDeferred();
  }

  copyCurrentPlanToRecap();

  renderRecapRows(document.getElementById("recapQuickFacts"), [
    { label: "Model", value: meta.title },
    { label: "Typ sestavy", value: getAssemblyTypeLabel() },
    { label: "Počet modulů", value: `${activeModules.length} ks` },
    { label: "Materiál", value: fabric?.selected ? `${fabric.selected.fabricName || fabric.selected.fabricKey} ${fabric.selected.shade || ""}`.trim() : "Nezvoleno" },
  ]);

  renderRecapDimensions(document.getElementById("recapDimensions"), getRecapDimensionRows());
  renderRecapRows(document.getElementById("recapAssembly"), getRecapAssemblyRows());

  const shouldShowHingesInRecap = getModelKey() !== "MANCHESTER";
  const hingeMeta = shouldShowHingesInRecap ? getRecapHingeMeta() : null;

  const equipmentTiles = [
    {
      label: "Nožičky",
      value: leg?.label || selectedLegs || "Nezvoleno",
      img: leg?.img || "",
      className: "recapEquipmentTile is-leg",
      mediaClass: "is-leg-image",
      details: [
        { label: "Typ", value: leg?.label || selectedLegs || "Nezvoleno" },
        { label: "Barva", value: legColor.label || "Nezvoleno" },
      ],
    },
    {
      label: "Područky",
      value: armrest?.label || selectedArmrests || "Nezvoleno",
      img: armrest?.img || "",
      className: "recapEquipmentTile is-armrest",
      mediaClass: "is-armrest-image",
      details: [
        { label: "Typ", value: armrest?.label || selectedArmrests || "Nezvoleno" },
        { label: "Šířka", value: getRecapArmrestWidthLabel() },
      ],
    },
  ];

  if (shouldShowHingesInRecap && hingeMeta) {
    equipmentTiles.push({
      label: "Panty",
      value: hingeMeta.label,
      img: hingeMeta.img,
      className: "recapEquipmentTile is-hinge",
      mediaClass: "is-hinge-image",
      details: [
        { label: "Barva", value: hingeMeta.label },
      ],
    });
  }

  if (isMelbourneShelfAvailable()) {
    equipmentTiles.push({
      label: "Polička",
      value: shelf.label || "Nezvoleno",
      img: shelf.img || "",
      className: "recapEquipmentTile is-shelf",
      mediaClass: "is-shelf-image",
      details: [
        { label: "Barva", value: shelf.label || "Nezvoleno" },
      ],
    });
  }

  renderRecapTiles(document.getElementById("recapEquipment"), equipmentTiles);

  renderRecapMaterial(document.getElementById("recapMaterial"), fabric);

  renderRecapRows(document.getElementById("recapPrice"), [
    { label: "Aktuální cena", value: formatCzk(discounted.base) },
    discounted.hasDiscount ? { label: "Sleva", value: `-${discounted.percent} %` } : null,
    { label: "Cena po slevě", value: formatCzk(discounted.final), className: "is-total" },
    { label: "bez DPH", value: formatCzk(Math.round(discounted.final / 1.21)), className: "is-price-note" },
  ]);
}

function absolutizeRecapPrintAssets(root) {
  if (!root) return;

  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) return;
    try {
      img.setAttribute("src", new URL(assetUrl(src), window.location.href).href);
    } catch (e) {}
  });

  root.querySelectorAll("*").forEach((el) => {
    const computedBg = window.getComputedStyle(el).backgroundImage;
    if (computedBg && computedBg !== "none") {
      el.style.backgroundImage = computedBg;
    }
  });
}

function getRecapPrintStyles() {
  return `
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #f6f4f1;
      color: #15171d;
      font-family: "Inter", Arial, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body { padding: 12mm 0; }
    .recapPrintShell {
      width: 190mm;
      margin: 0 auto;
    }
    .recapSheet {
      width: 100%;
      margin: 0;
      padding: 0;
      border-radius: 0;
      background: #fff;
      box-shadow: none;
      color: #15171d;
    }
    .recapHeader {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      align-items: start;
      margin-bottom: 14px;
    }
    .recapEyebrow {
      margin-bottom: 5px;
      font-size: 9px;
      font-weight: 800;
      color: #4eaed0;
      text-transform: uppercase;
      letter-spacing: .12em;
    }
    .recapHeader h1 {
      margin: 0;
      font-size: 25px;
      line-height: 1.05;
      font-weight: 800;
      letter-spacing: 0;
    }
    .recapHeader p {
      margin: 5px 0 0;
      color: #4b5563;
      font-size: 11px;
      line-height: 1.35;
    }
    .recapHeaderMeta {
      min-width: 42mm;
      padding: 8px 10px;
      border-radius: 7px;
      background: #f7f8fa;
      border: 1px solid #e7e9ee;
      text-align: right;
    }
    .recapHeaderMeta span {
      display: block;
      margin-bottom: 4px;
      color: #6b7280;
      font-size: 9px;
      font-weight: 700;
    }
    .recapHeaderMeta strong {
      display: block;
      font-size: 18px;
      line-height: 1.1;
    }
    .recapHero {
      display: grid;
      grid-template-columns: minmax(0, 1.62fr) minmax(50mm, .78fr);
      gap: 10px;
      align-items: stretch;
      margin-bottom: 10px;
    }
    .recapHeroImageWrap {
      position: relative;
      min-height: 64mm;
      overflow: hidden;
      border-radius: 8px;
      background: #fff;
      border: 1px solid #e1e5eb;
    }
    .recapHeroImage {
      width: 100%;
      height: 64mm;
      object-fit: contain;
      display: block;
      background: #fff;
    }
    .recapImageFallback { display: none !important; }
    .recapIntroCard,
    .recapCard,
    .recapActionsCard {
      border-radius: 8px;
      border: 1px solid #e1e5eb;
      background: #fff;
      break-inside: avoid;
    }
    .recapIntroCard { padding: 10px; }
    .recapIntroCard h2,
    .recapCardTitle h2 {
      margin: 0;
      font-size: 11px;
      line-height: 1.2;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .02em;
    }
    .recapQuickFacts {
      display: grid;
      gap: 6px;
      margin-top: 10px;
    }
    .recapFact {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: baseline;
      min-height: 20px;
      padding-bottom: 5px;
      border-bottom: 1px solid #eef1f5;
    }
    .recapFact span {
      color: #657080;
      font-size: 9px;
      font-weight: 700;
      text-transform: none;
    }
    .recapFact strong {
      color: #111827;
      font-size: 10px;
      line-height: 1.25;
      font-weight: 800;
      text-align: right;
    }
    .recapGrid {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .recapGridTwo {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    .recapPdfPageBreakBefore {
      break-before: page;
      page-break-before: always;
      padding-top: 0;
    }
    .recapCard,
    .recapActionsCard {
      padding: 10px;
    }
    .recapCardTitle {
      display: flex;
      align-items: center;
      gap: 7px;
      padding-bottom: 8px;
      border-bottom: 1px solid #edf0f4;
    }
    .recapEditBtn,
    .recapActionsCard,
    .recapDimActions {
      display: none !important;
    }
    .recapIcon {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      color: #1f2937;
      flex: 0 0 auto;
    }
    .recapIcon::before {
      content: "";
      width: 17px;
      height: 17px;
      display: block;
      background-color: currentColor;
      -webkit-mask: center / contain no-repeat;
      mask: center / contain no-repeat;
    }
    .recapIcon[data-recap-icon="assembly"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='m12 3 8 4.5-8 4.5-8-4.5L12 3Z'/%3E%3Cpath d='M4 7.5v9L12 21l8-4.5v-9'/%3E%3Cpath d='M12 12v9'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='m12 3 8 4.5-8 4.5-8-4.5L12 3Z'/%3E%3Cpath d='M4 7.5v9L12 21l8-4.5v-9'/%3E%3Cpath d='M12 12v9'/%3E%3C/svg%3E"); }
    .recapIcon[data-recap-icon="equipment"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M12 15.3A3.3 3.3 0 1 0 12 8.7a3.3 3.3 0 0 0 0 6.6Z'/%3E%3Cpath d='M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2.1 2.1 0 0 1-2.97 2.97l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2.1 2.1 0 0 1-4.2 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2.1 2.1 0 1 1-2.97-2.97l.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.56-1.03H2.45a2.1 2.1 0 0 1 0-4.2h.09A1.7 1.7 0 0 0 4.1 8.74a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2.1 2.1 0 1 1 2.97-2.97l.06.06a1.7 1.7 0 0 0 1.88.34h.01a1.7 1.7 0 0 0 1.03-1.56V2.6a2.1 2.1 0 0 1 4.2 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06A1.7 1.7 0 0 0 19.4 8.8v.01a1.7 1.7 0 0 0 1.56 1.03h.09a2.1 2.1 0 0 1 0 4.2h-.09A1.7 1.7 0 0 0 19.4 15Z'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M12 15.3A3.3 3.3 0 1 0 12 8.7a3.3 3.3 0 0 0 0 6.6Z'/%3E%3Cpath d='M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2.1 2.1 0 0 1-2.97 2.97l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2.1 2.1 0 0 1-4.2 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2.1 2.1 0 1 1-2.97-2.97l.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.56-1.03H2.45a2.1 2.1 0 0 1 0-4.2h.09A1.7 1.7 0 0 0 4.1 8.74a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2.1 2.1 0 1 1 2.97-2.97l.06.06a1.7 1.7 0 0 0 1.88.34h.01a1.7 1.7 0 0 0 1.03-1.56V2.6a2.1 2.1 0 0 1 4.2 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06A1.7 1.7 0 0 0 19.4 8.8v.01a1.7 1.7 0 0 0 1.56 1.03h.09a2.1 2.1 0 0 1 0 4.2h-.09A1.7 1.7 0 0 0 19.4 15Z'/%3E%3C/svg%3E"); }
    .recapIcon[data-recap-icon="material"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='13.5' cy='7.5' r='1.2'/%3E%3Ccircle cx='8.2' cy='10.4' r='1.2'/%3E%3Ccircle cx='10.8' cy='15.2' r='1.2'/%3E%3Cpath d='M12 3.2a8.8 8.8 0 0 0 0 17.6h1.3a2.1 2.1 0 0 0 1.5-3.6 1.25 1.25 0 0 1 .9-2.1H17a4 4 0 0 0 4-4c0-4.35-3.94-7.9-9-7.9Z'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='13.5' cy='7.5' r='1.2'/%3E%3Ccircle cx='8.2' cy='10.4' r='1.2'/%3E%3Ccircle cx='10.8' cy='15.2' r='1.2'/%3E%3Cpath d='M12 3.2a8.8 8.8 0 0 0 0 17.6h1.3a2.1 2.1 0 0 0 1.5-3.6 1.25 1.25 0 0 1 .9-2.1H17a4 4 0 0 0 4-4c0-4.35-3.94-7.9-9-7.9Z'/%3E%3C/svg%3E"); }
    .recapIcon[data-recap-icon="price"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20.6 13.2 13.2 20.6a2.2 2.2 0 0 1-3.1 0L3.4 13.9a2.2 2.2 0 0 1-.64-1.56V4.4A1.65 1.65 0 0 1 4.4 2.75h7.95c.58 0 1.14.23 1.55.65l6.7 6.7a2.2 2.2 0 0 1 0 3.1Z'/%3E%3Ccircle cx='7.7' cy='7.7' r='1.15'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20.6 13.2 13.2 20.6a2.2 2.2 0 0 1-3.1 0L3.4 13.9a2.2 2.2 0 0 1-.64-1.56V4.4A1.65 1.65 0 0 1 4.4 2.75h7.95c.58 0 1.14.23 1.55.65l6.7 6.7a2.2 2.2 0 0 1 0 3.1Z'/%3E%3Ccircle cx='7.7' cy='7.7' r='1.15'/%3E%3C/svg%3E"); }
    .recapIcon[data-recap-icon="plan"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='4' y='5' width='6.5' height='6.5' rx='1'/%3E%3Crect x='10.5' y='5' width='9.5' height='6.5' rx='1'/%3E%3Crect x='4' y='11.5' width='9.5' height='7.5' rx='1'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='4' y='5' width='6.5' height='6.5' rx='1'/%3E%3Crect x='10.5' y='5' width='9.5' height='6.5' rx='1'/%3E%3Crect x='4' y='11.5' width='9.5' height='7.5' rx='1'/%3E%3C/svg%3E"); }
    .recapRows {
      display: grid;
      gap: 0;
      margin-top: 8px;
    }
    .recapRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 24px;
      padding: 5px 0;
      border-bottom: 1px solid #eef1f5;
      font-size: 10px;
    }
    .recapRow:last-child { border-bottom: 0; }
    .recapRow span { color: #657080; }
    .recapRow strong {
      justify-self: end;
      text-align: right;
      font-weight: 800;
    }
    .recapRow.is-part span {
      color: #252a33;
      font-weight: 700;
    }
    .recapRow.is-assembly-note {
      grid-template-columns: minmax(0, 1fr);
      min-height: auto;
      padding-top: 3px;
      border-bottom: 0;
      font-size: 8.5px;
    }
    .recapRow.is-assembly-note span {
      color: #8a93a3;
      font-weight: 700;
    }
    .recapRow.is-assembly-note strong {
      display: none;
    }
    .recapRow.is-total {
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid #dce2ea;
    }
    .recapRow.is-total strong { font-size: 15px; }
    .recapRow.is-price-note {
      min-height: auto;
      padding-top: 0;
      border-bottom: 0;
      font-size: 9px;
    }
    .recapRow.is-price-note span,
    .recapRow.is-price-note strong {
      color: #8a93a3;
      font-weight: 700;
    }
    .recapPlanFrame {
      margin-top: 9px;
      border-radius: 7px;
      background: #2d2f33;
      border: 1px solid #e1e5eb;
      overflow: hidden;
    }
    #recapPlanSvg {
      width: 100%;
      height: 45mm;
      display: block;
    }
    .recapTiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      margin-top: 9px;
    }
    .recapTile {
      min-width: 0;
      display: grid;
      grid-template-columns: 38px 1fr;
      gap: 8px;
      align-items: center;
      padding: 7px;
      border-radius: 7px;
      background: #f8f9fb;
      border: 1px solid #eaedf2;
      break-inside: avoid;
    }
    .recapTileMedia {
      width: 38px;
      height: 38px;
      border-radius: 6px;
      overflow: hidden;
      background: #e8ebf0;
      border: 1px solid rgba(15, 23, 42, 0.08);
      background-size: cover;
      background-position: center;
    }
    .recapTileMedia img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .recapTileText span,
    .recapMaterialHead span {
      display: block;
      margin-bottom: 2px;
      color: #6b7280;
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .recapTileText strong,
    .recapMaterialHead strong {
      display: block;
      color: #111827;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 800;
      overflow-wrap: anywhere;
    }
    #recapEquipment.recapTiles {
      grid-template-columns: 1fr;
    }
    #recapEquipment .recapTile {
      grid-template-columns: 44px minmax(0, 1fr);
      min-height: 22mm;
    }
    #recapEquipment .recapTileMedia {
      width: 44px;
      height: 44px;
    }
    #recapEquipment .recapTileMedia.is-leg-image {
      padding: 4px;
      box-sizing: border-box;
      background: #f1f4f8;
    }
    #recapEquipment .recapTileMedia.is-leg-image img {
      object-fit: contain;
      object-position: center center;
    }
    #recapEquipment .recapTileText {
      display: grid;
      grid-template-columns: minmax(0, .55fr) minmax(0, 1fr);
      gap: 8px;
      align-items: center;
    }
    #recapEquipment .recapTileDetails {
      display: grid;
      gap: 3px;
    }
    #recapEquipment .recapTileDetail {
      display: grid;
      grid-template-columns: 17mm 1fr;
      gap: 5px;
      align-items: baseline;
      font-size: 8px;
      line-height: 1.2;
    }
    #recapEquipment .recapTileDetail span {
      color: #758197;
      font-weight: 800;
      text-transform: uppercase;
    }
    #recapEquipment .recapTileDetail strong {
      color: #111827;
      font-weight: 800;
    }
    #recapMaterial.recapTiles {
      grid-template-columns: 1fr;
    }
    #recapMaterial .recapTile {
      display: block;
      padding: 0;
      background: #fff;
      border: 0;
    }
    #recapMaterial .recapMaterialMain,
    #recapMaterial .recapMaterialPaspule {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 8px 10px;
      align-items: center;
      padding: 10px;
      border-radius: 10px;
      background: #f8f9fb;
      border: 1px solid #eaedf2;
    }

    #recapMaterial .recapMaterialPaspule {
      margin-top: 9px;
      grid-template-columns: 34px minmax(0, 1fr);
    }

    #recapMaterial .recapMaterialSwatch {
      width: 42px;
      height: 42px;
      border-radius: 8px;
      background-size: cover;
      background-position: center;
      border: 1px solid rgba(15, 23, 42, .12);
    }

    #recapMaterial .recapMaterialSwatch.is-small {
      width: 34px;
      height: 34px;
      border-radius: 8px;
    }

    #recapMaterial .recapMaterialHead {
      min-width: 0;
    }

    #recapMaterial .recapMaterialDescription {
      grid-column: 1 / -1;
      margin-top: 2px;
      padding: 8px 9px;
      border-radius: 8px;
      background: #ffffff;
      border: 1px solid #e4e8ef;
      color: #111827;
      font-size: 9px;
      line-height: 1.38;
      font-weight: 600;
    }

    #recapMaterial .recapMaterialInfo {
      grid-column: 1 / -1;
      margin-top: 2px;
      border-top: 1px solid #e1e6ee;
    }

    #recapMaterial .recapMaterialInfoRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: baseline;
      min-height: 19px;
      padding: 4px 0;
      border-bottom: 1px solid #eef1f5;
      font-size: 9px;
    }

    #recapMaterial .recapMaterialInfoRow:last-child { border-bottom: 0; }

    #recapMaterial .recapMaterialInfoRow span {
      color: #657080;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .03em;
    }

    #recapMaterial .recapMaterialInfoRow strong {
      color: #111827;
      font-weight: 800;
      text-align: right;
    }
    .recapFinalGrid {
      grid-template-columns: minmax(0, 1fr);
      width: calc(50% - 5px);
    }
    @media print {
      body { padding: 0; background: #fff; }
      .recapPrintShell { width: 100%; }
      .recapSheet { background: #fff; }
    }
  `;
}

function getRecapPdfFilename() {
  const sofaName = document.getElementById("recapSofaName")?.textContent?.trim() || "konfigurace";
  const date = new Date().toISOString().slice(0, 10);
  const safeName = sofaName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "konfigurace";
  return `${safeName}-rekapitulace-${date}.pdf`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function stringToBytes(value) {
  return new TextEncoder().encode(value);
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatPdfParts(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildPdfFromJpegPages(pages) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const parts = [];
  const offsets = [0];
  let byteOffset = 0;
  let maxObjectNumber = 2 + pages.length * 3;

  const push = (value) => {
    const bytes = typeof value === "string" ? stringToBytes(value) : value;
    parts.push(bytes);
    byteOffset += bytes.length;
  };

  const addObject = (objectNumber, body) => {
    offsets[objectNumber] = byteOffset;
    push(`${objectNumber} 0 obj\n`);
    push(body);
    push(`\nendobj\n`);
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  addObject(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObject(2, `<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const imageName = `Im${index + 1}`;
    const drawCommand = `q\n${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm\n/${imageName} Do\nQ`;
    const imageBytes = dataUrlToBytes(page.dataUrl);

    addObject(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /${imageName} ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    addObject(contentObject, `<< /Length ${drawCommand.length} >>\nstream\n${drawCommand}\nendstream`);

    offsets[imageObject] = byteOffset;
    push(`${imageObject} 0 obj\n`);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`);
    push(imageBytes);
    push(`\nendstream\nendobj\n`);
  });

  const xrefOffset = byteOffset;
  push(`xref\n0 ${maxObjectNumber + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= maxObjectNumber; i++) {
    push(`${String(offsets[i] || 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${maxObjectNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob([concatPdfParts(parts)], { type: "application/pdf" });
}

async function urlToDataUrl(url) {
  if (!url || /^data:/i.test(url)) return url;
  const absoluteUrl = new URL(assetUrl(url), window.location.href).href;
  const response = await fetch(absoluteUrl);
  if (!response.ok) throw new Error(`Asset load failed: ${absoluteUrl}`);
  const blob = await response.blob();

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function inlineRecapPdfAssets(root) {
  const images = Array.from(root.querySelectorAll("img"));
  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src) continue;
    try {
      img.setAttribute("src", await urlToDataUrl(src));
    } catch (e) {
      console.warn("Recap PDF image inline failed:", src, e);
    }
  }

  const elements = Array.from(root.querySelectorAll("*"));
  for (const el of elements) {
    const bg = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;

    const urls = [...bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
    let nextBg = bg;
    for (const match of urls) {
      try {
        const dataUrl = await urlToDataUrl(match[1]);
        nextBg = nextBg.replace(match[1], dataUrl);
      } catch (e) {
        console.warn("Recap PDF background inline failed:", match[1], e);
      }
    }
    el.style.backgroundImage = nextBg;
  }
}

function createRecapPdfPageElements(sourceSheet) {
  const cleaned = sourceSheet.cloneNode(true);
  cleaned.querySelectorAll(".recapEditBtn, .recapDimActions, .recapActionsCard").forEach((el) => el.remove());
  absolutizeRecapPrintAssets(cleaned);

  const header = cleaned.querySelector(".recapHeader");
  const hero = cleaned.querySelector(".recapHero");
  const grids = Array.from(cleaned.querySelectorAll(".recapGrid"));

  const makeSheet = (...nodes) => {
    const sheet = document.createElement("section");
    sheet.className = "recapSheet";
    nodes.filter(Boolean).forEach((node) => sheet.appendChild(node.cloneNode(true)));
    return sheet;
  };

  return [
    makeSheet(header, hero, grids[0]),
    makeSheet(grids[1], grids[2]),
  ];
}

function wrapRecapPdfPage(pageSheet) {
  const page = document.createElement("div");
  page.className = "recapPdfRasterPage";

  const shell = document.createElement("main");
  shell.className = "recapPrintShell";
  shell.appendChild(pageSheet);

  page.appendChild(shell);
  return page;
}

function getRecapPdfAssetUrl(src, { format = "jpeg", width = 320, quality = 0.68 } = {}) {
  if (!src || /^data:/i.test(src)) return src;

  try {
    const sourceUrl = new URL(src, window.location.href);
    const basePath = getAppBasePath();
    const assetPath = sourceUrl.pathname.startsWith(basePath)
      ? `/${sourceUrl.pathname.slice(basePath.length)}`
      : sourceUrl.pathname;

    if (!assetPath.startsWith("/images/") && !assetPath.startsWith("/textures/")) {
      return src;
    }

    const endpoint = new URL(apiUrl("/api/pdf-asset"));
    endpoint.searchParams.set("src", `${assetPath}${sourceUrl.search}`);
    endpoint.searchParams.set("w", String(width));
    endpoint.searchParams.set("q", String(quality));
    if (format === "png") endpoint.searchParams.set("format", "png");
    return endpoint.href;
  } catch (error) {
    return src;
  }
}

function rewriteRecapPdfBackgroundAssets(backgroundImage, options) {
  if (!backgroundImage || backgroundImage === "none") return backgroundImage;

  return backgroundImage.replace(/url\(["']?([^"')]+)["']?\)/g, (full, src) => {
    const nextUrl = getRecapPdfAssetUrl(src, options);
    return `url("${nextUrl.replace(/"/g, "%22")}")`;
  });
}

function optimizeRecapPdfAssetReferences(root) {
  if (!root) return;

  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) return;

    const isLogo = img.classList.contains("recapPdfLogo");
    const tileMedia = img.closest(".recapTileMedia");
    const isTileImage = !!tileMedia;
    const needsTransparency = tileMedia?.classList.contains("is-leg-image");
    const width = isLogo ? 520 : isTileImage ? 260 : 420;
    const quality = needsTransparency ? 0.8 : isLogo ? 0.84 : 0.64;
    const format = needsTransparency ? "png" : "jpeg";

    img.setAttribute("src", getRecapPdfAssetUrl(src, { format, width, quality }));
  });

  root.querySelectorAll("*").forEach((el) => {
    const bg = el.style.backgroundImage;
    if (!bg || bg === "none") return;

    const isSwatch =
      el.classList.contains("recapMaterialSwatch") ||
      el.classList.contains("is-swatch");
    const isTileMedia = el.classList.contains("recapTileMedia");
    const width = isSwatch ? 180 : isTileMedia ? 260 : 320;
    const quality = isSwatch ? 0.58 : 0.64;

    el.style.backgroundImage = rewriteRecapPdfBackgroundAssets(bg, { width, quality });
  });
}

async function renderRecapPdfPageToJpeg(pageSheet) {
  const width = 794;
  const height = 1123;
  const scale = 2;
  const page = wrapRecapPdfPage(pageSheet);
  await inlineRecapPdfAssets(page);

  const pageCss = `
    ${getRecapPrintStyles()}
    html, body { margin: 0; padding: 0; background: #fff; }
    .recapPdfRasterPage {
      width: ${width}px;
      height: ${height}px;
      padding: 38px;
      background: #fff;
      overflow: hidden;
    }
    .recapPrintShell { width: 100%; margin: 0; }
    .recapSheet { width: 100%; }
  `;

  const xhtml = new XMLSerializer().serializeToString(page);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <foreignObject width="${width}" height="${height}">
        <div xmlns="http://www.w3.org/1999/xhtml">
          <style>${pageCss}</style>
          ${xhtml}
        </div>
      </foreignObject>
    </svg>
  `;

  const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = svgUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

async function buildRecapPdfHtml({ autoPrint = false } = {}) {
  if (recapDimsEditMode) exitRecapDimsEditMode({ save: true, render: false });

  renderRecapView();
  await renderRecapSofaImageDeferred();
  copyCurrentPlanToRecap();
  await waitRecapFrame();

  const sourceSheet = document.querySelector("#recapView .recapSheet");
  if (!sourceSheet) return null;

  const cleaned = sourceSheet.cloneNode(true);

  // V tiskové verzi nechceme editaci ani akční tlačítka
  cleaned
    .querySelectorAll(".recapEditBtn, .recapDimActions, .recapActionsCard")
    .forEach((el) => el.remove());

  absolutizeRecapPrintAssets(cleaned);
  optimizeRecapPdfAssetReferences(cleaned);

  const sourceHeader = cleaned.querySelector(".recapHeader");
  const sourceHero = cleaned.querySelector(".recapHero");
  const sourceGrids = Array.from(cleaned.querySelectorAll(".recapGrid"));

  // Rozdělení obsahu:
  // page 1 = header + hero + 1. grid (půdorys + složení)
  // page 2 = zbytek (vybavení + materiál + cena)
  const page1Nodes = [
    sourceHeader ? sourceHeader.cloneNode(true) : null,
    sourceHero ? sourceHero.cloneNode(true) : null,
    sourceGrids[0] ? sourceGrids[0].cloneNode(true) : null
  ].filter(Boolean);

  const page2Nodes = sourceGrids.slice(1).map((grid) => grid.cloneNode(true));

  // Spodní grid s cenou roztáhneme přes celou šířku
  if (page2Nodes.length) {
    const lastGrid = page2Nodes[page2Nodes.length - 1];
    lastGrid.classList.remove("recapGridTwo");
    lastGrid.classList.add("recapPdfPriceGrid");
  }

  const sofaName = document.getElementById("recapSofaName")?.textContent?.trim() || "Konfigurace";
  const sofaSubtitle = document.getElementById("recapSofaSubtitle")?.textContent?.trim() || "";
  const recapDateText = document.getElementById("recapDate")?.textContent?.trim() || "";
  const fileName = getRecapPdfFilename();
  const baseHref = escapeHtmlText(new URL("./", window.location.href).href);
  const logoSrc = escapeHtmlText(getRecapPdfAssetUrl(
    new URL("./images/madros-logo2.jpg", window.location.href).href,
    { width: 520, quality: 0.84 }
  ));

  function buildPdfPage(contentNodes, pageNumber, totalPages) {
    const page = document.createElement("section");
    page.className = "recapPdfPage";

    const inner = document.createElement("div");
    inner.className = "recapPdfPageInner";

    inner.innerHTML = `
      <div class="recapPdfHeaderBar">
        <div class="recapPdfBrand">
          <img src="${logoSrc}" alt="Madros" class="recapPdfLogo">
          <div class="recapPdfBrandText">
            <strong>Rekapitulace konfigurace</strong>
            <span>Sedací souprava na míru</span>
          </div>
        </div>

        <div class="recapPdfMeta">
          <strong>${escapeHtmlText(sofaName)}</strong>
          <span>${escapeHtmlText(sofaSubtitle)}</span>
          <span>${escapeHtmlText(recapDateText)}</span>
        </div>
      </div>

      <div class="recapPdfBody"></div>

      <div class="recapPdfFooter">
        <span>www.madros.cz · info@madros.cz</span>
        <strong>${pageNumber} / ${totalPages}</strong>
      </div>
    `;

    const body = inner.querySelector(".recapPdfBody");

    const sheet = document.createElement("div");
    sheet.className = "recapSheet recapPdfSheet";

    contentNodes.forEach((node) => sheet.appendChild(node));
    body.appendChild(sheet);

    page.appendChild(inner);
    return page.outerHTML;
  }

  const totalPages = 2;

  const pagesHtml = [
    buildPdfPage(page1Nodes, 1, totalPages),
    buildPdfPage(page2Nodes, 2, totalPages)
  ].join("");

  const autoPrintScript = autoPrint ? `
        <script>
          window.addEventListener("load", function () {
            setTimeout(function () {
              window.focus();
              window.print();
            }, 500);
          });
        <\/script>
  ` : "";

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <base href="${baseHref}">
        <title>${escapeHtmlText(fileName)}</title>
        <style>
          ${getRecapPrintStyles()}

          @page {
            size: A4 portrait;
            margin: 0;
          }

          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
          }

          body {
            background: #ffffff !important;
          }

          .recapPrintShell {
            width: 210mm !important;
            margin: 0 auto !important;
            background: #ffffff !important;
          }

          .recapPdfPage {
            width: 210mm;
            min-height: 297mm;
            padding: 12mm 12mm 12mm;
            background: #ffffff;
            page-break-after: always;
            break-after: page;
          }

          .recapPdfPage:last-child {
            page-break-after: auto;
            break-after: auto;
          }

          .recapPdfPageInner {
            min-height: calc(297mm - 24mm);
            display: flex;
            flex-direction: column;
          }

          .recapPdfHeaderBar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            padding-bottom: 8px;
            margin-bottom: 12px;
            border-bottom: 1px solid #e6ebf1;
          }

          .recapPdfBrand {
            display: flex;
            align-items: center;
            gap: 6mm;
            min-width: 0;
            max-width: 95mm;
          }

          .recapPdfLogo {
            display: block !important;
            width: 34mm !important;
            height: auto !important;
            max-width: 34mm !important;
            max-height: 12mm !important;
            object-fit: contain !important;
            flex: 0 0 34mm !important;
          }

          .recapPdfBrandMark {
            min-width: 38mm;
            height: 14mm;
            padding: 0 10px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #111827;
            color: #ffffff;
            font-size: 14px;
            font-weight: 900;
            letter-spacing: .05em;
          }

          .recapPdfBrandText strong {
            display: block;
            margin: 0;
            color: #111827;
            font-size: 12px;
            line-height: 1.15;
            font-weight: 800;
          }

          .recapPdfBrandText span {
            display: block;
            margin-top: 2px;
            color: #6b7280;
            font-size: 9px;
            line-height: 1.2;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: .08em;
          }

          .recapPdfMeta {
            text-align: right;
            display: grid;
            gap: 2px;
          }

          .recapPdfMeta strong {
            color: #111827;
            font-size: 11px;
            line-height: 1.2;
            font-weight: 800;
          }

          .recapPdfMeta span {
            color: #6b7280;
            font-size: 9px;
            line-height: 1.2;
            font-weight: 700;
          }

          .recapPdfBody {
            flex: 1;
          }

          .recapPdfFooter {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            margin-top: 12px;
            padding-top: 8px;
            border-top: 1px solid #e6ebf1;
            color: #6b7280;
            font-size: 9px;
            line-height: 1.2;
            font-weight: 700;
          }

          .recapPdfFooter strong {
            color: #111827;
            font-weight: 800;
          }

          .recapPdfSheet {
            width: 100%;
            background: #ffffff !important;
            box-shadow: none !important;
          }

          /* Jemné doladění 1. stránky, aby nebyla tak prázdná */
          .recapHeader {
            margin-bottom: 16px !important;
          }

          .recapHero {
            margin-bottom: 12px !important;
          }

          .recapHeroImageWrap {
            min-height: 76mm !important;
          }

          .recapHeroImage {
            height: 76mm !important;
          }

          #recapPlanSvg {
            height: 58mm !important;
          }

          .recapCard,
          .recapIntroCard {
            padding: 12px !important;
          }

          .recapGrid {
            gap: 12px !important;
            margin-top: 12px !important;
          }

          .recapGridTwo {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          }

          /* Tisková verze: bez tužky a bez akčních tlačítek */
          .recapEditBtn,
          .recapDimActions,
          .recapActionsCard {
            display: none !important;
          }

          /* Cenové shrnutí na 2. stránce přes celou šířku */
          .recapPdfPriceGrid,
          .recapFinalGrid {
            width: 100% !important;
            grid-template-columns: 1fr !important;
          }

          .recapPdfPriceGrid .recapCard,
          .recapFinalGrid .recapCard {
            width: 100% !important;
          }

          @media print {
            html, body {
              width: 210mm;
              background: #ffffff !important;
            }

            .recapPrintShell {
              width: 210mm !important;
              margin: 0 auto !important;
            }

            .recapPdfPage {
              page-break-after: always;
              break-after: page;
            }

            .recapPdfPage:last-child {
              page-break-after: auto;
              break-after: auto;
            }
          }
        </style>
      </head>

      <body>
        <main class="recapPrintShell">
          ${pagesHtml}
        </main>
        ${autoPrintScript}
      </body>
    </html>
  `;

  return { html, fileName };
}

async function openRecapPdfDocument() {
  const pdfDoc = await buildRecapPdfHtml({ autoPrint: true });
  if (!pdfDoc) return;

  const printWindow = window.open("", "_blank");

  if (!printWindow) {
    alert("Prohlížeč zablokoval otevření PDF okna. Povolte prosím vyskakovací okna pro tuto stránku.");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(pdfDoc.html);
  printWindow.document.close();
}

function getRecapPdfEndpoints() {
  if (window.RECAP_PDF_ENDPOINT) return [window.RECAP_PDF_ENDPOINT];

  return [
    apiUrl("/api/export-recap-pdf"),
  ];
}

async function downloadRecapPdfDocument() {
  const pdfDoc = await buildRecapPdfHtml();
  if (!pdfDoc) throw new Error("Recap PDF source is not available.");

  let lastError = null;

  for (const endpoint of getRecapPdfEndpoints()) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          html: pdfDoc.html,
          filename: pdfDoc.fileName,
        }),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `PDF server returned ${response.status}`);
      }

      const blob = await response.blob();
      downloadBlob(blob, pdfDoc.fileName);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("PDF export failed.");
}

function getRecapInquiryEndpoints() {
  if (window.RECAP_INQUIRY_ENDPOINT) return [window.RECAP_INQUIRY_ENDPOINT];

  return [
    apiUrl("/api/send-recap-inquiry"),
  ];
}

function getStoredRecapCustomerEmail() {
  try {
    return localStorage.getItem("madrosCustomerEmail") || "";
  } catch (error) {
    return "";
  }
}

function setStoredRecapCustomerEmail(email) {
  try {
    localStorage.setItem("madrosCustomerEmail", email);
  } catch (error) {}
}

const RECAP_COMMON_EMAIL_DOMAINS = [
  "gmail.com",
  "seznam.cz",
  "email.cz",
  "post.cz",
  "centrum.cz",
  "volny.cz",
  "atlas.cz",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "yahoo.com",
  "proton.me",
  "madros.cz",
];

const RECAP_BLOCKED_EMAIL_DOMAINS = new Set([
  "email.com",
  "gmail.cz",
  "gmail.co",
  "gmai.com",
  "gmial.com",
  "gmal.com",
  "gmaill.com",
  "seznam.com",
  "sezam.cz",
  "seznm.cz",
  "sesnam.cz",
  "email.c",
  "seznam.c",
  "centrum.c",
  "outlook.c",
  "hotmal.com",
  "hotmai.com",
  "icloud.c",
]);

function getLevenshteinDistance(a, b) {
  a = String(a || "");
  b = String(b || "");

  const matrix = Array.from({ length: a.length + 1 }, () => []);

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function getClosestRecapEmailDomain(domain) {
  const cleanDomain = String(domain || "").trim().toLowerCase();
  if (!cleanDomain) return null;

  let best = null;

  for (const knownDomain of RECAP_COMMON_EMAIL_DOMAINS) {
    const distance = getLevenshteinDistance(cleanDomain, knownDomain);

    if (!best || distance < best.distance) {
      best = {
        domain: knownDomain,
        distance,
      };
    }
  }

  if (!best) return null;

  const maxDistance = cleanDomain.length <= 8 ? 1 : 2;

  if (best.distance <= maxDistance && best.domain !== cleanDomain) {
    return best.domain;
  }

  return null;
}

function getRecapEmailValidation(email) {
  const value = String(email || "").trim().toLowerCase();

  if (!value) {
    return {
      ok: false,
      message: "Zadejte prosím e-mailovou adresu.",
    };
  }

  if (value.includes(" ")) {
    return {
      ok: false,
      message: "E-mailová adresa nesmí obsahovat mezery.",
    };
  }

  if (value.includes("..")) {
    return {
      ok: false,
      message: "E-mailová adresa nesmí obsahovat dvě tečky za sebou.",
    };
  }

  const parts = value.split("@");

  if (parts.length !== 2) {
    return {
      ok: false,
      message: "E-mail musí obsahovat právě jeden znak @, například vas@email.cz.",
    };
  }

  const [localPart, domain] = parts;

  if (!localPart) {
    return {
      ok: false,
      message: "Před znakem @ chybí jméno e-mailu.",
    };
  }

  if (!domain) {
    return {
      ok: false,
      message: "Za znakem @ chybí doména, například seznam.cz nebo gmail.com.",
    };
  }

  if (localPart.startsWith(".") || localPart.endsWith(".")) {
    return {
      ok: false,
      message: "Část před @ nesmí začínat ani končit tečkou.",
    };
  }

  if (domain.startsWith(".") || domain.endsWith(".")) {
    return {
      ok: false,
      message: "Doména nesmí začínat ani končit tečkou.",
    };
  }

  if (!domain.includes(".")) {
    return {
      ok: false,
      message: "V doméně chybí tečka, například gmail.com nebo seznam.cz.",
    };
  }

  const domainParts = domain.split(".");
  const tld = domainParts[domainParts.length - 1];

  if (!tld || tld.length < 2) {
    return {
      ok: false,
      message: "Koncovka domény musí mít alespoň 2 znaky, například .cz nebo .com.",
    };
  }

  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart)) {
    return {
      ok: false,
      message: "E-mail obsahuje nepovolené znaky před znakem @.",
    };
  }

  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return {
      ok: false,
      message: "Doména e-mailu obsahuje nepovolené znaky.",
    };
  }

  if (RECAP_BLOCKED_EMAIL_DOMAINS.has(domain)) {
    const suggestion = getClosestRecapEmailDomain(domain);

    return {
      ok: false,
      message: suggestion
        ? `Doména vypadá jako překlep. Nemysleli jste ${localPart}@${suggestion}?`
        : "Doména e-mailu vypadá jako překlep. Zkontrolujte ji prosím.",
    };
  }

  const suggestion = getClosestRecapEmailDomain(domain);

  if (suggestion) {
    return {
      ok: false,
      message: `Doména vypadá jako překlep. Nemysleli jste ${localPart}@${suggestion}?`,
    };
  }

  return {
    ok: true,
    message: "",
  };
}

function isValidRecapEmail(email) {
  return getRecapEmailValidation(email).ok;
}

function getRecapInquiryModal() {
  let modal = document.getElementById("recapInquiryModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "recapInquiryModal";
  modal.className = "recapInquiryModal hidden";
  modal.innerHTML = `
    <div class="recapInquiryBackdrop" data-recap-inquiry-close></div>
    <div class="recapInquiryDialog" role="dialog" aria-modal="true" aria-labelledby="recapInquiryTitle">
      <button class="recapInquiryClose" type="button" aria-label="Zavřít" data-recap-inquiry-close>×</button>
      <h2 id="recapInquiryTitle">Odeslat poptávku</h2>
      <p>Zadejte email, kam pošleme potvrzení a rekapitulaci konfigurace.</p>
      <label class="recapInquiryField">
        <span>Email zákazníka</span>
        <input id="recapInquiryEmail" type="email" autocomplete="email" placeholder="vas@email.cz">
      </label>
      <div id="recapInquiryMessage" class="recapInquiryMessage" aria-live="polite"></div>
      <div class="recapInquiryActions">
        <button class="recapInquirySecondary" type="button" data-recap-inquiry-close>Zrušit</button>
        <button class="recapInquiryPrimary" type="button" id="recapInquirySubmit">Odeslat</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

let recapInquirySending = false;

window.addEventListener("beforeunload", (event) => {
  if (!recapInquirySending) return;
  event.preventDefault();
  event.returnValue = "";
});

function getSendingDotsHtml(label) {
  return `
    <span class="sendingText">${escapeHtmlText(label)}</span>
    <span class="sendingDots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
  `;
}

function setButtonSendingState(button, busy, {
  busyLabel = "Odesílám poptávku",
  idleLabel = "Odeslat poptávku",
} = {}) {
  if (!button) return;

  button.disabled = Boolean(busy);
  button.classList.toggle("is-sending", Boolean(busy));

  if (busy) {
    button.innerHTML = getSendingDotsHtml(busyLabel);
    button.setAttribute("aria-label", `${busyLabel}...`);
  } else {
    button.textContent = idleLabel;
    button.removeAttribute("aria-label");
  }
}

function setRecapInquiryModalState(modal, { busy = false, message = "", tone = "" } = {}) {
  const submit = modal.querySelector("#recapInquirySubmit");
  const input = modal.querySelector("#recapInquiryEmail");
  const msg = modal.querySelector("#recapInquiryMessage");

  if (submit) {
    setButtonSendingState(submit, busy, {
      busyLabel: "Odesílám",
      idleLabel: "Odeslat",
    });
  }

  if (input) input.disabled = busy;

  if (msg) {
    msg.textContent = message;
    msg.dataset.tone = tone;
  }
}

function askForRecapCustomerEmail() {
  return new Promise((resolve) => {
    const modal = getRecapInquiryModal();
    const input = modal.querySelector("#recapInquiryEmail");
    const submit = modal.querySelector("#recapInquirySubmit");
    let done = false;

    const close = (value = null) => {
      if (done) return;
      done = true;
      modal.classList.add("hidden");
      modal.querySelectorAll("[data-recap-inquiry-close]").forEach((el) => {
        el.removeEventListener("click", onCancel);
      });
      submit?.removeEventListener("click", onSubmit);
      input?.removeEventListener("keydown", onKeydown);
      input?.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onDocumentKeydown);
      resolve(value);
    };

    const onCancel = () => close(null);
    const onDocumentKeydown = (event) => {
      if (event.key === "Escape") close(null);
    };
    const onKeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      }
    };
    const onSubmit = () => {
      const email = String(input?.value || "").trim();
      const validation = getRecapEmailValidation(email);

      if (!validation.ok) {
        input?.classList.add("is-invalid");

        setRecapInquiryModalState(modal, {
          message: validation.message || "Zadejte prosím platnou e-mailovou adresu.",
          tone: "error",
        });

        input?.focus();
        return;
      }

      input?.classList.remove("is-invalid");
      close(email);
    };

    if (input) input.value = getStoredRecapCustomerEmail();
    setRecapInquiryModalState(modal);
    modal.classList.remove("hidden");

    modal.querySelectorAll("[data-recap-inquiry-close]").forEach((el) => {
      el.addEventListener("click", onCancel);
    });
    const onInput = () => {
      input?.classList.remove("is-invalid");
      setRecapInquiryModalState(modal, {
        message: "",
        tone: "",
      });
    };

    submit?.addEventListener("click", onSubmit);
    input?.addEventListener("keydown", onKeydown);
    input?.addEventListener("input", onInput);
    document.addEventListener("keydown", onDocumentKeydown);
    setTimeout(() => input?.focus(), 0);
  });
}

async function getRecapInquirySummary(
  shareState = getCurrentSharedConfigurationState(),
  configurationUrl = ""
) {
  renderRecapView();

  const sofaKey = getActiveSofaKeyFromScene();
  const meta = SOFA_SUMMARY_META[sofaKey] || SOFA_SUMMARY_META.Manila;
  const total = getDiscountedAmount(getConfiguredTotalPrice()).final;
  const modelConfig = MODEL_EQUIP_CONFIG[getModelKey()] || {};
  const leg = getRecapLegMeta();
  const legColor = getRecapLegColorMeta();
  const armrest = getRecapArmrestMeta();

  const equipmentText = [
    leg?.label ? `Nohy: ${leg.label}` : "",
    legColor?.label ? `Barva nohou: ${legColor.label}` : "",
    armrest?.label ? `Područky: ${armrest.label}` : "",
    (modelConfig.hinges || []).length ? `Panty: ${getRecapHingeMeta()?.label || getRecapHingeLabel()}` : "",
    (modelConfig.shelfColors || []).length ? `Polička: ${getRecapShelfColorMeta()?.label || ""}` : "",
  ].filter(Boolean).join(" · ");

  const finalUrl = String(configurationUrl || "").trim();

  return {
    assemblyType: getAssemblyTypeLabel(),
    assemblyText: getRecapAssemblyText(),
    equipmentText,
    sofaName: document.getElementById("recapSofaName")?.textContent?.trim() || meta.title || "Konfigurace",
    totalPrice: formatCzk(total),

    // Tohle se pak propíše do e-mailu.
    url: finalUrl,
  };
}

async function sendRecapInquiry(customerEmail) {
  const shareState = getCurrentSharedConfigurationState();

  if (!shareState) {
    throw new Error("Nepodařilo se připravit stav konfigurace pro sdílený odkaz.");
  }

  const configurationUrl = await createShortConfigurationShareUrl(shareState);

  if (!configurationUrl) {
    throw new Error("Nepodařilo se vytvořit krátký odkaz na konfiguraci.");
  }

  const pdfDoc = await buildRecapPdfHtml();
  if (!pdfDoc) throw new Error("Rekapitulace není dostupná.");

  const summary = await getRecapInquirySummary(shareState, configurationUrl);
  let lastError = null;

  for (const endpoint of getRecapInquiryEndpoints()) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customerEmail,
          filename: pdfDoc.fileName,
          html: pdfDoc.html,
          summary,

          // Pořád posíláme i state, aby si ho server případně uměl uložit / ověřit.
          shareState,
          shareUrlBase: getShareUrlBase(),
        }),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `Server vrátil chybu ${response.status}.`);
      }

      setStoredRecapCustomerEmail(customerEmail);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Poptávku se nepodařilo odeslat.");
}

function enterRecapDimsEditMode() {
  recapDimsEditMode = true;
  recapDimsEditDraft = {};
  for (const row of getRecapDimensionRows()) {
    if (row.dim) recapDimsEditDraft[row.dim] = row.valueNumber;
  }
  renderRecapView();
}

function exitRecapDimsEditMode({ save = false, render = true } = {}) {
  const host = document.getElementById("recapDimensions");

  if (save && host) {
    host.querySelectorAll(".recapDimInput").forEach((input) => {
      const dim = input.dataset.dim || "";
      if (!dim) return;

      const raw = input.value;
      if (typeof window.__setSofaDimFromRecap === "function") {
        window.__setSofaDimFromRecap(dim, raw);
      } else {
        const parsed = parseInt(String(raw).replace(/[^\d-]/g, ""), 10);
        const min = Number(input.dataset.min);
        const max = Number(input.dataset.max);
        if (Number.isFinite(parsed)) {
          window.__sofaDims[dim] = clamp(
            parsed,
            Number.isFinite(min) ? min : -Infinity,
            Number.isFinite(max) ? max : Infinity
          );
        }
      }
    });
  }

  recapDimsEditMode = false;
  recapDimsEditDraft = {};

  try { window.__refreshSofaPlanEverywhere?.(); } catch (e) {}
  try { updateSummaryUI(); } catch (e) {}
  try { scheduleSummaryRecalc(); } catch (e) {}

  if (render) renderRecapView();
}

function isBuildStepActive() {
  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");
  return isConfigurator && appState.step === 2;
}

function isHeadrestStepActive() {
  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");
  return isConfigurator && appState.step === 3;
}

// kterĂ˝ sub-tab je aktivnĂ­ v kroku 3 (bottom bar)
let currentEquipTabKey = "armrests";
let currentFabricTabKey = "cat1";
let currentFabricTargetMode = "sofa";
const renderedFabricTabs = new Set();

let activeFabricFamilyByTab = {
  cat1: null,
  cat2: null,
  cat3: null,
  leather: null,
  paspule: null,
};

function getActiveFabricFamilyForTab(tabKey) {
  return activeFabricFamilyByTab?.[tabKey] || null;
}

function setActiveFabricFamilyForTab(tabKey, fabricKey) {
  if (!tabKey || !fabricKey) return;
  activeFabricFamilyByTab[tabKey] = fabricKey;
}

let appliedFabricPriceGroup = "g1";

function getSelectedFabricStatePayload(value) {
  if (!value) return null;
  return {
    fabricKey: value.fabricKey || null,
    fabricName: value.fabricName || null,
    shade: value.shade || null,
    baseColorUrl: value.baseColorUrl || null,
    normalUrl: value.normalUrl || null,
    roughnessUrl: value.roughnessUrl || null,
  };
}

function getFabricFamilyByKey(tabKey, fabricKey) {
  const list =
    tabKey === "leather"
      ? FABRICS_LEATHER
      : tabKey === "cat3"
      ? FABRICS_CAT3
      : tabKey === "cat2"
        ? FABRICS_CAT2
        : FABRICS_CAT1;
  return (list || []).find((f) => f.key === fabricKey) || null;
}

function getAppliedFabricPriceGroup() {
  if ((appState.unlockedStep || 1) < 4) return "g1";
  return appliedFabricPriceGroup || "g1";
}

function getFabricPriceGroupFromTabKey(tabKey) {
  if (tabKey === "cat3") return "g3";
  if (tabKey === "cat2") return "g2";
  if (tabKey === "leather") return "leather";
  return "g1";
}

function calcTotalPriceForFabricGroup(fabricGroup) {
  let total = 0;

  for (const rec of activeModules || []) {
    const upgradeKey = getUpgradeKeyForRec(rec);
    total += getSummaryPriceForRecSafe(rec, fabricGroup, upgradeKey);
  }

  return total;
}

function getAppliedFabricTabKey() {
  if (appliedFabricPriceGroup === "g3") return "cat3";
  if (appliedFabricPriceGroup === "g2") return "cat2";
  if (appliedFabricPriceGroup === "leather") return "leather";
  return "cat1";
}

function getSelectedFabricForTabKey(tabKey) {
  if (tabKey === "cat3") return selectedFabricCat3;
  if (tabKey === "cat2") return selectedFabricCat2;
  if (tabKey === "cat1") return selectedFabricCat1;
  if (tabKey === "leather") return selectedFabricLeather;
  return null;
}

function updateFabricSelectionIndicators() {
  const appliedTabKey = getAppliedFabricTabKey();

  document.querySelectorAll("#bottomBar .fabricPriceTab").forEach((tab) => {
    const tabKey = tab.dataset.tab;
    const shouldShow =
      tabKey === appliedTabKey &&
      tabKey !== currentFabricTabKey;

    tab.classList.toggle("hasFabricSelectionHint", shouldShow);
    tab.dataset.selectionHint = shouldShow
      ? "Tady máte aktuálně vybranou látku."
      : "";
  });

  const selected = getSelectedFabricForTabKey(currentFabricTabKey);
  const selectedFabricKey = selected?.fabricKey || "";

  document.querySelectorAll("#bottomBar .fabricFamilyTab").forEach((tab) => {
    const shouldShow =
      !!selectedFabricKey &&
      tab.dataset.fabricKey === selectedFabricKey &&
      !tab.classList.contains("is-active");

    tab.classList.toggle("hasFabricSelectionHint", shouldShow);
    tab.dataset.selectionHint = shouldShow
      ? "Tady máte aktuálně vybranou látku."
      : "";
  });

  document
    .querySelectorAll("#bottomBar .fabricFamilyTooltipOverlay.is-visible")
    .forEach((tooltip) => {
      const browser = tooltip.closest(".fabricBrowserMain");
      const hoveredHint = browser?.querySelector(".fabricFamilyTab.hasFabricSelectionHint:hover");

      if (!hoveredHint) {
        tooltip.classList.remove("is-visible");
        tooltip.textContent = "";
        tooltip.setAttribute("aria-hidden", "true");
      }
    });

}

function updateFabricCategoryTabPrices() {
  const map = {
    cat1: "g1",
    cat2: "g2",
    cat3: "g3",
    leather: "leather",
  };

  for (const [tabKey, fabricGroup] of Object.entries(map)) {
    const el = document.querySelector(`.fabricPriceTabPrice[data-price-for="${tabKey}"]`);
    if (!el) continue;

    const price = calcTotalPriceForFabricGroup(fabricGroup);

    if (price > 0) {
      const discounted = getDiscountedAmount(price);
      el.classList.remove("hasDiscount");
      el.textContent = formatCzk(discounted.final);
    } else {
      el.textContent = "—";
    }
  }
}

function applySelectedFabricSelectionForTab(tabKey) {
  const selected =
    tabKey === "leather"
      ? selectedFabricLeather
      : tabKey === "cat3"
      ? selectedFabricCat3
      : tabKey === "cat2"
        ? selectedFabricCat2
        : selectedFabricCat1;
  if (!selected?.baseColorUrl) return;

  const family = getFabricFamilyByKey(tabKey, selected.fabricKey);

  applyFabricToSofaByMaterialMap({
    fabricKey: selected.fabricKey || "",
    baseColorUrl: selected.baseColorUrl,
    normalUrl: selected.normalUrl,
    roughnessUrl: selected.roughnessUrl,
    repeat: family?.repeat ?? 2,
    normalScale: family?.normalScale ?? null,
  });
}

function reapplyCurrentFabricIfSelected() {
  const tabKey = getAppliedFabricTabKey();
  const selected = getSelectedFabricForTabKey(tabKey);

  if (!selected?.baseColorUrl) return false;

  applySelectedFabricSelectionForTab(tabKey);
  return true;
}

function reapplyCurrentFabricAndPaspuleIfSelected() {
  let didApply = false;

  // 1) hlavní látka sedačky
  try {
    didApply = !!reapplyCurrentFabricIfSelected?.() || didApply;
  } catch (e) {
    console.warn("Reapply sofa fabric failed:", e);
  }

  // 2) paspule - musí jít až po hlavní látce,
  // aby se materiál paspule znovu nepřepsal hlavní látkou
  try {
    didApply = !!applySelectedPaspuleFabricIfValid?.() || didApply;
  } catch (e) {
    console.warn("Reapply paspule fabric failed:", e);
  }

  return didApply;
}

function syncRenderedFabricBrowserSelection(tabKey) {
  const suffix = String(tabKey || "").replace(/[^a-z0-9]/gi, "");

  const selected =
    tabKey === "paspule"
      ? selectedPaspuleFabric
      : tabKey === "leather"
      ? selectedFabricLeather
      : tabKey === "cat3"
      ? selectedFabricCat3
      : tabKey === "cat2"
        ? selectedFabricCat2
        : selectedFabricCat1;

  const paspuleContext = tabKey === "paspule" ? getPaspuleFabricContext() : null;
  const activeFabricKey =
    (tabKey === "paspule" ? paspuleContext?.family?.key : null) ||
    getActiveFabricFamilyForTab(tabKey) ||
    selected?.fabricKey ||
    "";

  const tabsEl = document.getElementById(`fabricFamilyTabs${suffix}`);
  const shadesEl = document.getElementById(`fabricShadesGrid${suffix}`);
  if (!tabsEl || !shadesEl) return false;

  const wantedTab = activeFabricKey
    ? tabsEl.querySelector(`.fabricFamilyTab[data-fabric-key="${CSS.escape(activeFabricKey)}"]`)
    : null;

  if (wantedTab && !wantedTab.classList.contains("is-active")) {
    wantedTab.click();
  }

  // Aktivní odstín označ jen pokud patří do právě otevřeného druhu látky.
  const selectedBelongsToOpenFamily =
    selected?.fabricKey && selected.fabricKey === activeFabricKey;

  shadesEl
    .querySelectorAll(".fabricShadeBtn.is-active")
    .forEach((x) => x.classList.remove("is-active"));

  if (selectedBelongsToOpenFamily && selected?.shade) {
    const wantedShade = shadesEl.querySelector(
      `.fabricShadeBtn[data-shade="${CSS.escape(String(selected.shade))}"]:not(.is-empty)`
    );

    if (wantedShade) {
      wantedShade.classList.add("is-active");
    }
  }

  return !!wantedTab;
}

function updateHeadrestDotsVisibility() {
  // headrest hotspoty chci jen ve 3. kroku a jen kdyĹľ nejsou otevĹ™enĂ© "PĹ™Ă­platky"
  const show = isHeadrestStepActive() && currentEquipTabKey !== "extras";

  headrestDots.forEach((d) => {
    if (d) d.visible = show;
  });
}

const CLICK_MOVE_TOLERANCE = 12;

// =====================================================
// CANONICAL REBUILD (krok 2 -> 3)
// =====================================================

let pendingCanonicalAnalysis = null;
let needsCanonicalRebuild = false;
let canonicalRebuildInFlight = false;
let suppressPlanAnalysisDuringCanonicalRebuild = false;

async function runCanonicalRebuildBeforeLeavingStep2(nextStep) {
  if (canonicalRebuildInFlight) return true;

  canonicalRebuildInFlight = true;

  try {
    // VĹ˝DY ber ÄŤerstvou analĂ˝zu aktuĂˇlnĂ­ scĂ©ny.
    // pendingCanonicalAnalysis mĹŻĹľe bĂ˝t stale po editaci ve kroku 2
    // a pak se rebuild rozhoduje podle starĂ©ho layoutu.
    const analysis = analyzeCanonicalLayoutForStep3();
    pendingCanonicalAnalysis = analysis;
    needsCanonicalRebuild = !!analysis?.needsRebuild;

    debugLog("CANONICAL ANALYSIS", analysis);

    if (analysis?.needsRebuild) {
      debugLog("CANONICAL REBUILD TRIGGERED", {
        reason: analysis?.reason,
        branchCount: analysis?.branchCount,
        needsRebuild: analysis?.needsRebuild,
        nextStep
      });

      const snapshot = snapshotSceneModulesForCanonicalRebuild();
      const descriptor = buildCanonicalDescriptorFromAnalysis(analysis, snapshot);

      debugLog("CANONICAL DESCRIPTOR", descriptor);

      debugLog(
        "CANONICAL DESCRIPTOR VARIANTS",
        descriptor.map((x, i) => `${i}: ${x.variantId} | attachTo=${x.attachTo} | side=${x.side}`)
      );

      if (descriptor.length) {
        const ok = await rebuildSceneFromCanonicalDescriptor(descriptor, snapshot);
        if (!ok) {
          console.warn("Canonical rebuild failed, continuing with existing layout.");
        }
      }
    }

    return true;
  } catch (e) {
    console.warn("Canonical pre-step flow failed:", e);
    return true; // fallback: uĹľivatele nepustĂ­me do dead-endu
  } finally {
    canonicalRebuildInFlight = false;
    pendingCanonicalAnalysis = null;
    needsCanonicalRebuild = false;
  }
}

// =====================================================
// EXTRAS (PĹ™Ă­platky) â€“ stav + render seznamu modulĹŻ
// =====================================================

// hodnoty: "unset" | "none" | "bed" | "bed2" | "storage"
// (dĹ™Ă­v bylo "sleep", nechĂˇvĂˇm kompatibilitu nĂ­Ĺľ)
const extrasChoiceByModuleUuid = new Map();

// Sem si postupnÄ› doplnĂ­Ĺˇ variantId modulĹŻ, kterĂ© pĹ™Ă­platky UMĂŤ.
// KdyĹľ set nechĂˇĹˇ prĂˇzdnĂ˝, bereme zatĂ­m vĹˇechny moduly jako "eligible".
const EXTRAS_ELIGIBLE_VARIANTS = new Set([
  // pĹ™Ă­klad:
  // "Manila_2M",
  // "Manila_1L",
]);

function getRecVariantId(rec) {
  // activeModules record mĂˇ variantu v rec.name
  // navĂ­c mĂˇme jistotu i v rec.mesh.userData.variantId (kdyĹľ jsi pĹ™idal)
  return String(
    rec?.name ??
    rec?.variantId ??
    rec?.mesh?.userData?.variantId ??
    ""
  ).trim();
}

function hasAnyExtrasOption(variantId) {
  const c = getCatalog?.(variantId);
  if (!c) return false;

  // âś… rozhoduje jen to, co je povolenĂ© v catalogue.js
  const allowed = Array.isArray(c.allowedUpgrades) ? c.allowedUpgrades : [];
  return allowed.includes("storage") || allowed.includes("bed") || allowed.includes("bed2");
}

function isModuleEligibleForExtras(rec) {
  if (!rec?.mesh) return false;

  const variantId = getRecVariantId(rec);
  if (!variantId) return false;

  // 1) nejdĹ™Ă­v: musĂ­ mĂ­t v catalogue nÄ›jakou cenu pro storage nebo bed
  //    (pokud je storage+bed vĹˇude 0, modul v PĹ™Ă­platcĂ­ch vĹŻbec nezobrazĂ­me)
  if (!hasAnyExtrasOption(variantId)) return false;

  // 2) volitelnĂ˝ whitelist (kdyĹľ ho zaÄŤneĹˇ pouĹľĂ­vat)
  if (EXTRAS_ELIGIBLE_VARIANTS.size === 0) return true;
  return EXTRAS_ELIGIBLE_VARIANTS.has(variantId);
}

function getExtrasSofaKeyForRec(rec = null) {
  const variantId = getRecVariantId(rec);
  const fromVariant = variantId ? String(variantId).split("_")[0] : "";
  return fromVariant || getActiveSofaKeyFromScene?.() || "";
}

function extrasLabel(choice, rec = null) {
  if (choice === "none") return "Bez příplatku";
  if (choice === "bed" || choice === "sleep") {
    const sofaKey = String(getExtrasSofaKeyForRec(rec)).toLowerCase();
    return sofaKey === "melbourne" ? "Rozklad (Belgický)" : "Rozklad (Manila)";
  }
  if (choice === "bed2") return "Rozklad (Belgický)";
  if (choice === "storage") return "Úložný prostor";
  return "Zatím nevybráno";
}

function areExtrasSelectionsComplete() {
  const eligible = (activeModules || []).filter(isModuleEligibleForExtras);

  for (const rec of eligible) {
    const uuid = rec?.mesh?.uuid;
    const choice = (uuid && extrasChoiceByModuleUuid.get(uuid)) || "unset";
    if (choice === "unset") return false;
  }

  return true;
}

function setExtrasChoice(rec, choice) {
  if (!rec || !rec.mesh) return;

  // normalizace hodnot z UI ("none" | "bed" | "storage")
  const normalized =
    (choice === "sleep") ? "bed" : choice; // kdyby nÄ›kde zĹŻstalo starĂ© "sleep"

  // âś… TADY je fix persistence:
  // tohle je hodnota, kterĂˇ se uklĂˇdĂˇ do localStorage jako `upgrade: r.upgrade`
  // (viz saveStateNow: upgrade: r.upgrade || null)
  rec.upgrade = (!normalized || normalized === "none") ? null : normalized;

  // mapu si nechĂˇme pro UI highlight
  extrasChoiceByModuleUuid.set(rec.mesh.uuid, normalized || "unset");

  // pĹ™ekreslit tab + pĹ™epoÄŤĂ­tat summary + uloĹľit
  renderExtrasModuleList();
  scheduleSummaryRecalc();
  updateStep3ContinueUI();
  saveStateDebounced(50);
}

function openBedTypeModalForRec(rec, diffBed, diffBed2) {
  // UPRAV SI CESTY K OBRĂZKĹ®M:
  const IMG_BED_MANILA   = "./images/models/mendoza/rozklad-M.jpg";
  const IMG_BED_BELGICKY = "./images/models/mendoza/rozklad-B.jpg";

  // zavĹ™i pĹ™Ă­padnĂ˝ existujĂ­cĂ­
  const existing = document.getElementById("bedTypeModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "bedTypeModal";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "99999";

  const box = document.createElement("div");
  box.style.width = "min(980px, 92vw)";
  box.style.maxHeight = "86vh";
  box.style.overflow = "auto";
  box.style.background = "#fff";
  box.style.borderRadius = "16px";
  box.style.padding = "18px";
  box.style.position = "relative";

  // font pro celĂ˝ modal
  box.style.fontFamily =
    'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  // ===== header: title + X vpravo nahoĹ™e (stejnĂ© jako module picker) =====
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";
  header.style.marginBottom = "12px";

  const h = document.createElement("div");
  h.style.fontSize = "18px";
  h.style.fontWeight = "700";
  h.style.lineHeight = "1.2";
  h.textContent = "Vyber typ rozkladu";

  // âś… klonuj existujĂ­cĂ­ X z pickeru (stejnĂ˝ styl)
  let closeX = null;
  const pickerClose = document.getElementById("modulePickerClose");
  if (pickerClose) {
    closeX = pickerClose.cloneNode(true);
    closeX.removeAttribute("id");           // aĹĄ nemĂˇĹˇ duplicitnĂ­ id
    closeX.onclick = () => overlay.remove(); // pĹ™epiĹˇ akci
  } else {
    // fallback (kdyby nebyl v DOM)
    closeX = document.createElement("button");
    closeX.type = "button";
    closeX.textContent = "×";
    closeX.style.width = "36px";
    closeX.style.height = "36px";
    closeX.style.borderRadius = "10px";
    closeX.style.border = "1px solid rgba(0,0,0,0.12)";
    closeX.style.background = "#fff";
    closeX.style.cursor = "pointer";
    closeX.style.fontSize = "22px";
    closeX.style.lineHeight = "1";
    closeX.style.fontWeight = "700";
    closeX.onclick = () => overlay.remove();
  }

  closeX.style.border = "none";
  closeX.style.background = "transparent";
  closeX.style.boxShadow = "none";
  closeX.style.width = "48px";
  closeX.style.height = "48px";
  closeX.style.padding = "0";
  closeX.style.cursor = "pointer";
  closeX.style.fontSize = "26px";
  closeX.style.fontWeight = "400";
  closeX.style.lineHeight = "1";


  header.appendChild(h);
  header.appendChild(closeX);
  box.appendChild(header);

  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
  grid.style.gap = "14px";

  const mkOption = (title, imgSrc, price, onPick) => {
    const card = document.createElement("button");
    card.type = "button";
    card.style.border = "1px solid rgba(0,0,0,0.12)";
    card.style.borderRadius = "14px";
    card.style.padding = "12px";
    card.style.textAlign = "left";
    card.style.background = "#fff";
    card.style.cursor = "pointer";
    card.style.transition = "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease";
    card.style.boxShadow = "0 0 0 rgba(0,0,0,0)";

    // ===== image wrapper (text bude uvnitĹ™ obrĂˇzku) =====
    const imgWrap = document.createElement("div");
    imgWrap.style.position = "relative";
    imgWrap.style.width = "100%";
    imgWrap.style.height = "250px";
    imgWrap.style.borderRadius = "12px";
    imgWrap.style.overflow = "hidden";
    imgWrap.style.background = "#f4f5f7";
    imgWrap.style.border = "none";

    const img = document.createElement("img");
    img.src = imgSrc;
    img.alt = title;
    img.style.position = "absolute";
    img.style.top = "-30px";          // đź‘ TADY posouvĂˇĹˇ fotku vĂ˝Ĺˇ
    img.style.left = "0";
    img.style.width = "100%";
    img.style.height = "calc(100% + 25px)";
    img.style.objectFit = "cover";
    img.style.display = "block";

    // ===== overlay text =====
    const overlayInfo = document.createElement("div");
    overlayInfo.style.position = "absolute";
    overlayInfo.style.left = "0";
    overlayInfo.style.right = "0";
    overlayInfo.style.bottom = "0";
    overlayInfo.style.padding = "10px 12px";
    overlayInfo.style.color = "#111";
    overlayInfo.style.background =
      "linear-gradient(to top, rgba(255,255,255,0.98), rgba(255,255,255,0.78), rgba(255,255,255,0))";

    const t = document.createElement("div");
    t.textContent = title;
    t.style.fontWeight = "700";
    t.style.fontSize = "14px";     // âś… menĹˇĂ­
    t.style.lineHeight = "1.2";
    t.style.marginBottom = "3px";

    const p = document.createElement("div");
    p.textContent = `+${formatCzk(price)}`;
    p.style.fontWeight = "700";
    p.style.fontSize = "13px";     // âś… menĹˇĂ­
    p.style.opacity = "0.9";
    p.style.lineHeight = "1.1";

    overlayInfo.appendChild(t);
    overlayInfo.appendChild(p);

    imgWrap.appendChild(img);
    imgWrap.appendChild(overlayInfo);

    card.appendChild(imgWrap);

    // hover efekt
    const onEnter = () => {
      card.style.transform = "translateY(-2px)";
      card.style.boxShadow = "0 10px 24px rgba(0,0,0,0.10)";
      card.style.borderColor = "rgba(0,0,0,0.22)";
    };
    const onLeave = () => {
      card.style.transform = "translateY(0)";
      card.style.boxShadow = "0 0 0 rgba(0,0,0,0)";
      card.style.borderColor = "rgba(0,0,0,0.12)";
    };

    card.addEventListener("mouseenter", onEnter);
    card.addEventListener("mouseleave", onLeave);
    card.addEventListener("focus", onEnter);
    card.addEventListener("blur", onLeave);

    card.addEventListener("click", () => onPick());

    return card;
  };

  grid.appendChild(
    mkOption("Rozklad typ Manila", IMG_BED_MANILA, diffBed, () => {
      setExtrasChoice(rec, "bed");
      overlay.remove();
    })
  );

  grid.appendChild(
    mkOption("Rozklad typ Belgický", IMG_BED_BELGICKY, diffBed2, () => {
      setExtrasChoice(rec, "bed2");
      overlay.remove();
    })
  );

  box.appendChild(grid);
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openArmrestCustomModal({ modelName = "Mendoza", presetLabel = "15 / 20 / 25 cm" } = {}) {
  const CONTACT_EMAIL = "info@madros.cz"; // â† zmÄ›Ĺ na vĂˇĹˇ sprĂˇvnĂ˝ mail

  // zavĹ™i pĹ™Ă­padnĂ˝ existujĂ­cĂ­
  const existing = document.getElementById("armrestCustomModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "armrestCustomModal";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "99999";

  const box = document.createElement("div");
  box.style.width = "min(720px, 92vw)";
  box.style.maxHeight = "80vh";
  box.style.overflow = "auto";
  box.style.background = "#fff";
  box.style.borderRadius = "16px";
  box.style.padding = "18px";
  box.style.position = "relative";
  box.style.fontFamily =
    'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  // header (nĂˇzev + X)
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";
  header.style.marginBottom = "12px";

  const h = document.createElement("div");
  h.style.fontSize = "18px";
  h.style.fontWeight = "700";
  h.style.lineHeight = "1.2";
  h.textContent = "Područka na míru";

  // X â€“ zkus klonovat existujĂ­cĂ­ (stejnÄ› jako u bedType modalu)
  let closeX = null;
  const pickerClose = document.getElementById("modulePickerClose");
  if (pickerClose) {
    closeX = pickerClose.cloneNode(true);
    closeX.removeAttribute("id");
    closeX.onclick = () => overlay.remove();
  } else {
    closeX = document.createElement("button");
    closeX.type = "button";
    closeX.textContent = "×";
    closeX.onclick = () => overlay.remove();
  }

  closeX.style.border = "none";
  closeX.style.background = "transparent";
  closeX.style.boxShadow = "none";
  closeX.style.width = "48px";
  closeX.style.height = "48px";
  closeX.style.padding = "0";
  closeX.style.cursor = "pointer";
  closeX.style.fontSize = "26px";
  closeX.style.fontWeight = "400";
  closeX.style.lineHeight = "1";

  header.appendChild(h);
  header.appendChild(closeX);
  box.appendChild(header);

  const p = document.createElement("div");
  p.style.fontSize = "14px";
  p.style.lineHeight = "1.55";
  p.style.color = "rgba(0,0,0,0.78)";
  p.style.marginBottom = "14px";
  p.innerHTML =
    `Chcete jiný rozměr područky než ${presetLabel}? <br>` +
    `Neváhejte se na nás obrátit s jakýmkoliv dotazem – rádi vám područky upravíme i po centimetrech.`;

  const mail = document.createElement("a");
  mail.href = `mailto:${CONTACT_EMAIL}?subject=Područka na míru – ${modelName}`;
  mail.textContent = CONTACT_EMAIL;
  mail.style.display = "inline-block";
  mail.style.marginTop = "10px";
  mail.style.fontWeight = "700";
  mail.style.color = "#111";
  mail.style.textDecoration = "underline";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "10px";
  actions.style.marginTop = "18px";

  const btnOk = document.createElement("button");
  btnOk.type = "button";
  btnOk.textContent = "Zavřít";
  btnOk.style.border = "1px solid rgba(0,0,0,0.12)";
  btnOk.style.background = "#fff";
  btnOk.style.borderRadius = "12px";
  btnOk.style.padding = "10px 14px";
  btnOk.style.cursor = "pointer";
  btnOk.onclick = () => overlay.remove();

  actions.appendChild(btnOk);

  box.appendChild(p);
  box.appendChild(mail);
  box.appendChild(actions);

  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

function openAllBranchesCustomModal() {
  const CONTACT_EMAIL = "info@madros.cz";

  const existing = document.getElementById("allBranchesCustomModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "allBranchesCustomModal";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "99999";

  const box = document.createElement("div");
  box.style.width = "min(720px, 92vw)";
  box.style.maxHeight = "80vh";
  box.style.overflow = "auto";
  box.style.background = "#fff";
  box.style.borderRadius = "16px";
  box.style.padding = "18px";
  box.style.position = "relative";
  box.style.fontFamily =
    'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";
  header.style.marginBottom = "12px";

  const h = document.createElement("div");
  h.style.fontSize = "18px";
  h.style.fontWeight = "700";
  h.style.lineHeight = "1.2";
  h.textContent = "Nastavení každé větve";

  let closeX = null;
  const pickerClose = document.getElementById("modulePickerClose");
  if (pickerClose) {
    closeX = pickerClose.cloneNode(true);
    closeX.removeAttribute("id");
    closeX.onclick = () => overlay.remove();
  } else {
    closeX = document.createElement("button");
    closeX.type = "button";
    closeX.textContent = "×";
    closeX.onclick = () => overlay.remove();
  }

  closeX.style.border = "none";
  closeX.style.background = "transparent";
  closeX.style.boxShadow = "none";
  closeX.style.width = "48px";
  closeX.style.height = "48px";
  closeX.style.padding = "0";
  closeX.style.cursor = "pointer";
  closeX.style.fontSize = "26px";
  closeX.style.fontWeight = "400";
  closeX.style.lineHeight = "1";

  header.appendChild(h);
  header.appendChild(closeX);
  box.appendChild(header);

  const p = document.createElement("div");
  p.style.fontSize = "14px";
  p.style.lineHeight = "1.55";
  p.style.color = "rgba(0,0,0,0.78)";
  p.style.marginBottom = "14px";
  p.innerHTML =
    `Máte složitější sestavu se 4 a více větvemi a chcete nastavit každou větev zvlášť po centimetrech? <br>` +
    `Napište nám a rádi vám připravíme individuální konfiguraci na míru.`;

  const mail = document.createElement("a");
  mail.href = `mailto:${CONTACT_EMAIL}?subject=Individuální nastavení větví – Mendoza`;
  mail.textContent = CONTACT_EMAIL;
  mail.style.display = "inline-block";
  mail.style.marginTop = "10px";
  mail.style.fontWeight = "700";
  mail.style.color = "#111";
  mail.style.textDecoration = "underline";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "10px";
  actions.style.marginTop = "18px";

  const btnOk = document.createElement("button");
  btnOk.type = "button";
  btnOk.textContent = "Zavřít";
  btnOk.style.border = "1px solid rgba(0,0,0,0.12)";
  btnOk.style.background = "#fff";
  btnOk.style.borderRadius = "12px";
  btnOk.style.padding = "10px 14px";
  btnOk.style.cursor = "pointer";
  btnOk.onclick = () => overlay.remove();

  actions.appendChild(btnOk);

  box.appendChild(p);
  box.appendChild(mail);
  box.appendChild(actions);

  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

function getUpgradeKeyForRec(rec) {
  if (!rec?.mesh) return null;

  const choice = extrasChoiceByModuleUuid.get(rec.mesh.uuid) || "unset";

  // unset = jeĹˇtÄ› nevybral â†’ chovej se jako bez pĹ™Ă­platku
  if (choice === "unset" || choice === "none") return null;

  if (choice === "bed" || choice === "sleep") return "bed";
  if (choice === "bed2") return "bed2";
  if (choice === "storage") return "storage";

  return null;
}

function snapshotSceneModulesForCanonicalRebuild() {
  return (activeModules || []).map((rec, index) => ({
    oldIndex: index,
    variantId: String(
      rec?.name ??
      rec?.variantId ??
      rec?.mesh?.userData?.variantId ??
      ""
    ).trim(),
    model: rec?.model || null,
    upgrade: rec?.upgrade || null,
    upgradeChoice: rec?.mesh
      ? (extrasChoiceByModuleUuid.get(rec.mesh.uuid) || "unset")
      : "unset",
  }));
}

function analyzeCanonicalLayoutForStep3() {

  if (suppressPlanAnalysisDuringCanonicalRebuild) {
    return {
      ok: true,
      needsRebuild: false,
      reason: "suppressed_during_canonical_rebuild",
      branchCount: 0,
      nodes: [],
      topo: null,
      orientation: "front",
      widthAxisNodes: [],
      leftDepthNodes: [],
      rightDepthNodes: [],
      widthMin: 0,
      leftMin: 0,
      rightMin: 0,
    };
  }

  try {

    const nodes =
      (typeof window !== "undefined" && typeof window.__getConnectedPlanNodes === "function")
        ? window.__getConnectedPlanNodes()
        : [];

    const topo =
      (typeof window !== "undefined" && typeof window.__getPlanTopology === "function")
        ? window.__getPlanTopology()
        : null;

    const branchCount = Math.max(1, Number(topo?.branchCount) || 1);

    if (!nodes.length) {
      return {
        ok: true,
        needsRebuild: false,
        reason: "empty",
        branchCount: 0,
        nodes: [],
        topo: null,
      };
    }

    // 4+ vÄ›tve zatĂ­m ĂşplnÄ› ignorujeme
    if (branchCount >= 4) {
      return {
        ok: true,
        needsRebuild: false,
        reason: "skip_4plus",
        branchCount,
        nodes,
        topo,
      };
    }

    const orientation =
      (typeof window !== "undefined" && typeof window.__getPlanRenderOrientation === "function")
        ? window.__getPlanRenderOrientation(nodes)
        : "front";

    const widthAxisNodes =
      (typeof window !== "undefined" && typeof window.__getMainWidthAxisNodes === "function")
        ? window.__getMainWidthAxisNodes(nodes)
        : [];

    const widthAxisOrientation =
      (typeof window !== "undefined" && typeof window.__getPlanRenderOrientation === "function")
        ? window.__getPlanRenderOrientation(widthAxisNodes)
        : orientation;

    const sideAxes =
      (typeof window !== "undefined" && typeof window.__getSideDepthAxisNodes === "function")
        ? window.__getSideDepthAxisNodes(nodes, widthAxisNodes)
        : { left: [], right: [] };

    const leftDepthNodes = Array.isArray(sideAxes?.left) ? sideAxes.left : [];
    const rightDepthNodes = Array.isArray(sideAxes?.right) ? sideAxes.right : [];

    debugLog("ANALYZE SIDE AXES RAW", {
      left: sideAxes?.left?.map(n =>
        String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
      ),
      right: sideAxes?.right?.map(n =>
        String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
      ),
    });

    debugLog("ANALYZE SIDE AXES FINAL", {
      leftDepthNodes: leftDepthNodes.map(n =>
        String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
      ),
      rightDepthNodes: rightDepthNodes.map(n =>
        String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
      ),
    });

    const widthMin =
      (typeof window !== "undefined" && typeof window.__sumWidthAxis === "function")
        ? window.__sumWidthAxis(widthAxisNodes, [...leftDepthNodes, ...rightDepthNodes], "min")
        : 0;

    const leftMin =
      (typeof window !== "undefined" && typeof window.__sumDepthAxis === "function")
        ? window.__sumDepthAxis(leftDepthNodes, "min")
        : 0;

    const rightMin =
      (typeof window !== "undefined" && typeof window.__sumDepthAxis === "function")
        ? window.__sumDepthAxis(rightDepthNodes, "min")
        : 0;

    const variantOfNode = (node) => {
      return String(
        node?.rec?.name ??
        node?.rec?.variantId ??
        node?.rec?.mesh?.userData?.variantId ??
        ""
      ).trim();
    };

    const isCornerNode = (node) => /ROH/i.test(variantOfNode(node));

    const isDualAxisNode = (node) => {
      return !!node &&
        typeof window !== "undefined" &&
        typeof window.__isDualAxisModule === "function" &&
        window.__isDualAxisModule(node);
    };

    const isLeftDualAxisVariantId = (variantId) => {
      const v = String(variantId || "").trim();
      return /_1X?D_L$/i.test(v);
    };

    const isRightDualAxisVariantId = (variantId) => {
      const v = String(variantId || "").trim();
      return /_1X?D_P$/i.test(v);
    };

    const getWorldCardinalOrientationForNode = (node) => {
      try {
        const rawRoot = node?.root || node?.rec?.mesh || node?.mesh || null;
        const root =
          (typeof getModuleRoot === "function")
            ? getModuleRoot(rawRoot)
            : rawRoot;

        if (!root) return "front";

        root.updateWorldMatrix?.(true, true);

        const worldQ = new THREE.Quaternion();
        if (typeof root.getWorldQuaternion === "function") {
          root.getWorldQuaternion(worldQ);
        } else if (root.quaternion) {
          worldQ.copy(root.quaternion);
        }

        const frontDir = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQ);
        const eps = 0.0001;

        if (Math.abs(frontDir.z) >= Math.abs(frontDir.x) - eps) {
          return frontDir.z < 0 ? "front" : "back";
        }

        return frontDir.x > 0 ? "right" : "left";
      } catch (e) {
        return "front";
      }
    };

    const getMapped = (node) => {
      return (typeof window !== "undefined" && typeof window.__getMappedPlanCenter === "function")
        ? window.__getMappedPlanCenter(node, orientation)
        : { x: 0, z: 0 };
    };

    const getMappedX = (node) => Number(getMapped(node)?.x) || 0;
    const getMappedZ = (node) => Number(getMapped(node)?.z) || 0;

    const dedupeNodes = (arr) => {
      const out = [];
      const seen = new Set();

      for (const n of arr || []) {
        const key =
          n?.root?.uuid ||
          n?.rec?.mesh?.uuid ||
          n?.rec?.name ||
          null;

        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }

      return out;
    };

    const widthCornerCount = widthAxisNodes.filter(isCornerNode).length;
    const widthDualAxisCount = widthAxisNodes.filter(isDualAxisNode).length;

    const widthAxisKeys = new Set(
      widthAxisNodes.map((n) =>
        n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null
      ).filter(Boolean)
    );

    const nodesOutsideWidthAxis = nodes.filter((n) => {
      const key = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;
      return key && !widthAxisKeys.has(key);
    });

    const inferredUByDoubleCornerWidthAxis =
      widthCornerCount >= 2 && nodesOutsideWidthAxis.length >= 1;

    const inferredUByCornerAndDualAxisWidthAxis =
      widthCornerCount >= 1 &&
      widthDualAxisCount >= 1 &&
      nodesOutsideWidthAxis.length >= 1;

    const hasDualAxisOnAnyDepthBranch =
      leftDepthNodes.some(isDualAxisNode) ||
      rightDepthNodes.some(isDualAxisNode);

    const hasCornerOnWidthAxis =
      widthAxisNodes.some(isCornerNode);

    const hasDualAxisOnWidthAxis =
      widthAxisNodes.some(isDualAxisNode);

    const dualAxisNodes =
      dedupeNodes(nodes.filter(isDualAxisNode)).filter(Boolean);

    const dualAxisOnWidthAxisNodes =
      dedupeNodes(widthAxisNodes.filter(isDualAxisNode)).filter(Boolean);

    const inferredUByCornerAndDualAxisAcrossAxes =
      hasCornerOnWidthAxis &&
      hasDualAxisOnAnyDepthBranch &&
      nodesOutsideWidthAxis.length >= 1;

    const hasCornerAnywhere =
      nodes.some(isCornerNode);

    const hasDualAxisAnywhere =
      nodes.some(isDualAxisNode);

    const dualAxisOutsideWidthAxis =
      nodesOutsideWidthAxis.some(isDualAxisNode);

    const inferredUByCornerAndDualAxisAnywhere =
      hasCornerAnywhere &&
      hasDualAxisAnywhere &&
      dualAxisOutsideWidthAxis;

    debugLog("U CORNER+1D AXIS CHECK", {
      widthAxis: widthAxisNodes.map(variantOfNode),
      leftDepth: leftDepthNodes.map(variantOfNode),
      rightDepth: rightDepthNodes.map(variantOfNode),
      hasCornerOnWidthAxis,
      hasCornerAnywhere,
      hasDualAxisAnywhere,
      dualAxisOutsideWidthAxis,
      hasDualAxisOnAnyDepthBranch,
      inferredUByCornerAndDualAxisWidthAxis,
      inferredUByCornerAndDualAxisAcrossAxes,
      inferredUByCornerAndDualAxisAnywhere,
    });

    const widthEndpointNodes = dedupeNodes(
      widthAxisNodes.filter((n) => isCornerNode(n) || isDualAxisNode(n))
    ).filter(Boolean);

    let widthLeftEndpoint = null;
    let widthRightEndpoint = null;

    if (widthEndpointNodes.length >= 2) {
      const epA = widthEndpointNodes[0];
      const epB = widthEndpointNodes[1];

      const epDx = Math.abs(getMappedX(epA) - getMappedX(epB));
      const epDz = Math.abs(getMappedZ(epA) - getMappedZ(epB));

      widthEndpointNodes.sort((a, b) => {
        return epDx >= epDz
          ? getMappedX(a) - getMappedX(b)
          : getMappedZ(a) - getMappedZ(b);
      });

      widthLeftEndpoint = widthEndpointNodes[0];
      widthRightEndpoint = widthEndpointNodes[widthEndpointNodes.length - 1];
    }

    const widthLeftVariant = widthLeftEndpoint ? variantOfNode(widthLeftEndpoint) : "";
    const widthRightVariant = widthRightEndpoint ? variantOfNode(widthRightEndpoint) : "";

    const hasCornerPlusDualAxisEndpointOrderIssue =
      inferredUByCornerAndDualAxisWidthAxis &&
      (
        isLeftDualAxisVariantId(widthRightVariant) ||
        isRightDualAxisVariantId(widthLeftVariant)
      );

    debugLog("U WIDTH ENDPOINT ORDER CHECK", {
      widthAxis: widthAxisNodes.map((n) =>
        String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
      ),
      widthEndpointNodes: widthEndpointNodes.map((n) => variantOfNode(n)),
      widthLeftVariant,
      widthRightVariant,
      inferredUByCornerAndDualAxisWidthAxis,
      hasCornerPlusDualAxisEndpointOrderIssue,
    });

    const effectiveBranchCount =
      (
        inferredUByDoubleCornerWidthAxis ||
        inferredUByCornerAndDualAxisWidthAxis ||
        inferredUByCornerAndDualAxisAcrossAxes ||
        inferredUByCornerAndDualAxisAnywhere
      )
        ? 3
        : branchCount;

    const dualAxisWorldCheckCandidates =
      (dualAxisOnWidthAxisNodes.length ? dualAxisOnWidthAxisNodes : dualAxisNodes)
        .slice()
        .sort((a, b) => {
          const av = variantOfNode(a);
          const bv = variantOfNode(b);
          const aRank = isLeftDualAxisVariantId(av) ? 0 : (isRightDualAxisVariantId(av) ? 1 : 2);
          const bRank = isLeftDualAxisVariantId(bv) ? 0 : (isRightDualAxisVariantId(bv) ? 1 : 2);
          if (aRank !== bRank) return aRank - bRank;
          return getMappedX(a) - getMappedX(b);
        });

    const pickedDualAxisWorldCheckNode =
      dualAxisWorldCheckCandidates[0] || null;

    const pickedDualAxisWorldOrientation =
      pickedDualAxisWorldCheckNode
        ? getWorldCardinalOrientationForNode(pickedDualAxisWorldCheckNode)
        : null;

    const shouldCheckDualAxisWorldOrientation =
      effectiveBranchCount === 3 &&
      dualAxisNodes.length > 0 &&
      (
        inferredUByCornerAndDualAxisWidthAxis ||
        inferredUByCornerAndDualAxisAcrossAxes ||
        inferredUByCornerAndDualAxisAnywhere ||
        dualAxisNodes.length >= 2
      );

    const hasDualAxisWorldOrientationIssue =
      shouldCheckDualAxisWorldOrientation &&
      !!pickedDualAxisWorldCheckNode &&
      pickedDualAxisWorldOrientation !== "front";

    const dualAxisWorldCheck = {
      required: shouldCheckDualAxisWorldOrientation,
      hasIssue: hasDualAxisWorldOrientationIssue,
      pickedVariant: pickedDualAxisWorldCheckNode
        ? variantOfNode(pickedDualAxisWorldCheckNode)
        : null,
      pickedOrientation: pickedDualAxisWorldOrientation,
      candidates: dualAxisWorldCheckCandidates.map((n) => ({
        variantId: variantOfNode(n),
        orientation: getWorldCardinalOrientationForNode(n),
        onWidthAxis: dualAxisOnWidthAxisNodes.includes(n),
      })),
    };

    // 1 vÄ›tev = rovnĂˇ sestava
    // rebuild chceme tehdy, kdyĹľ nenĂ­ kanonicky ve "front" orientaci
    if (effectiveBranchCount === 1) {
      const needsRebuild = orientation !== "front";

      return {
        ok: true,
        needsRebuild,
        reason: needsRebuild ? "single_branch_not_front" : "single_branch_ok",
        branchCount: effectiveBranchCount,
        nodes,
        topo,
        orientation,
        widthAxisNodes,
        leftDepthNodes,
        rightDepthNodes,
        widthMin,
        leftMin,
        rightMin,
      };
    }

    // 2 vÄ›tve = L
    // MVP pravidlo:
    // pokud je nÄ›kterĂˇ depth vÄ›tev delĹˇĂ­ neĹľ hlavnĂ­ width osa,
    // chceme rebuildnout, protoĹľe delĹˇĂ­ strana mĂˇ bĂ˝t hlavnĂ­
    if (effectiveBranchCount === 2) {
      const hasLeftDepth = leftDepthNodes.length > 0;

      const nodeKeyOf = (n) =>
        n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;

      const leftDepthOutsideWidth = leftDepthNodes.filter((n) => {
        const key = nodeKeyOf(n);
        return key && !widthAxisKeys.has(key);
      });

      const rightDepthOutsideWidth = rightDepthNodes.filter((n) => {
        const key = nodeKeyOf(n);
        return key && !widthAxisKeys.has(key);
      });

      const hasRightDepth = rightDepthNodes.length > 0;
      const hasRealRightDepth = rightDepthOutsideWidth.length > 0;

      const isRealCornerNode = (n) => isCornerNode(n);

      const widthStraightForLength = widthAxisNodes.filter((n) => !isRealCornerNode(n));
      const leftStraightForLength = leftDepthOutsideWidth.filter((n) => !isRealCornerNode(n));
      const rightStraightForLength = rightDepthOutsideWidth.filter((n) => !isRealCornerNode(n));

      const widthPhysicalLen =
        (typeof window !== "undefined" && typeof window.__sumWidthAxis === "function")
          ? window.__sumWidthAxis(widthStraightForLength, [], "min")
          : 0;

      const leftPhysicalLen =
        (typeof window !== "undefined" && typeof window.__sumDepthAxis === "function")
          ? window.__sumDepthAxis(leftStraightForLength, "min")
          : 0;

      const rightPhysicalLen =
        (typeof window !== "undefined" && typeof window.__sumDepthAxis === "function")
          ? window.__sumDepthAxis(rightStraightForLength, "min")
          : 0;

      const longestPhysicalDepth = Math.max(leftPhysicalLen, rightPhysicalLen);

      // malá tolerance, aby rebuild neskákal kvůli zaokrouhlení / pár mm
      const physicalDepthLongerThanWidth = longestPhysicalDepth > widthPhysicalLen + 1;

      debugLog("L PHYSICAL LENGTH CHECK", {
        widthAxis: widthAxisNodes.map(variantOfNode),
        leftDepth: leftDepthNodes.map(variantOfNode),
        rightDepth: rightDepthNodes.map(variantOfNode),

        widthStraightForLength: widthStraightForLength.map(variantOfNode),
        leftStraightForLength: leftStraightForLength.map(variantOfNode),
        rightStraightForLength: rightStraightForLength.map(variantOfNode),

        oldWidthMin: widthMin,
        oldLeftMin: leftMin,
        oldRightMin: rightMin,

        widthPhysicalLen,
        leftPhysicalLen,
        rightPhysicalLen,
        longestPhysicalDepth,
        physicalDepthLongerThanWidth,

        hasRightDepth,
        hasRealRightDepth,
      });

      // L pravidla:
      // 1) rebuild když je FYZICKY delší depth větev než width větev
      // 2) nebo když sestava není ve "front" orientaci
      // 3) nebo když existuje skutečná pravá depth větev mimo width axis
      const needsRebuild =
        physicalDepthLongerThanWidth ||
        orientation !== "front" ||
        hasRealRightDepth;

      let reason = "l_shape_ok";
      if (physicalDepthLongerThanWidth) reason = "l_shape_longer_physical_depth_than_width";
      else if (orientation !== "front") reason = "l_shape_not_front";
      else if (hasRealRightDepth) reason = "l_shape_depth_on_right";

      return {
        ok: true,
        needsRebuild,
        reason,
        branchCount: effectiveBranchCount,
        nodes,
        topo,
        orientation,
        widthAxisNodes,
        leftDepthNodes,
        rightDepthNodes,
        widthMin,
        leftMin,
        rightMin,
      };
    }

    // 3 vÄ›tve = U
    // rebuild chceme tehdy, kdyĹľ U nenĂ­ v kanonickĂ© "front" orientaci
    if (effectiveBranchCount === 3) {

      debugLog("U ANALYSIS RAW", {
        orientation,
        branchCount: effectiveBranchCount,
        dualAxisWorldCheck,
        widthAxisNodes: widthAxisNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        leftDepthNodes: leftDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        rightDepthNodes: rightDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        widthMin,
        leftMin,
        rightMin
      });

      const hasLeftDepth = leftDepthNodes.length > 0;
      const hasRightDepth = rightDepthNodes.length > 0;

      const hasCornerPlusDualAxisTopology =
        inferredUByCornerAndDualAxisWidthAxis ||
        inferredUByCornerAndDualAxisAcrossAxes ||
        inferredUByCornerAndDualAxisAnywhere;

      // pro klasickĂ© U se 2 endpoint rohy chceme opravdu obÄ› side vÄ›tve,
      // ale pro "1 roh + 1D" tohle nesmĂ­ bĂ˝t povinnĂ© stejnÄ› pĹ™Ă­snÄ›,
      // protoĹľe jedna strana mĹŻĹľe bĂ˝t reprezentovanĂˇ endpointem / middle path heuristikou
      const shouldRequireBothDepthSides = !hasCornerPlusDualAxisTopology;
      const missingClassicUSideBranch =
        shouldRequireBothDepthSides &&
        (!hasLeftDepth || !hasRightDepth);

      debugLog("U REBUILD DECISION DEBUG", {
        orientation,
        widthAxisOrientation,
        hasLeftDepth,
        hasRightDepth,
        hasCornerPlusDualAxisTopology,
        hasDualAxisOnWidthAxis,
        shouldRequireBothDepthSides,
        missingClassicUSideBranch,
        widthMin,
        leftMin,
        rightMin,
        widthAxis: widthAxisNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        leftAxis: leftDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        rightAxis: rightDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
      });

      // POZNĂMKA:
      // Pro klasickĂ© U nechĂˇvĂˇme pĹŻvodnĂ­ rozhodovĂˇnĂ­.
      // Ale pro "1 roh + 1D" CHCEME canonical rebuild vynutit,
      // protoĹľe tahle topologie se mĂˇ pĹ™estavÄ›t do vlastnĂ­ho U descriptoru
      // a nesmĂ­ zĹŻstat jen "detected but canonical".
      const isMinimalCornerPlus1DUAlreadyStable =
        hasCornerPlusDualAxisTopology &&
        Number(topo?.activeCornerCount || 0) === 1 &&
        Number(topo?.depthModuleCount || 0) === 1 &&
        Array.isArray(nodes) &&
        nodes.length === 4 &&
        orientation === "front" &&
        widthAxisOrientation === "front" &&
        !hasDualAxisWorldOrientationIssue &&
        !missingClassicUSideBranch &&
        !hasCornerPlusDualAxisEndpointOrderIssue;

      const forceRebuildForCornerPlus1D =
        hasCornerPlusDualAxisTopology &&
        !hasDualAxisOnWidthAxis &&
        !isMinimalCornerPlus1DUAlreadyStable;

      const isCornerPlus1DAlreadyOnWidthAxis =
        hasCornerPlusDualAxisTopology &&
        hasDualAxisOnWidthAxis &&
        !inferredUByCornerAndDualAxisAcrossAxes;

      const needsRebuild =
        orientation !== "front" ||
        widthAxisOrientation !== "front" ||
        missingClassicUSideBranch ||
        hasCornerPlusDualAxisEndpointOrderIssue ||
        hasDualAxisWorldOrientationIssue ||
        forceRebuildForCornerPlus1D;

      let reason = "u_shape_ok";
      if (orientation !== "front") reason = "u_shape_not_front";
      else if (widthAxisOrientation !== "front") reason = "u_shape_width_axis_not_front";
      else if (missingClassicUSideBranch) reason = "u_shape_missing_side_branch";
      else if (hasCornerPlusDualAxisEndpointOrderIssue) reason = "u_shape_corner_plus_1d_endpoint_order";
      else if (hasDualAxisWorldOrientationIssue) reason = "u_shape_1d_not_world_front";
      else if (forceRebuildForCornerPlus1D) reason = "u_shape_corner_plus_1d_force_rebuild";

      debugLog("U CORNER+1D REBUILD FLAGS", {
        orientation,
        widthAxisOrientation,
        branchCount: effectiveBranchCount,
        hasCornerPlusDualAxisTopology,
        inferredUByCornerAndDualAxisWidthAxis,
        inferredUByCornerAndDualAxisAcrossAxes,
        inferredUByCornerAndDualAxisAnywhere,
        hasDualAxisOnWidthAxis,
        hasDualAxisOnAnyDepthBranch,
        hasCornerOnWidthAxis,
        dualAxisWorldCheck,
        missingClassicUSideBranch,
        hasCornerPlusDualAxisEndpointOrderIssue,
        forceRebuildForCornerPlus1D,
        isCornerPlus1DAlreadyOnWidthAxis,
        isMinimalCornerPlus1DUAlreadyStable,
        needsRebuild,
        reason,
        widthAxis: widthAxisNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        leftAxis: leftDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
        rightAxis: rightDepthNodes.map((n) =>
          String(n?.rec?.name ?? n?.rec?.variantId ?? n?.rec?.mesh?.userData?.variantId ?? "").trim()
        ),
      });

      return {
        ok: true,
        needsRebuild,
        reason,
        branchCount: effectiveBranchCount,
        nodes,
        topo,
        orientation,
        widthAxisNodes,
        leftDepthNodes,
        rightDepthNodes,
        widthMin,
        leftMin,
        rightMin,
        dualAxisWorldCheck,
      };
    }

    return {
      ok: true,
      needsRebuild: false,
      reason: "fallback_no_rebuild",
      branchCount: effectiveBranchCount,
      nodes,
      topo,
      orientation,
      widthAxisNodes,
      leftDepthNodes,
      rightDepthNodes,
      widthMin,
      leftMin,
      rightMin,
    };
  } catch (e) {
    console.warn("analyzeCanonicalLayoutForStep3 failed:", e);
    return {
      ok: false,
      needsRebuild: false,
      reason: "error",
      branchCount: 0,
      nodes: [],
      topo: null,
    };
  }
}

function scheduleCanonicalRebuildAnalysis() {
  try {
    pendingCanonicalAnalysis = analyzeCanonicalLayoutForStep3();
    needsCanonicalRebuild = !!pendingCanonicalAnalysis?.needsRebuild;
  } catch (e) {
    console.warn("scheduleCanonicalRebuildAnalysis failed:", e);
    pendingCanonicalAnalysis = null;
    needsCanonicalRebuild = false;
  }
}

function installCanonicalRebuildDebugTools() {
  if (typeof window === "undefined") return;

  window.__debugCanonicalRebuild = () => {
    const variantOfNode = (node) => String(
      node?.rec?.name ??
      node?.rec?.variantId ??
      node?.rec?.mesh?.userData?.variantId ??
      ""
    ).trim();

    const nodeKey = (node) => String(
      node?.root?.uuid ||
      node?.rec?.mesh?.uuid ||
      node?.rec?.name ||
      ""
    ).trim();

    const nodes =
      typeof window.__getConnectedPlanNodes === "function"
        ? window.__getConnectedPlanNodes()
        : [];

    const analysis = analyzeCanonicalLayoutForStep3();
    const snapshot = snapshotSceneModulesForCanonicalRebuild();
    const descriptor = buildCanonicalDescriptorFromAnalysis(analysis, snapshot);

    const moduleRows = (activeModules || []).map((rec, index) => ({
      index,
      variantId: String(rec?.name || rec?.variantId || rec?.mesh?.userData?.variantId || "").trim(),
      uuid: rec?.mesh?.uuid || "",
      left: activeModules.find((m) => m?.mesh === rec?.connections?.left)?.name || "",
      right: activeModules.find((m) => m?.mesh === rec?.connections?.right)?.name || "",
      front: activeModules.find((m) => m?.mesh === rec?.connections?.front)?.name || "",
      back: activeModules.find((m) => m?.mesh === rec?.connections?.back)?.name || "",
    }));

    const nodeRows = (nodes || []).map((node, index) => ({
      index,
      variantId: variantOfNode(node),
      key: nodeKey(node),
      cx: Math.round((Number(node?.cx) || 0) * 10) / 10,
      cz: Math.round((Number(node?.cz) || 0) * 10) / 10,
      sx: Math.round((Number(node?.sx) || 0) * 10) / 10,
      sz: Math.round((Number(node?.sz) || 0) * 10) / 10,
      left: variantOfNode(node?.neighbors?.left),
      right: variantOfNode(node?.neighbors?.right),
      front: variantOfNode(node?.neighbors?.front),
      back: variantOfNode(node?.neighbors?.back),
    }));

    const analysisSummary = {
      ok: analysis?.ok,
      needsRebuild: analysis?.needsRebuild,
      reason: analysis?.reason,
      branchCount: analysis?.branchCount,
      orientation: analysis?.orientation,
      topo: analysis?.topo,
      widthAxis: (analysis?.widthAxisNodes || []).map(variantOfNode),
      leftDepth: (analysis?.leftDepthNodes || []).map(variantOfNode),
      rightDepth: (analysis?.rightDepthNodes || []).map(variantOfNode),
      widthMin: analysis?.widthMin,
      leftMin: analysis?.leftMin,
      rightMin: analysis?.rightMin,
      dualAxisWorldCheck: analysis?.dualAxisWorldCheck,
    };

    const descriptorRows = (descriptor || []).map((step, index) => ({
      index,
      variantId: step?.variantId || "",
      attachTo: step?.attachTo,
      side: step?.side,
      sourceVariant: step?.sourceSnapshot?.variantId || "",
    }));

    console.group("CANONICAL DEBUG SNAPSHOT");
    debugLog("appState", {
      step: appState?.step,
      model: appState?.model,
      needsCanonicalRebuild,
      pendingReason: pendingCanonicalAnalysis?.reason || null,
    });
    console.table(moduleRows);
    console.table(nodeRows);
    debugLog("analysis", analysisSummary);
    console.table(descriptorRows);
    console.groupEnd();

    return {
      appState: {
        step: appState?.step,
        model: appState?.model,
        needsCanonicalRebuild,
        pendingReason: pendingCanonicalAnalysis?.reason || null,
      },
      modules: moduleRows,
      nodes: nodeRows,
      analysis: analysisSummary,
      descriptor: descriptorRows,
    };
  };
}

installCanonicalRebuildDebugTools();

function buildCanonicalDescriptorFromAnalysis(analysis, snapshot) {
  if (!analysis?.nodes?.length || !Array.isArray(snapshot) || !snapshot.length) {
    return [];
  }

  // zatĂ­m Ĺ™eĹˇĂ­me rovnou sestavu, L a U
  if (![1, 2, 3].includes(Number(analysis.branchCount))) {
    return [];
  }

  if (Number(analysis.branchCount) === 1) {
    const orientation = analysis.orientation || "front";

    const widthAxisNodes = Array.isArray(analysis.widthAxisNodes)
      ? analysis.widthAxisNodes.slice()
      : [];

    const getMapped = (node) => {
      return (typeof window !== "undefined" && typeof window.__getMappedPlanCenter === "function")
        ? window.__getMappedPlanCenter(node, orientation)
        : { x: 0, z: 0 };
    };

    const getMappedX = (node) => Number(getMapped(node)?.x) || 0;

    const variantOfNode = (node) => {
      return String(
        node?.rec?.name ??
        node?.rec?.variantId ??
        node?.rec?.mesh?.userData?.variantId ??
        ""
      ).trim();
    };

    const dedupeNodes = (arr) => {
      const out = [];
      const seen = new Set();

      for (const n of arr || []) {
        const key = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || Math.random();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }

      return out;
    };

    const takeSnapshotForVariant = (() => {
      const used = new Set();

      return (variantId) => {
        const candidates = snapshot.filter((s, idx) => {
          if (used.has(idx)) return false;
          return String(s?.variantId || "").trim() === String(variantId || "").trim();
        });

        if (!candidates.length) return null;

        const picked = candidates[0];
        const realIndex = snapshot.findIndex((s, idx) => {
          return !used.has(idx) && s === picked;
        });

        if (realIndex >= 0) used.add(realIndex);
        return picked || null;
      };
    })();

    const getAvailableAttachSidesForVariant = (baseVariantId) => {
      const baseId = String(baseVariantId || "").trim();
      if (!baseId) return [];

      try {
        const key = normalizeOffsetKey(baseId);
        const defs = getModuleAddButtonOffsets()?.[key] || [];

        return defs
          .map((d) => String(d?.direction || "").trim())
          .filter(Boolean);
      } catch (e) {
        return [];
      }
    };

    const pickAttachSideByRules = (baseVariantId, newVariantId, preferredSides = []) => {
      const baseId = String(baseVariantId || "").trim();
      const newId = String(newVariantId || "").trim();

      if (!baseId || !newId) return null;

      const fallbackOrder = ["right", "left", "front", "back"];
      const orderedSides = [
        ...preferredSides,
        ...fallbackOrder.filter((s) => !preferredSides.includes(s))
      ];

      const availableSides = getAvailableAttachSidesForVariant(baseId);

      // 1) preferuj side, kterĂ˝ mĂˇ reĂˇlnĂ˝ add-button offset
      //    a zĂˇroveĹ projde connection rules
      for (const side of orderedSides) {
        try {
          const hasRealOffset =
            !availableSides.length || availableSides.includes(side);

          if (hasRealOffset && canAttach({ baseId, baseSide: side, newId })) {
            return side;
          }
        } catch (e) {}
      }

      // 2) fallback: kdyby offsety pro nÄ›jakĂ˝ modul chybÄ›ly
      for (const side of orderedSides) {
        try {
          if (canAttach({ baseId, baseSide: side, newId })) {
            return side;
          }
        } catch (e) {}
      }

      return null;
    };

    const straightNodes = dedupeNodes(widthAxisNodes).filter(Boolean);

    if (!straightNodes.length) {
      console.warn("Canonical builder: no straight nodes for single branch");
      return [];
    }

    straightNodes.sort((a, b) => getMappedX(a) - getMappedX(b));

    debugLog("CANONICAL SINGLE BRANCH", {
      orientation,
      nodes: straightNodes.map(variantOfNode)
    });

    const descriptor = [];

    for (let i = 0; i < straightNodes.length; i++) {
      const node = straightNodes[i];
      const variantId = variantOfNode(node);
      if (!variantId) continue;

      if (i === 0) {
        descriptor.push({
          variantId,
          attachTo: null,
          side: null,
          sourceSnapshot: takeSnapshotForVariant(variantId),
        });
        continue;
      }

      const prevVariantId = descriptor[descriptor.length - 1]?.variantId || "";
      const side = pickAttachSideByRules(prevVariantId, variantId, ["right", "left"]);

      if (!side) {
        console.warn("Canonical builder: no valid side for single-branch step", {
          prevVariantId,
          variantId,
          i
        });
        return [];
      }

      descriptor.push({
        variantId,
        attachTo: descriptor.length - 1,
        side,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });
    }

    return descriptor;
  }

  if (Number(analysis.branchCount) === 3) {
    const orientation = analysis.orientation || "front";
    const allNodes = Array.isArray(analysis.nodes) ? analysis.nodes.slice() : [];

    const variantOfNode = (node) => {
      return String(
        node?.rec?.name ??
        node?.rec?.variantId ??
        node?.rec?.mesh?.userData?.variantId ??
        ""
      ).trim();
    };

    const nodeKeyOf = (node) => {
      return String(
        node?.root?.uuid ||
        node?.rec?.mesh?.uuid ||
        node?.rec?.name ||
        ""
      ).trim();
    };

    const dedupeNodes = (arr) => {
      const out = [];
      const seen = new Set();

      for (const n of arr || []) {
        const key = nodeKeyOf(n);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }

      return out;
    };

    const isCorner = (node) => /ROH/i.test(variantOfNode(node));

    const isDualAxisEndpoint = (node) => {
      return !!node &&
        typeof window !== "undefined" &&
        typeof window.__isDualAxisModule === "function" &&
        window.__isDualAxisModule(node);
    };

    const isUEndpoint = (node) => {
      return isCorner(node) || isDualAxisEndpoint(node);
    };

    const isLeftDualAxisEndpoint = (node) => {
      const v = String(variantOfNode(node) || "").trim();
      return /_1X?D_L$/i.test(v);
    };

    const isRightDualAxisEndpoint = (node) => {
      const v = String(variantOfNode(node) || "").trim();
      return /_1X?D_P$/i.test(v);
    };

    const getMapped = (node) => {
      return (typeof window !== "undefined" && typeof window.__getMappedPlanCenter === "function")
        ? window.__getMappedPlanCenter(node, orientation)
        : { x: 0, z: 0 };
    };

    const getMappedX = (node) => Number(getMapped(node)?.x) || 0;
    const getMappedZ = (node) => Number(getMapped(node)?.z) || 0;

    const getNeighbors = (node) => {
      return [
        node?.neighbors?.left,
        node?.neighbors?.right,
        node?.neighbors?.front,
        node?.neighbors?.back,
      ].filter(Boolean);
    };

    const buildNodeMap = (nodes) => {
      const map = new Map();
      for (const n of nodes) {
        const key = nodeKeyOf(n);
        if (key) map.set(key, n);
      }
      return map;
    };

    const bfsPath = (startNode, endNode, allowedNodes) => {
      const allowed = buildNodeMap(allowedNodes);
      const startKey = nodeKeyOf(startNode);
      const endKey = nodeKeyOf(endNode);

      if (!startKey || !endKey || !allowed.has(startKey) || !allowed.has(endKey)) {
        return [];
      }

      const queue = [startNode];
      const prev = new Map();
      const visited = new Set([startKey]);

      while (queue.length) {
        const current = queue.shift();
        const currentKey = nodeKeyOf(current);
        if (!currentKey) continue;

        if (currentKey === endKey) break;

        for (const next of getNeighbors(current)) {
          const nextKey = nodeKeyOf(next);
          if (!nextKey) continue;
          if (!allowed.has(nextKey)) continue;
          if (visited.has(nextKey)) continue;

          visited.add(nextKey);
          prev.set(nextKey, currentKey);
          queue.push(next);
        }
      }

      if (!visited.has(endKey)) return [];

      const pathKeys = [];
      let cur = endKey;

      while (cur) {
        pathKeys.push(cur);
        if (cur === startKey) break;
        cur = prev.get(cur) || null;
      }

      pathKeys.reverse();

      return pathKeys
        .map((k) => allowed.get(k))
        .filter(Boolean);
    };

    const collectBranchFromCorner = (cornerNode, middlePathNodes) => {
      const middleKeys = new Set((middlePathNodes || []).map(nodeKeyOf).filter(Boolean));
      const startNeighbors = getNeighbors(cornerNode).filter((n) => {
        const k = nodeKeyOf(n);
        return k && !middleKeys.has(k);
      });

      if (!startNeighbors.length) return [];

      const out = [];
      const visited = new Set();

      // DĹ®LEĹ˝ITĂ‰:
      // nezaÄŤĂ­nej jen prvnĂ­m sousedem, ale vĹˇemi validnĂ­mi smÄ›ry mimo middle path.
      // TĂ­m odstranĂ­me nĂˇhodnost podle poĹ™adĂ­ neighbors.
      const queue = [...startNeighbors];

      while (queue.length) {
        const current = queue.shift();
        const currentKey = nodeKeyOf(current);
        if (!currentKey || visited.has(currentKey)) continue;
        if (middleKeys.has(currentKey)) continue;

        visited.add(currentKey);
        out.push(current);

        for (const next of getNeighbors(current)) {
          const nextKey = nodeKeyOf(next);
          if (!nextKey || visited.has(nextKey)) continue;
          if (middleKeys.has(nextKey)) continue;
          queue.push(next);
        }
      }

      return out;
    };

    const isAdjacentEither = (a, b) => {
      const aKey = nodeKeyOf(a);
      const bKey = nodeKeyOf(b);
      if (!aKey || !bKey) return false;

      return (
        getNeighbors(a).some((n) => nodeKeyOf(n) === bKey) ||
        getNeighbors(b).some((n) => nodeKeyOf(n) === aKey)
      );
    };

    const collectConnectedFromSeeds = (seedNodes, allowedNodes) => {
      const allowed = buildNodeMap(allowedNodes || []);
      const queue = dedupeNodes(seedNodes || []).filter(Boolean);
      const out = [];
      const visited = new Set();

      while (queue.length) {
        const current = queue.shift();
        const currentKey = nodeKeyOf(current);
        if (!currentKey || visited.has(currentKey)) continue;
        if (!allowed.has(currentKey)) continue;
        if (isCorner(current)) continue;

        visited.add(currentKey);
        out.push(current);

        for (const next of dedupeNodes(allowedNodes || [])) {
          const nextKey = nodeKeyOf(next);
          if (!nextKey || visited.has(nextKey)) continue;
          if (!allowed.has(nextKey)) continue;
          if (isCorner(next)) continue;

          if (isAdjacentEither(current, next)) {
            queue.push(next);
          }
        }
      }

      return out;
    };

    const orderLinearBranchFromCorner = (cornerNode, branchNodes) => {
      const pool = dedupeNodes(branchNodes || []).filter(Boolean);
      if (pool.length <= 1) return pool;

      const poolMap = buildNodeMap(pool);
      const ordered = [];
      const used = new Set();

      let current = pool.find((n) =>
        getNeighbors(cornerNode).some((m) => nodeKeyOf(m) === nodeKeyOf(n))
      ) || pool[0];

      while (current) {
        const key = nodeKeyOf(current);
        if (!key || used.has(key)) break;

        ordered.push(current);
        used.add(key);

        const next = getNeighbors(current).find((n) => {
          const nk = nodeKeyOf(n);
          return nk && poolMap.has(nk) && !used.has(nk);
        }) || null;

        current = next;
      }

      for (const n of pool) {
        const key = nodeKeyOf(n);
        if (!key || used.has(key)) continue;
        ordered.push(n);
      }

      return ordered;
    };

    const forceCornerSide = (variantId, side) => {
      const v = String(variantId || "").trim();
      if (!v) return v;

      if (side === "L") {
        if (/_roh_p$/i.test(v)) return v.replace(/_roh_p$/i, "_roh_L");
        if (/_roh_l$/i.test(v)) return v.replace(/_roh_l$/i, "_roh_L");
        if (/ROH_P$/i.test(v)) return v.replace(/ROH_P$/i, "roh_L");
        if (/ROH_L$/i.test(v)) return v.replace(/ROH_L$/i, "roh_L");
      }

      if (side === "P") {
        if (/_roh_p$/i.test(v)) return v.replace(/_roh_p$/i, "_roh_P");
        if (/_roh_l$/i.test(v)) return v.replace(/_roh_l$/i, "_roh_P");
        if (/ROH_P$/i.test(v)) return v.replace(/ROH_P$/i, "roh_P");
        if (/ROH_L$/i.test(v)) return v.replace(/ROH_L$/i, "roh_P");
      }

      return v;
    };

    const takeSnapshotForVariant = (() => {
      const used = new Set();

      return (variantId) => {
        const candidates = snapshot.filter((s, idx) => {
          if (used.has(idx)) return false;
          return String(s?.variantId || "").trim() === String(variantId || "").trim();
        });

        if (!candidates.length) return null;

        const picked = candidates[0];
        const realIndex = snapshot.findIndex((s, idx) => !used.has(idx) && s === picked);

        if (realIndex >= 0) used.add(realIndex);
        return picked || null;
      };
    })();

    const getAvailableAttachSidesForVariant = (baseVariantId) => {
      const baseId = String(baseVariantId || "").trim();
      if (!baseId) return [];

      try {
        const key = normalizeOffsetKey(baseId);
        const defs = getModuleAddButtonOffsets()?.[key] || [];

        return defs
          .map((d) => String(d?.direction || "").trim())
          .filter(Boolean);
      } catch (e) {
        return [];
      }
    };

    // U builder musĂ­ mĂ­t vlastnĂ­ attach pravidlo.
    // U 2 branches dĂˇvĂˇ smysl vĂ­c tlaÄŤit offsety,
    // ale u 3 branches chceme nejdĹ™Ă­v zachovat validnĂ­ topologii pĹ™es canAttach.
    // Offsety ber aĹľ jako secondary preference.
    const pickAttachSideByRules = (baseVariantId, newVariantId, preferredSides = []) => {
      const baseId = String(baseVariantId || "").trim();
      const newId = String(newVariantId || "").trim();

      if (!baseId || !newId) return null;

      const fallbackOrder = ["right", "left", "front", "back"];
      const orderedSides = [
        ...preferredSides,
        ...fallbackOrder.filter((s) => !preferredSides.includes(s))
      ];

      const availableSides = getAvailableAttachSidesForVariant(baseId);

      // 1) U-specific: nejdĹ™Ă­v ÄŤistÄ› connection rules podle preferovanĂ©ho poĹ™adĂ­
      for (const side of orderedSides) {
        try {
          if (canAttach({ baseId, baseSide: side, newId })) {
            return side;
          }
        } catch (e) {}
      }

      // 2) aĹľ potom jemnĂˇ preference na skuteÄŤnĂ© offsety
      for (const side of orderedSides) {
        try {
          const hasRealOffset =
            !availableSides.length || availableSides.includes(side);

          if (hasRealOffset && canAttach({ baseId, baseSide: side, newId })) {
            return side;
          }
        } catch (e) {}
      }

      return null;
    };

    const isEndCapLikeVariant = (variantId) => {
      const v = String(variantId || "").trim();
      return /_1[LP]$/i.test(v);
    };

    const nodes = dedupeNodes(allNodes).filter(Boolean);
    const cornerNodes = dedupeNodes(nodes.filter(isCorner)).filter(Boolean);
    const uEndpointNodes = dedupeNodes(nodes.filter(isUEndpoint)).filter(Boolean);

    // podporujeme:
    // 1) pĹŻvodnĂ­ stav: 2 rohy
    // 2) novĂ˝ stav: 1 roh + 1 dual-axis (1D)
    // 3) novĂ˝ stav: 2 dual-axis endpointy (1D_L + 1D_P)
    if (!(
      cornerNodes.length >= 2 ||
      (cornerNodes.length >= 1 && uEndpointNodes.length >= 2) ||
      (cornerNodes.length === 0 && uEndpointNodes.length >= 2)
    )) {
      console.warn("Canonical U builder: expected 2 U endpoints (2 corners, or 1 corner + 1 dualAxis, or 2 dualAxis), got", {
        cornerCount: cornerNodes.length,
        uEndpointCount: uEndpointNodes.length,
        endpoints: uEndpointNodes.map(variantOfNode),
      });
      return [];
    }

    const endpointA = uEndpointNodes[0];
    const endpointB = uEndpointNodes[1];

    const endpointDx = Math.abs(getMappedX(endpointA) - getMappedX(endpointB));
    const endpointDz = Math.abs(getMappedZ(endpointA) - getMappedZ(endpointB));

    // vĂ˝chozĂ­ geometrickĂ© Ĺ™azenĂ­
    uEndpointNodes.sort((a, b) => {
      return endpointDx >= endpointDz
        ? getMappedX(a) - getMappedX(b)
        : getMappedZ(a) - getMappedZ(b);
    });

    let leftCornerNode = uEndpointNodes[0];
    let rightCornerNode = uEndpointNodes[uEndpointNodes.length - 1];

    // =====================================================
    // FIX: pro endpointy s 1D urÄŤuj levĂ˝/pravĂ˝ endpoint podle suffixu,
    // ne ÄŤistÄ› podle geometrie
    // =====================================================
    if (uEndpointNodes.length >= 2) {
      const leftDualAxisNode = uEndpointNodes.find((n) => isLeftDualAxisEndpoint(n)) || null;
      const rightDualAxisNode = uEndpointNodes.find((n) => isRightDualAxisEndpoint(n)) || null;
      const realCornerNode = uEndpointNodes.find((n) => isCorner(n)) || null;

      // case 1 roh + 1D
      if (leftDualAxisNode && realCornerNode) {
        leftCornerNode = leftDualAxisNode;
        rightCornerNode = realCornerNode;
      } else if (rightDualAxisNode && realCornerNode) {
        leftCornerNode = realCornerNode;
        rightCornerNode = rightDualAxisNode;
      }

      // case 2x 1D
      else if (leftDualAxisNode && rightDualAxisNode) {
        leftCornerNode = leftDualAxisNode;
        rightCornerNode = rightDualAxisNode;
      }
    }

    debugLog("U ENDPOINT ORDER", {
      endpointsRaw: uEndpointNodes.map(variantOfNode),
      leftEndpoint: variantOfNode(leftCornerNode),
      rightEndpoint: variantOfNode(rightCornerNode),
    });

    const leftCornerRawVariant = variantOfNode(leftCornerNode);
    const rightCornerRawVariant = variantOfNode(rightCornerNode);

    const leftIsRealCorner = isCorner(leftCornerNode);
    const rightIsRealCorner = isCorner(rightCornerNode);

    const isLeftCornerL = leftIsRealCorner && /_roh_l$/i.test(leftCornerRawVariant);
    const isLeftCornerP = leftIsRealCorner && /_roh_p$/i.test(leftCornerRawVariant);
    const isRightCornerL = rightIsRealCorner && /_roh_l$/i.test(rightCornerRawVariant);
    const isRightCornerP = rightIsRealCorner && /_roh_p$/i.test(rightCornerRawVariant);

    const hasSameCornerTypes =
      leftIsRealCorner &&
      rightIsRealCorner &&
      (
        (isLeftCornerL && isRightCornerL) ||
        (isLeftCornerP && isRightCornerP)
      );

    const hasDifferentCornerTypes =
      leftIsRealCorner &&
      rightIsRealCorner &&
      (
        (isLeftCornerL && isRightCornerP) ||
        (isLeftCornerP && isRightCornerL)
      );

    // âś… speciĂˇlnĂ­ reĹľimy pro stejnĂ© rohy
    const hasDoubleLeftCorners =
      isLeftCornerL && isRightCornerL;

    const hasDoubleRightCorners =
      isLeftCornerP && isRightCornerP;

    const hasDoubleSameCorners =
      hasDoubleLeftCorners || hasDoubleRightCorners;

    const hasCornerAndDualAxisEndpoints =
      uEndpointNodes.length >= 2 &&
      (
        (leftIsRealCorner && isDualAxisEndpoint(rightCornerNode)) ||
        (rightIsRealCorner && isDualAxisEndpoint(leftCornerNode))
      );

    const hasDualAxisAndDualAxisEndpoints =
      uEndpointNodes.length >= 2 &&
      !leftIsRealCorner &&
      !rightIsRealCorner &&
      isDualAxisEndpoint(leftCornerNode) &&
      isDualAxisEndpoint(rightCornerNode);

    debugLog("U CORNER TYPE MODE", {
      leftCornerRawVariant,
      rightCornerRawVariant,
      hasSameCornerTypes,
      hasDifferentCornerTypes,
      hasDoubleLeftCorners,
      hasDoubleRightCorners,
      hasDoubleSameCorners,
      hasCornerAndDualAxisEndpoints,
      hasDualAxisAndDualAxisEndpoints
    });

    let fullCornerPath;

    if (hasCornerAndDualAxisEndpoints || hasDualAxisAndDualAxisEndpoints) {
      const widthAxisNodesRaw = Array.isArray(analysis.widthAxisNodes)
        ? dedupeNodes(analysis.widthAxisNodes).filter(Boolean)
        : [];

      const leftDepthNodesRaw = Array.isArray(analysis.leftDepthNodes)
        ? dedupeNodes(analysis.leftDepthNodes).filter(Boolean)
        : [];

      const rightDepthNodesRaw = Array.isArray(analysis.rightDepthNodes)
        ? dedupeNodes(analysis.rightDepthNodes).filter(Boolean)
        : [];

      const leftKey = nodeKeyOf(leftCornerNode);
      const rightKey = nodeKeyOf(rightCornerNode);

      // 1) hlavnĂ­ zdroj pravĂ© middle vÄ›tve = skuteÄŤnĂˇ graph path mezi endpointy
      const graphPathBetweenEndpoints = bfsPath(leftCornerNode, rightCornerNode, nodes);

      const middleFromGraphPath = graphPathBetweenEndpoints.filter((n) => {
        const key = nodeKeyOf(n);
        if (!key) return false;
        if (key === leftKey || key === rightKey) return false;
        if (isUEndpoint(n)) return false;
        return true;
      });

      // 2) kandidĂˇti na skuteÄŤnĂ˝ stĹ™ed = co je v obou depth vÄ›tvĂ­ch
      const rightDepthKeySet = new Set(
        rightDepthNodesRaw.map(nodeKeyOf).filter(Boolean)
      );

      const middleFromDepthIntersection = leftDepthNodesRaw.filter((n) => {
        const key = nodeKeyOf(n);
        if (!key) return false;
        if (key === leftKey || key === rightKey) return false;
        if (isUEndpoint(n)) return false;
        return rightDepthKeySet.has(key);
      });

      // 3) speciĂˇlnĂ­ fallback pro 1 roh + 1D:
      // kdyĹľ jedna depth osa obsahuje OBA endpointy,
      // tak jejĂ­ non-endpoint moduly jsou skuteÄŤnĂ˝ middle chain
      const leftDepthHasBothEndpoints =
        leftDepthNodesRaw.some((n) => nodeKeyOf(n) === leftKey) &&
        leftDepthNodesRaw.some((n) => nodeKeyOf(n) === rightKey);

      const rightDepthHasBothEndpoints =
        rightDepthNodesRaw.some((n) => nodeKeyOf(n) === leftKey) &&
        rightDepthNodesRaw.some((n) => nodeKeyOf(n) === rightKey);

      const middleFromSingleDepthBridge = leftDepthHasBothEndpoints
        ? leftDepthNodesRaw.filter((n) => {
            const key = nodeKeyOf(n);
            if (!key) return false;
            if (key === leftKey || key === rightKey) return false;
            if (isUEndpoint(n)) return false;
            return true;
          })
        : rightDepthHasBothEndpoints
        ? rightDepthNodesRaw.filter((n) => {
            const key = nodeKeyOf(n);
            if (!key) return false;
            if (key === leftKey || key === rightKey) return false;
            if (isUEndpoint(n)) return false;
            return true;
          })
        : [];

      // 4) fallback = starĂ© widthAxisNodesRaw
      const middleFromWidthAxis = widthAxisNodesRaw.filter((n) => {
        const key = nodeKeyOf(n);
        if (!key) return false;
        if (key === leftKey || key === rightKey) return false;
        if (isUEndpoint(n)) return false;
        return true;
      });

      const isCornerPlusDualAxisOnly =
        hasCornerAndDualAxisEndpoints &&
        (
          (leftIsRealCorner && isDualAxisEndpoint(rightCornerNode)) ||
          (rightIsRealCorner && isDualAxisEndpoint(leftCornerNode))
        );

      const haveSameNodeSet = (aNodes, bNodes) => {
        const aKeys = dedupeNodes(aNodes || []).map(nodeKeyOf).filter(Boolean).sort();
        const bKeys = dedupeNodes(bNodes || []).map(nodeKeyOf).filter(Boolean).sort();
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every((key, idx) => key === bKeys[idx]);
      };

      const getMiddleSidePenalty = (candidateNodes) => {
        return dedupeNodes(candidateNodes || []).reduce((sum, n) => {
          const variant = String(variantOfNode(n) || "").trim();
          if (!variant) return sum;
          if (/_[123]L$/i.test(variant) || /_[123]P$/i.test(variant)) return sum + 2;
          if (/_1X?MO_[LP]$/i.test(variant) || /_MO_[LP]$/i.test(variant)) return sum + 2;
          return sum;
        }, 0);
      };

      const pickCornerPlusDualAxisMiddle = () => {
        // U topologie "1 roh + 1D" je root/null chain skutečná cesta mezi endpointy.
        // Width/depth heuristiky umí při větvi roh -> M -> 1MO omylem vybrat první
        // modul větve jako middle/root, což rozbije descriptor.
        if (middleFromGraphPath.length) {
          return { source: "graphPath", nodes: middleFromGraphPath };
        }

        const bridgeConsensus =
          middleFromSingleDepthBridge.length &&
          middleFromDepthIntersection.length &&
          haveSameNodeSet(middleFromSingleDepthBridge, middleFromDepthIntersection);

        const widthAxisSingleNodeOverride =
          bridgeConsensus &&
          middleFromWidthAxis.length === 1 &&
          middleFromSingleDepthBridge.length > 1 &&
          getMiddleSidePenalty(middleFromWidthAxis) === 0 &&
          getMiddleSidePenalty(middleFromWidthAxis) < getMiddleSidePenalty(middleFromSingleDepthBridge);

        if (widthAxisSingleNodeOverride) {
          return { source: "widthAxisSingleNodeOverride", nodes: middleFromWidthAxis };
        }

        if (bridgeConsensus) {
          return { source: "bridgeConsensus", nodes: middleFromSingleDepthBridge };
        }

        const fallbackCandidates = [
          { source: "graphPath", nodes: middleFromGraphPath },
          { source: "widthAxis", nodes: middleFromWidthAxis },
          { source: "singleDepthBridge", nodes: middleFromSingleDepthBridge },
          { source: "depthIntersection", nodes: middleFromDepthIntersection },
        ];

        const sourcePriority = {
          graphPath: 0,
          widthAxis: 1,
          singleDepthBridge: 2,
          depthIntersection: 3,
        };

        const scoredFallback = fallbackCandidates
          .filter(({ nodes }) => nodes.length)
          .map((entry) => ({
            ...entry,
            sidePenalty: getMiddleSidePenalty(entry.nodes),
          }))
          .sort((a, b) => {
            if (a.sidePenalty !== b.sidePenalty) return a.sidePenalty - b.sidePenalty;
            if (a.nodes.length !== b.nodes.length) return a.nodes.length - b.nodes.length;
            return (sourcePriority[a.source] ?? 99) - (sourcePriority[b.source] ?? 99);
          });

        return scoredFallback[0] || { source: "empty", nodes: [] };
      };

      // PRO 1 roh + 1D:
      // root/null MUSĂŤ bĂ˝t skuteÄŤnĂˇ cesta mezi endpointy.
      // Z praktickĂ˝ch repro pĹ™Ă­padĹŻ vychĂˇzĂ­ spolehlivÄ›ji graph path mezi
      // endpointy neĹľ widthAxis heuristika, kterĂˇ si umĂ­ jako "stĹ™ed"
      // omylem vybrat delĹˇĂ­ pravou/boÄŤnĂ­ vÄ›tev.
      const cornerPlusDualAxisMiddlePick = isCornerPlusDualAxisOnly
        ? pickCornerPlusDualAxisMiddle()
        : null;

      const chosenMiddleNodes = isCornerPlusDualAxisOnly
        ? cornerPlusDualAxisMiddlePick.nodes
        : (
            middleFromGraphPath.length
              ? middleFromGraphPath
              : middleFromDepthIntersection.length
              ? middleFromDepthIntersection
              : middleFromSingleDepthBridge.length
              ? middleFromSingleDepthBridge
              : middleFromWidthAxis
          );

      debugLog("CORNER_PLUS_1D MIDDLE PICK", {
        isCornerPlusDualAxisOnly,
        leftEndpoint: variantOfNode(leftCornerNode),
        rightEndpoint: variantOfNode(rightCornerNode),
        pickedSource:
          isCornerPlusDualAxisOnly
            ? (cornerPlusDualAxisMiddlePick?.source || "empty")
            : "non_corner_plus_1d",
        graphPathBetweenEndpoints: graphPathBetweenEndpoints.map(variantOfNode),
        middleFromGraphPath: middleFromGraphPath.map(variantOfNode),
        middleFromSingleDepthBridge: middleFromSingleDepthBridge.map(variantOfNode),
        middleFromDepthIntersection: middleFromDepthIntersection.map(variantOfNode),
        middleFromWidthAxis: middleFromWidthAxis.map(variantOfNode),
        chosenMiddleNodes: chosenMiddleNodes.map(variantOfNode),
        bridgeConsensus:
          middleFromSingleDepthBridge.length &&
          middleFromDepthIntersection.length &&
          haveSameNodeSet(middleFromSingleDepthBridge, middleFromDepthIntersection),
        widthAxisSingleNodeOverride:
          middleFromSingleDepthBridge.length &&
          middleFromDepthIntersection.length &&
          haveSameNodeSet(middleFromSingleDepthBridge, middleFromDepthIntersection) &&
          middleFromWidthAxis.length === 1 &&
          middleFromSingleDepthBridge.length > 1 &&
          getMiddleSidePenalty(middleFromWidthAxis) === 0 &&
          getMiddleSidePenalty(middleFromWidthAxis) < getMiddleSidePenalty(middleFromSingleDepthBridge),
        widthAxisSidePenalty: getMiddleSidePenalty(middleFromWidthAxis),
        singleDepthBridgeSidePenalty: getMiddleSidePenalty(middleFromSingleDepthBridge),
        depthIntersectionSidePenalty: getMiddleSidePenalty(middleFromDepthIntersection),
      });

      // seĹ™azenĂ­ middle path podle dominantnĂ­ osy mezi endpointy
      const endpointSpanX = Math.abs(getMappedX(rightCornerNode) - getMappedX(leftCornerNode));
      const endpointSpanZ = Math.abs(getMappedZ(rightCornerNode) - getMappedZ(leftCornerNode));
      const sortMiddleByX = endpointSpanX >= endpointSpanZ;

      chosenMiddleNodes.sort((a, b) => {
        return sortMiddleByX
          ? getMappedX(a) - getMappedX(b)
          : getMappedZ(a) - getMappedZ(b);
      });

      fullCornerPath = dedupeNodes([
        leftCornerNode,
        ...chosenMiddleNodes,
        rightCornerNode,
      ]).filter(Boolean);

      debugLog("DUAL_ENDPOINT_U WIDTH PATH", {
        endpoints: uEndpointNodes.map(variantOfNode),
        widthAxisNodesRaw: widthAxisNodesRaw.map(variantOfNode),
        leftDepthNodesRaw: leftDepthNodesRaw.map(variantOfNode),
        rightDepthNodesRaw: rightDepthNodesRaw.map(variantOfNode),
        graphPathBetweenEndpoints: graphPathBetweenEndpoints.map(variantOfNode),
        middleFromGraphPath: middleFromGraphPath.map(variantOfNode),
        middleFromDepthIntersection: middleFromDepthIntersection.map(variantOfNode),
        middleFromSingleDepthBridge: middleFromSingleDepthBridge.map(variantOfNode),
        middleFromWidthAxis: middleFromWidthAxis.map(variantOfNode),
        chosenMiddleNodes: chosenMiddleNodes.map(variantOfNode),
        fullCornerPath: fullCornerPath.map(variantOfNode),
      });

    } else if (!hasSameCornerTypes) {
      // =====================================================
      // PĹ®VODNĂŤ LOGIKA PRO DVA RĹ®ZNĂ‰ ROHY - NESAHAT
      // =====================================================
      fullCornerPath = bfsPath(leftCornerNode, rightCornerNode, nodes);
    } else {
      // =====================================================
      // NOVĂ LOGIKA JEN PRO STEJNĂ‰ ROHY
      // middle path NEBER z analysis.widthAxisNodes,
      // ale najdi komponentu mezi rohy, kterĂˇ se dotĂ˝kĂˇ OBOU rohĹŻ
      // =====================================================

      const nonCornerNodes = dedupeNodes(nodes).filter((n) => !isCorner(n));

      const leftCornerX = getMappedX(leftCornerNode);
      const rightCornerX = getMappedX(rightCornerNode);
      const leftCornerZ = getMappedZ(leftCornerNode);
      const rightCornerZ = getMappedZ(rightCornerNode);

      const cornerSpanX = Math.abs(rightCornerX - leftCornerX);
      const cornerSpanZ = Math.abs(rightCornerZ - leftCornerZ);

      // dominantnĂ­ osa mezi rohy:
      // kdyĹľ jsou rohy vĂ­c vedle sebe -> filtruj mezi nimi podle X
      // kdyĹľ jsou vĂ­c nad sebou -> filtruj mezi nimi podle Z
      const useXBandForBetweenCorners = cornerSpanX >= cornerSpanZ;

      const minBand = useXBandForBetweenCorners
        ? Math.min(leftCornerX, rightCornerX)
        : Math.min(leftCornerZ, rightCornerZ);

      const maxBand = useXBandForBetweenCorners
        ? Math.max(leftCornerX, rightCornerX)
        : Math.max(leftCornerZ, rightCornerZ);

      const betweenCornerCandidates = nonCornerNodes.filter((n) => {
        const v = useXBandForBetweenCorners ? getMappedX(n) : getMappedZ(n);
        return v >= minBand && v <= maxBand;
      });

      const buildComponents = (list) => {
        const pool = dedupeNodes(list || []).filter(Boolean);
        const used = new Set();
        const comps = [];

        for (const start of pool) {
          const startKey = nodeKeyOf(start);
          if (!startKey || used.has(startKey)) continue;

          const comp = [];
          const queue = [start];
          used.add(startKey);

          while (queue.length) {
            const cur = queue.shift();
            comp.push(cur);

            for (const next of pool) {
              const nextKey = nodeKeyOf(next);
              if (!nextKey || used.has(nextKey)) continue;

              if (isAdjacentEither(cur, next)) {
                used.add(nextKey);
                queue.push(next);
              }
            }
          }

          comps.push(comp);
        }

        return comps;
      };

      const components = buildComponents(betweenCornerCandidates);

      const bridgingComponents = components.filter((comp) => {
        const touchesLeft = comp.some((n) => isAdjacentEither(leftCornerNode, n));
        const touchesRight = comp.some((n) => isAdjacentEither(rightCornerNode, n));
        return touchesLeft && touchesRight;
      });

      const widthAxisNodesRaw = Array.isArray(analysis.widthAxisNodes)
        ? dedupeNodes(analysis.widthAxisNodes).filter(Boolean)
        : [];

      const widthAxisKeys = new Set(
        widthAxisNodesRaw.map(nodeKeyOf).filter(Boolean)
      );

      const scoreBridgeComponent = (comp) => {
        const clean = dedupeNodes(comp || []).filter((n) => !isCorner(n));
        const overlapScore = clean.reduce((sum, n) => {
          return sum + (widthAxisKeys.has(nodeKeyOf(n)) ? 1 : 0);
        }, 0);

        const minX = Math.min(...clean.map(getMappedX));
        const maxX = Math.max(...clean.map(getMappedX));
        const minZ = Math.min(...clean.map(getMappedZ));
        const maxZ = Math.max(...clean.map(getMappedZ));

        const spanX = maxX - minX;
        const spanZ = maxZ - minZ;

        return {
          clean,
          overlapScore,
          spanX,
          spanZ,
          len: clean.length,
        };
      };

      let chosenMiddleNodes = [];

      if (bridgingComponents.length) {
        const scored = bridgingComponents
          .map((comp) => scoreBridgeComponent(comp))
          .sort((a, b) => {
            // 1) nejdĹ™Ă­v preferuj komponentu, kterĂˇ se nejvĂ­c shoduje s widthAxisNodes z analĂ˝zy
            if (b.overlapScore !== a.overlapScore) return b.overlapScore - a.overlapScore;

            // 2) pak preferuj delĹˇĂ­ bridge
            if (b.len !== a.len) return b.len - a.len;

            // 3) a aĹľ pak vÄ›tĹˇĂ­ rozpÄ›tĂ­ v dominantnĂ­ ose mezi rohy
            const cornerSpanX = Math.abs(getMappedX(rightCornerNode) - getMappedX(leftCornerNode));
            const cornerSpanZ = Math.abs(getMappedZ(rightCornerNode) - getMappedZ(leftCornerNode));
            const preferX = cornerSpanX >= cornerSpanZ;

            return preferX ? (b.spanX - a.spanX) : (b.spanZ - a.spanZ);
          });

        chosenMiddleNodes = scored[0]?.clean?.slice() || [];
      } else {
        chosenMiddleNodes = widthAxisNodesRaw.filter((n) => !isCorner(n));
      }

      // Ĺ™aÄŹ middle path podle dominantnĂ­ osy mezi rohy, ne natvrdo podle X
      const sortMiddleByX = cornerSpanX >= cornerSpanZ;

      chosenMiddleNodes.sort((a, b) => {
        return sortMiddleByX
          ? getMappedX(a) - getMappedX(b)
          : getMappedZ(a) - getMappedZ(b);
      });

      fullCornerPath = dedupeNodes([
        leftCornerNode,
        ...chosenMiddleNodes,
        rightCornerNode
      ]).filter(Boolean);

      debugLog("SAME CORNER WIDTH PATH", {
        betweenCornerCandidates: betweenCornerCandidates.map(variantOfNode),
        components: components.map((c) => c.map(variantOfNode)),
        bridgingComponents: bridgingComponents.map((c) => c.map(variantOfNode)),
        chosenMiddleNodes: chosenMiddleNodes.map(variantOfNode),
        fullCornerPath: fullCornerPath.map(variantOfNode),
        widthAxisNodesRaw: widthAxisNodesRaw.map(variantOfNode),
        cornerSpanX,
        cornerSpanZ,
        useXBandForBetweenCorners,
        minBand,
        maxBand,
        sortMiddleByX,
      });
    }

    if (!fullCornerPath.length) {
      console.warn("Canonical U builder: no path between U endpoints", {
        endpoints: uEndpointNodes.map(variantOfNode),
        hasCornerAndDualAxisEndpoints,
        hasSameCornerTypes,
        hasDifferentCornerTypes,
      });
      return [];
    }

    const middlePathNodes = fullCornerPath.filter((n) => !isUEndpoint(n));

    if (!middlePathNodes.length) {
      console.warn("Canonical U builder: missing middle path nodes");
      return [];
    }

    const leftBranchNodesRaw = collectBranchFromCorner(leftCornerNode, fullCornerPath);
    const rightBranchNodesRaw = collectBranchFromCorner(rightCornerNode, fullCornerPath);

    const analysisLeftDepthNodes = Array.isArray(analysis.leftDepthNodes)
      ? analysis.leftDepthNodes.filter((n) => n && !isCorner(n))
      : [];

    const analysisRightDepthNodes = Array.isArray(analysis.rightDepthNodes)
      ? analysis.rightDepthNodes.filter((n) => n && !isCorner(n))
      : [];

    const sanitizeBranchNodes = (nodes, cornerNode, middlePathNodes) => {
      const middleKeys = new Set((middlePathNodes || []).map(nodeKeyOf).filter(Boolean));
      const cornerKey = nodeKeyOf(cornerNode);

      return dedupeNodes(nodes || []).filter((n) => {
        const key = nodeKeyOf(n);
        if (!key) return false;
        if (key === cornerKey) return false;
        if (middleKeys.has(key)) return false;
        if (isCorner(n)) return false;
        return true;
      });
    };

    const leftBranchNodesRawClean = sanitizeBranchNodes(leftBranchNodesRaw, leftCornerNode, fullCornerPath);
    const rightBranchNodesRawClean = sanitizeBranchNodes(rightBranchNodesRaw, rightCornerNode, fullCornerPath);

    const analysisLeftDepthNodesClean = sanitizeBranchNodes(analysisLeftDepthNodes, leftCornerNode, fullCornerPath);
    const analysisRightDepthNodesClean = sanitizeBranchNodes(analysisRightDepthNodes, rightCornerNode, fullCornerPath);

    // GEOMETRICKĂť FALLBACK:
    // vezmi vĹˇechny ne-corner moduly mimo middle path
    // a pĹ™iĹ™aÄŹ je k levĂ©mu / pravĂ©mu rohu podle X pozice a vzdĂˇlenosti ke cornerĹŻm
    const middleKeys = new Set(fullCornerPath.map(nodeKeyOf).filter(Boolean));

    const remainingBranchCandidates = dedupeNodes(nodes).filter((n) => {
      const key = nodeKeyOf(n);
      if (!key) return false;
      if (middleKeys.has(key)) return false;
      if (isCorner(n)) return false;
      return true;
    });

    const leftCornerX = getMappedX(leftCornerNode);
    const rightCornerX = getMappedX(rightCornerNode);

    const leftGeomCandidates = [];
    const rightGeomCandidates = [];

    for (const n of remainingBranchCandidates) {
      const x = getMappedX(n);

      const distToLeft = Math.abs(x - leftCornerX);
      const distToRight = Math.abs(x - rightCornerX);

      if (x <= leftCornerX) {
        leftGeomCandidates.push(n);
        continue;
      }

      if (x >= rightCornerX) {
        rightGeomCandidates.push(n);
        continue;
      }

      // fallback, kdyĹľ leĹľĂ­ "mezi", pĹ™iĹ™aÄŹ podle bliĹľĹˇĂ­ho rohu
      if (distToLeft <= distToRight) leftGeomCandidates.push(n);
      else rightGeomCandidates.push(n);
    }

    const mergeUniqueNodes = (...groups) => {
      const out = [];
      const seen = new Set();

      for (const group of groups) {
        for (const n of group || []) {
          const key = nodeKeyOf(n);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(n);
        }
      }

      return out;
    };

    const bfsDistanceFromCornerExcludingMiddle = (cornerNode, targetNode, middlePathNodes) => {
      const targetKey = nodeKeyOf(targetNode);
      const cornerKey = nodeKeyOf(cornerNode);
      if (!targetKey || !cornerKey) return Infinity;

      const middleKeys = new Set((middlePathNodes || []).map(nodeKeyOf).filter(Boolean));
      const queue = [{ node: cornerNode, dist: 0 }];
      const visited = new Set([cornerKey]);

      while (queue.length) {
        const { node, dist } = queue.shift();
        const nodeKey = nodeKeyOf(node);
        if (!nodeKey) continue;

        for (const next of getNeighbors(node)) {
          const nextKey = nodeKeyOf(next);
          if (!nextKey || visited.has(nextKey)) continue;

          // middle path ignorujeme, ale target pustĂ­me vĹľdy
          if (middleKeys.has(nextKey) && nextKey !== targetKey) continue;

          if (isCorner(next) && nextKey !== targetKey) continue;

          if (nextKey === targetKey) {
            return dist + 1;
          }

          visited.add(nextKey);
          queue.push({ node: next, dist: dist + 1 });
        }
      }

      return Infinity;
    };

    const assignBranchNodesForSameCorners = (
      candidates,
      leftCornerNode,
      rightCornerNode,
      middlePathNodes
    ) => {
      const left = [];
      const right = [];

      for (const n of dedupeNodes(candidates || [])) {
        if (!n || isCorner(n)) continue;

        const dl = bfsDistanceFromCornerExcludingMiddle(leftCornerNode, n, middlePathNodes);
        const dr = bfsDistanceFromCornerExcludingMiddle(rightCornerNode, n, middlePathNodes);

        if (dl === Infinity && dr === Infinity) continue;

        if (dl < dr) {
          left.push(n);
        } else if (dr < dl) {
          right.push(n);
        } else {
          // tie-break fallback podle X
          if (getMappedX(n) <= ((leftCornerX + rightCornerX) / 2)) left.push(n);
          else right.push(n);
        }
      }

      return { left, right };
    };

    let leftBranchNodes;
    let rightBranchNodes;

    const shouldUseStrictGraphBranchSplit =
      hasSameCornerTypes ||
      hasCornerAndDualAxisEndpoints ||
      hasDualAxisAndDualAxisEndpoints;

    if (!shouldUseStrictGraphBranchSplit) {
      // =====================================================
      // PĹ®VODNĂŤ LOGIKA PRO KLASICKĂ‰ U se dvÄ›ma rĹŻznĂ˝mi endpoint rohy
      // =====================================================
      leftBranchNodes = mergeUniqueNodes(
        leftBranchNodesRawClean,
        analysisLeftDepthNodesClean,
        leftGeomCandidates
      );

      rightBranchNodes = mergeUniqueNodes(
        rightBranchNodesRawClean,
        analysisRightDepthNodesClean,
        rightGeomCandidates
      );
    } else {
      // =====================================================
      // STRICT GRAPH SPLIT:
      // - stejnĂ© rohy
      // - 1 roh + 1D
      // - 2x 1D endpointy
      //
      // V tÄ›chto topologiĂ­ch nesmĂ­me do side branchĂ­ vracet raw analysis
      // fallbacky, protoĹľe prĂˇvÄ› ty umĂ­ kontaminovat middle chain nebo
      // opaÄŤnou vÄ›tev moduly z druhĂ© strany.
      // =====================================================

      const sameCornerCandidates = dedupeNodes(nodes).filter((n) => {
        const key = nodeKeyOf(n);
        if (!key) return false;
        if (middleKeys.has(key)) return false;
        if (isCorner(n)) return false;
        return true;
      });

      const lx = getMappedX(leftCornerNode);
      const lz = getMappedZ(leftCornerNode);
      const rx = getMappedX(rightCornerNode);
      const rz = getMappedZ(rightCornerNode);

      // 1) primĂˇrnĂ­ split = graph distance od rohĹŻ
      const assigned = assignBranchNodesForSameCorners(
        sameCornerCandidates,
        leftCornerNode,
        rightCornerNode,
        fullCornerPath
      );

      let leftAssigned = dedupeNodes(assigned?.left || []);
      let rightAssigned = dedupeNodes(assigned?.right || []);

      // 2) fallback pro moduly, kterĂ© graph split nechytil
      const assignedKeys = new Set(
        [...leftAssigned, ...rightAssigned].map(nodeKeyOf).filter(Boolean)
      );

      const unresolved = sameCornerCandidates.filter((n) => {
        const key = nodeKeyOf(n);
        return key && !assignedKeys.has(key);
      });

      for (const n of unresolved) {
        const nx = getMappedX(n);
        const nz = getMappedZ(n);

        const distToLeft = Math.hypot(nx - lx, nz - lz);
        const distToRight = Math.hypot(nx - rx, nz - rz);

        if (distToLeft <= distToRight) leftAssigned.push(n);
        else rightAssigned.push(n);
      }

      // 3) SAME-CORNER:
      // raw/analysis fallbacky uĹľ sem NESMĂŤME bez filtru vracet,
      // protoĹľe tĂ­m znovu nacpeme moduly z opaÄŤnĂ© vÄ›tve do obou chainĹŻ.
      // Nech jen to, co opravdu vyĹˇlo z graph splitu + unresolved fallbacku.
      leftBranchNodes = mergeUniqueNodes(leftAssigned);
      rightBranchNodes = mergeUniqueNodes(rightAssigned);

      debugLog("STRICT U GEOM SPLIT", {
        strictMode: {
          hasSameCornerTypes,
          hasCornerAndDualAxisEndpoints,
          hasDualAxisAndDualAxisEndpoints,
        },
        sameCornerCandidates: sameCornerCandidates.map((n) => ({
          variantId: variantOfNode(n),
          x: getMappedX(n),
          z: getMappedZ(n),
          distToLeft: Math.hypot(getMappedX(n) - lx, getMappedZ(n) - lz),
          distToRight: Math.hypot(getMappedX(n) - rx, getMappedZ(n) - rz),
          bfsLeft: bfsDistanceFromCornerExcludingMiddle(leftCornerNode, n, fullCornerPath),
          bfsRight: bfsDistanceFromCornerExcludingMiddle(rightCornerNode, n, fullCornerPath),
        })),
        corners: {
          leftCorner: { variantId: variantOfNode(leftCornerNode), x: lx, z: lz },
          rightCorner: { variantId: variantOfNode(rightCornerNode), x: rx, z: rz },
        },
        leftAssigned: leftAssigned.map(variantOfNode),
        rightAssigned: rightAssigned.map(variantOfNode),
        unresolved: unresolved.map(variantOfNode),
        leftGeom: leftBranchNodes.map(variantOfNode),
        rightGeom: rightBranchNodes.map(variantOfNode),
      });
    }

    let leftChain;
    let rightChain;

    const sortByDistanceFrom = (cornerNode, arr) => {
      return dedupeNodes(arr || [])
        .slice()
        .sort((a, b) => {
          const da = Math.hypot(
            getMappedX(a) - getMappedX(cornerNode),
            getMappedZ(a) - getMappedZ(cornerNode)
          );
          const db = Math.hypot(
            getMappedX(b) - getMappedX(cornerNode),
            getMappedZ(b) - getMappedZ(cornerNode)
          );
          return da - db;
        });
    };

    const orderBranchPreferLinearFromCorner = (cornerNode, branchNodes) => {
      const pool = dedupeNodes(branchNodes || []).filter(Boolean);
      if (pool.length <= 1) return pool;

      // 1) zkus nejdĹ™Ă­v skuteÄŤnĂ© lineĂˇrnĂ­ poĹ™adĂ­ podle sousednosti
      const linear = orderLinearBranchFromCorner(cornerNode, pool);

      const linearKeys = linear.map(nodeKeyOf).filter(Boolean);
      const poolKeys = pool.map(nodeKeyOf).filter(Boolean);

      const sameSize = linear.length === pool.length;
      const sameMembers =
        linearKeys.length === poolKeys.length &&
        linearKeys.every((k) => poolKeys.includes(k));

      if (!sameSize || !sameMembers) {
        return sortByDistanceFrom(cornerNode, pool);
      }

      // 2) ovÄ›Ĺ™, Ĺľe lineĂˇrnĂ­ poĹ™adĂ­ opravdu zaÄŤĂ­nĂˇ modulem sousedĂ­cĂ­m s rohem
      const first = linear[0] || null;
      const firstTouchesCorner =
        !!first &&
        getNeighbors(cornerNode).some((n) => nodeKeyOf(n) === nodeKeyOf(first));

      if (!firstTouchesCorner) {
        return sortByDistanceFrom(cornerNode, pool);
      }

      // 3) ovÄ›Ĺ™, Ĺľe sousednĂ­ dvojice v poĹ™adĂ­ opravdu navazujĂ­
      let chainLooksLinear = true;
      for (let i = 1; i < linear.length; i++) {
        if (!isAdjacentEither(linear[i - 1], linear[i])) {
          chainLooksLinear = false;
          break;
        }
      }

      if (!chainLooksLinear) {
        return sortByDistanceFrom(cornerNode, pool);
      }

      return linear;
    };

    leftChain = orderBranchPreferLinearFromCorner(leftCornerNode, leftBranchNodes);
    rightChain = orderBranchPreferLinearFromCorner(rightCornerNode, rightBranchNodes);

    if (hasSameCornerTypes) {
      debugLog("SAME CORNER CHAIN CHECK", {
        leftBranchNodes: leftBranchNodes.map(variantOfNode),
        rightBranchNodes: rightBranchNodes.map(variantOfNode),
        leftChain: leftChain.map(variantOfNode),
        rightChain: rightChain.map(variantOfNode),
        leftChainLen: leftChain.length,
        rightChainLen: rightChain.length,
      });

      debugLog("SAME CORNER CHAIN DETAIL", {
        leftDetailed: leftChain.map((n, i) => ({
          i,
          variantId: variantOfNode(n),
          x: getMappedX(n),
          z: getMappedZ(n),
        })),
        rightDetailed: rightChain.map((n, i) => ({
          i,
          variantId: variantOfNode(n),
          x: getMappedX(n),
          z: getMappedZ(n),
        })),
      });
    }

    if (hasSameCornerTypes) {
      debugLog("SAME CORNER GEOM DETAIL", {
        leftCorner: {
          variantId: variantOfNode(leftCornerNode),
          x: getMappedX(leftCornerNode),
          z: getMappedZ(leftCornerNode),
        },
        rightCorner: {
          variantId: variantOfNode(rightCornerNode),
          x: getMappedX(rightCornerNode),
          z: getMappedZ(rightCornerNode),
        },
        leftBranchNodesDetailed: leftBranchNodes.map((n) => ({
          variantId: variantOfNode(n),
          x: getMappedX(n),
          z: getMappedZ(n),
        })),
        rightBranchNodesDetailed: rightBranchNodes.map((n) => ({
          variantId: variantOfNode(n),
          x: getMappedX(n),
          z: getMappedZ(n),
        })),
      });
    }

    const getLastVariantId = (chain) => {
      if (!Array.isArray(chain) || !chain.length) return "";
      return String(variantOfNode(chain[chain.length - 1]) || "").trim();
    };

    const getChainSideHints = (chain) => {
      const variants = (chain || []).map((n) => String(variantOfNode(n) || "").trim());

      let lScore = 0;
      let pScore = 0;

      for (const v of variants) {
        if (/_[123]L$/i.test(v)) lScore += 1;
        if (/_[123]P$/i.test(v)) pScore += 1;
      }

      return {
        variants,
        lScore,
        pScore,
      };
    };

    const leftLastVariant = getLastVariantId(leftChain);
    const rightLastVariant = getLastVariantId(rightChain);

    const leftHints = getChainSideHints(leftChain);
    const rightHints = getChainSideHints(rightChain);

    // pĹŻvodnĂ­ ostrĂˇ detekce: levĂ˝ chain konÄŤĂ­ 1P a pravĂ˝ 1L
    const chainsLookSwappedByEndCaps =
      /_1P$/i.test(leftLastVariant) &&
      /_1L$/i.test(rightLastVariant);

    // novĂˇ ĹˇirĹˇĂ­ detekce:
    // kdyĹľ levĂ˝ chain nese vĂ­c P hintĹŻ neĹľ L hintĹŻ a pravĂ˝ chain nenĂ­ zjevnÄ› P,
    // je velmi pravdÄ›podobnĂ©, Ĺľe chainy jsou vĂ˝znamovÄ› obrĂˇcenÄ›.
    // To Ĺ™eĹˇĂ­ prĂˇvÄ› pĹ™Ă­pady typu: left=[1P], right=[3M]
    const chainsLookSwappedBySideHints =
      leftHints.pScore > leftHints.lScore &&
      rightHints.pScore <= rightHints.lScore;

    // zrcadlovĂ˝ pĹ™Ă­pad pro P/P:
    // kanonicky vlevo chceme L-hinty a vpravo ne-L chain.
    // kdyĹľ L-hinty skonÄŤĂ­ vpravo a vlevo nic L-ovĂ©ho nenĂ­,
    // jsou chainy vĂ˝znamovÄ› obrĂˇcenÄ›.
    const chainsLookSwappedByMirrorLHints =
      rightHints.lScore > rightHints.pScore &&
      leftHints.lScore <= leftHints.pScore;

    const shouldSwapChains =
      chainsLookSwappedByEndCaps ||
      chainsLookSwappedBySideHints ||
      chainsLookSwappedByMirrorLHints;

    // mixed rohy: pĹŻvodnĂ­ ochrana
    // L/L: stejnĂ˝ problĂ©m se mĹŻĹľe stĂˇt taky â€“ chainy se rozdÄ›lĂ­ dobĹ™e geometricky,
    // ale vĂ˝znamovÄ› skonÄŤĂ­ obrĂˇcenÄ› vĹŻÄŤi kanonickĂ©mu L/P descriptoru.
    if (hasDifferentCornerTypes || hasDoubleSameCorners) {
      if (shouldSwapChains) {
        console.warn("Canonical U builder: swapping left/right chains by semantic detection", {
          hasDifferentCornerTypes,
          hasDoubleLeftCorners,
          hasDoubleRightCorners,
          hasDoubleSameCorners,
          leftLastVariant,
          rightLastVariant,
          leftHints,
          rightHints,
          chainsLookSwappedByEndCaps,
          chainsLookSwappedBySideHints,
          leftBefore: leftChain.map(variantOfNode),
          rightBefore: rightChain.map(variantOfNode),
        });

        const tmp = leftChain;
        leftChain = rightChain;
        rightChain = tmp;
      }
    }

    debugLog("CANONICAL U BRANCH SOURCE", {
      sameCornerTypes: hasSameCornerTypes,
      differentCornerTypes: hasDifferentCornerTypes,
      leftRaw: leftBranchNodesRaw.map(variantOfNode),
      rightRaw: rightBranchNodesRaw.map(variantOfNode),
      leftFallback: analysisLeftDepthNodes.map(variantOfNode),
      rightFallback: analysisRightDepthNodes.map(variantOfNode),
      leftChosen: leftBranchNodes.map(variantOfNode),
      rightChosen: rightBranchNodes.map(variantOfNode),
      leftChain: leftChain.map(variantOfNode),
      rightChain: rightChain.map(variantOfNode),
      leftBranchNodesRawClean: leftBranchNodesRawClean.map(variantOfNode),
      rightBranchNodesRawClean: rightBranchNodesRawClean.map(variantOfNode),
      analysisLeftDepthNodesClean: analysisLeftDepthNodesClean.map(variantOfNode),
      analysisRightDepthNodesClean: analysisRightDepthNodesClean.map(variantOfNode),
      sameCornerPrimaryLeft: leftBranchNodesRawClean.map(variantOfNode),
      sameCornerPrimaryRight: rightBranchNodesRawClean.map(variantOfNode),
      leftBranchCount: leftBranchNodes.length,
      rightBranchCount: rightBranchNodes.length,
    });

    debugLog("CANONICAL U TOPOLOGY", {
      corners: cornerNodes.map(variantOfNode),
      endpoints: uEndpointNodes.map(variantOfNode),
      cornerPath: fullCornerPath.map(variantOfNode),
      middleChain: middlePathNodes.map(variantOfNode),
      leftBranch: leftChain.map(variantOfNode),
      rightBranch: rightChain.map(variantOfNode),
      leftEndpointIsDualAxis: isDualAxisEndpoint(leftCornerNode),
      rightEndpointIsDualAxis: isDualAxisEndpoint(rightCornerNode),
      fullCornerPathSource: hasSameCornerTypes ? "widthAxisNodes" : "bfsPath",
    });

    debugLog("CANONICAL U DESCRIPTOR PREVIEW", {
      middlePathNodes: middlePathNodes.map(variantOfNode),
      leftChain: leftChain.map(variantOfNode),
      rightChain: rightChain.map(variantOfNode),
      leftEndpointVariantId,
      rightEndpointVariantId,
      leftEndpointBlocksBranch,
      rightEndpointBlocksBranch,
    });

    const descriptor = [];

    // 1) root = prostĹ™ednĂ­ vÄ›tev mezi rohy
    for (let i = 0; i < middlePathNodes.length; i++) {
      const node = middlePathNodes[i];
      const variantId = variantOfNode(node);
      if (!variantId) continue;

      if (i === 0) {
        descriptor.push({
          variantId,
          attachTo: null,
          side: null,
          sourceSnapshot: takeSnapshotForVariant(variantId),
        });
        continue;
      }

      const attachIndex = descriptor.length - 1;
      const baseVariantId = descriptor[attachIndex]?.variantId || "";
      const side = pickAttachSideByRules(baseVariantId, variantId, ["right", "left"]);

      if (!side) {
        console.warn("Canonical U builder: no valid side for middle chain step", {
          baseVariantId,
          variantId,
          i
        });
        return [];
      }

      descriptor.push({
        variantId,
        attachTo: attachIndex,
        side,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });
    }

    const middleStartIndex = 0;
    const middleEndIndex = descriptor.length - 1;

    const getCanonicalEndpointVariantId = (node, side) => {
      const raw = variantOfNode(node);

      // 1D / dual-axis endpoint nechĂˇvĂˇme beze zmÄ›ny
      if (isDualAxisEndpoint(node)) {
        return raw;
      }

      // roh dĂˇl kanonizujeme stejnÄ› jako dosud
      return forceCornerSide(raw, side);
    };

    const leftEndpointVariantId = getCanonicalEndpointVariantId(leftCornerNode, "L");
    const leftEndpointAttachSide = pickAttachSideByRules(
      descriptor[middleStartIndex]?.variantId || "",
      leftEndpointVariantId,
      ["left", "front", "back", "right"]
    );

    if (!leftEndpointAttachSide) {
      console.warn("Canonical U builder: no valid side for left endpoint attach", {
        baseVariantId: descriptor[middleStartIndex]?.variantId || "",
        leftEndpointVariantId
      });
      return [];
    }

    descriptor.push({
      variantId: leftEndpointVariantId,
      attachTo: middleStartIndex,
      side: leftEndpointAttachSide,
      sourceSnapshot: takeSnapshotForVariant(variantOfNode(leftCornerNode)),
    });

    const leftCornerDescriptorIndex = descriptor.length - 1;

    const rightEndpointVariantId = getCanonicalEndpointVariantId(rightCornerNode, "P");
    const rightEndpointAttachSide = pickAttachSideByRules(
      descriptor[middleEndIndex]?.variantId || "",
      rightEndpointVariantId,
      ["right", "front", "back", "left"]
    );

    if (!rightEndpointAttachSide) {
      console.warn("Canonical U builder: no valid side for right endpoint attach", {
        baseVariantId: descriptor[middleEndIndex]?.variantId || "",
        rightEndpointVariantId
      });
      return [];
    }

    descriptor.push({
      variantId: rightEndpointVariantId,
      attachTo: middleEndIndex,
      side: rightEndpointAttachSide,
      sourceSnapshot: takeSnapshotForVariant(variantOfNode(rightCornerNode)),
    });

    const rightCornerDescriptorIndex = descriptor.length - 1;

    // 4) levĂˇ vÄ›tev od levĂ©ho endpointu ven
    const leftEndpointBlocksBranch = isDualAxisEndpoint(leftCornerNode);
    let lastLeftAttachIndex = leftCornerDescriptorIndex;
    let leftRunSide = null;

    for (let i = 0; i < (leftEndpointBlocksBranch ? 0 : leftChain.length); i++) {
      const node = leftChain[i];
      const variantId = variantOfNode(node);
      if (!variantId) continue;

      const attachIndex = lastLeftAttachIndex;
      const baseVariantId = descriptor[attachIndex]?.variantId || "";

      let preferredSides;
      const isLast = i === leftChain.length - 1;
      const isEndCap = isEndCapLikeVariant(variantId);

      if (hasDoubleLeftCorners) {
        // =====================================================
        // SPECIĂLNĂŤ LOGIKA JEN PRO L/L
        // tady to funguje dobĹ™e a chceme ji nechat jen pro dvojitĂ© levĂ© rohy.
        // =====================================================
        if (i === 0) {
          preferredSides = ["left", "front", "back", "right"];
        } else if (isLast && isEndCap && leftRunSide) {
          preferredSides = [leftRunSide, "left", "front", "right", "back"];
        } else if (leftRunSide) {
          preferredSides = [leftRunSide, "left", "front", "right", "back"];
        } else {
          preferredSides = ["left", "front", "back", "right"];
        }
      } else {
        // =====================================================
        // PĹ®VODNĂŤ / OBECNĂ LOGIKA
        // sem mĂˇ spadnout i P/P
        // =====================================================
        if (i === 0) {
          preferredSides = ["front", "left", "back", "right"];
        } else if (isLast && isEndCap && leftRunSide) {
          preferredSides = [leftRunSide, "front", "left", "right", "back"];
        } else if (leftRunSide) {
          preferredSides = [leftRunSide, "front", "left", "right", "back"];
        } else {
          preferredSides = ["left", "front", "right", "back"];
        }
      }

      const side = pickAttachSideByRules(
        baseVariantId,
        variantId,
        preferredSides
      );

      if (!side) {
        console.warn("Canonical U builder: no valid side for left chain step", {
          baseVariantId,
          variantId,
          i,
          attachIndex,
          lastLeftAttachIndex,
          leftRunSide
        });
        return [];
      }

      descriptor.push({
        variantId,
        attachTo: attachIndex,
        side,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });

      // jakmile se vÄ›tev po prvnĂ­m kroku rozbÄ›hne do boku,
      // drĹľ tenhle smÄ›r aĹľ do konce vÄ›tve
      if (hasDoubleLeftCorners) {
        if (i === 0 && side !== "front" && side !== "back") {
          leftRunSide = side;
        } else if (i >= 1 && side !== "front" && side !== "back") {
          leftRunSide = side;
        }
      } else {
        if (i >= 1 && side !== "front" && side !== "back") {
          leftRunSide = side;
        }
      }

      lastLeftAttachIndex = descriptor.length - 1;
    }

    // 5) pravĂˇ vÄ›tev od pravĂ©ho endpointu ven
    const rightEndpointBlocksBranch = isDualAxisEndpoint(rightCornerNode);
    let lastRightAttachIndex = rightCornerDescriptorIndex;
    let rightRunSide = null;

    for (let i = 0; i < (rightEndpointBlocksBranch ? 0 : rightChain.length); i++) {
      const node = rightChain[i];
      const variantId = variantOfNode(node);
      if (!variantId) continue;

      const attachIndex = lastRightAttachIndex;
      const baseVariantId = descriptor[attachIndex]?.variantId || "";

      let preferredSides;
      const isLast = i === rightChain.length - 1;
      const isEndCap = isEndCapLikeVariant(variantId);

      if (!hasSameCornerTypes) {
        // =====================================================
        // PĹ®VODNĂŤ LOGIKA PRO DVA RĹ®ZNĂ‰ ROHY - NESAHAT
        // =====================================================
        if (i === 0) {
          preferredSides = ["front", "back", "right", "left"];
        } else if (isLast && isEndCap && rightRunSide) {
          preferredSides = [rightRunSide, "front", "right", "left", "back"];
        } else if (rightRunSide) {
          preferredSides = [rightRunSide, "front", "right", "left", "back"];
        } else {
          preferredSides = ["right", "front", "left", "back"];
        }
      } else {
        // =====================================================
        // PĹ®VODNĂŤ SAME-CORNER LOGIKA PRO P/P - NESAHAT
        // =====================================================
        if (i === 0) {
          preferredSides = ["right", "front", "back", "left"];
        } else if (rightRunSide) {
          preferredSides = [rightRunSide, "right", "front", "back", "left"];
        } else {
          preferredSides = ["right", "front", "back", "left"];
        }
      }

      const side = pickAttachSideByRules(
        baseVariantId,
        variantId,
        preferredSides
      );

      debugLog("RIGHT CHAIN STEP DEBUG", {
        i,
        variantId,
        baseVariantId,
        attachIndex,
        preferredSides,
        pickedSide: side,
        rightRunSideBefore: rightRunSide,
        hasSameCornerTypes
      });

      if (!side) {
        console.warn("Canonical U builder: no valid side for right chain step", {
          baseVariantId,
          variantId,
          i,
          attachIndex,
          lastRightAttachIndex,
          rightRunSide,
          preferredSides,
          hasSameCornerTypes
        });
        return [];
      }

      descriptor.push({
        variantId,
        attachTo: attachIndex,
        side,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });

      // pro stejnĂ© rohy zamkni side hned po prvnĂ­m modulu
      if (hasSameCornerTypes) {
        if (i === 0) {
          rightRunSide = side;
        }
      } else {
        // pĹŻvodnĂ­ chovĂˇnĂ­ pro rĹŻznĂ© rohy
        if (i >= 1 && side !== "front" && side !== "back") {
          rightRunSide = side;
        }
      }

      lastRightAttachIndex = descriptor.length - 1;
    }

    return descriptor;
  }

  const orientation = analysis.orientation || "front";

  const widthAxisNodes = Array.isArray(analysis.widthAxisNodes)
    ? analysis.widthAxisNodes.slice()
    : [];

  const leftDepthNodes = Array.isArray(analysis.leftDepthNodes)
    ? analysis.leftDepthNodes.slice()
    : [];

  const rightDepthNodes = Array.isArray(analysis.rightDepthNodes)
    ? analysis.rightDepthNodes.slice()
    : [];

  const allNodes = Array.isArray(analysis.nodes) ? analysis.nodes.slice() : [];

  const getMapped = (node) => {
    return (typeof window !== "undefined" && typeof window.__getMappedPlanCenter === "function")
      ? window.__getMappedPlanCenter(node, orientation)
      : { x: 0, z: 0 };
  };

  const getMappedX = (node) => Number(getMapped(node)?.x) || 0;
  const getMappedZ = (node) => Number(getMapped(node)?.z) || 0;

  const variantOfNode = (node) => {
    return String(
      node?.rec?.name ??
      node?.rec?.variantId ??
      node?.rec?.mesh?.userData?.variantId ??
      ""
    ).trim();
  };

  const isCorner = (node) => {
    return /ROH/i.test(variantOfNode(node));
  };

  const isDualAxisPivot = (node) => {
    return !!node &&
      typeof window !== "undefined" &&
      typeof window.__isDualAxisModule === "function" &&
      window.__isDualAxisModule(node);
  };

  const isDualAxisVariantId = (variantId) => {
    const v = String(variantId || "").trim();
    return /_1X?D_[LP]$/i.test(v);
  };

  const isLeftDualAxisVariantId = (variantId) => {
    const v = String(variantId || "").trim();
    return /_1X?D_L$/i.test(v);
  };

  const isRightDualAxisVariantId = (variantId) => {
    const v = String(variantId || "").trim();
    return /_1X?D_P$/i.test(v);
  };

  const isAdjacent = (a, b) => {
    if (!a || !b) return false;
    return (
      a?.neighbors?.left === b ||
      a?.neighbors?.right === b ||
      a?.neighbors?.front === b ||
      a?.neighbors?.back === b
    );
  };

  const orderChainFromPivot = (nodes, pivotNode) => {
    const pool = dedupeNodes(nodes || []).filter(Boolean);
    if (pool.length <= 1) return pool;

    const ordered = [];
    const used = new Set();

    // 1) prvnĂ­ musĂ­ bĂ˝t ten, kterĂ˝ se pĹ™Ă­mo dotĂ˝kĂˇ pivotu
    let current =
      pool.find((n) => isAdjacent(n, pivotNode)) ||
      pool[0];

    while (current) {
      const key = current?.root?.uuid || current?.rec?.mesh?.uuid || current?.rec?.name;
      if (!key || used.has(key)) break;

      ordered.push(current);
      used.add(key);

      const next =
        pool.find((n) => {
          const nk = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name;
          if (!nk || used.has(nk)) return false;
          return isAdjacent(current, n);
        }) || null;

      current = next;
    }

    // fallback â€“ kdyby nÄ›co zĹŻstalo nepropojenĂ© / heuristika selhala
    for (const n of pool) {
      const key = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name;
      if (!key || used.has(key)) continue;
      ordered.push(n);
    }

    return ordered;
  };

  const dedupeNodes = (arr) => {
    const out = [];
    const seen = new Set();

    for (const n of arr || []) {
      const key = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || Math.random();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }

    return out;
  };

  const flipCornerVariantIdForCanonical = (variantId) => {
    const v = String(variantId || "").trim();
    if (!v) return v;

    if (/_roh_p$/i.test(v)) return v.replace(/_roh_p$/i, "_roh_L");
    if (/_roh_l$/i.test(v)) return v.replace(/_roh_l$/i, "_roh_P");

    if (/ROH_P$/i.test(v)) return v.replace(/ROH_P$/i, "roh_L");
    if (/ROH_L$/i.test(v)) return v.replace(/ROH_L$/i, "roh_P");

    return v;
  };

  const takeSnapshotForVariant = (() => {
    const used = new Set();

    return (variantId) => {
      const candidates = snapshot.filter((s, idx) => {
        if (used.has(idx)) return false;
        return String(s?.variantId || "").trim() === String(variantId || "").trim();
      });

      if (!candidates.length) return null;

      const picked = candidates[0];
      const realIndex = snapshot.findIndex((s, idx) => {
        return !used.has(idx) && s === picked;
      });

      if (realIndex >= 0) used.add(realIndex);
      return picked || null;
    };
  })();

  const getAvailableAttachSidesForVariant = (baseVariantId) => {
    const baseId = String(baseVariantId || "").trim();
    if (!baseId) return [];

    try {
      const key = normalizeOffsetKey(baseId);
      const defs = getModuleAddButtonOffsets()?.[key] || [];

      return defs
        .map((d) => String(d?.direction || "").trim())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  };

  const pickAttachSideByRules = (baseVariantId, newVariantId, preferredSides = []) => {
    const baseId = String(baseVariantId || "").trim();
    const newId = String(newVariantId || "").trim();

    if (!baseId || !newId) return null;

    const fallbackOrder = ["right", "left", "front", "back"];
    const orderedSides = [
      ...preferredSides,
      ...fallbackOrder.filter((s) => !preferredSides.includes(s))
    ];

    const availableSides = getAvailableAttachSidesForVariant(baseId);

    // 1) nejdĹ™Ă­v zkus side, kterĂ˝:
    //    - opravdu existuje v add-button offsetech
    //    - a zĂˇroveĹ projde connection rules
    for (const side of orderedSides) {
      try {
        const hasRealOffset =
          !availableSides.length || availableSides.includes(side);

        if (hasRealOffset && canAttach({ baseId, baseSide: side, newId })) {
          return side;
        }
      } catch (e) {}
    }

    // 2) fallback: kdyby offsety pro nÄ›jakĂ˝ modul chybÄ›ly
    for (const side of orderedSides) {
      try {
        if (canAttach({ baseId, baseSide: side, newId })) {
          return side;
        }
      } catch (e) {}
    }

    return null;
  };

  const cornerNode =
    allNodes.find((n) => isCorner(n)) ||
    leftDepthNodes.find((n) => isCorner(n)) ||
    rightDepthNodes.find((n) => isCorner(n)) ||
    null;

  const dualAxisPivotNode =
    allNodes.find((n) => isDualAxisPivot(n)) ||
    leftDepthNodes.find((n) => isDualAxisPivot(n)) ||
    rightDepthNodes.find((n) => isDualAxisPivot(n)) ||
    null;

  const pivotNode = cornerNode || dualAxisPivotNode || null;
  const pivotKind = cornerNode ? "corner" : (dualAxisPivotNode ? "dualAxis" : null);

  debugLog("CANONICAL PIVOT", {
    pivotKind,
    pivotVariantId: pivotNode ? variantOfNode(pivotNode) : null
  });

  if (!pivotNode) {
    console.warn("Canonical builder: neither corner nor dual-axis pivot node found");
    return [];
  }

  const nodeKeyOf = (n) =>
    n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;

  const widthStraight = dedupeNodes(
    widthAxisNodes.filter((n) => !isCorner(n) && n !== pivotNode)
  );

  const widthStraightKeys = new Set(
    widthStraight.map(nodeKeyOf).filter(Boolean)
  );

  const leftStraightRaw = dedupeNodes(
    leftDepthNodes.filter((n) => !isCorner(n) && n !== pivotNode)
  );

  const rightStraightRaw = dedupeNodes(
    rightDepthNodes.filter((n) => !isCorner(n) && n !== pivotNode)
  );

  // 2-branch FIX:
  // co uĹľ je souÄŤĂˇst widthStraight, nesmĂ­ znovu skonÄŤit v depthStraight,
  // jinak se stejnĂ˝ modul dostane do descriptoru dvakrĂˇt
  const leftStraight = leftStraightRaw.filter((n) => {
    const key = nodeKeyOf(n);
    return key && !widthStraightKeys.has(key);
  });

  const rightStraight = rightStraightRaw.filter((n) => {
    const key = nodeKeyOf(n);
    return key && !widthStraightKeys.has(key);
  });

  const depthStraight = leftStraight.length ? leftStraight : rightStraight;

  // speciĂˇlnĂ­ case:
  // kdyĹľ je pivot 1D / 1XD, tak druhĂˇ vÄ›tev mĹŻĹľe bĂ˝t tvoĹ™enĂˇ jen samotnĂ˝m pivotem
  // (napĹ™. 1D-2M), takĹľe side chain je validnÄ› prĂˇzdnĂ˝
  const isDualAxisOnlyL =
    pivotKind === "dualAxis" &&
    widthStraight.length > 0 &&
    depthStraight.length === 0;

  if (!widthStraight.length || (!depthStraight.length && !isDualAxisOnlyL)) {
    console.warn("Canonical builder: missing width/depth straight chain", {
      pivotKind,
      widthStraight,
      leftStraight,
      rightStraight,
      isDualAxisOnlyL
    });
    return [];
  }

  // Fyzická délka konkrétních větví, ze kterých se bude opravdu stavět descriptor.
  // Nebereme počet modulů ani obecnou analysis osu, ale přímo widthStraight/depthStraight.
  const getCanonicalChainLength = (chain, axisKind) => {
    const safeChain = Array.isArray(chain) ? chain.filter(Boolean) : [];

    if (!safeChain.length) return 0;

    if (axisKind === "depth") {
      return (typeof window !== "undefined" && typeof window.__sumDepthAxis === "function")
        ? window.__sumDepthAxis(safeChain, "min")
        : safeChain.length;
    }

    return (typeof window !== "undefined" && typeof window.__sumWidthAxis === "function")
      ? window.__sumWidthAxis(safeChain, [], "min")
      : safeChain.length;
  };

  const widthLen = getCanonicalChainLength(widthStraight, "width");
  const depthLen = getCanonicalChainLength(depthStraight, "depth");

  // HLAVNÍ pravidlo:
  // world osa = fyzicky delší větev.
  // orientation/back/right má jen rozhodnout, že se rebuild spustí,
  // ale ne o tom, která větev bude hlavní.
  const useDepthAsMain = depthLen > widthLen + 1;

  let mainChain = [];
  let sideChain = [];

  // Endcap z hlavní větve, který nesmí být root,
  // ale zároveň NESMÍ spadnout do sideChain za roh.
  let deferredMainEndCaps = [];

  debugLog("CANONICAL AXIS CHOICE", {
    orientation: analysis.orientation,
    widthLen,
    depthLen,
    useDepthAsMain,
    widthAxisNodes: widthAxisNodes.map(variantOfNode),
    leftDepthNodes: leftDepthNodes.map(variantOfNode),
    rightDepthNodes: rightDepthNodes.map(variantOfNode)
  });

  const countEndCapHints = (chain) => {
    return (chain || []).reduce((sum, n) => {
      const v = String(variantOfNode(n) || "").trim();
      return sum + (/_1[LP]$/i.test(v) ? 1 : 0);
    }, 0);
  };

  if (isDualAxisOnlyL) {
    // 1D / 1XD tvoĹ™Ă­ samo hloubku,
    // takĹľe hlavnĂ­ osa je vĹľdy straight width chain
    // a side chain je prĂˇzdnĂ˝
    mainChain = widthStraight.slice();
    sideChain = [];
  } else if (pivotKind === "dualAxis") {
    // =====================================================
    // 2 BRANCHES + 1D
    // =====================================================
    // Pro 1D nechceme pouĹľĂ­vat corner heuristiku s endcapy.
    // Tady nech pĹŻvodnĂ­ stabilnÄ›jĹˇĂ­ logiku:
    // - hlavnĂ­ osa se vybĂ­rĂˇ podle dĂ©lky
    // - vedlejĹˇĂ­ vÄ›tev je ta druhĂˇ
    // - ĹľĂˇdnĂ˝ corner swap pĹ™es 1L/1P se tu nesmĂ­ dĂ­t
    mainChain = useDepthAsMain ? depthStraight.slice() : widthStraight.slice();
    sideChain = useDepthAsMain ? widthStraight.slice() : depthStraight.slice();

    debugLog("DUAL AXIS MAIN/SIDE DECISION", {
      mainBefore: mainChain.map(variantOfNode),
      sideBefore: sideChain.map(variantOfNode),
      widthStraight: widthStraight.map(variantOfNode),
      depthStraight: depthStraight.map(variantOfNode),
      widthLen,
      depthLen,
      useDepthAsMain,
      pivotKind
    });
  } else if (pivotKind === "corner") {
    // =====================================================
    // 2 BRANCHES + CORNER
    // =====================================================
    // Tady naopak CHCEME speciĂˇlnĂ­ corner heuristiku:
    // - primĂˇrnĂ­ vĂ˝bÄ›r podle dĂ©lky
    // - nĂˇslednÄ› korekce pĹ™es endcap-like moduly 1L/1P,
    //   aby endcap neskonÄŤil jako null/root na world ose
    mainChain = useDepthAsMain ? depthStraight.slice() : widthStraight.slice();
    sideChain = useDepthAsMain ? widthStraight.slice() : depthStraight.slice();

    const mainEndCapHints = countEndCapHints(mainChain);
    const sideEndCapHints = countEndCapHints(sideChain);

    const mainFirstVariantId = String(variantOfNode(mainChain[0]) || "").trim();
    const sideFirstVariantId = String(variantOfNode(sideChain[0]) || "").trim();

    const mainStartsWithEndCap = /_1[LP]$/i.test(mainFirstVariantId);
    const sideStartsWithEndCap = /_1[LP]$/i.test(sideFirstVariantId);

    const shouldSwapChainsForCorner =
      mainStartsWithEndCap && !sideStartsWithEndCap;

    debugLog("CORNER MAIN/SIDE DECISION", {
      mainBefore: mainChain.map(variantOfNode),
      sideBefore: sideChain.map(variantOfNode),
      mainEndCapHints,
      sideEndCapHints,
      mainFirstVariantId,
      sideFirstVariantId,
      mainStartsWithEndCap,
      sideStartsWithEndCap,
      shouldSwapChainsForCorner,
      widthStraight: widthStraight.map(variantOfNode),
      depthStraight: depthStraight.map(variantOfNode),
      widthLen,
      depthLen,
      useDepthAsMain,
      pivotKind
    });

    if (shouldSwapChainsForCorner) {
      console.warn("Canonical corner builder: swapping main/side chains by endcap heuristics", {
        mainBefore: mainChain.map(variantOfNode),
        sideBefore: sideChain.map(variantOfNode),
        mainEndCapHints,
        sideEndCapHints,
        mainFirstVariantId,
        sideFirstVariantId,
        mainStartsWithEndCap,
        sideStartsWithEndCap,
      });

      const tmp = mainChain;
      mainChain = sideChain;
      sideChain = tmp;
    }
  } else {
    // fallback â€“ kdyby nÄ›kdy pĹ™iĹˇla 2-branch sestava bez corneru i bez 1D
    mainChain = useDepthAsMain ? depthStraight.slice() : widthStraight.slice();
    sideChain = useDepthAsMain ? widthStraight.slice() : depthStraight.slice();

    debugLog("GENERIC L MAIN/SIDE DECISION", {
      mainBefore: mainChain.map(variantOfNode),
      sideBefore: sideChain.map(variantOfNode),
      widthStraight: widthStraight.map(variantOfNode),
      depthStraight: depthStraight.map(variantOfNode),
      widthLen,
      depthLen,
      useDepthAsMain,
      pivotKind
    });
  }

  // seĹ™aÄŹ main chain po ose svĂ©ho aktuĂˇlnĂ­ho smÄ›ru
  if (useDepthAsMain) {
    mainChain.sort((a, b) => getMappedZ(a) - getMappedZ(b));
  } else {
    mainChain.sort((a, b) => getMappedX(a) - getMappedX(b));
  }

  // U bÄ›ĹľnĂ©ho L-case chceme, aby pivot navazoval na POSLEDNĂŤ modul hlavnĂ­ osy.
  //
  // ALE pro 1D nechceme rozhodovat jen podle dĂ©lky chainu.
  // MusĂ­me si zapamatovat, kterĂ˝ KONKRĂ‰TNĂŤ modul z mainChain
  // byl v pĹŻvodnĂ­ scĂ©nÄ› opravdu soused pivotu (1D),
  // a na ten pak 1D po canonical rebuildu pĹ™ipojit.
  const isDualAxisStraightOnly =
    pivotKind === "dualAxis" && sideChain.length === 0;

  const dualAxisAnchorNode = isDualAxisStraightOnly
    ? (mainChain.find((n) => isAdjacent(n, pivotNode)) || null)
    : null;

  let pivotAttachMode = "last";

  if (mainChain.length > 1) {
    const firstIsNearPivot = isAdjacent(mainChain[0], pivotNode);
    const lastIsNearPivot = isAdjacent(mainChain[mainChain.length - 1], pivotNode);

    if (isDualAxisStraightOnly) {
      // pro 1D chceme zachovat canonical poĹ™adĂ­ mainChain,
      // ale nebudeme uĹľ rozhodovat attach jen pĹ™es first/last.
      // Reverse udÄ›lej jen tehdy, kdyĹľ chceĹˇ dostat chain od vnÄ›jĹˇĂ­ho konce smÄ›rem k anchoru.
      if (firstIsNearPivot && !lastIsNearPivot) {
        mainChain.reverse();
      }
    } else {
      // pĹŻvodnĂ­ chovĂˇnĂ­ pro rohy / sideChain pĹ™Ă­pady
      if (firstIsNearPivot && !lastIsNearPivot) {
        mainChain.reverse();
      }
    }
  }

  // side chain chceme od pivotu smÄ›rem ven
  if (sideChain.length) {
    sideChain = orderChainFromPivot(sideChain, pivotNode);

    // đź”Ą FIX: 1D musĂ­ bĂ˝t nejblĂ­Ĺľ pivotu
    const is1D = (n) => {
      const v = variantOfNode(n) || "";
      return v.includes("1D");
    };

    const index1D = sideChain.findIndex(is1D);

    if (index1D > 0) {
      const [oneD] = sideChain.splice(index1D, 1);
      sideChain.unshift(oneD);
    }

    debugLog("CANONICAL SIDE CHAIN ORDER", sideChain.map(variantOfNode));
  }

  // CORNER ROOT FIX:
  // když mainChain začíná endcapem (1L/1P), tak ten nesmí být null/root.
  // ALE nesmí se přesunout do sideChain, protože by se pak připojil za roh
  // a mohl by skončit třeba na 1P.
  //
  // Správně:
  // - mainChain: [1L, 3M] -> [3M]
  // - 1L si odložíme bokem
  // - po vytvoření rootu 3M ho připojíme zpět přímo na 3M
  if (pivotKind === "corner" && mainChain.length >= 2) {
    const firstMainVariantId = String(variantOfNode(mainChain[0]) || "").trim();
    const secondMainVariantId = String(variantOfNode(mainChain[1]) || "").trim();

    const firstMainIsEndCap = /_1[LP]$/i.test(firstMainVariantId);
    const secondMainIsEndCap = /_1[LP]$/i.test(secondMainVariantId);

    if (firstMainIsEndCap && !secondMainIsEndCap) {
      debugLog("Canonical corner builder: deferring leading endcap from mainChain", {
        mainBefore: mainChain.map(variantOfNode),
        sideBefore: sideChain.map(variantOfNode),
        firstMainVariantId,
        secondMainVariantId,
      });

      const [leadingEndCap] = mainChain.splice(0, 1);

      if (leadingEndCap) {
        deferredMainEndCaps.push(leadingEndCap);
      }
    }
  }

  debugLog("CANONICAL CHAINS", {
    mainChain: mainChain.map(variantOfNode),
    sideChain: sideChain.map(variantOfNode),
    pivot: pivotNode ? variantOfNode(pivotNode) : null
  });

  const descriptor = [];

  // 1) hlavnĂ­ rovnĂ˝ chain
  for (let i = 0; i < mainChain.length; i++) {
    const node = mainChain[i];
    const variantId = variantOfNode(node);
    if (!variantId) continue;

    if (i === 0) {
      descriptor.push({
        variantId,
        attachTo: null,
        side: null,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });
      continue;
    }

    const prevVariantId = descriptor[descriptor.length - 1]?.variantId || "";
    const side = pickAttachSideByRules(prevVariantId, variantId, ["right", "left"]);

    if (!side) {
      console.warn("Canonical builder: no valid side for main chain step", {
        prevVariantId,
        variantId
      });
      return [];
    }

    descriptor.push({
      variantId,
      attachTo: descriptor.length - 1,
      side,
      sourceSnapshot: takeSnapshotForVariant(variantId),
    });
  }

  // =====================================================
  // SIMPLE 2-BRANCH CORNER REBUILD
  // inspirovĂˇno 3-branch flow:
  // mainChain -> corner -> sideChain
  // =====================================================
  if (pivotKind === "corner") {
    let cornerVariantId = variantOfNode(pivotNode);
    if (!cornerVariantId) return [];

    if (useDepthAsMain) {
      cornerVariantId = flipCornerVariantIdForCanonical(cornerVariantId);
    }

    const pivotAttachIndex = descriptor.length ? (descriptor.length - 1) : -1;
    const prevMainVariantId =
      pivotAttachIndex >= 0
        ? (descriptor[pivotAttachIndex]?.variantId || "")
        : "";

    const pivotIsCanonicalLeftCorner = /_roh_L$/i.test(String(cornerVariantId || "").trim());
    const pivotIsCanonicalRightCorner = /_roh_P$/i.test(String(cornerVariantId || "").trim());

    let pivotPreferredSides;
    if (pivotIsCanonicalLeftCorner) {
      pivotPreferredSides = ["left", "front", "back", "right"];
    } else if (pivotIsCanonicalRightCorner) {
      pivotPreferredSides = ["right", "front", "back", "left"];
    } else {
      pivotPreferredSides = ["front", "left", "right", "back"];
    }

    const pivotSide =
      pivotAttachIndex >= 0
        ? pickAttachSideByRules(
            prevMainVariantId,
            cornerVariantId,
            pivotPreferredSides
          )
        : null;

    if (pivotAttachIndex >= 0 && !pivotSide) {
      console.warn("Simple corner builder: no valid side for corner attach", {
        prevMainVariantId,
        cornerVariantId,
        pivotPreferredSides,
        mainChain: mainChain.map(variantOfNode),
        sideChain: sideChain.map(variantOfNode),
      });
      return [];
    }

    descriptor.push({
      variantId: cornerVariantId,
      attachTo: pivotAttachIndex >= 0 ? pivotAttachIndex : null,
      side: pivotAttachIndex >= 0 ? pivotSide : null,
      sourceSnapshot: takeSnapshotForVariant(variantOfNode(pivotNode)),
    });

    const cornerDescriptorIndex = descriptor.length - 1;

    // Připoj zpět odložené endcapy z hlavní větve.
    // Důležité: attachTo není roh ani sideChain, ale první hlavní modul,
    // typicky 3M. Tím se zabrání chybě 1P -> 1L.
    if (deferredMainEndCaps.length) {
      const mainEndCapAttachIndex = 0;
      const mainEndCapBaseVariantId = descriptor[mainEndCapAttachIndex]?.variantId || "";

      for (const endCapNode of deferredMainEndCaps) {
        const endCapVariantId = variantOfNode(endCapNode);
        if (!endCapVariantId) continue;

        const preferredSides =
          /_1L$/i.test(endCapVariantId)
            ? ["left", "right", "front", "back"]
            : /_1P$/i.test(endCapVariantId)
              ? ["right", "left", "front", "back"]
              : ["left", "right", "front", "back"];

        const endCapSide = pickAttachSideByRules(
          mainEndCapBaseVariantId,
          endCapVariantId,
          preferredSides
        );

        if (!endCapSide) {
          console.warn("Simple corner builder: no valid side for deferred main endcap", {
            mainEndCapBaseVariantId,
            endCapVariantId,
            preferredSides,
            mainChain: mainChain.map(variantOfNode),
            sideChain: sideChain.map(variantOfNode),
            deferredMainEndCaps: deferredMainEndCaps.map(variantOfNode),
          });
          return [];
        }

        descriptor.push({
          variantId: endCapVariantId,
          attachTo: mainEndCapAttachIndex,
          side: endCapSide,
          sourceSnapshot: takeSnapshotForVariant(endCapVariantId),
        });
      }
    }

    let lastBranchAttachIndex = cornerDescriptorIndex;
    let branchRunSide = null;

    for (let i = 0; i < sideChain.length; i++) {
      const node = sideChain[i];
      const variantId = variantOfNode(node);
      if (!variantId) continue;

      const attachIndex = lastBranchAttachIndex;
      const baseVariantId = descriptor[attachIndex]?.variantId || "";

      const isEndCapLike =
        /_1[LP]$/i.test(String(variantId || "").trim());

      let preferredSides;

      if (i === 0) {
        // prvnĂ­ modul po rohu = vÄ›tev ZA rohem
        if (pivotIsCanonicalLeftCorner) {
          preferredSides = ["front", "left", "back", "right"];
        } else if (pivotIsCanonicalRightCorner) {
          preferredSides = ["front", "right", "back", "left"];
        } else {
          preferredSides = ["front", "left", "right", "back"];
        }
      } else if (branchRunSide) {
        preferredSides = [branchRunSide, "front", "back", "left", "right"];
      } else if (pivotIsCanonicalLeftCorner) {
        preferredSides = ["left", "front", "back", "right"];
      } else if (pivotIsCanonicalRightCorner) {
        preferredSides = ["right", "front", "back", "left"];
      } else {
        preferredSides = ["right", "left", "front", "back"];
      }

      // konec vÄ›tve lehce preferuj do "sprĂˇvnĂ©" strany
      if (isEndCapLike) {
        if (pivotIsCanonicalLeftCorner && /_1L$/i.test(variantId)) {
          preferredSides = ["left", "front", "back", "right"];
        } else if (pivotIsCanonicalRightCorner && /_1P$/i.test(variantId)) {
          preferredSides = ["right", "front", "back", "left"];
        }
      }

      const side = pickAttachSideByRules(baseVariantId, variantId, preferredSides);

      if (!side) {
        console.warn("Simple corner builder: no valid side for sideChain step", {
          baseVariantId,
          variantId,
          i,
          attachIndex,
          preferredSides,
          mainChain: mainChain.map(variantOfNode),
          sideChain: sideChain.map(variantOfNode),
          cornerVariantId,
        });
        return [];
      }

      descriptor.push({
        variantId,
        attachTo: attachIndex,
        side,
        sourceSnapshot: takeSnapshotForVariant(variantId),
      });

      if (side !== "front" && side !== "back") {
        branchRunSide = side;
      }

      lastBranchAttachIndex = descriptor.length - 1;
    }

    debugLog("SIMPLE CORNER DESCRIPTOR", descriptor.map((x, i) => ({
      i,
      variantId: x.variantId,
      attachTo: x.attachTo,
      side: x.side
    })));

    return descriptor;
  }

  // 2) pivot â€“ buÄŹ roh, nebo 1D
  let pivotVariantId = variantOfNode(pivotNode);
  if (!pivotVariantId) return [];

  // roh pĹ™i canonical pĹ™etoÄŤenĂ­ flipujeme, 1D ne
  if (pivotKind === "corner" && useDepthAsMain) {
    pivotVariantId = flipCornerVariantIdForCanonical(pivotVariantId);
  }

  const sideChainFirstVariantId =
    sideChain.length ? String(variantOfNode(sideChain[0]) || "").trim() : "";

  const sideChainLastVariantId =
    sideChain.length ? String(variantOfNode(sideChain[sideChain.length - 1]) || "").trim() : "";

  const sideChainStartsWithEndCap = /_1[LP]$/i.test(sideChainFirstVariantId);
  const sideChainEndsWithEndCap = /_1[LP]$/i.test(sideChainLastVariantId);

  // CORNER SPECIAL:
  // u rohu nechceme roh vĹľdycky vÄ›Ĺˇet na konec hlavnĂ­ osy.
  // KdyĹľ je mainChain world osa a sideChain je vÄ›tev za rohem,
  // roh se mĂˇ napojit na "anchor" modul hlavnĂ­ osy, ne aĹľ za ni.
  // TypickĂ˝ case:
  //   2M(null) -> 3P
  //   2M(null) -> roh_L -> 2M -> 1L
  //
  // Heuristika:
  // - pivot je roh
  // - mainChain mĂˇ aspoĹ 2 moduly
  // - sideChain nezaÄŤĂ­nĂˇ endcapem
  //   (tj. nenĂ­ to straight osa s ukonÄŤenĂ­m, ale spĂ­Ĺˇ branch za rohem)
  const shouldAttachCornerToMainAnchor =
    pivotKind === "corner" &&
    mainChain.length >= 1 &&
    sideChain.length >= 1 &&
    !sideChainStartsWithEndCap;

  // najdi skuteÄŤnĂ˝ anchor hlavnĂ­ osy, na kterĂ˝ byl roh v pĹŻvodnĂ­ scĂ©nÄ› napojenĂ˝
  const cornerAnchorCandidates = shouldAttachCornerToMainAnchor
    ? mainChain
        .map((n, idx) => ({ node: n, idx }))
        .filter(({ node }) => isAdjacent(node, pivotNode))
    : [];

  const cornerAnchorNode =
    cornerAnchorCandidates.length
      ? cornerAnchorCandidates[cornerAnchorCandidates.length - 1].node
      : (shouldAttachCornerToMainAnchor
          ? (mainChain[mainChain.length - 1] || null)
          : null);

  const cornerAnchorIndex =
    cornerAnchorCandidates.length
      ? cornerAnchorCandidates[cornerAnchorCandidates.length - 1].idx
      : (
          cornerAnchorNode
            ? mainChain.findIndex((n) => n === cornerAnchorNode)
            : -1
        );

  let pivotAttachIndex = -1;

  if (descriptor.length) {
    if (shouldAttachCornerToMainAnchor) {
      if (cornerAnchorIndex >= 0 && cornerAnchorIndex < descriptor.length) {
        pivotAttachIndex = cornerAnchorIndex;
      } else {
        pivotAttachIndex = descriptor.length - 1;
      }

      debugLog("CORNER ATTACH ANCHOR", {
        cornerAnchorVariantId: cornerAnchorNode ? variantOfNode(cornerAnchorNode) : null,
        cornerAnchorIndex,
        cornerAnchorCandidates: cornerAnchorCandidates.map(({ node, idx }) => ({
          idx,
          variantId: variantOfNode(node),
        })),
        mainChain: mainChain.map(variantOfNode),
        descriptorVariants: descriptor.map((d) => d.variantId),
        pickedPivotAttachIndex: pivotAttachIndex,
      });

    } else if (isDualAxisStraightOnly && dualAxisAnchorNode) {
      const dualAxisAnchorVariantId = String(variantOfNode(dualAxisAnchorNode) || "").trim();

      // najdi descriptor index podle konkrĂ©tnĂ­ho node z mainChain,
      // ne jen podle variantId orderu "first/last"
      const anchorMainIndex = mainChain.findIndex((n) => n === dualAxisAnchorNode);

      if (anchorMainIndex >= 0 && anchorMainIndex < descriptor.length) {
        pivotAttachIndex = anchorMainIndex;
      } else {
        pivotAttachIndex = descriptor.length - 1;
      }

      debugLog("DUAL AXIS ATTACH ANCHOR", {
        dualAxisAnchorVariantId,
        anchorMainIndex,
        mainChain: mainChain.map(variantOfNode),
        descriptorVariants: descriptor.map((d) => d.variantId),
        pickedPivotAttachIndex: pivotAttachIndex,
      });
    } else {
      pivotAttachIndex = descriptor.length - 1;
    }
  }

  const prevMainVariantId = pivotAttachIndex >= 0
    ? (descriptor[pivotAttachIndex]?.variantId || "")
    : "";

  let pivotPreferredSides;

  if (pivotKind === "corner") {
    pivotPreferredSides = ["left", "right"];
  } else if (isLeftDualAxisVariantId(pivotVariantId)) {
    // 1D_L mĂˇ zĹŻstat levĂ˝ endpoint
    pivotPreferredSides = ["left", "front", "right", "back"];
  } else if (isRightDualAxisVariantId(pivotVariantId)) {
    // 1D_P mĂˇ zĹŻstat pravĂ˝ endpoint
    pivotPreferredSides = ["right", "front", "left", "back"];
  } else {
    pivotPreferredSides = ["front", "left", "right", "back"];
  }

  const pivotSide = prevMainVariantId
    ? pickAttachSideByRules(
        prevMainVariantId,
        pivotVariantId,
        pivotPreferredSides
      )
    : null;

  if (pivotAttachIndex >= 0 && !pivotSide) {
    console.warn("Canonical builder: no valid side for pivot attach", {
      pivotKind,
      prevMainVariantId,
      pivotVariantId
    });
    return [];
  }

  descriptor.push({
    variantId: pivotVariantId,
    attachTo: pivotAttachIndex >= 0 ? pivotAttachIndex : null,
    side: pivotAttachIndex >= 0 ? pivotSide : null,
    sourceSnapshot: takeSnapshotForVariant(variantOfNode(pivotNode)),
  });

  const pivotDescriptorIndex = descriptor.length - 1;

  // 3) druhĂ˝ chain od pivotu ven
  let firstBranchAfterCornerIndex = -1;

  for (let i = 0; i < sideChain.length; i++) {
    const node = sideChain[i];
    const variantId = variantOfNode(node);
    if (!variantId) continue;

    const pivotIsCanonicalLeftCorner = /_roh_L$/i.test(String(pivotVariantId || "").trim());
    const pivotIsCanonicalRightCorner = /_roh_P$/i.test(String(pivotVariantId || "").trim());

    const looksLikeWorldExtension =
      (pivotIsCanonicalLeftCorner && /_[23]P$/i.test(variantId)) ||
      (pivotIsCanonicalRightCorner && /_[23]L$/i.test(variantId));

    const looksLikeBranchEndCap =
      (pivotIsCanonicalLeftCorner && /_1L$/i.test(variantId)) ||
      (pivotIsCanonicalRightCorner && /_1P$/i.test(variantId));

    let attachIndex;

    if (i === 0) {
      attachIndex = pivotDescriptorIndex;
    } else if (
      pivotKind === "corner" &&
      shouldAttachCornerToMainAnchor &&
      looksLikeWorldExtension
    ) {
      // world-axis continuation musĂ­ jĂ­t zpĂˇtky na null/root,
      // ne Ĺ™etÄ›zit se za branch modulem po rohu
      attachIndex =
        (shouldAttachCornerToMainAnchor && cornerAnchorIndex >= 0)
          ? cornerAnchorIndex
          : 0;
    } else if (
      pivotKind === "corner" &&
      shouldAttachCornerToMainAnchor &&
      looksLikeBranchEndCap &&
      firstBranchAfterCornerIndex >= 0
    ) {
      // endcap vÄ›tve musĂ­ pokraÄŤovat z branch chainu za rohem,
      // ne z world-axis continuation
      attachIndex = firstBranchAfterCornerIndex;
    } else {
      attachIndex = descriptor.length - 1;
    }

    const baseVariantId = descriptor[attachIndex]?.variantId || "";

    let preferredSides;

    if (i === 0) {
      if (pivotKind === "corner" && isDualAxisVariantId(variantId)) {
        if (isLeftDualAxisVariantId(variantId)) {
          preferredSides = ["left", "front", "right", "back"];
        } else if (isRightDualAxisVariantId(variantId)) {
          preferredSides = ["right", "front", "left", "back"];
        } else {
          preferredSides = ["front", "right", "left", "back"];
        }
      } else if (pivotKind === "corner") {
        // u rohu chceme druhĂ˝ chain primĂˇrnÄ› jako vÄ›tev ZA rohem,
        // takĹľe prvnĂ­ modul po rohu musĂ­ preferovat front/back
        // pĹ™ed boÄŤnĂ­m pokraÄŤovĂˇnĂ­m world osy
        preferredSides = ["front", "back", "left", "right"];
      } else {
        preferredSides = ["right", "left", "front", "back"];
      }
    } else if (
      pivotKind === "corner" &&
      shouldAttachCornerToMainAnchor &&
      looksLikeWorldExtension
    ) {
      preferredSides = pivotIsCanonicalLeftCorner
        ? ["right", "front", "left", "back"]
        : ["left", "front", "right", "back"];
    } else if (
      pivotKind === "corner" &&
      shouldAttachCornerToMainAnchor &&
      looksLikeBranchEndCap
    ) {
      preferredSides = pivotIsCanonicalLeftCorner
        ? ["left", "front", "back", "right"]
        : ["right", "front", "back", "left"];
    } else {
      preferredSides = ["right", "left", "front", "back"];
    }

    const side = pickAttachSideByRules(baseVariantId, variantId, preferredSides);

    if (!side) {
      console.warn("Canonical builder: no valid side for side chain step", {
        pivotKind,
        baseVariantId,
        variantId,
        i,
        attachIndex,
        looksLikeWorldExtension,
        looksLikeBranchEndCap
      });
      return [];
    }

    descriptor.push({
      variantId,
      attachTo: attachIndex,
      side,
      sourceSnapshot: takeSnapshotForVariant(variantId),
    });

    if (i === 0) {
      firstBranchAfterCornerIndex = descriptor.length - 1;
    }
  }

  return descriptor;
}

async function rebuildSceneFromCanonicalDescriptor(descriptor, snapshot) {
  if (!Array.isArray(descriptor) || !descriptor.length) return false;

  loadingBegin(10, "Srovnávám sestavu…");

  try {

    suppressPlanAnalysisDuringCanonicalRebuild = true;

    clearSceneForPreset();
    cameraPinned = false;

    const createdMeshes = [];

    for (let stepIndex = 0; stepIndex < descriptor.length; stepIndex++) {
      const step = descriptor[stepIndex];

      debugLog("REBUILD STEP", {
        stepIndex,
        variantId: step.variantId,
        attachTo: step.attachTo,
        side: step.side
      });

      let mesh = null;

      if (step.attachTo == null) {
        mesh = await addVariantAsFirst(step.variantId);
      } else {
        const baseMesh = createdMeshes[step.attachTo];
        if (!baseMesh) {
          throw new Error(
            `Canonical rebuild: missing base mesh for attachTo at step ${stepIndex}`
          );
        }

        mesh = await addVariantAttached(
          step.variantId,
          baseMesh,
          step.side
        );
      }

      if (!mesh) {
        throw new Error(
          `Canonical rebuild: failed to add step ${stepIndex} (${step.variantId})`
        );
      }

      createdMeshes[stepIndex] = mesh;

      const rec = activeModules.find((r) => r?.mesh === mesh) || null;
      if (rec && step.sourceSnapshot) {
        rec.upgrade = step.sourceSnapshot.upgrade || null;

        if (rec.mesh) {
          extrasChoiceByModuleUuid.set(
            rec.mesh.uuid,
            step.sourceSnapshot.upgradeChoice || "unset"
          );
        }
      }
    }

    updateButtons();
    relayoutFromAnchor();
    await rebuildAllAddButtons();

    // Po canonical rebuild vzniknou nové meshe a mají default/basecolor materiály.
    // Pokud už je vybraná látka, musíme ji hned znovu aplikovat na nově vytvořenou sestavu.
    try { reapplyCurrentFabricAndPaspuleIfSelected?.(); } catch (e) {
      console.warn("Reapply fabric/paspule after canonical rebuild failed:", e);
    }

    recomputeCameraFit();
    snapCameraToAutoGoal?.();
    scheduleSummaryRecalc();
    refreshStepValidityAfterCompositionChange();
    window.__refreshSofaPlanEverywhere?.();
    saveStateDebounced?.(50);

    return createdMeshes.length > 0;
  } catch (e) {
    console.warn("rebuildSceneFromCanonicalDescriptor failed:", e);
    return false;
  } finally {
    suppressPlanAnalysisDuringCanonicalRebuild = false;
    loadingEnd();
  }
}

function clearHoveredModule() {
  if (hoveredModule) {
    try { resetModuleHover(hoveredModule); } catch (e) {}
    hoveredModule = null;
  }
}

function orderExtrasModulesSpatialSnake(recs) {
  const list = Array.isArray(recs) ? recs.slice() : [];
  if (list.length <= 1) return list;

  // center + size cache (kvĹŻli vĂ˝konu)
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();

  const items = list.map((rec) => {
    box.setFromObject(rec.mesh);
    box.getCenter(center);
    box.getSize(size);
    return {
      rec,
      cx: center.x,
      cz: center.z,
      sx: size.x,
      sz: size.z,
    };
  });

  // tolerance pro "stejnou Ĺ™adu" v Z
  // (vezmeme typickou hloubku modulu a z nĂ­ udÄ›lĂˇme rozumnĂ˝ threshold)
  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };

  const typicalDepth = median(items.map(i => Math.max(0.0001, i.sz)));
  const rowTol = typicalDepth * 0.45; // kdyĹľ je to moc/mĂˇlo, dej tĹ™eba 0.35 nebo 0.6

  // 1) seskup do Ĺ™ad podle Z (clustering)
  // Ĺ™ady drĹľĂ­me jako { zRef, items: [] }
  const rows = [];
  const sortedByZ = items.slice().sort((a, b) => a.cz - b.cz); // front/back dle tvĂ© osy

  for (const it of sortedByZ) {
    let row = rows.find(r => Math.abs(it.cz - r.zRef) <= rowTol);
    if (!row) {
      row = { zRef: it.cz, items: [] };
      rows.push(row);
    }
    row.items.push(it);
    // prĹŻbÄ›ĹľnÄ› zpĹ™esni referenÄŤnĂ­ Z Ĺ™ady (prĹŻmÄ›r)
    row.zRef = row.items.reduce((s, x) => s + x.cz, 0) / row.items.length;
  }

  // 2) seĹ™aÄŹ Ĺ™ady "od pĹ™edku k zadku"
  // Pozn.: u tebe "front" pĹ™idĂˇvĂˇ modul do menĹˇĂ­ho Z (viz computeSnapPosition),
  // takĹľe "pĹ™edek" bude menĹˇĂ­ cz -> proto sort vzestupnÄ› (uĹľ je).
  rows.sort((a, b) => a.zRef - b.zRef);

  // 3) uvnitĹ™ Ĺ™ady seĹ™aÄŹ podle X a udÄ›lej "snake" (kaĹľdĂˇ druhĂˇ Ĺ™ada obrĂˇcenÄ›)
  const out = [];
  rows.forEach((row, idx) => {
    row.items.sort((a, b) => a.cx - b.cx);
    const arr = (idx % 2 === 0) ? row.items : row.items.slice().reverse();
    arr.forEach(it => out.push(it.rec));
  });

  return out;
}

// ===== EXTRAS thumbs tweak (posun/zoom + objectFit + â€śauto backgroundâ€ť) =====
function getExtrasThumbTweak(variantId) {
  const v = String(variantId || "");

  // --- MANILA: kdyĹľ je to â€ś1*â€ť modul, chceme vidÄ›t celĂ˝ modul (contain)
  if (v.startsWith("Manila_1")) {
    return {
      fit: "contain",
      bg: "auto",
      y: 50,
      scale: 1.0
    };
  }

  // --- MENDOZA
  if (v.startsWith("Mendoza_")) {

    // âś… 1D/1M/1P + jejich X varianty (1XD/1XM/1XP): zobrazit celĂ© + splynout pozadĂ­
    // (tohle je pĹ™esnÄ› to, co popisujeĹˇ: modul celĂ˝ + â€śiluze jednoho obrĂˇzkuâ€ť)
    if (/^Mendoza_1X?(D|M|P)(_|$)/.test(v)) {
      return {
        fit: "contain",
        bg: "auto",
        y: 50,
        scale: 1.0
      };
    }

    // ostatnĂ­: tvoje pĹŻvodnĂ­ logika
    if (/^Mendoza_(2|3)/.test(v)) {
      return { fit: "cover", bg: null, y: 56, scale: 1.0 };
    }

    return { fit: "cover", bg: null, y: 75, scale: 1.05 };
  }

  return null;
}

function renderExtrasModuleList() {
  const listEl = document.getElementById("extrasModuleList");
  const emptyEl = document.getElementById("extrasEmptyHint");
  if (!listEl) return;

  clearHoveredModule();

  // nechceme render mimo krok 3 (tab sice existuje, ale step = jinĂ˝)
  if (!isHeadrestStepActive()) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.classList.add("hidden");
    return;
  }

  const eligible = (activeModules || []).filter(isModuleEligibleForExtras);

  const orderedEligible = orderExtrasModulesSpatialSnake(eligible);

  // empty
  if (!eligible.length) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  } else {
    if (emptyEl) emptyEl.classList.add("hidden");
  }

  listEl.innerHTML = "";

  for (const rec of orderedEligible) {
    const uuid = rec.mesh.uuid;
    const choice = extrasChoiceByModuleUuid.get(uuid) || "unset";

    const card = document.createElement("div");
    card.className = "extrasCard";
    card.dataset.uuid = uuid;

    // HOVER ve scĂ©nÄ› (stejnĂ© jako v kroku 2)
    card.addEventListener("mouseenter", () => {
      // kdyĹľ uĹľ byl zvĂ˝raznÄ›nĂ˝ jinĂ˝ modul, vraĹĄ ho zpĂˇtky
      if (hoveredModule && hoveredModule !== rec.mesh) {
        resetModuleHover(hoveredModule);
      }

      hoveredModule = rec.mesh;
      applyModuleHover(hoveredModule);
    });

    card.addEventListener("mouseleave", () => {
      // zruĹˇit hover jen kdyĹľ odjĂ­ĹľdĂ­m z toho stejnĂ©ho modulu
      if (hoveredModule === rec.mesh) {
        resetModuleHover(hoveredModule);
        hoveredModule = null;
      }
    });

    const thumb = document.createElement("div");
    thumb.className = "extrasThumb";
    const img = document.createElement("img");
    img.alt = getRecVariantId(rec) || "Modul";
    thumb.appendChild(img);

    // âś… 1) nejdĹ™Ă­v pĹ™ipojit thumbnail (to mĹŻĹľe nastavovat i styly)
    try {
      if (typeof attachThumbToImg === "function") {
        const variantId = getRecVariantId(rec);
        if (variantId) attachThumbToImg(variantId, img);
      }
    } catch (e) {}

    // âś… 2) aĹľ potom aplikovat tweak (tĂ­m pĹ™epĂ­ĹˇeĹˇ pĹ™Ă­padnĂ© cover z attachThumbToImg)
    const variantIdForThumb = getRecVariantId(rec);
    const tweak = getExtrasThumbTweak(variantIdForThumb);

    if (tweak) {
      if (tweak.fit) img.style.objectFit = tweak.fit;
      if (typeof tweak.y === "number") img.style.objectPosition = `50% ${tweak.y}%`;
      if (typeof tweak.scale === "number") img.style.transform = `scale(${tweak.scale})`;

      if (tweak.bg === "auto") {
        thumb.style.background = "#f7f5f2";   // ÄŤistÄ› bĂ­lĂ© pozadĂ­
      }
    } else {
      img.style.objectFit = "";
      img.style.objectPosition = "";
      img.style.transform = "";
      thumb.style.background = "";
    }

    const meta = document.createElement("div");

    const title = document.createElement("div");
    title.className = "extrasTitle";
    title.textContent = rec.name || rec.variantId || "Modul";

    const status = document.createElement("div");
    status.className = "extrasStatus";
    status.innerHTML = `Vybráno: <strong>${extrasLabel(choice, rec)}</strong>`;

    const chips = document.createElement("div");
    chips.className = "extrasChips";

    // variantId + ceny
    const variantId = getRecVariantId(rec);
    const cat = getCatalog?.(variantId);

    // base cena modulu (bez pĹ™Ă­platku)
    const basePrice = (variantId && typeof getModulePrice === "function")
      ? getSummaryPriceForRecSafe(rec, selectedUpholstery, null)
      : 0;

    // spoÄŤĂ­tĂˇ rozdĂ­l "o kolik je draĹľĹˇĂ­ upgrade neĹľ base"
    const getDiff = (upgradeKey) => {
      if (!upgradeKey) return 0;
      if (!variantId || !cat) return null;

      // povolenĂ© upgrady pro modul (z catalogue.js)
      const allowed = Array.isArray(cat.allowedUpgrades) ? cat.allowedUpgrades : [];
      if (!allowed.includes(upgradeKey)) return null;

      const upgraded = getSummaryPriceForRecSafe(rec, selectedUpholstery, upgradeKey);
      const diff = Number(upgraded) - Number(basePrice);
      return Number.isFinite(diff) ? diff : null;
    };

    const mkChip = (label, val, upgradeKey) => {
      const b = document.createElement("button");
      b.type = "button";

      // aktivnĂ­ volba (beru i starĂ© "sleep" jako "bed")
      const isActive =
        choice === val || (val === "bed" && choice === "sleep");

      const diff = getDiff(upgradeKey);

      // kdyĹľ upgrade nenĂ­ povolenĂ˝ (nebo nenĂ­ cena), tak chip vĹŻbec nevytvĂˇĹ™ej
      if (upgradeKey && diff === null) return null;

      const isDisabled = false;

      b.className =
        "extrasChip" +
        (isActive ? " is-active" : "") +
        (isDisabled ? " is-disabled" : "");

      b.dataset.choice = val;
      b.disabled = !!isDisabled;

      const labelEl = document.createElement("span");
      labelEl.className = "extrasChipLabel";
      labelEl.textContent = label;

      const priceEl = document.createElement("span");
      priceEl.className = "extrasChipPrice";

      if (isDisabled) {
        priceEl.textContent = "—";
      } else {
        // Bez pĹ™Ă­platku = 0, Upgrady = + rozdĂ­l
        if (!upgradeKey) {
          priceEl.textContent = `+${formatCzk(0)}`;
        } else {
          priceEl.textContent = `+${formatCzk(diff)}`;
        }
      }

      b.appendChild(labelEl);
      b.appendChild(priceEl);

      return b;
    };

    chips.appendChild(mkChip("Bez příplatku", "none", null));

    const isMendoza = String(getActiveSofaKeyFromScene?.() || "").toLowerCase() === "mendoza";

    const diffBed  = getDiff("bed");
    const diffBed2 = getDiff("bed2"); // null pokud nenĂ­ povolenĂ© v allowedUpgrades

    const bedChip = mkChip("Rozklad", "bed", "bed");
    if (bedChip) {
      // oznaÄŤĂ­me si, Ĺľe tenhle konkrĂ©tnĂ­ card+chip umĂ­ i bed2 (jen Mendoza a jen kdyĹľ je povoleno)
      if (isMendoza && diffBed2 != null) {
        bedChip.dataset.hasBed2 = "1";
        bedChip.dataset.diffBed  = String(diffBed ?? "");
        bedChip.dataset.diffBed2 = String(diffBed2 ?? "");

        // kdyĹľ je vybranĂ© bed2, zvĂ˝razni chip stejnÄ› jako bed (je to poĹ™Ăˇd "Rozklad" tlaÄŤĂ­tko)
        if (choice === "bed2") bedChip.classList.add("is-active");

        // pĹ™epiĹˇ cenu v chipu:
        const priceEl = bedChip.querySelector(".extrasChipPrice");
        if (priceEl) {
          if (choice === "bed") {
            priceEl.textContent = `+${formatCzk(diffBed)}`;
          } else if (choice === "bed2") {
            priceEl.textContent = `+${formatCzk(diffBed2)}`;
          } else {
            priceEl.textContent = `+${formatCzk(diffBed)} / +${formatCzk(diffBed2)}`;
          }
        }
      }

      chips.appendChild(bedChip);
    }

    const storageChip = mkChip("Úložný prostor", "storage", "storage");
    if (storageChip) chips.appendChild(storageChip);

    meta.appendChild(title);
    meta.appendChild(status);
    meta.appendChild(chips);

    card.appendChild(thumb);
    card.appendChild(meta);

    listEl.appendChild(card);
  }

  // event delegation â€“ kliknutĂ­ na chip
  listEl.onclick = (ev) => {
    const chip = ev.target.closest(".extrasChip");
    const card = ev.target.closest(".extrasCard");
    if (!card) return;

    const uuid = card.dataset.uuid;
    const rec = eligible.find(r => r?.mesh?.uuid === uuid);
    if (!rec) return;

    // klik na chip = zmÄ›na volby
    if (chip) {
      ev.stopPropagation();
      const val = chip.dataset.choice;

      // âś… Mendoza: "Rozklad" otevĹ™e vĂ˝bÄ›r bed vs bed2 (jen pokud mĂˇ bed2 povolenĂ©)
      if (val === "bed" && chip.dataset.hasBed2 === "1") {
        const diffBed  = Number(chip.dataset.diffBed || 0);
        const diffBed2 = Number(chip.dataset.diffBed2 || 0);
        openBedTypeModalForRec(rec, diffBed, diffBed2);
        return;
      }

      setExtrasChoice(rec, val === "sleep" ? "bed" : val);
      return;
    }

    // klik na kartu mimo chipy = jen zamÄ›Ĺ™enĂ­ kamery na modul
    try {
      focusCameraOnObject(rec.mesh, {
        lockToModuleFront: true,
        frontTiltY: 0.22,
        targetYOffset: 0.25,
        distanceMul: 2.25
      });
    } catch (e) {}
  };
}

function syncEquipLayout(){
  const bottomBarEl = document.getElementById("bottomBar");
  if(!bottomBarEl) return;

  const isHidden = bottomBarEl.classList.contains("is-hidden");
  const isCollapsed = bottomBarEl.classList.contains("is-collapsed");

  // KdyĹľ je bar skrytĂ˝ nebo "sbalenĂ˝", SummaryUI mĂˇ bĂ˝t dole jako ve 2. kroku
  if(isHidden || isCollapsed){
    document.documentElement.style.setProperty("--equip-raise", "0px");
    return;
  }

  const rect = bottomBarEl.getBoundingClientRect();
  const raise = Math.max(0, Math.round(rect.height + 12));
  document.documentElement.style.setProperty("--equip-raise", `${raise}px`);
}

function measureEquipRaise(){
  const bottomBarEl = document.getElementById("bottomBar");
  if(!bottomBarEl) return 0;

  // MÄ›Ĺ™ panel (ne celĂ˝ bottomBar), protoĹľe panel je to, co reĂˇlnÄ› zajĂ­ĹľdĂ­/vyjĂ­ĹľdĂ­
  const panel = bottomBarEl.querySelector(".bottomPanel");
  if(!panel) return 0;

  const r = panel.getBoundingClientRect();
  return Math.max(0, Math.round(r.height + 12));
}

function setEquipRaise(px){
  document.documentElement.style.setProperty("--equip-raise", `${px}px`);
}

let equipAnimToken = 0;

function animateEquipLayout(durationMs = 260){

  const bottomBarEl = document.getElementById("bottomBar");
  if(!bottomBarEl) return;

  const token = ++equipAnimToken;

  // vĂ˝Ĺˇka bottomBaru na zaÄŤĂˇtku animace
  const rect = bottomBarEl.getBoundingClientRect();
  const fullRaise = Math.max(0, Math.round(rect.height + 12));

  // smÄ›r animace podle toho, jestli zrovna skrĂ˝vĂˇme
  const isHiding = bottomBarEl.classList.contains("is-hiding");
  const from = isHiding ? fullRaise : 0;
  const to   = isHiding ? 0 : fullRaise;

  const start = performance.now();

  function tick(now){

    // kdyĹľ mezitĂ­m bÄ›ĹľĂ­ novĂˇ animace, ukonÄŤi tuhle
    if(token !== equipAnimToken) return;

    const t = Math.min(1, (now - start) / durationMs);
    const current = Math.round(from + (to - from) * t);

    document.documentElement.style.setProperty("--equip-raise", `${current}px`);

    if(t < 1){
      requestAnimationFrame(tick);
    } else {
      // finĂˇlnĂ­ dorovnĂˇnĂ­ podle stavu tĹ™Ă­d
      syncEquipLayout();
    }
  }

  requestAnimationFrame(tick);
}

function updateBottomBarUI() {
  const bar = document.getElementById("bottomBar");
  if (!bar) return;

  const isConfigurator =
    document.getElementById("viewConfigurator")?.classList.contains("activeView");

  const shouldShow = isConfigurator && (appState.step === 3 || appState.step === 4);

  // âś… HTML startuje s "is-hidden", takĹľe musĂ­me pĹ™epĂ­nat is-hidden (ne "hidden")
  bar.classList.remove("hidden");               // kdyby tam nÄ›kde zbyla starĂˇ tĹ™Ă­da
  bar.classList.toggle("is-hidden", !shouldShow);

  // posun summary (aby tlaÄŤĂ­tka nebyla pod barem)
  animateEquipLayout(260);

  if (!shouldShow) return;

  const isMelbourneStep4 = appState.step === 4 && getModelKey() === "MELBOURNE";
  if (appState.step === 4 && currentFabricTabKey === "paspule") {
    currentFabricTabKey = getAppliedFabricTabKey() || "cat1";
  }
  if (!isMelbourneStep4) {
    currentFabricTargetMode = "sofa";
  }

  const shelfAvailable = shouldShowMelbourneShelfTab();
  if (appState.step === 3 && currentEquipTabKey === "shelf" && !shelfAvailable) {
    currentEquipTabKey = "legs";
  }
  const hingesAvailable = shouldShowHingesTab();
  if (appState.step === 3 && currentEquipTabKey === "hinges" && !hingesAvailable) {
    currentEquipTabKey = "legs";
  }
  const extrasAvailable = shouldShowExtrasTab();
  if (appState.step === 3 && currentEquipTabKey === "extras" && !extrasAvailable) {
    currentEquipTabKey = "legs";
  }

  // zobraz jen taby pro aktuĂˇlnĂ­ krok
  document.querySelectorAll(".bottomTab").forEach((t) => {
    const step = Number(t.dataset.step || 3);   // step3 taby nemajĂ­ data-step => ber 3
    const isShelfTab = t.dataset.tab === "shelf";
    const isHingesTab = t.dataset.tab === "hinges";
    const isExtrasTab = t.dataset.tab === "extras";
    const visible =
      step === appState.step &&
      (!isShelfTab || shelfAvailable) &&
      (!isHingesTab || hingesAvailable) &&
      (!isExtrasTab || extrasAvailable);
    t.classList.toggle("hidden", !visible);
  });

  // aktivnĂ­ obsah podle kroku
  if (appState.step === 3) {
    setBottomPanelByKey(currentEquipTabKey);
    if (currentEquipTabKey === "shelf") bindShelfEquipmentUI();
  } else {
    setBottomPanelByKey(currentFabricTabKey);
    renderFabricsForTab(currentFabricTabKey);
  }
}

// ======================================================
// đź§© MODEL CONFIG â€“ krok 3 (VybavenĂ­) per model
// ======================================================

const MODEL_EQUIP_CONFIG = {

  MANILA: {
    legs: [
      { code: "N7",  label: "N7",  img: "./images/nohy/N7.png",  material: "wood" },
      { code: "N9",  label: "N9",  img: "./images/nohy/N9.png",  material: "wood" },
      { code: "N1",  label: "N1",  img: "./images/nohy/N1.png",  material: "metal" },
      { code: "N11", label: "N11", img: "./images/nohy/N11.png", material: "metal" },
    ],

    armrests: [
      { code: "smooth", label: "Kulatá", img: "./images/podrucky/Manila_kulata.png" },
      { code: "sharp",   label: "Hranatá", img: "./images/podrucky/Manila_hranata.png" },
    ],

    hinges: [
      { code: "standard", label: "Standard" },
      { code: "premium",  label: "Premium" },
    ]
  },

  MENDOZA: {
    legs: [
      { code: "N8",  label: "N8", img: "./images/nohy/N8.png", material: "metal" },
      { code: "N11", label: "N11",   img: "./images/nohy/N11.png", material: "metal" },
      { code: "N1",  label: "N1",  img: "./images/nohy/N1.png",  material: "metal" },
    ],

    armrests: [
      { code: "smooth",    label: "Hranatá",    img: "./images/podrucky/Mendoza_hranata.png" },
      { code: "sharp", label: "Polohovací", img: "./images/podrucky/Mendoza_polohovaci.png" },
    ],

    hinges: [
      { code: "hidden", label: "Skryté" }
    ]
  },

  MELBOURNE: {
    legs: [
      { code: "N9",  label: "N9",  img: "./images/nohy/N9.png",  material: "wood" },
      { code: "N21", label: "N21", img: "./images/nohy/N21.png", material: "metal" },
      { code: "N1",  label: "N1",  img: "./images/nohy/N1.png",  material: "metal" },
      { code: "N11", label: "N11", img: "./images/nohy/N11.png", material: "metal" },
    ],

    armrests: [
      { code: "smooth", label: "Melbourne", img: "./images/podrucky/Melbourne_normal.png" },
    ],

    hinges: [
      { code: "hidden", label: "Skryté" }
    ]
  },

  MANCHESTER: {
    legs: [
      { code: "N21", label: "N21", img: "./images/nohy/N21.png", material: "metal" },
      { code: "N1",  label: "N1",  img: "./images/nohy/N1.png",  material: "metal" },
      { code: "N8",  label: "N8",  img: "./images/nohy/N8.png",  material: "metal" },
      { code: "N9",  label: "N9",  img: "./images/nohy/N9.png",  material: "wood" },
      { code: "N11", label: "N11", img: "./images/nohy/N11.png", material: "metal" },
    ],

    armrests: [
      { code: "smooth", label: "Polohovací", img: "./images/podrucky/Manchester_polohovaci.png" },
      { code: "sharp",  label: "Hranatá",    img: "./images/podrucky/Manchester_hranata.png" },
    ],

    hinges: []
  },

  // dalĹˇĂ­ pohovky jen pĹ™idĂˇĹˇ sem
};

// =========================
// KROK 4 â€“ CAT1 (reĂˇlnĂˇ Clara 01â€“20) â€“ BASECOLOR = tvoje hotovĂ© obrĂˇzky
// =========================

const CLARA_NORMAL_URL =
  "/textures/fabric/1/Clara/Poliigon_FabricUpholsterySolid_9282_Normal.png";
const CLARA_ROUGHNESS_URL =
  "/textures/fabric/1/Clara/Poliigon_FabricUpholsterySolid_9282_Roughness.jpg";

// 01..20
const CLARA_CODES_01_20 = Array.from({ length: 20 }, (_, i) =>
  String(i + 1).padStart(2, "0")
);

// âś… vĹˇech 20 je dostupnĂ˝ch
const CLARA_AVAILABLE = new Set(CLARA_CODES_01_20);

// âś… tvoje hotovĂ© basecolors (01..20)
const CLARA_BASECOLOR_URL = (code2) =>
  `/textures/fabric/1/Clara/CLARA_215_${code2}.png`;

const FABRICS_CAT1 = [

  buildFabricFamilyFromFiles({
    key: "clara",
    name: "Clara",
    folder: "Clara",
    categoryFolder: "1",

    repeat: 1,
    normalScale: 1,

    normalFile: "Poliigon_FabricUpholsterySolid_9282_Normal.png",
    roughnessFile: "Poliigon_FabricUpholsterySolid_9282_Roughness.jpg",

    resolveCode: (_fileName, shadeStem) => {
      return shadeStem
        .replace(/^CLARA_/i, "")
        .replace(/_/g, ".");
    },

    info: {
      brandKey: "toptextilpetproof",
      summary: "Clara je měkká žinylková potahová látka s jemnou strukturou a lehkým leskem. Patří do základní kategorie látek a je vhodná pro běžné domácí používání.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "80 000 cyklů" },
        { label: "Gramáž", value: "340 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "80 000 cyklů" },
            { label: "Žmolkování", value: "5/5" },
            { label: "Stálost barvy v otěru", value: "4–5/5" },
            { label: "Stálost barvy na světle", value: "6/8" },
          ],
        },
      ],
    },

    shadeFiles: [
      "CLARA_215_01.png",
      "CLARA_215_02.png",
      "CLARA_215_03.png",
      "CLARA_215_04.png",
      "CLARA_215_05.png",
      "CLARA_215_06.png",
      "CLARA_215_07.png",
      "CLARA_215_08.png",
      "CLARA_215_09.png",
      "CLARA_215_10.png",
      "CLARA_215_11.png",
      "CLARA_215_12.png",
      "CLARA_215_13.png",
      "CLARA_215_14.png",
      "CLARA_215_15.png",
      "CLARA_215_16.png",
      "CLARA_215_17.png",
      "CLARA_215_18.png",
      "CLARA_215_19.png",
      "CLARA_215_20.png",
    ],

    desc: "Jemná čalounická látka s čistou strukturou a moderními odstíny.",
    care: "Doporučeno běžné šetrné čištění čalouněných látek.",
  }),

  buildFabricFamilyFromFiles({
    key: "dragon",
    name: "Dragon",
    folder: "Dragon",
    categoryFolder: "1",

    repeat: 3.5,
    normalScale: 1,

    normalFile: "BoucleBubblyMixed001_NRM_1K_METALNESS.png",
    roughnessFile: "BoucleBubblyMixed001_ROUGHNESS_1K_METALNESS.png",

    resolveCode: (_fileName, shadeStem) => {
      return shadeStem
        .replace(/^DRAGON_/i, "");
    },

    info: {
      brandKey: "toptextilpetproof",
      summary: "Dragon je výraznější pletená potahová látka s plastickou strukturou a příjemným omakem. Patří do základní kategorie látek a je vhodná pro běžné domácí používání.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "50 000 cyklů" },
        { label: "Gramáž", value: "380 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "50 000 cyklů" },
            { label: "Žmolkování", value: "5/5" },
            { label: "Stálost barvy v otěru", value: "5/5" },
            { label: "Stálost barvy na světle", value: "6–7/8" },
          ],
        },
      ],
    },

    shadeFiles: [
      "DRAGON_208.01.png",
      "DRAGON_208.02.png",
      "DRAGON_208.03.png",
      "DRAGON_208.04.png",
      "DRAGON_208.05.png",
      "DRAGON_208.06.png",
      "DRAGON_208.07.png",
      "DRAGON_208.08.png",
      "DRAGON_208.09.png",
      "DRAGON_208.10.png",
      "DRAGON_208.11.png",
      "DRAGON_208.12.png",
      "DRAGON_208.13.png",
    ],

    desc: "Měkká strukturovaná látka s výraznější boucle texturou a tlumenými moderními odstíny.",
    care: "Doporučeno běžné šetrné čištění čalouněných látek.",
  }),

  buildFabricFamilyFromFiles({
    key: "freya",
    name: "Freya",
    folder: "Freya",
    categoryFolder: "1",

    repeat: 0.5,
    normalScale: 0.7,

    normalFile: "FabricTowel001_NRM_2K.jpg",
    roughnessFile: "FabricTowel001_Roughness_FromGloss_2K.png",

    resolveCode: (_fileName, shadeStem) => {
      return shadeStem.replace(/^FREYA_/i, "");
    },

    info: {
      brandKey: "toptextilpetproof",
      summary: "Freya je lehčí pletená potahová látka s jemným vlasem a příjemným měkkým povrchem. Patří do základní kategorie látek a je vhodná pro běžné domácí používání.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "70 000 cyklů" },
        { label: "Gramáž", value: "260 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "70 000 cyklů" },
            { label: "Žmolkování", value: "5/5" },
            { label: "Stálost barvy v otěru", value: "4–5/5" },
            { label: "Stálost barvy na světle", value: "4–5/8" },
          ],
        },
      ],
    },

    shadeFiles: [
      "FREYA_210.01.png",
      "FREYA_210.02.png",
      "FREYA_210.03.png",
      "FREYA_210.04.png",
      "FREYA_210.05.png",
      "FREYA_210.06.png",
      "FREYA_210.07.png",
      "FREYA_210.08.png",
      "FREYA_210.09.png",
      "FREYA_210.10.png",

      "FREYA_210.11.png",
      "FREYA_210.12.png",
      "FREYA_210.13.png",
      "FREYA_210.14.png",
      "FREYA_210.15.png",
      "FREYA_210.16.png",
      "FREYA_210.17.png",
      "FREYA_210.18.png",
      "FREYA_210.19.png",
      "FREYA_210.20.png",

      "FREYA_210.21.png",
      "FREYA_210.22.png",
      "FREYA_210.23.png",
      "FREYA_210.24.png",
      "FREYA_210.25.png",
      "FREYA_210.26.png",
      "FREYA_210.27.png",
      "FREYA_210.28.png",
      "FREYA_210.29.png",
      "FREYA_210.30.png",

      "FREYA_210.31.png",
      "FREYA_210.32.png",
    ],

    desc: "Jemná textilní látka s čistým povrchem a širokou škálou neutrálních i barevných odstínů.",
    care: "Doporučeno běžné šetrné čištění čalouněných látek.",
  }),

  buildFabricFamilyFromFiles({
    key: "rugia",
    name: "Rugia",
    folder: "Rugia",
    categoryFolder: "1",

    repeat: 2,
    normalScale: 1,

    normalFile: "FabricLinenUpholstery012_NRM_2K_METALNESS.png",
    roughnessFile: "FabricLinenUpholstery012_ROUGHNESS_2K_METALNESS.png",

    resolveCode: (_fileName, shadeStem) => {
      return shadeStem.replace(/^RUGIA_/i, "");
    },

    info: {
      brandKey: "toptextilwaterrepellent",
      summary: "Rugia je jemnější žinylková potahová látka s měkkým povrchem a příjemným omakem. Patří do základní kategorie látek a je vhodná pro běžné domácí používání.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "80 000 cyklů" },
        { label: "Gramáž", value: "250 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "80 000 cyklů" },
            { label: "Žmolkování", value: "4–5/5" },
            { label: "Stálost barvy v otěru", value: "4/5" },
            { label: "Stálost barvy na světle", value: "5/8" },
          ],
        },
      ],
    },

    shadeFiles: [
      "RUGIA_218.01.png",
      "RUGIA_218.02.png",
      "RUGIA_218.03.png",
      "RUGIA_218.04.png",
      "RUGIA_218.05.png",
      "RUGIA_218.06.png",
      "RUGIA_218.07.png",
      "RUGIA_218.08.png",
      "RUGIA_218.09.png",
      "RUGIA_218.10.png",

      "RUGIA_218.11.png",
      "RUGIA_218.12.png",
      "RUGIA_218.13.png",
      "RUGIA_218.14.png",
      "RUGIA_218.15.png",
      "RUGIA_218.16.png",
      "RUGIA_218.17.png",
      "RUGIA_218.18.png",
      "RUGIA_218.19.png",
      "RUGIA_218.20.png",

      "RUGIA_218.21.png",
    ],

    desc: "Tkaná čalounická látka s jemnou lněnou strukturou a elegantními přírodními odstíny.",
    care: "Doporučeno běžné šetrné čištění čalouněných látek.",
  }),

  buildFabricFamilyFromFiles({
    key: "smartvelvet",
    name: "Smart Velvet",
    folder: "Smart-velvet",
    categoryFolder: "1",

    repeat: 2,
    normalScale: 1,

    normalFile: "FabricVelourPlain002_NRM_2K_METALNESS.png",
    roughnessFile: "FabricVelourPlain002_ROUGHNESS_2K_METALNESS.png",

    resolveCode: (_fileName, shadeStem) => {
      return shadeStem.replace(/^SMART_VELVET_/i, "");
    },

    info: {
      brandKey: "toptextilpetproof",
      summary: "Smart Velvet je hladší sametová potahová látka s matným vzhledem a rovnoměrným odstínem. Patří do základní kategorie látek a je vhodná pro běžné domácí používání.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "60 000 cyklů" },
        { label: "Gramáž", value: "240 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "60 000 cyklů" },
            { label: "Žmolkování", value: "4–5/5" },
            { label: "Stálost barvy v otěru", value: "4–5/5" },
            { label: "Stálost barvy na světle", value: "4–5/8" },
          ],
        },
      ],
    },

    shadeFiles: [
      "SMART_VELVET_216.01.png",
      "SMART_VELVET_216.02.png",
      "SMART_VELVET_216.03.png",
      "SMART_VELVET_216.04.png",
      "SMART_VELVET_216.05.png",
      "SMART_VELVET_216.06.png",
      "SMART_VELVET_216.07.png",
      "SMART_VELVET_216.08.png",
      "SMART_VELVET_216.09.png",
      "SMART_VELVET_216.10.png",

      "SMART_VELVET_216.11.png",
      "SMART_VELVET_216.12.png",
      "SMART_VELVET_216.13.png",
      "SMART_VELVET_216.14.png",
      "SMART_VELVET_216.15.png",
      "SMART_VELVET_216.16.png",
      "SMART_VELVET_216.17.png",
      "SMART_VELVET_216.18.png",
      "SMART_VELVET_216.19.png",
      "SMART_VELVET_216.20.png",

      "SMART_VELVET_216.21.png",
      "SMART_VELVET_216.22.png",
      "SMART_VELVET_216.23.png",
      "SMART_VELVET_216.24.png",
      "SMART_VELVET_216.25.png",
      "SMART_VELVET_216.26.png",
      "SMART_VELVET_216.27.png",
      "SMART_VELVET_216.28.png",
      "SMART_VELVET_216.29.png",
      "SMART_VELVET_216.30.png",

      "SMART_VELVET_216.31.png",
      "SMART_VELVET_216.32.png",
      "SMART_VELVET_216.33.png",
      "SMART_VELVET_216.34.png",
      "SMART_VELVET_216.35.png",
      "SMART_VELVET_216.36.png",
      "SMART_VELVET_216.37.png",
      "SMART_VELVET_216.38.png",
      "SMART_VELVET_216.39.png",
      "SMART_VELVET_216.40.png",

      "SMART_VELVET_216.41.png",
      "SMART_VELVET_216.42.png",
      "SMART_VELVET_216.43.png",
      "SMART_VELVET_216.44.png",
    ],

    desc: "Jemná velurová látka s elegantním sametovým vzhledem.",
    care: "Doporučeno běžné šetrné čištění čalouněných látek.",
  }),
];

let selectedFabricCat1 = null;
let selectedFabricCat2 = null;
let selectedFabricCat3 = null;
let selectedFabricLeather = null;
let selectedPaspuleFabric = null;

function resetFabricSelectionState({ save = true } = {}) {
  selectedFabricCat1 = null;
  selectedFabricCat2 = null;
  selectedFabricCat3 = null;
  selectedFabricLeather = null;
  selectedPaspuleFabric = null;

  appliedFabricPriceGroup = "g1";
  currentFabricTabKey = "cat1";
  currentFabricTargetMode = "sofa";

  activeFabricFamilyByTab = {
    cat1: null,
    cat2: null,
    cat3: null,
    leather: null,
    paspule: null,
  };

  try { renderedFabricTabs?.clear?.(); } catch (e) {}

  document
    .querySelectorAll(
      "#bottomBar .fabricShadeBtn.is-active, #bottomBar .fabricFamilyTab.is-active"
    )
    .forEach((el) => el.classList.remove("is-active"));

  document
    .querySelectorAll("#bottomBar .hasFabricSelectionHint")
    .forEach((el) => {
      el.classList.remove("hasFabricSelectionHint");
      el.dataset.selectionHint = "";
    });

  try { updateFabricSelectionIndicators?.(); } catch (e) {}
  try { updateStep4ContinueUI?.(); } catch (e) {}

  if (save) saveStateDebounced?.(50);
}

function derivePerShadeMapFile(fileName, mapKind) {
  const clean = String(fileName || "").trim();
  if (!clean) return clean;
  return clean.replace(/_basecolor(?=\.[a-z0-9]+$)/i, `_${mapKind}`);
}

function buildFabricFamilyFromFiles({
  key,
  name,
  folder,
  categoryFolder = "2",
  basePathOverride = null,
  normalFile,
  roughnessFile,
  shadeFiles,
  resolveNormalFile = null,
  resolveRoughnessFile = null,
  resolveCode = null,
  repeat = 3,
  normalScale = 0.18,
  desc = "Potahová látka pro každodenní použití.",
  care = "Běžná údržba, vysávání.",
  specs = {},
  info = null
}) {
  const basePath = assetUrl(basePathOverride || `/textures/fabric/${categoryFolder}/${folder}`);
  const shades = (shadeFiles || []).map((fileName) => {
    const clean = String(fileName || "").trim();
    const extMatch = clean.match(/\.([a-z0-9]+)$/i);
    const withoutExt = extMatch ? clean.slice(0, -(extMatch[0].length)) : clean;
    const shadeStem = withoutExt.replace(/_(basecolor|normal|roughness)$/i, "");
    const codeMatch = shadeStem.match(/[_ -]([0-9]+[a-zA-Z]?)$/);
    const code2 = resolveCode
      ? resolveCode(clean, shadeStem)
      : (codeMatch ? codeMatch[1] : shadeStem);

    return {
      code2,
      available: true,
      baseColorUrl: `${basePath}/${clean}`,
      normalUrl: `${basePath}/${resolveNormalFile ? resolveNormalFile(clean) : normalFile}`,
      roughnessUrl: `${basePath}/${resolveRoughnessFile ? resolveRoughnessFile(clean) : roughnessFile}`,
    };
  });

  return {
    key,
    name,
    desc,
    care,
    // Tohle je hlavní místo pro ruční ladění každé látky:
    // repeat = kolikrát se textura opakuje přes UV modelu
    // normalScale = síla normal mapy
    repeat,
    normalScale,
    specs,
    info,
    shades,
  };
}

const FABRIC_BRAND_INFO = {
  aquaclean: {
    label: "Aquaclean",
    maintenanceValue: "čištění čistou vodou",
    summary: "Technologie Aquaclean umožňuje čistit většinu běžných skvrn pouze čistou vodou, bez mýdla nebo čisticích prostředků.",
    careSection: {
      title: "Péče a údržba",
      text: "Pro běžnou údržbu doporučujeme pravidelně vysávat celý povrch pohovky měkkým kartáčovým nástavcem. Při čištění skvrn stačí čistá voda a navlhčený hadřík.",
      items: [
        "Nejprve odstraňte z čalounění přebytečné zbytky nebo tekutinu.",
        "Naneste čistou vodu přímo na skvrnu nebo použijte navlhčený hadřík.",
        "Nechte vodu několik vteřin působit.",
        "Jemně otírejte krouživými pohyby a podle potřeby postup opakujte.",
        "Po vyčištění nechte látku volně uschnout.",
        "U zaschlých nebo odolnějších skvrn může být potřeba čištění zopakovat.",
      ],
    },
  },
  froca: {
    label: "Froca",
    maintenanceValue: "čištění vodou (H2Oh!)",
    summary: "Úprava H2Oh! od značky Froca usnadňuje běžnou údržbu a čištění vodou.",
    careSection: {
      title: "Péče a údržba",
      text: "Pro běžnou údržbu doporučujeme látku pravidelně vysávat měkkým kartáčovým nástavcem. Menší skvrny čistěte co nejdříve čistou vodou a měkkým hadříkem.",
      items: [
        "Nejprve odstraňte přebytečnou tekutinu nebo pevné zbytky.",
        "Navlhčete čistý hadřík vodou a jemně čistěte zasažené místo.",
        "Netřete látku agresivně a nepoužívejte bělidla.",
        "Po vyčištění nechte látku volně uschnout.",
        "Nevystavujte mokrou látku přímému slunci.",
      ],
    },
  },
  fargotexwaterrepellent: {
    label: "Fargotex",
    maintenanceValue: "ztížené vstřebávání tekutin",
    summary: "Vybrané látky Fargotex mají praktickou úpravu, která zpomaluje vsakování rozlitých tekutin do struktury látky.",
    careSection: {
      title: "Péče a údržba",
      text: "Tekutinu doporučujeme co nejdříve jemně odsát savým hadříkem. Povrch pravidelně vysávejte měkkým kartáčovým nástavcem.",
      items: [
        "Rozlitou tekutinu nejdříve jemně odsajte, netřete ji do látky.",
        "Menší nečistoty čistěte vlhkým hadříkem z mikrovlákna.",
        "Nepoužívejte bělidla ani agresivní chemické čističe.",
        "Po čištění nechte látku volně proschnout.",
      ],
    },
  },

  fargotexpetfriendly: {
    label: "Fargotex",
    maintenanceValue: "vhodné pro domácnosti s mazlíčky",
    summary: "Vybrané látky Fargotex jsou navržené pro domácnosti se zvířaty a mají zvýšenou odolnost proti zatržení vláken.",
    careSection: {
      title: "Péče a údržba",
      text: "Povrch pravidelně vysávejte nebo čistěte měkkým kartáčem. Chlupy a běžné nečistoty odstraňujte šetrně, bez agresivního tření.",
      items: [
        "Pravidelně odstraňujte chlupy měkkým kartáčem nebo vysavačem.",
        "Skvrny čistěte co nejdříve vlhkým hadříkem z mikrovlákna.",
        "Netřete látku silou, aby se nenarušila struktura vláken.",
        "Nepoužívejte bělidla ani silné chemické čističe.",
      ],
    },
  },
  toptextilpetproof: {
    label: "Toptextil",
    maintenanceValue: "základní úprava pro domácnosti s mazlíčky",
    summary: "Vybrané látky Toptextil s úpravou Pet Proof jsou praktickou volbou pro běžné domácí použití se zvířaty. Pomáhají omezit zatrhávání vláken a usnadňují odstraňování chlupů z povrchu látky.",
    careSection: {
      title: "Péče a údržba",
      text: "Povrch pravidelně vysávejte nebo čistěte měkkým kartáčem. Chlupy odstraňujte válečkem na textil nebo lehce vlhkým hadříkem.",
      items: [
        "Pravidelně odstraňujte chlupy válečkem, měkkým kartáčem nebo vysavačem.",
        "Menší nečistoty čistěte vlhkým hadříkem z mikrovlákna.",
        "Netřete látku silou, aby se nenarušila struktura vláken.",
        "Nepoužívejte bělidla ani agresivní chemické čističe.",
      ],
    },
  },
  toptextilwaterrepellent: {
    label: "Toptextil",
    maintenanceValue: "základní ochrana proti rychlému vsakování tekutin",
    summary: "Vybrané látky Toptextil s úpravou Water Repellent pomáhají zpomalit vsakování drobně rozlitých tekutin. Jde o praktickou každodenní úpravu.",
    careSection: {
      title: "Péče a údržba",
      text: "Rozlitou tekutinu doporučujeme co nejdříve jemně odsát savým hadříkem nebo papírovou utěrkou. Povrch pravidelně vysávejte měkkým nástavcem.",
      items: [
        "Rozlitou tekutinu nejdříve jemně odsajte, netřete ji do látky.",
        "Menší nečistoty čistěte vlhkým hadříkem z mikrovlákna.",
        "Nepoužívejte bělidla ani agresivní chemické čističe.",
        "Po čištění nechte látku volně proschnout.",
      ],
    },
  },
};

function normalizeFabricInfoLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getFabricBrandInfo(brandKey) {
  const key = String(brandKey || "").trim().toLowerCase();
  return key ? FABRIC_BRAND_INFO[key] || null : null;
}

function resolveFabricInfoForDisplay(fabric) {
  const info = fabric?.info;
  if (!info) return null;

  const brand = getFabricBrandInfo(info.brandKey || info.brand);
  const stats = [];

  if (brand?.label) {
    stats.push({ label: "Značka", value: brand.label });
  }

  const hiddenBrandLabels = new Set();
  if (brand?.label) hiddenBrandLabels.add("znacka");
  if (brand?.maintenanceValue) hiddenBrandLabels.add("udrzba");

  (info.stats || []).forEach((row) => {
    const labelKey = normalizeFabricInfoLabel(row?.label);
    if (hiddenBrandLabels.has(labelKey)) return;
    stats.push(row);
  });

  if (brand?.maintenanceValue) {
    stats.push({ label: "Údržba", value: brand.maintenanceValue });
  }

  const sections = (info.sections || []).filter((section) => {
    if (!brand?.careSection) return true;
    return normalizeFabricInfoLabel(section?.title) !== "pece a udrzba";
  });

  if (brand?.careSection) {
    sections.push(brand.careSection);
  }

  const summary = [info.summary, brand?.summary]
    .filter(Boolean)
    .join(" ");

  return {
    ...info,
    summary,
    stats,
    sections,
  };
}

const FABRICS_CAT2 = [
  buildFabricFamilyFromFiles({
    key: "golden",
    name: "Golden",
    folder: "",
    categoryFolder: "2",
    basePathOverride: "/textures/fabric/2/Golden",
    repeat: 2,
    normalScale: 1,
    normalFile: "FabricLinenUpholstery018_NRM_2K_METALNESS.png",
    roughnessFile: "FabricLinenUpholstery018_ROUGHNESS_2K_METALNESS.png",
    resolveCode: (_fileName, shadeStem) => {
      const pretty = shadeStem.replace(/^GOLDEN_/i, "").replace(/_/g, " ").trim();
      return pretty;
    },
    info: {
      brandKey: "fargotexWaterRepellent",
      summary: "Golden je měkká žinylková potahová látka s jemným elegantním leskem, výraznější texturou a sametovým dojmem. Díky technologiím Easy Clean a Water Repellent je vhodná pro moderní interiéry i každodenně používaný čalouněný nábytek.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "> 110 000 cyklů" },
        { label: "Gramáž", value: "400 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "> 110 000 cyklů" },
            { label: "Žmolkování", value: "5/5" },
            { label: "Stálost barvy v otěru", value: "za sucha 4–5/5, za mokra 4/5" },
            { label: "Stálost barvy na světle", value: "5/5" },
          ],
        },
      ],
    },
    shadeFiles: [
      "GOLDEN_01.png",
      "GOLDEN_04.png",
      "GOLDEN_21.png",
      "GOLDEN_24.png",
      "GOLDEN_25.png",
      "GOLDEN_26.png",
      "GOLDEN_29.png",
      "GOLDEN_31.png",
      "GOLDEN_34.png",
      "GOLDEN_35.png",
      "GOLDEN_46.png",
      "GOLDEN_50.png",
      "GOLDEN_55.png",
      "GOLDEN_56.png",
      "GOLDEN_63.png",
      "GOLDEN_68.png",
      "GOLDEN_72.png",
      "GOLDEN_79.png",
      "GOLDEN_97.png",
      "GOLDEN_100.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "milton-new",
    name: "Milton New",
    folder: "",
    categoryFolder: "2",
    basePathOverride: "/textures/fabric/2/Milton-new",
    repeat: 1.5,
    normalScale: 0.8,
    normalFile: "FabricPlainBlackChenille001_NRM_2K.png",
    roughnessFile: "FabricPlainBlackChenille001_Roughness_FromGloss_2K.png",
    resolveCode: (_fileName, shadeStem) => {
      const pretty = shadeStem.replace(/^MILTON_NEW_/i, "").replace(/_/g, " ").trim();
      return pretty;
    },
    info: {
      brandKey: "fargotexWaterRepellent",
      summary: "Milton New je pletená potahová látka s moderní opalizující strukturou. Díky úpravě se ztíženým vstřebáváním tekutin je vhodná pro každodenně používaný čalouněný nábytek.",
      stats: [
        { label: "Složení", value: ["97% polyester", "3% nylon"] },
        { label: "Odolnost", value: "90 000 cyklů" },
        { label: "Gramáž", value: "300 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "90 000 cyklů" },
            { label: "Žmolkování", value: "5/5" },
            { label: "Stálost barvy v otěru", value: "4–5/5" },
            { label: "Stálost barvy na světle", value: "4/5" },
          ],
        },
      ],
    },
    shadeFiles: [
      "MILTON_NEW_01.png",
      "MILTON_NEW_02.png",
      "MILTON_NEW_03.png",
      "MILTON_NEW_04.png",
      "MILTON_NEW_06.png",
      "MILTON_NEW_11.png",
      "MILTON_NEW_13.png",
      "MILTON_NEW_14.png",
      "MILTON_NEW_15.png",
      "MILTON_NEW_16.png",
      "MILTON_NEW_17.png",
      "MILTON_NEW_18.png",
      "MILTON_NEW_19.png",
      "MILTON_NEW_20.png",
      "MILTON_NEW_21.png",
      "MILTON_NEW_22.png",
      "MILTON_NEW_23.png",
      "MILTON_NEW_24.png",
      "MILTON_NEW_25.png",
      "MILTON_NEW_26.png",
      "MILTON_NEW_27.png",
      "MILTON_NEW_28.png",
      "MILTON_NEW_29.png",
      "MILTON_NEW_30.png",
      "MILTON_NEW_31.png",
      "MILTON_NEW_32.png",
      "MILTON_NEW_33.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "zoya",
    name: "Zoya",
    folder: "",
    categoryFolder: "2",
    basePathOverride: "/textures/fabric/2/Zoya",
    repeat: 0.5,
    normalScale: 1,
    normalFile: "FabricSuedePatchy001_NRM_2K.jpg",
    roughnessFile: "FabricSuedePatchy001_Roughness_FromGloss_2K.png",
    resolveCode: (_fileName, shadeStem) => {
      const pretty = shadeStem.replace(/^ZOYA_/i, "").replace(/_/g, " ").trim();
      return pretty;
    },
    info: {
      brandKey: "fargotexPetFriendly",
      summary: "Zoya je měkká pletená potahová látka s netradičním mramorovaným stínováním. Díky vlastnostem vhodným pro domácnosti s mazlíčky se hodí pro každodenně používaný nábytek.",
      stats: [
        { label: "Složení", value: "100% polyester" },
        { label: "Odolnost", value: "50 000 cyklů" },
        { label: "Gramáž", value: "390 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "50 000 cyklů" },
            { label: "Žmolkování", value: "4/5" },
            { label: "Stálost barvy v otěru", value: "4/5" },
            { label: "Stálost barvy na světle", value: "4/5" },
          ],
        },
      ],
    },
    shadeFiles: [
      "ZOYA_01.png",
      "ZOYA_02.png",
      "ZOYA_03.png",
      "ZOYA_04.png",
      "ZOYA_05.png",
      "ZOYA_06.png",
      "ZOYA_07.png",
      "ZOYA_08.png",
      "ZOYA_09.png",
      "ZOYA_10.png",
      "ZOYA_11.png",
      "ZOYA_12.png",
      "ZOYA_13.png",
      "ZOYA_14.png",
      "ZOYA_15.png",
    ],
  }),
];

const FABRICS_CAT3 = [
  buildFabricFamilyFromFiles({
    key: "mystic",
    name: "Mystic",
    folder: "mystic",
    categoryFolder: "3",
    repeat: 1,
    normalScale: 1,
    normalFile: "FabricDenim005_NRM16_1K_METALNESS.png",
    roughnessFile: "FabricDenim005_ROUGHNESS_1K_METALNESS.png",
    info: {
      brandKey: "aquaclean",
      summary: "Mystic je jemná 100% polyesterová potahová látka s měkkým, příjemným povrchem a velmi vysokou odolností pro každodenní používání.",
      stats: [
        { label: "Složení", value: "100% PES" },
        { label: "Odolnost", value: "> 200 000 cyklů" },
        { label: "Gramáž", value: "450 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "> 200 000 cyklů" },
            { label: "Žmolkování", value: "5/5, bez žmolkování" },
            { label: "Stálost barvy v otěru", value: "4–5, dobrá" },
            { label: "Stálost barvy na světle", value: "4–5, dobrá" },
          ],
        },
      ],
    },
    shadeFiles: [
      "MYSTIC_01.png",
      "MYSTIC_03.png",
      "MYSTIC_05.png",
      "MYSTIC_07.png",
      "MYSTIC_08.png",
      "MYSTIC_100.png",
      "MYSTIC_104.png",
      "MYSTIC_105.png",
      "MYSTIC_11.png",
      "MYSTIC_112.png",
      "MYSTIC_114.png",
      "MYSTIC_12.png",
      "MYSTIC_13.png",
      "MYSTIC_131.png",
      "MYSTIC_136.png",
      "MYSTIC_144.png",
      "MYSTIC_15.png",
      "MYSTIC_161.png",
      "MYSTIC_165.png",
      "MYSTIC_176.png",
      "MYSTIC_177.png",
      "MYSTIC_18.png",
      "MYSTIC_187.png",
      "MYSTIC_190.png",
      "MYSTIC_21.png",
      "MYSTIC_213.png",
      "MYSTIC_214.png",
      "MYSTIC_244.png",
      "MYSTIC_248.png",
      "MYSTIC_250.png",
      "MYSTIC_252.png",
      "MYSTIC_311.png",
      "MYSTIC_313.png",
      "MYSTIC_32.png",
      "MYSTIC_320.png",
      "MYSTIC_324.png",
      "MYSTIC_373.png",
      "MYSTIC_38.png",
      "MYSTIC_387.png",
      "MYSTIC_395.png",
      "MYSTIC_50.png",
      "MYSTIC_503.png",
      "MYSTIC_51.png",
      "MYSTIC_510.png",
      "MYSTIC_514.png",
      "MYSTIC_52.png",
      "MYSTIC_523.png",
      "MYSTIC_525.png",
      "MYSTIC_526.png",
      "MYSTIC_528.png",
      "MYSTIC_537.png",
      "MYSTIC_545.png",
      "MYSTIC_546.png",
      "MYSTIC_549.png",
      "MYSTIC_551.png",
      "MYSTIC_553.png",
      "MYSTIC_556.png",
      "MYSTIC_559.png",
      "MYSTIC_56.png",
      "MYSTIC_59.png",
      "MYSTIC_602.png",
      "MYSTIC_603.png",
      "MYSTIC_61.png",
      "MYSTIC_62.png",
      "MYSTIC_64.png",
      "MYSTIC_65.png",
      "MYSTIC_66.png",
      "MYSTIC_68.png",
      "MYSTIC_69.png",
      "MYSTIC_73.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "daytona",
    name: "Daytona",
    folder: "daytona",
    categoryFolder: "3",
    repeat: 2,
    normalScale: 1,
    normalFile: "Poliigon_FabricUpholsterySolid_9303_Normal.png",
    roughnessFile: "Poliigon_FabricUpholsterySolid_9303_Roughness.jpg",
    info: {
      brandKey: "aquaclean",
      summary: "Daytona je praktická a odolná potahová látka s textilním základem z polyesteru a recyklované bavlny, vhodná pro intenzivní každodenní používání.",
      stats: [
        { label: "Složení", value: ["70% PES", "30% recyklovaný materiál"] },
        { label: "Odolnost", value: "> 200 000 cyklů" },
        { label: "Gramáž", value: "410 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "> 200 000 cyklů" },
            { label: "Žmolkování", value: "5/5, bez žmolkování" },
            { label: "Stálost barvy v otěru", value: "4/5, dobrá" },
            { label: "Stálost barvy na světle", value: "4/5, dobrá" },
          ],
        },
      ],
    },
    shadeFiles: [
      "DAYTONA_HP_49.png",
      "DAYTONA_HP_60.png",
      "DAYTONA_HP_72.png",
      "DAYTONA_HP_76.png",
      "DAYTONA_HP_77.png",
      "DAYTONA_HP_78.png",
      "DAYTONA_HP_80.png",
      "DAYTONA_HP_81.png",
      "DAYTONA_HP_86.png",
      "DAYTONA_HP_91.png",
      "DAYTONA_HP_98.png",
      "DAYTONA_HP_102.png",
      "DAYTONA_HP_108.png",
      "DAYTONA_HP_109.png",
      "DAYTONA_HP_110.png",
      "DAYTONA_HP_131.png",
      "DAYTONA_HP_137.png",
      "DAYTONA_HP_138.png",
      "DAYTONA_HP_139.png",
      "DAYTONA_HP_142.png",
      "DAYTONA_HP_145.png",
      "DAYTONA_HP_146.png",
      "DAYTONA_HP_151.png",
      "DAYTONA_HP_152.png",
      "DAYTONA_HP_153.png",
      "DAYTONA_HP_155.png",
      "DAYTONA_HP_156.png",
      "DAYTONA_HP_157.png",
      "DAYTONA_HP_158.png",
      "DAYTONA_HP_163.png",
      "DAYTONA_HP_164.png",
      "DAYTONA_HP_165.png",
      "DAYTONA_HP_183.png",
      "DAYTONA_HP_184.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "zeus",
    name: "Zeus",
    folder: "Zeus",
    categoryFolder: "3",
    repeat: 1,
    normalScale: 1,
    normalFile: "FabricVelourPlain002_NRM_2K_METALNESS.png",
    roughnessFile: "FabricVelourPlain002_ROUGHNESS_2K_METALNESS.png",
    info: {
      brandKey: "froca",
      summary: "Zeus je potahová látka s příjemným omakem a elegantní strukturou, dostupná v široké paletě odstínů.",
      stats: [
        { label: "Složení", value: "100% PES" },
        { label: "Odolnost", value: "> 66 000 cyklů" },
        { label: "Gramáž", value: "400 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "> 66 000 cyklů" },
            { label: "Žmolkování", value: "4/5" },
            { label: "Stálost barvy na světle", value: "4/8" },
            { label: "Stálost při suchém čištění", value: "4–5/5" },
            { label: "Stálost při praní/čištění", value: "4–5/5" },
          ],
        },
      ],
    },
    shadeFiles: [
      "ZEUS_01.png",
      "ZEUS_02.png",
      "ZEUS_03.png",
      "ZEUS_04.png",
      "ZEUS_05.png",
      "ZEUS_06.png",
      "ZEUS_07.png",
      "ZEUS_08.png",
      "ZEUS_09.png",
      "ZEUS_10.png",
      "ZEUS_11.png",
      "ZEUS_12.png",
      "ZEUS_13.png",
      "ZEUS_14.png",
      "ZEUS_15.png",
      "ZEUS_16.png",
      "ZEUS_17.png",
      "ZEUS_18.png",
      "ZEUS_19.png",
      "ZEUS_20.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "venice",
    name: "Venice",
    folder: "Venice",
    categoryFolder: "3",
    repeat: 2.4,
    normalScale: 0.6,
    normalFile: "BoucleChunky001_NRM_1K_METALNESS.png",
    roughnessFile: "BoucleChunky001_ROUGHNESS_1K_METALNESS.png",
    info: {
      brandKey: "aquaclean",
      summary: "Venice je výrazně strukturovaná potahová látka s plastickým povrchem a příjemně textilním omakem.",
      stats: [
        {
          label: "Složení",
          value: [
            "71% polyester",
            "18% modakryl",
            "8% recyklovaná bavlna",
            "3% polyamid",
          ],
        },
        { label: "Odolnost", value: "60 000 cyklů" },
        { label: "Gramáž", value: "565 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Šířka", value: "140 cm" },
            { label: "Odolnost proti oděru", value: "60 000 cyklů" },
            { label: "Žmolkování", value: "5/5, bez žmolkování" },
            { label: "Stálost barvy v otěru", value: "4–5/5, dobrá" },
            { label: "Stálost barvy na světle", value: "4–5/8, dobrá" },
          ],
        },
      ],
    },
    shadeFiles: [
      "VENICE_01.png",
      "VENICE_07.png",
      "VENICE_08.png",
      "VENICE_11.png",
      "VENICE_111.png",
      "VENICE_13.png",
      "VENICE_131.png",
      "VENICE_15.png",
      "VENICE_156.png",
      "VENICE_213.png",
      "VENICE_214.png",
      "VENICE_250.png",
      "VENICE_266.png",
      "VENICE_27.png",
      "VENICE_271.png",
      "VENICE_29.png",
      "VENICE_300.png",
      "VENICE_324.png",
      "VENICE_336.png",
      "VENICE_339.png",
      "VENICE_349.png",
      "VENICE_43.png",
      "VENICE_458.png",
      "VENICE_46.png",
      "VENICE_50.png",
      "VENICE_510.png",
      "VENICE_514.png",
      "VENICE_53.png",
      "VENICE_60.png",
      "VENICE_602.png",
      "VENICE_61.png",
      "VENICE_618.png",
      "VENICE_62.png",
      "VENICE_625.png",
      "VENICE_667.png",
      "VENICE_69.png",
      "VENICE_80.png",
      "VENICE_91.png",
      "VENICE_93.png",
      "VENICE_94.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "bellagio",
    name: "Bellagio",
    folder: "Bellagio-ac",
    categoryFolder: "3",
    repeat: 0.7,
    normalScale: 1,
    normalFile: "FabricVelvet009_NRM_1K_METALNESS.png",
    roughnessFile: "FabricVelvet009_ROUGHNESS_1K_METALNESS.png",
    info: {
      brandKey: "aquaclean",
      summary: "Bellagio je elegantní 100% polyesterová potahová látka s jemnějším, hladším povrchem a vysokou odolností proti oděru.",
      stats: [
        { label: "Složení", value: "100% PES" },
        { label: "Odolnost", value: "> 100 000 cyklů" },
        { label: "Gramáž", value: "404 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "> 100 000 cyklů" },
            { label: "Žmolkování", value: "5/5, bez žmolkování" },
            { label: "Stálost barvy v otěru", value: "5/5, dobrá" },
            { label: "Stálost barvy na světle", value: "5/8, dobrá" },
          ],
        },
      ],
    },
    shadeFiles: [
      "BELLAGIO_01.png",
      "BELLAGIO_08.png",
      "BELLAGIO_105.png",
      "BELLAGIO_11.png",
      "BELLAGIO_13.png",
      "BELLAGIO_131.png",
      "BELLAGIO_14.png",
      "BELLAGIO_156.png",
      "BELLAGIO_213.png",
      "BELLAGIO_242.png",
      "BELLAGIO_245.png",
      "BELLAGIO_248.png",
      "BELLAGIO_271.png",
      "BELLAGIO_28.png",
      "BELLAGIO_300.png",
      "BELLAGIO_321.png",
      "BELLAGIO_324.png",
      "BELLAGIO_355.png",
      "BELLAGIO_451.png",
      "BELLAGIO_50.png",
      "BELLAGIO_503.png",
      "BELLAGIO_514.png",
      "BELLAGIO_515.png",
      "BELLAGIO_59.png",
      "BELLAGIO_62.png",
      "BELLAGIO_65.png",
      "BELLAGIO_68.png",
      "BELLAGIO_80.png",
      "BELLAGIO_81.png",
      "BELLAGIO_82.png",
    ],
  }),
  buildFabricFamilyFromFiles({
    key: "amaral",
    name: "Amaral",
    folder: "Amaral-ac",
    categoryFolder: "3",
    repeat: 2,
    normalScale: 1,
    normalFile: "FabricPlainGrey020_NRM_2K.png",
    roughnessFile: "FabricPlainGrey020_Roughness_FromGloss_2K.png",
    info: {
      brandKey: "aquaclean",
      summary: "Amaral je kompaktní potahová látka s podílem recyklované bavlny, stabilním povrchem a dobrou odolností pro běžné používání.",
      stats: [
        {
          label: "Složení",
          value: [
            "96% PES",
            "3% recyklovaná bavlna",
            "1% ostatní vlákna",
          ],
        },
        { label: "Odolnost", value: "60 000 cyklů" },
        { label: "Gramáž", value: "551 g/m²" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Odolnost proti oděru", value: "60 000 cyklů" },
            { label: "Žmolkování", value: "5/5, bez žmolkování" },
            { label: "Stálost barvy v otěru", value: "5/5, dobrá" },
            { label: "Stálost barvy na světle", value: "5/8, dobrá" },
          ],
        },
      ],
    },
    shadeFiles: [
      "AMARAL_10.png",
      "AMARAL_1300.png",
      "AMARAL_1605.png",
      "AMARAL_248.png",
      "AMARAL_271.png",
      "AMARAL_300.png",
      "AMARAL_305.png",
      "AMARAL_32.png",
      "AMARAL_325.png",
      "AMARAL_336.png",
      "AMARAL_347.png",
      "AMARAL_349.png",
      "AMARAL_395.png",
      "AMARAL_51.png",
      "AMARAL_56.png",
      "AMARAL_60.png",
      "AMARAL_602.png",
      "AMARAL_603.png",
      "AMARAL_604.png",
      "AMARAL_608.png",
      "AMARAL_613.png",
      "AMARAL_615.png",
      "AMARAL_617.png",
      "AMARAL_620.png",
      "AMARAL_790.png",
      "AMARAL_90.png",
    ],
  }),
];

const FABRICS_LEATHER = [
  buildFabricFamilyFromFiles({
    key: "florida",
    name: "Florida",
    folder: "",
    categoryFolder: "leather",
    basePathOverride: "/textures/fabric/leather",

    repeat: 0.3,
    normalScale: 1,

    normalFile: "FabricLeatherCowhide001_NRM_2K.jpg",
    roughnessFile: "FabricLeatherCowhide001_Roughness_FromGloss_2K.png",

    resolveCode: (_fileName, shadeStem) => {
      const pretty = shadeStem
        .replace(/^FLORIDA_/i, "")
        .replace(/_/g, " ")
        .trim();

      return pretty
        .toLowerCase()
        .replace(/\b\w/g, (m) => m.toUpperCase());
    },

    info: {
      brand: "Elastron",
      summary: "Florida je pravá čalounická kůže s přirozenou strukturou, pevnějším omakem a elegantním vzhledem. Díky tloušťce 0,8–1,0 mm je vhodná pro interiérové čalounění s důrazem na autentický charakter materiálu.",
      stats: [
        { label: "Složení", value: "pravá kůže" },
        { label: "Tloušťka", value: "0,8–1,0 mm" },
        { label: "Stálost na světle", value: "> 5" },
      ],
      sections: [
        {
          title: "Technické vlastnosti",
          rows: [
            { label: "Typ materiálu", value: "pravá kůže" },
            { label: "Tloušťka", value: "0,8–1,0 mm" },
            { label: "Stálost barvy na umělém světle", value: "> 5" },
            { label: "Odolnost vůči cigaretě a zápalce", value: "ano" },
          ],
        },
      ],
    },

    shadeFiles: [
      "FLORIDA_OpticWhite.png",
      "FLORIDA_Milk.png",
      "FLORIDA_Sand.png",
      "FLORIDA_Cream.png",

      "FLORIDA_Almond.png",
      "FLORIDA_Camel.png",
      "FLORIDA_Tobacco.png",
      "FLORIDA_Elephant.png",

      "FLORIDA_Taupe.png",
      "FLORIDA_Ebony.png",
      "FLORIDA_Forest.png",
      "FLORIDA_Red.png",

      "FLORIDA_Ocean.png",
      "FLORIDA_Cement.png",
      "FLORIDA_Ash.png",
      "FLORIDA_Anthracite.png",

      "FLORIDA_Black.png",
    ],

    desc: "Jemná přírodní kůže s pravidelnou strukturou.",
    care: "Doporučena šetrná údržba kůže.",
  }),
];

function findFabricFamilyByKeyAny(fabricKey) {
  const key = String(fabricKey || "").trim();
  if (!key) return null;

  const groups = [
    { tabKey: "cat1", fabrics: FABRICS_CAT1 },
    { tabKey: "cat2", fabrics: FABRICS_CAT2 },
    { tabKey: "cat3", fabrics: FABRICS_CAT3 },
    { tabKey: "leather", fabrics: FABRICS_LEATHER },
  ];

  for (const group of groups) {
    const family = (group.fabrics || []).find((f) => f.key === key);
    if (family) return { tabKey: group.tabKey, family };
  }

  return null;
}

function getCurrentAppliedFabricContext() {
  const tabKey = getAppliedFabricTabKey();
  const selected = getSelectedFabricForTabKey(tabKey);
  if (!selected?.fabricKey) return null;

  const family = getFabricFamilyByKey(tabKey, selected.fabricKey);
  if (!family) return null;

  return { tabKey, selected, family };
}

function getPaspuleFabricContext() {
  if (getModelKey() !== "MELBOURNE") return null;
  return getCurrentAppliedFabricContext();
}

function clearPaspuleSelectionIfSofaFamilyChanged(nextFabricKey) {
  if (getModelKey() !== "MELBOURNE") return;
  if (!selectedPaspuleFabric?.fabricKey) return;
  if (selectedPaspuleFabric.fabricKey === nextFabricKey) return;

  selectedPaspuleFabric = null;
  activeFabricFamilyByTab.paspule = nextFabricKey || null;
  try { resetPaspuleMaterialToDefault?.(); } catch (e) {}
  try { updateStep4ContinueUI?.(); } catch (e) {}
}

function applySelectedPaspuleFabricIfValid() {
  if (getModelKey() !== "MELBOURNE") return false;
  if (!selectedPaspuleFabric?.baseColorUrl) return false;

  const ctx = getPaspuleFabricContext();
  if (!ctx?.family || ctx.family.key !== selectedPaspuleFabric.fabricKey) return false;

  applyFabricToPaspuleByMaterialMap({
    fabricKey: selectedPaspuleFabric.fabricKey || "",
    baseColorUrl: selectedPaspuleFabric.baseColorUrl,
    normalUrl: selectedPaspuleFabric.normalUrl,
    roughnessUrl: selectedPaspuleFabric.roughnessUrl,
    repeat: ctx.family.repeat ?? 2,
    normalScale: ctx.family.normalScale ?? null,
  });

  return true;
}

function hashToHsl(str){
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;

  // âś… THREE.Color.setStyle chce starĹˇĂ­ CSS formĂˇt s ÄŤĂˇrkami
  return `hsl(${h}, 55%, 62%)`;
}

function hashToHue01(str){
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h / 360;
}

function getFabricHostIdForTab(tabKey) {
  if (tabKey === "cat1") return "fabricListCat1";
  if (tabKey === "cat2") return "fabricListCat2";
  if (tabKey === "cat3") return "fabricListCat3";
  if (tabKey === "leather") return "fabricListLeather";
  return "";
}

function renderFabricsForTab(tabKey) {
  if (tabKey === "paspule") {
    tabKey = getAppliedFabricTabKey();
    currentFabricTabKey = tabKey;
  }

  if (currentFabricTargetMode === "paspule") {
    renderFabricBrowserPaspule(tabKey);
    return;
  }

  if (renderedFabricTabs.has(tabKey)) {
    syncRenderedFabricBrowserSelection(tabKey);
    return;
  }

  if (tabKey === "cat1") {
    renderFabricBrowserCat1();
    renderedFabricTabs.add(tabKey);
    syncRenderedFabricBrowserSelection(tabKey);
    return;
  }

  if (tabKey === "cat2") {
    renderFabricBrowserCat2();
    renderedFabricTabs.add(tabKey);
    syncRenderedFabricBrowserSelection(tabKey);
    return;
  }

  if (tabKey === "cat3") {
    renderFabricBrowserCat3();
    renderedFabricTabs.add(tabKey);
    syncRenderedFabricBrowserSelection(tabKey);
    return;
  }

  if (tabKey === "leather") {
    renderFabricBrowserLeather();
    renderedFabricTabs.add(tabKey);
    syncRenderedFabricBrowserSelection(tabKey);
    return;
  }

  // ===== OSTATNĂŤ TABY: zatĂ­m nechĂˇme pĹŻvodnĂ­ grid logiku =====
  const map = {
    cat2: document.getElementById("fabricGridCat2"),
    cat3: document.getElementById("fabricGridCat3"),
    leather: document.getElementById("fabricGridLeather"),
  };

  const grid = map[tabKey];
  if (!grid) return;

  const list = Array.isArray(FABRICS)
    ? FABRICS.filter((f) => (f.category || "cat1") === tabKey)
    : [];

  grid.innerHTML = "";

  list.forEach((f) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fabricCard";
    btn.dataset.fabricId = f.id;

    btn.innerHTML = `
      <img class="fabricThumb" src="${escapeHtmlText(assetUrl(f.thumb || ""))}" alt="${escapeHtmlText(f.name || "")}">
      <div class="fabricName">${f.name || f.id}</div>
    `;

    btn.addEventListener("click", () => {
      debugLog("VybranĂˇ lĂˇtka:", f);
    });

    grid.appendChild(btn);
  });
}

function renderFabricBrowser({
  tabKey,
  hostId,
  fabrics,
  selectedGetter,
  selectedSetter,
  familyColumnTitle = "Druh látky",
  applyTarget = "sofa",
}) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const suffix = String(tabKey || "").replace(/[^a-z0-9]/gi, "");
  document.querySelectorAll(".fabricInfoPopover").forEach((el) => el.remove());

  host.innerHTML = `
    <div class="fabricBrowserCat1">
      <div class="fabricBrowserMain">
        <div class="fabricFamilyColumn">
          <div class="fabricColumnTitle">${familyColumnTitle}</div>
          <div class="fabricFamilyTabs" id="fabricFamilyTabs${suffix}"></div>
        </div>

        <div class="fabricShadesColumn">
          <div class="fabricShadesHeader">
            <div class="fabricColumnTitle" id="fabricShadesTitle${suffix}"></div>
            <div class="fabricTargetToggle is-hidden" id="fabricTargetToggle${suffix}" aria-label="Režim výběru látky">
              <button type="button" class="fabricTargetBtn" data-fabric-target="sofa">Potah</button>
              <button type="button" class="fabricTargetBtn" data-fabric-target="paspule">Paspule</button>
            </div>
            <button type="button" class="fabricInfoBtn is-hidden" id="fabricInfoBtn${suffix}" aria-expanded="false">
              <span class="fabricInfoBtnIcon" aria-hidden="true">i</span>
              <span>Informace o látce</span>
            </button>
          </div>
          <div class="fabricShadesScroll">
            <div class="fabricShadesGrid" id="fabricShadesGrid${suffix}"></div>
          </div>
      </div>

      <div class="fabricFamilyTooltipOverlay" id="fabricFamilyTooltip${suffix}" aria-hidden="true"></div>
      <div class="fabricInfoPopover" id="fabricInfoPopover${suffix}" role="dialog" aria-hidden="true"></div>
      </div>
    </div>
  `;

  const tabsEl = document.getElementById(`fabricFamilyTabs${suffix}`);
  const shadesEl = document.getElementById(`fabricShadesGrid${suffix}`);
  const shadesTitleEl = document.getElementById(`fabricShadesTitle${suffix}`);
  const targetToggleEl = document.getElementById(`fabricTargetToggle${suffix}`);
  const infoBtnEl = document.getElementById(`fabricInfoBtn${suffix}`);
  const infoPopoverEl = host.querySelector(`#fabricInfoPopover${suffix}`);
  const tooltipEl = document.getElementById(`fabricFamilyTooltip${suffix}`);
  const mainEl = host.querySelector(".fabricBrowserMain");

  if (!tabsEl || !shadesEl || !shadesTitleEl || !targetToggleEl || !infoBtnEl || !infoPopoverEl || !tooltipEl || !mainEl) return;
  document.body.appendChild(infoPopoverEl);

  let activeTooltipAnchor = null;
  let activeInfoFabric = null;
  const stateTabKey = applyTarget === "paspule" ? "paspule" : tabKey;

  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const renderFabricInfoValue = (value) => {
    if (Array.isArray(value)) {
      return value
        .map((item) => `<span class="fabricInfoValueLine">${escapeHtml(item)}</span>`)
        .join("");
    }

    return escapeHtml(value);
  };

  function buildFabricInfoHtml(fabric) {
    const info = resolveFabricInfoForDisplay(fabric);
    if (!info) return "";

    const statsHtml = (info.stats || [])
      .map((row) => `
        <div class="fabricInfoStat">
          <span>${escapeHtml(row.label)}</span>
          <strong>${renderFabricInfoValue(row.value)}</strong>
        </div>
      `)
      .join("");

    const sectionsHtml = (info.sections || [])
      .map((section) => {
        const rowsHtml = (section.rows || [])
          .map((row) => `
            <div class="fabricInfoDetailRow">
              <span>${escapeHtml(row.label)}</span>
              <strong>${renderFabricInfoValue(row.value)}</strong>
            </div>
          `)
          .join("");

        const itemsHtml = (section.items || [])
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("");

        return `
          <section class="fabricInfoSection">
            <h4>${escapeHtml(section.title)}</h4>
            ${section.text ? `<p>${escapeHtml(section.text)}</p>` : ""}
            ${rowsHtml ? `<div class="fabricInfoDetails">${rowsHtml}</div>` : ""}
            ${itemsHtml ? `<ul>${itemsHtml}</ul>` : ""}
          </section>
        `;
      })
      .join("");

    return `
      <div class="fabricInfoHeader">
        <div>
          <h3>${escapeHtml(fabric.name)}</h3>
          <p>${escapeHtml(info.summary || fabric.desc || "")}</p>
        </div>
        <button type="button" class="fabricInfoClose" aria-label="Zavřít informace">×</button>
      </div>
      ${statsHtml ? `<div class="fabricInfoStats">${statsHtml}</div>` : ""}
      ${sectionsHtml ? `<div class="fabricInfoSections">${sectionsHtml}</div>` : ""}
    `;
  }

  function closeFabricInfoPopover() {
    infoPopoverEl.classList.remove("is-open", "is-left");
    infoPopoverEl.setAttribute("aria-hidden", "true");
    infoBtnEl.setAttribute("aria-expanded", "false");
  }

  function positionFabricInfoPopover() {
    const btnRect = infoBtnEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1200;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const margin = 12;
    const popoverWidth = Math.min(380, Math.max(320, viewportWidth - margin * 2));
    const gap = 12;

    infoPopoverEl.style.width = `${popoverWidth}px`;

    let left = btnRect.right + gap;
    let opensLeft = false;

    if (left + popoverWidth > viewportWidth - margin) {
      left = btnRect.left - popoverWidth - gap;
      opensLeft = true;
    }

    left = Math.max(margin, Math.min(left, viewportWidth - popoverWidth - margin));

    infoPopoverEl.style.left = `${Math.round(left)}px`;
    infoPopoverEl.style.top = `${Math.round(margin)}px`;

    const popoverRect = infoPopoverEl.getBoundingClientRect();
    const popoverHeight = Math.min(popoverRect.height || 0, viewportHeight - margin * 2);
    const maxTop = Math.max(margin, viewportHeight - popoverHeight - margin);
    let top = btnRect.top - 86;
    top = Math.max(margin, Math.min(top, maxTop));

    infoPopoverEl.style.top = `${Math.round(top)}px`;
    infoPopoverEl.classList.toggle("is-left", opensLeft);

    const arrowTop = Math.max(28, Math.min(popoverHeight - 28, (btnRect.top + btnRect.height / 2) - top));
    infoPopoverEl.style.setProperty("--fabric-info-arrow-top", `${Math.round(arrowTop)}px`);
  }

  function openFabricInfoPopover(fabric = activeInfoFabric) {
    if (!resolveFabricInfoForDisplay(fabric)) return;

    infoPopoverEl.innerHTML = buildFabricInfoHtml(fabric);
    positionFabricInfoPopover();
    infoPopoverEl.classList.add("is-open");
    infoPopoverEl.setAttribute("aria-hidden", "false");
    infoBtnEl.setAttribute("aria-expanded", "true");

    const closeBtn = infoPopoverEl.querySelector(".fabricInfoClose");
    if (closeBtn) closeBtn.onclick = closeFabricInfoPopover;
  }

  function syncFabricInfoButton(fabric) {
    activeInfoFabric = fabric || null;
    const hasInfo = !!resolveFabricInfoForDisplay(fabric);

    infoBtnEl.classList.toggle("is-hidden", !hasInfo);
    infoBtnEl.disabled = !hasInfo;

    if (!hasInfo) {
      closeFabricInfoPopover();
      return;
    }

    if (infoPopoverEl.classList.contains("is-open")) {
      openFabricInfoPopover(fabric);
    }
  }

  function syncFabricTargetToggle() {
    const isMelbourne = getModelKey() === "MELBOURNE";
    const ctx = getPaspuleFabricContext();
    const canOpenPaspule = !!ctx?.family && ctx.tabKey === tabKey;

    targetToggleEl.classList.toggle("is-hidden", !isMelbourne);

    targetToggleEl
      .querySelectorAll(".fabricTargetBtn")
      .forEach((btn) => {
        const target = btn.dataset.fabricTarget || "sofa";
        const isPaspuleBtn = target === "paspule";

        btn.classList.toggle("is-active", target === applyTarget);
        btn.disabled = isPaspuleBtn && !canOpenPaspule && applyTarget !== "paspule";
        btn.title = isPaspuleBtn && btn.disabled
          ? "Paspule lze upravit po výběru látky v této kategorii."
          : "";
      });
  }

  targetToggleEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".fabricTargetBtn");
    if (!btn || btn.disabled) return;

    const target = btn.dataset.fabricTarget || "sofa";
    currentFabricTargetMode = target === "paspule" ? "paspule" : "sofa";
    renderedFabricTabs.delete(tabKey);
    renderFabricsForTab(tabKey);
    saveStateDebounced?.(80);
  });

  infoBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeInfoFabric?.info) return;

    if (infoPopoverEl.classList.contains("is-open")) {
      closeFabricInfoPopover();
    } else {
      openFabricInfoPopover(activeInfoFabric);
    }
  });

  infoPopoverEl.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("click", (e) => {
    if (
      !infoPopoverEl.classList.contains("is-open") ||
      infoPopoverEl.contains(e.target) ||
      infoBtnEl.contains(e.target)
    ) {
      return;
    }

    closeFabricInfoPopover();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFabricInfoPopover();
  });

  function hideFabricFamilyTooltip() {
    activeTooltipAnchor = null;
    tooltipEl.classList.remove("is-visible");
    tooltipEl.textContent = "";
    tooltipEl.setAttribute("aria-hidden", "true");
  }

  function positionFabricFamilyTooltip(anchor) {
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const mainRect = mainEl.getBoundingClientRect();

    const top = anchorRect.top - mainRect.top + (anchorRect.height / 2);
    tooltipEl.style.top = `${Math.round(top)}px`;
  }

  function showFabricFamilyTooltip(anchor) {
    if (!anchor) return;

    const text = anchor.dataset.selectionHint || "";
    if (!text) {
      hideFabricFamilyTooltip();
      return;
    }

    activeTooltipAnchor = anchor;
    tooltipEl.textContent = text;
    tooltipEl.classList.add("is-visible");
    tooltipEl.setAttribute("aria-hidden", "false");
    positionFabricFamilyTooltip(anchor);
  }

  tabsEl.addEventListener("mousemove", (e) => {
    const tab = e.target.closest(".fabricFamilyTab.hasFabricSelectionHint");

    if (!tab || !tabsEl.contains(tab)) {
      hideFabricFamilyTooltip();
      return;
    }

    showFabricFamilyTooltip(tab);
  });

  tabsEl.addEventListener("mouseleave", () => {
    hideFabricFamilyTooltip();
  });

  tabsEl.addEventListener("scroll", () => {
    hideFabricFamilyTooltip();
  });

  const renderShadesTitle = (fabric) => {
    shadesTitleEl.textContent = applyTarget === "paspule"
      ? `Odstíny paspule – ${fabric.name}`
      : `Odstíny – ${fabric.name}`;

    syncFabricInfoButton(fabric);
  };

  // --- helper: vykresli odstĂ­ny
  const renderShades = (fabric) => {
    shadesEl.innerHTML = "";

    // âś… loader jen pro thumbnails, kterĂ© jeĹˇtÄ› NEJSOU v cache
    const urlsToLoad = (fabric.shades || [])
      .filter(s => s.available)
      .map(s => s.baseColorUrl)
      .filter(url => url && !fabricThumbCache.has(url));

    const total = urlsToLoad.length;
    if (total > 0) loadingBegin(10, "Načítám náhledy látek…");
    let pending = total;

    const oneDone = () => {
      pending--;
      if (pending <= 0) loadingEnd();
    };

    if (total === 0) {
      loadingEnd();
    }

    fabric.shades.forEach((shadeObj) => {
      const { code2, available, baseColorUrl, normalUrl, roughnessUrl } = shadeObj;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fabricShadeBtn";
      btn.dataset.fabricKey = fabric.key;
      btn.dataset.fabricName = fabric.name;
      btn.dataset.shade = code2;

      btn.dataset.baseColorUrl = baseColorUrl;
      btn.dataset.normalUrl = normalUrl;
      btn.dataset.roughnessUrl = roughnessUrl;

      btn.title = `${fabric.name} ${code2}`;
      btn.setAttribute("aria-label", `${fabric.name} ${code2}`);

      btn.innerHTML = `
        <div class="fabricShadeSwatch"></div>
        <div class="fabricShadeLabel">${fabric.name} ${code2}</div>
      `;

      const sw = btn.querySelector(".fabricShadeSwatch");

      if (!available) {
        btn.classList.add("is-empty");
        btn.disabled = true;
        sw.classList.remove("is-loaded");
        sw.style.backgroundImage = "none";
        sw.style.backgroundColor = "rgba(255,255,255,0.08)";
        shadesEl.appendChild(btn);
        return;
      }

      // 1) placeholder (aĹĄ tam nenĂ­ "prĂˇzdno")
      sw.classList.remove("is-loaded");
      sw.style.backgroundImage = "none";
      sw.style.backgroundColor = "rgba(255,255,255,0.08)";

      const apply = () => {
        sw.style.backgroundImage = `url("${assetUrl(baseColorUrl)}")`;
        sw.style.backgroundSize = "cover";
        sw.style.backgroundPosition = "center";
        sw.style.backgroundRepeat = "no-repeat";
        sw.style.backgroundColor = "transparent";
        sw.classList.add("is-loaded");
      };

      // âś… kdyĹľ uĹľ je URL v cache, neÄŤekej, nic nenaÄŤĂ­tej, rovnou apply
      if (fabricThumbCache.has(baseColorUrl)) {
        apply();
      } else {
        // âś… jinak naÄŤti a uloĹľ do cache (jen jednou pro danou URL)
        loadThumbCached(baseColorUrl)
          .then(apply)
          .catch(apply)
          .finally(oneDone);
      }

      btn.addEventListener("click", async () => {
        // active state jen v gridu odstĂ­nĹŻ
        shadesEl
          .querySelectorAll(".fabricShadeBtn.is-active")
          .forEach((x) => x.classList.remove("is-active"));
        btn.classList.add("is-active");

        if (applyTarget !== "paspule") {
          appliedFabricPriceGroup = getFabricPriceGroupFromTabKey(tabKey);
          clearPaspuleSelectionIfSofaFamilyChanged(fabric.key);
        }

        selectedSetter({
          fabricKey: fabric.key,
          fabricName: fabric.name,
          shade: code2,
          desc: fabric.desc,
          care: fabric.care,
          baseColorUrl,
          normalUrl,
          roughnessUrl,
        });

        const selected = selectedGetter();

        if (applyTarget === "paspule") {
          await applyFabricToPaspuleByMaterialMap({
            fabricKey: fabric.key,
            baseColorUrl: selected?.baseColorUrl,
            normalUrl: selected?.normalUrl,
            roughnessUrl: selected?.roughnessUrl,
            repeat: fabric.repeat ?? 2,
            normalScale: fabric.normalScale,
          });
        } else {
          // âś… bez tintovĂˇnĂ­ â€“ uĹľ mĂˇĹˇ hotovĂ© obrĂˇzky
          await applyFabricToSofaByMaterialMap({
            fabricKey: fabric.key,
            baseColorUrl: selected?.baseColorUrl,
            normalUrl: selected?.normalUrl,
            roughnessUrl: selected?.roughnessUrl,
            repeat: fabric.repeat ?? 2,
            normalScale: fabric.normalScale,
          });
        }

        scheduleSummaryRecalc?.();
        updateSummaryUI?.();
        if (applyTarget !== "paspule") updateFabricCategoryTabPrices?.();
        syncFabricTargetToggle();
        if (infoPopoverEl.classList.contains("is-open")) openFabricInfoPopover(fabric);
        if (applyTarget !== "paspule") updateFabricSelectionIndicators?.();
        updateStep4ContinueUI?.();
        try { saveStateNow?.(); } catch (e) { saveStateDebounced?.(80); }
      });

      shadesEl.appendChild(btn);
    });

    shadesEl
      .querySelectorAll(".fabricShadeBtn.is-active")
      .forEach((x) => x.classList.remove("is-active"));

    const selected = selectedGetter();
    const isAppliedCategory =
      applyTarget === "paspule" || tabKey === getAppliedFabricTabKey();

    const wantedShade =
      isAppliedCategory && selected?.fabricKey === fabric.key
        ? String(selected.shade || "")
        : "";

    const preferred =
      wantedShade
        ? shadesEl.querySelector(`.fabricShadeBtn[data-shade="${CSS.escape(wantedShade)}"]:not(.is-empty)`)
        : null;

    if (preferred) {
      preferred.classList.add("is-active");
    }
  };

  // --- vykresli tabs (lĂˇtky)
  tabsEl.innerHTML = "";
  const selected = selectedGetter();
  const activeFabricKey = getActiveFabricFamilyForTab(stateTabKey) || selected?.fabricKey || "";
  let preferredTab = null;

  fabrics.forEach((fabric, idx) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "fabricFamilyTab";
    tab.dataset.fabricKey = fabric.key;

    // thumb: vezmeme prvnĂ­ odstĂ­n jako preview
    const thumb = fabric.shades?.[0]?.baseColorUrl || "";

    tab.innerHTML = `
      <div class="fabricFamilyThumb" style="background-image:url('${escapeHtmlText(assetUrl(thumb))}')"></div>
      <div class="fabricFamilyName">${fabric.name}</div>
    `;

    tab.addEventListener("click", () => {
      tabsEl
        .querySelectorAll(".fabricFamilyTab.is-active")
        .forEach((x) => x.classList.remove("is-active"));
      tab.classList.add("is-active");

      setActiveFabricFamilyForTab(stateTabKey, fabric.key);
      saveStateDebounced?.(80);

      renderShadesTitle(fabric);
      renderShades(fabric);
      syncFabricTargetToggle();
      if (applyTarget !== "paspule") updateFabricSelectionIndicators?.();
    });

    tabsEl.appendChild(tab);

    if (!preferredTab && activeFabricKey === fabric.key) {
      preferredTab = tab;
    } else if (idx === 0 && !preferredTab) {
      preferredTab = tab;
    }
  });

  if (preferredTab) {
    const preferredFabric = fabrics.find((f) => f.key === preferredTab.dataset.fabricKey);

    tabsEl
      .querySelectorAll(".fabricFamilyTab.is-active")
      .forEach((x) => x.classList.remove("is-active"));

    preferredTab.classList.add("is-active");

    if (preferredFabric) {
      renderShadesTitle(preferredFabric);
      renderShades(preferredFabric);
    }
  }

  syncFabricTargetToggle();
  if (applyTarget !== "paspule") updateFabricSelectionIndicators?.();
  updateStep4ContinueUI?.();
}

function renderFabricBrowserCat1() {
  renderFabricBrowser({
    tabKey: "cat1",
    hostId: "fabricListCat1",
    fabrics: FABRICS_CAT1,
    selectedGetter: () => selectedFabricCat1,
    selectedSetter: (value) => { selectedFabricCat1 = value; }
  });
}

function renderFabricBrowserCat2() {
  renderFabricBrowser({
    tabKey: "cat2",
    hostId: "fabricListCat2",
    fabrics: FABRICS_CAT2,
    selectedGetter: () => selectedFabricCat2,
    selectedSetter: (value) => { selectedFabricCat2 = value; }
  });
}

function renderFabricBrowserCat3() {
  renderFabricBrowser({
    tabKey: "cat3",
    hostId: "fabricListCat3",
    fabrics: FABRICS_CAT3,
    selectedGetter: () => selectedFabricCat3,
    selectedSetter: (value) => { selectedFabricCat3 = value; }
  });
}

function renderFabricBrowserLeather() {
  renderFabricBrowser({
    tabKey: "leather",
    hostId: "fabricListLeather",
    fabrics: FABRICS_LEATHER,
    selectedGetter: () => selectedFabricLeather,
    selectedSetter: (value) => { selectedFabricLeather = value; },
    familyColumnTitle: "Druh kůže",
  });
}

function renderFabricBrowserPaspule(tabKey = currentFabricTabKey) {
  const hostId = getFabricHostIdForTab(tabKey);
  const host = document.getElementById(hostId);
  if (!host) return;

  const ctx = getPaspuleFabricContext();
  if (!ctx?.family || ctx.tabKey !== tabKey) {
    currentFabricTargetMode = "sofa";
    renderedFabricTabs.delete(tabKey);
    renderFabricsForTab(tabKey);
    return;
  }

  if (!ctx.family.shades?.length) {
    host.innerHTML = `
      <div class="fabricEmptyState">
        Pro paspule nejsou dostupné žádné odstíny.
      </div>
    `;
    return;
  }

  const family = ctx.family;
  activeFabricFamilyByTab.paspule = family.key;

  renderFabricBrowser({
    tabKey,
    hostId,
    fabrics: [family],
    selectedGetter: () => (
      selectedPaspuleFabric?.fabricKey === family.key ? selectedPaspuleFabric : null
    ),
    selectedSetter: (value) => {
      selectedPaspuleFabric = {
        ...value,
        sourceFabricTab: ctx.tabKey,
      };
    },
    familyColumnTitle: ctx.tabKey === "leather" ? "Druh kůže" : "Druh látky",
    applyTarget: "paspule",
  });
}

function setBottomPanelByKey(key) {
  document.querySelectorAll(".bottomTab").forEach((x) => {
    const step = Number(x.dataset.step || 3);
    if (step !== appState.step) return;
    x.classList.toggle("active", x.dataset.tab === key);
  });

  document.querySelectorAll(".bottomSection").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.tabpanel !== key);
  });
}

function updateBuildModeUI() {
  const buildEnabled = isBuildStepActive();

  // 1) zavĹ™i UI, kterĂ© ve kroku 3 nechceĹˇ
  if (!buildEnabled) {
    try { closePicker(); } catch (e) {}
    try { closeActionMenu(); } catch (e) {}
  }

  // 2) skryj 3D add tlaÄŤĂ­tka (start + plusy)
  // startButton je globĂˇl (u tebe existuje) :contentReference[oaicite:3]{index=3}
  if (startButton) {
    // start tlaÄŤĂ­tko jen kdyĹľ stavĂ­Ĺˇ a nemĂˇĹˇ moduly
    startButton.visible = buildEnabled && activeModules.length === 0;
  }

  // activeButtons je globĂˇlnĂ­ pole 3D tlaÄŤĂ­tek :contentReference[oaicite:4]{index=4}
  activeButtons.forEach((btn) => {
    const mesh = btn?.mesh || btn; // podle toho, jak to tam mĂˇĹˇ uloĹľenĂ©
    if (mesh) mesh.visible = buildEnabled;
  });

  // 3) HTML overlay (picker/menu) zakĂˇzat pointery ve 3. kroku (pro jistotu)
  const picker = document.getElementById("modulePicker");
  if (picker) picker.style.pointerEvents = buildEnabled ? "auto" : "none";

  const actionMenu = document.getElementById("moduleActionMenu");
  if (actionMenu) actionMenu.style.pointerEvents = buildEnabled ? "auto" : "none";
}

function bindBottomToggle(){

  const bottomBarEl = document.getElementById("bottomBar");
  const toggleBtn   = document.getElementById("bottomToggle");
  const tabsEl      = bottomBarEl?.querySelector(".bottomTabs");
  const panelEl     = bottomBarEl?.querySelector(".bottomPanel");

  if(!bottomBarEl || !toggleBtn) return;

  const ANIM_TIME = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--equip-anim")
  ) || 260;

  let collapseTimer = null;

  function calcDockDy(){
    // Ĺˇipka mĂˇ sjet jen â€śtam, kde byly tabsâ€ť (+ malĂ˝ doraz),
    // NE o vĂ˝Ĺˇku celĂ©ho panelu (jinak zmizĂ­ mimo obraz).
    let dy = 0;

    if (tabsEl) {
      dy += tabsEl.offsetHeight;
      const tabsCS = getComputedStyle(tabsEl);
      dy += parseFloat(tabsCS.marginBottom) || 0;
    }

    // malĂ˝ doraz, aby Ĺˇipka nesedÄ›la ĂşplnÄ› na hranÄ›
    dy += 12;

    return Math.max(0, Math.round(dy));
  }

  function collapse(){
    // zruĹˇ pĹ™edchozĂ­ timeout, kdyĹľ uĹľivatel klikĂˇ rychle
    if(collapseTimer){
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }

    // nastav o kolik mĂˇ Ĺˇipka sjet (neĹľ pĹ™idĂˇme is-hiding)
    const dy = calcDockDy();
    document.documentElement.style.setProperty("--dock-dy", `${dy}px`);

    // 1) okamĹľitÄ› zaÄŤni animaci (tabs+panel+Ĺˇipka) + summary pohyb
    bottomBarEl.classList.add("is-hiding");
    animateEquipLayout(ANIM_TIME);

    // 2) po dobÄ›hnutĂ­ animace ĂşplnÄ› â€śsbalâ€ť
    collapseTimer = setTimeout(() => {
      bottomBarEl.classList.add("is-collapsed");

      // dĹŻleĹľitĂ©: po sbalenĂ­ uĹľ nechceme drĹľet Ĺˇipku â€śdoleâ€ť
      document.documentElement.style.setProperty("--dock-dy", `0px`);

      collapseTimer = null;
      syncEquipLayout();
    }, ANIM_TIME);
  }

  function expand(){
    if(collapseTimer){
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }

    // pĹ™iprav: vraĹĄ do layoutu, ale nech zatĂ­m "hiding"
    bottomBarEl.classList.remove("is-collapsed");
    bottomBarEl.classList.add("is-hiding");

    // po od-collapsed uĹľ znĂˇme reĂˇlnĂ© vĂ˝Ĺˇky â†’ spoÄŤĂ­tej dy znovu
    const dy = calcDockDy();
    document.documentElement.style.setProperty("--dock-dy", `${dy}px`);

    // dalĹˇĂ­ frame: pusĹĄ vyjĂ­ĹľdÄ›nĂ­ (Ĺˇipka nahoru, tabs/panel se objevĂ­)
    requestAnimationFrame(() => {
      // Ĺˇipka se vracĂ­ nahoru plynule
      document.documentElement.style.setProperty("--dock-dy", `0px`);

      bottomBarEl.classList.remove("is-hiding");
      animateEquipLayout(ANIM_TIME);
    });
  }

  toggleBtn.addEventListener("click", () => {
    const collapsed = bottomBarEl.classList.contains("is-collapsed");
    if(collapsed) expand();
    else collapse();
  });
}

// =====================================================
// CAMERA FOCUS HELPERS (tabs: legs / armrests / hinges)
// =====================================================

// vezme "krajnĂ­" modul â€“ defaultnÄ› nejvĂ­c vpravo podle stĹ™edu bounding boxu
function getEdgeModuleRecRightmost() {
  if (!Array.isArray(activeModules) || activeModules.length === 0) return null;

  let best = null;
  let bestX = -Infinity;

  const box = new THREE.Box3();
  const center = new THREE.Vector3();

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;
    box.setFromObject(rec.mesh);
    box.getCenter(center);

    if (center.x > bestX) {
      bestX = center.x;
      best = rec;
    }
  }
  return best;
}

// projde objekt a vrĂˇtĂ­ mesh-e, jejichĹľ jmĂ©no obsahuje nÄ›kterĂ˝ substring
function collectMeshesByName(obj3d, substringsLower = []) {
  const out = [];
  if (!obj3d) return out;

  obj3d.traverse((o) => {
    if (!o || !o.isMesh) return;
    const n = (o.name || "").toLowerCase();
    if (substringsLower.some((s) => n.includes(s))) out.push(o);
  });

  return out;
}

// box z meshĹŻ; kdyĹľ nic nenajde, vrĂˇtĂ­ null
function boxFromMeshes(meshes) {
  if (!meshes || meshes.length === 0) return null;

  const box = new THREE.Box3();
  let hasAny = false;

  for (const m of meshes) {
    if (!m) continue;
    box.expandByObject(m);
    hasAny = true;
  }
  return hasAny ? box : null;
}

// spoÄŤĂ­tĂˇ camera pos, aby se veĹˇel box (podobnÄ› jako tvoje auto-fit)
function focusCameraOnBox(box, { padding = 1.25, yTargetOffset = 0.0 } = {}) {
  if (!camera || !controls || !box) return;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // lehce zvednout target (aĹĄ koukĂˇĹˇ spĂ­Ĺˇ na detail neĹľ na zem)
  const target = center.clone();
  target.y += yTargetOffset;

  // smÄ›r: vezmi aktuĂˇlnĂ­ smÄ›r kamery (aĹĄ to nepĹ™eskakuje â€śz bokuâ€ť)
  const viewDir = camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(viewDir.x) || !isFinite(viewDir.y) || !isFinite(viewDir.z)) {
    viewDir.set(0.6, 0.35, 0.75).normalize();
  }

  // fit vzdĂˇlenost podle fov / aspect
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || 1;

  const height = Math.max(size.y, 0.0001);
  const width = Math.max(size.x, 0.0001);
  const depth = Math.max(size.z, 0.0001);

  // chceme aby se veĹˇel â€śnejvÄ›tĹˇĂ­ rozmÄ›râ€ť v obraze
  const maxH = height;
  const maxW = width;

  // dist pro vĂ˝Ĺˇku
  let distH = (maxH / 2) / Math.tan(fov / 2);

  // dist pro ĹˇĂ­Ĺ™ku (pĹ™epoÄŤet pĹ™es aspect)
  let distW = (maxW / 2) / (Math.tan(fov / 2) * aspect);

  let dist = Math.max(distH, distW);

  // trochu pĹ™idej i hloubku, aby to nebylo nalepenĂ©
  dist = Math.max(dist, depth * 0.9);

  dist *= padding;

  const newPos = target.clone().add(viewDir.multiplyScalar(dist));

  // nastav â€śauto cameraâ€ť cĂ­le â€“ tĂ­m vyuĹľijeĹˇ tvoje plynulĂ© dolerpovĂˇnĂ­ (ĹľĂˇdnĂ˝ lock)
  camGoalTarget.copy(target);
  camGoalPos.copy(newPos);

  autoCamActive = true;
  autoCamBlocked = false;
}

// zacĂ­lenĂ­ podle tabu
function focusCameraForBottomTab_Box(tabKey) {
  if (!tabKey) return;

  // fallback: kdyĹľ nemĂˇĹˇ moduly, neĹ™eĹˇ
  const edgeRec = getEdgeModuleRecRightmost();
  const edgeMesh = edgeRec?.mesh;

  // 1) nohy: hledej meshe co v nĂˇzvu majĂ­ "legs" (ty uĹľ podle toho materiĂˇlujeĹˇ) :contentReference[oaicite:1]{index=1}
  if (tabKey === "legs") {
    const legsMeshes = collectMeshesByName(edgeMesh, ["legs"]);
    const box = boxFromMeshes(legsMeshes) || (edgeMesh ? new THREE.Box3().setFromObject(edgeMesh) : null);

    // target lehce dolĹŻ, aĹĄ vidĂ­Ĺˇ nohy
    if (box) focusCameraOnBox(box, { padding: 1.35, yTargetOffset: -0.15 });
    return;
  }

  if (tabKey === "shelf") {
    const shelfMeshes = [];
    for (const rec of activeModules || []) {
      if (!rec?.mesh) continue;
      rec.mesh.traverse((o) => {
        if (o?.isMesh && String(o.name || "").toLowerCase() === "plane") {
          shelfMeshes.push(o);
        }
      });
    }

    const box = boxFromMeshes(shelfMeshes);
    if (box) focusCameraOnBox(box, { padding: 1.55, yTargetOffset: 0.05 });
    return;
  }

  // 2) podruÄŤky: ÄŤasto bĂ˝vajĂ­ v nĂˇzvu "arm" / "armrest" / "podruck"
  if (tabKey === "armrests") {
    // 1) podruÄŤky primĂˇrnÄ› z PRVNĂŤHO modulu
    let armMeshes = collectMeshesByKeywords(firstModule, [
      "arm", "armrest", "podruck", "podru", "ruÄŤk", "ruc"
    ]);

    // 2) fallback: kdyĹľ prvnĂ­ modul nemĂˇ podruÄŤky, vezmeme vĹˇechny a vybereme jednu
    if (!armMeshes.length) {
      const all = [];
      for (const rec of activeModules) {
        if (!rec?.mesh) continue;
        all.push(...collectMeshesByKeywords(rec.mesh, [
          "arm", "armrest", "podruck", "podru", "ruÄŤk", "ruc"
        ]));
      }
      armMeshes = all;
    }
    if (!armMeshes.length) return;

    // 3) kdyĹľ jsou 2 podruÄŤky, vybereme jednu konkrĂ©tnĂ­ (pravou / nejvĂ­c X)
    const arm = pickRightmost(armMeshes);

    // 4) vĹľdy zepĹ™edu modulu (ne mezi podruÄŤky)
    focusCameraOnObject(arm, {
      lockToModuleFront: true,
      frontTiltY: 0.22,
      targetYOffset: 0.08,
      distanceMul: 2.4
    });
    return;
  }

  // 3) panty: v nĂˇzvu mĂˇĹˇ "hinge" (materiĂˇlovacĂ­ logika) :contentReference[oaicite:2]{index=2}
  if (tabKey === "hinges") {
    const hingeMeshes = collectMeshesByName(edgeMesh, ["hinge"]);
    const box = boxFromMeshes(hingeMeshes) || (edgeMesh ? new THREE.Box3().setFromObject(edgeMesh) : null);

    if (box) focusCameraOnBox(box, { padding: 1.25, yTargetOffset: 0.05 });
    return;
  }
}

function openLegsUntouchedConfirmModal() {
  const existing = document.getElementById("legsUntouchedConfirmModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "legsUntouchedConfirmModal";
  modal.className = "confirmModal";
  modal.setAttribute("aria-hidden", "false");

  modal.innerHTML = `
    <div class="picker-window confirmWindow" role="dialog" aria-modal="true" aria-labelledby="legsUntouchedTitle">
      <div class="picker-header">
        <div id="legsUntouchedTitle">Výběr nohou</div>
        <button id="legsUntouchedClose" type="button" aria-label="Zavřít">✕</button>
      </div>
      <div class="confirmText">
        Nohy zůstaly ve výchozím nastavení. Chcete s nimi pokračovat?
      </div>
      <div class="confirmActions">
        <button id="legsUntouchedChoose" type="button" class="confirmBtn">Vybrat nohy</button>
        <button id="legsUntouchedContinue" type="button" class="confirmBtn confirmBtnPrimary">Pokračovat</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  return new Promise((resolve) => {
    const okBtn = modal.querySelector("#legsUntouchedContinue");
    const chooseBtn = modal.querySelector("#legsUntouchedChoose");
    const closeBtn = modal.querySelector("#legsUntouchedClose");

    const cleanup = () => {
      okBtn?.removeEventListener("click", onOk);
      chooseBtn?.removeEventListener("click", onChoose);
      closeBtn?.removeEventListener("click", onChoose);
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
      modal.remove();
    };

    const onOk = () => {
      cleanup();
      resolve(true);
    };

    const onChoose = () => {
      cleanup();
      resolve(false);
    };

    const onBackdrop = (e) => {
      if (e.target === modal) onChoose();
    };

    const onKey = (e) => {
      if (e.key === "Escape") onChoose();
    };

    okBtn?.addEventListener("click", onOk);
    chooseBtn?.addEventListener("click", onChoose);
    closeBtn?.addEventListener("click", onChoose);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKey);
  });
}

function openLegsTabForReview() {
  currentEquipTabKey = "legs";
  setBottomPanelByKey("legs");
  try { bindLegsEquipmentUI(); } catch (e) {}
  try { updateHeadrestDotsVisibility(); } catch (e) {}
  try { updateStep3ContinueUI(); } catch (e) {}
  try { focusCameraForBottomTab?.("legs"); } catch (e) {}
}

function resetLegsUntouchedWarningForCurrentBuild() {
  legsUntouchedWarningShownForCurrentBuild = false;
  hasUserTouchedLegs = false;
}

async function confirmLegsBeforeLeavingStep3() {
  if (appState.step !== 3) return true;

  // Když už uživatel nohy ručně řešil, není co potvrzovat.
  if (hasUserTouchedLegs) return true;

  // DŮLEŽITÉ:
  // Upozornění se má v jedné sestavě ukázat jen jednou.
  // Jakmile už jednou vyskočilo, podruhé už uživatele nepřerušujeme.
  if (legsUntouchedWarningShownForCurrentBuild) {
    return true;
  }

  // Označíme jako zobrazené hned před otevřením modalu.
  // Díky tomu se nebude opakovat ani když uživatel klikne na "Vybrat nohy"
  // a pak znovu zkusí pokračovat bez změny.
  legsUntouchedWarningShownForCurrentBuild = true;

  const shouldContinue = await openLegsUntouchedConfirmModal();

  if (shouldContinue) {
    // Uživatel potvrdil, že chce pokračovat s výchozími nohami.
    // Tím pádem se chováme, jako by byly nohy vyřešené.
    hasUserTouchedLegs = true;
    try { saveStateDebounced?.(50); } catch (e) {}
    return true;
  }

  // Uživatel klikl na "Vybrat nohy" / zavřel modal.
  // Otevřeme tab nohou, ale další pokus o pokračování už modal znovu neukáže.
  openLegsTabForReview();
  try { saveStateDebounced?.(50); } catch (e) {}
  return false;
}

function bindBottomTabs() {
  const tabs = Array.from(document.querySelectorAll(".bottomTab"));
  const panels = Array.from(document.querySelectorAll(".bottomSection"));
  if (!tabs.length || !panels.length) return;

  function setActiveTab(key) {
    if (appState.step === 3 && key === "shelf" && !shouldShowMelbourneShelfTab()) {
      key = "legs";
    }
    if (appState.step === 3 && key === "hinges" && !shouldShowHingesTab()) {
      key = "legs";
    }
    if (appState.step === 3 && key === "extras" && !shouldShowExtrasTab()) {
      key = "legs";
    }

    if (appState.step === 4 && key === "paspule") {
      key = getAppliedFabricTabKey() || "cat1";
    }

    // 1) uloĹľit aktivnĂ­ klĂ­ÄŤ podle kroku
    if (appState.step === 4) {
      currentFabricTabKey = key;
      currentFabricTargetMode = "sofa";
      renderedFabricTabs.delete(key);
    } else {
      currentEquipTabKey = key;
    }

    // 2) pĹ™epnout UI
    tabs.forEach((x) => {
      const isForThisStep = Number(x.dataset.step || 3) === appState.step;
      if (!isForThisStep) return;
      x.classList.toggle("active", x.dataset.tab === key);
    });

    panels.forEach((p) => p.classList.toggle("hidden", p.dataset.tabpanel !== key));

    // 3) krok 3: extras logika + headrest viditelnost + pokraÄŤovat
    if (appState.step === 3) {
      updateHeadrestDotsVisibility();

      if (key === "extras") {
        renderExtrasModuleList();
      } else if (key === "shelf") {
        bindShelfEquipmentUI();
      } else {
        clearHoveredModule();
      }

      updateStep3ContinueUI();
      focusCameraForBottomTab(key);
    }

    // 4) krok 4: render lĂˇtek
    if (appState.step === 4) {
      saveStateDebounced?.(80);
      renderFabricsForTab(key);
      updateFabricSelectionIndicators?.();
      updateStep4ContinueUI?.();
      // (kamera pro lĂˇtky klidnÄ› zatĂ­m neĹ™eĹˇ)
    }
  }

  // bind klikĹŻ
  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      const isForThisStep = Number(t.dataset.step || 3) === appState.step;
      if (!isForThisStep) return;
      setActiveTab(t.dataset.tab);
    });
  });

  // init podle kroku
  const initKey = (appState.step === 4) ? currentFabricTabKey : currentEquipTabKey;
  setActiveTab(initKey);
}

// ===============================
// âś… Bottom menu konfigurace per model (krok 3)
// ===============================
const LEGS_UI_BY_MODEL = {
  MANILA: [
    { code: "N7",  label: "N7",  img: "/images/nohy/N7.png",  material: "wood"  },
    { code: "N9",  label: "N9",  img: "/images/nohy/N9.png",  material: "wood"  },
    { code: "N1",  label: "N1",  img: "/images/nohy/N1.png",  material: "metal" },
    { code: "N11", label: "N11", img: "/images/nohy/N11.png", material: "metal" },
  ],
  MENDOZA: [
    { code: "N8",  label: "N8",  img: "/images/nohy/N8.png",  material: "metal" },
    { code: "N11", label: "N11", img: "/images/nohy/N11.png", material: "metal" },
    { code: "N1",  label: "N1",  img: "/images/nohy/N1.png",  material: "metal" },
  ],
};

// helper â€“ normalizace klĂ­ÄŤe modelu
function getModelKey() {
  return String(appState?.model || "").trim().toUpperCase();
}

// default noha pro model
function getDefaultLegForModel() {
  const mk = getModelKey();
  // pokud nenĂ­ model, fallback MANILA
  const list = LEGS_UI_BY_MODEL[mk] || LEGS_UI_BY_MODEL.MANILA || [];
  return (list[0] && list[0].code) ? list[0].code : "N7";
}

const WOOD_COLORS_TOP = [
  { id: "wood_buk_prirodni", label: "Buk přírodní", img: "/textures/wood/buk/buk_prirodni.png" },
  { id: "wood_dub_prirodni", label: "Dub přírodní", img: "/textures/wood/dub/dub_prirodni.png" },
  { id: "wood_buk_bpa_d63_16", label: "Buk BPA D63/16", img: "/textures/wood/buk/buk_bpa_d63_16.png" },
  { id: "wood_buk_br_282", label: "Buk BR 282", img: "/textures/wood/buk/buk_br_282.png" },
  { id: "wood_buk_br_2441", label: "Buk BR 2441", img: "/textures/wood/buk/buk_br_2441.png" },
  { id: "wood_buk_br_132", label: "Buk BR 132", img: "/textures/wood/buk/buk_br_132.png" },
];

const WOOD_COLORS_ALL = [
  ...WOOD_COLORS_TOP,
  { id: "wood_buk_br_130", label: "Buk BR 130", img: "/textures/wood/buk/buk_br_130.png" },
  { id: "wood_buk_br_201", label: "Buk BR 201", img: "/textures/wood/buk/buk_br_201.png" },
  { id: "wood_buk_br_229", label: "Buk BR 229", img: "/textures/wood/buk/buk_br_229.png" },
  { id: "wood_buk_br_231", label: "Buk BR 231", img: "/textures/wood/buk/buk_br_231.png" },
  { id: "wood_buk_br_243", label: "Buk BR 243", img: "/textures/wood/buk/buk_br_243.png" },
  { id: "wood_buk_br_280", label: "Buk BR 280", img: "/textures/wood/buk/buk_br_280.png" },
  { id: "wood_buk_br_281", label: "Buk BR 281", img: "/textures/wood/buk/buk_br_281.png" },
  { id: "wood_buk_br_283", label: "Buk BR 283", img: "/textures/wood/buk/buk_br_283.png" },
  { id: "wood_buk_br_288", label: "Buk BR 288", img: "/textures/wood/buk/buk_br_288.png" },
  { id: "wood_buk_br_289", label: "Buk BR 289", img: "/textures/wood/buk/buk_br_289.png" },
  { id: "wood_buk_br_385", label: "Buk BR 385", img: "/textures/wood/buk/buk_br_385.png" },
  { id: "wood_buk_br_400_13", label: "Buk BR 400/13", img: "/textures/wood/buk/buk_br_400_13.png" },
  { id: "wood_buk_br_522", label: "Buk BR 522", img: "/textures/wood/buk/buk_br_522.png" },
  { id: "wood_buk_br_2432", label: "Buk BR 2432", img: "/textures/wood/buk/buk_br_2432.png" },
  { id: "wood_buk_br_2436", label: "Buk BR 2436", img: "/textures/wood/buk/buk_br_2436.png" },
  { id: "wood_buk_br_2478", label: "Buk BR 2478", img: "/textures/wood/buk/buk_br_2478.png" },
  { id: "wood_buk_br_2503", label: "Buk BR 2503", img: "/textures/wood/buk/buk_br_2503.png" },
  { id: "wood_buk_br_2527", label: "Buk BR 2527", img: "/textures/wood/buk/buk_br_2527.png" },
  { id: "wood_buk_br_3023", label: "Buk BR 3023", img: "/textures/wood/buk/buk_br_3023.png" },
  { id: "wood_buk_br_3027", label: "Buk BR 3027", img: "/textures/wood/buk/buk_br_3027.png" },
  { id: "wood_buk_br_3028", label: "Buk BR 3028", img: "/textures/wood/buk/buk_br_3028.png" },
];

function bindLegsEquipmentUI() {
  const typeSelect = document.getElementById("legsTypeSelect");
  const colorSelect = document.getElementById("legsColorSelect");
  const legsRow = document.getElementById("legsCardRow");
  const colorsGrid = document.getElementById("legsColorGrid");
  const btnShowAll = document.getElementById("btnLegsShowAll");
  const wrap = document.getElementById("legsEquipWrap");
  const sofaKey = normalizeSofaKey(appState.model); // "manila" | "mendoza" | ...

  const modelKey = String(appState?.model || "").toUpperCase();
  const config = MODEL_EQUIP_CONFIG[modelKey];

  if (!config) return;

  if (!typeSelect || !colorSelect || !legsRow || !colorsGrid) return;

  // =========================
  // 1) Vygeneruj nohy z CONFIGU
  // =========================
  const legsUiList = config.legs;

  legsRow.innerHTML = "";
  typeSelect.innerHTML = "";

  legsUiList.forEach((it, idx) => {
    // karta
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tileCard" + (idx === 0 ? " is-active" : "");
    btn.dataset.leg = it.code;

    btn.innerHTML = `
      <img class="tileImg" src="${escapeHtmlText(assetUrl(it.img))}" alt="${escapeHtmlText(it.code)}" />
      <div class="tileTitle">${it.label}</div>
    `;

    legsRow.appendChild(btn);

    // option pro hidden select
    const opt = document.createElement("option");
    opt.value = it.code;
    opt.textContent = it.label;
    typeSelect.appendChild(opt);
  });

  // 2) LEG_META si sestavĂ­me z konfigurace (mĂ­sto hardcodu)
  const LEG_META = {};
  config.legs.forEach(l => {
    LEG_META[l.code] = { material: l.material };
  });

  // KovovĂ© barvy podle nohy (pĹ™esnÄ› jak jsi psal)
  const METAL_BY_LEG = {
    N11: [
      { id: "metal_chrome", label: "Lesklý kov (chrom)", img: "/textures/metal/chrome/chrome-image.jpg" },
      { id: "metal_matte_black", label: "Černý matný kov", img: "/textures/metal/matte_black/mate-black-image.png" },
    ],
    N8: [
      { id: "metal_chrome", label: "Lesklý kov (chrom)", img: "/textures/metal/chrome/chrome-image.jpg" },
      { id: "metal_matte_black", label: "Černý matný kov", img: "/textures/metal/matte_black/mate-black-image.png" },
    ],
    N1: [
      { id: "metal_chrome", label: "Lesklý kov (chrom)", img: "/textures/metal/chrome/chrome-image.jpg" },
      { id: "metal_matte", label: "Matný kov", img: "/textures/metal/matte/matte-image.jpg" },
    ],
    N21: [
      { id: "metal_chrome", label: "Lesklý kov (chrom)", img: "/textures/metal/chrome/chrome-image.jpg" },
      { id: "meta_graphite", label: "Graphite", img: "/textures/metal/graphite/graphite-image.jpg" },
    ],
  };

  // DĹ™evÄ›nĂ© TOP (6)
  const WOOD_TOP = [
    { id: "wood_buk_prirodni", label: "Buk přírodní", img: "/textures/wood/buk/buk_prirodni.png" },
    { id: "wood_dub_prirodni", label: "Dub přírodní", img: "/textures/wood/dub/dub_prirodni.png" },
    { id: "wood_buk_bpa_d63_16", label: "Buk BPA D63/16", img: "/textures/wood/buk/buk_bpa_d63_16.png" },
    { id: "wood_buk_br_282", label: "Buk BR 282", img: "/textures/wood/buk/buk_br_282.png" },
    { id: "wood_buk_br_2441", label: "Buk BR 2441", img: "/textures/wood/buk/buk_br_2441.png" },
    { id: "wood_buk_br_132", label: "Buk BR 132", img: "/textures/wood/buk/buk_br_132.png" },
  ];

  // DĹ™evÄ›nĂ© ALL (z toho screenshotu â€“ base PNG bez _nor/_rou)
  const WOOD_ALL = [
    ...WOOD_TOP,
    { id: "wood_buk_br_130", label: "Buk BR 130", img: "/textures/wood/buk/buk_br_130.png" },
    { id: "wood_buk_br_201", label: "Buk BR 201", img: "/textures/wood/buk/buk_br_201.png" },
    { id: "wood_buk_br_229", label: "Buk BR 229", img: "/textures/wood/buk/buk_br_229.png" },
    { id: "wood_buk_br_231", label: "Buk BR 231", img: "/textures/wood/buk/buk_br_231.png" },
    { id: "wood_buk_br_243", label: "Buk BR 243", img: "/textures/wood/buk/buk_br_243.png" },

    { id: "wood_buk_br_280", label: "Buk BR 280", img: "/textures/wood/buk/buk_br_280.png" },
    { id: "wood_buk_br_281", label: "Buk BR 281", img: "/textures/wood/buk/buk_br_281.png" },
    { id: "wood_buk_br_283", label: "Buk BR 283", img: "/textures/wood/buk/buk_br_283.png" },
    { id: "wood_buk_br_288", label: "Buk BR 288", img: "/textures/wood/buk/buk_br_288.png" },
    { id: "wood_buk_br_289", label: "Buk BR 289", img: "/textures/wood/buk/buk_br_289.png" },

    { id: "wood_buk_br_385", label: "Buk BR 385", img: "/textures/wood/buk/buk_br_385.png" },
    { id: "wood_buk_br_400_13", label: "Buk BR 400/13", img: "/textures/wood/buk/buk_br_400_13.png" },
    { id: "wood_buk_br_522", label: "Buk BR 522", img: "/textures/wood/buk/buk_br_522.png" },

    { id: "wood_buk_br_2432", label: "Buk BR 2432", img: "/textures/wood/buk/buk_br_2432.png" },
    { id: "wood_buk_br_2436", label: "Buk BR 2436", img: "/textures/wood/buk/buk_br_2436.png" },
    { id: "wood_buk_br_2478", label: "Buk BR 2478", img: "/textures/wood/buk/buk_br_2478.png" },
    { id: "wood_buk_br_2503", label: "Buk BR 2503", img: "/textures/wood/buk/buk_br_2503.png" },
    { id: "wood_buk_br_2527", label: "Buk BR 2527", img: "/textures/wood/buk/buk_br_2527.png" },

    { id: "wood_buk_br_3023", label: "Buk BR 3023", img: "/textures/wood/buk/buk_br_3023.png" },
    { id: "wood_buk_br_3027", label: "Buk BR 3027", img: "/textures/wood/buk/buk_br_3027.png" },
    { id: "wood_buk_br_3028", label: "Buk BR 3028", img: "/textures/wood/buk/buk_br_3028.png" },
  ];

  // --- helpery pro "TOP + pĹ™ipnutĂˇ barva" ---
  const WOOD_BY_ID = new Map(WOOD_ALL.map(c => [c.id, c]));
  const WOOD_TOP_IDS = new Set(WOOD_TOP.map(c => c.id));

  // kdyĹľ user vybere barvu mimo TOP, pĹ™ipneme ji do "mĂ©nÄ› barev" na 1. pozici
  let pinnedWoodColorId = null;

  let showAllWoodColors = false;

  function getLegMaterialType(legCode) {
    const code = String(legCode || "").trim();
    const configured = LEG_META[code]?.material;
    if (configured === "wood" || configured === "metal") return configured;
    if (METAL_BY_LEG[code]) return "metal";
    return "wood";
  }

  function applyLegsToScene(legCode) {
    selectedLegs = legCode;

    for (const rec of activeModules) {
      if (!rec?.mesh) continue;

      forceLegsOnly(rec.mesh, selectedLegs);

      applyMendozaVisibility(rec.mesh, {
        armrestType: selectedArmrests || "smooth",
        legCode: selectedLegs,
      });

      applyMelbourneVisibility(rec.mesh, {
        legCode: selectedLegs,
      });

      applyManchesterVisibility(rec.mesh, {
        armrestType: selectedArmrests || "smooth",
        legCode: selectedLegs || "N21",
      });

      rec.mesh.updateMatrixWorld?.(true);
    }
  }

  function setActiveColor(colorId) {
    // UI active tile
    colorsGrid.querySelectorAll(".tileCard").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.color === colorId);
    });
    colorSelect.value = colorId;

    // zjisti typ nohy a materiĂˇl
    const legCode = typeSelect.value || selectedLegs || defaultLeg;
    const isWood = getLegMaterialType(legCode) === "wood";

    // pĹ™ebarvenĂ­ podle materiĂˇlu
    if (isWood) {
      applyWoodColorToAllLegs(colorId);
    } else {
      applyMetalColorToAllLegs(colorId);
    }
    
    if (isWood) {
      pinnedWoodColorId = WOOD_TOP_IDS.has(colorId) ? null : colorId;
    } else {
      pinnedWoodColorId = null; // jistota, aĹĄ se to netĂˇhne do kovu
    }

    if (!isRestoringState) saveStateDebounced();
  }

  function renderColorsForLeg(legCode) {
    const isWood = getLegMaterialType(legCode) === "wood";

    // zapamatuj si, co bylo vybranĂ© pĹ™ed pĹ™ekreslenĂ­m
    const prevSelected = colorSelect.value;

    // tlaÄŤĂ­tko "vĹˇechny" jen pro dĹ™evo
    if (btnShowAll) {
      btnShowAll.classList.toggle("hidden", !isWood);
      btnShowAll.textContent = showAllWoodColors ? "Zobrazit méně barev" : "Zobrazit více barev";
    }

    // kdyĹľ je ALL -> barvy zaberou celĂ˝ panel (schovajĂ­ typy)
    if (wrap) wrap.classList.toggle("is-colors-only", isWood && showAllWoodColors);

    // grid rozĹˇĂ­Ĺ™enĂ˝
    colorsGrid.classList.toggle("is-expanded", isWood && showAllWoodColors);

    const colorBlock = document.getElementById("legsColorBlock");
    if (colorBlock) colorBlock.classList.toggle("is-expanded", isWood && showAllWoodColors);

    // ----- sestavenĂ­ seznamu barev -----
    let list = [];

    if (isWood) {
      if (showAllWoodColors) {
        list = WOOD_ALL.slice();
      } else {
        // "mĂ©nÄ› barev" = TOP, ale kdyĹľ je vybranĂˇ mimo TOP, pĹ™ipni ji na prvnĂ­ pozici
        if (pinnedWoodColorId && !WOOD_TOP_IDS.has(pinnedWoodColorId)) {
          const pinned = WOOD_BY_ID.get(pinnedWoodColorId);
          if (pinned) {
            const rest = WOOD_TOP.filter(c => c.id !== pinned.id);
            list = [pinned, ...rest].slice(0, WOOD_TOP.length);
          } else {
            list = WOOD_TOP.slice();
          }
        } else {
          list = WOOD_TOP.slice();
        }
      }
    } else {
      list = (METAL_BY_LEG[legCode] || []).slice();
    }

    colorsGrid.innerHTML = "";
    colorSelect.innerHTML = "";

    if (list.length === 0) {
      colorsGrid.innerHTML = `<div style="opacity:.7;color:#fff">Pro tento typ zatím nejsou barvy.</div>`;
      return;
    }

    // ----- vyber aktivnĂ­ barvu: priorita = pĹ™edchozĂ­ vĂ˝bÄ›r, jinak prvnĂ­ v listu -----
    let activeColorId = prevSelected && list.some(c => c.id === prevSelected)
      ? prevSelected
      : list[0].id;

    // render options + tiles
    for (const c of list) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      colorSelect.appendChild(opt);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tileCard" + (c.id === activeColorId ? " is-active" : "");
      btn.dataset.color = c.id;

      btn.innerHTML = `
        <img class="tileImg" src="${escapeHtmlText(assetUrl(c.img))}" alt="${escapeHtmlText(c.label)}">
        <div class="tileTitle">${c.label}</div>
      `;

      btn.addEventListener("click", () => {
        hasUserTouchedLegs = true;
        setActiveColor(c.id);
      });
      colorsGrid.appendChild(btn);
    }

    // nastav aktivnĂ­ i do selectu + oznaÄŤenĂ­ v gridu (a pĹ™Ă­padnÄ› pĹ™ebarvenĂ­, pokud ho mĂˇĹˇ napojenĂ© v setActiveColor)
    setActiveColor(activeColorId);
  }

  function setActiveLeg(legCode) {
    // pĹ™i zmÄ›nÄ› nohy se ALL resetne, aby panel byl zase nĂ­zkĂ˝
    showAllWoodColors = false;

    legsRow.querySelectorAll(".tileCard").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.leg === legCode);
    });

    typeSelect.value = legCode;

    applyLegsToScene(legCode);
    renderColorsForLeg(legCode);
    if (!isRestoringState) saveStateDebounced();
  }

  // âś… DelegovanĂ˝ klik â€“ funguje i po pĹ™erenderu UI
  legsRow.__setActiveLeg = setActiveLeg;
  if (!legsRow.dataset.boundClick) {
    legsRow.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-leg]");
      if (!btn) return;
      const leg = btn.dataset.leg;
      if (!leg) return;
      hasUserTouchedLegs = true;
      legsRow.__setActiveLeg?.(leg);
    });
    legsRow.dataset.boundClick = "1";
  }

  const defaultLeg =
    (legsUiList[0] && legsUiList[0].code) ? legsUiList[0].code : getDefaultLegForModel();

  // TlaÄŤĂ­tko ALL barvy
  if (btnShowAll) {
    btnShowAll.onclick = () => {
      showAllWoodColors = !showAllWoodColors;
      renderColorsForLeg(typeSelect.value || selectedLegs || defaultLeg);
    };
  }

  // Init
  setActiveLeg(typeSelect.value || selectedLegs || defaultLeg);

  // âś… dovolĂ­me obnovu z localStorage (po reloadu)
  window.__setLegsFromState = (legCode, colorId) => {
    if (legCode) setActiveLeg(legCode);
    if (colorId && Array.from(colorSelect.options).some((opt) => opt.value === colorId)) {
      setActiveColor(colorId);
    }
  };
}

function hasMelbourneCornerInScene() {
  if (getModelKey() !== "MELBOURNE") return false;

  return (activeModules || []).some((rec) => {
    const variantId = getRecVariantId(rec);
    return /^Melbourne_roh_/i.test(variantId);
  });
}

function isMelbourneShelfAvailable() {
  return hasMelbourneCornerInScene();
}

function shouldShowMelbourneShelfTab() {
  return appState.step === 3 && isMelbourneShelfAvailable();
}

function shouldShowHingesTab() {
  const cfg = MODEL_EQUIP_CONFIG?.[getModelKey()] || null;
  return appState.step === 3 && Array.isArray(cfg?.hinges) && cfg.hinges.length > 0;
}

function shouldShowExtrasTab() {
  return appState.step === 3 && getModelKey() !== "MANCHESTER";
}

function syncMelbourneShelfTabVisibility() {
  const available = shouldShowMelbourneShelfTab();
  const tab = document.querySelector('#bottomBar .bottomTab[data-tab="shelf"]');
  if (tab) tab.classList.toggle("hidden", !available);

  if (!available && currentEquipTabKey === "shelf") {
    currentEquipTabKey = "legs";
    if (appState.step === 3) setBottomPanelByKey(currentEquipTabKey);
  }

  return available;
}

function renderShelfColorGrid() {
  const grid = document.getElementById("shelfColorGrid");
  const select = document.getElementById("shelfColorSelect");
  if (!grid || !select) return;

  const colors = WOOD_COLORS_ALL;
  const activeColor = selectedShelfColor || "wood_buk_br_281";

  grid.innerHTML = "";
  select.innerHTML = "";

  for (const c of colors) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    select.appendChild(opt);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tileCard" + (c.id === activeColor ? " is-active" : "");
    btn.dataset.shelfColor = c.id;
    btn.innerHTML = `
      <img class="tileImg" src="${escapeHtmlText(assetUrl(c.img))}" alt="${escapeHtmlText(c.label)}">
      <div class="tileTitle">${c.label}</div>
    `;

    grid.appendChild(btn);
  }

  select.value = activeColor;
}

function setActiveShelfColor(colorId, { fromUI = true } = {}) {
  const next = WOOD_COLORS_ALL.some((c) => c.id === colorId)
    ? colorId
    : "wood_buk_br_281";

  selectedShelfColor = next;

  const select = document.getElementById("shelfColorSelect");
  if (select) select.value = next;

  document.querySelectorAll("#shelfColorGrid .tileCard").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.shelfColor === next);
  });

  applyShelfColorToMelbournePlanes(next);

  if (fromUI && !isRestoringState) saveStateDebounced(80);
}

function bindShelfEquipmentUI() {
  const grid = document.getElementById("shelfColorGrid");
  const select = document.getElementById("shelfColorSelect");
  if (!grid || !select) return;

  renderShelfColorGrid();

  if (!grid.dataset.boundClick) {
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-shelf-color]");
      if (!btn) return;
      setActiveShelfColor(btn.dataset.shelfColor, { fromUI: true });
    });
    grid.dataset.boundClick = "1";
  }

  select.onchange = () => setActiveShelfColor(select.value, { fromUI: true });

  window.__setShelfColorFromState = (colorId) => {
    renderShelfColorGrid();
    setActiveShelfColor(colorId || selectedShelfColor || "wood_buk_br_281", { fromUI: false });
  };

  setActiveShelfColor(selectedShelfColor || "wood_buk_br_281", { fromUI: false });
}

function getManchesterSharpArmrestDiscountAmount(fabricGroup = getAppliedFabricPriceGroup()) {
  if (getModelKey() !== "MANCHESTER") return 0;

  let diff = 0;

  for (const rec of activeModules || []) {
    if (!rec?.name) continue;
    const upgradeKey = getUpgradeKeyForRec(rec);
    const basePrice = getSummaryPriceForRecSafe(rec, fabricGroup, upgradeKey, {
      disableManchesterArmrest: true,
      modelKey: "MANCHESTER",
    });
    const armrestPrice = getSummaryPriceForRecSafe(rec, fabricGroup, upgradeKey, {
      armrestType: "sharp",
      modelKey: "MANCHESTER",
    });
    const itemDiff = Number(basePrice) - Number(armrestPrice);
    if (Number.isFinite(itemDiff) && itemDiff > 0) diff += itemDiff;
  }

  return diff;
}

function getEquipTilePriceDeltaText(item, dataAttr) {
  if (dataAttr !== "armrest") return "";
  if (getModelKey() !== "MANCHESTER") return "";

  const code = String(item?.code || "").trim().toLowerCase();
  const selected = String(selectedArmrests || "smooth").trim().toLowerCase();

  // zobrazovat cenu jen u NEaktivní varianty
  if (!code || code === selected) return "";

  const rawDiff = getManchesterSharpArmrestDiscountAmount();
  const diff = getDiscountedAmount(rawDiff).final;

  if (!Number.isFinite(diff) || diff <= 0) return "";

  // Manchester:
  // smooth = Polohovací
  // sharp  = Hranatá

  // když je aktivní Polohovací, ukaž u Hranaté slevu
  if (selected === "smooth" && code === "sharp") {
    return `(- ${formatCzk(diff)})`;
  }

  // když je aktivní Hranatá, ukaž u Polohovací příplatek
  if (selected === "sharp" && code === "smooth") {
    return `(+ ${formatCzk(diff)})`;
  }

  return "";
}

function getEquipTileTitleHtml(item, dataAttr) {
  const delta = getEquipTilePriceDeltaText(item, dataAttr);

  return `
    <span class="tileTitleText">${escapeHtmlText(item?.label || "")}</span>
    ${delta ? `<span class="tilePriceDelta">${escapeHtmlText(delta)}</span>` : ""}
  `;
}

function refreshManchesterArmrestPriceLabels() {
  const row = document.getElementById("armrestsCardRow");
  if (!row) return;

  const modelConfig = MODEL_EQUIP_CONFIG[getModelKey()] || {};
  const armrestsUiList = Array.isArray(modelConfig.armrests) ? modelConfig.armrests : [];

  armrestsUiList.forEach((item) => {
    const code = String(item.code);
    const escapedCode = (typeof CSS !== "undefined" && CSS.escape)
      ? CSS.escape(code)
      : code.replace(/["\\]/g, "\\$&");
    const btn = row.querySelector(`button[data-armrest="${escapedCode}"]`);
    const title = btn?.querySelector(".tileTitle");
    if (title) title.innerHTML = getEquipTileTitleHtml(item, "armrest");
  });
}

function renderEquipBlock(list, container, dataAttr) {
  container.innerHTML = "";

  list.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tileCard" + (i === 0 ? " is-active" : "");
    btn.dataset[dataAttr] = item.code;

    btn.innerHTML = `
      ${item.img ? `<img class="tileImg" src="${escapeHtmlText(assetUrl(item.img))}">` : ""}
      <div class="tileTitle">${getEquipTileTitleHtml(item, dataAttr)}</div>
    `;

    container.appendChild(btn);
  });
}

function bindSofaDimsUI() {
  const wrap = document.getElementById("sofaDimsRows");
  if (!wrap) return;

  // =========================
  // 1) CONFIG (min/max + nĂˇzvy)
  // =========================
  const DIM_META = {
    W: { title: "Šířka" },
    D: { title: "Hloubka" },
    B: { title: "Bok" },
    L: { title: "Levý bok" },
    R: { title: "Pravý bok" },
  };

  // drĹľĂ­me hodnoty pro aktuĂˇlnÄ› zobrazenĂ© dimenze
  window.__sofaDims = window.__sofaDims || {};

  const clamp = (n, min, max) => {
    if (Number.isFinite(min)) n = Math.max(min, n);
    if (Number.isFinite(max)) n = Math.min(max, n);
    return n;
  };

  function shouldWarnAboutDepthSurcharge(dim, value, min, max) {
    const isDepthLike = dim === "D" || dim === "B" || dim === "L" || dim === "R";
    if (!isDepthLike) return false;

    // jen pro rozsah 150â€“200
    if (Number(min) !== 150 || Number(max) !== 200) return false;

    return Number(value) > 180;
  }

  function showDepthSurchargeModal(dim, value) {
    const existing = document.getElementById("depthSurchargeModal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "depthSurchargeModal";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.55)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "99999";

    const box = document.createElement("div");
    box.style.width = "min(620px, 92vw)";
    box.style.background = "#fff";
    box.style.borderRadius = "16px";
    box.style.padding = "20px";
    box.style.fontFamily =
      'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

    const title = document.createElement("div");
    title.textContent = "Prodloužení s příplatkem";
    title.style.fontSize = "18px";
    title.style.fontWeight = "700";
    title.style.marginBottom = "10px";

    const text = document.createElement("div");
    text.style.fontSize = "14px";
    text.style.lineHeight = "1.6";
    text.style.color = "rgba(0,0,0,0.78)";
    text.innerHTML = `
      Zvolený rozměr <strong>${value} cm</strong> spadá do pásma prodloužení nad 180 cm.<br>
      U této úpravy se připočítává <strong>příplatek 10 %</strong>.
    `;

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "18px";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Rozumím";
    btn.style.border = "1px solid rgba(0,0,0,0.12)";
    btn.style.background = "#fff";
    btn.style.borderRadius = "12px";
    btn.style.padding = "10px 14px";
    btn.style.cursor = "pointer";
    btn.onclick = () => overlay.remove();

    actions.appendChild(btn);
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(actions);
    overlay.appendChild(box);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  function showDimensionModuleChangeModal(direction) {
    const existing = document.getElementById("dimensionModuleChangeModal");
    if (existing) existing.remove();

    const wantsSmaller = direction === "smaller";
    const overlay = document.createElement("div");
    overlay.id = "dimensionModuleChangeModal";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.55)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "99999";

    const box = document.createElement("div");
    box.style.width = "min(620px, 92vw)";
    box.style.background = "#fff";
    box.style.borderRadius = "16px";
    box.style.padding = "20px";
    box.style.fontFamily =
      'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

    const title = document.createElement("div");
    title.textContent = "Rozměr je na hranici";
    title.style.fontSize = "18px";
    title.style.fontWeight = "700";
    title.style.marginBottom = "10px";

    const text = document.createElement("div");
    text.style.fontSize = "14px";
    text.style.lineHeight = "1.6";
    text.style.color = "rgba(0,0,0,0.78)";
    text.textContent = wantsSmaller
      ? "Pro menší rozměr je potřeba v kroku 2 vyměnit modul za užší variantu."
      : "Pro větší rozměr je potřeba v kroku 2 vyměnit modul za širší variantu.";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "18px";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Rozumím";
    btn.style.border = "1px solid rgba(0,0,0,0.12)";
    btn.style.background = "#fff";
    btn.style.borderRadius = "12px";
    btn.style.padding = "10px 14px";
    btn.style.cursor = "pointer";
    btn.onclick = () => overlay.remove();

    actions.appendChild(btn);
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(actions);
    overlay.appendChild(box);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  function setDimValueWithRules(dim, rawValue, min, max, { showWarning = true } = {}) {
    const next = clamp(rawValue, min, max);
    const prev = Number(window.__sofaDims[dim]);

    window.__sofaDims[dim] = next;

    if (!isRestoringState) {
      saveStateDebounced(50);
    }

    if (
      showWarning &&
      shouldWarnAboutDepthSurcharge(dim, next, min, max) &&
      (!Number.isFinite(prev) || prev <= 180)
    ) {
      showDepthSurchargeModal(dim, next);
    }

    return next;
  }

  function getSceneModulePlanNodes() {
    const nodes = [];
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();

    for (const rec of activeModules || []) {
      if (!rec?.mesh) continue;

      const root = getModuleRoot(rec.mesh);
      if (!root) continue;

      root.updateMatrixWorld(true);
      box.setFromObject(root);
      box.getCenter(center);
      box.getSize(size);

      nodes.push({
        rec,
        root,
        cx: center.x * 100,
        cz: center.z * 100,
        sx: size.x * 100,
        sz: size.z * 100,
        neighbors: {
          left: null,
          right: null,
          front: null,
          back: null
        }
      });
    }

    return nodes;
  }

  function linkSceneModulePlanNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length <= 1) return nodes || [];

    const median = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };

    const typicalX = median(nodes.map(n => Math.max(1, n.sx)));
    const typicalZ = median(nodes.map(n => Math.max(1, n.sz)));

    const overlapTolX = Math.max(8, typicalX * 0.18);
    const overlapTolZ = Math.max(8, typicalZ * 0.18);
    const touchTolX = Math.max(10, typicalX * 0.22);
    const touchTolZ = Math.max(10, typicalZ * 0.22);

    const setBest = (node, dir, candidate, gap) => {
      const prev = node.neighbors[dir];
      if (!prev || gap < prev.gap) {
        node.neighbors[dir] = { node: candidate, gap };
      }
    };

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];

        const dx = b.cx - a.cx;
        const dz = b.cz - a.cz;

        const expectedX = (a.sx + b.sx) * 0.5;
        const expectedZ = (a.sz + b.sz) * 0.5;

        const alignedZ = Math.abs(dz) <= overlapTolZ;
        const alignedX = Math.abs(dx) <= overlapTolX;

        const touchXGap = Math.abs(Math.abs(dx) - expectedX);
        const touchZGap = Math.abs(Math.abs(dz) - expectedZ);

        // left / right napojenĂ­
        if (alignedZ && touchXGap <= touchTolX) {
          if (dx > 0) {
            setBest(a, "right", b, touchXGap);
            setBest(b, "left", a, touchXGap);
          } else {
            setBest(a, "left", b, touchXGap);
            setBest(b, "right", a, touchXGap);
          }
        }

        // front / back napojenĂ­
        if (alignedX && touchZGap <= touchTolZ) {
          if (dz > 0) {
            setBest(a, "back", b, touchZGap);
            setBest(b, "front", a, touchZGap);
          } else {
            setBest(a, "front", b, touchZGap);
            setBest(b, "back", a, touchZGap);
          }
        }
      }
    }

    const nodeByRootUuid = new Map();
    const nodeByMeshUuid = new Map();

    for (const node of nodes) {
      const root = getModuleRoot(node?.root || node?.rec?.mesh || node?.mesh);
      if (root?.uuid) nodeByRootUuid.set(root.uuid, node);
      if (node?.rec?.mesh?.uuid) nodeByMeshUuid.set(node.rec.mesh.uuid, node);
    }

    const findNodeForMesh = (mesh) => {
      if (!mesh) return null;
      const root = getModuleRoot(mesh);
      if (root?.uuid && nodeByRootUuid.has(root.uuid)) {
        return nodeByRootUuid.get(root.uuid);
      }
      if (mesh?.uuid && nodeByMeshUuid.has(mesh.uuid)) {
        return nodeByMeshUuid.get(mesh.uuid);
      }
      return null;
    };

    for (const node of nodes) {
      const connections = node?.rec?.connections || {};

      for (const dir of ["left", "right", "front", "back"]) {
        const connectedNode = findNodeForMesh(connections[dir]);
        if (!connectedNode || connectedNode === node) continue;

        // Geometry touch heuristics can miss Melbourne modules because their
        // GLB boxes and corner offsets have larger visual overhangs. The saved
        // module connection is the source of truth for legal topology.
        node.neighbors[dir] = { node: connectedNode, gap: 0 };

        const opp = oppositeDirection(dir);
        if (opp && !connectedNode.neighbors?.[opp]) {
          connectedNode.neighbors[opp] = { node, gap: 0 };
        }
      }
    }

    for (const node of nodes) {
      for (const dir of ["left", "right", "front", "back"]) {
        node.neighbors[dir] = node.neighbors[dir]?.node || null;
      }
    }

    return nodes;
  }

  function getConnectedPlanNodes() {
    return linkSceneModulePlanNodes(getSceneModulePlanNodes());
  }

  window.__getConnectedPlanNodes = getConnectedPlanNodes;

  function getNodeVariantId(node) {
    const rec = node?.rec || node;
    return String(
      rec?.mesh?.userData?.variantId ??
      rec?.variantId ??
      rec?.name ??
      ""
    ).trim();
  }

  function isDepthBranchModule(node) {
    const variantId = getNodeVariantId(node);
    if (!variantId) return false;

    const v = String(variantId).trim().toUpperCase();

    // pĹ™esnÄ› Mendoza varianty, kterĂ© majĂ­ bĂ˝t branĂ© jako hloubkovĂˇ vÄ›tev
    if (
      v.endsWith("_1D_L") ||
      v.endsWith("_1XD_L") ||
      v.endsWith("_1D_P") ||
      v.endsWith("_1XD_P")
    ) {
      return true;
    }

    // obecnÄ›jĹˇĂ­ fallback
    if (/(^|_)1X?D(?:_|$)/i.test(v)) return true;

    const cat = (typeof getCatalog === "function") ? getCatalog(variantId) : null;
    const dr = cat?.depthRangeCm;

    const dMin = Number(dr?.min);
    const dMax = Number(dr?.max);

    return (
      Number.isFinite(dMin) &&
      Number.isFinite(dMax) &&
      dMin > 0 &&
      dMax > 0 &&
      dMin !== dMax
    );
  }

  function isDualAxisModule(node) {
    const variantId = getNodeVariantId(node);
    if (!variantId) return false;

    const v = String(variantId).trim().toUpperCase();

    // 1D / 1XD s levou nebo pravou orientacĂ­
    return (
      v.endsWith("_1D_L") ||
      v.endsWith("_1XD_L") ||
      v.endsWith("_1D_P") ||
      v.endsWith("_1XD_P") ||
      /(^|_)1X?D_[LP]$/i.test(v)
    );
  }

  window.__isDualAxisModule = isDualAxisModule;

  function isCornerModule(node) {
    const variantId = getNodeVariantId(node);
    if (!variantId) return false;

    return /ROH/i.test(String(variantId).trim());
  }

  function isActiveCornerNode(node) {
    if (!isCornerModule(node)) return false;

    const hasLeft = !!node?.neighbors?.left;
    const hasRight = !!node?.neighbors?.right;
    const hasFront = !!node?.neighbors?.front;
    const hasBack = !!node?.neighbors?.back;

    const hasHorizontal = hasLeft || hasRight;
    const hasVertical = hasFront || hasBack;

    // roh je aktivnĂ­ jen kdyĹľ mĂˇ opravdu vyuĹľitĂ© obÄ› osy
    return hasHorizontal && hasVertical;
  }

  function getPlanTopology() {
    const nodes = getConnectedPlanNodes();

    if (nodes.length <= 1) {
      return {
        branchCount: 1,
        cornerCount: 0,
        activeCornerCount: 0,
        depthModuleCount: 0,
        hasHorizontal: false,
        hasVertical: false,
        lSide: "left",
        hasLeftBranch: false,
        hasRightBranch: false
      };
    }

    let hasHorizontal = false;
    let hasVertical = false;
    let cornerCount = 0;
    let activeCornerCount = 0;

    const minX = Math.min(...nodes.map(n => n.cx));
    const maxX = Math.max(...nodes.map(n => n.cx));
    const midX = (minX + maxX) / 2;

    const branchSourceNodes = [];
    const endpointNodes = [];

    for (const n of nodes) {
      const hasLeft = !!n.neighbors.left;
      const hasRight = !!n.neighbors.right;
      const hasFront = !!n.neighbors.front;
      const hasBack = !!n.neighbors.back;

      const horizontalDegree = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
      const verticalDegree = (hasFront ? 1 : 0) + (hasBack ? 1 : 0);
      const degree = horizontalDegree + verticalDegree;

      if (horizontalDegree > 0) hasHorizontal = true;
      if (verticalDegree > 0) hasVertical = true;

      const isCorner = isCornerModule(n);
      const isActiveCorner = isActiveCornerNode(n);
      const isDepth = isDepthBranchModule(n);

      if (isCorner) cornerCount++;
      if (isActiveCorner) {
        activeCornerCount++;
        branchSourceNodes.push(n);
      }

      if (isDepth) {
        branchSourceNodes.push(n);
      }

      if (degree <= 1) {
        endpointNodes.push(n);
      }
    }

    const depthModuleCount = nodes.filter(n => isDepthBranchModule(n)).length;

    // hlavnĂ­ pravidlo:
    // novĂˇ vÄ›tev vznikĂˇ jen z:
    // - 1D / 1XD
    // - aktivnĂ­ho rohu
    const branchGenerators = depthModuleCount + activeCornerCount;

    let branchCount = 1;

    if (branchGenerators <= 0) {
      branchCount = 1;
    } else if (branchGenerators === 1) {
      branchCount = 2;
    } else if (branchGenerators === 2) {
      branchCount = 3;
    } else {
      branchCount = 4;
    }

    let hasLeftBranch = false;
    let hasRightBranch = false;

    for (const n of [...endpointNodes, ...branchSourceNodes]) {
      if (n.cx < midX - 1) hasLeftBranch = true;
      if (n.cx > midX + 1) hasRightBranch = true;
    }

    let lSide = "left";
    if (branchCount === 2) {
      lSide = hasRightBranch ? "right" : "left";
    }

    return {
      branchCount,
      cornerCount,
      activeCornerCount,
      depthModuleCount,
      hasHorizontal,
      hasVertical,
      lSide,
      hasLeftBranch,
      hasRightBranch
    };
  }

  window.__getPlanTopology = getPlanTopology;

  // =========================
  // 2) DETEKCE VÄšTVĂŤ (1 / 2 / 3)
  // =========================
  // Pozn.: Je to "heuristika" z rozptylu pozic modulĹŻ.
  // Pro UI (poÄŤet ovladaÄŤĹŻ) je to vÄ›tĹˇinou ĂşplnÄ› OK.
  function detectBranchCount() {
    try {
      const topo = getPlanTopology();
      const nodes = getConnectedPlanNodes?.() || [];

      if (!nodes.length) return 1;

      const widthAxisNodes = getMainWidthAxisNodes(nodes) || [];

      const widthAxisKeys = new Set(
        widthAxisNodes
          .map((n) => n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null)
          .filter(Boolean)
      );

      const widthCornerCount = widthAxisNodes.filter((n) => isCornerModule(n)).length;

      const nodesOutsideWidthAxis = nodes.filter((n) => {
        const key = n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;
        return key && !widthAxisKeys.has(key);
      });

      const topologyBranchCount = Math.max(1, Number(topo?.branchCount) || 1);

      // 4+ vÄ›tvĂ­ mĂˇ pĹ™ednost pĹ™ed speciĂˇlnĂ­mi U fallbacky nĂ­Ĺľe.
      // Jinak sestava se dvÄ›ma aktivnĂ­mi rohy a dalĹˇĂ­ vÄ›tvĂ­ spadne zpĂˇtky na 3.
      if (topologyBranchCount >= 4) {
        return topologyBranchCount;
      }

      // DĹ®LEĹ˝ITĂ‰:
      // Mendoza U mĹŻĹľe mĂ­t jen jednu "extra" boÄŤnĂ­ vÄ›tev mimo width osu,
      // protoĹľe druhĂˇ strana je uĹľ obsaĹľenĂˇ v pravĂ©m/levĂ©m rohu.
      // Ale tohle smĂ­ platit jen tehdy, kdyĹľ jsou aktivnĂ­ OBA rohy.
      // Roh pouĹľitĂ˝ jen jako zakonÄŤenĂ­ pohovky nesmĂ­ sĂˇm o sobÄ› zvednout
      // sestavu z 2 branches na 3 branches.
      if (
        widthCornerCount >= 2 &&
        Number(topo?.activeCornerCount || 0) >= 2 &&
        nodesOutsideWidthAxis.length >= 1
      ) {
        return 3;
      }

      return topologyBranchCount;
    } catch (e) {
      console.warn("detectBranchCount failed:", e);
      return 1;
    }
  }

  function getCurrentArmrestCatalogBaseCm() {
    const modelKey = String(appState?.model || "").trim().toUpperCase();

    // katalogové rozměry modulů jsou počítané vždy proti jednomu základnímu
    // rozměru područky pro daný model; aktuálně zvolená područka se přičítá
    // až jako delta zvlášť.
    //
    // Manchester má v catalogue.js rozměry počítané s područkou 40 cm,
    // proto se u modulů s područkou nejdřív odečte 40 cm a potom
    // se přičte aktuálně zvolená šířka područky.
    const DEFAULT_BASE_WIDTH_BY_MODEL = {
      MANILA: 20,
      MENDOZA: 25,
      MELBOURNE: 13,
      MANCHESTER: 40,
    };

    return Number(DEFAULT_BASE_WIDTH_BY_MODEL[modelKey] ?? 25);
  }

  function getCurrentArmrestRule() {
    const modelKey = String(appState?.model || "").trim().toUpperCase();
    const armType = String(window.selectedArmrests || selectedArmrests || "").trim().toLowerCase();

    const RULES = {
      MANILA: {
        smooth: { kind: "fixed", valueCm: 14 },
        sharp:  { kind: "variable", min: 10, max: 25, defaultCm: 20 },
      },

      MENDOZA: {
        smooth: { kind: "variable", min: 10, max: 25, defaultCm: 25 },
        sharp:  { kind: "fixed", valueCm: 33 },
      },

      MELBOURNE: {
        smooth: { kind: "fixed", valueCm: 13 },
      },

      // Manchester:
      // smooth = Polohovací
      // sharp  = Hranatá
      //
      // catalogue.js je počítaný s područkou 40 cm,
      // takže polohovací default 40 nechá katalogový rozměr beze změny.
      // Hranatá 25 cm zmenší každý modul s područkou o 15 cm za každou viditelnou područku.
      MANCHESTER: {
        smooth: { kind: "variable", min: 30, max: 40, defaultCm: 40 },
        sharp:  { kind: "variable", min: 15, max: 25, defaultCm: 25 },
      },
    };

    const byModel = RULES[modelKey] || null;
    return byModel?.[armType] || byModel?.smooth || null;
  }

  function getCurrentSelectedArmrestCm() {
    const rule = getCurrentArmrestRule();
    if (!rule) return 25;

    if (rule.kind === "fixed") {
      return Number(rule.valueCm);
    }

    const raw = Number(window.selectedArmrestSharpWidthCm || selectedArmrestSharpWidthCm);
    const fallback = Number(rule.defaultCm);
    const v = Number.isFinite(raw) ? raw : fallback;

    return Math.max(rule.min, Math.min(rule.max, v));
  }

  function getVariantArmrestCountFromCatalog(variantId) {
    const v = String(variantId || "").trim().toUpperCase();
    if (!v) return 0;

    // rohy bez podruÄŤek
    if (/ROH/i.test(v)) return 0;

    // kĹ™eslo = 2 podruÄŤky
    if (/KRESLO/i.test(v)) return 2;

    // bez podruÄŤek
    // napĹ™. ..._1M, ..._2M, ..._1XM, ..._2XM
    if (/_\d+X?M$/i.test(v)) return 0;

    // nÄ›kterĂ© otevĹ™enĂ© stĹ™edovĂ© / ottoman varianty bez podruÄŤky
    if (/_\d+X?MO_[LP]$/i.test(v)) return 0;

    // 1 podruÄŤkovĂ˝ modul s orientacĂ­
    // napĹ™. ..._1L, ..._1P, ..._1XL, ..._1XP
    if (/_\d+X?[LP]$/i.test(v)) return 1;

    // 1 podruÄŤkovĂ˝ modul s orientacĂ­ pĹ™es suffix
    // napĹ™. ..._1M_L, ..._1M_P, ..._1XM_L, ..._1XM_P
    if (/_\d+X?[MP]_[LP]$/i.test(v)) return 1;

    // depth moduly s 1 podruÄŤkou
    // napĹ™. ..._1D_L, ..._1D_P, ..._1XD_L, ..._1XD_P
    if (/_\d+X?D_[LP]$/i.test(v)) return 1;

    // 2-podruÄŤkovĂ˝ rovnĂ˝ modul
    // napĹ™. ..._1, ..._2, ..._1X, ..._2X
    if (/_\d+X?$/i.test(v)) return 2;

    return 0;
  }

  function getNodeCatalogInfo(node, mode = "min") {
    const variantId = getNodeVariantId(node);
    const cat = typeof getCatalog === "function" ? getCatalog(variantId) : null;

    const empty = {
      variantId,
      seatRaw: 0,
      seatBase: 0,
      depthRaw: 0,
      armCount: 0,
      isDepth: false,
      isDualAxis: false,
    };

    if (!cat) return empty;

    const useMin = mode === "min";
    const seatRange = cat.seatWidthRangeCm || {};
    const depthRange = cat.depthRangeCm || null;
    const dims = cat.dimsCm || {};

    const seatRaw = useMin ? Number(seatRange.min) : Number(seatRange.max);
    const safeSeatRaw = Number.isFinite(seatRaw) ? seatRaw : (Number(dims.w) || 0);

    const depthRaw = depthRange
      ? (useMin ? Number(depthRange.min) : Number(depthRange.max))
      : (Number(dims.d) || 0);

    const safeDepthRaw = Number.isFinite(depthRaw) ? depthRaw : (Number(dims.d) || 0);

    const armCount = getVariantArmrestCountFromCatalog(variantId);
    const catalogArmCm = getCurrentArmrestCatalogBaseCm();

    return {
      variantId,
      seatRaw: safeSeatRaw,
      seatBase: Math.max(0, safeSeatRaw - armCount * catalogArmCm),
      depthRaw: safeDepthRaw,
      armCount,
      isDepth: isDepthBranchModule(node),
      isDualAxis: isDualAxisModule(node),
    };
  }


  function getAxisXGroups(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return [];

    const sorted = nodes.slice().sort((a, b) => a.cz - b.cz);
    const groups = [];
    const tol = 18;

    for (const n of sorted) {
      let g = groups.find(gr => Math.abs(gr.cz - n.cz) <= tol);
      if (!g) {
        g = { cz: n.cz, nodes: [] };
        groups.push(g);
      }
      g.nodes.push(n);
      g.cz = g.nodes.reduce((s, x) => s + x.cz, 0) / g.nodes.length;
    }

    groups.forEach(g => g.nodes.sort((a, b) => a.cx - b.cx));
    return groups;
  }

  function getAxisXGroupsMapped(nodes, orientation) {
    if (!Array.isArray(nodes) || !nodes.length) return [];

    const items = nodes.map((n) => {
      const c = getMappedPlanCenter(n, orientation);
      return {
        node: n,
        px: c.x,
        pz: c.z
      };
    });

    const sorted = items.slice().sort((a, b) => a.pz - b.pz);
    const groups = [];
    const tol = 18;

    for (const it of sorted) {
      let g = groups.find(gr => Math.abs(gr.pz - it.pz) <= tol);
      if (!g) {
        g = { pz: it.pz, nodes: [] };
        groups.push(g);
      }
      g.nodes.push(it.node);
      g.pz = g.nodes
        .map(n => getMappedPlanCenter(n, orientation).z)
        .reduce((s, z) => s + z, 0) / g.nodes.length;
    }

    groups.forEach(g => {
      g.nodes.sort((a, b) => {
        const ax = getMappedPlanCenter(a, orientation).x;
        const bx = getMappedPlanCenter(b, orientation).x;
        return ax - bx;
      });
    });

    return groups;
  }

  function getMainWidthAxisNodes(nodes) {

    let orientation = "front";

    try {
      const straightNodes = nodes.filter(n => !isCornerModule(n));
      const anchorNode = straightNodes.length ? straightNodes[0] : nodes[0];
      const root = getModuleRoot(anchorNode?.root || anchorNode?.rec?.mesh || anchorNode?.mesh);
      orientation = getCardinalOrientationFromRoot(root);
    } catch (e) {
      orientation = "front";
    }

    const groups = getAxisXGroupsMapped(nodes, orientation);

    debugLog("WIDTH AXIS ORIENTATION", orientation);
    debugLog(
      "WIDTH GROUPS MAPPED",
      groups.map(g => g.nodes.map(n => getNodeVariantId(n)))
    );

    if (!groups.length) return [];

    const allCorners = nodes.filter(n => isCornerModule(n));
    const dualAxisNodes = nodes.filter(n => isDualAxisModule(n));

    let best = groups[0];
    let bestValue = -Infinity;

    for (const g of groups) {
      let sum = 0;
      for (const n of g.nodes) {
        const info = getNodeCatalogInfo(n, "min");
        sum += info.seatBase;
      }
      if (sum > bestValue) {
        bestValue = sum;
        best = g;
      }
    }

    // Speciální fix pro "1 roh + 1D":
    // pokud existuje řada, ve které je 1D spolu s běžným modulem,
    // je to silný signál, že právě tahle řada je skutečná world/main osa.
    // Nechceme pak vybrat boční řadu typu "roh + 2M".
    if (allCorners.length === 1 && dualAxisNodes.length === 1) {
      const dualAxisWidthGroups = groups.filter((g) => {
        const hasDualAxis = g.nodes.some(isDualAxisModule);
        const hasRegularMainNode = g.nodes.some((n) => !isCornerModule(n) && !isDualAxisModule(n));
        return hasDualAxis && hasRegularMainNode && g.nodes.length >= 2;
      });

      if (dualAxisWidthGroups.length) {
        let bestDualAxisGroup = dualAxisWidthGroups[0];
        let bestDualAxisValue = -Infinity;

        for (const g of dualAxisWidthGroups) {
          let sum = 0;
          for (const n of g.nodes) {
            const info = getNodeCatalogInfo(n, "min");
            sum += info.seatBase;
          }

          if (sum > bestDualAxisValue) {
            bestDualAxisValue = sum;
            bestDualAxisGroup = g;
          }
        }

        debugLog(
          "WIDTH AXIS CORNER+1D FIX",
          bestDualAxisGroup.nodes.map(n => getNodeVariantId(n))
        );

        return bestDualAxisGroup.nodes.slice();
      }
    }

    // Speciální fix pro U endpointy "1D_L + 1D_P":
    // když je mezi nimi jen jeden široký modul (2M/3M), row heuristika umí vybrat
    // jako width osu jen prostředek a obě 1D pak spadnou do side os s obřím rozměrem.
    // Správná width osa je vždy skutečná graph cesta mezi 1D_L a 1D_P.
    if (!allCorners.length && dualAxisNodes.length >= 2) {
      const leftDualAxisNode = dualAxisNodes.find((n) => /_1X?D_L$/i.test(getNodeVariantId(n))) || null;
      const rightDualAxisNode = dualAxisNodes.find((n) => /_1X?D_P$/i.test(getNodeVariantId(n))) || null;

      if (leftDualAxisNode && rightDualAxisNode) {
        const getNodeKey = (n) =>
          n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;

        const getNeighbors = (node) => {
          return [
            node?.neighbors?.left,
            node?.neighbors?.right,
            node?.neighbors?.front,
            node?.neighbors?.back,
          ].filter(Boolean);
        };

        const allowedNodes = nodes.filter((n) => {
          if (n === leftDualAxisNode || n === rightDualAxisNode) return true;
          if (isCornerModule(n)) return false;
          if (isDepthBranchModule(n) || isDualAxisModule(n)) return false;
          return true;
        });

        const allowedMap = new Map();
        for (const n of allowedNodes) {
          const key = getNodeKey(n);
          if (key) allowedMap.set(key, n);
        }

        const startKey = getNodeKey(leftDualAxisNode);
        const endKey = getNodeKey(rightDualAxisNode);
        const queue = [leftDualAxisNode];
        const visited = new Set(startKey ? [startKey] : []);
        const prev = new Map();

        while (queue.length) {
          const cur = queue.shift();
          const curKey = getNodeKey(cur);
          if (!curKey) continue;
          if (curKey === endKey) break;

          for (const nb of getNeighbors(cur)) {
            const nbKey = getNodeKey(nb);
            if (!nbKey) continue;
            if (!allowedMap.has(nbKey)) continue;
            if (visited.has(nbKey)) continue;

            visited.add(nbKey);
            prev.set(nbKey, curKey);
            queue.push(nb);
          }
        }

        if (startKey && endKey && visited.has(endKey)) {
          const pathKeys = [];
          let cur = endKey;

          while (cur) {
            pathKeys.push(cur);
            if (cur === startKey) break;
            cur = prev.get(cur) || null;
          }

          pathKeys.reverse();

          const dualAxisWidthPath = pathKeys
            .map((key) => allowedMap.get(key))
            .filter(Boolean);

          if (dualAxisWidthPath.length >= 3) {
            debugLog(
              "WIDTH AXIS DOUBLE 1D FIX",
              dualAxisWidthPath.map(n => getNodeVariantId(n))
            );

            return dualAxisWidthPath;
          }
        }
      }
    }

    const activeCorners = nodes.filter(n => isActiveCornerNode(n));
    const cornerCandidates = allCorners.length >= 2 ? allCorners : activeCorners;

    if (cornerCandidates.length >= 2) {
      const orderedCorners = cornerCandidates
        .slice()
        .sort((a, b) => {
          const ax = getMappedPlanCenter(a, orientation).x;
          const bx = getMappedPlanCenter(b, orientation).x;
          return ax - bx;
        });

      const leftCorner = orderedCorners[0];
      const rightCorner = orderedCorners[orderedCorners.length - 1];

      const leftC = getMappedPlanCenter(leftCorner, orientation);
      const rightC = getMappedPlanCenter(rightCorner, orientation);

      const topRowZ = (leftC.z + rightC.z) * 0.5;
      const minX = Math.min(leftC.x, rightC.x);
      const maxX = Math.max(leftC.x, rightC.x);

      const rowTol = 22;
      const sideTol = 18;

      const getNodeKey = (n) =>
        n?.root?.uuid || n?.rec?.mesh?.uuid || n?.rec?.name || null;

      const getNeighbors = (node) => {
        return [
          node?.neighbors?.left,
          node?.neighbors?.right,
          node?.neighbors?.front,
          node?.neighbors?.back,
        ].filter(Boolean);
      };

      const bfsPathBetweenCorners = (startNode, endNode, allowedNodes) => {
        const allowedMap = new Map();
        for (const n of allowedNodes) {
          const key = getNodeKey(n);
          if (key) allowedMap.set(key, n);
        }

        const startKey = getNodeKey(startNode);
        const endKey = getNodeKey(endNode);

        if (!startKey || !endKey || !allowedMap.has(startKey) || !allowedMap.has(endKey)) {
          return [];
        }

        const queue = [startNode];
        const visited = new Set([startKey]);
        const prev = new Map();

        while (queue.length) {
          const cur = queue.shift();
          const curKey = getNodeKey(cur);
          if (!curKey) continue;

          if (curKey === endKey) break;

          for (const nb of getNeighbors(cur)) {
            const nbKey = getNodeKey(nb);
            if (!nbKey) continue;
            if (!allowedMap.has(nbKey)) continue;
            if (visited.has(nbKey)) continue;

            visited.add(nbKey);
            prev.set(nbKey, curKey);
            queue.push(nb);
          }
        }

        if (!visited.has(endKey)) return [];

        const pathKeys = [];
        let cur = endKey;

        while (cur) {
          pathKeys.push(cur);
          if (cur === startKey) break;
          cur = prev.get(cur) || null;
        }

        pathKeys.reverse();

        return pathKeys.map((k) => allowedMap.get(k)).filter(Boolean);
      };

      const candidateWidthNodes = nodes.filter((n) => {
        if (n === leftCorner || n === rightCorner) return true;
        if (isDepthBranchModule(n) || isDualAxisModule(n)) return false;

        const c = getMappedPlanCenter(n, orientation);
        const inRow = Math.abs(c.z - topRowZ) <= rowTol;
        const inSpan = c.x >= (minX - sideTol) && c.x <= (maxX + sideTol);

        return inRow && inSpan;
      });

      const orderedWidth = bfsPathBetweenCorners(leftCorner, rightCorner, candidateWidthNodes);

      const finalOrderedWidth = orderedWidth.length
        ? orderedWidth
        : candidateWidthNodes.slice().sort((a, b) => {
            const ax = getMappedPlanCenter(a, orientation).x;
            const bx = getMappedPlanCenter(b, orientation).x;
            return ax - bx;
          });

      debugLog(
        "WIDTH AXIS DOUBLE CORNER FIX",
        finalOrderedWidth.map(n => getNodeVariantId(n))
      );

      debugLog("WIDTH AXIS DOUBLE CORNER FIX CENTERS", finalOrderedWidth.map((n) => {
        const c = getMappedPlanCenter(n, orientation);
        return { v: getNodeVariantId(n), x: c.x, z: c.z };
      }));

      if (orderedWidth.length >= 3) {
        return finalOrderedWidth;
      }
    }

    return best.nodes.slice();
  }

  window.__getMainWidthAxisNodes = getMainWidthAxisNodes;

  function getMappedPlanCenter(node, orientation) {
    const rect = getNodePlanRectMapped(node, orientation);
    return {
      x: (rect.minX + rect.maxX) * 0.5,
      z: (rect.minZ + rect.maxZ) * 0.5
    };
  }

  window.__getMappedPlanCenter = getMappedPlanCenter;

  function getSideDepthAxisNodes(nodes, widthAxisNodes) {
    const widthSet = new Set(widthAxisNodes);
    const orientation = getPlanRenderOrientation(nodes);

    const pushUnique = (arr, node) => {
      if (node && !arr.includes(node)) arr.push(node);
    };

    const getAllNeighbors = (node) => {
      return [
        node?.neighbors?.left,
        node?.neighbors?.right,
        node?.neighbors?.front,
        node?.neighbors?.back
      ].filter(Boolean);
    };

    const widthCenters = widthAxisNodes.map(n => ({
      node: n,
      c: getMappedPlanCenter(n, orientation)
    }));

    const orderedWidth = widthCenters
      .slice()
      .sort((a, b) => a.c.x - b.c.x);

    const leftWidthAnchor = orderedWidth[0]?.node || null;
    const rightWidthAnchor = orderedWidth[orderedWidth.length - 1]?.node || null;

    const widthMidX =
      orderedWidth.reduce((s, it) => s + it.c.x, 0) / Math.max(1, orderedWidth.length);

    // -------------------------
    // 1) Najdi skuteÄŤnĂ© "starty" boÄŤnĂ­ch vÄ›tvĂ­:
    //    jen pĹ™es front/back odboÄŤku z width osy
    // -------------------------
    const leftStarters = [];
    const rightStarters = [];
    const leftAnchors = [];
    const rightAnchors = [];

    for (const a of widthAxisNodes) {
      const aCenter = getMappedPlanCenter(a, orientation);

      const depthNeighbors = [a.neighbors.front, a.neighbors.back].filter(Boolean);

      for (const nb of depthNeighbors) {
        // starter musĂ­ bĂ˝t mimo ÄŤistou width osu,
        // nebo musĂ­ bĂ˝t bridge modul (roh / 1D / dual-axis)
        const nbIsBridge =
          isActiveCornerNode(nb) ||
          isDepthBranchModule(nb) ||
          isDualAxisModule(nb);

        if (widthSet.has(nb) && !nbIsBridge) continue;

        const anchorIsLeft =
          a === leftWidthAnchor ||
          (leftWidthAnchor && getMappedPlanCenter(a, orientation).x <= getMappedPlanCenter(leftWidthAnchor, orientation).x + 8);

        const anchorIsRight =
          a === rightWidthAnchor ||
          (rightWidthAnchor && getMappedPlanCenter(a, orientation).x >= getMappedPlanCenter(rightWidthAnchor, orientation).x - 8);

        let isLeftSide = false;

        if (anchorIsLeft && !anchorIsRight) {
          isLeftSide = true;
        } else if (anchorIsRight && !anchorIsLeft) {
          isLeftSide = false;
        } else {
          const nbCenter = getMappedPlanCenter(nb, orientation);
          const widthMidX =
            orderedWidth.reduce((s, it) => s + it.c.x, 0) / Math.max(1, orderedWidth.length);

          isLeftSide = nbCenter.x < widthMidX;
        }

        if (isLeftSide) {
          pushUnique(leftStarters, nb);
          pushUnique(leftAnchors, a);
        } else {
          pushUnique(rightStarters, nb);
          pushUnique(rightAnchors, a);
        }
      }
    }

    // -------------------------
    // 2) Projdi kaĹľdou vÄ›tev zvlĂˇĹˇĹĄ, ale:
    //    - nikdy nepĹ™eskakuj pĹ™es ÄŤistĂ˝ width modul
    //    - nikdy nepĹ™elejvej jednu vÄ›tev do druhĂ©
    // -------------------------
    function collectBranch(starters, ownAnchors) {
      const out = [];
      const queue = [...starters];
      const visited = new Set();

      while (queue.length) {
        const cur = queue.shift();
        if (!cur || visited.has(cur)) continue;
        visited.add(cur);

        const curIsBridge =
          isActiveCornerNode(cur) ||
          isDepthBranchModule(cur) ||
          isDualAxisModule(cur) ||
          isCornerModule(cur);

        const curInWidth = widthSet.has(cur);

        // bridge modul nebo modul mimo width osu do vÄ›tve patĹ™Ă­
        if (!curInWidth || curIsBridge) {
          pushUnique(out, cur);
        }

        for (const nb of getAllNeighbors(cur)) {
          if (!nb || visited.has(nb)) continue;

          const nbIsBridge =
            isActiveCornerNode(nb) ||
            isDepthBranchModule(nb) ||
            isDualAxisModule(nb) ||
            isCornerModule(nb);

          const nbInWidth = widthSet.has(nb);

          // pĹ™es obyÄŤejnĂ˝ width modul se dĂˇl neĹˇĂ­Ĺ™Ă­me
          if (nbInWidth && !nbIsBridge) continue;

          // nevracej se do width anchorĹŻ druhĂ© vÄ›tve
          if (widthSet.has(nb) && !ownAnchors.includes(nb)) continue;

          queue.push(nb);
        }
      }

      return out;
    }

    const seedBranchFromWidthAnchor = (anchorNode, starters, anchors) => {
      if (!anchorNode) return;

      for (const nb of getAllNeighbors(anchorNode)) {
        if (!nb) continue;

        const nbInWidth = widthSet.has(nb);
        const nbIsBridge =
          isActiveCornerNode(nb) ||
          isDepthBranchModule(nb) ||
          isDualAxisModule(nb) ||
          isCornerModule(nb);

        // chceme seednout vĹˇe, co vede mimo ÄŤistou width osu,
        // a zĂˇroveĹ i bridge moduly navĂˇzanĂ© na anchor
        if (!nbInWidth || nbIsBridge) {
          pushUnique(starters, nb);
          pushUnique(anchors, anchorNode);
        }
      }
    };

    // dĹŻleĹľitĂ©:
    // i kdyĹľ se starter nenaĹˇel pĹ™i prĹŻchodu width osy,
    // rohovĂ˝ anchor musĂ­ umÄ›t vÄ›tev "nastartovat" sĂˇm
    seedBranchFromWidthAnchor(leftWidthAnchor, leftStarters, leftAnchors);
    seedBranchFromWidthAnchor(rightWidthAnchor, rightStarters, rightAnchors);

    let left = collectBranch(leftStarters, leftAnchors);
    let right = collectBranch(rightStarters, rightAnchors);

    // -------------------------
    // 3) Rohy na krajĂ­ch width osy musĂ­ patĹ™it do pĹ™Ă­sluĹˇnĂ© boÄŤnĂ­ vÄ›tve
    //    i kdyĹľ zrovna nejsou oznaÄŤenĂ© jako "active corner"
    // -------------------------
    for (const n of nodes) {
      if (!isCornerModule(n) && !isActiveCornerNode(n)) continue;
      if (!widthSet.has(n)) continue;

      const c = getMappedPlanCenter(n, orientation);

      if (leftWidthAnchor && n === leftWidthAnchor) {
        pushUnique(left, n);
        continue;
      }

      if (rightWidthAnchor && n === rightWidthAnchor) {
        pushUnique(right, n);
        continue;
      }

      if (c.x < widthMidX) pushUnique(left, n);
      else pushUnique(right, n);
    }

    // -------------------------
    // 4) KdyĹľ je ve vÄ›tvi 1D, nesmĂ­ se pĹ™es nÄ›j vÄ›tev dĂˇl "nafouknout" o druhou stranu
    //    => branch s 1D nech jako jejĂ­ vlastnĂ­ komponentu + pĹ™Ă­padnĂ˝ roh pĹ™ed nĂ­
    // -------------------------
    const keepOnlyRelevantForDepth = (arr) => {
      const hasDepth = arr.some(n => isDepthBranchModule(n));
      if (!hasDepth) return arr;

      return arr.filter((n) => {
        return (
          isDepthBranchModule(n) ||
          isDualAxisModule(n) ||
          isActiveCornerNode(n) ||
          isCornerModule(n) ||
          !widthSet.has(n)
        );
      });
    };

    left = keepOnlyRelevantForDepth(left);
    right = keepOnlyRelevantForDepth(right);

    // KdyĹľ se na jednĂ© stranÄ› nenaĹˇel ĹľĂˇdnĂ˝ starter,
    // ale krajnĂ­ roh width osy existuje, musĂ­ aspoĹ ten roh zĹŻstat v boÄŤnĂ­ vÄ›tvi.
    if (!left.length && leftWidthAnchor) {
      pushUnique(left, leftWidthAnchor);
    }

    if (!right.length && rightWidthAnchor) {
      pushUnique(right, rightWidthAnchor);
    }

    // -------------------------
    // 5) Fallback pro depth moduly, kterĂ© se zatĂ­m nezaĹ™adily nikam:
    //    1D / 1XD musĂ­ bĂ˝t vĹľdy aspoĹ v jednĂ© boÄŤnĂ­ vÄ›tvi,
    //    jinak zmizĂ­ i ze ĹˇĂ­Ĺ™ky.
    // -------------------------
    const assigned = new Set([...left, ...right]);

    for (const n of nodes) {
      if (assigned.has(n)) continue;
      if (widthSet.has(n)) continue;
      if (!isDepthBranchModule(n)) continue;

      const c = getMappedPlanCenter(n, orientation);

      if (c.x < widthMidX) {
        pushUnique(left, n);
      } else {
        pushUnique(right, n);
      }
    }

    debugLog("SIDE AXIS AFTER ANCHOR SEED", {
      leftStartersAfterSeed: leftStarters.map(getNodeVariantId),
      rightStartersAfterSeed: rightStarters.map(getNodeVariantId),
      leftAnchorsAfterSeed: leftAnchors.map(getNodeVariantId),
      rightAnchorsAfterSeed: rightAnchors.map(getNodeVariantId),
    });

    debugLog("SIDE AXIS ANCHORS", {
      widthAxis: widthAxisNodes.map(getNodeVariantId),
      leftWidthAnchor: leftWidthAnchor ? getNodeVariantId(leftWidthAnchor) : null,
      rightWidthAnchor: rightWidthAnchor ? getNodeVariantId(rightWidthAnchor) : null,
      leftStarters: leftStarters.map(getNodeVariantId),
      rightStarters: rightStarters.map(getNodeVariantId),
    });

    debugLog("SIDE AXIS FINAL AFTER CORNER FALLBACK", {
      left: left.map(n => getNodeVariantId(n)),
      right: right.map(n => getNodeVariantId(n)),
      leftHasAnchor: !!(leftWidthAnchor && left.includes(leftWidthAnchor)),
      rightHasAnchor: !!(rightWidthAnchor && right.includes(rightWidthAnchor)),
    });

    debugLog("getSideDepthAxisNodes -> left", left.map(n => getNodeVariantId(n)));
    debugLog("getSideDepthAxisNodes -> right", right.map(n => getNodeVariantId(n)));

    return { left, right };
  }

  window.__getSideDepthAxisNodes = getSideDepthAxisNodes;

  function isNodeInWidthAxis(node, widthAxisNodes) {
    return widthAxisNodes.includes(node);
  }

  function isNodeInDepthAxis(node, depthAxisNodes) {
    return depthAxisNodes.includes(node);
  }

  function getWidthAxisArmrestCount(widthAxisNodes) {
    let count = 0;

    for (const n of widthAxisNodes) {
      const info = getNodeCatalogInfo(n, "min");
      if (info.armCount <= 0) continue;

      const hasLeft = !!n.neighbors.left;
      const hasRight = !!n.neighbors.right;
      const role = getRole(getNodeVariantId(n));

      // 1D / 1XD = speciĂˇlnĂ­ dual-axis modul
      // musĂ­ umÄ›t pĹ™idat podruÄŤku do width osy podle skuteÄŤnÄ› otevĹ™enĂ©ho konce
      if (info.isDualAxis) {
        if (role === "L") {
          if (!hasLeft) count += 1;
        } else if (role === "P") {
          if (!hasRight) count += 1;
        } else {
          if (!hasLeft) count += 1;
          if (!hasRight) count += 1;
        }
        continue;
      }

      if (info.armCount === 2) {
        if (!hasLeft) count += 1;
        if (!hasRight) count += 1;
        continue;
      }

      if (role === "L") {
        if (!hasLeft) count += 1;
      } else if (role === "P") {
        if (!hasRight) count += 1;
      } else {
        if (!hasLeft && !hasRight) count += 1;
      }
    }

    return count;
  }

  function getDepthAxisArmrestCount(depthAxisNodes) {
    return getBranchArmrestCount(depthAxisNodes);
  }

  function getBranchArmrestCount(branchNodes) {
    const nodes = Array.isArray(branchNodes) ? branchNodes.filter(Boolean) : [];
    const branchSet = new Set(nodes);
    let count = 0;

    for (const n of nodes) {
      const variantId = getNodeVariantId(n);
      if (/roh/i.test(String(variantId || ""))) continue;

      const info = getNodeCatalogInfo(n, "min");
      if (info.armCount <= 0) continue;

      // 1D v depth ose nikdy nepĹ™iÄŤĂ­tĂˇ podruÄŤku
      if (info.isDepth) continue;

      const role = getRole(variantId);
      const sides = [];

      if (info.armCount >= 2) {
        sides.push("left", "right");
      } else if (role === "L") {
        sides.push("left");
      } else if (role === "P") {
        sides.push("right");
      } else {
        sides.push("left", "right");
      }

      for (const side of sides) {
        const neighbor = n.neighbors?.[side] || null;
        if (!neighbor || !branchSet.has(neighbor)) {
          count += 1;
          if (info.armCount === 1) break;
        }
      }
    }

    return count;
  }

  function sumWidthAxis(widthAxisNodes, depthAxisNodes, mode = "min") {
    let total = 0;

    for (const n of widthAxisNodes) {
      const info = getNodeCatalogInfo(n, mode);

      // bÄ›ĹľnĂ˝ modul v hlavnĂ­ ĹˇĂ­Ĺ™kovĂ© ose
      total += info.seatBase;
    }

    // 1D musĂ­ ovlivnit i ĹˇĂ­Ĺ™ku, i kdyĹľ souÄŤasnÄ› leĹľĂ­ i v depth ose
    for (const n of depthAxisNodes) {
      const info = getNodeCatalogInfo(n, mode);
      if (!info.isDepth) continue;
      if (widthAxisNodes.includes(n)) continue;

      total += info.seatBase;
    }

    return total;
  }

  window.__sumWidthAxis = sumWidthAxis;

  function sumDepthAxis(depthAxisNodes, mode = "min") {
    let total = 0;

    for (const n of depthAxisNodes) {
      const info = getNodeCatalogInfo(n, mode);
      const variantId = getNodeVariantId(n);

      if (info.isDepth) {
        total += info.depthRaw;   // 1D = depthRangeCm
        continue;
      }

      // roh i bÄ›ĹľnĂ˝ modul v boÄŤnĂ­ vÄ›tvi = seatBase
      if (/roh/i.test(String(variantId || ""))) {
        total += info.seatBase;
        continue;
      }

      total += info.seatBase;
    }

    return total;
  }

  window.__sumDepthAxis = sumDepthAxis;

  function getAxisGroupsByCenter(nodes, axis = "z") {
    if (!Array.isArray(nodes) || !nodes.length) return [];

    const key = axis === "x" ? "cx" : "cz";
    const sizeKey = axis === "x" ? "sx" : "sz";

    const sorted = nodes.slice().sort((a, b) => a[key] - b[key]);
    const groups = [];

    const median = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };

    const typicalSize = median(sorted.map(n => Math.max(1, Number(n[sizeKey]) || 1)));
    const tol = Math.max(18, typicalSize * 0.22);

    for (const n of sorted) {
      let g = groups.find(gr => Math.abs(gr.center - n[key]) <= tol);
      if (!g) {
        g = { center: n[key], nodes: [] };
        groups.push(g);
      }
      g.nodes.push(n);
      g.center = g.nodes.reduce((s, x) => s + x[key], 0) / g.nodes.length;
    }

    return groups;
  }

  function getPlanBoundsForNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const n of nodes) {
      const x1 = n.cx - n.sx / 2;
      const x2 = n.cx + n.sx / 2;
      const z1 = n.cz - n.sz / 2;
      const z2 = n.cz + n.sz / 2;

      if (x1 < minX) minX = x1;
      if (x2 > maxX) maxX = x2;
      if (z1 < minZ) minZ = z1;
      if (z2 > maxZ) maxZ = z2;
    }

    return { minX, maxX, minZ, maxZ };
  }

  // ======================================
  // PLAN ORIENTATION HELPERS (WORLD -> PLAN)
  // ======================================

  function getCardinalOrientationFromRoot(root) {
    if (!root) return "front";

    const worldQ = new THREE.Quaternion();
    root.getWorldQuaternion(worldQ);

    const frontDir = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQ);
    const x = frontDir.x;
    const z = frontDir.z;

    // malĂˇ tolerance proti chvÄ›nĂ­ kolem diagonĂˇl
    const eps = 0.0001;

    if (Math.abs(z) >= Math.abs(x) - eps) {
      return z < 0 ? "front" : "back";
    }

    return x > 0 ? "right" : "left";
  }

  function isSceneRotated90ForPlan(nodes = null) {
    const planNodes = Array.isArray(nodes) && nodes.length
      ? nodes
      : (getConnectedPlanNodes?.() || []);

    if (!planNodes.length) return false;

    const straightNodes = planNodes.filter(n => !isCornerModule(n));
    const candidates = straightNodes.length ? straightNodes : planNodes;

    const anchorNode = candidates[0];
    const root = getModuleRoot(anchorNode?.root || anchorNode?.rec?.mesh || anchorNode?.mesh);
    const o = getCardinalOrientationFromRoot(root);

    return o === "left" || o === "right";
  }

  function getOppositePlanOrientation(orientation) {
    switch (orientation) {
      case "front": return "back";
      case "back": return "front";
      case "left": return "right";
      case "right": return "left";
      default: return orientation || "front";
    }
  }

  function getPlanRenderOrientation(nodes = null) {
    const planNodes = Array.isArray(nodes) && nodes.length
      ? nodes
      : (getConnectedPlanNodes?.() || []);

    if (!planNodes.length) return "front";

    const getSceneOrientationFallback = () => {
      const straightNodes = planNodes.filter(n => !isCornerModule(n));
      const candidates = straightNodes.length ? straightNodes : planNodes;

      const sorted = candidates
        .slice()
        .sort((a, b) => {
          if (Math.abs(a.cz - b.cz) > 1) return a.cz - b.cz;
          return a.cx - b.cx;
        });

      const anchorNode = sorted[0];
      const root = getModuleRoot(anchorNode?.root || anchorNode?.rec?.mesh || anchorNode?.mesh);
      return getCardinalOrientationFromRoot(root);
    };

    const branchCount = Math.max(1, Number(detectBranchCount?.() || 1));
    const widthAxisNodes = getMainWidthAxisNodes(planNodes);

    // =========================================
    // SPECIĂLNĂŤ PRAVIDLO PRO U (3 vÄ›tve):
    // prostĹ™ednĂ­ / hlavnĂ­ vÄ›tev musĂ­ bĂ˝t v pĹŻdorysu vĹľdy NAHOĹE.
    // Tzn. vyber orientaci, kterĂˇ:
    // 1) udÄ›lĂˇ z widthAxis vodorovnou hornĂ­ pĹ™Ă­ÄŤku
    // 2) poĹˇle boÄŤnĂ­ vÄ›tve smÄ›rem dolĹŻ
    // =========================================
    const topo = getPlanTopology();

    // SpeciĂˇlnĂ­ "U orientace" jen pro skuteÄŤnĂ© U s aktivnĂ­m rohem.
    // Sestava 1D - modul - 1D sice vychĂˇzĂ­ branchCount === 3,
    // ale nenĂ­ to klasickĂ© rohovĂ© U a nemĂˇ se nĂˇsilnÄ› pĹ™etĂˇÄŤet bokem.
    if (branchCount === 3 && isSceneRotated90ForPlan(planNodes)) {

      const orientations = ["front", "right", "back", "left"];

      const getMappedRect = (node, orientation) => {
        return getNodePlanRectMapped(node, orientation);
      };

      const getMappedCenter = (node, orientation) => {
        const rect = getMappedRect(node, orientation);
        return {
          x: (rect.minX + rect.maxX) * 0.5,
          z: (rect.minZ + rect.maxZ) * 0.5
        };
      };

      const getDegree = (node) => {
        return (node?.neighbors?.left ? 1 : 0)
          + (node?.neighbors?.right ? 1 : 0)
          + (node?.neighbors?.front ? 1 : 0)
          + (node?.neighbors?.back ? 1 : 0);
      };

      const median = (arr) => {
        const a = arr.slice().sort((x, y) => x - y);
        const mid = Math.floor(a.length / 2);
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
      };

      const buildRowsForOrientation = (orientation) => {
        const items = planNodes.map((n) => {
          const rect = getMappedRect(n, orientation);
          return {
            node: n,
            rect,
            cx: (rect.minX + rect.maxX) * 0.5,
            cz: (rect.minZ + rect.maxZ) * 0.5,
            sx: rect.maxX - rect.minX,
            sz: rect.maxZ - rect.minZ
          };
        });

        const typicalDepth = median(items.map(i => Math.max(1, i.sz)));
        const rowTol = Math.max(14, typicalDepth * 0.35);

        const rows = [];
        const sorted = items.slice().sort((a, b) => a.cz - b.cz);

        for (const it of sorted) {
          let row = rows.find(r => Math.abs(it.cz - r.cz) <= rowTol);
          if (!row) {
            row = { cz: it.cz, items: [] };
            rows.push(row);
          }
          row.items.push(it);
          row.cz = row.items.reduce((s, x) => s + x.cz, 0) / row.items.length;
        }

        for (const row of rows) {
          row.minX = Math.min(...row.items.map(i => i.rect.minX));
          row.maxX = Math.max(...row.items.map(i => i.rect.maxX));
          row.minZ = Math.min(...row.items.map(i => i.rect.minZ));
          row.maxZ = Math.max(...row.items.map(i => i.rect.maxZ));
          row.spanX = row.maxX - row.minX;
          row.spanZ = row.maxZ - row.minZ;
          row.midX = (row.minX + row.maxX) * 0.5;
          row.midZ = (row.minZ + row.maxZ) * 0.5;
        }

        return rows;
      };

      let bestOrientation = "front";
      let bestScore = -Infinity;

      for (const orientation of orientations) {
        const rows = buildRowsForOrientation(orientation);
        if (!rows.length) continue;

        let bestRow = null;
        let bestRowScore = -Infinity;

        for (const row of rows) {
          let rowScore = 0;

          // chceme dlouhou vodorovnou prostĹ™ednĂ­ vÄ›tev
          rowScore += row.spanX * 12;
          rowScore -= row.spanZ * 30;

          // lehce preferuj Ĺ™adu vĂ˝Ĺˇ v plĂˇnku
          rowScore -= row.midZ * 0.02;

          // roh / 1D / endpoint v Ĺ™adÄ› je dobrĂ˝ signĂˇl, Ĺľe jde o "hlavnĂ­" U pĹ™Ă­ÄŤku
          let branchSignalsInRow = 0;
          for (const it of row.items) {
            const n = it.node;
            const degree = getDegree(n);
            if (
              isDepthBranchModule(n) ||
              isDualAxisModule(n) ||
              isActiveCornerNode(n) ||
              degree <= 2
            ) {
              branchSignalsInRow++;
            }
          }

          rowScore += branchSignalsInRow * 60;

          if (rowScore > bestRowScore) {
            bestRowScore = rowScore;
            bestRow = row;
          }
        }

        if (!bestRow) continue;

        let belowCount = 0;
        let aboveCount = 0;
        let leftBelow = 0;
        let rightBelow = 0;

        for (const n of planNodes) {
          const c = getMappedCenter(n, orientation);

          const insideBestRow =
            c.z >= bestRow.minZ - 1 &&
            c.z <= bestRow.maxZ + 1 &&
            c.x >= bestRow.minX - 1 &&
            c.x <= bestRow.maxX + 1;

          if (insideBestRow) continue;

          const degree = getDegree(n);
          const isEndpoint = degree <= 1;
          const isBranchLike =
            isDepthBranchModule(n) ||
            isDualAxisModule(n) ||
            isActiveCornerNode(n) ||
            isEndpoint;

          if (!isBranchLike) continue;

          const dz = c.z - bestRow.midZ;

          if (dz > 1) {
            belowCount++;
            if (c.x < bestRow.midX - 2) leftBelow++;
            if (c.x > bestRow.midX + 2) rightBelow++;
          } else if (dz < -1) {
            aboveCount++;
          }
        }

        let score = bestRowScore;

        // chceme vÄ›tve dole
        score += belowCount * 220;
        score -= aboveCount * 300;

        // chceme obÄ› vÄ›tve: vlevo dole i vpravo dole
        if (leftBelow > 0) score += 900;
        if (rightBelow > 0) score += 900;

        // kdyĹľ jsou obÄ›, je to skoro jistĂ© U sprĂˇvnÄ› otoÄŤenĂ©
        if (leftBelow > 0 && rightBelow > 0) score += 1200;

        if (score > bestScore) {
          bestScore = score;
          bestOrientation = orientation;
        }
      }

      return bestOrientation;
    }

    // =========================================
    // SPECIĂLNĂŤ PRAVIDLO PRO L (2 vÄ›tve s aktivnĂ­m rohem):
    // chceme, aby hlavnĂ­ vÄ›tev byla nahoĹ™e vodorovnÄ›
    // a odboÄŤka Ĺˇla dolĹŻ na jednu stranu.
    // To opravĂ­ pĹ™Ă­pady po smazĂˇnĂ­ prvnĂ­ho modulu,
    // kdy starĂ˝ anchor fallback vezme ĹˇpatnĂ˝ uzel.
    // =========================================
    if (branchCount === 2 && Number(topo?.activeCornerCount || 0) > 0) {
      return getSceneOrientationFallback();
    }

    // =========================================
    // PĹ®VODNĂŤ CHOVĂNĂŤ PRO 1 / 4+ vÄ›tvĂ­
    // =========================================
    if (widthAxisNodes.length) {
      const sorted = widthAxisNodes
        .slice()
        .sort((a, b) => {
          if (Math.abs(a.cz - b.cz) > 1) return a.cz - b.cz;
          return a.cx - b.cx;
        });

      const anchorNode = sorted[0];
      const root = getModuleRoot(anchorNode?.root || anchorNode?.rec?.mesh || anchorNode?.mesh);
      return getCardinalOrientationFromRoot(root);
    }

    return getSceneOrientationFallback();
  }

  window.__getPlanRenderOrientation = getPlanRenderOrientation;

  function mapWorldPointToPlanAxes(x, z, orientation = null) {
    const o = orientation || getPlanRenderOrientation();

    switch (o) {
      case "front":
        return { x, z };

      case "right":
        return { x: z, z: -x };

      case "back":
        return { x: -x, z: -z };

      case "left":
        return { x: -z, z: x };

      default:
        return { x, z };
    }
  }

  function getNodePlanRectMapped(node, orientation = null) {
    if (!node) {
      return {
        minX: 0,
        maxX: 0,
        minZ: 0,
        maxZ: 0
      };
    }

    const o = orientation || getPlanRenderOrientation();

    const pts = [
      mapWorldPointToPlanAxes(node.cx - node.sx / 2, node.cz - node.sz / 2, o),
      mapWorldPointToPlanAxes(node.cx + node.sx / 2, node.cz - node.sz / 2, o),
      mapWorldPointToPlanAxes(node.cx + node.sx / 2, node.cz + node.sz / 2, o),
      mapWorldPointToPlanAxes(node.cx - node.sx / 2, node.cz + node.sz / 2, o),
    ];

    return {
      minX: Math.min(...pts.map(p => p.x)),
      maxX: Math.max(...pts.map(p => p.x)),
      minZ: Math.min(...pts.map(p => p.z)),
      maxZ: Math.max(...pts.map(p => p.z))
    };
  }

  function getPlanBoundsMapped(nodes, orientation = null) {
    if (!Array.isArray(nodes) || !nodes.length) {
      return {
        minX: 0,
        maxX: 0,
        minZ: 0,
        maxZ: 0,
        width: 0,
        depth: 0
      };
    }

    const o = orientation || getPlanRenderOrientation(nodes);

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const n of nodes) {
      const r = getNodePlanRectMapped(n, o);

      if (r.minX < minX) minX = r.minX;
      if (r.maxX > maxX) maxX = r.maxX;
      if (r.minZ < minZ) minZ = r.minZ;
      if (r.maxZ > maxZ) maxZ = r.maxZ;
    }

    return {
      minX,
      maxX,
      minZ,
      maxZ,
      width: maxX - minX,
      depth: maxZ - minZ
    };
  }

  function getSingleBranchOrientation(nodes = null) {
    return getPlanRenderOrientation(nodes);
  }

  function mapWorldPointToSingleBranchAxes(x, z) {
    return mapWorldPointToPlanAxes(x, z, getPlanRenderOrientation(getConnectedPlanNodes?.() || []));
  }

  function getSingleBranchBoundsMapped(nodes) {
    return getPlanBoundsMapped(nodes, getPlanRenderOrientation(nodes));
  }

  function getDims4PlusSummaryStyleModelKey() {
    const n =
      String(activeModules?.[0]?.name || activeModules?.[0]?.variantId || "")
        .trim();

    return (n.split("_")[0] || String(appState?.model || "")).toUpperCase();
  }

  function getDims4PlusSummaryStyleArmrestRules() {
    return {
      MENDOZA: {
        baseCm: 25,
        types: {
          smooth: { kind: "variable", min: 10, max: 25, defaultCm: 25 }, // hranatá
          sharp:  { kind: "fixed", valueCm: 33 },                       // polohovací
        },
      },

      MANILA: {
        baseCm: 20,
        types: {
          smooth: { kind: "fixed", valueCm: 14 },                       // kulatá
          sharp:  { kind: "variable", min: 10, max: 25, defaultCm: 20 }, // hranatá
        },
      },

      MANCHESTER: {
        // Manchester má v catalogue.js rozměry počítané s područkou 40 cm.
        // Summary UI tedy musí počítat delta: zvolená šířka - 40.
        baseCm: 40,
        types: {
          smooth: { kind: "variable", min: 30, max: 40, defaultCm: 40 }, // polohovací
          sharp:  { kind: "variable", min: 15, max: 25, defaultCm: 25 }, // hranatá
        },
      },
    };
  }

  function getDims4PlusSummaryStyleSelectedArmrestWidthCm(modelKey) {
    const rules = getDims4PlusSummaryStyleArmrestRules()[modelKey];
    if (!rules) return null;

    const armType = String(window.selectedArmrests || selectedArmrests || "smooth")
      .trim()
      .toLowerCase();

    const typeRule = rules.types?.[armType];
    if (!typeRule) return null;

    if (typeRule.kind === "fixed") {
      return Number(typeRule.valueCm);
    }

    // DŮLEŽITÉ:
    // Manchester používá hodnoty až 40 cm a nové UI je ukládá do window.selectedArmrestWidth.
    // selectedArmrestSharpWidthCm tam může někdy zůstat staré / 25, proto má selectedArmrestWidth prioritu.
    const raw = Number(
      window.selectedArmrestWidth ||
      window.selectedArmrestSharpWidthCm ||
      selectedArmrestSharpWidthCm ||
      typeRule.defaultCm
    );

    const fallback = Number(typeRule.defaultCm);
    const v = Number.isFinite(raw) ? raw : fallback;

    return Math.max(typeRule.min, Math.min(typeRule.max, v));
  }

  function getDims4PlusSummaryStyleWorldDirFromNode(node, localSide) {
    const root = getModuleRoot(node?.root || node?.rec?.mesh || node?.mesh);
    if (!root || typeof dirFromModuleToWorld !== "function") return null;
    return dirFromModuleToWorld(root, localSide);
  }

  function getDims4PlusSummaryStyleFootprintDimsCm(node, mode = "min") {
    const variantId = getNodeVariantId(node);
    const v = getCatalog(variantId);
    if (!v) return { w: 0, d: 0 };

    const isX = /(^|_)X/.test(String(variantId || ""));
    const dims = isX
      ? (v.xDimsCm || v.dimsCm || v.baseDimsCm)
      : (v.baseDimsCm || v.dimsCm || v.xDimsCm);

    let d = Number(dims?.d || 0);

    // stejnĂ© jako SummaryUI:
    // pokud mĂˇ modul depthRangeCm, pouĹľij min/max hloubku podle mode
    if (v.depthRangeCm && (mode === "min" || mode === "max")) {
      const dMin = Number(v.depthRangeCm.min);
      const dMax = Number(v.depthRangeCm.max);

      if (
        Number.isFinite(dMin) &&
        Number.isFinite(dMax) &&
        dMin > 0 &&
        dMax > 0
      ) {
        d = (mode === "min") ? dMin : dMax;
      }
    }

    return {
      w: Number(dims?.w || 0),
      d
    };
  }

  function getDims4PlusSummaryStyleFootprintWidthRangeCm(node) {
    const variantId = getNodeVariantId(node);
    const v = getCatalog(variantId);
    if (!v) return { min: 0, max: 0 };

    const r = v.seatWidthRangeCm;

    const dims = getDims4PlusSummaryStyleFootprintDimsCm(node);
    const min = (r?.min != null) ? Number(r.min) : Number(dims.w || 0);
    const max = (r?.max != null) ? Number(r.max) : Number(dims.w || 0);

    return { min, max };
  }

  function getDims4PlusSummaryStyleWorldHalfExtents(node, mode = "min") {
    const { d } = getDims4PlusSummaryStyleFootprintDimsCm(node, mode);
    const wr = getDims4PlusSummaryStyleFootprintWidthRangeCm(node);
    const w = (mode === "min") ? wr.min : wr.max;

    const hw = w / 2;
    const hd = d / 2;

    const wrDir = getDims4PlusSummaryStyleWorldDirFromNode(node, "right");
    const rotated90 = (wrDir === "front" || wrDir === "back");

    return rotated90 ? { hx: hd, hz: hw } : { hx: hw, hz: hd };
  }

  function getDims4PlusSummaryStyleShiftedCenter(node, p, mode = "min") {
    const { d } = getDims4PlusSummaryStyleFootprintDimsCm(node, mode);
    const STANDARD_D = 102;

    if (!(d > STANDARD_D)) return { x: p.x, z: p.z };

    const shift = (d - STANDARD_D) / 2;
    const frontWorld = getDims4PlusSummaryStyleWorldDirFromNode(node, "front");

    let x = p.x;
    let z = p.z;

    if (frontWorld === "front") z += shift;
    else if (frontWorld === "back") z -= shift;
    else if (frontWorld === "right") x += shift;
    else if (frontWorld === "left") x -= shift;

    return { x, z };
  }

  function computeDims4PlusSummaryStyleArmrestDeltaByWorldSide() {
    const modelKey = getDims4PlusSummaryStyleModelKey();
    const rules = getDims4PlusSummaryStyleArmrestRules()[modelKey];

    if (!rules) {
      return { left: 0, right: 0, front: 0, back: 0 };
    }

    const present = { left: false, right: false, front: false, back: false };

    for (const rec of activeModules || []) {
      if (!rec?.mesh) continue;

      const role = getRole(getRecVariantId(rec) || rec.name || rec.variantId || "");
      if (role !== "L" && role !== "P") continue;

      const root = getModuleRoot(rec.mesh);
      if (!root || typeof dirFromModuleToWorld !== "function") continue;

      const localSide = role === "L" ? "left" : "right";
      const worldSide = dirFromModuleToWorld(root, localSide);

      if (worldSide && Object.prototype.hasOwnProperty.call(present, worldSide)) {
        present[worldSide] = true;
      }
    }

    const selectedCm = getDims4PlusSummaryStyleSelectedArmrestWidthCm(modelKey);
    if (!Number.isFinite(selectedCm)) {
      return { left: 0, right: 0, front: 0, back: 0 };
    }

    const delta = selectedCm - Number(rules.baseCm);

    return {
      left:  present.left  ? delta : 0,
      right: present.right ? delta : 0,
      front: present.front ? delta : 0,
      back:  present.back  ? delta : 0,
    };
  }

  function computeDims4PlusTotalsLikeSummaryUI(mode = "min") {
    const recs = (activeModules || []).filter(rec => rec?.mesh);
    if (!recs.length) {
      return {
        width: 0,
        depth: 0,
        leftDepth: 0,
        rightDepth: 0,
      };
    }

    // stejnĂ© napojenĂ­ jako SummaryUI, ale pĹ™es vlastnĂ­ dims kopii
    const byMesh = new Map();
    for (const rec of recs) {
      const root = getModuleRoot(rec.mesh);
      if (root) byMesh.set(root, rec);
    }

    const anchorRoot = getModuleRoot(recs[0]?.mesh);
    if (!anchorRoot || !byMesh.has(anchorRoot)) {
      return {
        width: 0,
        depth: 0,
        leftDepth: 0,
        rightDepth: 0,
      };
    }

    // root -> node kvĹŻli dims helperĹŻm
    const nodes = getConnectedPlanNodes?.() || [];
    const byRootNode = new Map(nodes.map(n => [n.root, n]));

    // BFS stejnÄ› jako SummaryUI: pĹ™es rec.connections
    const posMode = new Map();
    const q = [];

    posMode.set(anchorRoot, { x: 0, z: 0 });
    q.push(anchorRoot);

    while (q.length) {
      const curMesh = q.shift();
      const curRec = byMesh.get(curMesh);
      const curNode = byRootNode.get(curMesh);

      if (!curRec?.connections || !curNode) continue;

      const curJoin = getDims4PlusSummaryStyleWorldHalfExtents(curNode, mode);
      const curPos = posMode.get(curMesh);

      for (const localSide of ["left", "right", "front", "back"]) {
        const nbMeshRaw = curRec.connections[localSide];
        if (!nbMeshRaw) continue;

        const nbRoot = getModuleRoot(nbMeshRaw);
        const nbRec = byMesh.get(nbRoot);
        const nbNode = byRootNode.get(nbRoot);

        if (!nbRec || !nbNode) continue;

        const worldDir = dirFromModuleToWorld(curMesh, localSide);
        const nbJoin = getDims4PlusSummaryStyleWorldHalfExtents(nbNode, mode);

        let nx = curPos.x;
        let nz = curPos.z;

        if (worldDir === "right") nx += (curJoin.hx + nbJoin.hx);
        if (worldDir === "left")  nx -= (curJoin.hx + nbJoin.hx);
        if (worldDir === "front") nz += (curJoin.hz + nbJoin.hz);
        if (worldDir === "back")  nz -= (curJoin.hz + nbJoin.hz);

        if (!posMode.has(nbRoot)) {
          posMode.set(nbRoot, { x: nx, z: nz });
          q.push(nbRoot);
        }
      }
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const [mesh, p] of posMode.entries()) {
      const node = byRootNode.get(mesh);
      if (!node) continue;

      const { hx, hz } = getDims4PlusSummaryStyleWorldHalfExtents(node, mode);
      const pc = getDims4PlusSummaryStyleShiftedCenter(node, p, mode);

      minX = Math.min(minX, pc.x - hx);
      maxX = Math.max(maxX, pc.x + hx);
      minZ = Math.min(minZ, pc.z - hz);
      maxZ = Math.max(maxZ, pc.z + hz);
    }

    let width = Math.round((maxX - minX) + 1e-6);
    let depth = Math.round((maxZ - minZ) + 1e-6);

    const armDelta = computeDims4PlusSummaryStyleArmrestDeltaByWorldSide();
    width = Math.round((width + armDelta.left + armDelta.right) + 1e-6);
    depth = Math.round((depth + armDelta.front + armDelta.back) + 1e-6);

    return {
      width: Math.max(0, width),
      depth: Math.max(0, depth),
      leftDepth: Math.max(0, depth),
      rightDepth: Math.max(0, depth),
    };
  }

  function computeTwoBranchTotalsLikePlanUI(mode = "min") {
    const nodes = getConnectedPlanNodes?.() || [];
    if (!nodes.length) {
      return {
        width: 0,
        depth: 0,
        leftDepth: 0,
        rightDepth: 0
      };
    }

    const orientation = getPlanRenderOrientation(nodes);
    const selectedArmCm = getCurrentSelectedArmrestCm();

    const mappedItems = nodes.map((n) => {
      const rect = getNodePlanRectMapped(n, orientation);
      return {
        node: n,
        rect,
        cx: (rect.minX + rect.maxX) * 0.5,
        cz: (rect.minZ + rect.maxZ) * 0.5,
        sx: rect.maxX - rect.minX,
        sz: rect.maxZ - rect.minZ
      };
    });

    const median = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };

    // seskupenĂ­ do "Ĺ™ad" v plĂˇnku
    const typicalDepth = median(mappedItems.map(i => Math.max(1, i.sz)));
    const rowTol = Math.max(14, typicalDepth * 0.35);

    const rows = [];
    const sorted = mappedItems.slice().sort((a, b) => a.cz - b.cz);

    for (const it of sorted) {
      let row = rows.find(r => Math.abs(it.cz - r.cz) <= rowTol);
      if (!row) {
        row = { cz: it.cz, items: [] };
        rows.push(row);
      }
      row.items.push(it);
      row.cz = row.items.reduce((s, x) => s + x.cz, 0) / row.items.length;
    }

    for (const row of rows) {
      row.minX = Math.min(...row.items.map(i => i.rect.minX));
      row.maxX = Math.max(...row.items.map(i => i.rect.maxX));
      row.minZ = Math.min(...row.items.map(i => i.rect.minZ));
      row.maxZ = Math.max(...row.items.map(i => i.rect.maxZ));
      row.spanX = row.maxX - row.minX;
      row.spanZ = row.maxZ - row.minZ;
      row.midX = (row.minX + row.maxX) * 0.5;
      row.midZ = (row.minZ + row.maxZ) * 0.5;
    }

    if (!rows.length) {
      return {
        width: 0,
        depth: 0,
        leftDepth: 0,
        rightDepth: 0
      };
    }

    // hlavnĂ­ width row = nejdelĹˇĂ­ vodorovnĂˇ Ĺ™ada, lehce preferuj hornÄ›jĹˇĂ­
    let widthRow = rows[0];
    let bestScore = -Infinity;

    for (const row of rows) {
      const score = row.spanX * 12 - row.spanZ * 30 - row.midZ * 0.02;
      if (score > bestScore) {
        bestScore = score;
        widthRow = row;
      }
    }

    const widthAxisNodes = widthRow.items.map(i => i.node);
    const widthSet = new Set(widthAxisNodes);

    // branch = to, co je POD hlavnĂ­ Ĺ™adou
    const branchItems = mappedItems.filter((it) => {
      if (widthSet.has(it.node)) return false;
      return it.cz > widthRow.maxZ - 1;
    });

    const branchNodes = branchItems.map(i => i.node);

    const widthBase = sumWidthAxis(widthAxisNodes, branchNodes, mode);

    const widthArmrestNodes = Array.from(
      new Set([
        ...widthAxisNodes,
        ...branchNodes.filter(n => getNodeCatalogInfo(n, "min").isDepth),
      ])
    );

    const widthArmrests =
      getWidthAxisArmrestCount(widthArmrestNodes) * selectedArmCm;

    const depthBase = sumDepthAxis(branchNodes, mode);
    const depthArmrests =
      getDepthAxisArmrestCount(branchNodes) * selectedArmCm;

    const width = Math.max(0, Math.round(widthBase + widthArmrests));
    const depth = Math.max(0, Math.round(depthBase + depthArmrests));

    // jen kvĹŻli kompatibilitÄ› â€“ u 2 branches reĂˇlnÄ› pouĹľĂ­vĂˇĹˇ B
    let leftDepth = 0;
    let rightDepth = 0;

    if (branchItems.length) {
      const branchCenterX =
        branchItems.reduce((s, x) => s + x.cx, 0) / branchItems.length;

      if (branchCenterX < widthRow.midX) leftDepth = depth;
      else rightDepth = depth;
    }

    return {
      width,
      depth,
      leftDepth,
      rightDepth
    };
  }

  function computeTwoBranchTotalsFromCorner(mode = "min") {
    const nodes = getConnectedPlanNodes();
    if (!Array.isArray(nodes) || !nodes.length) {
      return { width: 0, depth: 0, leftDepth: 0, rightDepth: 0 };
    }

    const orientation = getPlanRenderOrientation(nodes);
    const selectedArmCm = getCurrentSelectedArmrestCm();
    const activeCorner = nodes.find(n => isActiveCornerNode(n));

    // fallback â€“ kdyĹľ nenĂ­ aktivnĂ­ roh, nech starou logiku
    if (!activeCorner) {
      const widthAxisNodes = getMainWidthAxisNodes(nodes);
      const depthAxes = getSideDepthAxisNodes(nodes, widthAxisNodes);
      const leftDepthNodes = depthAxes.left || [];
      const rightDepthNodes = depthAxes.right || [];

      const left1D = leftDepthNodes.find(n => getNodeCatalogInfo(n, mode).isDepth) || null;
      const right1D = rightDepthNodes.find(n => getNodeCatalogInfo(n, mode).isDepth) || null;

      let leftDepth = 0;
      let rightDepth = 0;

      // Speciální fix pro jednoduché L bez aktivního rohu:
      // typicky sestava 1D + jeden hlavní modul.
      //
      // DŮLEŽITÉ:
      // 1D musí ovlivnit ŠÍŘKU svojí seatWidthRange hodnotou,
      // ale BOK musí být počítaný z depthRangeCm.
      //
      // Tedy:
      // - Šířka = hlavní width osa + seatBase z 1D + viditelné područky
      // - Bok   = depthRaw z 1D, tedy 150–200
      //
      // sumWidthAxis(widthAxisNodes, depthNodes, mode) už dělá správnou věc:
      // pro 1D z depth osy přičte pouze info.seatBase, NE info.depthRaw.
      if (left1D || right1D) {
        const depthNodesForWidth = Array.from(
          new Set([
            ...leftDepthNodes.filter(n => getNodeCatalogInfo(n, mode).isDepth),
            ...rightDepthNodes.filter(n => getNodeCatalogInfo(n, mode).isDepth),
          ])
        );

        const widthBase = sumWidthAxis(
          widthAxisNodes,
          depthNodesForWidth,
          mode
        );

        const widthArmrestNodes = Array.from(
          new Set([
            ...widthAxisNodes,
            ...depthNodesForWidth,
          ])
        );

        const widthArmrests =
          getWidthAxisArmrestCount(widthArmrestNodes) * selectedArmCm;

        if (left1D) {
          const info = getNodeCatalogInfo(left1D, mode);
          leftDepth = Math.max(0, Math.round(info.depthRaw));
        }

        if (right1D) {
          const info = getNodeCatalogInfo(right1D, mode);
          rightDepth = Math.max(0, Math.round(info.depthRaw));
        }

        debugLog("[DIMS FIX 1D SIMPLE L]", {
          mode,
          widthAxis: widthAxisNodes.map(n => getNodeVariantId(n)),
          depthNodesForWidth: depthNodesForWidth.map(n => getNodeVariantId(n)),
          leftDepthNodes: leftDepthNodes.map(n => getNodeVariantId(n)),
          rightDepthNodes: rightDepthNodes.map(n => getNodeVariantId(n)),
          left1D: left1D ? getNodeVariantId(left1D) : null,
          right1D: right1D ? getNodeVariantId(right1D) : null,
          widthBase,
          widthArmrestNodes: widthArmrestNodes.map(n => getNodeVariantId(n)),
          widthArmrests,
          width: Math.max(0, Math.round(widthBase + widthArmrests)),
          leftDepth,
          rightDepth,
        });

        return {
          width: Math.max(0, Math.round(widthBase + widthArmrests)),
          depth: Math.max(leftDepth, rightDepth),
          leftDepth,
          rightDepth
        };
      }

      const widthBase = sumWidthAxis(
        widthAxisNodes,
        [...leftDepthNodes, ...rightDepthNodes],
        mode
      );

      const widthArmrestNodes = Array.from(
        new Set([
          ...widthAxisNodes,
          ...leftDepthNodes.filter(n => getNodeCatalogInfo(n, "min").isDepth),
          ...rightDepthNodes.filter(n => getNodeCatalogInfo(n, "min").isDepth),
        ])
      );

      const widthArmrests =
        getWidthAxisArmrestCount(widthArmrestNodes) * selectedArmCm;

      // pĹŻvodnĂ­ fallback pro klasickĂ© L bez 1D
      const leftDepthBase = sumDepthAxis(leftDepthNodes, mode);
      const leftDepthArmrests =
        getDepthAxisArmrestCount(leftDepthNodes) * selectedArmCm;

      const rightDepthBase = sumDepthAxis(rightDepthNodes, mode);
      const rightDepthArmrests =
        getDepthAxisArmrestCount(rightDepthNodes) * selectedArmCm;

      leftDepth = Math.max(0, Math.round(leftDepthBase + leftDepthArmrests));
      rightDepth = Math.max(0, Math.round(rightDepthBase + rightDepthArmrests));

      return {
        width: Math.max(0, Math.round(widthBase + widthArmrests)),
        depth: Math.max(leftDepth, rightDepth),
        leftDepth,
        rightDepth
      };
    }

    const getCenter = (node) => getMappedPlanCenter(node, orientation);

    const pushUnique = (arr, node) => {
      if (node && !arr.includes(node)) arr.push(node);
    };

    const getPlanDirBetween = (fromNode, toNode) => {
      const a = getCenter(fromNode);
      const b = getCenter(toNode);

      const dx = b.x - a.x;
      const dz = b.z - a.z;

      if (Math.abs(dx) >= Math.abs(dz)) {
        return dx >= 0 ? "right" : "left";
      }
      return dz >= 0 ? "bottom" : "top";
    };

    const getAllNeighbors = (node) => {
      return [
        node?.neighbors?.left,
        node?.neighbors?.right,
        node?.neighbors?.front,
        node?.neighbors?.back
      ].filter(Boolean);
    };

    const collectBranchInPlanAxis = (startNode, axisKind) => {
      const visited = new Set();
      const out = [];
      const stack = [startNode];

      while (stack.length) {
        const n = stack.pop();
        if (!n || visited.has(n)) continue;
        visited.add(n);
        pushUnique(out, n);

        for (const nb of getAllNeighbors(n)) {
          if (!nb || visited.has(nb)) continue;

          const planDir = getPlanDirBetween(n, nb);

          if (axisKind === "horizontal") {
            if (planDir === "left" || planDir === "right") {
              stack.push(nb);
            }
          } else {
            if (planDir === "top" || planDir === "bottom") {
              stack.push(nb);
            }
          }
        }
      }

      return out;
    };

    const horizontalStarts = [];
    const verticalStarts = [];

    for (const nb of getAllNeighbors(activeCorner)) {
      const dir = getPlanDirBetween(activeCorner, nb);
      if (dir === "left" || dir === "right") horizontalStarts.push(nb);
      if (dir === "top" || dir === "bottom") verticalStarts.push(nb);
    }

    let horizontalBranch = [activeCorner];
    let verticalBranch = [activeCorner];

    for (const n of horizontalStarts) {
      const arr = collectBranchInPlanAxis(n, "horizontal");
      arr.forEach(x => pushUnique(horizontalBranch, x));
    }

    for (const n of verticalStarts) {
      const arr = collectBranchInPlanAxis(n, "vertical");
      arr.forEach(x => pushUnique(verticalBranch, x));
    }

    const calcBranchTotal = (branchNodes) => {
      const nodes = Array.isArray(branchNodes) ? branchNodes : [];

      const depthNodes = nodes.filter((n) => getNodeCatalogInfo(n, mode).isDepth);
      const hasDepth = depthNodes.length > 0;

      // KdyĹľ branch obsahuje 1D / depth modul,
      // nechci do boku pĹ™iÄŤĂ­tat ĹľĂˇdnĂ© dalĹˇĂ­ rovnĂ© moduly (napĹ™. 1M),
      // kterĂ© se do branch dostaly jen kvĹŻli collectBranchInPlanAxis().
      // Bok mĂˇ bĂ˝t v tomhle pĹ™Ă­padÄ› jen skuteÄŤnĂ˝ rozsah 1D.
      if (hasDepth) {
        const depthTotal = depthNodes.reduce((sum, n) => {
          const info = getNodeCatalogInfo(n, mode);
          return sum + (Number(info.depthRaw) || 0);
        }, 0);

        return Math.max(0, Math.round(depthTotal));
      }

      let total = 0;

      for (const n of nodes) {
        const info = getNodeCatalogInfo(n, mode);
        const variantId = getNodeVariantId(n);

        // roh se poÄŤĂ­tĂˇ do obou vÄ›tvĂ­
        if (/roh/i.test(String(variantId || ""))) {
          total += info.seatBase;
          continue;
        }

        total += info.seatBase;
      }

      total += getDepthAxisArmrestCount(nodes) * selectedArmCm;
      return Math.max(0, Math.round(total));
    };

    const horizontalTotal = calcBranchTotal(horizontalBranch);
    const verticalTotal = calcBranchTotal(verticalBranch);

    // v osĂˇch plĂˇnku:
    // horizontĂˇlnĂ­ vÄ›tev = ĹˇĂ­Ĺ™ka
    // vertikĂˇlnĂ­ vÄ›tev = bok
    return {
      width: horizontalTotal,
      depth: verticalTotal,
      leftDepth: verticalTotal,
      rightDepth: verticalTotal
    };
  }

  function computeRangeTotals(mode = "min") {
    const nodes = getConnectedPlanNodes?.() || [];
    if (!nodes.length) {
      return {
        width: 0,
        depth: 0,
        leftDepth: 0,
        rightDepth: 0
      };
    }

    const branchCount = detectBranchCount();
    const selectedArmCm = getCurrentSelectedArmrestCm();

    // =========================
    // 1 vÄ›tev = vlastnĂ­ mapovĂˇnĂ­ podle orientace sedaÄŤky
    // =========================
    if (branchCount === 1) {
      // U 1 vÄ›tve nechceme brĂˇt ĹˇĂ­Ĺ™ku z aktuĂˇlnĂ­ho world/mapped bbox,
      // ale z katalogovĂ˝ch rozsahĹŻ modulĹŻ + aktuĂˇlnÄ› zvolenĂ© ĹˇĂ­Ĺ™ky podruÄŤek.
      // DĂ­ky tomu je rozsah sprĂˇvnĂ˝ i po otoÄŤenĂ­ sestavy.

      const widthAxisNodes = nodes.slice();
      const depthAxisNodes = [];

      const selectedArmCm = getCurrentSelectedArmrestCm();

      const widthBase = sumWidthAxis(widthAxisNodes, depthAxisNodes, mode);
      const widthArmrests = getWidthAxisArmrestCount(widthAxisNodes) * selectedArmCm;
      const width = widthBase + widthArmrests;

      // Hloubku zatĂ­m nechĂˇme z reĂˇlnĂ©ho pĹŻdorysu jako dosud.
      const mapped = getSingleBranchBoundsMapped(nodes);
      const depth = Math.max(0, Math.round(mapped.depth));

      return {
        width: Math.max(0, Math.round(width)),
        depth,
        leftDepth: depth,
        rightDepth: depth
      };
    }

    // =========================
    // 2 vÄ›tve = vlastnĂ­ logika podle plĂˇnku
    // width = hornĂ­ hlavnĂ­ vÄ›tev
    // depth = vÄ›tev pod nĂ­
    // =========================
    if (branchCount === 2) {
      return computeTwoBranchTotalsFromCorner(mode);
    }

    // =========================
    // 3 vÄ›tve = zatĂ­m nech pĹŻvodnĂ­ logiku
    // =========================
    if (branchCount === 3) {
      const widthAxisNodes = getMainWidthAxisNodes(nodes);
      const depthAxes = getSideDepthAxisNodes(nodes, widthAxisNodes);
      const leftDepthNodes = depthAxes.left || [];
      const rightDepthNodes = depthAxes.right || [];

      const widthBase = sumWidthAxis(
        widthAxisNodes,
        [...leftDepthNodes, ...rightDepthNodes],
        mode
      );

      const widthArmrestNodes = Array.from(
        new Set([
          ...widthAxisNodes,
          ...leftDepthNodes.filter(n => getNodeCatalogInfo(n, "min").isDepth),
          ...rightDepthNodes.filter(n => getNodeCatalogInfo(n, "min").isDepth),
        ])
      );

      const widthArmrests =
        getWidthAxisArmrestCount(widthArmrestNodes) * selectedArmCm;

      const calcUBranchDepth = (branchNodes) => {
        const nodes = Array.isArray(branchNodes) ? branchNodes : [];

        const depthNodes = nodes.filter((n) => getNodeCatalogInfo(n, mode).isDepth);

        // kdyĹľ vÄ›tev obsahuje 1D, bok mĂˇ bĂ˝t jen rozsah 1D
        // a nesmĂ­ se k nÄ›mu pĹ™iÄŤĂ­tat dalĹˇĂ­ rovnĂ© moduly z tĂ© samĂ© vÄ›tve
        if (depthNodes.length > 0) {
          const depthTotal = depthNodes.reduce((sum, n) => {
            const info = getNodeCatalogInfo(n, mode);
            return sum + (Number(info.depthRaw) || 0);
          }, 0);

          return Math.max(0, Math.round(depthTotal));
        }

        const depthBase = sumDepthAxis(nodes, mode);
        const depthArmrests =
          getDepthAxisArmrestCount(nodes) * selectedArmCm;

        return Math.max(0, Math.round(depthBase + depthArmrests));
      };

      const leftDepth = calcUBranchDepth(leftDepthNodes);
      const rightDepth = calcUBranchDepth(rightDepthNodes);

      return {
        width: Math.max(0, Math.round(widthBase + widthArmrests)),
        depth: Math.max(leftDepth, rightDepth),
        leftDepth,
        rightDepth
      };
    }

    // =========================
    // 4+ vÄ›tve
    // poÄŤĂ­tej stejnÄ› jako SummaryUI:
    // - BFS/world footprint
    // - asymetrickĂ© 1D posunutĂ­ stĹ™edu
    // - korekce podruÄŤek podle WORLD stran
    // =========================
    return computeDims4PlusTotalsLikeSummaryUI(mode);
  }

  function getComputedTotalsRange() {
    const minTotals = computeRangeTotals("min");
    const maxTotals = computeRangeTotals("max");

    return {
      widthMin: Math.max(0, Math.round(Number(minTotals.width) || 0)),
      widthMax: Math.max(0, Math.round(Number(maxTotals.width) || 0)),

      depthMin: Math.max(0, Math.round(Number(minTotals.depth) || 0)),
      depthMax: Math.max(0, Math.round(Number(maxTotals.depth) || 0)),

      leftDepthMin: Math.max(0, Math.round(Number(minTotals.leftDepth) || 0)),
      leftDepthMax: Math.max(0, Math.round(Number(maxTotals.leftDepth) || 0)),

      rightDepthMin: Math.max(0, Math.round(Number(minTotals.rightDepth) || 0)),
      rightDepthMax: Math.max(0, Math.round(Number(maxTotals.rightDepth) || 0)),
    };
  }

  function getDynamicDimMeta(branchCount) {
    const r = getComputedTotalsRange();

    const widthMin = Math.min(r.widthMin, r.widthMax);
    const widthMax = Math.max(r.widthMin, r.widthMax);

    const depthMin = Math.min(r.depthMin, r.depthMax);
    const depthMax = Math.max(r.depthMin, r.depthMax);

    const leftDepthMin = Math.min(r.leftDepthMin, r.leftDepthMax);
    const leftDepthMax = Math.max(r.leftDepthMin, r.leftDepthMax);

    const rightDepthMin = Math.min(r.rightDepthMin, r.rightDepthMax);
    const rightDepthMax = Math.max(r.rightDepthMin, r.rightDepthMax);

    return {
      W: { title: DIM_META.W.title, min: widthMin, max: widthMax },
      D: { title: DIM_META.D.title, min: depthMin, max: depthMax },
      B: { title: DIM_META.B.title, min: depthMin, max: depthMax },
      L: { title: DIM_META.L.title, min: leftDepthMin, max: leftDepthMax },
      R: { title: DIM_META.R.title, min: rightDepthMin, max: rightDepthMax },
    };
  }

  // =========================
  // 3) RENDER ĹĂDKĹ® podle vÄ›tvĂ­
  // =========================
  function buildRows(branchCount) {
    wrap.dataset.branches = String(branchCount);
    wrap.dataset.mode = branchCount >= 4 ? "4plus" : "standard";

    let dimsOrder = ["W"];
    if (branchCount === 2) dimsOrder = ["W", "B"];
    if (branchCount === 3) dimsOrder = ["W", "L", "R"];
    if (branchCount >= 4) dimsOrder = ["W", "D"];

    // pro 4+ vÄ›tvĂ­ vĹľdy synchronizuj celkovĂ© rozmÄ›ry z reĂˇlnĂ©ho pĹŻdorysu
    const dynamicMeta = getDynamicDimMeta(branchCount);

    const layoutKey = JSON.stringify({
      branchCount,
      dimsOrder,
      ranges: dimsOrder.map((dim) => {
        const meta = dynamicMeta[dim] || { min: 0, max: 0 };
        return [dim, Number(meta.min) || 0, Number(meta.max) || 0];
      })
    });

    const prevLayoutKey = window.__sofaDimsLayoutKey || null;
    const layoutChanged = prevLayoutKey !== layoutKey;

    // layoutChanged si zatĂ­m nechĂˇvĂˇme jen informativnÄ›/debug,
    // ale nesmĂ­ pĹ™episovat userem uloĹľenĂ© rozmÄ›ry

    const getDefaultDimValue = (dim, meta) => {
      const isDepthLike = dim === "D" || dim === "B" || dim === "L" || dim === "R";

      // vĂ˝jimka: hloubkovĂˇ vÄ›tev 150â€“200 cm mĂˇ default 180
      if (isDepthLike && Number(meta.min) === 150 && Number(meta.max) === 200) {
        return 180;
      }

      // ostatnĂ­ chovĂˇnĂ­ zĹŻstĂˇvĂˇ stejnĂ© jako doteÄŹ
      return meta.max;
    };

    for (const dim of dimsOrder) {
      const meta = dynamicMeta[dim] || { min: 0, max: 0 };
      const current = Number(window.__sofaDims[dim]);

      const isMissing = !Number.isFinite(current);
      const isOutOfRange = current < meta.min || current > meta.max;
      const defaultValue = getDefaultDimValue(dim, meta);

      if (isMissing || isOutOfRange) {
        window.__sofaDims[dim] = defaultValue;
      } else {
        window.__sofaDims[dim] = clamp(current, meta.min, meta.max);
      }
    }

    window.__sofaDimsLayoutKey = layoutKey;

    const ctaHtml = branchCount >= 4 ? `
      <div class="dimsCustomAllWrap">
        <button type="button" id="btnAllBranchesCustom" class="dimsCustomAllBtn">
          Nastavení každé větve
        </button>
        <div class="dimsCustomAllNote">
          Pro individuální nastavení každé větve zvlášť nás kontaktujte e-mailem.
        </div>
      </div>
    ` : "";

    wrap.innerHTML =
      ctaHtml +
      dimsOrder.map((dim) => {
        const meta = dynamicMeta[dim];
        const id = `sofaDim_${dim}`;
        const rangeId = `sofaDim_${dim}_Range`;

        const isReadOnlyTotal = false;
        const rangeText = `${meta.min}–${meta.max} cm`;

        return `
          <div class="dimsRow" data-dim="${dim}" data-min="${meta.min}" data-max="${meta.max}">
            <div class="dimsTitle">${meta.title}</div>
            <div class="dimsControl">
              <button type="button" class="dimsBtn" data-step="-1" ${isReadOnlyTotal ? "disabled" : ""}>−</button>
              <div class="dimsValue">
                <input
                  id="${id}"
                  class="dimsValueInput"
                  type="text"
                  inputmode="numeric"
                  value="${window.__sofaDims[dim]}"
                  ${isReadOnlyTotal ? 'readonly aria-readonly="true"' : ""}
                />
              </div>
              <button type="button" class="dimsBtn" data-step="+1" ${isReadOnlyTotal ? "disabled" : ""}>+</button>
            </div>
            <div class="dimsRange"><span id="${rangeId}">${rangeText}</span></div>
          </div>
        `;
      }).join("") +
      `<div class="dimsNote"><span>Rozměr upravíte tlačítky&nbsp;+&nbsp;/&nbsp;− nebo kliknutím na číslo.</span></div>`;

    if (branchCount >= 4) {
      wrap.querySelector("#btnAllBranchesCustom")?.addEventListener("click", () => {
        openAllBranchesCustomModal();
      });
    }
  }

  // =========================
  // 4) GENERICKĂ‰ HELPERY (uĹľ ne natvrdo W/D)
  // =========================
  const getRowLimits = (dim) => {
    const row = wrap.querySelector(`.dimsRow[data-dim="${dim}"]`);
    if (!row) return { min: -Infinity, max: Infinity };
    const min = Number(row.dataset.min);
    const max = Number(row.dataset.max);
    return {
      min: Number.isFinite(min) ? min : -Infinity,
      max: Number.isFinite(max) ? max : Infinity,
    };
  };

  function render() {
    wrap.querySelectorAll(".dimsRow").forEach((row) => {
      const dim = row.getAttribute("data-dim");
      const inp = row.querySelector(".dimsValueInput");
      if (!dim || !inp) return;
      inp.value = String(window.__sofaDims[dim] ?? "");
    });
  }

  const redrawPlan = () => {
    // branches mĂˇĹˇ uloĹľenĂ© na wrapperu z buildRows(branchCount)
    const b = Number(wrap.dataset.branches) || 1;
    renderSofaPlan(b);
  };

  function refreshSofaDimsUI() {
    const branchCount = detectBranchCount();
    const dynamicMeta = getDynamicDimMeta(branchCount);

    buildRows(branchCount);

    Object.keys(dynamicMeta).forEach((dim) => {
      const meta = dynamicMeta[dim];
      if (!meta) return;

      const current = Number(window.__sofaDims[dim]);
      const isMissing = !Number.isFinite(current);
      const isOutOfRange = current < meta.min || current > meta.max;

      // DĹ®LEĹ˝ITĂ‰:
      // pĹ™i refreshi NIKDY neshazuj validnĂ­ user value na min/default.
      // Default pouĹľij jen kdyĹľ hodnota chybĂ­ nebo uĹľ je mimo novĂ˝ rozsah.
      if (isMissing || isOutOfRange) {
        const isDepthLike = dim === "D" || dim === "B" || dim === "L" || dim === "R";

        if (isDepthLike && Number(meta.min) === 150 && Number(meta.max) === 200) {
          window.__sofaDims[dim] = 180;
        } else {
          window.__sofaDims[dim] = meta.max;
        }
      } else {
        window.__sofaDims[dim] = clamp(current, meta.min, meta.max);
      }
    });

    render();
    redrawPlan();
    try { updateSummaryUI(); } catch (e) {}
    try { scheduleSummaryRecalc(); } catch (e) {}
  }

  window.refreshSofaDimsUI = refreshSofaDimsUI;

  if (!window.__sofaPlanControlsBound && controls && typeof controls.addEventListener === "function") {
    controls.addEventListener("change", () => {
      try {
        const wrap = document.getElementById("sofaDimsRows");
        const b = Number(wrap?.dataset?.branches) || 1;
        renderSofaPlan(b);
      } catch (e) {}
    });

    window.__sofaPlanControlsBound = true;
  }

  // =========================
  // 7) PĹ®DORYS (SVG) â€“ render v reĂˇlnĂ©m ÄŤase
  // =========================
  const planSvg = document.getElementById("sofaPlanSvg");

  function getPlanBoundsFromSceneCm() {
    const nodes = getConnectedPlanNodes?.() || [];
    if (!nodes.length) {
      return {
        minX: 0,
        maxX: 250,
        minZ: 0,
        maxZ: 215,
        width: 250,
        depth: 215,
        nodes: [],
        orientation: "front"
      };
    }

    const orientation = getPlanRenderOrientation(nodes);
    const mapped = getPlanBoundsMapped(nodes, orientation);

    return {
      minX: mapped.minX,
      maxX: mapped.maxX,
      minZ: mapped.minZ,
      maxZ: mapped.maxZ,
      width: mapped.width,
      depth: mapped.depth,
      nodes,
      orientation
    };
  }

  function getPlanViewDirection() {
    return {
      rightIsWorldXPlus: true,
      downIsWorldZPlus: true
    };
  }

  function mapWorldSideToPlanSide(side, orientation = "front") {
    switch (orientation) {
      case "front":
        if (side === "left") return "left";
        if (side === "right") return "right";
        if (side === "front") return "top";
        if (side === "back") return "bottom";
        break;

      case "back":
        if (side === "left") return "right";
        if (side === "right") return "left";
        if (side === "front") return "bottom";
        if (side === "back") return "top";
        break;

      case "right":
        if (side === "left") return "bottom";
        if (side === "right") return "top";
        if (side === "front") return "left";
        if (side === "back") return "right";
        break;

      case "left":
        if (side === "left") return "top";
        if (side === "right") return "bottom";
        if (side === "front") return "right";
        if (side === "back") return "left";
        break;
    }

    return side;
  }

  function getPlanShapeInfo(branches) {
    try {
      const topo = getPlanTopology();

      return {
        lSide: topo.lSide || "left",
        uLeft: branches === 3,
        uRight: branches === 3
      };
    } catch (e) {
      console.warn("getPlanShapeInfo failed:", e);
      return {
        lSide: "left",
        uLeft: true,
        uRight: true
      };
    }
  }

  function patchPlanSideSegmentsFor1DOnly(baseSides, bounds) {
    try {
      const branchCount = detectBranchCount?.() || 1;

      // bezpeÄŤnost:
      // Ĺ™eĹˇĂ­me jen L sestavy (2 vÄ›tve)
      if (branchCount !== 2) return baseSides;

      const nodes = bounds?.nodes || [];
      if (!nodes.length) return baseSides;

      const hasAnyBranchDriver = nodes.some(
        n =>
          isDepthBranchModule(n) ||
          isDualAxisModule(n) ||
          isActiveCornerNode(n)
      );

      if (!hasAnyBranchDriver) return baseSides;

      const orientation = bounds?.orientation || getPlanRenderOrientation(nodes);

      const widthAxisNodes = getMainWidthAxisNodes(nodes);
      const depthAxes = getSideDepthAxisNodes(nodes, widthAxisNodes);

      const leftDepthNodes = depthAxes?.left || [];
      const rightDepthNodes = depthAxes?.right || [];

      const getDepthInterval = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return null;

        let minZ = Infinity;
        let maxZ = -Infinity;
        let hasBranchDriver = false;

        for (const n of arr) {
          const rect = getNodePlanRectMapped(n, orientation);

          if (rect.minZ < minZ) minZ = rect.minZ;
          if (rect.maxZ > maxZ) maxZ = rect.maxZ;

          if (
            isDepthBranchModule(n) ||
            isDualAxisModule(n) ||
            isActiveCornerNode(n)
          ) {
            hasBranchDriver = true;
          }
        }

        if (!hasBranchDriver) return null;
        if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;

        return {
          start: minZ,
          end: maxZ,
          coverage: Math.max(0, maxZ - minZ)
        };
      };

      const patched = {
        top: baseSides?.top || null,
        bottom: baseSides?.bottom || null,
        left: baseSides?.left || null,
        right: baseSides?.right || null
      };

      const leftPatched = getDepthInterval(leftDepthNodes);
      const rightPatched = getDepthInterval(rightDepthNodes);

      // PATCH pouĹľĂ­vej jen kdyĹľ je opravdu lepĹˇĂ­ neĹľ pĹŻvodnĂ­ strana.
      // KdyĹľ je kratĹˇĂ­, nech pĹŻvodnĂ­ baseSides â€“ jinak se vÄ›tev smrskne jen na roh.
      const leftBaseCov = Number(baseSides?.left?.coverage || 0);
      const rightBaseCov = Number(baseSides?.right?.coverage || 0);
      const leftPatchCov = Number(leftPatched?.coverage || 0);
      const rightPatchCov = Number(rightPatched?.coverage || 0);

      if (leftPatched && leftPatchCov >= leftBaseCov) {
        patched.left = leftPatched;
      }

      if (rightPatched && rightPatchCov >= rightBaseCov) {
        patched.right = rightPatched;
      }

      const getFullWidthInterval = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return null;

        const o = bounds?.orientation || getPlanRenderOrientation(bounds?.nodes || []);
        let minX = Infinity;
        let maxX = -Infinity;

        for (const n of arr) {
          const rect = getNodePlanRectMapped(n, o);
          if (rect.minX < minX) minX = rect.minX;
          if (rect.maxX > maxX) maxX = rect.maxX;
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

        return {
          start: minX,
          end: maxX,
          coverage: Math.max(0, maxX - minX)
        };
      };

      const fullWidth = getFullWidthInterval(nodes);
      if (fullWidth) {
        patched.top = fullWidth;
      }

      // dĹŻleĹľitĂ©: funkce MUSĂŤ vĹľdy nÄ›co vrĂˇtit
      return patched;

    } catch (e) {
      return baseSides;
    }
  }

  function renderSofaPlan(branches) {
    if (!planSvg) return;

    const bounds = getPlanBoundsFromSceneCm();

    const W = Number(window.__sofaDims.W) || 0;
    const B = Number(window.__sofaDims.B) || 0;
    const L = Number(window.__sofaDims.L) || 0;
    const R = Number(window.__sofaDims.R) || 0;
    const D = Number(window.__sofaDims.D) || 0;

    const VB_W = 520;
    const VB_H = 260;
    planSvg.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
    planSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // ========================================
    // BezpeÄŤnĂ© rezervy pro kĂłty a texty
    // ========================================

    // ÄŤĂ­sla si teÄŹ kreslĂ­Ĺˇ vÄ›tĹˇĂ­m fontem, tak tomu dej reĂˇlnĂ˝ prostor
    const fontSize = 18;

    // dĂ©lka textu v kĂłtĂˇch typu "215 cm", "408 cm" apod.
    const sideLabels = [];
    if (branches === 2) sideLabels.push(`${B} cm`);
    if (branches === 3) sideLabels.push(`${L} cm`, `${R} cm`);
    if (branches >= 4) sideLabels.push(`${D} cm`);

    const longestSideLabel = sideLabels.reduce((m, s) => Math.max(m, String(s).length), 0);

    // hrubĂ˝ odhad ĹˇĂ­Ĺ™ky textu
    const approxSideTextWidth = Math.max(34, longestSideLabel * (fontSize * 0.62));

    // svislĂˇ kĂłta zabere:
    // 8 px odsazenĂ­ od plĂˇnku + 2*6 tick + textOffset + ĹˇĂ­Ĺ™ku textu + malou rezervu
    const verticalDimReserve = branches >= 2
      ? Math.ceil(8 + 6 + 24 + approxSideTextWidth + 12)
      : 22;

    // hornĂ­ kĂłta zabere prostor nad plĂˇnkem
    const topGutter = Math.max(38, fontSize + 20);
    const bottomGutter = Math.max(38, fontSize + 20);
    const sideGutter = verticalDimReserve;

    const innerX = sideGutter;
    const innerY = topGutter;
    const innerW = Math.max(80, VB_W - sideGutter * 2);
    const innerH = Math.max(60, VB_H - topGutter - bottomGutter);

    const scale = Math.min(
      innerW / Math.max(1, bounds.width),
      innerH / Math.max(1, bounds.depth)
    );

    const drawnW = bounds.width * scale;
    const drawnH = bounds.depth * scale;

    const ox = innerX + (innerW - drawnW) / 2;
    const oy = innerY + (innerH - drawnH) / 2;

    const sx = (v) => v * scale;
    const sy = (v) => v * scale;

    const stroke = "rgba(255,255,255,0.70)";
    const faint = "rgba(255,255,255,0.38)";
    const text = "rgba(255,255,255,0.92)";

    planSvg.innerHTML = "";

    const add = (tag, attrs = {}) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
      planSvg.appendChild(el);
      return el;
    };

    // =========================================================
    // 1) VĹ˝DY vykresli pĹ™esnĂ˝ pĹŻdorys podle vĹˇech modulĹŻ ve scĂ©nÄ›
    // =========================================================
    for (const n of bounds.nodes) {
      const rect = getNodePlanRectMapped(n, bounds.orientation || getPlanRenderOrientation(bounds.nodes));

      const rectMinX = rect.minX;
      const rectMaxX = rect.maxX;
      const rectMinZ = rect.minZ;
      const rectMaxZ = rect.maxZ;

      const x = ox + sx(rectMinX - bounds.minX);
      const y = oy + sy(rectMinZ - bounds.minZ);
      const w = sx(rectMaxX - rectMinX);
      const h = sy(rectMaxZ - rectMinZ);

      add("rect", {
        x,
        y,
        width: w,
        height: h,
        rx: 8,
        ry: 8,
        fill: "transparent",
        stroke,
        "stroke-width": 2
      });
    }

    const drawDim = (x1, y1, x2, y2, label, { side = "top", textOffset = 12 } = {}) => {
      add("line", { x1, y1, x2, y2, stroke: faint, "stroke-width": 2 });

      const vertical = Math.abs(x1 - x2) < 0.001;

      if (vertical) {
        add("line", { x1: x1 - 6, y1, x2: x1 + 6, y2: y1, stroke: faint, "stroke-width": 2 });
        add("line", { x1: x2 - 6, y1: y2, x2: x2 + 6, y2: y2, stroke: faint, "stroke-width": 2 });

        const tx = side === "left" ? x1 - textOffset : x1 + textOffset;
        const ty = (y1 + y2) / 2;

        add("text", {
          x: tx,
          y: ty,
          fill: text,
          "font-size": fontSize,
          "text-anchor": side === "left" ? "end" : "start",
          "dominant-baseline": "middle",
          "font-family": "system-ui, -apple-system, Segoe UI, Roboto, Arial"
        }).textContent = `${label} cm`;
      } else {
        add("line", { x1, y1: y1 - 6, x2: x1, y2: y1 + 6, stroke: faint, "stroke-width": 2 });
        add("line", { x1: x2, y1: y2 - 6, x2, y2: y2 + 6, stroke: faint, "stroke-width": 2 });

        const tx = (x1 + x2) / 2;
        const isBottom = side === "bottom";
        const ty = isBottom ? y1 + textOffset : y1 - textOffset;

        add("text", {
          x: tx,
          y: ty,
          fill: text,
          "font-size": fontSize,
          "text-anchor": "middle",
          "dominant-baseline": isBottom ? "hanging" : "auto",
          "font-family": "system-ui, -apple-system, Segoe UI, Roboto, Arial"
        }).textContent = `${label} cm`;
      }
    };

    const getMergedIntervals = (intervals) => {
      if (!intervals.length) return [];

      const sorted = intervals
        .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
        .sort((a, b) => a[0] - b[0]);

      const merged = [sorted[0].slice()];

      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = sorted[i];
        const last = merged[merged.length - 1];

        if (a <= last[1] + 1) {
          last[1] = Math.max(last[1], b);
        } else {
          merged.push([a, b]);
        }
      }

      return merged;
    };

    const getSideStats = (intervals) => {
      const merged = getMergedIntervals(intervals);
      if (!merged.length) {
        return {
          coverage: 0,
          start: 0,
          end: 0
        };
      }

      let coverage = 0;
      let start = Infinity;
      let end = -Infinity;

      for (const [a, b] of merged) {
        coverage += Math.max(0, b - a);
        start = Math.min(start, a);
        end = Math.max(end, b);
      }

      return { coverage, start, end };
    };

    const getPlanSideSegments = () => {
      const nodes = bounds.nodes || [];
      const tol = 1;
      const branchCount = detectBranchCount?.() || 1;

      const topIntervals = [];
      const bottomIntervals = [];
      const leftIntervals = [];
      const rightIntervals = [];

      const orientation = bounds.orientation || getPlanRenderOrientation(nodes);

      for (const n of nodes) {
        const rect = getNodePlanRectMapped(n, orientation);

        let x1 = rect.minX;
        let x2 = rect.maxX;
        let z1 = rect.minZ;
        let z2 = rect.maxZ;

        // Jen pro 1 vÄ›tev pĹ™emapuj obdĂ©lnĂ­k modulu do lokĂˇlnĂ­ch os sedaÄŤky,
        // aby TOP/RIGHT/BOTTOM/LEFT odpovĂ­daly otoÄŤenĂ­.
        if (branchCount === 1) {
          const pts = [
            mapWorldPointToSingleBranchAxes(n.cx - n.sx / 2, n.cz - n.sz / 2),
            mapWorldPointToSingleBranchAxes(n.cx + n.sx / 2, n.cz - n.sz / 2),
            mapWorldPointToSingleBranchAxes(n.cx + n.sx / 2, n.cz + n.sz / 2),
            mapWorldPointToSingleBranchAxes(n.cx - n.sx / 2, n.cz + n.sz / 2),
          ];

          x1 = Math.min(...pts.map(p => p.x));
          x2 = Math.max(...pts.map(p => p.x));
          z1 = Math.min(...pts.map(p => p.z));
          z2 = Math.max(...pts.map(p => p.z));
        }

        const planNeighborSides = [];

        for (const side of ["left", "right", "front", "back"]) {
          if (n.neighbors?.[side]) {
            planNeighborSides.push(
              mapWorldSideToPlanSide(side, orientation)
            );
          }
        }

        // dual-axis modul umĂ­ tvoĹ™it i â€žvodorovnouâ€ś ÄŤĂˇst plĂˇnku
        if (isDualAxisModule(n)) {
          planNeighborSides.push("left", "right");
        }

        // depth modul umĂ­ tvoĹ™it i â€žsvislouâ€ś ÄŤĂˇst plĂˇnku
        if (isDepthBranchModule(n)) {
          planNeighborSides.push("top", "bottom");
        }

        const hasHorizontal =
          planNeighborSides.includes("left") ||
          planNeighborSides.includes("right");

        const hasVertical =
          planNeighborSides.includes("top") ||
          planNeighborSides.includes("bottom");

        // TOP/BOTTOM ber jen z modulĹŻ, kterĂ© opravdu tvoĹ™Ă­ vodorovnou vÄ›tev v AKTUĂLNÄš zrotovanĂ©m plĂˇnku
        if (hasHorizontal) {
          if (Math.abs(z1 - bounds.minZ) <= tol) topIntervals.push([x1, x2]);
          if (Math.abs(z2 - bounds.maxZ) <= tol) bottomIntervals.push([x1, x2]);
        }

        // LEFT/RIGHT ber jen z modulĹŻ, kterĂ© opravdu tvoĹ™Ă­ svislou / depth vÄ›tev v AKTUĂLNÄš zrotovanĂ©m plĂˇnku
        if (hasVertical) {
          if (Math.abs(x1 - bounds.minX) <= tol) leftIntervals.push([z1, z2]);
          if (Math.abs(x2 - bounds.maxX) <= tol) rightIntervals.push([z1, z2]);
        }
      }

      return {
        top: getSideStats(topIntervals),
        bottom: getSideStats(bottomIntervals),
        left: getSideStats(leftIntervals),
        right: getSideStats(rightIntervals)
      };
    };

    const drawDimOnPlanSide = (sideName, label, startCm, endCm) => {
      if (!Number.isFinite(startCm) || !Number.isFinite(endCm)) return;

      if (sideName === "top") {
        drawDim(
          ox + sx(startCm - bounds.minX),
          oy - 8,
          ox + sx(endCm - bounds.minX),
          oy - 8,
          label,
          { side: "top", textOffset: 12 }
        );
        return;
      }

      if (sideName === "bottom") {
        drawDim(
          ox + sx(startCm - bounds.minX),
          oy + sy(bounds.depth) + 8,
          ox + sx(endCm - bounds.minX),
          oy + sy(bounds.depth) + 8,
          label,
          { side: "bottom", textOffset: 12 }
        );
        return;
      }

      if (sideName === "left") {
        drawDim(
          ox - 8,
          oy + sy(startCm - bounds.minZ),
          ox - 8,
          oy + sy(endCm - bounds.minZ),
          label,
          { side: "left", textOffset: 22 }
        );
        return;
      }

      if (sideName === "right") {
        drawDim(
          ox + sx(bounds.width) + 8,
          oy + sy(startCm - bounds.minZ),
          ox + sx(bounds.width) + 8,
          oy + sy(endCm - bounds.minZ),
          label,
          { side: "right", textOffset: 22 }
        );
      }
    };

    const getPreferredBranchOrder = (widthSide) => {
      if (widthSide === "top") return ["left", "right", "bottom"];
      if (widthSide === "right") return ["top", "bottom", "left"];
      if (widthSide === "bottom") return ["right", "left", "top"];
      return ["bottom", "top", "right"]; // widthSide === "left"
    };

    const worldSideToPlanSide = (worldSide) => {
      const { rightIsWorldXPlus, downIsWorldZPlus } = getPlanViewDirection();

      if (worldSide === "right") return rightIsWorldXPlus ? "right" : "left";
      if (worldSide === "left")  return rightIsWorldXPlus ? "left" : "right";

      // world front = +Z, world back = -Z
      if (worldSide === "front") return downIsWorldZPlus ? "bottom" : "top";
      if (worldSide === "back")  return downIsWorldZPlus ? "top" : "bottom";

      return "top";
    };

    const getSingleBranchBackPlanPlacement = () => {
      return {
        side: "top",
        start: bounds.minX,
        end: bounds.maxX
      };
    };

    const getPlanDimensionPlacementGeneric = (branches) => {
      const sidesBase = getPlanSideSegments();
      const sides = patchPlanSideSegmentsFor1DOnly(sidesBase, bounds);

      const sideNames = ["top", "right", "bottom", "left"];

      // -----------------------------------------
      // NOVĂ‰ PRAVIDLO:
      // - 1 vÄ›tev = nech pĹŻvodnĂ­ chovĂˇnĂ­
      // - 2 vÄ›tve = po otoÄŤenĂ­ plĂˇnku chceme width vĹľdy nahoĹ™e
      // - 3 vÄ›tve = top preferujeme stejnÄ› jako doteÄŹ
      // -----------------------------------------
      let widthSide = "top";

      if (branches === 1) {
        widthSide = sideNames
          .slice()
          .sort((a, b) => sides[b].coverage - sides[a].coverage)[0];
      }

      if (branches === 2) {
        // U L sestavy mĂˇ bĂ˝t ĹˇĂ­Ĺ™ka vĹľdy hornĂ­ ÄŤĂˇra v pĹŻdorysu
        if (Number(sides.top?.coverage || 0) > 0) {
          widthSide = "top";
        } else {
          widthSide = sideNames
            .slice()
            .sort((a, b) => sides[b].coverage - sides[a].coverage)[0];
        }
      }

      if (branches === 3) {
        widthSide = sideNames
          .slice()
          .sort((a, b) => sides[b].coverage - sides[a].coverage)[0];
      }

      if (branches === 2) {
        if (!(widthSide === "top" && Number(sides.top?.coverage || 0) > 0)) {
          const wValue = Number(W) || 0;

          const candidates = sideNames
            .filter(side => Number(sides[side]?.coverage || 0) > 0)
            .map(side => ({
              side,
              coverage: Number(sides[side].coverage || 0),
              scoreToW: Math.abs(Number(sides[side].coverage || 0) - wValue)
            }))
            .sort((a, b) => {
              if (a.scoreToW !== b.scoreToW) return a.scoreToW - b.scoreToW;
              return b.coverage - a.coverage;
            });

          if (candidates.length) {
            widthSide = candidates[0].side;
          }
        }
      }

      // =========================================
      // FIX:
      // U normĂˇlnĂ­ho U nechceme, aby se "ĹˇĂ­Ĺ™ka"
      // pĹ™ehodila jinam jen proto, Ĺľe je nÄ›kterĂˇ
      // boÄŤnĂ­ vÄ›tev delĹˇĂ­ neĹľ hornĂ­.
      //
      // Dokud mĂˇme klasickĂ© U:
      // - nahoĹ™e je nÄ›jakĂˇ souvislĂˇ hornĂ­ vÄ›tev
      // - vlevo je vÄ›tev
      // - vpravo je vÄ›tev
      //
      // tak preferujeme top jako hlavnĂ­ ĹˇĂ­Ĺ™ku.
      // =========================================
      if (branches === 3) {
        const topCov = Number(sides.top?.coverage || 0);
        const leftCov = Number(sides.left?.coverage || 0);
        const rightCov = Number(sides.right?.coverage || 0);
        const bottomCov = Number(sides.bottom?.coverage || 0);

        const hasTop = topCov > 0;
        const hasLeft = leftCov > 0;
        const hasRight = rightCov > 0;
        const hasBottom = bottomCov > 0;

        // klasickĂ© U z pohledu pĹŻdorysu:
        // ĹˇĂ­Ĺ™ka mĂˇ bĂ˝t nahoĹ™e,
        // boky majĂ­ bĂ˝t vlevo + vpravo
        const hasClassicTopU =
          hasTop &&
          hasLeft &&
          hasRight;

        // kdyĹľ je nahoĹ™e pĹ™Ă­ÄŤka a souÄŤasnÄ› existujĂ­ obÄ› boÄŤnĂ­ vÄ›tve,
        // ĹˇĂ­Ĺ™ku drĹľ vĹľdy nahoĹ™e.
        // bottom v tomhle pĹ™Ă­padÄ› nesmĂ­ ukrĂˇst width
        if (branches === 3 && hasClassicTopU) {
          widthSide = "top";
        }

        // extra ochrana:
        // i kdyby top coverage byla o nÄ›co kratĹˇĂ­ neĹľ right/left,
        // ale je zjevnÄ› validnĂ­ hornĂ­ pĹ™Ă­ÄŤka U,
        // poĹ™Ăˇd ji ber jako width
        if (
          branches === 3 &&
          hasTop &&
          hasLeft &&
          hasRight &&
          topCov >= 40
        ) {
          widthSide = "top";
        }
      }

      const result = {
        W: null,
        B: null,
        L: null,
        R: null
      };

      if (sides[widthSide].coverage > 0) {
        result.W = {
          side: widthSide,
          start: sides[widthSide].start,
          end: sides[widthSide].end
        };
      }

      if (branches === 2) {
        const bValue = Number(B) || 0;

        const candidates = sideNames
          .filter(side => side !== widthSide)
          .filter(side => Number(sides[side]?.coverage || 0) > 0)
          .map(side => ({
            side,
            coverage: Number(sides[side].coverage || 0),
            scoreToB: Math.abs(Number(sides[side].coverage || 0) - bValue)
          }))
          .sort((a, b) => {
            if (a.scoreToB !== b.scoreToB) return a.scoreToB - b.scoreToB;
            return b.coverage - a.coverage;
          });

        if (candidates.length) {
          const best = candidates[0];
          result.B = {
            side: best.side,
            start: sides[best.side].start,
            end: sides[best.side].end
          };
        }

        return result;
      }

      if (branches === 3) {
        const leftCov = Number(sides.left?.coverage || 0);
        const rightCov = Number(sides.right?.coverage || 0);
        const topCov = Number(sides.top?.coverage || 0);
        const bottomCov = Number(sides.bottom?.coverage || 0);

        const leftValue = Number(L) || 0;
        const rightValue = Number(R) || 0;

        const buildPlacement = (sideObj) => {
          if (!sideObj || !sideObj.coverage) return null;
          return {
            side: sideObj.side,
            start: sideObj.start,
            end: sideObj.end
          };
        };

        const leftSideObj = sides.left?.coverage > 0
          ? {
              side: "left",
              coverage: leftCov,
              start: sides.left.start,
              end: sides.left.end
            }
          : null;

        const rightSideObj = sides.right?.coverage > 0
          ? {
              side: "right",
              coverage: rightCov,
              start: sides.right.start,
              end: sides.right.end
            }
          : null;

        const bottomSideObj = sides.bottom?.coverage > 0
          ? {
              side: "bottom",
              coverage: bottomCov,
              start: sides.bottom.start,
              end: sides.bottom.end
            }
          : null;

        // =========================================
        // KLASICKĂ‰ U:
        // kdyĹľ existujĂ­ obÄ› boÄŤnĂ­ svislĂ© vÄ›tve,
        // pouĹľĂ­vej vĹľdy LEFT + RIGHT
        // a bottom do L/R vĹŻbec nepouĹˇtÄ›j
        // =========================================
        if (leftSideObj && rightSideObj) {
          result.L = buildPlacement(leftSideObj);
          result.R = buildPlacement(rightSideObj);
          return result;
        }

        // =========================================
        // PoloviÄŤnĂ­ fallback:
        // jedna skuteÄŤnĂˇ boÄŤnĂ­ vÄ›tev + druhĂˇ chybĂ­
        // pak doplĹ druhou z bottom jen kdyĹľ nenĂ­ jinĂˇ moĹľnost
        // =========================================
        if (leftSideObj && !rightSideObj) {
          result.L = buildPlacement(leftSideObj);

          if (bottomSideObj) {
            result.R = buildPlacement(bottomSideObj);
          }

          return result;
        }

        if (!leftSideObj && rightSideObj) {
          result.R = buildPlacement(rightSideObj);

          if (bottomSideObj) {
            result.L = buildPlacement(bottomSideObj);
          }

          return result;
        }

        // =========================================
        // NouzovĂ˝ fallback:
        // kdyĹľ nejsou left/right detekovanĂ© vĹŻbec,
        // tak teprve vybĂ­rej z ostatnĂ­ch stran podle podobnosti
        // =========================================
        const available = [];

        for (const side of ["left", "right", "bottom", "top"]) {
          if (side === widthSide) continue;
          if ((sides[side]?.coverage || 0) <= 0) continue;

          available.push({
            side,
            coverage: Number(sides[side].coverage || 0),
            start: sides[side].start,
            end: sides[side].end
          });
        }

        let bestPair = null;

        for (let i = 0; i < available.length; i++) {
          for (let j = 0; j < available.length; j++) {
            if (i === j) continue;

            const a = available[i];
            const b = available[j];

            const score =
              Math.abs(a.coverage - leftValue) +
              Math.abs(b.coverage - rightValue);

            if (!bestPair || score < bestPair.score) {
              bestPair = {
                left: a,
                right: b,
                score
              };
            }
          }
        }

        if (bestPair) {
          result.L = buildPlacement(bestPair.left);
          result.R = buildPlacement(bestPair.right);
        } else {
          if (available[0]) result.L = buildPlacement(available[0]);
          if (available[1]) result.R = buildPlacement(available[1]);
        }

        return result;
      }

      return result;
    };

    // Zatim nechavame vsechny tri modely na stejne logice.
    // Dulezite je, ze od tehle chvile pujde ladit kazdy model zvlast
    // bez rizika, ze zmeny zasahnou ostatni.
    const getPlanDimensionPlacementForMendoza = (branches) => {
      return getPlanDimensionPlacementGeneric(branches);
    };

    const getPlanDimensionPlacementForManila = (branches) => {
      const nodes = bounds.nodes || [];
      const orientation = bounds.orientation || getPlanRenderOrientation(nodes);
      let placement = getPlanDimensionPlacementGeneric(branches);

      if (nodes.length && (branches === 2 || branches === 3)) {
        const mappedItems = nodes.map((node) => {
          const rect = getNodePlanRectMapped(node, orientation);
          return {
            node,
            variantId: getNodeVariantId(node),
            rect,
            minX: rect.minX,
            maxX: rect.maxX,
            minZ: rect.minZ,
            maxZ: rect.maxZ
          };
        });

        const median = (arr) => {
          const a = arr.slice().sort((x, y) => x - y);
          const mid = Math.floor(a.length / 2);
          return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
        };

        const globalMinX = Math.min(...mappedItems.map((it) => it.minX));
        const globalMaxX = Math.max(...mappedItems.map((it) => it.maxX));
        const globalMinZ = Math.min(...mappedItems.map((it) => it.minZ));

        const typicalWidth = median(mappedItems.map((it) => Math.max(1, it.maxX - it.minX)));
        const typicalDepth = median(mappedItems.map((it) => Math.max(1, it.maxZ - it.minZ)));

        const topTol = Math.max(10, typicalDepth * 0.2);
        const edgeTol = Math.max(10, typicalWidth * 0.18);
        const protrudeTol = Math.max(8, typicalDepth * 0.08);

        const topBandItems = mappedItems.filter((it) => it.minZ <= globalMinZ + topTol);
        const topBandBottom = topBandItems.length
          ? median(topBandItems.map((it) => it.maxZ))
          : globalMinZ;
        const cornerItems = mappedItems.filter((it) => /roh/i.test(String(it.variantId || "")));

        const leftBranchItems = mappedItems.filter((it) =>
          it.minX <= globalMinX + edgeTol &&
          it.maxZ > topBandBottom + protrudeTol
        );

        const rightBranchItems = mappedItems.filter((it) =>
          it.maxX >= globalMaxX - edgeTol &&
          it.maxZ > topBandBottom + protrudeTol
        );

        const buildHorizontalPlacement = (items) => {
          if (!items.length) return null;
          return {
            side: "top",
            start: Math.min(...items.map((it) => it.minX)),
            end: Math.max(...items.map((it) => it.maxX))
          };
        };

        const buildVerticalPlacement = (items, side) => {
          if (!items.length) return null;

          const sideCornerItems = cornerItems.filter((it) =>
            side === "left"
              ? it.minX <= globalMinX + edgeTol
              : it.maxX >= globalMaxX - edgeTol
          );

          const allItems = [...items];
          for (const corner of sideCornerItems) {
            if (!allItems.includes(corner)) allItems.push(corner);
          }

          return {
            side,
            start: Math.min(...allItems.map((it) => it.minZ)),
            end: Math.max(...allItems.map((it) => it.maxZ))
          };
        };

        const manilaPlacement = {
          W: buildHorizontalPlacement(topBandItems),
          B: null,
          L: null,
          R: null
        };

        if (branches === 2) {
          const leftHeight = leftBranchItems.length
            ? Math.max(...leftBranchItems.map((it) => it.maxZ)) - Math.min(...leftBranchItems.map((it) => it.minZ))
            : -Infinity;
          const rightHeight = rightBranchItems.length
            ? Math.max(...rightBranchItems.map((it) => it.maxZ)) - Math.min(...rightBranchItems.map((it) => it.minZ))
            : -Infinity;

          if (rightHeight >= leftHeight) {
            manilaPlacement.B = buildVerticalPlacement(rightBranchItems, "right");
          } else {
            manilaPlacement.B = buildVerticalPlacement(leftBranchItems, "left");
          }
        }

        if (branches === 3) {
          manilaPlacement.L = buildVerticalPlacement(leftBranchItems, "left");
          manilaPlacement.R = buildVerticalPlacement(rightBranchItems, "right");

          // FALLBACK PRO MANILA U SESTAVU Z 2× 1D:
          //
          // Když je sestava např. 1D_L + jeden modul uprostřed + 1D_P,
          // může se stát, že leftBranchItems/rightBranchItems zůstanou prázdné,
          // protože 1D moduly se započítají do horního pásu.
          //
          // V tom případě boční kóty vytvoříme přímo z 1D_L / 1D_P.
          const isDualAxisItem = (it) => {
            const id = String(it?.variantId || "").toLowerCase();
            return (
              /_1x?d_l$/i.test(id) ||
              /_1x?d_p$/i.test(id) ||
              /_1x?dl$/i.test(id) ||
              /_1x?dp$/i.test(id)
            );
          };

          const dualAxisItems = mappedItems.filter(isDualAxisItem);

          const leftDualAxisItems = dualAxisItems.filter((it) => {
            const id = String(it?.variantId || "").toLowerCase();

            return (
              /_1x?d_l$/i.test(id) ||
              /_1x?dl$/i.test(id) ||
              it.minX <= globalMinX + edgeTol
            );
          });

          const rightDualAxisItems = dualAxisItems.filter((it) => {
            const id = String(it?.variantId || "").toLowerCase();

            return (
              /_1x?d_p$/i.test(id) ||
              /_1x?dp$/i.test(id) ||
              it.maxX >= globalMaxX - edgeTol
            );
          });

          if (!manilaPlacement.L && leftDualAxisItems.length) {
            manilaPlacement.L = buildVerticalPlacement(leftDualAxisItems, "left");
          }

          if (!manilaPlacement.R && rightDualAxisItems.length) {
            manilaPlacement.R = buildVerticalPlacement(rightDualAxisItems, "right");
          }
        }

        if (manilaPlacement.W || manilaPlacement.B || manilaPlacement.L || manilaPlacement.R) {
          placement = {
            ...placement,
            ...manilaPlacement
          };
        }
      }

      try {
        const mappedItems = nodes.map((node) => {
          const rect = getNodePlanRectMapped(node, orientation);
          return {
            variantId: getNodeVariantId(node),
            cx: Number((((rect.minX + rect.maxX) * 0.5)).toFixed(2)),
            cz: Number((((rect.minZ + rect.maxZ) * 0.5)).toFixed(2)),
            sx: Number((rect.maxX - rect.minX).toFixed(2)),
            sz: Number((rect.maxZ - rect.minZ).toFixed(2)),
            minX: Number(rect.minX.toFixed(2)),
            maxX: Number(rect.maxX.toFixed(2)),
            minZ: Number(rect.minZ.toFixed(2)),
            maxZ: Number(rect.maxZ.toFixed(2))
          };
        });

        debugLog("MANILA PLAN DEBUG", {
          branches,
          orientation,
          bounds: {
            minX: Number(bounds.minX.toFixed(2)),
            maxX: Number(bounds.maxX.toFixed(2)),
            minZ: Number(bounds.minZ.toFixed(2)),
            maxZ: Number(bounds.maxZ.toFixed(2))
          },
          mappedItems
        });

        debugLog("MANILA PLAN RESULT", {
          branches,
          result: placement
        });
      } catch (e) {
        console.warn("MANILA PLAN DEBUG FAILED", e);
      }

      return placement;
    };

    const getPlanDimensionPlacementForMelbourne = (branches) => {
      const placement = getPlanDimensionPlacementGeneric(branches);
      const nodes = bounds.nodes || [];
      const activeCorners = nodes.filter((n) => isActiveCornerNode(n));

      if (!placement || !activeCorners.length) return placement;

      const orientation = bounds.orientation || getPlanRenderOrientation(nodes);
      const getCornerRect = (cornerNode) => getNodePlanRectMapped(cornerNode, orientation);
      const getCornerCenter = (cornerNode) => getMappedPlanCenter(cornerNode, orientation);

      const extendPlacementWithCorners = (p, cornerNodes) => {
        if (!p) return p;
        const corners = Array.isArray(cornerNodes) ? cornerNodes.filter(Boolean) : [];
        if (!corners.length) return p;

        let start = Number(p.start);
        let end = Number(p.end);

        for (const cornerNode of corners) {
          const cornerRect = getCornerRect(cornerNode);

          if (p.side === "top" || p.side === "bottom") {
            start = Math.min(start, cornerRect.minX);
            end = Math.max(end, cornerRect.maxX);
          } else if (p.side === "left" || p.side === "right") {
            start = Math.min(start, cornerRect.minZ);
            end = Math.max(end, cornerRect.maxZ);
          }
        }

        return {
          ...p,
          start,
          end
        };
      };

      const orderedCorners = activeCorners
        .slice()
        .sort((a, b) => getCornerCenter(a).x - getCornerCenter(b).x);

      const leftCorner = orderedCorners[0] || null;
      const rightCorner = orderedCorners[orderedCorners.length - 1] || null;

      return {
        ...placement,
        W: extendPlacementWithCorners(placement.W, activeCorners),
        B: extendPlacementWithCorners(placement.B, activeCorners),
        L: extendPlacementWithCorners(placement.L, leftCorner ? [leftCorner] : []),
        R: extendPlacementWithCorners(placement.R, rightCorner ? [rightCorner] : [])
      };
    };

    const getPlanDimensionPlacementForManchester = (branches) => {
      const placement = getPlanDimensionPlacementForMelbourne(branches);
      const nodes = bounds.nodes || [];

      if (branches !== 3 || !nodes.length) return placement;

      const hasOneD = nodes.some((node) => isDualAxisModule(node));
      const hasActiveCorner = nodes.some((node) => isActiveCornerNode(node));

      // Když Manchester nemá 1D / 1XD, necháme původní chování.
      if (!hasOneD) return placement;

      const orientation = bounds.orientation || getPlanRenderOrientation(nodes);

      // DŮLEŽITÉ:
      // U Manchester U sestavy složené z 2× 1D nemusí existovat žádný Roh_L/Roh_P.
      // Proto se šířka musí roztáhnout přes všechny moduly hned tady,
      // ne až pod podmínkou hasActiveCorner.
      const rects = nodes.map((node) => getNodePlanRectMapped(node, orientation));
      const minX = Math.min(...rects.map((rect) => rect.minX));
      const maxX = Math.max(...rects.map((rect) => rect.maxX));

      let nextPlacement = {
        ...placement
      };

      if (Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX) {
        nextPlacement.W = {
          side: "top",
          start: minX,
          end: maxX
        };
      }

      // Pokud tam není aktivní roh, tady končíme.
      // To je přesně případ U sestavy z 2× 1D:
      // šířku máme opravenou přes celou sestavu, ale boky necháme podle generic placementu.
      if (!hasActiveCorner) {
        return nextPlacement;
      }

      const extendDepthPlacement = (current, branchNodes, fallbackSide) => {
        const arr = Array.isArray(branchNodes) ? branchNodes.filter(Boolean) : [];
        if (!arr.length) return current;

        // U větve s 1D / 1XD nechceme brát celou dlouhou větev s rohem,
        // ale jen samotnou 1D část.
        const dualAxisNodes = arr.filter((node) => isDualAxisModule(node));
        const shouldMeasureOnlyDualAxis = dualAxisNodes.length > 0;

        const measureNodes = shouldMeasureOnlyDualAxis
          ? dualAxisNodes
          : arr;

        const branchRects = measureNodes.map((node) =>
          getNodePlanRectMapped(node, orientation)
        );

        const start = Math.min(...branchRects.map((rect) => rect.minZ));
        const end = Math.max(...branchRects.map((rect) => rect.maxZ));

        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return current;
        }

        const currentCoverage = current
          ? Math.abs(Number(current.end) - Number(current.start))
          : 0;

        const nextCoverage = Math.abs(end - start);

        if (!shouldMeasureOnlyDualAxis && current && nextCoverage <= currentCoverage + 1) {
          return current;
        }

        return {
          side: shouldMeasureOnlyDualAxis ? fallbackSide : (current?.side || fallbackSide),
          start,
          end
        };
      };

      const widthAxisNodes = getMainWidthAxisNodes(nodes);
      const sideAxes = getSideDepthAxisNodes(nodes, widthAxisNodes);

      nextPlacement = {
        ...nextPlacement,
        L: extendDepthPlacement(nextPlacement?.L || null, sideAxes?.left || [], "left"),
        R: extendDepthPlacement(nextPlacement?.R || null, sideAxes?.right || [], "right")
      };

      return nextPlacement;
    };

    const getPlanDimensionPlacement = (branches) => {
      const activeSofaKey = String(getActiveSofaKeyFromScene?.() || "").trim().toLowerCase();

      if (activeSofaKey === "manila") {
        return getPlanDimensionPlacementForManila(branches);
      }

      if (activeSofaKey === "melbourne") {
        return getPlanDimensionPlacementForMelbourne(branches);
      }

      if (activeSofaKey === "manchester") {
        return getPlanDimensionPlacementForManchester(branches);
      }

      return getPlanDimensionPlacementForMendoza(branches);
    };

    // =========================================================
    // 2) KĂłty podle typu sestavy
    // =========================================================

    if (branches === 1) {
      const singlePlacement = getSingleBranchBackPlanPlacement();

      if (singlePlacement) {
        drawDimOnPlanSide(
          singlePlacement.side,
          Math.round(W),
          singlePlacement.start,
          singlePlacement.end
        );
      } else {
        drawDim(
          ox,
          oy - 8,
          ox + sx(bounds.width),
          oy - 8,
          Math.round(W),
          { side: "top", textOffset: 12 }
        );
      }

      return;
    }

    if (branches === 2 || branches === 3) {
      let placement = getPlanDimensionPlacement(branches);

      // =========================================
      // 2 branches:
      // hornĂ­ ÄŤĂˇra v pĹŻdorysu musĂ­ VĹ˝DY znamenat Ĺ Ă­Ĺ™ku
      // a druhĂˇ vÄ›tev musĂ­ bĂ˝t Bok.
      // KdyĹľ se placementy vrĂˇtĂ­ prohozenĂ©, tady je pĹ™ehodĂ­me.
      // =========================================
      if (branches === 2 && placement) {
        const wSide = placement.W?.side || null;
        const bSide = placement.B?.side || null;

        const wIsTop = wSide === "top";
        const bIsTop = bSide === "top";

        // kdyĹľ je nahoĹ™e omylem B a ne W, prohoÄŹ jen placementy
        if (!wIsTop && bIsTop) {
          placement = {
            ...placement,
            W: placement.B,
            B: placement.W
          };
        }
      }

      if (placement.W) {
        drawDimOnPlanSide(
          placement.W.side,
          Math.round(W),
          placement.W.start,
          placement.W.end
        );
      } else {
        drawDim(
          ox,
          oy - 8,
          ox + sx(bounds.width),
          oy - 8,
          Math.round(W),
          { side: "top", textOffset: 12 }
        );
      }

      if (branches === 2) {
        if (placement.B) {
          drawDimOnPlanSide(
            placement.B.side,
            B,
            placement.B.start,
            placement.B.end
          );
        } else {
          drawDim(
            ox + sx(bounds.width) + 8,
            oy,
            ox + sx(bounds.width) + 8,
            oy + sy(bounds.depth),
            B,
            { side: "right", textOffset: 24 }
          );
        }

        return;
      }

      if (branches === 3) {
        if (placement.L) {
          drawDimOnPlanSide(placement.L.side, L, placement.L.start, placement.L.end);
        }
        if (placement.R) {
          drawDimOnPlanSide(placement.R.side, R, placement.R.start, placement.R.end);
        }

        return;
      }
    }

    // 4+ vÄ›tvĂ­ = celkovĂˇ ĹˇĂ­Ĺ™ka nahoĹ™e
    drawDim(
      ox,
      oy - 8,
      ox + sx(bounds.width),
      oy - 8,
      Math.round(W),
      { side: "top", textOffset: 12 }
    );

    // 4+ vÄ›tvĂ­ = celkovĂˇ hloubka vpravo
    drawDim(
      ox + sx(bounds.width) + 8,
      oy,
      ox + sx(bounds.width) + 8,
      oy + sy(bounds.depth),
      D,
      { side: "right", textOffset: 22 }
    );
  }

  const applyTypedValue = (dim, raw) => {
    const { min, max } = getRowLimits(dim);
    const parsed = parseInt(String(raw).replace(/[^\d-]/g, ""), 10);

    if (!Number.isFinite(parsed)) {
      render();
      return;
    }

    setDimValueWithRules(dim, parsed, min, max, { showWarning: true });
    render();
    redrawPlan();

    // TODO napojenĂ­ na 3D / pĹ™epoÄŤet:
    // saveStateDebounced?.(50);
    // scheduleSummaryRecalc();
  };

  window.__setSofaDimFromRecap = function (dim, raw) {
    applyTypedValue(dim, raw);
    try { updateSummaryUI(); } catch (e) {}
    try { scheduleSummaryRecalc(); } catch (e) {}
    try { saveStateDebounced?.(); } catch (e) {}
  };

  // =========================
  // 5) BIND eventĹŻ (jen jednou), i kdyĹľ se Ĺ™Ăˇdky pĹ™erenderujĂ­
  // =========================
  if (!wrap.dataset.bound) {
    // KlikĂˇnĂ­ +/-
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".dimsBtn");
      if (!btn) return;

      const row = e.target.closest(".dimsRow");
      if (!row) return;

      const dim = row.getAttribute("data-dim");
      const step = btn.getAttribute("data-step") === "+1" ? 1 : -1;

      const { min, max } = getRowLimits(dim);
      const current = Number(window.__sofaDims[dim] || 0);

      if (step > 0 && Number.isFinite(max) && current >= max) {
        showDimensionModuleChangeModal("larger");
        return;
      }

      if (step < 0 && Number.isFinite(min) && current <= min) {
        showDimensionModuleChangeModal("smaller");
        return;
      }

      const next = current + step;

      setDimValueWithRules(dim, next, min, max, { showWarning: true });
      render();
      redrawPlan();
      try { updateSummaryUI(); } catch (e) {}
      try { scheduleSummaryRecalc(); } catch (e) {}
    });

    // Klik na ÄŤĂ­slo -> select
    wrap.addEventListener("focusin", (e) => {
      const inp = e.target.closest(".dimsValueInput");
      if (!inp) return;
      requestAnimationFrame(() => inp.select());
    });

    // Enter / Escape
    wrap.addEventListener("keydown", (e) => {
      const inp = e.target.closest(".dimsValueInput");
      if (!inp) return;

      const row = e.target.closest(".dimsRow");
      const dim = row?.getAttribute("data-dim");
      if (!dim) return;

      if (e.key === "Enter") {
        e.preventDefault();
        applyTypedValue(dim, inp.value);
        inp.blur();
      }

      if (e.key === "Escape") {
        e.preventDefault();
        render();
        redrawPlan();
        try { updateSummaryUI(); } catch (e) {}
        try { scheduleSummaryRecalc(); } catch (e) {}
        inp.blur();
      }
    });

    // blur = uloĹľit + clamp
    wrap.addEventListener("focusout", (e) => {
      const inp = e.target.closest(".dimsValueInput");
      if (!inp) return;

      const row = e.target.closest(".dimsRow");
      const dim = row?.getAttribute("data-dim");
      if (!dim) return;

      applyTypedValue(dim, inp.value);
    });

    wrap.dataset.bound = "1";
  }

  // =========================
  // 6) INIT + veĹ™ejnĂ˝ hook pro pĹ™epoÄŤet vÄ›tvĂ­
  // =========================
  function refreshBranchesUI() {
    const branches = detectBranchCount();
    buildRows(branches);
    render();
    renderSofaPlan(branches);
  }

  // expose pro volĂˇnĂ­ po kaĹľdĂ© zmÄ›nÄ› sestavy
  window.__refreshSofaDimsBranchesUI = refreshBranchesUI;

  window.__refreshSofaPlanEverywhere = function () {
    window.__refreshSofaDimsBranchesUI?.();
  };

  // prvnĂ­ render
  refreshSofaDimsUI();
}

function bindArmrestsEquipmentUI(modelKey) {
  const typeSelect = document.getElementById("armrestsTypeSelect");
  const row = document.getElementById("armrestsCardRow");
  if (!typeSelect || !row) return;

  const widthUI = bindArmrestWidthUI(modelKey);
  // 1) config pro model
  const cfg = MODEL_EQUIP_CONFIG?.[modelKey] || {};
  const armrestsUiList = Array.isArray(cfg.armrests) ? cfg.armrests : [];

  // KdyĹľ v configu nic nenĂ­, radĹˇi UI vyÄŤisti a skonÄŤi
  row.innerHTML = "";
  typeSelect.innerHTML = "";
  if (!armrestsUiList.length) {
    widthUI.setVisible(false);
    return;
  }

  // 2) Render kartiÄŤek (buttony)
  // POZOR: item.code by ideĂˇlnÄ› mÄ›l bĂ˝t "smooth" nebo "sharp"
  renderEquipBlock(armrestsUiList, row, "armrest");
  refreshManchesterArmrestPriceLabels();

  // 3) naplnit hidden select
  armrestsUiList.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.code;
    opt.textContent = item.label;
    typeSelect.appendChild(opt);
  });

  // 4) Normalizace hodnot -> co oÄŤekĂˇvĂˇ 3D logika
  function normalizeArmrestCode(val) {
    const v = String(val || "").trim().toLowerCase();

    // uĹľ sprĂˇvnÄ›:
    if (v === "smooth" || v === "sharp") return v;

    // bezpeÄŤnĂ© mapovĂˇnĂ­ (kdyĹľ bys nÄ›kde pouĹľil jinĂ© kĂłdy)
    const map = {
      // CZ
      "hranata": "sharp",
      "zakladni": "smooth",
      "pevna": "smooth",
      "kulata": "smooth",

      "polohovaci": "sharp",
      "polohovacĂ­": "sharp",
      "nastavitelna": "sharp",
      "nastavitelnĂˇ": "sharp",

      // EN
      "adjustable": "sharp",
      "fixed": "smooth",
      "basic": "smooth",
    };

    return map[v] || v; // kdyĹľ to neznĂˇm, nechĂˇm pĹŻvodnĂ­ (ale 3D pak nemusĂ­ reagovat)
  }

  function setActiveArmrest(rawVal, { fromUI = true } = {}) {
    const val = normalizeArmrestCode(rawVal);
    if (!val) return;

    // uloĹľit vĂ˝bÄ›r
    selectedArmrests = val;

    window.selectedArmrests = val;
    window.refreshSofaDimsUI?.();
    window.__refreshSofaPlanEverywhere?.();
    scheduleSummaryRecalc?.();

    // sync select (pozor: select mĂˇ opt.value z configu -> pokud config nepouĹľĂ­vĂˇ smooth/sharp,
    // tak nastavĂ­me i select na rawVal, ale pro 3D jedeme pĹ™es normalized)
    // NejlepĹˇĂ­ je: v configu pouĹľĂ­vej code="smooth"/"sharp".
    typeSelect.value = rawVal;

    // UI active state â€“ porovnĂˇvĂˇme s rawVal, protoĹľe data-armrest = item.code
    row.querySelectorAll(".tileCard").forEach((btn) => {
      const on = btn.dataset.armrest === String(rawVal);
      btn.classList.toggle("is-active", on);
      btn.classList.toggle("active", on);
    });

    refreshManchesterArmrestPriceLabels();

    // âś… 3D zmÄ›na + viditelnost ÄŤĂˇstĂ­ (hinge2, body1/body2â€¦)
    applyArmrestsToAllModules();
    refreshManchesterArmrestPriceLabels();

    // panel ĹˇĂ­Ĺ™ky jen pro "sharp"
    function isWidthArmrest(rawVal) {
      const v = String(rawVal || "").trim().toLowerCase();
      return v === "sharp" || v === "hranata";
    }

    // ...

    // Mendoza: ĹˇĂ­Ĺ™ka pro hranatou (smooth) + polohovacĂ­ (sharp)
    // Manila: ĹˇĂ­Ĺ™ka pro hranatou (sharp) + kulatou (smooth)
    const showWidth =
      (modelKey === "MELBOURNE")
        ? (val === "smooth")
        : (modelKey === "MENDOZA")
          ? (val === "smooth" || val === "sharp")
          : (val === "sharp" || val === "smooth");

    widthUI.applyContext?.(modelKey, val);
    widthUI.setVisible(showWidth);

    // ===== reset na vĂ˝chozĂ­ ĹˇĂ­Ĺ™ku podle modelu + typu podruÄŤky =====
    // (tĂ­m zabrĂˇnĂ­Ĺˇ pĹ™enĂˇĹˇenĂ­ "JinĂ© 14" z kulatĂ© do hranatĂ© atd.)
    const DEFAULT_WIDTH_BY_MODEL_AND_ARMREST = {
      MANILA:  { smooth: { fixed: 14 }, sharp: { preset: 20 } },
      MENDOZA: { smooth: { preset: 25 }, sharp: { fixed: 33 } },
      MELBOURNE: { smooth: { fixed: 13 } },

      // Manchester:
      // smooth = Polohovací
      // sharp  = Hranatá
      MANCHESTER: {
        smooth: { preset: 40 },
        sharp:  { preset: 25 },
      },
    };

    const rule = (DEFAULT_WIDTH_BY_MODEL_AND_ARMREST[modelKey] || {})[val] || null;

    // FIX reĹľim (jedno tlaÄŤĂ­tko)
    if (rule && typeof rule.fixed === "number") {

      if (modelKey === "MENDOZA" && val === "sharp") {
        widthUI.setFixed(rule.fixed, {
          fromUI: false,
          label: "Šířka područky (polohovací)",
          note: "Tato polohovací područka má pevnou šířku 33 cm a nelze ji upravovat po jednotlivých centimetrech."
        });
      } else if (modelKey === "MANILA" && val === "smooth") {
        widthUI.setFixed(rule.fixed, {
          fromUI: false,
          label: "Šířka područky (kulatá)",
          note: "Tato područka má pevnou šířku 14 cm a nelze ji upravovat."
        });
      } else if (modelKey === "MELBOURNE" && val === "smooth") {
        widthUI.setFixed(rule.fixed, {
          fromUI: false,
          label: "Šířka područky (Melbourne)",
          note: "Tato područka má pevnou šířku 13 cm a nelze ji upravovat."
        });
      } else {
        // fallback text (kdyby pĹ™ibyl novĂ˝ model)
        widthUI.setFixed(rule.fixed, {
          fromUI: false,
          label: "Šířka područky",
          note: `Tato područka má pevnou šířku ${rule.fixed} cm a nelze ji upravovat po jednotlivých centimetrech.`
        });
      }

    } else {
      // VARIABLE reĹľim (presety + "JinĂ©") â†’ vĹľdy vraĹĄ na vĂ˝chozĂ­ preset
      widthUI.setFixed(null, { fromUI: false });

      const preset = (rule && typeof rule.preset === "number") ? rule.preset : 15;

      // tohle ti zaruÄŤĂ­: preset mĂłd + sprĂˇvnÄ› aktivnĂ­ chip + nebude svĂ­tit "JinĂ©"
      if (typeof window.__setArmrestWidthFromState === "function") {
        window.__setArmrestWidthFromState(preset, "preset");
      } else {
        // fallback kdyby hook nebyl k dispozici
        widthUI.setMode("preset", { fromUI: false });
        widthUI.setValue(preset, { fromUI: false });
      }
    }

    // u tebe applyArmrestsToAllModules uĹľ dÄ›lĂˇ saveStateDebounced?.(50),
    // takĹľe tady uĹľ nic extra netĹ™eba â€“ ale nevadĂ­, kdyĹľ chceĹˇ:
    if (fromUI) saveStateDebounced?.(50);

    // dĹŻleĹľitĂ©: refresh aĹľ po nastavenĂ­ sprĂˇvnĂ© ĹˇĂ­Ĺ™ky/typu podruÄŤky
    window.refreshSofaDimsUI?.();
    window.__refreshSofaPlanEverywhere?.();
    scheduleSummaryRecalc?.();
  }

  // 5) Handlery â€“ pĹ™epĂ­Ĺˇeme natvrdo, aĹĄ se nikdy â€śnechytne starĂ˝â€ť
  row.onclick = (e) => {
    const btn = e.target.closest("button[data-armrest]");
    if (!btn) return;
    setActiveArmrest(btn.dataset.armrest, { fromUI: true });
  };

  typeSelect.onchange = () => {
    setActiveArmrest(typeSelect.value, { fromUI: true });
  };

  // 6) restore hook
  window.__setArmrestsFromState = (armrestType) => {
    if (!armrestType) return;
    setActiveArmrest(armrestType, { fromUI: false });
  };

  // 7) init â€“ vyber aktuĂˇlnĂ­ nebo fallback
  const allowedRaw = new Set(armrestsUiList.map((x) => String(x.code)));
  const currentRaw = String(typeSelect.value || "").trim() || String(selectedArmrests || "").trim();
  const fallbackRaw = String(armrestsUiList[0].code);

  const initialRaw = allowedRaw.has(currentRaw) ? currentRaw : fallbackRaw;
  setActiveArmrest(initialRaw, { fromUI: false });
}

function bindArmrestWidthUI(modelKey = String(appState?.model || "").trim().toUpperCase()) {
  const block = document.getElementById("armrestWidthBlock");
  const quick = document.getElementById("armrestWidthQuick");
  const customBtn = document.getElementById("armrestWidthCustomBtn");
  const customWrap = document.getElementById("armrestWidthCustom");
  const range = document.getElementById("armrestWidthRange");
  const valueEl = document.getElementById("armrestWidthValue");
  const noteEl = document.getElementById("armrestWidthNote");

  const fixedWrap = document.getElementById("armrestWidthFixed");
  const fixedBtn  = document.getElementById("armrestWidthFixedBtn");

  const labelEl = block ? block.querySelector(".equipLabel") : null;
  const defaultLabelText = labelEl ? labelEl.textContent : "";
  const defaultNoteText  = noteEl ? noteEl.textContent : "";

  if (!block || !quick || !customBtn || !customWrap || !range || !valueEl) {
    return {
      applyContext: () => {},
      setVisible: () => {},
      setValue: () => {},
      setMode: () => {},
      setFixed: () => {}
    };
  }

  // stav módu + fixed
  window.selectedArmrestWidthMode = window.selectedArmrestWidthMode || "preset"; // "preset" | "custom"
  window.selectedArmrestWidthIsFixed = window.selectedArmrestWidthIsFixed || false;

  function getWidthUiContext(activeModelKey = modelKey, armrestType = (window.selectedArmrests || selectedArmrests || "smooth")) {
    const mk = String(activeModelKey || "").trim().toUpperCase();
    const t = String(armrestType || "").trim().toLowerCase();

    // MANILA — hranatá
    // 3D model je zobrazený s područkou 20 cm
    if (mk === "MANILA" && t === "sharp") {
      return {
        presetValues: null,
        hidePresetValues: new Set([25]),
        moveCustomIntoGrid: true,
        hideSlider: true,
        modalPresetLabel: "10 / 15 / 20 cm",
        noteText: "Šířka se v náhledu 3D vizuálně nemění. 3D model je zobrazen s šířkou 20 cm pro porovnání proporcí."
      };
    }

    // MENDOZA — hranatá područka
    // Dostupné 15 / 20 / 25 cm, 3D model = 25 cm
    if (mk === "MENDOZA" && t === "smooth") {
      return {
        presetValues: null,
        hidePresetValues: new Set([10]),
        moveCustomIntoGrid: true,
        hideSlider: true,
        modalPresetLabel: "15 / 20 / 25 cm",
        noteText: "Šířka se v náhledu 3D vizuálně nemění. 3D model je zobrazen s šířkou 25 cm pro porovnání proporcí."
      };
    }

    // MANCHESTER — hranatá
    // Dostupné 15 / 20 / 25 cm, 3D model = 25 cm
    if (mk === "MANCHESTER" && t === "sharp") {
      return {
        presetValues: [15, 20, 25],
        hidePresetValues: new Set(),
        moveCustomIntoGrid: true,
        hideSlider: true,
        modalPresetLabel: "15 / 20 / 25 cm",
        noteText: "Šířka se v náhledu 3D vizuálně nemění. 3D model je zobrazen s šířkou 25 cm pro porovnání proporcí."
      };
    }

    // MANCHESTER — polohovací
    // Dostupné 30 / 35 / 40 cm, 3D model = 40 cm
    if (mk === "MANCHESTER" && t === "smooth") {
      return {
        presetValues: [30, 35, 40],
        hidePresetValues: new Set(),
        moveCustomIntoGrid: true,
        hideSlider: true,
        modalPresetLabel: "30 / 35 / 40 cm",
        noteText: "Šířka se v náhledu 3D vizuálně nemění. 3D model je zobrazen s šířkou 40 cm pro porovnání proporcí."
      };
    }

    return {
      presetValues: null,
      hidePresetValues: new Set(),
      moveCustomIntoGrid: false,
      hideSlider: false,
      modalPresetLabel: "10 / 15 / 20 / 25 cm",
      noteText: defaultNoteText
    };
  }

  function applyContext(activeModelKey = modelKey, armrestType = (window.selectedArmrests || selectedArmrests || "smooth")) {
    const ctx = getWidthUiContext(activeModelKey, armrestType);
    const customCol = customBtn?.closest(".armrestWidthCustomCol");

    block.dataset.customMode = ctx.hideSlider ? "modal" : "slider";
    block.dataset.modalPresetLabel = ctx.modalPresetLabel;

    const defaultPresetValues = [10, 15, 20, 25];
    const presetValues = Array.isArray(ctx.presetValues)
      ? ctx.presetValues
      : defaultPresetValues;

    quick.querySelectorAll(".chipBtn[data-armrest-width]").forEach((b, index) => {
      const nextValue = presetValues[index];

      if (typeof nextValue !== "number") {
        b.style.display = "none";
        return;
      }

      b.dataset.armrestWidth = String(nextValue);
      b.textContent = `${nextValue} cm`;

      b.style.display = ctx.hidePresetValues.has(nextValue) ? "none" : "";
    });

    if (ctx.moveCustomIntoGrid) {
      if (customBtn.parentElement !== quick) quick.appendChild(customBtn);
      customBtn.classList.remove("chipCustom");
      customBtn.style.display = "";
      if (customCol) customCol.style.display = "none";
      customWrap.style.display = "none";
    } else {
      if (customCol) customCol.style.display = "";
      if (customBtn && customCol && customBtn.parentElement !== customCol) {
        customCol.insertBefore(customBtn, customCol.firstChild);
      }
      customBtn.classList.add("chipCustom");
      customWrap.style.display = window.selectedArmrestWidthIsFixed ? "none" : "";
    }

    if (noteEl) noteEl.textContent = ctx.noteText;
  }

  function applyFixedUI(isFixed) {
    quick.style.display = isFixed ? "none" : "";
    customBtn.style.display = isFixed ? "none" : "";
    customWrap.style.display = isFixed ? "none" : "";
    block.classList.toggle("is-fixed-single", !!isFixed);

    if (fixedWrap) fixedWrap.style.display = isFixed ? "" : "none";

    if (labelEl) {
      const fixedLabel = window.selectedArmrestWidthFixedLabel;
      labelEl.textContent = isFixed ? (fixedLabel || "Šířka područky") : defaultLabelText;
    }

    if (!isFixed) {
      const activeModelKey =
        typeof getArmrestWidthActiveModelKey === "function"
          ? getArmrestWidthActiveModelKey()
          : modelKey;

      const activeArmrestType =
        typeof getArmrestWidthActiveType === "function"
          ? getArmrestWidthActiveType()
          : (window.selectedArmrests || selectedArmrests || "smooth");

      const ctx = getWidthUiContext(activeModelKey, activeArmrestType);

      customWrap.style.display = ctx.hideSlider ? "none" : "";

      if (noteEl) {
        noteEl.textContent = ctx.noteText;
      }
    }
  }

  function setMode(mode, { fromUI = true } = {}) {
    if (window.selectedArmrestWidthIsFixed) return;

    window.selectedArmrestWidthMode = mode;

    customBtn.classList.toggle("is-active", mode === "custom");

    if (mode === "custom") {
      quick.querySelectorAll(".chipBtn[data-armrest-width]").forEach((b) => {
        b.classList.remove("is-active");
      });
    }

    if (fromUI) {
      saveStateDebounced?.(50);
      scheduleSummaryRecalc();
    }
  }

  function setActiveChip(cm) {
    quick.querySelectorAll(".chipBtn[data-armrest-width]").forEach((b) => {
      b.classList.toggle("is-active", Number(b.dataset.armrestWidth) === Number(cm));
    });
  }

  function getArmrestWidthActiveModelKey() {
    // DŮLEŽITÉ:
    // Nepoužívat jen uzavřený "modelKey" z bindArmrestWidthUI().
    // Ten může být starý, pokud se UI bindovalo před změnou modelu.
    //
    // Potřebujeme aktuální model ze scény / appState.
    const raw =
      getActiveSofaKeyFromScene?.() ||
      appState?.model ||
      modelKey ||
      "";

    return String(raw).trim().toUpperCase();
  }

  function getArmrestWidthActiveType() {
    return String(window.selectedArmrests || selectedArmrests || "smooth")
      .trim()
      .toLowerCase();
  }

  function getCurrentPresetSet() {
    const ctx = getWidthUiContext(
      getArmrestWidthActiveModelKey(),
      getArmrestWidthActiveType()
    );

    return new Set(
      Array.isArray(ctx.presetValues)
        ? ctx.presetValues
        : [10, 15, 20, 25]
    );
  }

  function setValue(cm, { fromUI = true } = {}) {
    const isFixed = !!window.selectedArmrestWidthIsFixed;

    const activeModelKey = getArmrestWidthActiveModelKey();
    const activeArmrestType = getArmrestWidthActiveType();

    const ctx = getWidthUiContext(
      activeModelKey,
      activeArmrestType
    );

    const presetValues = Array.isArray(ctx.presetValues)
      ? ctx.presetValues
      : [10, 15, 20, 25];

    const presetMin = Math.min(...presetValues);
    const presetMax = Math.max(...presetValues);

    const min = isFixed
      ? Number(window.selectedArmrestWidthFixedCm || presetMin || 10)
      : Math.min(10, presetMin);

    const max = isFixed
      ? Number(window.selectedArmrestWidthFixedCm || presetMax || 25)
      : Math.max(25, presetMax);

    const numericCm = Number(cm);
    const fallback =
      Number(window.selectedArmrestWidth) ||
      Number(window.selectedArmrestSharpWidthCm) ||
      Number(selectedArmrestSharpWidthCm) ||
      Number(ctx.presetValues?.[ctx.presetValues.length - 1]) ||
      15;

    const raw = Number.isFinite(numericCm) ? numericCm : fallback;
    const v = Math.max(min, Math.min(max, raw));

    selectedArmrestSharpWidthCm = v;
    window.selectedArmrestSharpWidthCm = v;
    window.selectedArmrestWidth = v;

    // Range může mít u původního UI max 25.
    // U Manchester polohovací jsou hodnoty 30/35/40 a slider je schovaný,
    // takže range.value aktualizujeme jen pokud se hodnota do range vejde.
    const rangeMin = Number(range.min || 10);
    const rangeMax = Number(range.max || 25);

    if (v >= rangeMin && v <= rangeMax) {
      range.value = String(v);
    }

    valueEl.textContent = String(v);

    if (fromUI) {
      saveStateDebounced?.(50);

      // Přepočet rozměrů v tabu vpravo dole
      window.refreshSofaDimsUI?.();

      // Přepočet půdorysu / kót
      window.__refreshSofaPlanEverywhere?.();

      // Přepočet horní SummaryUI karty hned po kliknutí na 30/35/40
      try { updateSummaryUI?.(); } catch (e) {}

      // Zachovat původní odložený přepočet
      scheduleSummaryRecalc?.();
    }
  }

  function setFixed(fixedCmOrNull, { label, note, fromUI = true } = {}) {
    const isFixed = typeof fixedCmOrNull === "number" && !Number.isNaN(fixedCmOrNull);

    window.selectedArmrestWidthIsFixed = isFixed;

    if (isFixed) {
      const fixedCm = fixedCmOrNull;

      window.selectedArmrestWidthFixedCm = fixedCm;
      window.selectedArmrestWidthFixedLabel = label || null;
      window.selectedArmrestWidthFixedNote =
        note || `Tato područka má pevnou šířku ${fixedCm} cm a nelze ji upravovat po jednotlivých centimetrech.`;

      applyFixedUI(true);

      if (fixedBtn) fixedBtn.textContent = `${fixedCm} cm`;

      setValue(fixedCm, { fromUI: false });

      if (noteEl) noteEl.textContent = window.selectedArmrestWidthFixedNote;

      customBtn.classList.remove("is-active");
      quick.querySelectorAll(".chipBtn[data-armrest-width]").forEach((b) => {
        b.classList.remove("is-active");
      });
    } else {
      window.selectedArmrestWidthFixedCm = null;
      window.selectedArmrestWidthFixedLabel = null;
      window.selectedArmrestWidthFixedNote = null;

      applyFixedUI(false);

      const initV = Number(
        window.selectedArmrestWidth ||
        selectedArmrestSharpWidthCm ||
        range.value ||
        15
      );

      setValue(initV, { fromUI: false });

      const presetSet = getCurrentPresetSet();
      const valueNow = Number(window.selectedArmrestWidth || selectedArmrestSharpWidthCm || initV);

      if (window.selectedArmrestWidthMode === "preset" && presetSet.has(valueNow)) {
        customBtn.classList.remove("is-active");
        setActiveChip(valueNow);
      } else {
        setMode("custom", { fromUI: false });
      }

      // DŮLEŽITÉ:
      // Nesmíme sem vracet defaultNoteText.
      // Ten je text z DOMu v momentě bindu a způsobuje přenos textu
      // z předchozí pohovky / předchozí područky.
      const activeModelKey =
        typeof getArmrestWidthActiveModelKey === "function"
          ? getArmrestWidthActiveModelKey()
          : modelKey;

      const activeArmrestType =
        typeof getArmrestWidthActiveType === "function"
          ? getArmrestWidthActiveType()
          : (window.selectedArmrests || selectedArmrests || "smooth");

      const ctx = getWidthUiContext(activeModelKey, activeArmrestType);

      if (noteEl) {
        noteEl.textContent = ctx.noteText;
      }
    }

    if (fromUI) {
      saveStateDebounced?.(50);
      window.refreshSofaDimsUI?.();
      window.__refreshSofaPlanEverywhere?.();
      scheduleSummaryRecalc();
    }
  }

  function setVisible(isShown) {
    block.style.display = isShown ? "" : "none";
  }

  // klik na presety
  if (!quick.dataset.bound) {
    quick.addEventListener("click", (e) => {
      if (window.selectedArmrestWidthIsFixed) return;

      const btn = e.target.closest("button[data-armrest-width]");
      if (!btn) return;

      const v = Number(btn.dataset.armrestWidth);

      setMode("preset", { fromUI: true });
      setActiveChip(v);
      setValue(v, { fromUI: true });
    });

    quick.dataset.bound = "1";
  }

  // klik na "Jiné"
  if (!customBtn.dataset.bound) {
    customBtn.addEventListener("click", (e) => {
      if (window.selectedArmrestWidthIsFixed) return;

      const mk =
        String(getActiveSofaKeyFromScene?.() || appState?.model || "")
          .trim()
          .toLowerCase();

      if (mk === "mendoza") {
        e.preventDefault();
        e.stopPropagation();
        openArmrestCustomModal({
          modelName: "Mendoza",
          presetLabel: block.dataset.modalPresetLabel || "15 / 20 / 25 cm"
        });
        return;
      }

      if (mk === "manila" && block.dataset.customMode === "modal") {
        e.preventDefault();
        e.stopPropagation();
        openArmrestCustomModal({
          modelName: "Manila",
          presetLabel: block.dataset.modalPresetLabel || "10 / 15 / 20 cm"
        });
        return;
      }

      if (mk === "manchester" && block.dataset.customMode === "modal") {
        e.preventDefault();
        e.stopPropagation();
        openArmrestCustomModal({
          modelName: "Manchester",
          presetLabel: block.dataset.modalPresetLabel || "30 / 35 / 40 cm"
        });
        return;
      }

      // ostatní modely: původní chování se sliderem
      setMode("custom", { fromUI: true });
      setValue(range.value, { fromUI: true });
    });

    customBtn.dataset.bound = "1";
  }

  // slider input
  if (!range.dataset.bound) {
    range.addEventListener("input", () => {
      if (window.selectedArmrestWidthIsFixed) return;

      setMode("custom", { fromUI: true });
      setValue(range.value, { fromUI: true });
    });

    range.dataset.bound = "1";
  }

  applyContext(modelKey, window.selectedArmrests || selectedArmrests || "smooth");

  // INIT normál
  applyFixedUI(!!window.selectedArmrestWidthIsFixed);

  if (!window.selectedArmrestWidthIsFixed) {
    const initV = Number(
      window.selectedArmrestWidth ||
      selectedArmrestSharpWidthCm ||
      range.value ||
      15
    );

    setValue(initV, { fromUI: false });

    const presetSet = getCurrentPresetSet();
    const valueNow = Number(window.selectedArmrestWidth || selectedArmrestSharpWidthCm || initV);

    if (window.selectedArmrestWidthMode === "preset" && presetSet.has(valueNow)) {
      customBtn.classList.remove("is-active");
      setActiveChip(valueNow);
    } else {
      setMode("custom", { fromUI: false });
    }
  }

  // restore hook
  window.__setArmrestWidthFromState = (cm, mode) => {
    if (window.selectedArmrestWidthIsFixed) {
      try { window.refreshSofaDimsUI?.(); } catch (e) {}
      try { window.__refreshSofaPlanEverywhere?.(); } catch (e) {}
      try { updateSummaryUI?.(); } catch (e) {}
      try { scheduleSummaryRecalc?.(); } catch (e) {}
      return;
    }

    const normalizedMode = (mode === "custom" || mode === "preset")
      ? mode
      : "preset";

    const v = (typeof cm === "number") ? cm : Number(cm);

    setMode(normalizedMode, { fromUI: false });

    if (!Number.isNaN(v)) {
      setValue(v, { fromUI: false });
    }

    const valueNow = Number(
      window.selectedArmrestWidth ||
      window.selectedArmrestSharpWidthCm ||
      selectedArmrestSharpWidthCm ||
      range.value ||
      15
    );

    const presetSet = getCurrentPresetSet();

    if (normalizedMode === "preset" && presetSet.has(valueNow)) {
      customBtn.classList.remove("is-active");
      setActiveChip(valueNow);
    } else {
      quick.querySelectorAll(".chipBtn[data-armrest-width]").forEach((b) => {
        b.classList.remove("is-active");
      });

      customBtn.classList.add("is-active");
    }

    // DŮLEŽITÉ:
    // Po restore / změně hodnoty musí přepočítat nejen cenu, ale i rozměrové řádky,
    // protože rekapitulace bere rozměry z #sofaDimsRows.
    try { window.refreshSofaDimsUI?.(); } catch (e) {}
    try { window.__refreshSofaPlanEverywhere?.(); } catch (e) {}
    try { updateSummaryUI?.(); } catch (e) {}
    try { scheduleSummaryRecalc?.(); } catch (e) {}
  };

  return { applyContext, setVisible, setValue, setMode, setFixed };
}

function bindHingesEquipmentUI() {
  const typeSelect = document.getElementById("hingesTypeSelect");
  const row = document.getElementById("hingesCardRow");
  if (!typeSelect || !row) return;

  function setActiveHinge(val, { fromUI = true } = {}) {
    if (!val) return;

    selectedHinges = val;
    typeSelect.value = val;

    row.querySelectorAll(".tileCard").forEach((btn) => {
      const on = btn.dataset.hinge === val;
      btn.classList.toggle("is-active", on);
      btn.classList.toggle("active", on);
    });

    applyHingesToAllModules();

    if (fromUI) saveStateDebounced();
  }

  row.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-hinge]");
    if (!btn) return;
    setActiveHinge(btn.dataset.hinge, { fromUI: true });
  });

  typeSelect.addEventListener("change", () => {
    setActiveHinge(typeSelect.value, { fromUI: true });
  });

  window.__setHingesFromState = (hingeType) => {
    if (!hingeType) return;
    setActiveHinge(hingeType, { fromUI: false });
  };

  setActiveHinge(typeSelect.value || selectedHinges || "standard", { fromUI: false });
}

function applyEquipVisibilityForModel(modelKey) {
  const cfg = MODEL_EQUIP_CONFIG?.[modelKey];
  if (!cfg) return;

  // --- ARMRESTS: schovej/ukaĹľ tlaÄŤĂ­tka podle cfg.armrests
  {
    const row = document.getElementById("armrestsCardRow");
    const typeSelect = document.getElementById("armrestsTypeSelect");
    if (row) {
      const allowed = new Set((cfg.armrests || []).map(x => x.code));
      row.querySelectorAll("button[data-armrest]").forEach(btn => {
        const code = btn.dataset.armrest;
        btn.classList.toggle("hidden", !allowed.has(code));
      });

      // pokud je vybranĂˇ nepovolenĂˇ, pĹ™epni na prvnĂ­ povolenou
      const current = (typeSelect?.value || selectedArmrests || "").trim();
      if (!allowed.has(current)) {
        const first = cfg.armrests?.[0]?.code;
        if (first) {
          if (typeSelect) typeSelect.value = first;
          if (window.__setArmrestsFromState) window.__setArmrestsFromState(first);
        }
      }
    }
  }

  // --- HINGES: schovej/ukaĹľ tlaÄŤĂ­tka podle cfg.hinges
  {
    const row = document.getElementById("hingesCardRow");
    const typeSelect = document.getElementById("hingesTypeSelect");
    if (row) {
      const allowed = new Set((cfg.hinges || []).map(x => x.code));
      row.querySelectorAll("button[data-hinge]").forEach(btn => {
        const code = btn.dataset.hinge;
        btn.classList.toggle("hidden", !allowed.has(code));
      });

      const current = (typeSelect?.value || selectedHinges || "").trim();
      if (!allowed.has(current)) {
        const first = cfg.hinges?.[0]?.code;
        if (first) {
          if (typeSelect) typeSelect.value = first;
          if (window.__setHingesFromState) window.__setHingesFromState(first);
        }
      }
    }
  }

  // --- LEGS: tohle uĹľ generujeĹˇ podle modelu pĹ™es bindLegsEquipmentUI(modelKey)
  bindLegsEquipmentUI(modelKey);
  bindShelfEquipmentUI();
  syncMelbourneShelfTabVisibility();
}

function bindStepToggle(stepBarId, toggleId) {
  const bar = document.getElementById(stepBarId);
  const btn = document.getElementById(toggleId);
  if (!bar || !btn) return;

  btn.addEventListener("click", () => {
    bar.classList.toggle("is-collapsed");
    const collapsed = bar.classList.contains("is-collapsed");
    btn.setAttribute("aria-label", collapsed ? "Rozbalit kroky" : "Sbalit kroky");
  });
}

bindStepToggle("stepBar", "stepToggle");
bindStepToggle("stepBarLanding", "stepToggleLanding");

bindSofaDimsUI();

// âś… default vybavenĂ­ pĹ™i startu novĂ© konfigurace z landing (PODLE MODELU)
const DEFAULT_EQUIP_BY_MODEL = {
  MANILA: {
    legs: "N7",
    legsColor: "wood_buk_prirodni", // Buk pĹ™Ă­rodnĂ­
    armrests: "smooth",
    hinges: "standard",
  },
  MENDOZA: {
    legs: "N8",
    legsColor: "metal_chrome", // âś… Mendoza: default N8 + chrom
    armrests: "smooth",
    hinges: "standard",
  },
  MELBOURNE: {
    legs: "N9",
    legsColor: "wood_buk_prirodni",
    shelfColor: "wood_buk_br_281",
    armrests: "smooth",
    hinges: "standard",
  },
  MANCHESTER: {
    legs: "N21",
    legsColor: "metal_chrome",
    armrests: "smooth",
    hinges: "",
  },
};

function getDefaultEquipForModel(modelName) {
  const key = String(modelName || appState.model || "MANILA").toUpperCase();
  return DEFAULT_EQUIP_BY_MODEL[key] || DEFAULT_EQUIP_BY_MODEL.MANILA;
}

function applyDefaultEquipForNewConfig(modelName) {
  const def = getDefaultEquipForModel(modelName);

  // 1) logickĂ˝ stav
  selectedLegs = def.legs;
  selectedArmrests = def.armrests;
  selectedHinges = def.hinges;

  // 2) UI + 3D pĹ™es hooky
  if (window.__setLegsFromState) {
    window.__setLegsFromState(def.legs, def.legsColor);
  }
  if (window.__setArmrestsFromState) {
    window.__setArmrestsFromState(def.armrests);
  }
  if (window.__setHingesFromState) {
    window.__setHingesFromState(def.hinges);
  }
  selectedShelfColor = def.shelfColor || selectedShelfColor || "wood_buk_br_281";
  if (window.__setShelfColorFromState) {
    window.__setShelfColorFromState(selectedShelfColor);
  }

  saveStateDebounced();
}

function refreshEquipmentUiForCurrentModel() {
  try { bindLegsEquipmentUI(); } catch (e) { console.warn("bindLegsEquipmentUI failed:", e); }
  try { bindShelfEquipmentUI(); } catch (e) { console.warn("bindShelfEquipmentUI failed:", e); }
  try { bindArmrestsEquipmentUI(getModelKey()); } catch (e) { console.warn("bindArmrestsEquipmentUI failed:", e); }
  try { bindHingesEquipmentUI(); } catch (e) { console.warn("bindHingesEquipmentUI failed:", e); }
  try { updateBottomBarUI(); } catch (e) {}
}

function startConfigurator(modelName, presetKey = null) {

  if (isRestoringState) return;

  currentDraftId = null;
  hasUserTouchedLegs = false;

  resetFabricSelectionState({ save: false });

  clearSceneForPreset();
  cameraPinned = false;  
  hardResetCameraToDefault();

  // âś… VĹ˝DYCKY zaÄŤni ÄŤistou scĂ©nou (aĹĄ jdeĹˇ z landing na cokoliv)
  clearSceneForPreset(); // maĹľe activeModules + activeButtons + vracĂ­ startButton

  // volitelnÄ›: zavĹ™i UI vÄ›ci, kdyby zĹŻstaly otevĹ™enĂ©
  try { closePicker(); } catch(e) {}
  try { closeActionMenu(); } catch(e) {}

  appState.model = modelName;

  try { updateSummaryUI(); } catch (e) {}

  // âś… po nastavenĂ­ modelu pĹ™ekresli vybavení pro daný model
  refreshEquipmentUiForCurrentModel();

  // âś… a teprve potom aplikuj default vybavenĂ­ PODLE MODELU
  applyDefaultEquipForNewConfig(modelName);
  window.__refreshSofaPlanEverywhere?.();

  // âś… pĹ™epoÄŤĂ­tej "Manila/Mendoza" a spusĹĄ prefetch jen pro tuhle sedaÄŤku
  const sofaKey = normalizeSofaKey(appState.model);
  if (sofaKey) queuePrefetchForSofa(sofaKey);

  setUnlockedStep(2);

  showView("configurator", { push: false });
  setStep(2, { push: false });

  pushRoute(false);

  pendingCanonicalAnalysis = null;
  needsCanonicalRebuild = false;

  if (isBuildStepActive()) {
    scheduleCanonicalRebuildAnalysis();
  }

  debugLog("Start configurator for:", modelName, "preset:", presetKey);

  // âś… kdyĹľ je preset, tak ho rovnou postav do scĂ©ny
  if (presetKey) {
    requestAnimationFrame(() => {
      loadPresetIntoScene(presetKey).catch(console.error);
    });
  } else {
    // âś… custom / prĂˇzdnĂˇ scĂ©na â†’ pĹ™epoÄŤĂ­tej summary (aĹĄ se hned ukĂˇĹľe 0 KÄŤ, 0Ă—0)
    try { scheduleSummaryRecalc(); } catch(e) {}
  }
}

// -----------------------------------------------------
//  PRESETY (AUTO SESTAVY)
// -----------------------------------------------------

// klĂ­ÄŤe si pojmenuj jak chceĹˇ, ale aĹĄ sedĂ­ s data-preset v HTML
const PRESETS = {
  "manila-2-1d": {
    steps: [
      { variantId: "Manila_1D_L", attachTo: null, side: null },          // prvnĂ­ kus do scĂ©ny
      { variantId: "Manila_2P",   attachTo: 0,    side: "right" },       // k 1D zprava 2P
    ],
  },

  "manila-2-roh-1": {
    steps: [
      { variantId: "Manila_2P",     attachTo: null, side: null },        // prvnĂ­ kus
      { variantId: "Manila_roh_L",  attachTo: 0,    side: "left" },      // k 2P zleva roh_L
      { variantId: "Manila_1L",     attachTo: 1,    side: "front" },     // k rohu zepĹ™edu 1P
    ],
  },

  "manila-2-roh-1mo": {
    steps: [
      { variantId: "Manila_2L",      attachTo: null, side: null },       // prvnĂ­ kus
      { variantId: "Manila_roh_P",   attachTo: 0,    side: "right" },    // k 2L zprava roh_P
      { variantId: "Manila_1MO_P",   attachTo: 1,    side: "front" },    // k rohu zepĹ™edu 1MO_P
    ],
  },

  "manila-2-roh-2": {
    steps: [
      { variantId: "Manila_2L",     attachTo: null, side: null },        // prvnĂ­ kus
      { variantId: "Manila_roh_P",  attachTo: 0,    side: "right" },     // k 2L zprava roh_P
      { variantId: "Manila_2P",     attachTo: 1,    side: "front" },     // k rohu zepĹ™edu 2P
    ],
  },

    // =========================
  // MENDOZA (stejnĂˇ logika jako Manila, jen jinĂ© variantId)
  // =========================
  "mendoza-2-1d": {
    steps: [
      { variantId: "Mendoza_1D_L", attachTo: null, side: null },
      { variantId: "Mendoza_2P",   attachTo: 0,    side: "right" },
    ],
  },

  "mendoza-2-roh-1": {
    steps: [
      { variantId: "Mendoza_2P",     attachTo: null, side: null },
      { variantId: "Mendoza_roh_L",  attachTo: 0,    side: "left" },
      { variantId: "Mendoza_1L",     attachTo: 1,    side: "front" },
    ],
  },

  "mendoza-2-roh-1mo": {
    steps: [
      { variantId: "Mendoza_2L",     attachTo: null, side: null },
      { variantId: "Mendoza_roh_P",  attachTo: 0,    side: "right" },
      { variantId: "Mendoza_1MO_P",  attachTo: 1,    side: "front" },
    ],
  },

  "mendoza-2-roh-2": {
    steps: [
      { variantId: "Mendoza_2L",     attachTo: null, side: null },
      { variantId: "Mendoza_roh_P",  attachTo: 0,    side: "right" },
      { variantId: "Mendoza_2P",     attachTo: 1,    side: "front" },
    ],
  },

  // =========================
  // MELBOURNE
  // =========================
  "MELBOURNE_2_1D": {
    steps: [
      { variantId: "Melbourne_1D_L", attachTo: null, side: null },
      { variantId: "Melbourne_2P",   attachTo: 0,    side: "right" },
    ],
  },

  "MELBOURNE_2_ROH_1": {
    steps: [
      { variantId: "Melbourne_2P",     attachTo: null, side: null },
      { variantId: "Melbourne_roh_L",  attachTo: 0,    side: "left" },
      { variantId: "Melbourne_1L",     attachTo: 1,    side: "front" },
    ],
  },

  "MELBOURNE_2_ROH_1MO": {
    steps: [
      { variantId: "Melbourne_2L",      attachTo: null, side: null },
      { variantId: "Melbourne_roh_P",   attachTo: 0,    side: "right" },
      { variantId: "Melbourne_1MO_P",   attachTo: 1,    side: "front" },
    ],
  },

  "MELBOURNE_2_ROH_2": {
    steps: [
      { variantId: "Melbourne_2L",     attachTo: null, side: null },
      { variantId: "Melbourne_roh_P",  attachTo: 0,    side: "right" },
      { variantId: "Melbourne_2P",     attachTo: 1,    side: "front" },
    ],
  },

  // =========================
  // MANCHESTER
  // Presety = startovací sestavy z kroku 1, ne příplatky.
  // =========================
  "MANCHESTER_2_1D": {
    steps: [
      { variantId: "Manchester_1D_L", attachTo: null, side: null },
      { variantId: "Manchester_2P",   attachTo: 0,    side: "right" },
    ],
  },

  "MANCHESTER_2_ROH_1": {
    steps: [
      { variantId: "Manchester_2P",     attachTo: null, side: null },
      { variantId: "Manchester_roh_L",  attachTo: 0,    side: "left" },
      { variantId: "Manchester_1L",     attachTo: 1,    side: "front" },
    ],
  },

  "MANCHESTER_2_ROH_1MO": {
    steps: [
      { variantId: "Manchester_2L",      attachTo: null, side: null },
      { variantId: "Manchester_roh_P",   attachTo: 0,    side: "right" },
      { variantId: "Manchester_1MO_P",   attachTo: 1,    side: "front" },
    ],
  },

  "MANCHESTER_2_ROH_2": {
    steps: [
      { variantId: "Manchester_2L",     attachTo: null, side: null },
      { variantId: "Manchester_roh_P",  attachTo: 0,    side: "right" },
      { variantId: "Manchester_2P",     attachTo: 1,    side: "front" },
    ],
  },
};

// vyÄŤistĂ­ scĂ©nu (moduly + jejich tlaÄŤĂ­tka) a nechĂˇ start button znovu â€śÄŤistĂ˝â€ť
function clearSceneForPreset() {
  // odstranit moduly (odzadu, bezpeÄŤnÄ›)
  for (let i = activeModules.length - 1; i >= 0; i--) {
    const mesh = activeModules[i]?.mesh;
    if (mesh) removeModuleCompletely(mesh);
  }

  // vyÄŤistit recordy
  activeModules.length = 0;

  // Nová prázdná sestava = upozornění na výchozí nohy se smí zobrazit znovu.
  resetLegsUntouchedWarningForCurrentBuild();

  // odstranit zbylĂˇ tlaÄŤĂ­tka (kdyby nÄ›co zĹŻstalo)
  for (let i = activeButtons.length - 1; i >= 0; i--) {
    if (activeButtons[i]?.mesh) scene.remove(activeButtons[i].mesh);
    activeButtons.splice(i, 1);
  }

  // start button zpÄ›t
  if (startButton) {
    startButton.visible = true;
    startButton.userData.isStartButton = true;
  }

  // reset pending stavu
  pendingAddPosition = null;
  pendingAddButton = null;
  pendingAddDirection = null;
  pendingAddRotY = 0;
  pendingAddShift = null;
  pendingAddBaseModule = null;
  replaceTarget = null;

  saveStateDebounced();
}

// (chooseModule bere variantId â€“ ty tam uĹľ takhle volĂˇĹˇ chooseModule(variantId) z pickeru)
async function addVariantAsFirst(variantId) {
  // simulace â€śklik na start buttonâ€ť
  pendingAddPosition = startButton ? startButton.position.clone() : new THREE.Vector3(0, 0, 0);
  pendingAddButton = startButton || null;
  pendingAddDirection = null;
  pendingAddRotY = 0;
  pendingAddShift = null;
  pendingAddBaseModule = null;
  replaceTarget = null;

  await chooseModule(variantId);

  // vrĂˇtĂ­ mesh poslednĂ­ho pĹ™idanĂ©ho modulu
  return activeModules[activeModules.length - 1]?.mesh || null;
}

async function addVariantAttached(variantId, baseMesh, side) {
  pendingAddPosition = baseMesh ? baseMesh.position.clone() : new THREE.Vector3(0, 0, 0);
  pendingAddButton = null;
  pendingAddDirection = side;          // "left/right/front/back"
  pendingAddBaseModule = baseMesh;
  replaceTarget = null;

  // âś… emulace kliknutĂ­ na konkrĂ©tnĂ­ + tlaÄŤĂ­tko:
  // vytĂˇhneme rotY/shift z moduleAddButtonOffsets pro base modul a danĂ˝ smÄ›r
  let rotY = 0;
  let shift = null;

  const baseRec = activeModules.find(r => r.mesh === baseMesh);
  if (baseRec) {
    const key = normalizeOffsetKey(baseRec.name);
    const defs = getModuleAddButtonOffsets()[key] || [];
    const def = defs.find(d => d.direction === side);

    debugLog("ADD ATTACHED DEBUG", {
      variantId,
      side,
      baseName: baseRec.name,
      key,
      availableDirections: defs.map(d => d.direction),
      foundDef: !!def
    });

    if (def) {
      rotY = def.rotY || 0;
      shift = def.shift ? def.shift.clone() : null;
    }
  }

  pendingAddRotY = rotY;
  pendingAddShift = shift;

  await chooseModule(variantId);

  return activeModules[activeModules.length - 1]?.mesh || null;
}

async function loadPresetIntoScene(presetKey) {

  loadingBegin(10, "Načítám sestavu…");

  await nextFrame();
  
  try {

  const preset = PRESETS[presetKey];
  if (!preset) {
    console.warn("Preset neexistuje:", presetKey);
    return;
  }

  clearSceneForPreset();

  // âś… aby prvnĂ­ modul mÄ›l stejnĂ˝ "hezkĂ˝" smÄ›r jako pĹ™i ruÄŤnĂ­m pĹ™idĂˇnĂ­
  cameraPinned = false;

  const created = []; // meshe v poĹ™adĂ­ krokĹŻ

  for (const step of preset.steps) {
    if (step.attachTo === null) {
      const mesh = await addVariantAsFirst(step.variantId);
      created.push(mesh);
    } else {
      const baseMesh = created[step.attachTo];
      const mesh = await addVariantAttached(step.variantId, baseMesh, step.side);
      created.push(mesh);
    }

    // âś… po kaĹľdĂ©m kroku:
    // - addModule() uĹľ volĂˇ recomputeCameraFit() (uvnitĹ™ addModule) :contentReference[oaicite:3]{index=3}
    // - my jen "dorovnĂˇme" kameru hned na goal, aby dalĹˇĂ­ krok poÄŤĂ­tal smÄ›r sprĂˇvnÄ›
    snapCameraToAutoGoal();
  }

  // po sestavenĂ­: layout + summary + finĂˇlnĂ­ fit (jistota)
  try { relayoutFromAnchor(); } catch (e) {}
  try { recomputeCameraFit(); } catch (e) {}
  try { snapCameraToAutoGoal(); } catch (e) {}
  try { scheduleSummaryRecalc(); } catch (e) {}

  } finally {
    loadingEnd();
  }

  window.__refreshSofaPlanEverywhere?.();
  scheduleCanonicalRebuildAnalysis();
}

// Event listeners (spuĹˇtÄ›nĂ­)
window.addEventListener("DOMContentLoaded", async () => {
  const sharedConfigurationState = await getSharedConfigurationStateFromUrl();
  const shouldRestoreActiveSession = !sharedConfigurationState && shouldRestoreActiveSessionOnBoot();
  if (sharedConfigurationState) {
    currentDraftId = null;
  } else if (shouldRestoreActiveSession) {
    currentDraftId = getPersistedCurrentDraftId();
  }

  // landing start custom
  const btnStartCustom = document.getElementById("btnStartCustom");
  if (btnStartCustom) btnStartCustom.addEventListener("click", () => startConfigurator("CUSTOM"));

  // landing presets
  document.querySelectorAll(".startPreset").forEach(btn => {
    btn.addEventListener("click", () => {
      startConfigurator(btn.dataset.model, btn.dataset.preset || null);
    });
  });

  // back to landing
  const btnBack = document.getElementById("btnBackToLanding");
  if (btnBack) btnBack.addEventListener("click", () => {
    showView("landing", { push: false });
    setStep(1, { push: false });
    appState.model = null;

    setUnlockedStep(1);

    pushRoute(false);
  });

  // step navigation
  const btnPrev = document.getElementById("btnPrevStep");
  const btnNext = document.getElementById("btnNextStep");

  const btnStep2Continue = document.getElementById("btnStep2Continue");
  if (btnStep2Continue) {
    btnStep2Continue.addEventListener("click", async () => {
      if (btnStep2Continue.disabled) return;

      await runCanonicalRebuildBeforeLeavingStep2(3);

      unlockStep(3);
      setStep(3, { push: false });
      pushRoute(false);
    });
  }

  const btnStep3Continue = document.getElementById("btnStep3Continue");
  if (btnStep3Continue) {
    btnStep3Continue.addEventListener("click", async () => {
      // kdyĹľ nejsou moduly, tlaÄŤĂ­tko je disabled â†’ nic
      if (btnStep3Continue.disabled) return;

      // blokace kvĹŻli pĹ™Ă­platkĹŻm (krok 3 / tab PĹ™Ă­platky)
      if (btnStep3Continue.dataset.blockedByExtras === "1") {
        const msg = "Nejdřív prosím vyberte příplatky u všech modulů.";
        if (typeof showPlacementMessage === "function") showPlacementMessage(msg, 4500);
        else alert(msg);
        return;
      }

      const legsOk = await confirmLegsBeforeLeavingStep3();
      if (!legsOk) return;

      unlockStep(4);
      setStep(4, { push: false });
      pushRoute(false);
    });
  }

  const btnStep4Continue = document.getElementById("btnStep4Continue");
  if (btnStep4Continue) {
    btnStep4Continue.textContent = "Pokračovat";

    btnStep4Continue.addEventListener("click", () => {
      const validation = getStep4MaterialValidation();

      if (!validation.ok) {
        const msg = validation.message || "Nejdřív prosím dokončete výběr materiálu.";
        if (typeof showPlacementMessage === "function") showPlacementMessage(msg, 4500);
        else alert(msg);
        updateStep4ContinueUI();
        return;
      }

      unlockStep(5);
      setStep(5, { push: false });
      pushRoute(false);
    });
  }

  document.getElementById("recapPrintBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("recapPrintBtn");
    const originalText = btn?.textContent || "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Vytvářím PDF...";
    }

    try {
      await downloadRecapPdfDocument();
    } catch (e) {
      console.error("Recap PDF download failed:", e);
      if (typeof showPlacementMessage === "function") {
        showPlacementMessage("PDF se nepodařilo vytvořit. Zkuste to prosím znovu.", 4500);
      } else {
        alert("PDF se nepodařilo vytvořit. Zkuste to prosím znovu.");
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText || "ULOŽIT / VYTISKNOUT PDF";
      }
    }
  });

  document.getElementById("recapDimsEditBtn")?.addEventListener("click", () => {
    if (recapDimsEditMode) {
      exitRecapDimsEditMode({ save: false });
    } else {
      enterRecapDimsEditMode();
    }
  });

  document.getElementById("recapDimensions")?.addEventListener("input", (e) => {
    const input = e.target.closest(".recapDimInput");
    if (!input) return;
    recapDimsEditDraft[input.dataset.dim || ""] = input.value;
  });

  document.getElementById("recapDimensions")?.addEventListener("keydown", (e) => {
    if (!e.target.closest(".recapDimInput")) return;

    if (e.key === "Enter") {
      e.preventDefault();
      exitRecapDimsEditMode({ save: true });
    }

    if (e.key === "Escape") {
      e.preventDefault();
      exitRecapDimsEditMode({ save: false });
    }
  });

  document.getElementById("recapDimensions")?.addEventListener("click", (e) => {
    if (e.target.closest("#recapDimsSaveBtn")) {
      exitRecapDimsEditMode({ save: true });
      return;
    }

    if (e.target.closest("#recapDimsCancelBtn")) {
      exitRecapDimsEditMode({ save: false });
    }
  });

  document.getElementById("recapEmailBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("recapEmailBtn");
    const originalText = btn?.textContent?.trim() || "";
    const customerEmail = await askForRecapCustomerEmail();

    if (!customerEmail) return;

    recapInquirySending = true;
    setButtonSendingState(btn, true, {
      busyLabel: "Odesílám poptávku",
      idleLabel: originalText || "ODESLAT POPTÁVKU",
    });

    try {
      await sendRecapInquiry(customerEmail);
      if (typeof showPlacementMessage === "function") {
        showPlacementMessage("Poptávku jsme přijali a odesíláme email. Děkujeme.", 4500);
      } else {
        alert("Poptávku jsme přijali a odesíláme email. Děkujeme.");
      }
    } catch (e) {
      console.error("Recap inquiry failed:", e);
      const message = e?.message || "Poptávku se nepodařilo odeslat. Zkuste to prosím znovu.";
      if (typeof showPlacementMessage === "function") showPlacementMessage(message, 6500);
      else alert(message);
    } finally {
      recapInquirySending = false;
      setButtonSendingState(btn, false, {
        idleLabel: originalText || "ODESLAT POPTÁVKU",
      });
    }
  });

  updateStep2ContinueUI();
  updateStep3ContinueUI();
  updateStep4ContinueUI();

  if (btnPrev) btnPrev.addEventListener("click", () => {
    const next = Math.max(1, appState.step - 1);
    setStep(next);
  });

  if (btnNext) btnNext.addEventListener("click", () => {
    const next = Math.min(appState.unlockedStep || 1, appState.step + 1);
    if (next === appState.step) {
      // zkusil jĂ­t dĂˇl neĹľ je odemÄŤeno â†’ hlĂˇĹˇka pod dalĹˇĂ­m krokem + pulse
      const target = appState.step + 1;
      const el = getStepEl("#stepBar", target);
      showHintUnderStep(el, requiredTextForStep(target));
      pulseStep(getStepEl("#stepBar", appState.unlockedStep || 1));
      return;
    }
    setStep(next);
  });

  document.querySelectorAll("#stepBar .step").forEach(el => {
    el.addEventListener("click", () => handleStepClick(Number(el.dataset.step), "#stepBar"));
  });

  document.querySelectorAll("#stepBarLanding .step").forEach(el => {
    el.addEventListener("click", () => handleStepClick(Number(el.dataset.step), "#stepBarLanding"));
  });

  // show landing as default on every fresh visit
  if (!shouldRestoreActiveSession) currentDraftId = null;
  applyState({ view: "landing", step: 1, model: null, unlockedStep: 1 });

  // prvnĂ­ zĂˇpis do historie (replace, aby to nebyl extra krok)
  pushRoute(true);

  // topbar: klik na logo / nadpis = zpÄ›t na krok 1 (vĂ˝bÄ›r pohovky)
  const goHome = () => {
    showView("landing", { push: false });
    setStep(1, { push: false });
    appState.model = null;

    setUnlockedStep(1);

    pushRoute(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  document.getElementById("btnTopLogo")?.addEventListener("click", goHome);
  document.getElementById("btnTopTitle")?.addEventListener("click", goHome);

  updateStepLocks();

  bindBottomToggle();
  bindBottomTabs();
  bindLegsEquipmentUI();
  bindShelfEquipmentUI();
  bindArmrestsEquipmentUI(getModelKey());
  bindHingesEquipmentUI();;
  updateBottomBarUI();
  updateBuildModeUI();
  bindDraftsProfileUI();

  if (sharedConfigurationState) {
    loadStateFromStorage(sharedConfigurationState).then((ok) => {
      if (ok) {
        clearSharedConfigurationParamFromUrl();
        updateStep2ContinueUI();
        updateStep3ContinueUI();
        updateStepLocks();

        if (isHeadrestStepActive() && currentEquipTabKey === "extras") {
          renderExtrasModuleList();
        }
      } else {
        isRestoringState = false;
      }
    });
  } else if (shouldRestoreActiveSession) {
    loadStateFromStorage().then((ok) => {
      if (ok) {
        updateStep2ContinueUI();
        updateStep3ContinueUI();
        updateStepLocks();

        if (isHeadrestStepActive() && currentEquipTabKey === "extras") {
          renderExtrasModuleList();
        }
      } else {
        isRestoringState = false;
      }
    });
  } else {
    isRestoringState = false;
  }
});

function applyState(state) {
  const view = state?.view || "landing";
  const step = Number(state?.step || 1);
  const model = state?.model || null;
  const unlockedFromUrl = Number(state?.unlockedStep || new URL(window.location.href).searchParams.get("unlocked") || 1);

  appState.model = model;

  // âś… kdyĹľ uĹľivatel vybral sedaÄŤku, zaÄŤni prefetch jen pro ni (ne pro vĹˇechny)
  if (model) {
    queuePrefetchForSofa(model);
  }

  // kdyĹľ mĂˇm model, minimĂˇlnÄ› krok 2 je odemÄŤenĂ˝
  appState.unlockedStep = Math.max(
    unlockedFromUrl || 1,
    model ? 2 : 1,
    step
  );

  updateStepLocks();

  showView(view, { push: false });
  setStep(Math.min(step, appState.unlockedStep), { push: false });
}

window.addEventListener("popstate", (e) => {
  applyState(e.state);
});

// =====================================================
//  FABRIC APPLY (KROK 4) â€“ aplikace textury na sedaÄŤku
// =====================================================

// MANILA_FABRIC_REPEAT_MULTIPLIER:
// Manila ma mensi UV mapy nez ostatni modely, proto se repeat latek na calouneni
// nasobi timto cislem. 1.5 znamena 150 %: repeat 2 -> 3, repeat 3 -> 4.5.
// Plati pouze pro hlavni fabric na pohovce, ne pro paspule, kov, drevo ani doplnky.
const MANILA_FABRIC_REPEAT_MULTIPLIER = 1.5;

function getSofaFabricRepeatForActiveModel(repeat) {
  const baseRepeat = Number.isFinite(Number(repeat)) ? Number(repeat) : 1;
  return getModelKey() === "MANILA"
    ? baseRepeat * MANILA_FABRIC_REPEAT_MULTIPLIER
    : baseRepeat;
}

async function applyFabricToSofaByMaterialMap({
  fabricKey = "",
  baseColorUrl,
  normalUrl,
  roughnessUrl,
  repeat = 2,
  normalScale = null,
}) {
  if (!scene) return;

  const fabricRepeat = getSofaFabricRepeatForActiveModel(repeat);

  const loadTex = (url, isColor) =>
    new Promise((resolve, reject) => {
      if (!url) return resolve(null);
      texLoader.load(
        url,
        (t) => resolve(setupTex(t, isColor, fabricRepeat)),
        undefined,
        (err) => reject({ url, err })
      );
    });

  let baseMap = null, normalMap = null, roughMap = null;

  try {
    [baseMap, normalMap, roughMap] = await Promise.all([
      loadTex(baseColorUrl, true),
      loadTex(normalUrl, false),
      loadTex(roughnessUrl, false),
    ]);
  } catch (e) {
    console.error("Texture load failed:", e);
    return;
  }

  scene.traverse((o) => {
    if (!o || !o.isMesh) return;

    // âś… nikdy nebarvi AddButton / StartButton a podobnĂ© UI vÄ›ci
    if (o.userData?.ignoreFabric) return;
    if (o.userData?.isStartButton) return;
    if (isNonUpholsteryHardPartMeshName(o.name)) return;

    // âś… mÄ›Ĺ jen ÄŤalounÄ›nĂ­
    // (kdyĹľ by nÄ›kde chybÄ›lo userData, tak to aspoĹ nepolĂˇmeĹˇ)
    if (o.userData?.materialRole && o.userData.materialRole !== "upholstery") return;

    const m = o.material;
    if (!m) return;

    const mats = Array.isArray(m) ? m : [m];

    mats.forEach((mat) => {
      if (!mat || !mat.isMeshStandardMaterial) return;

      // mapy
      if (baseMap) mat.map = baseMap;
      if (normalMap) mat.normalMap = normalMap;
      if (roughMap) mat.roughnessMap = roughMap;

      // âś… KdyĹľ pouĹľĂ­vĂˇĹˇ reĂˇlnĂ˝ BaseColor pro kaĹľdĂ˝ odstĂ­n, materiĂˇl musĂ­ bĂ˝t ÄŤistÄ› bĂ­lĂ˝
      mat.color.set(0xffffff);

      // âś… Realismus lĂˇtky
      mat.metalness = 0.0;

      // vĂ­c â€śmateriĂˇlâ€ť, mĂ­Ĺ â€śplochĂˇ kresbaâ€ť
      mat.roughness = fabricKey === "clara" ? 0.72 : 0.78;

      // normal nech trochu silnÄ›jĹˇĂ­, aĹĄ je lĂˇtka â€śĹľivĂˇâ€ť
      if (mat.normalMap) {
        const ns = Number.isFinite(normalScale)
          ? normalScale
          : (fabricKey === "clara" ? 0.22 : 0.18);
        mat.normalScale = new THREE.Vector2(ns, ns);
      }

      mat.needsUpdate = true;
    });
  });
}

async function applyFabricToPaspuleByMaterialMap({
  fabricKey = "",
  baseColorUrl,
  normalUrl,
  roughnessUrl,
  repeat = 2,
  normalScale = null,
}) {
  if (!scene) return;

  const loadTex = (url, isColor) =>
    new Promise((resolve, reject) => {
      if (!url) return resolve(null);
      texLoader.load(
        url,
        (t) => resolve(setupTex(t, isColor, repeat)),
        undefined,
        (err) => reject({ url, err })
      );
    });

  let baseMap = null, normalMap = null, roughMap = null;

  try {
    [baseMap, normalMap, roughMap] = await Promise.all([
      loadTex(baseColorUrl, true),
      loadTex(normalUrl, false),
      loadTex(roughnessUrl, false),
    ]);
  } catch (e) {
    console.error("Paspule texture load failed:", e);
    return;
  }

  for (const rec of activeModules || []) {
    const variantId = String(rec?.name || rec?.model || rec?.mesh?.userData?.variantId || "");
    if (!/^melbourne_/i.test(variantId)) continue;

    rec.mesh?.traverse((o) => {
      if (!o || !o.isMesh || !o.material) return;
      if (!String(o.name || "").toLowerCase().includes("paspule")) return;

      o.userData.materialRole = "paspule";

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((mat) => {
        if (!mat || !mat.isMeshStandardMaterial) return;

        if (baseMap) mat.map = baseMap;
        if (normalMap) mat.normalMap = normalMap;
        if (roughMap) mat.roughnessMap = roughMap;

        mat.color.set(0xffffff);
        mat.metalness = 0.0;
        mat.roughness = fabricKey === "clara" ? 0.72 : 0.78;

        if (mat.normalMap) {
          const ns = Number.isFinite(normalScale)
            ? normalScale
            : (fabricKey === "clara" ? 0.22 : 0.18);
          mat.normalScale = new THREE.Vector2(ns, ns);
        }

        mat.needsUpdate = true;
      });

      o.userData.originalMaterial = Array.isArray(o.material)
        ? o.material.map((m) => m?.clone?.() ?? m)
        : (o.material?.clone?.() ?? o.material);
    });
  }
}

function resetPaspuleMaterialToDefault() {
  for (const rec of activeModules || []) {
    const variantId = String(rec?.name || rec?.model || rec?.mesh?.userData?.variantId || "");
    if (!/^melbourne_/i.test(variantId)) continue;

    rec.mesh?.traverse((o) => {
      if (!o || !o.isMesh) return;
      if (!String(o.name || "").toLowerCase().includes("paspule")) return;

      o.material = MAT_PASPULE.clone();
      o.userData.originalMaterial = o.material.clone();
      o.userData.materialRole = "paspule";
      o.material.needsUpdate = true;
    });
  }
}

// -----------------------------------------------------
//  GLOBĂLNĂŤ PROMÄšNNĂ‰
// -----------------------------------------------------

let pendingAddPosition = null;
let hoveredButton = null;
let hoveredModule = null;
let selectedModule = null;
let pendingAddButton = null;
let pendingAddDirection = null;
let pickerClosedManually = false;
let isDragging = false;
let startButton = null;
let mouseDown = false;
let dragDistance = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let pendingAddRotY = 0;
let pendingAddShift = null;
let anchorMesh = null;
let pendingAddBaseModule = null;
let replaceTarget = null;
let downCandidate = null;
let controlsDragging = false;
let autoCamActive = false;
let autoCamBlocked = false;
let userViewDir = null; 
let controlsStartedThisClick = false;
let cameraMovedThisClick = false;
let pointerIsDown = false;
let selectedUpholstery = "g1";
let selectedLegs = "N7";
let hasUserTouchedLegs = false;
let legsUntouchedWarningShownForCurrentBuild = false;
let selectedShelfColor = "wood_buk_br_281";
let selectedArmrests = "smooth"; // "smooth" nebo "sharp"
let hingeEnvMap = null;
let selectedHinges = "standard";
let selectedArmrestSharpWidthCm = 15; // default

window.selectedArmrestSharpWidthCm =
  (window.selectedArmrestSharpWidthCm ?? selectedArmrestSharpWidthCm);

window.selectedArmrestWidthMode =
  (window.selectedArmrestWidthMode ?? "preset");

const AUTO_EPS_POS = 0.002;
const AUTO_EPS_TGT = 0.002;
// 1 jednotka v Three.js kolik je cm?
// NejÄŤastÄ›ji:
// - kdyĹľ je GLB v metrech: 100
// - kdyĹľ je GLB v centimetrech: 1
const SCENE_UNITS_TO_CM = 100;

debugLog(pendingAddDirection);

const activeModules = [];   // vĹˇechny moduly ve scĂ©nÄ›
const activeButtons = [];   // vĹˇechna tlaÄŤĂ­tka ve scĂ©nÄ›


// ===============================
// HINGE MATERIALS
// ===============================

const HINGE_MATERIALS = {
  standard: new THREE.MeshStandardMaterial({
    color: "#dddddd",
    metalness: 1,
    roughness: 0.15,
  }),

  softclose: new THREE.MeshStandardMaterial({
    color: "#111111",
    metalness: 1,
    roughness: 0.35,
  }),
};

// =====================================================
//  PERSISTENCE (uloĹľit stav scĂ©ny pĹ™es reload)
// =====================================================
const STORAGE_KEY = "manila_config_state_v1";
const DRAFTS_STORAGE_KEY = "madros_config_drafts_v1";
const DRAFTS_MIGRATION_KEY = "madros_config_drafts_migrated_v1";
const ACTIVE_SESSION_KEY = "madros_config_active_session_v1";
const LAST_ACTIVE_AT_KEY = "madros_config_last_active_at_v1";
const CURRENT_DRAFT_ID_KEY = "madros_config_current_draft_id_v1";
const SHARE_STATE_PARAM = "config";
const SHARE_TOKEN_PARAM = "share";
const ACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SAVED_DRAFTS = 10;

let currentDraftId = null;
let _draftsProfileBound = false;
let _draftsRenderTimer = null;
let _draftPreviewTimer = null;
let _draftPreviewSeq = 0;

function createDraftId() {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function rememberActiveSession() {
  const now = String(Date.now());
  try { sessionStorage.setItem(ACTIVE_SESSION_KEY, "1"); } catch (e) {}
  try { localStorage.setItem(LAST_ACTIVE_AT_KEY, now); } catch (e) {}

  if (currentDraftId) {
    try { sessionStorage.setItem(CURRENT_DRAFT_ID_KEY, currentDraftId); } catch (e) {}
    try { localStorage.setItem(CURRENT_DRAFT_ID_KEY, currentDraftId); } catch (e) {}
  } else {
    try { sessionStorage.removeItem(CURRENT_DRAFT_ID_KEY); } catch (e) {}
    try { localStorage.removeItem(CURRENT_DRAFT_ID_KEY); } catch (e) {}
  }
}

function getPersistedCurrentDraftId() {
  try {
    const fromSession = sessionStorage.getItem(CURRENT_DRAFT_ID_KEY);
    if (fromSession) return fromSession;
  } catch (e) {}

  try {
    return localStorage.getItem(CURRENT_DRAFT_ID_KEY) || null;
  } catch (e) {
    return null;
  }
}

function shouldRestoreActiveSessionOnBoot() {
  let hasSameTabSession = false;
  try {
    hasSameTabSession = sessionStorage.getItem(ACTIVE_SESSION_KEY) === "1";
  } catch (e) {}

  if (hasSameTabSession) return true;

  const navEntry = performance?.getEntriesByType?.("navigation")?.[0];
  const navType = navEntry?.type || "";
  const isReloadLikeNavigation = navType === "reload" || navType === "back_forward";

  let lastActiveAt = 0;
  try {
    lastActiveAt = Number(localStorage.getItem(LAST_ACTIVE_AT_KEY) || 0);
  } catch (e) {}

  if (!lastActiveAt) return false;
  return isReloadLikeNavigation && Date.now() - lastActiveAt <= ACTIVE_SESSION_TTL_MS;
}

function readDraftsFromStorage() {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((draft) => draft && draft.id && draft.state)
      : [];
  } catch (e) {
    console.warn("readDraftsFromStorage failed:", e);
    return [];
  }
}

function writeDraftsToStorage(drafts) {
  const normalized = (Array.isArray(drafts) ? drafts : [])
    .filter((draft) => draft && draft.id && draft.state)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, MAX_SAVED_DRAFTS);

  const tryWrite = (items) => {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(items));
  };

  try {
    tryWrite(normalized);
  } catch (e) {
    try {
      tryWrite(normalized.map((draft, index) => (
        index === 0 ? draft : { ...draft, image: "" }
      )));
    } catch (e2) {
      try {
        tryWrite(normalized.map((draft) => ({ ...draft, image: "" })));
      } catch (e3) {
        console.warn("writeDraftsToStorage failed:", e3);
      }
    }
  }
}

function cloneSavedState(state) {
  try {
    return JSON.parse(JSON.stringify(state));
  } catch (e) {
    return null;
  }
}

function encodeShareStateText(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeShareStateText(value) {
  let base64 = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (base64.length % 4) base64 += "=";

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
}

function encodeSharedConfigurationState(state) {
  return encodeShareStateText(JSON.stringify({
    v: 1,
    state,
  }));
}

function decodeSharedConfigurationState(value) {
  const parsed = JSON.parse(decodeShareStateText(value));
  return parsed?.state || parsed;
}

function getShareConfigEndpoints(token = "") {
  const suffix = token ? `/${encodeURIComponent(token)}` : "";

  if (window.RECAP_SHARE_ENDPOINT) {
    return [`${String(window.RECAP_SHARE_ENDPOINT).replace(/\/+$/g, "")}${suffix}`];
  }

  return [
    apiUrl(`/api/share-config${suffix}`),
  ];
}

async function fetchShareJson(endpoint, options = {}) {
  const controller = new AbortController();
  const { timeoutMs = 4500, ...fetchOptions } = options;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      ...fetchOptions,
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `Server vrátil chybu ${response.status}.`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function prepareSharedConfigurationStateForRestore(state) {
  const prepared = cloneSavedState(state);
  if (!prepared || prepared.version !== 1) return null;

  const model =
    getDraftModelFromPayload(prepared) ||
    String(prepared.route?.model || "").toUpperCase() ||
    "MANILA";

  prepared.route = {
    ...(prepared.route || {}),
    view: "configurator",
    model,
    step: 5,
    unlockedStep: Math.max(5, Number(prepared.route?.unlockedStep || 1)),
  };

  return prepared;
}

async function getSharedConfigurationStateFromUrl() {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(SHARE_TOKEN_PARAM);

    if (token) {
      for (const endpoint of getShareConfigEndpoints(token)) {
        try {
          const result = await fetchShareJson(endpoint, { timeoutMs: 6000 });
          const state = prepareSharedConfigurationStateForRestore(result?.state);
          if (state) return state;
        } catch (error) {
          console.warn("Shared configuration token fetch failed:", error);
        }
      }
    }

    const encoded = url.searchParams.get(SHARE_STATE_PARAM);
    if (!encoded) return null;
    return prepareSharedConfigurationStateForRestore(decodeSharedConfigurationState(encoded));
  } catch (e) {
    console.warn("Shared configuration restore failed:", e);
    return null;
  }
}

function getShareUrlBase() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  return url.href;
}

function getCurrentSharedConfigurationState() {
  try {
    saveStateNow();

    const raw = localStorage.getItem(STORAGE_KEY);
    const state = raw ? cloneSavedState(JSON.parse(raw)) : null;
    if (!state || state.version !== 1) return null;
    if (!Array.isArray(state.modules) || state.modules.length === 0) return null;

    const model =
      getDraftModelFromPayload(state) ||
      String(state.route?.model || appState.model || "").toUpperCase() ||
      "MANILA";

    state.ts = Date.now();
    state.route = {
      ...(state.route || {}),
      view: "configurator",
      model,
      step: 5,
      unlockedStep: Math.max(5, Number(state.route?.unlockedStep || appState.unlockedStep || 1)),
    };

    return state;
  } catch (e) {
    console.warn("Shared configuration snapshot failed:", e);
    return null;
  }
}

async function createShortConfigurationShareUrl(state) {
  if (!state) return "";

  for (const endpoint of getShareConfigEndpoints()) {
    try {
      const result = await fetchShareJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state,
          urlBase: getShareUrlBase(),
        }),
      });

      if (result?.url) return result.url;
    } catch (error) {
      console.warn("Short share URL create failed:", error);
    }
  }

  return "";
}

async function getCurrentConfigurationShareUrl(state = getCurrentSharedConfigurationState()) {
  if (!state) return window.location.href;

  const shortUrl = await createShortConfigurationShareUrl(state);
  if (shortUrl) return shortUrl;

  const url = new URL(getShareUrlBase());
  url.searchParams.set("view", "configurator");
  url.searchParams.set("step", "5");
  url.searchParams.set("unlocked", String(Math.max(5, Number(state.route?.unlockedStep || 5))));
  if (state.route?.model) url.searchParams.set("model", state.route.model);

  return url.href;
}

function clearSharedConfigurationParamFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SHARE_STATE_PARAM) && !url.searchParams.has(SHARE_TOKEN_PARAM)) return;

    url.searchParams.delete(SHARE_STATE_PARAM);
    url.searchParams.delete(SHARE_TOKEN_PARAM);
    url.searchParams.set("view", "configurator");
    url.searchParams.set("step", "5");
    url.searchParams.set("unlocked", String(Math.max(5, Number(appState.unlockedStep || 5))));
    if (appState.model) url.searchParams.set("model", appState.model);

    history.replaceState({
      view: "configurator",
      step: 5,
      model: appState.model,
      unlockedStep: Math.max(5, Number(appState.unlockedStep || 5)),
    }, "", url);
  } catch (e) {
    console.warn("Shared configuration URL cleanup failed:", e);
  }
}

function isDraftSaveMeaningfulPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (Array.isArray(payload.modules) && payload.modules.length > 0) return true;
  return false;
}

function isDraftSaveEligiblePayload(payload) {
  if (!isDraftSaveMeaningfulPayload(payload)) return false;

  // Drafts in the profile should appear only after the customer really leaves
  // assembly step 2. The plain STORAGE_KEY still saves earlier states for reload.
  return Number(payload?.route?.step || 1) >= 3;
}

function getDraftModelFromPayload(payload) {
  const fromRoute = String(payload?.route?.model || "").trim();
  if (fromRoute && fromRoute.toUpperCase() !== "CUSTOM") return fromRoute.toUpperCase();

  const firstVariant = String(payload?.modules?.[0]?.variantId || "").trim();
  if (firstVariant.includes("_")) return firstVariant.split("_")[0].toUpperCase();

  return fromRoute ? fromRoute.toUpperCase() : "";
}

function getDraftSofaTitle(payload) {
  const model = getDraftModelFromPayload(payload);
  if (!model || model === "CUSTOM") return "Vlastní sedací souprava";

  const key = model.charAt(0).toUpperCase() + model.slice(1).toLowerCase();
  const title = SOFA_SUMMARY_META[key]?.title || key;
  return `Sedací souprava ${title}`;
}

function getStoredPayloadTotalPrice(payload) {
  const group = payload?.selections?.appliedFabricPriceGroup || "g1";
  const modelKey = getDraftModelFromPayload(payload);
  const armrestType = payload?.selections?.armrests || "";
  let total = 0;

  for (const module of payload?.modules || []) {
    const upgradeChoice = module?.upgradeChoice;
    const upgrade = (upgradeChoice === "bed" || upgradeChoice === "bed2" || upgradeChoice === "storage")
      ? upgradeChoice
      : (module?.upgrade || null);
    const effectiveUpgrade = getManchesterArmrestPriceKey(module.variantId, group, upgrade, {
      armrestType,
      modelKey,
    });

    try {
      total += getModulePrice(module.variantId, group, effectiveUpgrade);
    } catch (e) {}
  }

  return total;
}

function getDraftPriceNumber(payload, preferLive = false) {
  if (preferLive) {
    try {
      return getDiscountedAmount(getConfiguredTotalPrice()).final;
    } catch (e) {}
  }

  return getDiscountedAmount(getStoredPayloadTotalPrice(payload)).final;
}

function getDraftFabricPreviewPart(fabric) {
  if (!fabric || typeof fabric !== "object") return null;

  return {
    fabricKey: fabric.fabricKey || "",
    fabricName: fabric.fabricName || "",
    shade: fabric.shade || "",
    baseColorUrl: fabric.baseColorUrl || "",
    normalUrl: fabric.normalUrl || "",
    roughnessUrl: fabric.roughnessUrl || "",
  };
}

function getDraftPreviewSignature(payload) {
  try {
    return JSON.stringify({
      model: payload?.route?.model || "",
      modules: (payload?.modules || []).map((module) => ({
        variantId: module.variantId,
        upgrade: module.upgrade || null,
        upgradeChoice: module.upgradeChoice || null,
        pos: module.pos,
        quat: module.quat,
      })),
      fabricGroup: payload?.selections?.appliedFabricPriceGroup || "",
      fabrics: {
        cat1: getDraftFabricPreviewPart(payload?.selections?.fabricCat1),
        cat2: getDraftFabricPreviewPart(payload?.selections?.fabricCat2),
        cat3: getDraftFabricPreviewPart(payload?.selections?.fabricCat3),
        leather: getDraftFabricPreviewPart(payload?.selections?.fabricLeather),
        paspule: getDraftFabricPreviewPart(payload?.selections?.fabricPaspule),
      },
      legs: payload?.selections?.legs || "",
      armrests: payload?.selections?.armrests || "",
    });
  } catch (e) {
    return String(payload?.ts || Date.now());
  }
}

function resetAllModuleHoverForCapture() {
  try { clearHoverEffects?.(); } catch (e) {}

  for (const rec of activeModules || []) {
    try { resetModuleHover(rec?.mesh); } catch (e) {}
  }
}

async function captureDraftPreviewImage() {
  try {
    if (!activeModules?.length) return "";
    resetAllModuleHoverForCapture();
    await applyCurrentMaterialsBeforeRecapCapture();
    await waitRecapFrame();
    await waitRecapFrame();
    resetAllModuleHoverForCapture();
    return captureRecapSofaImage({
      captureSize: { width: 720, height: 420, aspect: 720 / 420 },
      mimeType: "image/jpeg",
      quality: 0.84,
    }) || "";
  } catch (e) {
    console.warn("captureDraftPreviewImage failed:", e);
    return "";
  }
}

function scheduleDraftPreviewCapture(draftId, payload, previewSignature) {
  if (!draftId || !payload || !activeModules?.length) return;

  const seq = ++_draftPreviewSeq;
  clearTimeout(_draftPreviewTimer);

  _draftPreviewTimer = setTimeout(async () => {
    try {
      if (seq !== _draftPreviewSeq) return;
      if (isRestoringState) return;
      if (currentDraftId !== draftId) return;

      const image = await captureDraftPreviewImage();
      if (!image) return;

      const drafts = readDraftsFromStorage();
      const draft = drafts.find((item) => item.id === draftId);
      if (!draft) return;
      if (draft.previewSignature && draft.previewSignature !== previewSignature) return;

      draft.image = image;
      draft.previewTs = Date.now();
      draft.previewSignature = previewSignature;
      writeDraftsToStorage(drafts);
      scheduleDraftsProfileRender();
    } catch (e) {
      console.warn("scheduleDraftPreviewCapture failed:", e);
    }
  }, 80);
}

function scheduleDraftsProfileRender() {
  clearTimeout(_draftsRenderTimer);
  _draftsRenderTimer = setTimeout(renderDraftsProfileUI, 80);
}

function upsertCurrentDraftFromPayload(payload) {
  if (!isDraftSaveEligiblePayload(payload)) return;

  if (!currentDraftId) currentDraftId = createDraftId();

  const drafts = readDraftsFromStorage();
  const index = drafts.findIndex((draft) => draft.id === currentDraftId);
  const existing = index >= 0 ? drafts[index] : null;
  const now = Number(payload.ts || Date.now());
  const previewSignature = getDraftPreviewSignature(payload);
  let image = existing?.image || "";
  let previewTs = Number(existing?.previewTs || 0);

  const shouldCapturePreview =
    activeModules?.length > 0 &&
    (!image || existing?.previewSignature !== previewSignature || now - previewTs > 12000);

  const priceNumber = getDraftPriceNumber(payload, true);
  const model = getDraftModelFromPayload(payload);
  const draft = {
    ...(existing || {}),
    id: currentDraftId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    title: getDraftSofaTitle(payload),
    model,
    step: Number(payload.route?.step || 1),
    moduleCount: Array.isArray(payload.modules) ? payload.modules.length : 0,
    price: priceNumber,
    priceText: formatCzk(priceNumber),
    image,
    previewTs,
    previewSignature: image || shouldCapturePreview ? previewSignature : existing?.previewSignature || "",
    state: payload,
  };

  if (index >= 0) drafts.splice(index, 1, draft);
  else drafts.unshift(draft);

  writeDraftsToStorage(drafts);
  scheduleDraftsProfileRender();

  if (shouldCapturePreview) {
    scheduleDraftPreviewCapture(currentDraftId, payload, previewSignature);
  }
}

function getDraftFallbackImage(draft) {
  const firstVariant = draft?.state?.modules?.[0]?.variantId;
  if (!firstVariant) return "";

  try {
    return getThumbUrlForVariant(firstVariant);
  } catch (e) {
    return "";
  }
}

function formatDraftUpdatedAt(ts) {
  const date = new Date(Number(ts || Date.now()));
  try {
    return date.toLocaleString("cs-CZ", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}

function renderDraftsProfileUI() {
  const drafts = readDraftsFromStorage()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

  const countEl = document.getElementById("draftsButtonCount");
  if (countEl) countEl.textContent = `(${drafts.length})`;

  const list = document.getElementById("draftsList");
  const empty = document.getElementById("draftsEmpty");
  if (!list || !empty) return;

  empty.classList.toggle("hidden", drafts.length > 0);
  list.innerHTML = drafts.map((draft) => {
    const image = draft.image || getDraftFallbackImage(draft);
    const imageHtml = image
      ? `<img src="${escapeHtmlText(image)}" alt="">`
      : `<div class="draftThumbPlaceholder">Náhled</div>`;

    const moduleCount = Number(draft.moduleCount || draft.state?.modules?.length || 0);
    const metaParts = [
      moduleCount ? `${moduleCount} modulů` : "",
      `Uloženo ${formatDraftUpdatedAt(draft.updatedAt)}`,
    ].filter(Boolean);

    return `
      <article class="draftItem" data-draft-id="${escapeHtmlText(draft.id)}" tabindex="0">
        <div class="draftThumb">${imageHtml}</div>
        <div class="draftBody">
          <div class="draftName">${escapeHtmlText(draft.title || "Rozestavěná sestava")}</div>
          <div class="draftPrice">Celkem ${escapeHtmlText(draft.priceText || formatCzk(draft.price || 0))} včetně DPH</div>
          <div class="draftMeta">${escapeHtmlText(metaParts.join(" · "))}</div>
        </div>
        <button class="draftDelete" type="button" data-draft-delete="${escapeHtmlText(draft.id)}" aria-label="Smazat sestavu">×</button>
      </article>
    `;
  }).join("");
}

function openDraftsPopover() {
  renderDraftsProfileUI();
  const popover = document.getElementById("draftsPopover");
  const button = document.getElementById("draftsButton");
  if (!popover || !button) return;

  popover.classList.remove("hidden");
  popover.setAttribute("aria-hidden", "false");
  button.setAttribute("aria-expanded", "true");
}

function closeDraftsPopover() {
  const popover = document.getElementById("draftsPopover");
  const button = document.getElementById("draftsButton");
  if (!popover || !button) return;

  popover.classList.add("hidden");
  popover.setAttribute("aria-hidden", "true");
  button.setAttribute("aria-expanded", "false");
}

function deleteDraftById(id) {
  const drafts = readDraftsFromStorage().filter((draft) => draft.id !== id);
  if (currentDraftId === id) currentDraftId = null;
  writeDraftsToStorage(drafts);
  renderDraftsProfileUI();
}

function prepareDraftStateForRestore(state, draft) {
  if (!state || typeof state !== "object") return state;

  const hasConfiguration =
    (Array.isArray(state.modules) && state.modules.length > 0) ||
    Boolean(state.route?.model || draft?.model);

  if (!hasConfiguration) return state;

  const model =
    getDraftModelFromPayload(state) ||
    String(draft?.model || "").toUpperCase() ||
    "MANILA";

  const savedStep = Number(state.route?.step || draft?.step || 2);
  const nextStep = Math.max(2, savedStep);

  state.route = {
    ...(state.route || {}),
    view: "configurator",
    model,
    step: nextStep,
    unlockedStep: Math.max(2, Number(state.route?.unlockedStep || 1), nextStep),
  };

  return state;
}

async function loadDraftById(id) {
  const draft = readDraftsFromStorage().find((item) => item.id === id);
  if (!draft?.state) return;

  const state = prepareDraftStateForRestore(cloneSavedState(draft.state), draft);
  if (!state) return;

  currentDraftId = draft.id;
  rememberActiveSession();
  closeDraftsPopover();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}

  const ok = await loadStateFromStorage(state);
  if (ok) {
    try { showPlacementMessage?.("Rozestavěná sestava byla načtena.", 2200); } catch (e) {}
  }
}

function bindDraftsProfileUI() {
  if (_draftsProfileBound) return;
  _draftsProfileBound = true;

  const button = document.getElementById("draftsButton");
  const close = document.getElementById("draftsClose");
  const popover = document.getElementById("draftsPopover");
  const list = document.getElementById("draftsList");

  button?.addEventListener("click", () => {
    const isOpen = !popover?.classList.contains("hidden");
    if (isOpen) closeDraftsPopover();
    else openDraftsPopover();
  });

  close?.addEventListener("click", closeDraftsPopover);

  popover?.addEventListener("click", (e) => {
    if (e.target === popover) closeDraftsPopover();
  });

  list?.addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-draft-delete]");
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteDraftById(deleteBtn.dataset.draftDelete);
      return;
    }

    const item = e.target.closest("[data-draft-id]");
    if (item) loadDraftById(item.dataset.draftId);
  });

  list?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const item = e.target.closest("[data-draft-id]");
    if (!item) return;
    e.preventDefault();
    loadDraftById(item.dataset.draftId);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDraftsPopover();
  });

  migrateLegacySavedStateToDrafts();
  renderDraftsProfileUI();
}

function migrateLegacySavedStateToDrafts() {
  try {
    if (localStorage.getItem(DRAFTS_MIGRATION_KEY) === "1") return;

    const raw = localStorage.getItem(STORAGE_KEY);
    const state = raw ? JSON.parse(raw) : null;
    localStorage.setItem(DRAFTS_MIGRATION_KEY, "1");

    if (!isDraftSaveEligiblePayload(state)) return;

    const drafts = readDraftsFromStorage();
    const legacyTs = Number(state.ts || Date.now());
    if (drafts.some((draft) => Number(draft.legacyTs || 0) === legacyTs)) return;

    const price = getStoredPayloadTotalPrice(state);
    const discounted = getDiscountedAmount(price).final;
    const legacyId = `legacy_${legacyTs}`;
    if (!currentDraftId) currentDraftId = legacyId;

    drafts.unshift({
      id: legacyId,
      legacyTs,
      createdAt: legacyTs,
      updatedAt: legacyTs,
      title: getDraftSofaTitle(state),
      model: getDraftModelFromPayload(state),
      step: Number(state.route?.step || 1),
      moduleCount: Array.isArray(state.modules) ? state.modules.length : 0,
      price: discounted,
      priceText: formatCzk(discounted),
      image: "",
      previewTs: 0,
      previewSignature: "",
      state,
    });

    writeDraftsToStorage(drafts);
  } catch (e) {
    console.warn("migrateLegacySavedStateToDrafts failed:", e);
  }
}

let isRestoringState = true; // blokuj autosave pĹ™i startu strĂˇnky (boot)

let _saveTimer = null;
function saveStateDebounced(ms = 250) {
  if (isRestoringState) return; // âś… bÄ›hem restore nic neuklĂˇdat
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStateNow, ms);
}

function saveStateNow() {
  if (isRestoringState) return; // âś… bÄ›hem restore nic neuklĂˇdat

  try {
    if (!camera || !controls) return;

    try { purgeModuleRecords(); } catch (e) {}

    // route / app
    const route = {
      view: document.getElementById("viewConfigurator")?.classList.contains("activeView")
        ? "configurator"
        : "landing",
      step: appState.step,
      model: appState.model,
      unlockedStep: appState.unlockedStep,
      fabricTab: currentFabricTabKey,
    };

    // selections (co umĂ­me z tohohle souboru)
    const selections = {
      legs: selectedLegs,
      legsColor: document.getElementById("legsColorSelect")?.value || null,
      legsAcknowledged: Boolean(hasUserTouchedLegs),
      shelfColor: document.getElementById("shelfColorSelect")?.value || selectedShelfColor || null,
      upholstery: selectedUpholstery,
      armrests: selectedArmrests,
      hinges: selectedHinges,
      fabricTab: currentFabricTabKey,
      activeFabricFamilyByTab: { ...activeFabricFamilyByTab },
      fabricCat1: getSelectedFabricStatePayload(selectedFabricCat1),
      fabricCat2: getSelectedFabricStatePayload(selectedFabricCat2),
      fabricCat3: getSelectedFabricStatePayload(selectedFabricCat3),
      fabricLeather: getSelectedFabricStatePayload(selectedFabricLeather),
      fabricPaspule: getSelectedFabricStatePayload(selectedPaspuleFabric),

      appliedFabricPriceGroup,

      armrestSharpWidthCm: (window.selectedArmrestSharpWidthCm ?? selectedArmrestSharpWidthCm ?? null),
      armrestWidthMode: window.selectedArmrestWidthMode ?? "preset",
    };

    // camera
    const cam = {
      pos: camera.position.toArray(),
      target: controls.target.toArray(),
    };

    // modules + connections (uloĹľĂ­me indexy sousedĹŻ)
    const meshToIndex = new Map();
    activeModules.forEach((r, i) => meshToIndex.set(r.mesh, i));

    const modules = activeModules.map((r) => {
      const m = r.mesh;
      return {
        variantId: r.name,     // napĹ™. Manila_2P
        model: r.model,        // napĹ™. Manila_2M (GLB)
        upgrade: r.upgrade || null,
        upgradeChoice: extrasChoiceByModuleUuid.get(r.mesh.uuid) || "unset",
        pos: m.position.toArray(),
        quat: m.quaternion.toArray(),
        scale: m.scale.toArray(),
        connections: {
          left:  r.connections.left  ? (meshToIndex.get(r.connections.left)  ?? null) : null,
          right: r.connections.right ? (meshToIndex.get(r.connections.right) ?? null) : null,
          front: r.connections.front ? (meshToIndex.get(r.connections.front) ?? null) : null,
          back:  r.connections.back  ? (meshToIndex.get(r.connections.back)  ?? null) : null,
        },
      };
    });

    const payload = {
      version: 1,
      ts: Date.now(),
      route,
      selections,
      camera: cam,
      modules,
      sofaDims: { ...(window.__sofaDims || {}) },
      sofaDimsLayoutKey: window.__sofaDimsLayoutKey || null,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    upsertCurrentDraftFromPayload(payload);
    rememberActiveSession();
  } catch (e) {
    console.warn("saveStateNow failed:", e);
  }
}

// âś… pojistka: pĹ™i reloadu / zavĹ™enĂ­ tabu uloĹľ hned (bez debounce)
window.addEventListener("beforeunload", () => {
  saveStateNow();
  rememberActiveSession();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    saveStateNow();
    rememberActiveSession();
  }
});

async function loadStateFromStorage(sourceState = null) {
  isRestoringState = true; // âś… START restore (blokuje autosave)
  
  let restoredOk = false;

  try {
    let data = null;
    if (sourceState) {
      data = sourceState;
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      try {
        data = JSON.parse(raw);
      } catch (e) {
        return false;
      }
    }

    if (!data || data.version !== 1) return false;

    // 0) restore rozmÄ›rĹŻ pohovky
    let restoredSofaDims = null;
    let restoredSofaDimsLayoutKey = null;

    if (data.sofaDims && typeof data.sofaDims === "object") {
      restoredSofaDims = { ...data.sofaDims };
      window.__sofaDims = { ...restoredSofaDims };
    }

    if (data.sofaDimsLayoutKey) {
      restoredSofaDimsLayoutKey = data.sofaDimsLayoutKey;
      window.__sofaDimsLayoutKey = data.sofaDimsLayoutKey;
    }

    // 1) restore app/route
    if (data.route) {
      appState.step = Number(data.route.step || 1);
      appState.model = data.route.model || null;
      appState.unlockedStep = Number(data.route.unlockedStep || 1);
      if (data.route.fabricTab) currentFabricTabKey = data.route.fabricTab;

      refreshEquipmentUiForCurrentModel();
      updateStepLocks();
      showView(data.route.view || "landing", { push: false });
      setStep(Math.min(appState.step, appState.unlockedStep), { push: false });
      pushRoute(false);
    }

    // 2) restore selections
    if (data.selections) {
      if (data.selections.legs) selectedLegs = data.selections.legs;
      hasUserTouchedLegs = Boolean(data.selections.legsAcknowledged);
      if (data.selections.shelfColor) selectedShelfColor = data.selections.shelfColor;
      if (data.selections.upholstery) selectedUpholstery = data.selections.upholstery;
      if (data.selections.armrests) selectedArmrests = data.selections.armrests;
      if (data.selections.fabricTab) currentFabricTabKey = data.selections.fabricTab;

      if (
        data.selections.activeFabricFamilyByTab &&
        typeof data.selections.activeFabricFamilyByTab === "object"
      ) {
        activeFabricFamilyByTab = {
          ...activeFabricFamilyByTab,
          ...data.selections.activeFabricFamilyByTab,
        };
      }

      appliedFabricPriceGroup = data.selections.appliedFabricPriceGroup || appliedFabricPriceGroup || "g1";

      if (data.selections.fabricCat1) selectedFabricCat1 = { ...data.selections.fabricCat1 };
      if (data.selections.fabricCat2) selectedFabricCat2 = { ...data.selections.fabricCat2 };
      if (data.selections.fabricCat3) selectedFabricCat3 = { ...data.selections.fabricCat3 };
      if (data.selections.fabricLeather) selectedFabricLeather = { ...data.selections.fabricLeather };
      if (data.selections.fabricPaspule) selectedPaspuleFabric = { ...data.selections.fabricPaspule };

      // âś… DĹ®LEĹ˝ITĂ‰: obnov i panty do logickĂ©ho stavu
      if (data.selections.hinges) selectedHinges = data.selections.hinges;

      // âś… Obnov UI + 3D aĹľ po initu UI (2 raf = jistota)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {

          // nohy + barva
          if (window.__setLegsFromState) {
            window.__setLegsFromState(
              data.selections.legs || selectedLegs,
              data.selections.legsColor || null
            );
          }

          // polička Melbourne
          if (window.__setShelfColorFromState) {
            window.__setShelfColorFromState(
              data.selections.shelfColor || selectedShelfColor || "wood_buk_br_281"
            );
          } else {
            applyShelfColorToMelbournePlanes(
              data.selections.shelfColor || selectedShelfColor || "wood_buk_br_281"
            );
          }

          // podruÄŤky
          if (window.__setArmrestsFromState) {
            window.__setArmrestsFromState(data.selections.armrests || selectedArmrests);
          }

          // ĹˇĂ­Ĺ™ka podruÄŤky (chips/custom)
          if (window.__setArmrestWidthFromState) {
            window.__setArmrestWidthFromState(
              data.selections.armrestSharpWidthCm ?? selectedArmrestSharpWidthCm,
              data.selections.armrestWidthMode ?? window.selectedArmrestWidthMode
            );
          }

          // panty
          if (window.__setHingesFromState) {
            window.__setHingesFromState(data.selections.hinges || selectedHinges);
          }

        });
      });
    }

    // 3) restore scene (moduly)
    if (Array.isArray(data.modules)) {
      clearSceneForPreset();

      for (const m of data.modules) {
        const pos = new THREE.Vector3().fromArray(m.pos);
        const mesh = await addModule(m.model, pos, m.variantId);

        if (mesh) {
          if (m.quat) mesh.quaternion.fromArray(m.quat);
          if (m.scale) mesh.scale.fromArray(m.scale);
          mesh.updateMatrixWorld(true);

          // âś… obnovĂ­me upgrade do recordu + do mapy pro UI pĹ™Ă­platkĹŻ
          const rec = activeModules.find(r => r.mesh === mesh);
          if (rec) {
            rec.upgrade = m.upgrade || null;
            // âś… 1) vezmi explicitnĂ­ volbu, pokud existuje (novĂ˝ formĂˇt)
            // âś… 2) fallback pro starĂ˝ formĂˇt: kdyĹľ byl upgrade, tak "bed"/"storage", jinak "unset"
            const restoredChoice =
              (m.upgradeChoice != null)
                ? m.upgradeChoice
                : (rec.upgrade ? rec.upgrade : "unset");

            extrasChoiceByModuleUuid.set(mesh.uuid, restoredChoice);

            // rec.upgrade musĂ­ sedÄ›t s volbou (kvĹŻli cenĂˇm)
            // - "none" i "unset" => null
            // - "bed"/"storage" => klĂ­ÄŤ
            rec.upgrade = (restoredChoice === "bed" || restoredChoice === "storage")
              ? restoredChoice
              : null;
          }
        }
      }

      const meshes = activeModules.map(r => r.mesh);

      data.modules.forEach((m, i) => {
        const rec = activeModules[i];
        if (!rec || !m.connections) return;
        for (const side of ["left", "right", "front", "back"]) {
          const idx = m.connections[side];
          rec.connections[side] = Number.isInteger(idx) ? (meshes[idx] || null) : null;
        }
      });

      await rebuildAllAddButtons();
      scheduleSummaryRecalc();

      // âś… FIX: po znovu-nahrĂˇnĂ­ modulĹŻ jeĹˇtÄ› jednou aplikuj nohy + barvu
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (window.__setLegsFromState) {
            window.__setLegsFromState(
              data.selections?.legs || selectedLegs,
              data.selections?.legsColor || null
            );
          }

          const shelfColorId =
            data.selections?.shelfColor || selectedShelfColor || "wood_buk_br_281";
          if (window.__setShelfColorFromState) {
            window.__setShelfColorFromState(shelfColorId);
          } else {
            applyShelfColorToMelbournePlanes(shelfColorId);
          }

          if (window.__setArmrestsFromState) {
            window.__setArmrestsFromState(data.selections?.armrests || selectedArmrests);
          }

          if (window.__setArmrestWidthFromState) {
            window.__setArmrestWidthFromState(
              data.selections?.armrestSharpWidthCm ?? selectedArmrestSharpWidthCm,
              data.selections?.armrestWidthMode ?? window.selectedArmrestWidthMode
            );
          }

          if (window.__setHingesFromState) {
            window.__setHingesFromState(data.selections?.hinges || selectedHinges);
          }

          applySelectedFabricSelectionForTab(getAppliedFabricTabKey());
          applySelectedPaspuleFabricIfValid();
          syncRenderedFabricBrowserSelection(currentFabricTabKey);
          syncMelbourneShelfTabVisibility();
        });
      });
    }

    // 4) restore camera
    if (data.camera?.pos && data.camera?.target) {
      camera.position.fromArray(data.camera.pos);
      controls.target.fromArray(data.camera.target);
      controls.update();

      camGoalPos.copy(camera.position);
      camGoalTarget.copy(controls.target);
      autoCamActive = false;
    }

    // âś… dopnout UI
    try { updateStep2ContinueUI(); } catch (e) {}
    try { updateStep3ContinueUI(); } catch (e) {}
    try { updateStep4ContinueUI(); } catch (e) {}
    try { updateBottomBarUI(); } catch (e) {}

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { updateFabricSelectionIndicators?.(); } catch (e) {}
      });
    });

    try { updateBuildModeUI(); } catch (e) {}
    try { if (isBuildStepActive()) updateButtons(); } catch (e) {}

    // NÄ›kterĂ© init kroky (vĂ˝bava / pĹ™epoÄŤet sestavy) si bÄ›hem restore sĂˇhnou
    // na rozmÄ›ry znovu. Na konci proto vrĂˇtĂ­me pĹ™esnÄ› obnovenĂ© user hodnoty
    // a aĹľ potom pĹ™erenderujeme UI rozmÄ›rĹŻ podle finĂˇlnĂ­ sestavy.
    if (restoredSofaDims) {
      window.__sofaDims = { ...restoredSofaDims };
    }
    if (restoredSofaDimsLayoutKey) {
      window.__sofaDimsLayoutKey = restoredSofaDimsLayoutKey;
    }
    window.refreshSofaDimsUI?.();

    // âś… uloĹľit 1Ă— finĂˇlnĂ­ stav
    saveStateNow();

    restoredOk = true;
    return true;
  } finally {
    // âś… Tohle je ten fix: vĹľdycky odblokovat uklĂˇdĂˇnĂ­ i pĹ™i return false / chybÄ›
    isRestoringState = false;

    if (restoredOk) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { updateStep2ContinueUI(); } catch (e) {}
          try { updateStep3ContinueUI(); } catch (e) {}
          try { updateStep4ContinueUI(); } catch (e) {}
          try { reconcileStepLocksWithCurrentValidity(); } catch (e) {}
          try { if (appState.step === 5) renderRecapView(); } catch (e) {}
          try { saveStateNow(); } catch (e) {}
        });
      });
    }
  }

  if (restoredOk) saveStateNow();
}

// (volitelnĂ©) kdyĹľ chceĹˇ "novĂ˝ zaÄŤĂˇtek":
function clearSavedState() {
  localStorage.removeItem(STORAGE_KEY);
}

const moduleActionMenu = document.getElementById("moduleActionMenu");

// === AUTO CAMERA (default stav) ===
const DEFAULT_CAM_POS = new THREE.Vector3(0, 1.5, 1.5);
const DEFAULT_TARGET  = new THREE.Vector3(0, 0, 0);

// =========================
//  CAMERA FOCUS PER TAB
// =========================
let lastFocusedTabKey = null;

function getExtremeModuleMesh(side = "right") {
  // activeModules: [{ mesh, ... }]
  if (!Array.isArray(activeModules) || activeModules.length === 0) return null;

  let best = null;
  let bestX = side === "right" ? -Infinity : Infinity;

  const box = new THREE.Box3();
  const center = new THREE.Vector3();

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;
    box.setFromObject(rec.mesh);
    box.getCenter(center);

    if (side === "right") {
      if (center.x > bestX) { bestX = center.x; best = rec.mesh; }
    } else {
      if (center.x < bestX) { bestX = center.x; best = rec.mesh; }
    }
  }
  return best;
}

function focusCameraOnObject(mesh, {
  // jemnĂ© doladÄ›nĂ­ podle toho, co chceĹˇ ukĂˇzat
  targetYOffset = 0.15,
  distanceMul = 1.6,

  // pĹŻvodnĂ­ chovĂˇnĂ­ (kdyĹľ nechceĹˇ lock na "pĹ™edek modulu")
  dir = new THREE.Vector3(0.35, 0.22, 1).normalize(),

  // âś… NOVĂ‰: kdyĹľ true, ignoruje userViewDir a vĹľdy mĂ­Ĺ™Ă­ "zepĹ™edu modulu"
  lockToModuleFront = false,

  // âś… NOVĂ‰: jak moc zvednout smÄ›r nahoru (0 = ÄŤistÄ› zepĹ™edu)
  frontTiltY = 0.22,
} = {}) {
  if (!mesh || !camera || !controls) return;

  // najdi "root modul" (tj. rec.mesh z activeModules), i kdyĹľ klikĂˇme na ÄŤĂˇst (noha/podruÄŤka)
  function findModuleRootForMesh(m) {
    let o = m;
    while (o) {
      for (const rec of activeModules) {
        if (rec?.mesh === o) return o;
      }
      o = o.parent;
    }
    return m;
  }

  const box = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  // target: stĹ™ed objektu + malĂ˝ posun nahoru/dolĹŻ
  const target = center.clone();
  target.y = box.min.y + targetYOffset;

  // vzdĂˇlenost podle velikosti
  const base = Math.max(size.x, size.y, size.z);
  const dist = Math.max(1.2, base * distanceMul);

  let finalDir;

  if (lockToModuleFront) {
    const moduleRoot = findModuleRootForMesh(mesh);

    // svÄ›tovĂˇ orientace modulu
    const q = new THREE.Quaternion();
    moduleRoot.getWorldQuaternion(q);

    // "pĹ™edek modulu" = +Z (sedĂ­ ti s default kamerou (0, ?, +Z) koukajĂ­cĂ­ na (0,0,0))
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();

    // lehce shora (pĹ™imĂ­chĂˇme Y)
    finalDir = front.add(new THREE.Vector3(0, frontTiltY, 0)).normalize();
  } else {
    // pĹŻvodnĂ­ chovĂˇnĂ­: dir + pĹ™Ă­padnÄ› userViewDir
    finalDir = dir.clone();
    if (typeof userViewDir !== "undefined" && userViewDir && userViewDir.lengthSq() > 1e-6) {
      finalDir = userViewDir.clone().normalize();
    }
  }

  // goal pozice/target
  camGoalTarget.copy(target);
  camGoalPos.copy(target.clone().add(finalDir.multiplyScalar(dist)));
  autoCamActive = true;

  controls.update();
}

// === helpery pro fokus: prvnĂ­ modul + vĂ˝bÄ›r konkrĂ©tnĂ­ ÄŤĂˇsti ===
function getFirstAddedModuleMesh() {
  if (!Array.isArray(activeModules) || activeModules.length === 0) return null;
  return activeModules[0]?.mesh || null; // PRVNĂŤ pĹ™idanĂ˝ modul
}

function collectMeshesByKeywords(root, keywords) {
  const out = [];
  if (!root) return out;

  const keys = keywords.map(k => String(k).toLowerCase());
  root.traverse((o) => {
    if (!o || !o.isMesh) return;
    const n = (o.name || "").toLowerCase();
    if (!n) return;
    if (keys.some(k => n.includes(k))) out.push(o);
  });

  return out;
}

function pickMostInFrontOfModule(meshes, moduleRoot) {
  if (!meshes?.length || !moduleRoot) return null;

  // "pĹ™edek modulu" = jeho lokĂˇlnĂ­ +Z (pokud mĂˇĹˇ jinak, Ĺ™ekni a otoÄŤĂ­me)
  const frontDir = new THREE.Vector3(0, 0, 1).applyQuaternion(moduleRoot.quaternion).normalize();

  const moduleCenter = new THREE.Vector3();
  new THREE.Box3().setFromObject(moduleRoot).getCenter(moduleCenter);

  let best = null;
  let bestScore = -Infinity;

  const p = new THREE.Vector3();
  for (const m of meshes) {
    m.getWorldPosition(p);
    const v = p.clone().sub(moduleCenter);
    const score = v.dot(frontDir); // ÄŤĂ­m vÄ›tĹˇĂ­, tĂ­m vĂ­c "vpĹ™edu"
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function pickRightmost(meshes) {
  if (!meshes?.length) return null;
  let best = null;
  let bestX = -Infinity;
  const p = new THREE.Vector3();
  for (const m of meshes) {
    m.getWorldPosition(p);
    if (p.x > bestX) { bestX = p.x; best = m; }
  }
  return best;
}

function pickModuleWithMostHeadrests() {
  if (!Array.isArray(activeModules) || !activeModules.length) return null;

  let best = null;
  let bestCount = -1;

  for (const rec of activeModules) {
    const moduleMesh = rec?.mesh;
    if (!moduleMesh) continue;

    // pojistka: kdyĹľ by headrestDots jeĹˇtÄ› nebyly pĹ™ipravenĂ©, tak je pĹ™iprav
    if (!Array.isArray(moduleMesh.userData?.headrestDots)) {
      setupHeadrestDotsForModule(moduleMesh);
    }

    const count = moduleMesh.userData.headrestDots?.length || 0;

    if (count > bestCount) {
      bestCount = count;
      best = moduleMesh;
    }
  }

  return best;
}

function raiseAllHeadrestsOnModule(moduleMesh) {
  if (!moduleMesh) return;

  // pojistka: kdyĹľ by headrestDots jeĹˇtÄ› nebyly pĹ™ipravenĂ©, tak je pĹ™iprav
  if (!Array.isArray(moduleMesh.userData?.headrestDots)) {
    setupHeadrestDotsForModule(moduleMesh);
  }

  const dots = moduleMesh.userData.headrestDots || [];

  const vid = String(moduleMesh?.userData?.variantId || "").toLowerCase();
  const isMendoza = vid.startsWith("mendoza_");

  for (const dot of dots) {
    const hr = dot?.userData?.headrestMesh || dot?.parent; // dot je pĹ™idanĂ˝ na hr
    if (!hr) continue;

    // âś… Mendoza: nezaklĂˇdej pivoty, jen pĹ™epĂ­nej 1->2 (zvednout vĹˇechny)
    if (isMendoza) {
      const moduleRoot = getModuleRoot(hr);

      let obj = hr;
      let m = null;
      while (obj && obj !== moduleRoot && !m) {
        const nn = String(obj?.name || "").toLowerCase();
        m = nn.match(/^backrest_(1|2)([pls])(\.|_|$)/);
        obj = obj.parent;
      }

      if (m) {
        const cur = Number(m[1]);
        // zvednout jen ty, co jsou v "1" (dole)
        if (cur === 1) toggleHeadrest(hr);
      }

      continue;
    }

    // Manchester: vlastní translate-only animace bez rotace
    if (isManchesterTranslateHeadrest(hr)) {
      const isUp = !!hr.userData._manchesterHeadrestIsUp;

      // zvednout jen ty, co nejsou zvednuté
      if (!isUp) toggleHeadrest(hr);

      continue;
    }

    // Manila (a vše ostatní): původní pivot animace
    const pivot = hr.userData._headrestPivot || ensureHeadrestPivot(hr);
    if (!pivot) continue;

    const isUp = !!pivot.userData._headrestIsUp;

    // zvednout jen ty, co nejsou zvednuté
    if (!isUp) toggleHeadrest(hr);
  }
}

function focusCameraBehindModule(moduleMesh, opts = {}) {
  if (!moduleMesh) return;

  // âś… ladÄ›nĂ­ (mĹŻĹľeĹˇ mÄ›nit i z volĂˇnĂ­)
  const distanceMul   = opts.distanceMul   ?? 2.2;   // menĹˇĂ­ = blĂ­Ĺľ
  const targetYOffset = opts.targetYOffset ?? 0.10;  // kam mĂ­Ĺ™Ă­Ĺˇ (vĂ˝Ĺˇka targetu)
  const upTilt        = opts.upTilt        ?? 0.18;  // kolik "shora"
  const sideAmount    = opts.sideAmount    ?? 0.55;  // 0 = zezadu, 1 = z boku
  const sideSign      = opts.sideSign      ?? 1;     // 1 = pravĂˇ strana, -1 = levĂˇ

  // bbox modulu -> centrum a velikost
  const box = new THREE.Box3().setFromObject(moduleMesh);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const base = Math.max(size.x, size.y, size.z);
  const dist = Math.max(1.2, base * distanceMul);

  // "zezadu" = -Z v lokĂˇlu modulu -> svÄ›t
  const backDir = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(moduleMesh.quaternion)
    .normalize();

  // "z boku" = +X (nebo -X) v lokĂˇlu modulu -> svÄ›t
  const sideDir = new THREE.Vector3(1 * sideSign, 0, 0)
    .applyQuaternion(moduleMesh.quaternion)
    .normalize();

  // âś… mix: zezadu + bok + trochu nahoru
  const dir = backDir.clone()
    .multiplyScalar(1 - sideAmount)
    .add(sideDir.multiplyScalar(sideAmount))
    .add(new THREE.Vector3(0, upTilt, 0))
    .normalize();

  const target = center.clone();
  target.y += targetYOffset;

  camGoalTarget.copy(target);
  camGoalPos.copy(target).add(dir.multiplyScalar(dist));

  autoCamActive = true;
}

function focusCameraForBottomTab(tabKey) {
  // aĹĄ to nespamuje, kdyĹľ user klikne na uĹľ aktivnĂ­ tab
  if (tabKey === lastFocusedTabKey) return;
  lastFocusedTabKey = tabKey;

  const firstModule = getFirstAddedModuleMesh();
  if (!firstModule) return;

  if (tabKey === "extras") {
    // zatĂ­m jen obecnĂ˝ pohled na modul (pozdÄ›ji zamÄ›Ĺ™Ă­me sedĂˇky / konkrĂ©tnĂ­ modul)
    focusCameraOnObject(firstModule, {
      lockToModuleFront: true,
      frontTiltY: 0.22,
      targetYOffset: 0.25,
      distanceMul: 2.25
    });
    return;
  }

  if (tabKey === "legs") {
    // 1) nohy bereme z PRVNĂŤHO modulu (uĹľ ne nejvĂ­c vpravo)
    const legMeshes = collectMeshesByKeywords(firstModule, [
      "leg", "noha", "nohy", "foot"
    ]);

    // 2) vyber jednu konkrĂ©tnĂ­ nohu: tu "nejvĂ­c vpĹ™edu" na tom modulu
    const leg = pickMostInFrontOfModule(legMeshes, firstModule) || firstModule;

    // 3) vĹľdy ze pĹ™edu modulu (ignoruje userViewDir)
    focusCameraOnObject(leg, {
      lockToModuleFront: true,
      frontTiltY: 0.06,        // nĂ­Ĺľ (vĂ­c k noĹľiÄŤkĂˇm)
      targetYOffset: -0.04,    // mĂ­Ĺ™ nĂ­Ĺľ
      distanceMul: 1.9
    });
    return;
  }

  if (tabKey === "armrests") {
    // U "Podrucky a rozmery" nech kamera zustat tam, kde prave je.
    return;
  }

  if (tabKey === "shelf") {
    // Polička:
    // - najde první rohový modul Roh_L / Roh_P
    // - i když jich je víc, vezme jen jeden
    // - v něm najde mesh "plane"
    // - kameru řeší stejně jako ostatní taby přes focusCameraOnObject,
    //   takže rychlost zůstává stejná přes CAMERA_LERP v animate()

    const cornerRec = (activeModules || []).find((rec) => {
      if (!rec?.mesh) return false;

      const variantId = String(
        rec?.name ??
        rec?.variantId ??
        rec?.mesh?.userData?.variantId ??
        ""
      ).trim();

      // match např. Melbourne_roh_L / Melbourne_roh_P / *_roh_L / *_roh_P
      return /(^|_)roh_[lp]$/i.test(variantId);
    });

    if (!cornerRec?.mesh) {
      console.warn("Shelf camera: ve scéně není žádný modul Roh_L / Roh_P.");
      lastFocusedTabKey = null;
      return;
    }

    let planeMesh = null;

    cornerRec.mesh.traverse((o) => {
      if (planeMesh) return;
      if (!o?.isMesh) return;

      const name = String(o.name || "").trim().toLowerCase();

      // Blender často dělá Plane, Plane.001 apod.
      if (
        name === "plane" ||
        name.startsWith("plane.") ||
        name.startsWith("plane_")
      ) {
        planeMesh = o;
      }
    });

    if (!planeMesh) {
      console.warn("Shelf camera: v rohovém modulu nebyl nalezen mesh 'plane'.", {
        variantId: String(
          cornerRec?.name ??
          cornerRec?.variantId ??
          cornerRec?.mesh?.userData?.variantId ??
          ""
        ).trim()
      });

      // pojistka: když by v GLB chyběl/změnil se název plane,
      // kamera aspoň necukne do chyby a zaměří celý roh
      planeMesh = cornerRec.mesh;
    }

    const cornerVariantId = String(
      cornerRec?.name ??
      cornerRec?.variantId ??
      cornerRec?.mesh?.userData?.variantId ??
      ""
    ).trim();

    const shelfCameraSideSign =
      /_roh_p$/i.test(cornerVariantId) ? 1 :
      /_roh_l$/i.test(cornerVariantId) ? -1 :
      1;

    focusCameraBehindModule(cornerRec.mesh, {
      distanceMul: 2.55,
      targetYOffset: -0.2,
      upTilt: 0.5,
      sideAmount: 0.5,
      sideSign: shelfCameraSideSign
    });

    return;

    return;
  }

  if (tabKey === "hinges") {
    // 1) vyber modul s nejvĂ­c hlavovkama (kdyĹľ ĹľĂˇdnĂ˝, tak fallback prvnĂ­ modul)
    let moduleMesh = pickModuleWithMostHeadrests();
    if (!moduleMesh && activeModules?.length) moduleMesh = activeModules[0]?.mesh;

    if (!moduleMesh) return;

    // 2) zvedni jen ty hlavovky, co nejsou zvednutĂ©
    raiseAllHeadrestsOnModule(moduleMesh);

    // 3) kamera zezadu na vybranĂ˝ modul (jako â€śpohled na pantyâ€ť)
    focusCameraBehindModule(moduleMesh, {
      distanceMul: 0.4,   // blĂ­Ĺľ (zkus 1.8 aĹľ 2.3)
      targetYOffset: 0.10,
      upTilt: 0.16,
      sideAmount: 0.45,   // vĂ­c z boku (0.5 aĹľ 0.8)
      sideSign: 1         // 1 pravĂˇ strana, -1 levĂˇ strana
    });

    return;
  }
}

function hardResetCameraToDefault() {
  if (!camera || !controls) return;

  // okamĹľitÄ› nastavit kameru i target (ĹľĂˇdnĂ˝ lerp)
  camera.position.copy(DEFAULT_CAM_POS);
  controls.target.copy(DEFAULT_TARGET);

  // sladit auto-fit promÄ›nnĂ©, aby ti to dalĹˇĂ­mi kroky "necuklo"
  camGoalPos.copy(DEFAULT_CAM_POS);
  camGoalTarget.copy(DEFAULT_TARGET);

  // reset stavu auto-fit logiky
  cameraPinned = false;
  userViewDir = null;
  autoCamActive = false;
  autoCamBlocked = false;

  // update OrbitControls + projekce
  controls.update();
  camera.updateProjectionMatrix?.();
}

function snapCameraToAutoGoal() {
  if (!camera || !controls) return;

  // okamĹľitÄ› skoÄŤ na vypoÄŤtenĂ˝ cĂ­l (stejnĂ© mĂ­sto, kam by se to do-larpovalo)
  camera.position.copy(camGoalPos);
  controls.target.copy(camGoalTarget);

  controls.update();
  autoCamActive = false; // uĹľ nenĂ­ potĹ™eba dojĂ­ĹľdÄ›t
}

function resetCameraToSofaFit({ snap = true } = {}) {
  // Reset â€žna celou sestavuâ€ś (podle aktuĂˇlnĂ­ch modulĹŻ)
  // - zruĹˇĂ­ tab-focus pohledy (step 3) a vrĂˇtĂ­ â€ždefault hezkĂ˝ smÄ›râ€ś
  if (!camera || !controls) return;

  // klĂ­ÄŤovĂ©: aĹĄ recomputeCameraFit pouĹľije FIRST_MODULE_DIR (ne aktuĂˇlnĂ­ smÄ›r)
  cameraPinned = false;
  userViewDir = null;

  // povol auto kameru (kdyby byla bloknutĂˇ)
  autoCamBlocked = false;

  // pĹ™epoÄŤet cĂ­le podle bbox celĂ© sestavy (activeModules)
  recomputeCameraFit();

  // buÄŹ skoÄŤ hned, nebo nech dojet lerpem
  if (snap) snapCameraToAutoGoal();

  // aĹĄ se to uloĹľĂ­ (kdyĹľ mĂˇĹˇ rozjetĂ˝ persist kamery)
  try { saveStateDebounced(); } catch (e) {}
}

function orbitCameraByPadDelta(dx, dy) {
  // dx/dy v pixelech -> pĹ™epoÄŤet na radiĂˇny
  if (!camera || !controls) return;

  const ORBIT_PAD_SPEED = 0.006; // rad / px (kdyĹľ bude moc rychlĂ©/pomalĂ©, uprav)

  // target
  const target = controls.target.clone();

  // poloha kamery relativnÄ› k targetu
  const offset = camera.position.clone().sub(target);

  // pĹ™evod na sfĂ©rickĂ© souĹ™adnice
  const spherical = new THREE.Spherical();
  spherical.setFromVector3(offset);

  // azimut (theta) = otoÄŤenĂ­ kolem Y, polar (phi) = sklon
  spherical.theta -= dx * ORBIT_PAD_SPEED;
  spherical.phi   -= dy * ORBIT_PAD_SPEED;

  // clamp phi (aĹĄ se to nepĹ™eklopĂ­ pĹ™es pĂłl)
  const EPS = 1e-4;
  const minPhi = (typeof controls.minPolarAngle === "number") ? controls.minPolarAngle : EPS;
  const maxPhi = (typeof controls.maxPolarAngle === "number") ? controls.maxPolarAngle : (Math.PI - EPS);
  spherical.phi = Math.max(minPhi + EPS, Math.min(maxPhi - EPS, spherical.phi));

  // zpÄ›t do kartĂ©zskĂ˝ch
  offset.setFromSpherical(spherical);

  camera.position.copy(target.add(offset));
  camera.lookAt(controls.target);

  // uĹľivatel si kameru â€śvzĂˇl do rukyâ€ť
  autoCamActive = false;
  autoCamBlocked = true;

  controls.update();
}

// ===== AUTO-FIT KAMERY (jak se mĂˇ kamera chovat, kdyĹľ jsou moduly) =====
// vĂ­c dozadu: zvyĹˇ Z
// mĂ­Ĺ z vrchu (vĂ­c "ze spodu"): sniĹľ Y
const CAMERA_FIT_DIR = new THREE.Vector3(0, 0.20, 1).normalize();

// kam mĂ­Ĺ™it (stĹ™ed sestavy + vĂ˝Ĺˇka)
// kdyĹľ mĂ­Ĺ™Ă­ moc vysoko, sniĹľ tohle ÄŤĂ­slo
const CAMERA_FIT_TARGET_Y = 0.10;

// pro plynulĂ˝ pĹ™echod
let camGoalPos = DEFAULT_CAM_POS.clone();
let camGoalTarget = DEFAULT_TARGET.clone();
let cameraPinned = false; // po prvnĂ­m "auto-nastavenĂ­" uĹľ jen oddalujeme
const FIRST_MODULE_DIR = new THREE.Vector3(0, 1.4, 6).normalize(); 
// â†‘ smÄ›r kamery od targetu: menĹˇĂ­ Y = kamera nĂ­Ĺľ, vÄ›tĹˇĂ­ Z = vĂ­c "zezadu"

// jak moc "odstupu" kolem sestavy (vyĹˇĹˇĂ­ = vĂ­c oddĂˇlit)
const CAMERA_FIT_PADDING = 1.25;

// rychlost plynulĂ©ho dojezdu (0.05..0.2)
const CAMERA_LERP = 0.035;

// -----------------------------------------------------
//  LOADERY
// -----------------------------------------------------

// ===== Prefetch + cache GLB (aby klik byl instantnĂ­) =====
const gltfCache = new Map();        // url -> Promise<gltf>
const MAX_PREFETCH = 8;             // kolik modelĹŻ dopĹ™edu

// ===== Cache pro FABRIC thumbnails (aby se po pĹ™epnutĂ­ kategoriĂ­ nenaÄŤĂ­taly znovu) =====
const fabricThumbCache = new Map(); // url -> Promise<HTMLImageElement>

function loadThumbCached(url) {
  const finalUrl = assetUrl(url);

  if (!finalUrl) return Promise.resolve(null);
  if (fabricThumbCache.has(finalUrl)) return fabricThumbCache.get(finalUrl);

  const img = new Image();
  img.decoding = "async";
  img.src = finalUrl;

  const p = new Promise((resolve) => {
    const done = async () => {
      try { if (img.decode) await img.decode(); } catch (e) {}
      resolve(img);
    };

    if (img.complete) done();
    else {
      img.onload = done;
      img.onerror = () => resolve(null);
    }
  });

  fabricThumbCache.set(finalUrl, p);
  return p;
}

// ===== LOADING OVERLAY (UI) =====
let _loadingCount = 0;
let _loadingTimer = null;

// aby to neblikalo:
let _loadingShownAt = 0;
let _loadingHideTimer = null;
const LOADING_MIN_VISIBLE_MS = 180; // klidnÄ› 150â€“250

function _getLoadingEl() {
  return document.getElementById("loadingOverlay");
}

function loadingBegin(delayMs = 10, text = "Načítám…") {
  _loadingCount++;

  // text nastav jen pĹ™i startu celĂ© "session"
  if (_loadingCount === 1) {
    const t = document.querySelector("#loadingOverlay .loadingText");
    if (t) t.textContent = text;

    if (_loadingHideTimer) {
      clearTimeout(_loadingHideTimer);
      _loadingHideTimer = null;
    }

    if (_loadingTimer) clearTimeout(_loadingTimer);

    _loadingTimer = setTimeout(() => {
      _loadingTimer = null;
      if (_loadingCount <= 0) return;

      const el = _getLoadingEl();
      if (!el) return;

      el.classList.add("is-visible");
      el.setAttribute("aria-hidden", "false");
      _loadingShownAt = performance.now();
    }, Math.max(0, delayMs));
  }
}

function loadingEnd() {
  _loadingCount = Math.max(0, _loadingCount - 1);

  if (_loadingCount !== 0) return;

  // kdyĹľ jeĹˇtÄ› ani neprobÄ›hl show timer, zruĹˇ ho
  if (_loadingTimer) {
    clearTimeout(_loadingTimer);
    _loadingTimer = null;
  }

  const el = _getLoadingEl();
  if (!el) return;

  const isVisible = el.classList.contains("is-visible");
  if (!isVisible) {
    // nebylo nikdy zobrazenĂ© -> nic neĹ™eĹˇ
    return;
  }

  const elapsed = performance.now() - (_loadingShownAt || 0);
  const remaining = LOADING_MIN_VISIBLE_MS - elapsed;

  if (remaining > 0) {
    // schovej aĹľ po min dobÄ›, aby to neblikalo
    if (_loadingHideTimer) clearTimeout(_loadingHideTimer);
    _loadingHideTimer = setTimeout(() => {
      el.classList.remove("is-visible");
      el.setAttribute("aria-hidden", "true");
      _loadingHideTimer = null;
    }, remaining);
  } else {
    el.classList.remove("is-visible");
    el.setAttribute("aria-hidden", "true");
  }
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function loadGLBCached(url) {
  if (gltfCache.has(url)) return gltfCache.get(url);

  loadingBegin(10);

  const p = new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      (err) => reject(err)
    );
  })
  .catch((err) => {
    // aĹĄ vidĂ­Ĺˇ chybu v konzoli (tohle ti pomĹŻĹľe kdyĹľ nÄ›co "nejde naÄŤĂ­st")
    console.error("GLB load failed:", url, err);
    throw err;
  })
  .finally(() => {
    loadingEnd();
  });

  gltfCache.set(url, p);
  return p;
}

function loadGLBCachedSilent(url) {
  if (gltfCache.has(url)) return gltfCache.get(url);

  const p = new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  }).catch((err) => {
    console.error("GLB silent load failed:", url, err);
    throw err;
  });

  gltfCache.set(url, p);
  return p;
}

function prefetchFirstModels(variantIds) {
  variantIds.slice(0, MAX_PREFETCH).forEach((variantId) => {
    const cat = getCatalog?.(variantId);
    if (!cat?.model) return;

    loadGLBCached(modelGlbUrl(cat.model)).catch(() => {});
  });
}

const addButtonLoader = new GLTFLoader();
const loader = new GLTFLoader();
const moduleTemplates = {};

// =====================================================
//  AddButton template cache (aby se Button.glb nenaÄŤĂ­tal poĹ™Ăˇd dokola)
// =====================================================
let _addButtonTemplatePromise = null;

function loadButton() {
  // 1) prvnĂ­ volĂˇnĂ­: naÄŤti Button.glb a uloĹľ jako template
  if (!_addButtonTemplatePromise) {
    loadingBegin(10);

    _addButtonTemplatePromise = new Promise((resolve) => {
      addButtonLoader.load(
        "/models/Button/Button.glb",
        (gltf) => {
          const template = gltf.scene;

          // nastav materiĂˇly jen na template
          template.traverse((o) => {
            if (!o.isMesh) return;

            o.castShadow = true;
            o.receiveShadow = true;

            const n = (o.name || "").toLowerCase();

            if (n.includes("cross") || n.includes("plus") || n.includes("x")) {
              o.material = BUTTON_CROSS_MAT.clone();
            } else {
              o.material = BUTTON_BODY_MAT.clone();
            }

            // pro jistotu raycast
            o.raycast = THREE.Mesh.prototype.raycast;

            o.userData.ignoreFabric = true;
            o.userData.materialRole = "ui";
          });

          resolve(template);
        },
        undefined,
        (err) => {
          console.error("Chyba načítání tlačítka:", err);
          resolve(null); // dĹŻleĹľitĂ©: aĹĄ promise nikdy nezĹŻstane viset
        }
      );
    }).finally(() => {
      loadingEnd();
    });
  }

  // 2) kaĹľdĂ© volĂˇnĂ­: vraĹĄ NOVOU instanci tlaÄŤĂ­tka (clone)
  return _addButtonTemplatePromise.then((template) => {
    const btn = template.clone(true);

    // dĹŻleĹľitĂ©: kaĹľdĂˇ instance musĂ­ mĂ­t svoje materiĂˇly (hover by jinak mÄ›nil vĹˇem)
    btn.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material) o.material = o.material.clone();
      o.userData.originalMaterial = o.material ? o.material : null;
    });

    return btn;
  });
}

// -----------------------------------------------------
//  TEXTURY + MATERIĂLY (DEFAULT)
// -----------------------------------------------------

const texLoader = new THREE.TextureLoader();

function textureHasImageData(tex) {
  const image = tex?.image;
  if (!image) return false;
  if (Array.isArray(image)) return image.length > 0;
  if (image.data) return true;

  const width = Number(image.width ?? image.naturalWidth ?? image.videoWidth ?? 0);
  const height = Number(image.height ?? image.naturalHeight ?? image.videoHeight ?? 0);
  return width > 0 && height > 0;
}

function markTextureForUpdateIfReady(tex) {
  if (textureHasImageData(tex)) {
    tex.needsUpdate = true;
  }
}

function setupTex(tex, isColor = false, repeat = 1) {
  // glTF UVs â†’ musĂ­ bĂ˝t flipY = false
  tex.flipY = false;

  // barva musĂ­ bĂ˝t v sRGB, ostatnĂ­ mapy jsou linear
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;

  // repeat
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);

  // âś… lepĹˇĂ­ filtrovĂˇnĂ­ â€“ hodnÄ› pomĂˇhĂˇ proti pruhĹŻm na ĹˇikmĂ˝ch plochĂˇch
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  // âś… anizotropie (pomĂˇhĂˇ proti "rozpatlĂˇnĂ­" textury pod Ăşhlem)
  // zatĂ­m nastavĂ­me rozumnou hodnotu, po vytvoĹ™enĂ­ rendereru to dotlaÄŤĂ­me na maximum GPU
  tex.anisotropy = 8;

  markTextureForUpdateIfReady(tex);
  
  return tex;
}

// ===== FABRIC (denim / default ĹˇedĂˇ) =====
const FABRIC_REPEAT = 2; // đź‘ zkus 4, 6, 8... podle jak jemnou lĂˇtku chceĹˇ

const FABRIC_baseColor = setupTex(texLoader.load("/textures/fabric/basecolor/basecolor_COL_VAR2_2K.jpg"), true, FABRIC_REPEAT);
const FABRIC_normal    = setupTex(texLoader.load("/textures/fabric/basecolor/basecolor_NRM_2K.jpg"), false, FABRIC_REPEAT);
const FABRIC_gloss = setupTex(texLoader.load("/textures/fabric/basecolor/basecolor_GLOSS_2K.jpg"), false, FABRIC_REPEAT);

const MAT_FABRIC = new THREE.MeshStandardMaterial({
  map: FABRIC_baseColor,
  normalMap: FABRIC_normal,
  normalScale: new THREE.Vector2(0.25, 0.25),
  roughness: 1.0,
  metalness: 0.0,
});

// âś… aĹľ se gloss textura naÄŤte, pĹ™ehodĂ­Ĺˇ ji na roughnessMap (invertovanou)
FABRIC_gloss.onUpdate = async () => {
  // onUpdate mĹŻĹľe bÄ›Ĺľet vĂ­ckrĂˇt, tak se pojistĂ­me
  if (MAT_FABRIC.userData._roughReady) return;
  MAT_FABRIC.userData._roughReady = true;

  MAT_FABRIC.roughnessMap = await invertTextureToRoughness(FABRIC_gloss);
  MAT_FABRIC.needsUpdate = true;
};

// ===== METAL (chrome) =====
// podle tvĂ©ho screenshotu: Color / Metalness / NormalDX / Roughness
const METAL_color     = setupTex(texLoader.load("/textures/metal/chrome/Metal049A_2K-JPG_Color.jpg"), true);
const METAL_metalness = setupTex(texLoader.load("/textures/metal/chrome/Metal049A_2K-JPG_Metalness.png"));
const METAL_normalDX  = setupTex(texLoader.load("/textures/metal/chrome/Metal049A_2K-JPG_NormalDX.png"));
const METAL_roughness = setupTex(texLoader.load("/textures/metal/chrome/Metal049A_2K-JPG_Roughness.png"));

const MAT_METAL = new THREE.MeshStandardMaterial({
  map: METAL_color,
  metalnessMap: METAL_metalness,
  normalMap: METAL_normalDX,
  roughnessMap: METAL_roughness,
  metalness: 1.0,
  roughness: 0.22,
  envMap: hingeEnvMap || null,
  envMapIntensity: 0.25,
});

// ===== WOOD (buk_prirodni) =====
const WOOD_color     = setupTex(texLoader.load("/textures/wood/buk/buk_prirodni.png"), true);
const WOOD_normal    = setupTex(texLoader.load("/textures/wood/buk/buk_prirodni_normal.png"));
const WOOD_roughness = setupTex(texLoader.load("/textures/wood/buk/buk_prirodni_roughness.png"));

const MAT_WOOD = new THREE.MeshStandardMaterial({
  map: WOOD_color,
  normalMap: WOOD_normal,
  roughnessMap: WOOD_roughness,
  roughness: 1.0,
  metalness: 0.0,
});

const WOOD_CORNER_color = setupTex(texLoader.load("/textures/wood/buk/buk_br_281.png"), true);
const WOOD_CORNER_normal = setupTex(texLoader.load("/textures/wood/buk/buk_br_281_normal.png"));
const WOOD_CORNER_roughness = setupTex(texLoader.load("/textures/wood/buk/buk_br_281_roughness.png"));

const MAT_WOOD_CORNER = new THREE.MeshStandardMaterial({
  map: WOOD_CORNER_color,
  normalMap: WOOD_CORNER_normal,
  roughnessMap: WOOD_CORNER_roughness,
  roughness: 0.9,
  metalness: 0.0,
});

const PASPULE_color = setupTex(texLoader.load("/textures/fabric/basecolor/Paspule-default.png"), true, FABRIC_REPEAT);
const PASPULE_normal = setupTex(texLoader.load("/textures/fabric/basecolor/Paspule-normal.png"), false, FABRIC_REPEAT);
const PASPULE_roughness = setupTex(texLoader.load("/textures/fabric/basecolor/Paspule-roughness.png"), false, FABRIC_REPEAT);

const MAT_PASPULE = new THREE.MeshStandardMaterial({
  map: PASPULE_color,
  normalMap: PASPULE_normal,
  normalScale: new THREE.Vector2(0.25, 0.25),
  roughnessMap: PASPULE_roughness,
  roughness: 1.0,
  metalness: 0.0,
});

// =====================================================
//  WOOD COLOR SWITCH (nohy) â€“ pĹ™epĂ­nĂˇnĂ­ textur podle vĂ˝bÄ›ru barvy
// =====================================================

// cache, aĹĄ se textury nenaÄŤĂ­tajĂ­ poĹ™Ăˇd dokola
const _woodTexCache = new Map(); // key -> { map, normalMap, roughnessMap }

function _woodPathsFromColorId(colorId) {
  // colorId napĹ™: "wood_buk_br_3023"  -> soubory: /textures/wood/buk/buk_br_3023(.png/_normal/_roughness)
  // colorId napĹ™: "wood_buk_prirodni" -> buk_prirodni.png + buk_prirodni_normal.png + buk_prirodni_roughness.png
  // colorId napĹ™: "wood_dub_prirodni" -> dub_prirodni.png + dub_normal.png + dub_roughness.png (podle tvĂ©ho folderu)

  if (!colorId || !colorId.startsWith("wood_")) return null;

  // speciĂˇl pro dub (podle tvĂ© sloĹľky: dub_prirodni.png + dub_normal.png + dub_roughness.png)
  if (colorId === "wood_dub_prirodni") {
    return {
      map: "/textures/wood/dub/dub_prirodni.png",
      normalMap: "/textures/wood/dub/dub_normal.png",
      roughnessMap: "/textures/wood/dub/dub_roughness.png",
    };
  }

  // obecnÄ›: vezmeme "buk_br_3023" nebo "buk_prirodni"â€¦
  const baseName = colorId.replace("wood_", ""); // "buk_br_3023"
  const folder = baseName.startsWith("dub_") ? "dub" : "buk"; // zatĂ­m mĂˇĹˇ reĂˇlnÄ› buk + dub

  return {
    map: `/textures/wood/${folder}/${baseName}.png`,
    normalMap: `/textures/wood/${folder}/${baseName}_normal.png`,
    roughnessMap: `/textures/wood/${folder}/${baseName}_roughness.png`,
  };
}

function _getWoodTexSet(colorId) {
  const paths = _woodPathsFromColorId(colorId);
  if (!paths) return null;

  const cacheKey = `${paths.map}|${paths.normalMap}|${paths.roughnessMap}`;
  if (_woodTexCache.has(cacheKey)) return _woodTexCache.get(cacheKey);

  const set = {
    map: setupTex(texLoader.load(paths.map), true),
    normalMap: setupTex(texLoader.load(paths.normalMap), false),
    roughnessMap: setupTex(texLoader.load(paths.roughnessMap), false),
  };

  _woodTexCache.set(cacheKey, set);
  return set;
}

function _getWoodTextures(colorId) {
  return _getWoodTexSet(colorId);
}

async function applyWoodColorToAllLegs(colorId) {
  const tex = await _getWoodTextures(colorId);

  // âś… stejnĂ© rozpoznĂˇnĂ­ nohou jako ve forceLegsOnly()
  const isLegThing = (name) => {
    const n = (name || "").toLowerCase();
    return (
      n.includes("legs") ||
      n.includes("noha") ||
      n.includes("nohy") ||
      n.includes("podnoz") ||
      n.includes("feet")
    );
  };

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;

    rec.mesh.traverse((obj) => {
      if (!obj.isMesh) return;

      const n = (obj.name || "").toLowerCase();

      // âś… BYLO: if (!n.includes("legs")) return;
      // âś… NOVÄš: bereme i noha/nohy/podnoz/feet
      if (!isLegThing(n)) return;
      if (_isMetalLegMeshName(n)) return;

      // âś… jen aktuĂˇlnÄ› vybranĂˇ/viditelnĂˇ varianta nohou
      if (!obj.visible) return;

      const mat = MAT_WOOD.clone();
      mat.map = tex.map;
      mat.normalMap = tex.normalMap;
      mat.roughnessMap = tex.roughnessMap;

      // vyÄŤisti metal vÄ›ci
      mat.metalness = 0.0;
      mat.metalnessMap = null;
      mat.envMap = null;
      mat.envMapIntensity = 0.0;

      mat.needsUpdate = true;
      obj.material = mat;
      obj.userData.materialRole = "other";
      obj.userData.originalMaterial = mat.clone();
    });
  }
}

async function applyShelfColorToMelbournePlanes(colorId = selectedShelfColor) {
  const tex = await _getWoodTextures(colorId || "wood_buk_br_281");
  if (!tex) return;

  for (const rec of activeModules || []) {
    const variantId = String(getRecVariantId(rec) || rec?.model || "");
    if (!/^Melbourne_/i.test(variantId)) continue;

    rec.mesh?.traverse((obj) => {
      if (!obj?.isMesh || !obj.material) return;
      const name = String(obj.name || "").toLowerCase();
      if (name !== "plane") return;

      const mat = MAT_WOOD_CORNER.clone();
      mat.map = tex.map;
      mat.normalMap = tex.normalMap;
      mat.roughnessMap = tex.roughnessMap;
      mat.roughness = 0.9;
      mat.metalness = 0.0;
      mat.needsUpdate = true;

      obj.material = mat;
      obj.userData.originalMaterial = mat.clone();
      obj.userData.materialRole = "other";
    });
  }
}

// ============================
// METAL TEXTURES FOR LEGS
// ============================

// Pozn.: uprav si cesty pokud mĂˇĹˇ jinĂ© nĂˇzvy souborĹŻ.
// Podle tvĂ˝ch screenshotĹŻ:

const METAL_TEX = {
  metal_chrome: {
    color: "/textures/metal/chrome/Metal049A_2K-JPG_Color.jpg",
    normal: "/textures/metal/chrome/Metal049A_2K-JPG_NormalDX.jpg",
    roughness: "/textures/metal/chrome/Metal049A_2K-JPG_Roughness.jpg",
    metalness: "/textures/metal/chrome/Metal049A_2K-JPG_Metalness.jpg",
  },
  metal_matte: {
    color: "/textures/metal/matte/Poliigon_MetalSteelBrushed_7174_BaseColor.jpg",
    normal: "/textures/metal/matte/Poliigon_MetalSteelBrushed_7174_Normal.png",
    roughness: "/textures/metal/matte/Poliigon_MetalSteelBrushed_7174_Roughness.jpg",
    metalness: "/textures/metal/matte/Poliigon_MetalSteelBrushed_7174_Metallic.jpg",
  },
  metal_matte_black: {
    color: "/textures/metal/matte_black/Poliigon_MetalPaintedMatte_7037_BaseColor.jpg",
    normal: "/textures/metal/matte_black/Poliigon_MetalPaintedMatte_7037_Normal.png",
    roughness: "/textures/metal/matte_black/Poliigon_MetalPaintedMatte_7037_Roughness.jpg",
    metalness: "/textures/metal/matte_black/Poliigon_MetalPaintedMatte_7037_Metallic.jpg",
  },
  meta_graphite: {
    color: "/textures/metal/graphite/Metal059A_2K-PNG_Color.png",
    normal: "/textures/metal/graphite/Metal059A_2K-PNG_NormalGL.png",
    roughness: "/textures/metal/graphite/Metal059A_2K-PNG_Roughness.png",
    metalness: "/textures/metal/graphite/Metal059A_2K-PNG_Metalness.png",
  },
};

const _metalLegMatCache = new Map();

function _isMetalLegMeshName(name) {
  const n = (name || "").toLowerCase();

  if (/^n(?:1|8|11|21)$/i.test(n)) return true;

  const isLegThing = (s) => {
    const t = (s || "").toLowerCase();
    return (
      t.includes("legs") ||
      t.includes("noha") ||
      t.includes("nohy") ||
      t.includes("podnoz") ||
      t.includes("feet")
    );
  };

  if (!isLegThing(n)) return false;

  return (
    /(^|_)n1(_|$)/i.test(n) ||
    /(^|_)n21(_|$)/i.test(n) ||
    /(^|_)n8(_|$)/i.test(n) ||
    /(^|_)n11(_|$)/i.test(n)
  );
}

function getMetalLegMaterial(colorId) {
  if (_metalLegMatCache.has(colorId)) return _metalLegMatCache.get(colorId);

  const def = METAL_TEX[colorId] || METAL_TEX.metal_chrome;

  // âś… pouĹľĂ­vej stejnĂ˝ loader + stejnĂ© nastavenĂ­ jako u wood
  // (u tebe uĹľ texLoader a setupTex existujĂ­ vĂ˝Ĺˇ v souboru)
  const map         = setupTex(texLoader.load(def.color), true);
  const normalMap   = setupTex(texLoader.load(def.normal));
  const roughnessMap= setupTex(texLoader.load(def.roughness));
  const metalnessMap= setupTex(texLoader.load(def.metalness));

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    metalness: 1.0,
    roughness: 0.25,

    // âś… HDRI jen pro tenhle materiĂˇl (NE na scene.environment)
    envMap: hingeEnvMap || null,
    envMapIntensity: 0.7,
  });

  _metalLegMatCache.set(colorId, mat);
  return mat;
}

function applyMetalColorToAllLegs(colorId) {
  const baseMat = getMetalLegMaterial(colorId);

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;

    rec.mesh.traverse((o) => {
      if (!o?.isMesh) return;

      // âś… jen kovovĂ© legs (N1 a N11)
      if (!_isMetalLegMeshName(o.name)) return;

      // âś… aby se to nesdĂ­lelo s jinĂ˝mi meshama omylem
      o.material = baseMat.clone();
      o.material.needsUpdate = true;
      o.userData.materialRole = "other";
      o.userData.originalMaterial = o.material.clone();
    });
  }
}

async function invertTextureToRoughness(glossTexture) {
  const img = glossTexture.image;
  if (!img) throw new Error("invertTextureToRoughness: texture.image is missing");

  const w = img.width;
  const h = img.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const p = data.data;

  // invert RGB (gloss -> roughness)
  for (let i = 0; i < p.length; i += 4) {
    p[i + 0] = 255 - p[i + 0];
    p[i + 1] = 255 - p[i + 1];
    p[i + 2] = 255 - p[i + 2];
    // alpha nechĂˇvĂˇm
  }

  ctx.putImageData(data, 0, 0);

  const roughTex = new THREE.CanvasTexture(canvas);
  // pĹ™enes nastavenĂ­ z pĹŻvodnĂ­ textury (repeat, wrap, encodingâ€¦)
  roughTex.wrapS = glossTexture.wrapS;
  roughTex.wrapT = glossTexture.wrapT;
  roughTex.repeat.copy(glossTexture.repeat);
  roughTex.offset.copy(glossTexture.offset);
  roughTex.rotation = glossTexture.rotation;
  roughTex.center.copy(glossTexture.center);
  roughTex.flipY = glossTexture.flipY;
  roughTex.anisotropy = glossTexture.anisotropy || 1;

  roughTex.colorSpace = THREE.NoColorSpace;
  roughTex.needsUpdate = true;
  return roughTex;
}

function isHingeMeshName(name) {
  const n = (name || "").toLowerCase();
  return n.includes("hinge") || n.includes("pant");
}

function isLegMeshName(name) {
  const n = (name || "").toLowerCase();
  return (
    n.includes("legs") ||
    n.includes("noha") ||
    n.includes("nohy") ||
    n.includes("podnoz") ||
    n.includes("feet") ||
    /^n(?:1|7|8|9|11|21)$/i.test(n)
  );
}

function isNonUpholsteryHardPartMeshName(name) {
  const n = (name || "").toLowerCase();
  return (
    isLegMeshName(n) ||
    isHingeMeshName(n) ||
    n === "plane" ||
    n.includes("paspule")
  );
}

function isUpholsteryMeshName(name) {
  const n = (name || "").toLowerCase();

  // vĹˇe co nechceme pĹ™ebarvit jako lĂˇtku:
  if (isNonUpholsteryHardPartMeshName(n)) return false;

  // pokud mĂˇĹˇ dalĹˇĂ­ â€śtvrdĂ©â€ť ÄŤĂˇsti, pĹ™idej si sem:
  // if (n.includes("wood")) return false;
  // if (n.includes("metal")) return false;

  // jinak bereme jako ÄŤalounÄ›nĂ­
  return true;
}

function getMaterialForMeshName(meshName) {
  const n = (meshName || "").toLowerCase();

  if (n === "plane") return MAT_WOOD_CORNER;
  if (n.includes("paspule")) return MAT_PASPULE;

  // nohy
  if (isLegMeshName(n)) {
    if (_isMetalLegMeshName(n)) return MAT_METAL;
    return MAT_WOOD;
  }

  // panty
  if (isHingeMeshName(n)) return MAT_METAL;

  // vĹˇechno ostatnĂ­ = lĂˇtka
  return MAT_FABRIC;
}

function applyDefaultMaterials(root) {
  // snapMesh (seat) â€“ stejnÄ› jako pĹ™i loadAllModules()
  root.userData.snapMesh = null;

  root.traverse((obj) => {
    if (!obj.isMesh) return;

    obj.castShadow = true;
    obj.receiveShadow = true;

    let baseMat = getMaterialForMeshName(obj.name);
    const objName = (obj.name || "").toLowerCase();

    // âś… Mendoza: primĂˇrnĂ­ nohy legs_N8 majĂ­ bĂ˝t kov (chrom)
    const isMendoza = /^mendoza/i.test(root?.userData?.variantId || root?.userData?.moduleName || "");
    const isMelbourne = /^melbourne/i.test(root?.userData?.variantId || root?.userData?.moduleName || "");
    if (isMendoza) {
      if (objName.includes("legs_n8")) {
        baseMat = MAT_METAL;
      }
    }
    if (isMelbourne) {
      if (objName === "plane") baseMat = MAT_WOOD_CORNER;
      if (objName.includes("paspule")) baseMat = MAT_PASPULE;
    }

    // clone materiĂˇlu, aby mÄ›l kaĹľdĂ˝ mesh vlastnĂ­ instanci
    obj.material = baseMat.clone();

    // uloĹľit originĂˇl (pro reset hoveru)
    obj.userData.originalMaterial = obj.material.clone();

    // âś… oznaÄŤenĂ­ role materiĂˇlu (dĹŻleĹľitĂ© pro â€śmÄ›Ĺ jen lĂˇtkuâ€ť)
    if (isMelbourne && objName.includes("paspule")) {
      obj.userData.materialRole = "paspule";
    } else if (isUpholsteryMeshName(obj.name)) {
      obj.userData.materialRole = "upholstery";
    } else {
      obj.userData.materialRole = "other";
    }

    // snap mesh
    if ((obj.name || "").toLowerCase().includes("seat")) {
      root.userData.snapMesh = obj;
    }
  });
}

// seznam REĂLNĂťCH 3D modelĹŻ (GLB) â€“ unikĂˇtnÄ›
const modelNames = Array.from(
  new Set(Object.values(modulesCatalog).map(v => v.model))
);

function oppositeDirection(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "front") return "back";
  if (dir === "back") return "front";
  return null;
}

const BUTTON_BODY_MAT = new THREE.MeshPhysicalMaterial({
  color: 0xeeeeee,
  roughness: 0.35,
  metalness: 0.0,
  clearcoat: 0.6,
  clearcoatRoughness: 0.25,
});

const BUTTON_CROSS_MAT = new THREE.MeshStandardMaterial({
  color: 0x2b2b2b,
  roughness: 0.55,
  metalness: 0.0,
});

async function loadAllModules() {
  console.time("loadAllModules (sequential)");

  for (const name of modelNames) {
    await new Promise((resolve) => {
      loader.load(
        modelGlbUrl(name),
        (gltf) => {
          moduleTemplates[name] = gltf.scene;

          gltf.scene.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
              let baseMat = getMaterialForMeshName(obj.name);
              const objName = (obj.name || "").toLowerCase();
              const isMelbourne = /^melbourne/i.test(name);

              if (isMelbourne) {
                if (objName === "plane") baseMat = MAT_WOOD_CORNER;
                if (objName.includes("paspule")) baseMat = MAT_PASPULE;
              }

              obj.material = baseMat;
              obj.userData.originalMaterial = obj.material.clone();
            }

            if (obj.isMesh && obj.name.toLowerCase().includes("seat")) {
              gltf.scene.userData.snapMesh = obj;
            }
          });

          resolve();
        },
        undefined,
        (err) => {
          console.error("Chyba naÄŤĂ­tĂˇnĂ­:", name, err);
          resolve();
        }
      );
    });

    // âś… po kaĹľdĂ©m modelu nech UI nadechnout
    await new Promise((r) => requestAnimationFrame(r));
  }

  console.timeEnd("loadAllModules (sequential)");
}

function detectConnectionDirection(moduleMesh, position) {
  const local = moduleMesh.worldToLocal(position.clone());

  if (local.x > 0.5) return "right";
  if (local.x < -0.5) return "left";
  if (local.z > 0.5) return "front";
  if (local.z < -0.5) return "back";

  return null;
}

function getSnapMesh(root) {
  let snap = null;
  root.traverse((o) => {
    if (o.isMesh && o.name.toLowerCase().includes("seat")) {
      snap = o;
    }
  });
  return snap || root;
}

function getModuleRoot(obj) {
  let root = obj;
  while (root && root.parent && root.parent !== scene) {
    root = root.parent;
  }
  return root;
}

function getButtonRoot(obj) {
  let root = obj;
  while (root && root.parent && root.parent !== scene) root = root.parent;
  return root;
}

function computeSnapPosition(baseModule, newModule, direction) {
  baseModule = getModuleRoot(baseModule);
  newModule = getModuleRoot(newModule);

  const baseSnap = getSnapMesh(baseModule);
  const newSnap = getSnapMesh(newModule);

  const baseBox = new THREE.Box3().setFromObject(baseSnap);
  const newBox = new THREE.Box3().setFromObject(newSnap);

  const pos = baseModule.position.clone();

  if (direction === "left") {
    pos.x = baseBox.min.x - (newBox.max.x - newModule.position.x);
  }
  if (direction === "right") {
    pos.x = baseBox.max.x - (newBox.min.x - newModule.position.x);
  }
  if (direction === "front") {
    pos.z = baseBox.min.z - (newBox.max.z - newModule.position.z);
  }
  if (direction === "back") {
    pos.z = baseBox.max.z - (newBox.min.z - newModule.position.z);
  }

  return pos;
}

async function warmupWebGL() {
  // vezmeme libovolnĂ˝ uĹľ naÄŤtenĂ˝ template a na 1 frame ho skrytÄ› vykreslĂ­me
  const firstKey = Object.keys(moduleTemplates)[0];
  const original = moduleTemplates[firstKey];
  if (!original) return;

  const tmp = original.clone(true);
  tmp.visible = false;
  scene.add(tmp);

  // donutĂ­me renderer pĹ™ipravit shadery/programy
  renderer.compile(scene, camera);

  // jeden render frame ÄŤasto dotlaÄŤĂ­ upload textur + kompilaci shaderĹŻ
  renderer.render(scene, camera);

  scene.remove(tmp);
}

// -----------------------------------------------------
//  ZĂKLADNĂŤ 3D SCĂ‰NA
// -----------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f5f2);

// Kamera
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

camera.position.set(0, 1.2, 5);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0xf7f5f2, 1);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// âś… DĹ®LEĹ˝ITĂ‰ â€“ sprĂˇvnĂ© barvy / shading
renderer.outputColorSpace = THREE.SRGBColorSpace;

// âś… dotlaÄŤit anizotropii na max podle GPU (nejlepĹˇĂ­ kvalita na ĹˇikmĂ˝ch plochĂˇch)
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

// nastavĂ­me to na vĹˇechny texture promÄ›nnĂ©, co uĹľ mĂˇĹˇ vytvoĹ™enĂ© vĂ˝Ĺˇ
[
  FABRIC_baseColor, FABRIC_normal, FABRIC_gloss,
  METAL_color, METAL_metalness, METAL_normalDX, METAL_roughness,
  WOOD_color, WOOD_normal, WOOD_roughness,
].forEach((t) => {
  if (!t) return;
  t.anisotropy = MAX_ANISO;
  markTextureForUpdateIfReady(t);
});

// âś… ToneMapping OK, ale expozice byla moc vysokĂˇ (3 je hodnÄ›)
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;

document.getElementById("threeRoot").appendChild(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);

// uloĹľĂ­me do tĂ© GLOBĂLNĂŤ promÄ›nnĂ© (let hingeEnvMap nahoĹ™e)
hingeEnvMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

MAT_METAL.envMap = hingeEnvMap;
MAT_METAL.needsUpdate = true;

// mĹŻĹľeme pmrem pak klidnÄ› dispose, aĹĄ nevisĂ­ v pamÄ›ti
pmrem.dispose();

// -----------------------------------------------------
//  START BUTTON (vytvoĹ™ aĹľ kdyĹľ existuje scene)
// -----------------------------------------------------
let modulesReady = false;

(async () => {
  if (!startButton) {
    const btn = await createButtonAt(new THREE.Vector3(0, 0, 0));
    startButton = btn;
    startButton.userData.isStartButton = true;
    startButton.visible = (activeModules.length === 0);
  }
})();

// -----------------------------------------------------
//  PREFETCH MODULĹ® NA POZADĂŤ (NEBLOKUJE UI)
// -----------------------------------------------------

const PRIORITY_MODELS = [
  "Manila_1D_L",
  "Manila_1D_P",
  "Manila_2L",
  "Manila_2M",
  "Manila_2P",
  "Manila_3L",
  "Manila_3M",
  "Manila_3P",
  "Manila_roh_L",
  "Manila_roh_P",
];

function getModelNamesForPrefix(prefix) {
  return modelNames.filter((name) => String(name || "").startsWith(prefix + "_"));
}

function getSofaFolderFromModelName(modelName) {
  // oÄŤekĂˇvĂˇme formĂˇt: "Manila_1D_L", "Mendoza_2P", ...
  // vezmeme prefix pĹ™ed prvnĂ­m podtrĹľĂ­tkem
  return String(modelName).split("_")[0];
}

function modelGlbUrl(modelName) {
  const folder = getSofaFolderFromModelName(modelName);
  return `/models/${folder}/${modelName}.glb`;
}

function prefetchModelGLB(modelName) {
  return loadGLBCachedSilent(modelGlbUrl(modelName)).catch(() => {});
}

// =====================================================
//  PREFETCH jen pro vybranou sedaÄŤku (lazy-load)
// =====================================================

// 1) seznamy modulĹŻ podle sedaÄŤky
//    (teÄŹ mĂˇĹˇ jen Manila, dalĹˇĂ­ pĹ™idĂˇĹˇ sem)
const SOFA_MODULES = {
  Manila: getModelNamesForPrefix("Manila"),
  Mendoza: getModelNamesForPrefix("Mendoza"),
  Melbourne: getModelNamesForPrefix("Melbourne"),
};

// 2) priority seznamy podle sedaÄŤky
const SOFA_PRIORITY = {
  Manila: PRIORITY_MODELS,
  Mendoza: [
    "Mendoza_1D_L",
    "Mendoza_1D_P",
    "Mendoza_2L",
    "Mendoza_2M",
    "Mendoza_2P",
    "Mendoza_3L",
    "Mendoza_3M",
    "Mendoza_3P",
    "Mendoza_roh_L",
    "Mendoza_roh_P",
  ],
  Melbourne: [
    "Melbourne_1D_L",
    "Melbourne_1D_P",
    "Melbourne_2L",
    "Melbourne_2M",
    "Melbourne_2P",
    "Melbourne_3L",
    "Melbourne_3M",
    "Melbourne_3P",
    "Melbourne_roh_L",
    "Melbourne_roh_P",
  ],
};

// 3) prefetch pro konkrĂ©tnĂ­ sedaÄŤku + modul (cesta /models/<SofaKey>/<Module>.glb)
function prefetchModelGLBForSofa(sofaKey, moduleName) {
  const url = modelGlbUrl(moduleName); // vezme sloĹľku z "Mendoza_..." / "Manila_..."
  return loadGLBCachedSilent(url).catch(() => {});
}

// 4) spusĹĄ prefetch pro zvolenou sedaÄŤku (priority -> zbytek)
function queuePrefetchForSofa(sofaKey) {
  if (!sofaKey) return;

  const priority = SOFA_PRIORITY[sofaKey] || [];
  const all = SOFA_MODULES[sofaKey] || [];

  // priority nejdĹ™Ă­v
  priority.forEach((m) => enqueuePriorityJob(() => prefetchModelGLBForSofa(sofaKey, m)));

  // zbytek na idle
  all
    .filter((m) => !priority.includes(m))
    .forEach((m) => enqueueIdleJob(() => prefetchModelGLBForSofa(sofaKey, m)));
}

// idle fronta (aby se to nedusilo)
const idleQueue = [];
let idleRunning = false;

function runIdleQueue() {
  if (idleRunning) return;
  if (idleQueue.length === 0) return;

  idleRunning = true;

  const job = idleQueue.shift();

  const done = () => {
    idleRunning = false;
    // dalĹˇĂ­ job aĹľ v dalĹˇĂ­m idle slotu
    scheduleIdle(runIdleQueue);
  };

  job().finally(done);
}

function scheduleIdle(fn) {
  if ("requestIdleCallback" in window) {
    requestIdleCallback(fn, { timeout: 300 });
  } else {
    setTimeout(fn, 0);
  }
}

function enqueueIdleJob(fn) {
  idleQueue.push(fn);
  scheduleIdle(runIdleQueue);
}

function preventCameraInsideModules() {
  // kdyĹľ nejsou moduly, nic
  if (!activeModules.length) return;

  // aura kolem modulĹŻ (30 cm)
  const aura = CAMERA_AURA; // 0.30

  // kamera pozice
  const camPos = camera.position;

  // pro kaĹľdĂ˝ modul â€“ udÄ›lej bounding sphere a otestuj, jestli kamera nenĂ­ uvnitĹ™
  for (const rec of activeModules) {
    const root = rec?.mesh;
    if (!root) continue;

    // spoÄŤti bounding sphere z bbox
    const box = new THREE.Box3().setFromObject(root);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);

    // zvÄ›tĹˇi kouli o auru
    sphere.radius += aura;

    // test: kamera uvnitĹ™ â€žbublinyâ€ś?
    const dist = camPos.distanceTo(sphere.center);

    if (dist < sphere.radius) {
      // posuĹ kameru pĹ™esnÄ› na okraj koule (bez vystĹ™elenĂ­)
      const dir = camPos.clone().sub(sphere.center).normalize();

      // kdyĹľ by kamera byla pĹ™esnÄ› ve stĹ™edu (fail-safe)
      if (dir.lengthSq() < 0.000001) dir.set(0, 0, 1);

      camPos.copy(sphere.center).add(dir.multiplyScalar(sphere.radius));
    }
  }
}

function resetModuleHover(moduleRoot) {
  if (!moduleRoot) return;

  moduleRoot.traverse((o) => {
    if (!o || !o.isMesh || !o.material) return;

    const mats = Array.isArray(o.material) ? o.material : [o.material];

    mats.forEach((mat) => {
      if (!mat) return;

      // vraĹĄ pĹŻvodnĂ­ emissive hodnoty, pokud existujĂ­
      if (mat.userData && mat.userData._hoverOrigEmissive) {
        if (mat.emissive) mat.emissive.copy(mat.userData._hoverOrigEmissive);
        mat.emissiveIntensity = mat.userData._hoverOrigEmissiveIntensity ?? 0;
      } else {
        // fallback: kdyĹľ nemĂˇme uloĹľenĂ© orig hodnoty
        if (mat.emissive) mat.emissive.setHex(0x000000);
        if ("emissiveIntensity" in mat) mat.emissiveIntensity = 0;
      }

      mat.needsUpdate = true;
    });
  });
}

function makeHoverMaterialUnique(mesh) {
  if (!mesh || !mesh.isMesh || !mesh.material || mesh.userData?._hoverMatUnique) return;

  try {
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((mat) => (mat?.clone ? mat.clone() : mat));
    } else if (mesh.material?.clone) {
      mesh.material = mesh.material.clone();
    }

    mesh.userData._hoverMatUnique = true;
  } catch (e) {
    console.warn("makeHoverMaterialUnique failed:", e);
  }
}

function applyModuleHover(moduleRoot) {
  if (!moduleRoot) return;

  moduleRoot.traverse((o) => {
    if (!o || !o.isMesh || !o.material) return;

    // 1) zajisti unikĂˇtnĂ­ materiĂˇl pro tenhle mesh (aĹĄ emissive neovlivnĂ­ jinĂ© moduly)
    makeHoverMaterialUnique(o);

    const mats = Array.isArray(o.material) ? o.material : [o.material];

    mats.forEach((mat) => {
      if (!mat) return;

      // 2) kdyĹľ emissive neexistuje, vytvoĹ™ ho
      if (!mat.emissive) mat.emissive = new THREE.Color(0x000000);

      // 3) uloĹľ originĂˇl emissive jen poprvĂ©
      if (mat.userData._hoverOrigEmissive === undefined) {
        mat.userData._hoverOrigEmissive = mat.emissive.clone();
        mat.userData._hoverOrigEmissiveIntensity = mat.emissiveIntensity ?? 0;
      }

      // 4) aplikuj highlight (jen emissive, NIKDY nepĹ™episuj mapy/barvy)
      mat.emissive.setHex(0xffffff);
      mat.emissiveIntensity = 0.08; // kdyĹľ je to moc, dej tĹ™eba 0.05
      mat.needsUpdate = true;
    });
  });
}

// -----------------------------------------------------
//  PRIORITY FRONTa (pro kliknutĂ­ uĹľivatele)
// -----------------------------------------------------
const priorityQueue = [];
let priorityRunning = false;

function runPriorityQueue() {
  if (priorityRunning) return;
  if (priorityQueue.length === 0) return;

  priorityRunning = true;

  const job = priorityQueue.shift();
  job().finally(() => {
    priorityRunning = false;
    // dalĹˇĂ­ job hned (priority mĂˇ pĹ™ednost)
    runPriorityQueue();
  });
}

function enqueuePriorityJob(fn) {
  priorityQueue.push(fn);
  runPriorityQueue();
}

// âś… po loadu udÄ›lĂˇme jen lehkĂ˝ warmup WebGL (ĹľĂˇdnĂ© stahovĂˇnĂ­ GLB dopĹ™edu)
window.addEventListener("load", () => {
  enqueueIdleJob(() => warmupWebGL().catch(console.error));
});

const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

// =====================================================
// HEADREST DOTS (klikacĂ­ puntĂ­ky + animace zvednutĂ­)
// =====================================================

const headrestDots = [];              // vĹˇechny puntĂ­ky (kvĹŻli raycastu)
let hoveredHeadrestDot = null;        // pro hover efekt

function rebuildAllHeadrestDots() {
  // 1) odstranit existujĂ­cĂ­ doty ze scĂ©ny
  for (const d of headrestDots) {
    if (d && d.parent) d.parent.remove(d);
  }

  // 2) vyÄŤistit registry
  headrestDots.length = 0;
  hoveredHeadrestDot = null;

  // 3) znovu vytvoĹ™it doty pro vĹˇechny aktuĂˇlnĂ­ moduly
  for (const rec of activeModules) {
    if (rec?.mesh) setupHeadrestDotsForModule(rec.mesh);
  }

  // 4) pĹ™enastavit viditelnost podle aktuĂˇlnĂ­ho kroku
  updateHeadrestDotsVisibility();

  // kdyĹľ jsme v PĹ™Ă­platcĂ­ch, pĹ™erenderuj seznam modulĹŻ
  if (currentEquipTabKey === "extras") {
    renderExtrasModuleList();
  }
}

// ladÄ›nĂ­:
// jak moc se headrest zvedne (v jednotkĂˇch scĂ©ny; typicky metry)
const HEADREST_LIFT_Y = 0.095;
// jak dlouho trvĂˇ animace (ms)
const HEADREST_ANIM_MS = 220;

// o kolik se mĂˇ headrest posunout dopĹ™edu (lokĂˇlnÄ›)
const HEADREST_FORWARD_Z = -0.03;

// o kolik se mĂˇ headrest "pĹ™iklopit" dopĹ™edu (v radiĂˇnech)
const HEADREST_PITCH_X = THREE.MathUtils.degToRad(50);

// âś… kdyĹľ hlavovka STARTUJE NAHOĹE, tak pĹ™i prvnĂ­m pohybu DOLĹ® nechceme tak velkĂ˝ posun
// (uprav si ÄŤĂ­sla podle oka)
const HEADREST_DOWN_FROM_UP_Y = 0.05;   // bylo moc: 0.095
const HEADREST_DOWN_FROM_UP_Z = -0.052;  // bylo moc: -0.03

// ===============================
// HEADREST OVERRIDES (corners)
// ===============================

// vytĂˇhne "backrest_2p" / "backrest_2l" / "backrest_2s" z nĂˇzvu meshe
function getHeadrestKeyFromName(name) {
  const n = (name || "").toLowerCase();
  const m = n.match(/^backrest_2[pls]/); // vezme tĹ™eba "backrest_2p"
  return m ? m[0] : null;
}

// VrĂˇtĂ­ nastavenĂ­ pro danou hlavovku (osa + posuny).
// Default = jako doteÄŹ (osa X).
function getHeadrestSettings(hrMesh) {
  const variantId = (typeof getVariantIdForAnyObject === "function")
    ? (getVariantIdForAnyObject(hrMesh) || "")
    : "";

  const v = variantId.toLowerCase();
  const key = getHeadrestKeyFromName(hrMesh?.name);

  const out = {
    axis: new THREE.Vector3(1, 0, 0),          // osa rotace
    liftY: HEADREST_LIFT_Y,

    // kolik "dopĹ™edu" (po ose, kterou urÄŤĂ­me nĂ­Ĺľe)
    forwardZ: HEADREST_FORWARD_Z,

    // z jakĂ© osy se bere "dopĹ™edu" (default = Z)
    forwardAxis: new THREE.Vector3(0, 0, 1),

    // kdyĹľ headrest startuje nahoĹ™e a poprvĂ© jde dolĹŻ:
    downFromUpY: HEADREST_DOWN_FROM_UP_Y,
    downFromUpZ: HEADREST_DOWN_FROM_UP_Z,      // (po forwardAxis)
  };

  const isRohL = v.includes("roh_l");
  const isRohP = v.includes("roh_p");

  // ===== ROH_P: backrest_P (backrest_2p) =====
  if (isRohP && key === "backrest_2p") {
    out.axis = new THREE.Vector3(0, 0, 1);
    out.forwardAxis = new THREE.Vector3(1, 0, 0);

    // tvoje hodnoty pro Roh_P (nech si je jak chceĹˇ)
    out.liftY = 0.105;
    out.forwardZ = 0.015;
  }

  // ===== ROH_L: backrest_P (backrest_2p) â€“ ZRCADLO =====
  if (isRohL && key === "backrest_2p") {
    // âś… osa otoÄŤenĂˇ = opaÄŤnĂ˝ smÄ›r rotace (bez dalĹˇĂ­ch zmÄ›n v toggleHeadrest)
    out.axis = new THREE.Vector3(0, 0, -1);

    // nech stejnĂ©, nebo si to uprav podle potĹ™eby
    out.forwardAxis = new THREE.Vector3(1, 0, 0);

    // âś… tady si nastavĂ­Ĺˇ Roh_L ĂşplnÄ› individuĂˇlnÄ›
    out.liftY = 0.105;     // zkus tĹ™eba 0.105, 0.095, 0.115...
    out.forwardZ = -0.015;  // zkus tĹ™eba 0.015, 0.010, 0.020...
  }

  if ((isRohL || isRohP) && key === "backrest_2l") {
    // âś… tady doladĂ­Ĺˇ pohyb pro L hlavovku na rohu (osa nechĂˇme default X)
    out.liftY = 0.105;       // zkus 0.070 kdyĹľ je to moc
    out.forwardZ = -0.015;   // zkus -0.020 kdyĹľ je to moc dopĹ™edu
  }

  return out;
}

// âś… moduly (variantId), kterĂ© majĂ­ headrest v zĂˇkladu UĹ˝ NAHOĹE
// Sem doplnĂ­Ĺˇ ty svoje varianty: napĹ™. "Manila_roh_L": true
const HEADREST_STARTS_UP_BY_VARIANT = {
  // "Manila_roh_L": true,
  // "Manila_1MO_P": true,
};

const HEADREST_STARTS_UP_ONLY_MESHES = {
  "Manila_2":  ["backrest_2p"],
  "Manila_2L": ["backrest_2p"],
  "Manila_2M": ["backrest_2p"],

  "Manila_2P": ["backrest_2l"],

  "Manila_3":  ["backrest_2s"],
  "Manila_3L": ["backrest_2s"],
  "Manila_3M": ["backrest_2s"],
  "Manila_3P": ["backrest_2s"],

  "Melbourne_2":  ["backrest_2p"],
  "Melbourne_2L": ["backrest_2p"],
  "Melbourne_2M": ["backrest_2p"],

  "Melbourne_2P": ["backrest_2l"],

  "Melbourne_3":  ["backrest_2s"],
  "Melbourne_3L": ["backrest_2s"],
  "Melbourne_3M": ["backrest_2s"],
  "Melbourne_3P": ["backrest_2s"],
};

function findActiveModuleRecForObject(obj) {
  // Projdi rodiÄŤe smÄ›rem nahoru a hledej, jestli nÄ›kterĂ˝ z nich je pĹ™esnÄ› activeModules[i].mesh
  let o = obj;
  while (o) {
    const rec = activeModules.find(r => r.mesh === o);
    if (rec) return rec;
    o = o.parent;
  }
  return null;
}

function getVariantIdForAnyObject(obj) {
  // 1) NejrychlejĹˇĂ­ a funguje i pĹ™ed activeModules.push(record):
  let o = obj;
  while (o) {
    if (o.userData && o.userData.variantId) return o.userData.variantId;
    o = o.parent;
  }

  // 2) Fallback: aĹľ kdyĹľ to nenajdeme v userData, zkusĂ­me activeModules
  const root = getModuleRoot(obj);
  const rec = activeModules.find((r) => r.mesh === root);
  return rec?.name || null;
}

function headrestStartsUp(headrestMesh) {
  const variantId = getVariantIdForAnyObject(headrestMesh);
  if (!variantId) return false;

  // 1) jednoduchĂ˝ reĹľim: celĂ˝ modul mĂˇ headresty nahoĹ™e
  if (HEADREST_STARTS_UP_BY_VARIANT[variantId]) return true;

  // 2) jemnÄ›jĹˇĂ­ reĹľim: jen nÄ›kterĂ© konkrĂ©tnĂ­ headrest meshe
  const list = HEADREST_STARTS_UP_ONLY_MESHES[variantId];
  if (Array.isArray(list) && list.length) {
    const n = (headrestMesh?.name || "").toLowerCase();

    // povolĂ­me i suffixy: backrest_2p.001 / backrest_2p_something
    return list.some((base) =>
      n === base ||
      n.startsWith(base + ".") ||
      n.startsWith(base + "_")
    );
  }

  return false;
}

function createDotTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  // jemnĂ˝ nenĂˇpadnĂ˝ puntĂ­k
  ctx.clearRect(0, 0, size, size);

  // vnÄ›jĹˇĂ­ kruh (lehce prĹŻhlednĂ˝)
  ctx.beginPath();
  ctx.arc(size/2, size/2, size*0.28, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fill();

  // vnitĹ™nĂ­ teÄŤka
  ctx.beginPath();
  ctx.arc(size/2, size/2, size*0.12, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  return tex;
}

const HEADREST_DOT_TEX = createDotTexture();
const HEADREST_DOT_MAT = new THREE.SpriteMaterial({
  map: HEADREST_DOT_TEX,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  opacity: 0.9,
});

const HEADREST_DOT_HITBOX_MAT = new THREE.SpriteMaterial({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  opacity: 0.001,
});

function getHeadrestDotRoot(obj) {
  // kdyĹľ klikneme na "vizuĂˇlnĂ­ puntĂ­k" (child), odkĂˇĹľe nĂˇs rovnou na root
  if (obj?.userData?.headrestDotRoot) return obj.userData.headrestDotRoot;

  let o = obj;
  while (o && !o.userData?.isHeadrestDot) o = o.parent;
  return (o && o.userData?.isHeadrestDot) ? o : null;
}

function removeHeadrestDotsForModule(moduleMesh) {
  if (!moduleMesh?.userData?.headrestDots) return;

  for (const dot of moduleMesh.userData.headrestDots) {
    // odeber ze scĂ©ny
    if (dot.parent) dot.parent.remove(dot);

    // odeber z globĂˇlnĂ­ho listu
    const idx = headrestDots.indexOf(dot);
    if (idx !== -1) headrestDots.splice(idx, 1);
  }

  moduleMesh.userData.headrestDots = [];
}

function resetHeadrestStateForModule(moduleMesh) {
  if (!moduleMesh) return;

  const isHeadrestLikeName = (name) => {
    const n = String(name || "").toLowerCase();

    // Původní Manila / starší systém
    if (n.includes("backrest_2")) return true;

    // Nové headrest meshe:
    // headrest_l, headrest_p, headrest_s, headrest_001, headrest_cokoliv...
    if (n.startsWith("headrest_") && !n.endsWith("_pivot")) return true;

    return false;
  };

  moduleMesh.traverse((o) => {
    if (!o || !o.isObject3D) return;

    const isHeadrest = isHeadrestLikeName(o.name);
    if (!isHeadrest) return;

    // 1) Když hlavovka aktuálně visí v pivotu, MUSÍME ji vytáhnout ven,
    //    jinak se při dalším buildu vytvoří pivot v pivotu.
    const parent = o.parent;
    const looksLikePivot =
      parent &&
      parent.isObject3D &&
      typeof parent.name === "string" &&
      parent.name.toLowerCase().endsWith("_pivot");

    if (looksLikePivot) {
      const pivot = parent;
      const pivotParent = pivot.parent;

      // Vytáhni hlavovku do pivotParent se zachováním world transformu
      if (pivotParent) {
        pivotParent.attach(o);
        pivotParent.remove(pivot);
      } else {
        pivot.remove(o);
      }
    }

    // 2) Vyčisti stav
    delete o.userData._headrestIsUp;
    delete o.userData._headrestBasePos;
    delete o.userData._headrestBaseQuat;
    delete o.userData._headrestUpPos;
    delete o.userData._headrestUpQuat;
    delete o.userData._headrestAnim;

    // Manchester translate-only animace
    delete o.userData._manchesterHeadrestIsUp;
    delete o.userData._manchesterHeadrestBasePos;
    delete o.userData._manchesterHeadrestAnim;
    delete o.userData._manchesterHeadrestStateInitialized;

    // 3) Zapomenout pivot referenci
    o.userData._headrestPivot = null;
  });
}

function ensureHeadrestPivot(hr) {
  if (!hr || hr.userData._headrestPivot) return hr.userData._headrestPivot;

  // bbox v lokĂˇlu geometrie (kvĹŻli nalezenĂ­ "spodku" = mĂ­sto pantu)
  if (hr.geometry && !hr.geometry.boundingBox) hr.geometry.computeBoundingBox();
  const bb = hr.geometry?.boundingBox;
  if (!bb) return null;

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  bb.getCenter(center);
  bb.getSize(size);

  // Pant: vezmeme spodnĂ­ hranu hlavovky v lokĂˇlu meshe.
  // (tohle je klĂ­ÄŤ â€“ pivot bude "dole", takĹľe sklĂˇpÄ›nĂ­ nebude ujĂ­ĹľdÄ›t)
  const hingeLocal = center.clone().add(new THREE.Vector3(0, -size.y * 0.5, 0));

  const parent = hr.parent;
  if (!parent) return null;

  // vytvoĹ™ pivot jako novĂ˝ parent pro hr
  const pivot = new THREE.Object3D();
  pivot.name = `${hr.name}_pivot`;

  // pivot dostane pĹŻvodnĂ­ transform headrestu
  pivot.position.copy(hr.position);
  pivot.quaternion.copy(hr.quaternion);
  pivot.scale.copy(hr.scale);

  // vloĹľ pivot na stejnĂ© mĂ­sto v hierarchii, kde byl hr
  parent.add(pivot);

  // hr resetni a dej pod pivot
  hr.position.set(0, 0, 0);
  hr.quaternion.identity();
  hr.scale.set(1, 1, 1);
  pivot.add(hr);

  // posuĹ pivot do mĂ­sta pantu (ve smÄ›ru pivotu)
  const hingeWorldOffset = hingeLocal.clone().applyQuaternion(pivot.quaternion).multiply(pivot.scale);
  pivot.position.add(hingeWorldOffset);

  // a mesh posuĹ opaÄŤnÄ›, aby vizuĂˇlnÄ› zĹŻstal na mĂ­stÄ›
  hr.position.sub(hingeLocal);

  // uloĹľ reference
  hr.userData._headrestPivot = pivot;

  // --- DEFAULT: ber aktuĂˇlnĂ­ stav jako DOWN ---
  let baseQuat = pivot.quaternion.clone();
  let basePos  = pivot.position.clone();
  let isUpNow  = false;

  // âś… pokud tenhle modul/headrest STARTUJE NAHOĹE:
  if (headrestStartsUp(hr)) {
    const upQuat = pivot.quaternion.clone();
    const upPos  = pivot.position.clone();

    const s = getHeadrestSettings(hr);

    const invDeltaQuat = new THREE.Quaternion().setFromAxisAngle(
      s.axis,
      -HEADREST_PITCH_X
    );

    baseQuat = pivot.quaternion.clone().multiply(invDeltaQuat);

    const offsetDown = new THREE.Vector3(0, s.downFromUpY, 0)
      .add(s.forwardAxis.clone().multiplyScalar(s.downFromUpZ));
    basePos = pivot.position.clone().sub(offsetDown);

    pivot.userData._headrestUpQuat = upQuat;
    pivot.userData._headrestUpPos  = upPos;

    isUpNow = true;
  }

  pivot.userData._headrestBaseQuat = baseQuat;
  pivot.userData._headrestBasePos  = basePos;
  pivot.userData._headrestIsUp = isUpNow;
  pivot.userData._headrestAnim = null;

  return pivot;
}

function setupHeadrestDotsForModule(moduleMesh) {
  if (!moduleMesh) return;

  const variantId = String(
    moduleMesh?.userData?.variantId ||
    moduleMesh?.userData?.name ||
    moduleMesh?.name ||
    ""
  ).trim();

  const variantIdLower = variantId.toLowerCase();

  const isCornerModuleWithoutHeadrests =
    (
      variantIdLower.startsWith("manchester_") ||
      variantIdLower.startsWith("mendoza_") ||
      variantIdLower.startsWith("melbourne_")
    ) &&
    /(^|_)roh_[lp]$/i.test(variantId);

  // VÝJIMKA PRO ROHOVÉ MODULY BEZ HOTSPOTŮ:
  //
  // Manchester Roh_L / Roh_P:
  // - vypnuto
  //
  // Mendoza Roh_L / Roh_P:
  // - vypnuto
  //
  // Melbourne Roh_L / Roh_P:
  // - vypnuto
  //
  // DŮLEŽITÉ:
  // Manila Roh_L / Roh_P se tady NESMÍ vypnout,
  // protože Manila má původní rohové hotspoty zachovat.
  if (isCornerModuleWithoutHeadrests) {
    removeHeadrestDotsForModule(moduleMesh);
    moduleMesh.userData.headrestDots = [];
    return;
  }

  // kdyby se volalo víckrát, nejdřív uklidit
  removeHeadrestDotsForModule(moduleMesh);
  moduleMesh.userData.headrestDots = [];
  resetHeadrestStateForModule(moduleMesh);

  const headrestMeshes = [];

  // âś… Mendoza: v modelech mĹŻĹľeĹˇ mĂ­t "backrest_1P/L/S" (dole) a "backrest_2P/L/S" (nahoĹ™e)
  // Manila (a ostatnĂ­) zĹŻstĂˇvĂˇ beze zmÄ›ny (headresty = backrest_2*)
  const variantPrefix = String(moduleMesh?.userData?.variantId || "").toLowerCase();
  const isPairedBackrestModule =
    variantPrefix.startsWith("mendoza_") || variantPrefix.startsWith("melbourne_");

  function getHeadrestDotOffsetForModule(moduleMesh, hr) {
    const variantId = String(moduleMesh?.userData?.variantId || "").toLowerCase();
    const headrestName = String(hr?.name || "").toLowerCase();

    // DEFAULT / Manila
    const offset = new THREE.Vector3(0.00, 0.10, -0.14);

    // Mendoza
    if (variantId.startsWith("mendoza_")) {
      offset.set(0.00, 0.10, -0.14);
    }

    // Melbourne
    if (variantId.startsWith("melbourne_")) {
      offset.set(0.00, 0.10, -0.14);
    }

    // Manila – původní pozice hotspotu
    if (variantId.startsWith("manila_")) {
      offset.set(0.00, 0.00, 0.0);
    }

    // Nové headrest_ meshe chceme zatím stejně jako Manilu.
    // Až budeme ladit animaci / přesnou pozici, můžeme to upravit po modelu.
    if (headrestName.startsWith("headrest_")) {
      offset.set(0.00, 0.00, 0.0);
    }

    return offset;
  }

  // Headrest meshe:
  // - Manila / původní systém: backrest_2, backrest_2.001, backrest_2L/P/S...
  // - Mendoza / Melbourne párové hlavovky: backrest_1P/L/S + backrest_2P/L/S
  // - Nový systém: všechny objekty začínající headrest_
  const isExactHeadrest = (name) => {
    const n = String(name || "").toLowerCase();

    // Nové headrest meshe:
    // headrest_l, headrest_p, headrest_s, headrest_001, headrest_cokoliv...
    // Pozor: nechceme chytat námi vytvořené pivoty typu headrest_l_pivot.
    if (n.startsWith("headrest_") && !n.endsWith("_pivot")) {
      return true;
    }

    // Mendoza / Melbourne: povol i backrest_1p/backrest_1l/backrest_1s (+ suffixy)
    if (isPairedBackrestModule && n.startsWith("backrest_1")) {
      const rest1 = n.slice("backrest_1".length);

      if (rest1[0] === "p" || rest1[0] === "l" || rest1[0] === "s") {
        if (rest1.length === 1) return true;
        if (rest1[1] === "." || rest1[1] === "_") return true;
      }

      // nechceme backrest_1 bez P/L/S = obyčejné opěrky zad
      return false;
    }

    // Manila / původní systém
    if (!n.startsWith("backrest_2")) return false;

    const rest = n.slice("backrest_2".length);

    if (rest === "") return true;
    if (rest[0] === "." || rest[0] === "_") return true;

    if (rest[0] === "p" || rest[0] === "l" || rest[0] === "s") {
      if (rest.length === 1) return true;
      if (rest[1] === "." || rest[1] === "_") return true;
    }

    return false;
  };

  // helper: najdi prvnĂ­ Mesh potomka (kdyĹľ je headrest root jen Group/Empty)
  const findFirstMeshDescendant = (root) => {
    if (!root) return null;
    if (root.isMesh) return root;

    let found = null;
    root.traverse((ch) => {
      if (found) return;
      if (ch && ch.isMesh) found = ch;
    });
    return found;
  };

  // helper: kdyĹľ mĂˇ objekt nad sebou jinĂ˝ headrest root, nechceme duplicitu
  const hasHeadrestAncestor = (obj) => {
    let p = obj?.parent;
    while (p && p !== moduleMesh) {
      if (isExactHeadrest(p.name) && !String(p.name || "").toLowerCase().includes("backrest_1")) {
        return true;
      }
      p = p.parent;
    }
    return false;
  };

  const picked = new Set();
  const pairedCandidates = new Map();

  moduleMesh.traverse((o) => {
    if (!o || !o.isObject3D) return;

    const n = (o.name || "").toLowerCase();

    // nechceme backrest_1 (opÄ›rky zad) â€“ vĂ˝jimka: Mendoza/Melbourne backrest_1P/L/S je headrest (dole)
    if (n.includes("backrest_1") && !(isPairedBackrestModule && /^backrest_1[pls](\.|_|$)/.test(n))) return;

    // headrest root (mĹŻĹľe bĂ˝t Mesh i Group/Empty)
    if (!isExactHeadrest(o.name)) return;

    // kdyĹľ je to Mesh a uĹľ mĂˇ headrest ancestor, je to duplikĂˇt â†’ skip
    if (o.isMesh && hasHeadrestAncestor(o)) return;

    const hrMesh = findFirstMeshDescendant(o);
    if (!hrMesh) return;

    if (isPairedBackrestModule) {
      const pair = n.match(/^backrest_(1|2)([pls])(\.|_|$)/);
      if (pair) {
        const pairKey = pair[2];
        const version = pair[1];
        const entry = pairedCandidates.get(pairKey) || {};
        entry[version] = { root: o, mesh: hrMesh };
        pairedCandidates.set(pairKey, entry);
        return;
      }
    }

    // pojistka: nedĂˇvej stejnĂ˝ mesh 2Ă—
    if (picked.has(hrMesh)) return;
    picked.add(hrMesh);

    headrestMeshes.push(hrMesh);
  });

  if (isPairedBackrestModule) {
    for (const [, entry] of pairedCandidates.entries()) {
      const visibleCandidate =
        (entry["1"]?.root?.visible ? entry["1"] : null) ||
        (entry["2"]?.root?.visible ? entry["2"] : null) ||
        entry["1"] ||
        entry["2"] ||
        null;

      const hrMesh = visibleCandidate?.mesh || null;
      if (!hrMesh) continue;
      if (picked.has(hrMesh)) continue;
      picked.add(hrMesh);
      headrestMeshes.push(hrMesh);
    }
  }

  for (const hr of headrestMeshes) {
    const pivot = ensureHeadrestPivot(hr);
    if (!pivot) continue;

    // spoÄŤti stĹ™ed bbox z GEOMETRIE (lokĂˇlnĂ­ prostor meshe) â€“ stabilnÄ›jĹˇĂ­ neĹľ setFromObject
    if (hr.geometry && !hr.geometry.boundingBox) {
      hr.geometry.computeBoundingBox();
    }

    const centerL = new THREE.Vector3();
    if (hr.geometry && hr.geometry.boundingBox) {
      hr.geometry.boundingBox.getCenter(centerL);
    } else {
      // fallback kdyby mesh nemÄ›l geometrii jak ÄŤekĂˇme
      centerL.set(0, 0, 0);
    }

    const dot = new THREE.Sprite(HEADREST_DOT_HITBOX_MAT.clone());
    dot.userData.isHeadrestDot = true;
    dot.userData.headrestMesh = hr;
    dot.visible = isHeadrestStepActive();

    // vÄ›tĹˇĂ­ neviditelnĂ˝ hitbox pro pohodlnÄ›jĹˇĂ­ klikĂˇnĂ­
    dot.scale.set(0.11, 0.11, 1);

    // posuĹ hitbox trochu vĂ­c pĹ™ed hlavovku, aĹĄ ho lĂ©pe trefĂ­ raycaster
    dot.position.copy(centerL);
    dot.position.add(getHeadrestDotOffsetForModule(moduleMesh, hr));

    const visualDot = new THREE.Sprite(HEADREST_DOT_MAT.clone());
    visualDot.userData.headrestDotRoot = dot;
    visualDot.scale.set(0.32, 0.32, 1);
    visualDot.position.set(0, 0, 0.002);

    dot.userData.visualDot = visualDot;
    dot.add(visualDot);

    hr.add(dot);

    moduleMesh.userData.headrestDots.push(dot);
    headrestDots.push(dot);
  }
}

function computeBestHeadrestDeltaQuat(hr, baseQuat) {
  // zajisti bbox
  if (hr.geometry && !hr.geometry.boundingBox) hr.geometry.computeBoundingBox();

  const center = new THREE.Vector3(0, 0, 0);
  const size = new THREE.Vector3(0.1, 0.1, 0.1);

  if (hr.geometry && hr.geometry.boundingBox) {
    hr.geometry.boundingBox.getCenter(center);
    hr.geometry.boundingBox.getSize(size);
  }

  // testovacĂ­ bod "nahoĹ™e" na hlavovce v lokĂˇlu (abychom vidÄ›li, jestli jde dolĹŻ)
  const probeLocal = center.clone().add(new THREE.Vector3(0, size.y * 0.5, 0));

  // svÄ›tovĂˇ pozice probe bodu pĹ™ed rotacĂ­ (ignorujeme position, pro porovnĂˇnĂ­ staÄŤĂ­ orientace)
  const before = probeLocal.clone().applyQuaternion(baseQuat);

  const axes = [
    new THREE.Vector3(1, 0, 0), // local X
    new THREE.Vector3(0, 0, 1), // local Z
    new THREE.Vector3(0, 1, 0), // local Y (fallback)
  ];

  let bestDrop = -Infinity;
  let bestAxis = axes[0];
  let bestAngle = HEADREST_PITCH_X;

  for (const axis of axes) {
    for (const sign of [1, -1]) {
      const angle = HEADREST_PITCH_X * sign;
      const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);

      const afterQuat = baseQuat.clone().multiply(dq);
      const after = probeLocal.clone().applyQuaternion(afterQuat);

      // chceme, aby probe bod Ĺˇel co nejvĂ­c DOLĹ® => before.y - after.y co nejvÄ›tĹˇĂ­
      const drop = before.y - after.y;

      if (drop > bestDrop) {
        bestDrop = drop;
        bestAxis = axis;
        bestAngle = angle;
      }
    }
  }

  return new THREE.Quaternion().setFromAxisAngle(bestAxis, bestAngle);
}

// =======================
// MANCHESTER HEADREST ANIMATION
// - úplně oddělené od Manily
// - bez rotace
// - pouze lokace ve 2 etapách:
//   1) nahoru
//   2) dozadu
// =======================

// TADY LADÍŠ MANCHESTER RUČNĚ:
const MANCHESTER_HEADREST_MOVE_UP_Y = 0.18;     // 1. etapa: nahoru / dolů
const MANCHESTER_HEADREST_MOVE_BACK_Z = -0.165;  // 2. etapa: dozadu / dopředu
const MANCHESTER_HEADREST_ANIM_MS = 760;
const MANCHESTER_HEADREST_STAGE_SPLIT = 0.52;   // 0.52 = 52 % animace nahoru, 48 % dozadu

// Manchester headresty, které v GLB začínají už NAHOŘE.
//
// Všechny ostatní Manchester headresty bereme automaticky jako dole.
//
// Formát:
//   "manchester_<modul>::headrest_<mesh>"
//
// Tvoje zadání:
// Manchester_2:  headrest_p nahoře
// Manchester_2L: headrest_p nahoře
// Manchester_2P: headrest_l nahoře
// Manchester_2M: headrest_p nahoře
// Manchester_3:  headrest_s nahoře
// Manchester_3L: headrest_s nahoře
// Manchester_3P: headrest_s nahoře
// Manchester_3M: headrest_s nahoře
const MANCHESTER_HEADREST_STARTS_UP_BY_VARIANT = new Set([
  "manchester_2::headrest_p",
  "manchester_2l::headrest_p",
  "manchester_2p::headrest_l",
  "manchester_2m::headrest_p",

  "manchester_3::headrest_s",
  "manchester_3l::headrest_s",
  "manchester_3p::headrest_s",
  "manchester_3m::headrest_s",
]);

function isManchesterTranslateHeadrest(headrestMesh) {
  if (!headrestMesh) return false;

  const name = String(headrestMesh.name || "").toLowerCase();
  if (!name.startsWith("headrest_")) return false;

  const moduleRoot = getModuleRoot(headrestMesh);
  const variantId = String(
    moduleRoot?.userData?.variantId ||
    moduleRoot?.userData?.name ||
    moduleRoot?.name ||
    ""
  ).toLowerCase();

  // Jen Manchester headrest_...
  // Manila / Mendoza / Melbourne tímhle neprojdou.
  return variantId.startsWith("manchester_");
}

function getManchesterHeadrestMoveVectorUp() {
  return new THREE.Vector3(0, MANCHESTER_HEADREST_MOVE_UP_Y, 0);
}

function getManchesterHeadrestMoveVectorBack() {
  return new THREE.Vector3(0, 0, MANCHESTER_HEADREST_MOVE_BACK_Z);
}

function getManchesterHeadrestCleanName(headrestMesh) {
  const raw = String(headrestMesh?.name || "")
    .trim()
    .toLowerCase()
    .replace(/\.\d+$/, "");

  // Sjednocení:
  // headrest_l
  // headrest_l.001
  // headrest_l_extra
  // všechno bude brané jako headrest_l
  if (raw.startsWith("headrest_")) {
    const side = raw.slice("headrest_".length)[0];

    if (side === "l" || side === "p" || side === "s") {
      return `headrest_${side}`;
    }
  }

  return raw;
}

function getManchesterHeadrestVariantKey(headrestMesh) {
  const moduleRoot = getModuleRoot(headrestMesh);

  const raw = String(
    moduleRoot?.userData?.variantId ||
    moduleRoot?.userData?.name ||
    moduleRoot?.name ||
    ""
  ).trim().toLowerCase();

  // Z varianty vytáhneme jen Manchester modul:
  //
  // Manchester_2   -> manchester_2
  // Manchester_2L  -> manchester_2l
  // Manchester_2P  -> manchester_2p
  // Manchester_2M  -> manchester_2m
  // Manchester_3   -> manchester_3
  // Manchester_3L  -> manchester_3l
  // Manchester_3P  -> manchester_3p
  // Manchester_3M  -> manchester_3m
  //
  // Funguje i když by tam byl suffix, např. Manchester_2P_clone.
  const normalized = raw
    .replace(/^manchester[\s_-]*/i, "")
    .replace(/[^a-z0-9]/gi, "");

  const match = normalized.match(/^(\d+[lpm]?)/i);
  const moduleCode = match?.[1] || "";

  return moduleCode
    ? `manchester_${moduleCode.toLowerCase()}`
    : "";
}

function shouldManchesterHeadrestStartUp(headrestMesh) {
  const variantKey = getManchesterHeadrestVariantKey(headrestMesh);
  const headrestName = getManchesterHeadrestCleanName(headrestMesh);

  const exactKey = `${variantKey}::${headrestName}`;

  return MANCHESTER_HEADREST_STARTS_UP_BY_VARIANT.has(exactKey);
}

function initManchesterHeadrestStateIfNeeded(headrestMesh) {
  if (!headrestMesh) return;

  if (headrestMesh.userData._manchesterHeadrestStateInitialized) {
    return;
  }

  const currentPos = headrestMesh.position.clone();
  const startsUp = shouldManchesterHeadrestStartUp(headrestMesh);

  // Když headrest v modelu už začíná nahoře:
  // aktuální pozice = upPos.
  //
  // Potřebujeme dopočítat dolní base pozici:
  // base = current - UP - BACK
  //
  // Díky tomu první klik udělá opačnou animaci:
  // up -> mid -> base.
  let basePos = currentPos.clone();

  if (startsUp) {
    basePos
      .sub(getManchesterHeadrestMoveVectorUp())
      .sub(getManchesterHeadrestMoveVectorBack());
  }

  headrestMesh.userData._manchesterHeadrestBasePos = basePos;
  headrestMesh.userData._manchesterHeadrestIsUp = startsUp;
  headrestMesh.userData._manchesterHeadrestStateInitialized = true;
}

function getManchesterHeadrestBasePosition(headrestMesh) {
  initManchesterHeadrestStateIfNeeded(headrestMesh);
  return headrestMesh.userData._manchesterHeadrestBasePos.clone();
}

function getManchesterHeadrestMidPosition(headrestMesh) {
  const basePos = getManchesterHeadrestBasePosition(headrestMesh);

  // Mezipozice:
  // - při pohybu nahoru: base -> mid
  // - při pohybu dolů: up -> mid
  return basePos.clone().add(getManchesterHeadrestMoveVectorUp());
}

function getManchesterHeadrestUpPosition(headrestMesh) {
  const midPos = getManchesterHeadrestMidPosition(headrestMesh);

  // Finální horní pozice:
  // base -> nahoru -> dozadu
  return midPos.clone().add(getManchesterHeadrestMoveVectorBack());
}

function toggleManchesterHeadrestTranslateOnly(headrestMesh) {
  if (!headrestMesh) return;

  // DŮLEŽITÉ:
  // Nejdřív inicializujeme stav.
  // Tady se rozhodne, jestli mesh začíná nahoře nebo dole.
  initManchesterHeadrestStateIfNeeded(headrestMesh);

  const isUp = !!headrestMesh.userData._manchesterHeadrestIsUp;

  const basePos = getManchesterHeadrestBasePosition(headrestMesh);
  const midPos = getManchesterHeadrestMidPosition(headrestMesh);
  const upPos = getManchesterHeadrestUpPosition(headrestMesh);

  const fromPos = headrestMesh.position.clone();

  let toPos;

  if (isUp) {
    // OPAČNÁ ANIMACE DOLŮ:
    // 1) z horní pozice dopředu do mid
    // 2) z mid dolů do base
    toPos = basePos;
  } else {
    // ANIMACE NAHORU:
    // 1) z base nahoru do mid
    // 2) z mid dozadu do up
    toPos = upPos;
  }

  headrestMesh.userData._manchesterHeadrestIsUp = !isUp;

  headrestMesh.userData._manchesterHeadrestAnim = {
    kind: "manchesterTranslateOnly",
    goingUp: !isUp,
    fromPos,
    midPos,
    toPos,
    t0: performance.now(),
    dur: MANCHESTER_HEADREST_ANIM_MS,
    split: MANCHESTER_HEADREST_STAGE_SPLIT
  };
}

function toggleHeadrest(headrestMesh) {
  if (!headrestMesh) return;

  // âś… Mendoza: mĂ­sto animace pĹ™epĂ­nĂˇme dvojice backrest_1X <-> backrest_2X a zĂˇroveĹ Hinge_X
  // (Manila zĹŻstĂˇvĂˇ na animovanĂ˝ch backrest_2* hlavovkĂˇch beze zmÄ›ny)
  {
    const moduleRoot = getModuleRoot(headrestMesh);
    const vid = String(moduleRoot?.userData?.variantId || "").toLowerCase();

    // âś… Mendoza: najdi sprĂˇvnĂ˝ "root" (parent) kterĂ˝ se jmenuje backrest_1P/L/S nebo backrest_2P/L/S
    let obj = headrestMesh;
    let m = null;

    while (obj && obj !== moduleRoot && !m) {
      const nn = String(obj?.name || "").toLowerCase();
      m = nn.match(/^backrest_(1|2)([pls])(\.|_|$)/);
      obj = obj.parent;
    }

    // Mendoza / Melbourne: přepínání párů 1 <-> 2 bez animace
    if ((vid.startsWith("mendoza_") || vid.startsWith("melbourne_")) && m) {
      const cur = Number(m[1]);
      const k = m[2];
      const next = (cur === 1) ? 2 : 1;

      // uloĹľit stav (aby ho nepĹ™epsaly zmÄ›ny nohou/podruÄŤek/hinges)
      const stateKey = vid.startsWith("melbourne_")
        ? "_melbourneBackrestState"
        : "_mendozaBackrestState";
      moduleRoot.userData[stateKey] =
        moduleRoot.userData[stateKey] || { p: 1, l: 1, s: 1 };
      moduleRoot.userData[stateKey][k] = next;

      // pĹ™epnout viditelnosti (vÄŤetnÄ› suffixĹŻ .001 / _something)
      const setByBase = (baseLower, visible) => {
        moduleRoot.traverse((o) => {
          const on = (o?.name || "").toLowerCase();
          if (!on) return;
          if (on === baseLower || on.startsWith(baseLower + ".") || on.startsWith(baseLower + "_")) {
            o.visible = visible;
          }
        });
      };

      setByBase(`backrest_1${k}`, next === 1);
      setByBase(`backrest_2${k}`, next === 2);
      if (vid.startsWith("melbourne_")) {
        setByBase(`paspule_1${k}`, next === 1);
        setByBase(`paspule_2${k}`, next === 2);
      }
      setByBase(`hinge_${k}`, next === 2);

      setupHeadrestDotsForModule(moduleRoot);

      saveStateDebounced?.();
      return;
    }
  }

  // Manchester má vlastní animaci:
  // - bez pivot rotace
  // - bez quaternionu
  // - jen posun ve 2 etapách: nahoru, potom dozadu
  //
  // Manila tímhle neprojde, protože Manila headresty nejsou headrest_...
  // a zároveň nejsou v Manchester modulech.
  if (isManchesterTranslateHeadrest(headrestMesh)) {
    toggleManchesterHeadrestTranslateOnly(headrestMesh);
    saveStateDebounced?.();
    return;
  }

  const pivot = headrestMesh.userData._headrestPivot || ensureHeadrestPivot(headrestMesh);
  if (!pivot) return;

  const baseQuat = pivot.userData._headrestBaseQuat?.clone() ?? pivot.quaternion.clone();
  const basePos  = pivot.userData._headrestBasePos?.clone()  ?? pivot.position.clone();
  const isUp = !!pivot.userData._headrestIsUp;

  const fromQuat = pivot.quaternion.clone();
  const fromPos  = pivot.position.clone();

  let toQuat = baseQuat.clone();
  let toPos  = basePos.clone();

  if (!isUp) {
    const s = getHeadrestSettings(headrestMesh);

    const deltaQuat = new THREE.Quaternion().setFromAxisAngle(
      s.axis,
      +HEADREST_PITCH_X
    );

    if (pivot.userData._headrestUpPos && pivot.userData._headrestUpQuat) {
      // start-up hlavovky: "nahoru" = pĹ™esnÄ› uloĹľenĂ˝ load stav
      toQuat = pivot.userData._headrestUpQuat.clone();
      toPos  = pivot.userData._headrestUpPos.clone();
    } else {
      // bÄ›ĹľnĂ© hlavovky: base + rotace + posun
      toQuat = baseQuat.clone().multiply(deltaQuat);
      toPos = basePos.clone()
        .add(new THREE.Vector3(0, s.liftY, 0))
        .add(s.forwardAxis.clone().multiplyScalar(s.forwardZ));
    }
  }

  pivot.userData._headrestIsUp = !isUp;

  pivot.userData._headrestAnim = {
    fromQuat,
    toQuat,
    fromPos,
    toPos,
    t0: performance.now(),
    dur: HEADREST_ANIM_MS
  };
}

function updateHeadrestAnimations() {
  const now = performance.now();

  for (const dot of headrestDots) {
    const hr = dot?.userData?.headrestMesh;
    if (!hr) continue;

    // ==========================
    // Manchester: translate only
    // ==========================
    const manchesterAnim = hr.userData?._manchesterHeadrestAnim;

    if (manchesterAnim?.kind === "manchesterTranslateOnly") {
      const a = manchesterAnim;

      const t = Math.min(1, (now - a.t0) / a.dur);
      const split = Math.max(0.05, Math.min(0.95, Number(a.split) || 0.52));

      if (t < split) {
        // 1. etapa:
        // dole -> nahoru
        // nebo nahoře -> dopředu do mezipozice
        const localT = t / split;
        const k = localT * localT * (3 - 2 * localT);

        hr.position.lerpVectors(a.fromPos, a.midPos, k);
      } else {
        // 2. etapa:
        // mezipozice -> dozadu na kostru
        // nebo mezipozice -> dolů do base
        const localT = (t - split) / (1 - split);
        const k = localT * localT * (3 - 2 * localT);

        hr.position.lerpVectors(a.midPos, a.toPos, k);
      }

      if (t >= 1) {
        hr.position.copy(a.toPos);
        hr.userData._manchesterHeadrestAnim = null;
      }

      // Důležité:
      // Manchester nesmí pokračovat do původní pivot/quaternion animace.
      continue;
    }

    // ==========================
    // Původní animace:
    // Manila + ostatní pivot headresty
    // ==========================
    const pivot = hr?.userData?._headrestPivot;
    const a = pivot?.userData?._headrestAnim;
    if (!pivot || !a) continue;

    const t = Math.min(1, (now - a.t0) / a.dur);
    const k = t * t * (3 - 2 * t);

    pivot.quaternion.slerpQuaternions(a.fromQuat, a.toQuat, k);
    pivot.position.lerpVectors(a.fromPos, a.toPos, k);

    if (t >= 1) {
      pivot.quaternion.copy(a.toQuat);
      pivot.position.copy(a.toPos);
      pivot.userData._headrestAnim = null;
    }
  }
}

function applyHeadrestDotHover(dot) {
  if (!dot) return;
  const visual = dot.userData?.visualDot || dot; // kdyĹľ je to hitbox, zvedni vizuĂˇl
  visual.scale.set(0.043, 0.043, 1);
  if (visual.material) visual.material.opacity = 1.0;
}

function resetHeadrestDotHover(dot) {
  if (!dot) return;
  const visual = dot.userData?.visualDot || dot;
  visual.scale.set(0.035, 0.035, 1);
  if (visual.material) visual.material.opacity = 0.9;
}

function hideModuleMenu() {
  const menu = document.getElementById("moduleActionMenu");
  menu.classList.remove("visible");
  selectedModule = null;
}

function closeActionMenu() {
  if (!moduleActionMenu) return;
  if (moduleActionMenu.classList.contains("visible")) {
    moduleActionMenu.classList.remove("visible");
    selectedModule = null;
    document.getElementById("actionMenuBlocker")?.classList.remove("active");
  }
  clearHoverEffects();
  downCandidate = null; 
}

function positionModuleActionMenuAt(clientX, clientY) {
  if (!moduleActionMenu) return;

  // DŮLEŽITÉ:
  // Menu musí být počítané vůči viewportu, ne vůči žádnému parent elementu.
  // Tím se opraví posunutí menu mimo kurzor.
  moduleActionMenu.style.position = "fixed";
  moduleActionMenu.style.transform = "none";

  const offsetX = 10;
  const offsetY = 10;
  const pad = 8;

  let left = Number(clientX) + offsetX;
  let top = Number(clientY) + offsetY;

  // Nejdřív ho dočasně zobrazíme / nastavíme, aby šla změřit velikost.
  moduleActionMenu.classList.add("visible");
  moduleActionMenu.style.left = `${left}px`;
  moduleActionMenu.style.top = `${top}px`;

  const rect = moduleActionMenu.getBoundingClientRect();

  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }

  if (top + rect.height > window.innerHeight - pad) {
    top = window.innerHeight - rect.height - pad;
  }

  moduleActionMenu.style.left = `${Math.round(left)}px`;
  moduleActionMenu.style.top = `${Math.round(top)}px`;
}

function getVisibleRaycastMeshesFromRoot(root) {
  if (!root) return [];

  const out = [];
  root.traverse((obj) => {
    if (!obj?.isMesh) return;
    if (!obj.visible) return;

    let p = obj.parent;
    while (p) {
      if (p.visible === false) return;
      p = p.parent;
    }

    out.push(obj);
  });
  return out;
}
  
function onPointerDown(event) {

  const buildActive = isBuildStepActive();

  pointerIsDown = true;
  cameraMovedThisClick = false;
  controlsStartedThisClick = false;

  // kdyĹľ je otevĹ™enĂ© akÄŤnĂ­ menu, neĹ™eĹˇ klik do 3D
  if (moduleActionMenu?.classList.contains("visible")) {
    return;
  }

  // start drag detekce (jen levĂ© tlaÄŤĂ­tko)
  if (event.button === 0) {
    mouseDown = true;
    dragDistance = 0;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  }

  downCandidate = null;

  // kdyĹľ je otevĹ™enĂ˝ picker â†’ ignoruj kliky do 3D
  if (!document.getElementById("modulePicker").classList.contains("hidden")) {
    return;
  }

  // spoÄŤti myĹˇ vĹŻÄŤi canvasu
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  const headrestActive = isHeadrestStepActive(); // âś… krok 3

  const dotTargets = headrestActive ? headrestDots : []; // âś… jen krok 3

  const moduleTargets = buildActive ? activeModules.map((m) => m.mesh) : []; // âś… jen krok 2

  // ---------- FIX: vĹľdy posĂ­lej raycasteru PLOCHĂ‰ pole objektĹŻ ----------
  const targets = [];

  // krok 3: hotspoty (headrest/armrest)
  if (headrestActive) {
    for (const d of headrestDots) {
      if (d && d.visible) targets.push(d);
    }
  }

  // krok 2: build tlaÄŤĂ­tka + moduly
  if (buildActive) {
    if (startButton) targets.push(startButton);

    for (const b of activeButtons) {
      if (b?.mesh) targets.push(b.mesh);
    }

    for (const m of activeModules) {
      if (m?.mesh) targets.push(...getVisibleRaycastMeshesFromRoot(m.mesh));
    }
  }

  const visibleDotTargets = headrestDots.filter((d) => d && d.visible && d.parent);
  const dotHits = headrestActive ? raycaster.intersectObjects(visibleDotTargets, true) : [];
  if (dotHits.length > 0) {
    const hit = dotHits[0].object;
    const dotRoot = getHeadrestDotRoot(hit);
    if (dotRoot) {
      downCandidate = {
        type: "headrest",
        hit,
        root: dotRoot,
        headrest: dotRoot.userData.headrestMesh,
        clientX: event.clientX,
        clientY: event.clientY
      };
      return;
    }
  }

  const hits = raycaster.intersectObjects(targets, true);
  // ----------------------------------------------------------------------

  if (hits.length === 0) {
    downCandidate = null;
    return;
  }

  const hit = hits[0].object;

  // A) pokud je prvnĂ­ zĂˇsah BUTTON â†’ uloĹľit kandidĂˇta na "button click"
  const btnRoot = getButtonRoot(hit);
  const isKnownButton =
    btnRoot &&
    btnRoot.visible &&
    (btnRoot === startButton || activeButtons.some(b => b.mesh === btnRoot));

  if (isKnownButton) {
    downCandidate = {
      type: (startButton && btnRoot === startButton) ? "start" : "button",
      hit,
      root: btnRoot,
      clientX: event.clientX,
      clientY: event.clientY
    };
    return;
  }

  // B) pokud je prvnĂ­ zĂˇsah MODUL â†’ uloĹľit kandidĂˇta na "module click"
  const modRoot = getModuleRoot(hit);
  const isKnownModule = modRoot && activeModules.some(m => m.mesh === modRoot);

  if (isKnownModule) {
    downCandidate = {
      type: "module",
      hit,
      root: modRoot,
      clientX: event.clientX,
      clientY: event.clientY
    };
    return;
  }

  downCandidate = null;
  return;
}

function onPointerUp(event) {

  const buildActive = isBuildStepActive(); // krok 2 = stavba

  pointerIsDown = false;
  if (event.button === 0) mouseDown = false;

  if (downCandidate) {
    const dx = event.clientX - downCandidate.clientX;
    const dy = event.clientY - downCandidate.clientY;
    const dist = Math.hypot(dx, dy);

    if (dist > CLICK_MOVE_TOLERANCE) {
      downCandidate = null;
      return; // đź‘‰ byl to drag, ne click
    }
  }

  // âś… pokud se bÄ›hem tohohle kliku pohnula kamera, NIC nespouĹˇtÄ›j
  if (cameraMovedThisClick) {
    // đź‘‰ uĹľ jen reset flagu, ale NEblokuj click
    cameraMovedThisClick = false;
  }

  // pokud to byl drag nebo OrbitControls tĂˇhly â†’ nic nespouĹˇtÄ›t
  if (dragDistance > 20) { downCandidate = null; dragDistance = 0; return; }

  if (!downCandidate) { dragDistance = 0; return; }

  // pokud je otevĹ™enĂ˝ picker â†’ nic
  if (!document.getElementById("modulePicker").classList.contains("hidden")) {
    downCandidate = null;
    dragDistance = 0;
    return;
  }

  // âś… mimo krok 2 nedovol kliky na moduly / tlaÄŤĂ­tka
  if (!buildActive && downCandidate && (downCandidate.type === "module" || downCandidate.type === "button")) {
    downCandidate = null;
    return;
  }

  // ===== HEADREST TOGGLE =====
  if (downCandidate.type === "headrest") {
    toggleHeadrest(downCandidate.headrest);

    downCandidate = null;
    dragDistance = 0;
    return;
  }

  // ===== START BUTTON =====
  if (downCandidate.type === "start") {
    pendingAddPosition = startButton.position.clone();
    pendingAddButton = startButton;
    pendingAddDirection = null;
    pendingAddRotY = 0;
    pendingAddShift = null;
    pendingAddBaseModule = null;

    openModulePicker(startButton.position);
    downCandidate = null;
    dragDistance = 0;
    return;
  }

  // ===== ADD BUTTON =====
  if (downCandidate.type === "button") {
    const hit = downCandidate.hit;
    const btnRoot = downCandidate.root;

    const dir   = hit.userData.direction ?? btnRoot.userData?.direction ?? null;
    const rotY  = hit.userData.rotY ?? btnRoot.userData?.rotY ?? 0;
    const shift = hit.userData.shift ?? btnRoot.userData?.shift ?? null;

    pendingAddButton = btnRoot;
    pendingAddDirection = dir;
    pendingAddRotY = rotY;
    pendingAddShift = shift ? shift.clone() : null;

    const parentModule = hit.userData.parentModule ?? btnRoot.userData?.parentModule ?? null;
    pendingAddBaseModule = parentModule;

    openModulePicker(btnRoot.position);

    downCandidate = null;
    dragDistance = 0;
    return;
  }

  // ===== MODULE MENU =====
  if (downCandidate.type === "module") {
    selectedModule = downCandidate.root;

    // Menu zobrazíme podle aktuálního místa puštění myši.
    // Díky helperu se počítá vůči viewportu a nebude ujíždět.
    positionModuleActionMenuAt(event.clientX, event.clientY);

    const deleteBtn = document.querySelector(".module-action-btn.delete");
    const canDelete = isLeafModule(selectedModule);

    deleteBtn.classList.toggle("disabled", !canDelete);

    // ĹľĂˇdnĂˇ inline opacity! (jinak hover nikdy neprojde)
    deleteBtn.style.opacity = "";

    // klikatelnost + kurzor
    deleteBtn.style.pointerEvents = "auto";

    const replaceBtn = document.querySelector(".module-action-btn.replace");
    if (replaceBtn) {
      const rec = activeModules.find(m => m.mesh === selectedModule);
      const role = rec ? getRole(rec.name) : null;
      const isCorner = (role === "cornerL" || role === "cornerP");

      // kolik mĂˇ modul sousedĹŻ (napojenĂ˝ch modulĹŻ)
      const neighborSides = ["left", "right", "front", "back"].filter(
        s => rec?.connections?.[s]
      );
      const isBetweenTwoModules = neighborSides.length >= 2;

      // âś… roh zakĂˇzat jen kdyĹľ je mezi dvÄ›ma moduly
      const disableReplace = isCorner && isBetweenTwoModules;

      replaceBtn.classList.toggle("disabled", disableReplace);
      replaceBtn.style.opacity = "";

      // âś… nech pointerEvents zapnutĂ˝ vĹľdy, aĹĄ funguje hover + not-allowed kurzor
      replaceBtn.style.pointerEvents = "auto";
    }

    document.getElementById("actionMenuBlocker")?.classList.add("active");

    downCandidate = null;
    dragDistance = 0;
    controlsStartedThisClick = false;
    return;
  }

  downCandidate = null;
  dragDistance = 0;
}

function openModulePicker(worldPos) {
  pickerClosedManually = false;
  pendingAddPosition = worldPos.clone();

  // âś… kdyĹľ otevĂ­rĂˇm picker z "prĂˇzdnĂ© scĂ©ny" (start tlaÄŤĂ­tko),
  // nechci aby do toho kecal reĹľim "replace" nebo starĂ© pending hodnoty
  if (activeModules.length === 0) {
    replaceTarget = null;
    pendingAddBaseModule = null;
    pendingAddDirection = null;
  }

  // jistota: aĹĄ picker nikdy nenĂ­ pod blockerem/menu
  document.getElementById("actionMenuBlocker")?.classList.remove("active");
  moduleActionMenu?.classList.remove("visible");

  const picker = document.getElementById("modulePicker");
  picker.classList.remove("hidden");

  const list = document.getElementById("moduleList");
  list.innerHTML = "";

  // âś… zjisti base modul a smÄ›r (kdyĹľ klikneĹˇ na add button)
  let baseId = null;
  let baseSide = null;
  let replaceMiddleOnlyM = false;

  if (pendingAddBaseModule && pendingAddDirection) {
    const baseRec = activeModules.find(r => r.mesh === pendingAddBaseModule);
    baseId = baseRec?.name || null;           // âś… varianta
    baseSide = pendingAddDirection;           // left/right/front/back
  }

  // âś… reĹľim VYMÄšNIT: urÄŤi baseId/baseSide podle souseda vymÄ›ĹovanĂ©ho modulu
  // replaceTarget = mesh modulu, kterĂ˝ chceĹˇ vymÄ›nit
  if ((!baseId || !baseSide) && replaceTarget) {
    const oldRoot = getModuleRoot(replaceTarget); // âś… jistota: root
    const oldRec = activeModules.find(r => r.mesh === oldRoot);

    if (oldRec && oldRec.connections) {
      // zjisti, kolik mĂˇ oldRec sousedĹŻ (pĹ™ipojenĂ˝ch modulĹŻ)
      const neighborSides = ["left", "right", "front", "back"].filter(s => oldRec.connections[s]);

      // kdyĹľ je modul mezi dvÄ›ma moduly â†’ pĹ™i vĂ˝mÄ›nÄ› dovol jen "M" moduly
      const hasLeft  = neighborSides.includes("left");
      const hasRight = neighborSides.includes("right");
      const hasFront = neighborSides.includes("front");
      const hasBack  = neighborSides.includes("back");

      // "prostĹ™ednĂ­ modul" jen kdyĹľ je opravdu mezi dvÄ›ma moduly v pĹ™Ă­mce
      replaceMiddleOnlyM =
        (hasLeft && hasRight) ||
        (hasFront && hasBack);

      const pickNeighbor = () => {
        const candidates = [];

        for (const side of ["left", "right", "front", "back"]) {
          const nbMesh = oldRec.connections[side];
          if (!nbMesh) continue;

          const nbRoot = getModuleRoot(nbMesh);
          const nbRec = activeModules.find(r => r.mesh === nbRoot);
          if (!nbRec) continue;

          const role = getRole(nbRec.name);
          const isCorner = (role === "cornerL" || role === "cornerP");

          candidates.push({
            side,
            nbRec,
            nbRoot,
            isCorner
          });
        }

        if (candidates.length === 0) return null;

        // âś… HlavnĂ­ fix:
        // pĹ™i vĂ˝mÄ›nÄ› modulu nechceme jako hlavnĂ­ referenci roh,
        // protoĹľe roh si ÄŤasto drĹľĂ­ historickou orientaci pĹŻvodnĂ­ vÄ›tve
        // a novĂ˝ modul se pak otoÄŤĂ­ ĹˇpatnÄ›.
        const straightCandidate = candidates.find(c => !c.isCorner);
        if (straightCandidate) return straightCandidate;

        // roh aĹľ jako fallback
        return candidates[0];
      };

      const picked = pickNeighbor();
      if (picked) {
        // pro REPLACE picker chceme stranu z pohledu VYMÄšĹ‡OVANĂ‰HO slotu,
        // ne z pohledu souseda
        const sideOnNeighbor = getConnectionSide(picked.nbRec.mesh, oldRoot);

        baseId = picked.nbRec.name;

        // âś… PRO FILTER bereĹˇ stranu z pohledu BASE modulu (souseda),
        // ne z pohledu vymÄ›ĹovanĂ©ho slotu.
        // PĹŻvodnĂ­ "opposite" to prohazovalo vlevo/vpravo.
        baseSide = sideOnNeighbor || picked.side;
      }
    }
  }

  // ====== TABY + FILTRACE ======

  const tabsBar = document.querySelector("#modulePicker .picker-tabs");

  // ids, kterĂ© by Ĺˇly pĹ™ipojit na konkrĂ©tnĂ­ tlaÄŤĂ­tko (pokud existuje base)
  let attachableIds = (baseId && baseSide)
    ? filterVariantIdsForPicker({ baseId, baseSide, variantIds: moduleVariantIds })
    : [];

  // kdyĹľ vymÄ›Ĺuju prostĹ™ednĂ­ dĂ­l â†’ povol jen M moduly
  if (replaceTarget && replaceMiddleOnlyM) {
    // nechĂˇme jen roli M, a zĂˇroveĹ vyhodĂ­me rohy a SOLO
    // (rohy uprostĹ™ed nechceĹˇ)
    attachableIds = attachableIds.filter(id => getRole(id) === "M");
  }
  
  // freeMode = start reĹľim (ukĂˇzat celĂ˝ katalog)
  // speciĂˇlnÄ›: kdyĹľ dĂˇvĂˇm VYMÄšNIT a ve scĂ©nÄ› je jen 1 modul, chci vĹľdy celĂ˝ katalog
  const isSingleReplace = (replaceTarget && activeModules.length === 1);

  const freeMode =
    (
      (!baseId || !baseSide || attachableIds.length === 0) &&
      !(replaceTarget && replaceMiddleOnlyM)
    ) ||
    isSingleReplace;

  const btnSolo = document.querySelector('#modulePicker .picker-tabs button[data-tab="solo"]');
  if (btnSolo) btnSolo.style.display = freeMode ? "" : "none";

  // ukaĹľ/skrĂ˝j taby podle freeMode
  if (tabsBar) tabsBar.style.display = "";

  // ===== reĹľim: vĂ˝mÄ›na prostĹ™ednĂ­ho dĂ­lu -> ukaĹľ jen zĂˇloĹľku "VKLĂDACĂŤ" =====
  const btnAll = document.querySelector('#modulePicker .picker-tabs button[data-tab="all"]');
  const btnInsert = document.querySelector('#modulePicker .picker-tabs button[data-tab="insert"]');
  const btnEnd = document.querySelector('#modulePicker .picker-tabs button[data-tab="end"]');

  if (replaceTarget && replaceMiddleOnlyM) {
    if (btnAll) btnAll.style.display = "none";
    if (btnEnd) btnEnd.style.display = "none";
    if (btnInsert) btnInsert.style.display = "";
  } else {
    if (btnAll) btnAll.style.display = "";
    if (btnEnd) btnEnd.style.display = "";
    if (btnInsert) btnInsert.style.display = ""; // âś… vraĹĄ i insert
  }
  
  // helper: podle tabu vyfiltruj ids
  function filterIdsByTab(tab, idsIn) {
    if (tab === "all") return idsIn;

    return idsIn.filter((id) => {
      const role = getRole(id);

      if (tab === "insert") return role === "M" || role === "cornerP" || role === "cornerL";
      if (tab === "end")    return role === "L" || role === "P"; // UKONÄŚOVACĂŤ = L + P
      if (tab === "solo")   return role === "SOLO";              // SAMOSTATNĂ‰ = SOLO
      return true;
    });
  }

  function getModulePickerDepthNoteCm() {
    const sofaKey = String(
      normalizeSofaKey(appState.model) ||
      appState.model ||
      ""
    ).trim().toUpperCase();

    // TADY nastavíš číslo podle dané pohovky.
    // Hodnota je hloubka rohového modulu / rohu, která se má ukázat ve větě nad taby.
    const depthBySofa = {
      MANILA: 103,
      MENDOZA: 102,
      MELBOURNE: 107,
      MANCHESTER: 100,
    };

    return depthBySofa[sofaKey] || 102;
  }

  function getModulePickerNoteText() {
    return `Šířku modulů lze nastavit. Hloubka modulů je ${getModulePickerDepthNoteCm()} cm.`;
  }

  // helper: vykresli grid pro danĂ© ids
  function renderPickerList(idsToRender) {
    list.innerHTML = "";

    idsToRender.forEach((variantId) => {
      const c = getCatalog(variantId);
      if (!c) return;

      const div = document.createElement("div");
      div.className = "moduleItem";

      const priceFrom = getModulePrice(variantId, "g1", null);

      // vytvoĹ™ img element zvlĂˇĹˇĹĄ, aĹĄ mu pak mĹŻĹľeme zmÄ›nit src
      const img = document.createElement("img");
      img.alt = c.label;

      // tady se napojĂ­ auto-render thumbnail
      attachThumbToImg(variantId, img);

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = c.label;

      const price = document.createElement("div");
      price.className = "price";
      renderPriceWithDiscount(price, priceFrom);

      const dims = document.createElement("div");
      dims.className = "dims";

      // ĹˇĂ­Ĺ™ka = rozsah (base/X uĹľ je vyĹ™eĹˇenĂ˝ v catalogue.js pĹ™es seatWidthRangeCm)
      const r = c.seatWidthRangeCm;      // { min, max }
      const depth = Number(c.dimsCm?.d); // hloubka (vÄ›tĹˇinou 102)

      const minW = Number(r?.min);
      const maxW = Number(r?.max);

      const hasRange = Number.isFinite(minW) && Number.isFinite(maxW) && minW > 0 && maxW > 0;
      const isFixed = hasRange && minW === maxW;

      // napĹ™. "75â€“100" nebo "102"
      const wText = hasRange
        ? (isFixed ? `${minW}` : `${minW}–${maxW}`)
        : (c.dimsCm?.w != null ? String(c.dimsCm.w) : "");

      // popisek: rohy (a cokoliv s min=max) = pevnĂˇ ĹˇĂ­Ĺ™ka, ostatnĂ­ = nastavitelnĂˇ
      const prefix = isFixed ? "Šířka" : "Šířka";

      // âś… krĂˇtkĂ˝ popisek na kartÄ›
      const dr = c.depthRangeCm; // {min,max} nebo undefined
      const dMin = Number(dr?.min);
      const dMax = Number(dr?.max);
      const hasDepthRange =
        Number.isFinite(dMin) && Number.isFinite(dMax) && dMin > 0 && dMax > 0 && dMin !== dMax;

      if (hasDepthRange) {
        // 1D: Ĺ : 75â€“100, H: 150â€“200 cm
        dims.textContent = `Š: ${wText}, H: ${dMin}–${dMax} cm`;
      } else if (Number.isFinite(depth) && depth !== 102) {
        // ostatnĂ­ (kdyĹľ mĂˇ smysl ukĂˇzat jinou hloubku neĹľ 102)
        dims.textContent = `Š: ${wText} × ${depth} cm`;
      } else {
        // default
        dims.textContent = `Š: ${wText} cm`;
      }

      div.appendChild(img);
      div.appendChild(title);
      div.appendChild(price);
      div.appendChild(dims);

      div.onclick = () => {
        const cat = getCatalog?.(variantId);
        if (cat?.model) {
          enqueuePriorityJob(() => prefetchModelGLB(cat.model));
        }
        chooseModule(variantId);
      };

      list.appendChild(div);
    });
  }

  // zdroj dat pro taby: buÄŹ celĂ˝ katalog, nebo jen pĹ™ipojitelnĂ© vÄ›ci
  // âś… StriktnÄ› oddÄ›lit Manila vs Mendoza (ĹľĂˇdnĂ© mĂ­chĂˇnĂ­)
  const sofaKey = normalizeSofaKey(appState.model) || "MANILA";

  // âś… seznam variant pro danĂ˝ model bereme z catalogue.js (nejspolehlivÄ›jĹˇĂ­)
  const allIdsForSofa = (typeof getVariantIdsForSofa === "function")
    ? (getVariantIdsForSofa(sofaKey) || [])
    : []; // kdyby nĂˇhodou funkce nebyla

  const allowedSet = new Set(allIdsForSofa);

  // freeMode (start) = jen moduly pro danĂ˝ model
  // napojovĂˇnĂ­/vĂ˝mÄ›na = jen pĹ™ipojitelnĂ©, ale taky jen pro danĂ˝ model (prĹŻnik)
  let sourceIds = freeMode
    ? allIdsForSofa.slice()
    : (attachableIds || []).filter((id) => allowedSet.has(id));

  // âť—ď¸ŹĹ˝ĂˇdnĂ˝ fallback na celĂ˝ katalog â€“ radĹˇi ukĂˇzat prĂˇzdno neĹľ mĂ­chat Manila/Mendoza
  if (!sourceIds || sourceIds.length === 0) {
    console.warn("Picker: pro tento model není žádný povolený modul");
    list.innerHTML = `<div class="picker-empty">Pro tento model není žádný povolený modul.</div>`;
    return;
  }

  // kdyĹľ vymÄ›Ĺuju prostĹ™ednĂ­ dĂ­l, chci jen zĂˇloĹľku "VKLĂDACĂŤ"
  const middleReplaceOnlyInsert = (replaceTarget && replaceMiddleOnlyM);

  // nastav default tab
  const buttons = document.querySelectorAll("#modulePicker .picker-tabs button");
  const defaultTab = middleReplaceOnlyInsert ? "insert" : "all";

  buttons.forEach((b) => b.classList.remove("active"));
  const defaultBtn = document.querySelector(`#modulePicker .picker-tabs button[data-tab="${defaultTab}"]`);
  if (defaultBtn) defaultBtn.classList.add("active");

  // INFO: poznĂˇmka pod titulkem "Vyberte dĂ­l"
  {
    const picker = document.getElementById("modulePicker");
    const tabsBar = picker?.querySelector(".picker-tabs");
    if (picker && tabsBar) {
      let note = picker.querySelector("#modulePickerNote");
      if (!note) {
        note = document.createElement("div");
        note.id = "modulePickerNote";
        note.className = "pickerNote";
        // vloĹľ nad taby
        tabsBar.parentNode.insertBefore(note, tabsBar);
      }

      note.textContent = getModulePickerNoteText();
    }
  }

  // âś… PREFETCH â€“ co se mĂˇ hned ukĂˇzat v default tabu
  const firstIds = filterIdsByTab(defaultTab, sourceIds);
  prefetchFirstModels(firstIds);

  // prvnĂ­ render
  renderPickerList(firstIds);

  // klikĂˇnĂ­ na taby
  buttons.forEach((btn) => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;

      if (!freeMode && tab === "solo") return;
      if (middleReplaceOnlyInsert && tab !== "insert") return;

      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const ids = filterIdsByTab(tab, sourceIds);

      // âś… DOPLNIT: prefetch pro prĂˇvÄ› zobrazenĂ© vÄ›ci
      prefetchFirstModels(ids);

      renderPickerList(ids);
    };
  });
}

function pickAnchorRecord() {
  if (anchorMesh) {
    const r = activeModules.find(m => m.mesh === anchorMesh);
    if (r) return r;
  }
  return activeModules[0] || null;
}

function relayoutFromAnchor() {
  const anchor = pickAnchorRecord();
  if (!anchor) return;

  const visited = new Set();
  const queue = [anchor];
  visited.add(anchor.mesh);

  while (queue.length) {
    const cur = queue.shift();

    for (const dir of ["left", "right", "front", "back"]) {
      const nbMesh = cur.connections[dir];
      if (!nbMesh) continue;

      const nb = activeModules.find(m => m.mesh === nbMesh);
      if (!nb) continue;

      if (!visited.has(nb.mesh)) {
        snapModules(cur, nb, dir);
        repositionButtonsForModule(nb);
        visited.add(nb.mesh);
        queue.push(nb);
      }
    }
  }
}

function isLeafModule(mesh) {
  const rec = activeModules.find(m => m.mesh === mesh);
  if (!rec) return false;

  let degree = 0;
  for (const side of ["left", "right", "front", "back"]) {
    if (rec.connections?.[side]) degree++;
  }
  return degree <= 1; // leaf = 0 nebo 1 spoj
}

function getConnectionSide(baseMesh, otherMesh) {
  // âś… smÄ›r urÄŤujeme podle stĹ™edĹŻ "sedĂˇkovĂ˝ch" boxĹŻ, ne podle pivotĹŻ
  const baseBox  = getSnapBox(baseMesh);
  const otherBox = getSnapBox(otherMesh);

  const baseCenter  = new THREE.Vector3();
  const otherCenter = new THREE.Vector3();
  baseBox.getCenter(baseCenter);
  otherBox.getCenter(otherCenter);

  const v = otherCenter.sub(baseCenter); // vektor od base -> other ve world

  // lokĂˇlnĂ­ osy base ve world
  const baseRight   = new THREE.Vector3(1, 0, 0).applyQuaternion(baseMesh.quaternion).normalize();
  const baseForward = new THREE.Vector3(0, 0, 1).applyQuaternion(baseMesh.quaternion).normalize();

  const dx = v.dot(baseRight);
  const dz = v.dot(baseForward);

  if (Math.abs(dx) >= Math.abs(dz)) {
    return dx >= 0 ? "right" : "left";
  }
  return dz >= 0 ? "front" : "back";
}

function localDirVector(dir) {
  switch (dir) {
    case "right": return new THREE.Vector3(1, 0, 0);
    case "left":  return new THREE.Vector3(-1, 0, 0);
    case "front": return new THREE.Vector3(0, 0, 1);
    case "back":  return new THREE.Vector3(0, 0, -1);
    default:      return new THREE.Vector3(0, 0, 0);
  }
}

// pĹ™evede direction tlaÄŤĂ­tka ("right/left/front/back") z LOKĂLU modulu do SVÄšTA
function dirFromModuleToWorld(moduleMesh, dir) {
  const v = localDirVector(dir).applyQuaternion(moduleMesh.quaternion);

  // vybereme dominantnĂ­ osu ve svÄ›tÄ› (X nebo Z)
  if (Math.abs(v.x) >= Math.abs(v.z)) {
    return v.x >= 0 ? "right" : "left";
  } else {
    return v.z >= 0 ? "front" : "back";
  }
}

// =======================
// ORIENTATION HELPERS
// =======================

// vrĂˇtĂ­ hlavnĂ­ "orientation" celĂ© sedaÄŤky podle prvnĂ­ho modulu
function getSofaOrientation() {
  if (!activeModules?.length) return "front";

  const root = getModuleRoot(activeModules[0].mesh);
  if (!root) return "front";

  // world direction kam mĂ­Ĺ™Ă­ "front" modulu
  const frontDir = new THREE.Vector3(0, 0, -1).applyQuaternion(root.quaternion);

  const x = frontDir.x;
  const z = frontDir.z;

  if (Math.abs(z) > Math.abs(x)) {
    return z < 0 ? "front" : "back";
  } else {
    return x > 0 ? "right" : "left";
  }
}

// mapovĂˇnĂ­ world â†’ lokĂˇlnĂ­ osy sedaÄŤky
function mapWorldToSofaAxes(worldX, worldZ) {
  const o = getSofaOrientation();

  switch (o) {
    case "front":
      return { width: worldX, depth: worldZ };

    case "back":
      return { width: -worldX, depth: -worldZ };

    case "right":
      return { width: worldZ, depth: -worldX };

    case "left":
      return { width: -worldZ, depth: worldX };

    default:
      return { width: worldX, depth: worldZ };
  }
}

function recomputeCameraFit() {
  // vezmi jen aktuĂˇlnĂ­ moduly ve scĂ©nÄ›
  const meshes = activeModules.map(r => r.mesh).filter(Boolean);

  // 0 modulĹŻ => nĂˇvrat na default (a zruĹˇ pin, aby 1. modul mÄ›l zase â€śhezkĂ˝â€ť pohled)
  if (meshes.length === 0) {
    camGoalTarget.copy(DEFAULT_TARGET);
    camGoalPos.copy(DEFAULT_CAM_POS);

    cameraPinned = false;
    userViewDir = null;

    autoCamActive = true;
    return;
  }

  // bbox celĂ© sestavy
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);

  const size = new THREE.Vector3();
  box.getSize(size);

  const center = new THREE.Vector3();
  box.getCenter(center);

  // target dĂˇme na stĹ™ed sestavy (trochu vĂ˝Ĺˇ, aby byla vĂ­c â€śv zĂˇbÄ›ruâ€ť)
  // target dĂˇme na stĹ™ed sestavy (trochu vĂ˝Ĺˇ dle chuti)
  camGoalTarget.copy(center);
  camGoalTarget.y += CAMERA_FIT_TARGET_Y;

  // --- vzdĂˇlenost podle velikosti ---
  const maxDim = Math.max(size.x, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitDist = (maxDim / (2 * Math.tan(fov / 2))) * CAMERA_FIT_PADDING;

  const MIN_FIT_DIST = 2.6;   // zkus 2.4â€“3.2 podle chuti
  const MAX_FIT_DIST = 12;    // volitelnĂ©
  const fitDistClamped = THREE.MathUtils.clamp(fitDist, MIN_FIT_DIST, MAX_FIT_DIST);

  // --- smÄ›r (dir) ---
  // 1) prvnĂ­ modul = pouĹľij fixnĂ­ hezkĂ˝ smÄ›r (FIRST_MODULE_DIR)
  // 2) dalĹˇĂ­ add/remove = drĹľ aktuĂˇlnĂ­ smÄ›r uĹľivatelskĂ© kamery (aĹĄ to nerotuje)
  let dir;

  if (!cameraPinned) {
    dir = FIRST_MODULE_DIR.clone().normalize();
    cameraPinned = true;
  } else {
    dir = camera.position.clone().sub(controls.target).normalize();
    if (dir.lengthSq() < 1e-6) dir = FIRST_MODULE_DIR.clone().normalize();
  }

  // nastav pozici jen zmÄ›nou vzdĂˇlenosti po tom smÄ›ru
  camGoalPos.copy(camGoalTarget).add(dir.multiplyScalar(fitDistClamped));

  // pojistky aĹĄ nejde moc blĂ­zko / daleko
  camGoalPos.y = Math.max(camGoalPos.y, 0.6);

  autoCamActive = true;
}

// schovej tlaÄŤĂ­tko pro danĂ˝ modul a stranu i kdyĹľ nesedĂ­ record.buttons
function forceHideButtonFor(moduleMesh, side) {
  // 1) pokud existuje v record.buttons
  const rec = activeModules.find(m => m.mesh === moduleMesh);
  const btn = rec?.buttons?.[side];
  if (btn) btn.visible = false;

  // 2) jistota pĹ™es activeButtons
  for (const b of activeButtons) {
    if (b.parentModule === moduleMesh && b.direction === side) {
      b.mesh.visible = false;
    }
  }
}

function consumeAddButton(clickedButton) {
  if (!clickedButton) return;

  scene.remove(clickedButton);

  // odstranit z activeButtons
  for (let i = activeButtons.length - 1; i >= 0; i--) {
    if (activeButtons[i].mesh === clickedButton) {
      activeButtons.splice(i, 1);
      break;
    }
  }

  // odstranit z record.buttons
  const parent = clickedButton.userData?.parentModule;
  const dir = clickedButton.userData?.direction;
  if (parent && dir) {
    const rec = activeModules.find((m) => m.mesh === parent);
    if (rec && rec.buttons?.[dir] === clickedButton) {
      delete rec.buttons[dir];
    }
  }
}

function showPlacementMessage(text, ms = 5000) {
  const el = document.getElementById("placementToast");

  // fallback, kdyby toast element neexistoval
  if (!el) {
    console.warn("Missing #placementToast element");
    alert(text);
    return;
  }

  el.textContent = text;
  el.classList.add("show");

  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function rollbackNewModule(newModule) {

  removeHeadrestDotsForModule(newModule);

  // najdi record toho novĂ©ho modulu
  const recIdx = activeModules.findIndex(r => r.mesh === newModule);
  const rec = recIdx !== -1 ? activeModules[recIdx] : null;

  // 1) odeber tlaÄŤĂ­tka uloĹľenĂˇ v record.buttons
  if (rec?.buttons) {
    for (const k of Object.keys(rec.buttons)) {
      scene.remove(rec.buttons[k]);
    }
  }

  // 2) odeber tlaÄŤĂ­tka z activeButtons, kterĂˇ patĹ™Ă­ tomu modulu
  for (let i = activeButtons.length - 1; i >= 0; i--) {
    if (activeButtons[i].parentModule === newModule) {
      scene.remove(activeButtons[i].mesh);
      activeButtons.splice(i, 1);
    }
  }

  // 3) odeber samotnĂ˝ modul ze scĂ©ny
  scene.remove(newModule);

  // 4) odeber record z activeModules
  if (recIdx !== -1) {
    activeModules.splice(recIdx, 1);
  }
}

function removeModuleCompletely(moduleMesh) {

  removeHeadrestDotsForModule(moduleMesh);

  // 1) odstranit tlaÄŤĂ­tka z record.buttons
  const rec = activeModules.find(r => r.mesh === moduleMesh);
  if (rec?.buttons) {
    for (const k of Object.keys(rec.buttons)) {
      if (rec.buttons[k]) scene.remove(rec.buttons[k]);
    }
  }

  // 2) odstranit tlaÄŤĂ­tka z activeButtons pole
  for (let i = activeButtons.length - 1; i >= 0; i--) {
    if (activeButtons[i].parentModule === moduleMesh) {
      scene.remove(activeButtons[i].mesh);
      activeButtons.splice(i, 1);
    }
  }

  // 3) odstranit samotnĂ˝ modul (pro jistotu odeber root)
  const root = getModuleRoot(moduleMesh);
  root.traverse((o) => {
    // kdyĹľ mĂˇĹˇ geometrii/materiĂˇly, je OK je nedisposovat (protoĹľe je to clone)
    // ale kdyĹľ chceĹˇ, mĹŻĹľeĹˇ sem pozdÄ›ji pĹ™idat dispose.
  });
  scene.remove(root);
}

function scheduleSummaryRecalc() {

  // kontrola, Ĺľe funkce existuje
  debugLog("typeof updateSummaryUI =", typeof updateSummaryUI);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        debugLog("CALL updateSummaryUI()");
        updateSummaryUI();

        if (typeof window.__refreshSofaDimsBranchesUI === "function") {
          window.__refreshSofaDimsBranchesUI();
        }

        updateStep2ContinueUI();
        updateStep3ContinueUI();
        updateStep4ContinueUI();
        syncMelbourneShelfTabVisibility();
        if (appState.step === 5) {
          renderRecapView();
        }
        debugLog("DONE updateSummaryUI()");
      } catch (e) {
        console.error("updateSummaryUI crashed:", e);
      }
    });
  });
}

function cleanupOrphanModulesFromScene() {
  // povolenĂ© (sprĂˇvnĂ©) root meshe modulĹŻ podle activeModules
  const allowed = new Set(activeModules.map(r => getModuleRoot(r.mesh)));

  // najdi vĹˇechny root objekty ve scĂ©nÄ›, kterĂ© majĂ­ userData.isModule
  const toRemove = [];
  for (const child of scene.children) {
    if (child?.userData?.isModule) {
      const root = getModuleRoot(child);
      if (!allowed.has(root)) {
        toRemove.push(root);
      }
    }
  }

  // odeber duplicitnĂ­ / osiĹ™elĂ©
  for (const obj of toRemove) {
    scene.remove(obj);
  }
}

function purgeModuleRecords(removedMesh = null) {
  // odstranĂ­ recordy:
  // - kterĂ© ukazujĂ­ na removedMesh
  // - jejich mesh uĹľ nenĂ­ ve scĂ©nÄ› (nemĂˇ parent)
  // - duplicity (stejnĂ˝ mesh ve vĂ­ce recordech)

  // 1) vyhoÄŹ obvious ĹˇpatnĂ©
  for (let i = activeModules.length - 1; i >= 0; i--) {
    const m = activeModules[i];
    if (!m?.mesh) { activeModules.splice(i, 1); continue; }
    if (removedMesh && m.mesh === removedMesh) { activeModules.splice(i, 1); continue; }
    if (!m.mesh.parent) { activeModules.splice(i, 1); continue; } // uĹľ nenĂ­ ve scĂ©nÄ›
  }

  // 2) vyhoÄŹ duplicity (ponechĂˇme prvnĂ­ vĂ˝skyt meshe)
  const seen = new Set();
  for (let i = activeModules.length - 1; i >= 0; i--) {
    const mesh = activeModules[i].mesh;
    if (seen.has(mesh)) {
      activeModules.splice(i, 1);
    } else {
      seen.add(mesh);
    }
  }
}

function transferConnections(oldMesh, newMesh) {
  const oldRec = activeModules.find(m => m.mesh === oldMesh);
  const newRec = activeModules.find(m => m.mesh === newMesh);
  if (!oldRec || !newRec) return;

  // 1) pĹ™enes connection mapu ze starĂ©ho na novĂ˝ record
  newRec.connections = { ...oldRec.connections };

  // 2) u sousedĹŻ pĹ™epiĹˇ jejich odkaz ze starĂ©ho meshe na novĂ˝ mesh
  for (const side of ["left", "right", "front", "back"]) {
    const nbMesh = oldRec.connections[side];
    if (!nbMesh) continue;

    const nbRec = activeModules.find(m => m.mesh === nbMesh);
    if (!nbRec) continue;

    const nbSide = getConnectionSide(nbRec.mesh, oldRec.mesh);
    nbRec.connections[nbSide] = newMesh;
  }
}

function sweepOrphanModuleRoots() {
  // povolenĂ© rooty podle activeModules
  const allowed = new Set(activeModules.map(r => getModuleRoot(r.mesh)));

  // vĹˇe ve scĂ©nÄ›, co vypadĂˇ jako modul-root, ale nenĂ­ povolenĂ©, pryÄŤ
  const toRemove = [];
  for (const child of scene.children) {
    if (child?.userData?.isModule) {
      const root = getModuleRoot(child);
      if (!allowed.has(root)) toRemove.push(root);
    }
  }

  // odebrat unikĂˇtnÄ›
  const uniq = Array.from(new Set(toRemove));
  uniq.forEach(o => scene.remove(o));
}

async function chooseModule(name) {

  // name = VARIANTA (napĹ™. Manila_2XM)
  const variantId = name;
  const cat = getCatalog(variantId);
  if (!cat) {
    console.warn("Chybí katalog pro", variantId);
    return;
  }

  // modelName = reĂˇlnĂ˝ GLB (napĹ™. Manila_2M)
  const modelName = cat.model;

  const connectDirection = pendingAddDirection;
  const connectRotY = pendingAddRotY || 0;
  const clickedButton = pendingAddButton;
  let connectShift = pendingAddShift ? pendingAddShift.clone() : null;

  // âś… pokud tlaÄŤĂ­tko (napĹ™. roh/front) mĂˇ shiftByModule,
  // tak vyber shift podle vybranĂ©ho modulu "name"
  if (clickedButton) {
    const map = clickedButton.userData?.shiftByModule || null;
    if (map && map[name]) {
      connectShift = map[name].clone();
    }
  }
  // base modul bereme z tlaÄŤĂ­tka (pokud existuje)
  const connectBaseModule = pendingAddBaseModule || clickedButton?.userData?.parentModule || null;

  // ------------------------------------------------
  // (1) REPLACE MODULU
  // ------------------------------------------------
  if (replaceTarget) {
    // âś… vĹľdycky pĹ™epni na ROOT
    const oldRoot = getModuleRoot(replaceTarget);

    // âś… record musĂ­ sedÄ›t na root
    const oldRec = activeModules.find(m => m.mesh === oldRoot);
    if (!oldRec) {
      console.warn("REPLACE: nenaĹˇel jsem record pro oldRoot", oldRoot);
      return;
    }

    // uloĹľit transform
    const samePos = oldRoot.position.clone();
    const sameQuat = oldRoot.quaternion.clone();

    // FIX:
    // kdyĹľ nahrazuju roh, kterĂ˝ mĂˇ JEN jedno front spojenĂ­,
    // smaĹľu roh a novĂ˝ modul vloĹľĂ­m pĹ™Ă­mo na sprĂˇvnou stranu souseda
    // pĹ™es addVariantAttached(...), ne pĹ™es UI tlaÄŤĂ­tko.
    let replaceFrontOnlyCornerViaAttach = null;

    {
      const oldRole = getRole(oldRec.name);
      const oldIsCorner = (oldRole === "cornerL" || oldRole === "cornerP");

      if (oldIsCorner) {
        const hasLeft  = !!oldRec.connections?.left;
        const hasRight = !!oldRec.connections?.right;
        const hasBack  = !!oldRec.connections?.back;
        const hasFront = !!oldRec.connections?.front;

        const onlyFrontConnection =
          hasFront && !hasLeft && !hasRight && !hasBack;

        if (onlyFrontConnection) {
          const frontNeighborMesh = oldRec.connections.front;
          const frontNeighborRec = activeModules.find(m => m.mesh === frontNeighborMesh);

          if (frontNeighborRec?.mesh) {
            const neighborSide = getConnectionSide(frontNeighborRec.mesh, oldRoot);

            if (neighborSide) {
              replaceFrontOnlyCornerViaAttach = {
                neighborMesh: frontNeighborRec.mesh,
                neighborSide
              };
            }
          }
        }
      }
    }

    // âś… 1) starĂ˝ modul jen doÄŤasnÄ› schovej (NEODEBĂŤRAT ze scĂ©ny hned)
    const oldName = oldRec.name;
    const oldModel = oldRec.model; 
    oldRoot.visible = false;

    // SPECIĂLNĂŤ REPLACE FLOW:
    // roh s jedinĂ˝m front sousedem nahradĂ­me tak,
    // Ĺľe roh smaĹľeme a novĂ˝ modul pĹ™idĂˇme pĹ™Ă­mo na sprĂˇvnou stranu souseda.
    if (replaceFrontOnlyCornerViaAttach?.neighborMesh && replaceFrontOnlyCornerViaAttach?.neighborSide) {
      const baseMesh = replaceFrontOnlyCornerViaAttach.neighborMesh;
      const side = replaceFrontOnlyCornerViaAttach.neighborSide;

      // vrĂˇtit viditelnost, protoĹľe ho teÄŹ smaĹľeme normĂˇlnÄ›
      oldRoot.visible = true;

      removeModuleCompletely(oldRoot);

      const oldIdx = activeModules.indexOf(oldRec);
      if (oldIdx !== -1) activeModules.splice(oldIdx, 1);

      relayoutFromAnchor();

      // dĹŻleĹľitĂ©: dalĹˇĂ­ chooseModule uĹľ NESMĂŤ jet jako replace
      replaceTarget = null;

      await addVariantAttached(name, baseMesh, side);
      closePicker();
      return;
    }

    // schovej i jeho tlaÄŤĂ­tka (jsou samostatnÄ› ve scĂ©nÄ›)
    if (oldRec.buttons) {
      for (const k of Object.keys(oldRec.buttons)) {
        if (oldRec.buttons[k]) oldRec.buttons[k].visible = false;
      }
    }

    // âś… 3) vytvoĹ™it novĂ˝ mesh (STEJNÄš jako addModule â†’ z cache)
    const cat = getCatalog(name);          // name = variantId
    if (!cat) return;

    const url = modelGlbUrl(cat.model);
    const gltf = await loadGLBCached(url);

    // vĹľdy klon
    const newMesh = gltf.scene.clone(true);

    // âś… materiĂˇly stejnÄ› jako addModule
    applyDefaultMaterials(newMesh);

    newMesh.position.copy(samePos);

    // vĂ˝chozĂ­ chovĂˇnĂ­ = pĹ™evzĂ­t rotaci starĂ©ho modulu
    newMesh.quaternion.copy(sameQuat);

    // nohy podle vĂ˝bÄ›ru
    forceLegsOnly(newMesh, selectedLegs);

    forceArmrestsOnly(newMesh, selectedArmrests || "smooth");

    newMesh.userData.isModule = true;
    newMesh.userData.moduleName = cat.model;
    newMesh.name = "Module";

    newMesh.updateMatrixWorld(true);
    scene.add(newMesh);

    // âś… DĹ®LEĹ˝ITĂ‰: uloĹľit variantu a vytvoĹ™it hotspoty na hlavovĂ˝ch opÄ›rkĂˇch
    newMesh.userData.variantId = (name ?? "").trim();
    setupHeadrestDotsForModule(newMesh);

    // âś… 4) pĹ™esmÄ›rovat sousedy ze starĂ©ho na novĂ˝ (+ uloĹľit pro rollback)
    const redirectLinks = []; // { nbRec, nbSide }
    for (const side of ["left", "right", "front", "back"]) {
      const nbMesh = oldRec.connections?.[side];
      if (!nbMesh) continue;

      const nbRec = activeModules.find(m => m.mesh === nbMesh);
      if (!nbRec) continue;

      const nbSide = getConnectionSide(nbRec.mesh, oldRoot);
      if (nbSide) {
        redirectLinks.push({ nbRec, nbSide });
        nbRec.connections[nbSide] = newMesh;
      }
    }

    // âś… 5) aktualizuj record (ponechĂˇvĂˇĹˇ connections)
    oldRec.mesh = newMesh;
    oldRec.name = name;
    oldRec.model = cat.model;

    // âś… 6) layout + tlaÄŤĂ­tka
    // chceme hlĂ­dat jen NOVÄš vzniklĂ© kolize s NE-sousedy
    const beforePairs = getNonNeighborCollisionPairs({ strictEps: 0.002 });

    relayoutFromAnchor();

    const afterPairs = getNonNeighborCollisionPairs({ strictEps: 0.002 });

    // najdi kolize, kterĂ© vznikly NOVÄš po vĂ˝mÄ›nÄ›
    let createdNewNonNeighborCollision = false;
    for (const k of afterPairs) {
      if (!beforePairs.has(k)) {
        createdNewNonNeighborCollision = true;
        break;
      }
    }

    if (createdNewNonNeighborCollision) {
      showPlacementMessage("Výměna nejde – modul by narazil do jiného modulu.", 5000);

      // --- ROLLBACK ---
      // 1) vrĂˇtit sousedĹŻm odkazy zpÄ›t na starĂ˝ root
      for (const link of redirectLinks || []) {
        link.nbRec.connections[link.nbSide] = oldRoot;
      }

      // 2) vrĂˇtit record na starĂ˝ mesh + jmĂ©no (pĹŻvodnĂ­)
      oldRec.mesh = oldRoot;
      oldRec.name = oldName;
      oldRec.model = oldModel;

      // a hlavnÄ› zviditelnit starĂ˝ modul zpÄ›t
      oldRoot.visible = true;

      // 3) odstranit novĂ˝ mesh ze scĂ©ny + uklidit jeho buttony/reference
      removeModuleCompletely(newMesh); // kdyĹľ by nĂˇhodou mÄ›l tlaÄŤĂ­tka
      scene.remove(newMesh);

      // 4) znovu pĹ™epoÄŤĂ­tat layout a tlaÄŤĂ­tka zpÄ›t
      relayoutFromAnchor();
      await rebuildAllAddButtons();
      updateButtons();
      scheduleSummaryRecalc();

      if (isBuildStepActive()) {
        scheduleCanonicalRebuildAnalysis();
      }

      replaceTarget = null;
      hideModuleMenu();
      closePicker();
      return;
    }

    // (volitelnÄ›) debug: pokud nÄ›jakĂ© non-neighbor kolize existovaly uĹľ pĹ™ed vĂ˝mÄ›nou
    if (beforePairs.size > 0) {
      console.warn("Pozor: uĹľ pĹ™ed vĂ˝mÄ›nou existovala kolize mezi NE-sousedy.");
    }

    // kdyĹľ OK, pokraÄŤuj normĂˇlnÄ›
    await rebuildAllAddButtons();
    updateButtons();
    scheduleSummaryRecalc();
    refreshStepValidityAfterCompositionChange();

    if (isBuildStepActive()) {
      scheduleCanonicalRebuildAnalysis();
    }

    // âś… 7) sweep â€“ odstraĹ vĹˇechny osiĹ™elĂ© â€śisModuleâ€ť rooty, kterĂ© zĹŻstaly ve scĂ©nÄ›
    sweepOrphanModuleRoots();
    purgeModuleRecords(oldRoot);

    // ✅ FIX: po přidání / výměně modulu znovu aplikuj výběry z kroku 3 (nožičky/panty/područky)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const legsColorId = document.getElementById("legsColorSelect")?.value || null;

        // 1) noĹľiÄŤky + jejich barva
        if (window.__setLegsFromState) {
          window.__setLegsFromState(selectedLegs, legsColorId);
        } else {
          // fallback kdybys nemÄ›l tyto hooky
          if (typeof setActiveLeg === "function") setActiveLeg(selectedLegs);
          if (typeof setActiveColor === "function") setActiveColor(legsColorId);
          if (typeof applyLegsToScene === "function") applyLegsToScene();
        }

        // 2) podruÄŤky
        if (window.__setArmrestsFromState) {
          window.__setArmrestsFromState(selectedArmrests);
        } else {
          if (typeof applyArmrestsToAllModules === "function") applyArmrestsToAllModules();
        }

        // 3) panty
        if (window.__setHingesFromState) {
          window.__setHingesFromState(selectedHinges);
        } else {
          if (typeof applyHingesToAllModules === "function") applyHingesToAllModules();
        }

        // 4) polička u Melbourne rohů
        const shelfColorId = selectedShelfColor || "wood_buk_br_281";
        if (window.__setShelfColorFromState) {
          window.__setShelfColorFromState(shelfColorId);
        } else {
          applyShelfColorToMelbournePlanes(shelfColorId);
        }
        syncMelbourneShelfTabVisibility();

        // 5) látka + paspule po výměně modulu
        // Nově vyměněný modul má default/basecolor materiály,
        // takže musíme znovu aplikovat hlavní látku i paspuli.
        try { reapplyCurrentFabricAndPaspuleIfSelected?.(); } catch (e) {
          console.warn("Reapply fabric/paspule after replacing module failed:", e);
        }
      });
    });

    saveStateNow();
    window.__refreshSofaPlanEverywhere?.();
    refreshStepValidityAfterCompositionChange();
    replaceTarget = null;

    hideModuleMenu();
    closePicker();
    return;
  }

  // ------------------------------------------------
  // (2) NOVĂť MODUL
  // ------------------------------------------------
  const newModule = await addModule(modelName, pendingAddPosition, variantId);

  // Pokud už je v konfigurátoru zvolená látka, nově přidaný modul má po načtení default/basecolor.
  // Proto hned znovu aplikujeme aktuálně vybranou látku na celou sedačku.
  try { reapplyCurrentFabricAndPaspuleIfSelected?.(); } catch (e) {
    console.warn("Reapply fabric/paspule after adding new module failed:", e);
  }

  if (connectDirection && connectBaseModule) {
    const newRecord = activeModules.find((m) => m.mesh === newModule);
    const baseRecord = activeModules.find((m) => m.mesh === connectBaseModule);

    if (newRecord && baseRecord) {

      // âś… pojistka pravidel
      if (!canAttach({ baseId: baseRecord.name, baseSide: connectDirection, newId: newRecord.name })) {
        showPlacementMessage("Tento modul sem nejde připojit (pravidla sestavy).", 5000);
        rollbackNewModule(newModule);
        closePicker();
        return;
      }

      // 1) novĂ˝ modul zdÄ›dĂ­ rotaci base modulu
      newModule.quaternion.copy(connectBaseModule.quaternion);

      // 2) pĹ™idej rotaci z tlaÄŤĂ­tka pĹ™es quaternion
      if (connectRotY) {
        const qTurn = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          connectRotY
        );
        newModule.quaternion.multiply(qTurn);
      }

      newModule.updateMatrixWorld(true);

      // snap
      snapModules(baseRecord, newRecord, connectDirection);
      repositionButtonsForModule(newRecord);
      newModule.updateMatrixWorld(true);

      // âś… kolize check
      if (!placementIsValid(newRecord, baseRecord, {
        allowNeighborPenetration: 0.03,
        strictEps: 0.002,
      })) {
        showPlacementMessage("Sem se modul nevejde. Zkus jiné místo.", 5000);

        rollbackNewModule(newModule);

        closePicker();
        return;
      }

      // âś… teprve teÄŹ zapisuj connections + hide button
      baseRecord.connections[connectDirection] = newRecord.mesh;

      const sideOnNew = getConnectionSide(newRecord.mesh, baseRecord.mesh);
      newRecord.connections[sideOnNew] = baseRecord.mesh;

      forceHideButtonFor(newRecord.mesh, sideOnNew);

      updateButtons();
    }
  }

  // đź”Ą globĂˇlnĂ­ pĹ™epoÄŤet rozloĹľenĂ­ + tlaÄŤĂ­tka
  relayoutFromAnchor();
  updateButtons();
  window.__refreshSofaPlanEverywhere?.();
  refreshStepValidityAfterCompositionChange();
  saveStateDebounced();

  // cleanup
  pendingAddPosition = null;
  pendingAddButton = null;
  pendingAddDirection = null;
  pendingAddRotY = 0;
  pendingAddShift = null;
  pendingAddBaseModule = null;

  closePicker();
}

function closePicker() {
  const picker = document.getElementById("modulePicker");
  picker.classList.add("hidden");

  pendingAddPosition = null;

  pendingAddButton = null;
  pendingAddDirection = null;
  pendingAddRotY = 0;
  pendingAddShift = null;
  pendingAddBaseModule = null;
  replaceTarget = null;

  // reset pointer stavu v OrbitControls
  const fakeEvent = new PointerEvent("pointerup", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  renderer.domElement.dispatchEvent(fakeEvent);

  controls.update();
}

// Orbit Controls
const controls = new OrbitControls(camera, renderer.domElement);

// ===== CAMERA BUTTONS =====

function fitCameraToScene() {
  if (!activeModules || !activeModules.length) return;

  const box = new THREE.Box3();
  activeModules.forEach(rec => {
    if (rec?.mesh) box.expandByObject(rec.mesh);
  });

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let distance = maxDim / (2 * Math.tan(fov / 2));

  distance *= 1.4; // trochu oddĂˇlit

  const direction = new THREE.Vector3(0, 0.22, 1).normalize();  // zepĹ™edu + lehce zvrchu
  const newPos = center.clone().add(direction.multiplyScalar(distance));

  camera.position.copy(newPos);
  controls.target.copy(center);
  controls.update();
}

function zoomCamera(factor){
  const target = controls.target.clone();
  const offset = camera.position.clone().sub(target);
  offset.multiplyScalar(factor);
  camera.position.copy(target.add(offset));
  controls.update();
}

function openClearAllModal() {
  const modal  = document.getElementById("clearAllModal");
  const okBtn  = document.getElementById("clearAllOk");
  const noBtn  = document.getElementById("clearAllCancel");
  const xBtn   = document.getElementById("clearAllClose");

  if (!modal || !okBtn || !noBtn || !xBtn) return Promise.resolve(false);

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");

      okBtn.removeEventListener("click", onOk);
      noBtn.removeEventListener("click", onNo);
      xBtn.removeEventListener("click", onNo);
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onEsc);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onNo = () => { cleanup(); resolve(false); };

    const onBackdrop = (e) => {
      // klik mimo okno zavĹ™e (jen backdrop)
      if (e.target === modal) onNo();
    };

    const onEsc = (e) => {
      if (e.key === "Escape") onNo();
    };

    okBtn.addEventListener("click", onOk);
    noBtn.addEventListener("click", onNo);
    xBtn.addEventListener("click", onNo);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onEsc);
  });
}

// napojenĂ­ tlaÄŤĂ­tek
document.getElementById("btnCamFit")?.addEventListener("click", () => {
  resetCameraToSofaFit({ snap: true });

  // POSUN POHLEDU PO KLIKU NA "VYCENTROVAT KAMERU"
  // záporné číslo = kamera i target níž
  const CAM_FIT_Y_OFFSET = -0.4;

  camera.position.y += CAM_FIT_Y_OFFSET;
  controls.target.y += CAM_FIT_Y_OFFSET;

  camGoalPos.copy(camera.position);
  camGoalTarget.copy(controls.target);

  controls.update();
  try { saveStateDebounced(); } catch (e) {}
});
document.getElementById("btnCamZoomIn")?.addEventListener("click", () => zoomCamera(0.85));
document.getElementById("btnCamZoomOut")?.addEventListener("click", () => zoomCamera(1.15));

document.getElementById("btnCamClearAll")?.addEventListener("click", async () => {
  // zobrazovat to má smysl jen v kroku 2 (build)
  if (!isBuildStepActive()) return;

  const ok = await openClearAllModal();
  if (!ok) return;

  // Smazáním celé sestavy začíná nová sestava,
  // takže upozornění na výchozí nohy se může znovu ukázat.
  resetLegsUntouchedWarningForCurrentBuild();

  // Stejné jako kdyby v kroku 1 vybrali „postavit vlastní tvar“
  startConfigurator(appState.model, null);
});

function storeUserViewDir() {
  // vektor od targetu ke kameĹ™e = smÄ›r "odkud koukĂˇm"
  userViewDir = camera.position.clone().sub(controls.target);
  if (userViewDir.lengthSq() < 1e-6) userViewDir = new THREE.Vector3(0, 0.25, 1);
  userViewDir.normalize();
}

// uloĹľit hned na startu
storeUserViewDir();

// a pak pokaĹľdĂ©, kdyĹľ user domotĂˇ kameru
controls.addEventListener("end", storeUserViewDir);

controls.addEventListener("end", () => saveStateDebounced());

controls.addEventListener("change", () => {
  // change = kamera se fakt hĂ˝be (rotace/pan/zoom)
  if (pointerIsDown) cameraMovedThisClick = true;
});

controls.addEventListener("change", () => {
  // change = kamera se fakt hnula (rotace/pan/zoom)
  if (mouseDown) cameraMovedThisClick = true;
});

controls.target.set(0, 0.5, 0); // KDE BUDE STĹED POHLEDU
controls.minPolarAngle = Math.PI / 45;
controls.maxPolarAngle = Math.PI / 2.1;

// âś… minimĂˇlnĂ­ vzdĂˇlenost kamery od targetu (zabraĹuje "vlĂ©zt do modulu")
controls.minDistance = 1.2;

// (volitelnĂ©) maximĂˇlnĂ­ vzdĂˇlenost (aĹĄ uĹľivatel neodletĂ­ moc daleko)
controls.maxDistance = 12;

// =====================================================
//  CAMERA COLLISION (aura kolem sestavy)
// =====================================================
const cameraRaycaster = new THREE.Raycaster();
const cameraDir = new THREE.Vector3();

// jak daleko pĹ™ed modelem mĂˇ kamera zĹŻstat (aura)
// 0.08 = 8 cm (mĹŻĹľeĹˇ doladit)
const CAMERA_AURA = 0.30;

// =====================================================
//  LIMIT PAN (pravĂ© tlaÄŤĂ­tko) â€“ nedovol koukat pod sedaÄŤku
// =====================================================

// âś… minimĂˇlnĂ­ vĂ˝Ĺˇka targetu â€“ tĂ­m zabrĂˇnĂ­me "kouknout pod sedaÄŤku"
// (0.35 je takovĂ˝ dobrĂ˝ start, kdyĹľ je sedĂˇk cca kolem 0.45â€“0.55)
const MIN_TARGET_Y = 0.05;

// (volitelnĂ©) max vĂ˝Ĺˇka targetu, aby sis neodjel extrĂ©mnÄ› vysoko
const MAX_TARGET_Y = 2.5;

// uloĹľĂ­me si poslednĂ­ "bezpeÄŤnĂ˝" target (kdyby se nÄ›co snaĹľilo proletÄ›t)
let lastGoodTarget = controls.target.clone();

controls.addEventListener("change", () => {
  // âś… clamp target.y
  if (controls.target.y < MIN_TARGET_Y) controls.target.y = MIN_TARGET_Y;
  if (controls.target.y > MAX_TARGET_Y) controls.target.y = MAX_TARGET_Y;

  // âś… kdyĹľ by se target nÄ›kam divnÄ› "teleportoval", vrĂˇtĂ­me ho
  if (!isFinite(controls.target.y)) {
    controls.target.copy(lastGoodTarget);
  } else {
    lastGoodTarget.copy(controls.target);
  }
});

camera.position.copy(DEFAULT_CAM_POS);
controls.target.copy(DEFAULT_TARGET);
camGoalPos.copy(DEFAULT_CAM_POS);
camGoalTarget.copy(DEFAULT_TARGET);

controls.update();
scheduleSummaryRecalc();

// vlastnĂ­ orbit (NEPOUĹ˝ĂŤVĂ controls.rotateLeft/Up â€“ u tebe nejsou public)
function orbitCameraByDelta(dx, dy, speed) {
  if (!camera || !controls) return;

  const target = controls.target.clone();
  const offset = camera.position.clone().sub(target);

  const spherical = new THREE.Spherical();
  spherical.setFromVector3(offset);

  spherical.theta -= dx * speed;
  spherical.phi   -= dy * speed;

  // clamp podle tvĂ©ho omezenĂ­ (aĹĄ nejde koukat ze spoda)
  const eps = 1e-4;
  const minPhi = (controls.minPolarAngle ?? eps) + eps;
  const maxPhi = (controls.maxPolarAngle ?? (Math.PI - eps)) - eps;

  spherical.phi = Math.max(minPhi, Math.min(maxPhi, spherical.phi));

  offset.setFromSpherical(spherical);

  camera.position.copy(target).add(offset);
  camera.updateMatrixWorld?.();

  controls.update();
}

// Snap pohledy jako Blender (X/-X/Z/-Z/Y-top), bez spodku
function snapCameraToGizmoView(axisKey) {
  if (!camera || !controls) return;

  autoCamBlocked = true;
  autoCamActive = false;

  const target = controls.target.clone();
  const offset = camera.position.clone().sub(target);

  const spherical = new THREE.Spherical();
  spherical.setFromVector3(offset);

  const r = Math.max(controls.minDistance || 0, Math.min(controls.maxDistance || Infinity, spherical.radius));
  const minPhi = (controls.minPolarAngle ?? 0) + 1e-4;
  const maxPhi = (controls.maxPolarAngle ?? Math.PI) - 1e-4;

  const keepPhi = Math.max(minPhi, Math.min(maxPhi, spherical.phi));

  let theta = spherical.theta;
  let phi = keepPhi;

  // THREE.Spherical theta je od +Z smÄ›rem k +X
  switch (axisKey) {
    case "yp": theta = 0;            phi = keepPhi; break;      // zĂˇda  (world +Z)
    case "yn": theta = Math.PI;      phi = keepPhi; break;      // pĹ™edek (world -Z)
    case "xp": theta = Math.PI / 2;  phi = keepPhi; break;      // pravĂ˝ bok (+X)
    case "xn": theta = -Math.PI / 2; phi = keepPhi; break;      // levĂ˝ bok  (-X)
    case "zp":                                              // shora (Z)
      phi = minPhi; // skoro ĂşplnÄ› shora (respektuje minPolarAngle)
      break;
    default:
      return;
  }

  const newOffset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(r, phi, theta));
  camera.position.copy(target).add(newOffset);
  camera.updateMatrixWorld?.();

  controls.update();
}

// PĹ™epoÄŤet pozice os v koleÄŤku podle aktuĂˇlnĂ­ho pohledu (3Dâ†’2D projekce os v camera-space)
function updateCameraHudGizmo() {
  if (!cameraHudEl || !hudPadEl || !hudAxisEls || !camera) return;

  const R = 22; // px
  const cx = 32;
  const cy = 32;

  const axes = {
    // Blender-like popisky:
    // X = world X, Y = world Z, Z(top) = world Y
    xp: new THREE.Vector3( 1, 0, 0),
    xn: new THREE.Vector3(-1, 0, 0),
    yp: new THREE.Vector3( 0, 0, 1),  // Y+ = zĂˇda
    yn: new THREE.Vector3( 0, 0,-1),  // Y- = pĹ™edek
    zp: new THREE.Vector3( 0, 1, 0),  // Z  = shora
  };

  const invQ = camera.quaternion.clone().invert();

  for (const key of Object.keys(hudAxisEls)) {
    const el = hudAxisEls[key];
    if (!el) continue;

    const v = axes[key].clone().applyQuaternion(invQ); // camera-space

    const x2 = v.x;
    const y2 = -v.y;

    const len = Math.max(1e-6, Math.hypot(x2, y2));
    const nx = x2 / len;
    const ny = y2 / len;

    el.style.left = `${cx + nx * R}px`;
    el.style.top  = `${cy + ny * R}px`;

    // depth efekt (3D feeling)
    const depth = Math.max(0, Math.min(1, (-v.z + 0.25) / 1.25)); // 0..1

    // vizuĂˇlnĂ­ â€śvystoupenĂ­â€ť dopĹ™edu
    const zPx = (-4 + depth * 10);          // -4..+6 px
    const s   = (0.90 + depth * 0.20);      // 0.90..1.10

    // jemnĂ© natoÄŤenĂ­ â€śdo prostoruâ€ť (jen pro feeling)
    const rx = (-ny * 14);                  // deg
    const ry = ( nx * 14);                  // deg

    el.style.setProperty("--z", `${zPx.toFixed(2)}px`);
    el.style.setProperty("--s", `${s.toFixed(3)}`);
    el.style.setProperty("--rx", `${rx.toFixed(1)}deg`);
    el.style.setProperty("--ry", `${ry.toFixed(1)}deg`);

    el.style.opacity = String(0.40 + depth * 0.60);
    el.classList.toggle("is-front", v.z < -0.35);
  }
}

controls.addEventListener("start", () => {

  controlsDragging = true;
  controlsStartedThisClick = true;

  autoCamBlocked = true;
  autoCamActive = false;

  // zavĹ™Ă­t menu okamĹľitÄ› jakmile uĹľivatel zaÄŤne hĂ˝bat kamerou
  document.getElementById("moduleActionMenu")?.classList.remove("visible");
  selectedModule = null;
  document.getElementById("actionMenuBlocker")?.classList.remove("active");

  // zruĹˇ kandidĂˇta kliknutĂ­ (aby se po puĹˇtÄ›nĂ­ myĹˇi nÄ›co omylem nespustilo)
  downCandidate = null;
});

controls.addEventListener("end", () => {
  controlsDragging = false;
  autoCamBlocked = false;
  mouseDown = false;
  dragDistance = 0;
});

// === OSVÄšTLENĂŤ (lepĹˇĂ­ stĂ­ny + fill svÄ›tlo) ===

// 1) HemisfĂ©ra â€“ zĂˇkladnĂ­ ambient (mĂ­rnÄ› slabĹˇĂ­, aby to nebylo â€śvypranĂ©â€ť)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0xf0edea, 0.95);
scene.add(hemiLight);

// 2) HlavnĂ­ svÄ›tlo (to tvoje â€“ nechĂˇme, jen trochu doladĂ­me)
const keyLight = new THREE.DirectionalLight(0xffffff, 1.65);
keyLight.position.set(6, 12, 6);
keyLight.castShadow = false;

keyLight.shadow.mapSize.set(2048, 2048);

const keyCam = keyLight.shadow.camera;
keyCam.near = 0.5;
keyCam.far = 80;
keyCam.left = -12;
keyCam.right = 12;
keyCam.top = 12;
keyCam.bottom = -12;

// proti artefaktĹŻm
keyLight.shadow.bias = -0.00015;
keyLight.shadow.normalBias = 0.015;

scene.add(keyLight);

// 3) â€śShadow-onlyâ€ť svÄ›tlo shora (velmi slabĂ©, ale generuje pĹ™esnĂ˝ stĂ­n pod sedaÄŤkou)
const topShadowLight = new THREE.DirectionalLight(0xffffff, 0.12); // intenzita malĂˇ schvĂˇlnÄ›
topShadowLight.position.set(0, 18, 0);
topShadowLight.target.position.set(0, 0, 0);
scene.add(topShadowLight.target);

topShadowLight.castShadow = true;
topShadowLight.shadow.mapSize.set(2048, 2048);

const topCam = topShadowLight.shadow.camera;
topCam.near = 0.5;
topCam.far = 80;
topCam.left = -10;
topCam.right = 10;
topCam.top = 10;
topCam.bottom = -10;

// stĂ­ny ÄŤistÄ›jĹˇĂ­
topShadowLight.shadow.bias = -0.00015;
topShadowLight.shadow.normalBias = 0.02;

scene.add(topShadowLight);

// 4) Fill svÄ›tlo z opaÄŤnĂ© strany (aby nebyla jedna strana ÄŤernĂˇ)
const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
fillLight.position.set(-6, 9, -6);
fillLight.castShadow = false; // fill svÄ›tlo stĂ­ny dÄ›lat nemusĂ­
scene.add(fillLight);

// 5) Shadow catcher â€“ trochu vÄ›tĹˇĂ­ opacity, protoĹľe mĂˇme vĂ­c â€śstĂ­novĂ˝châ€ť svÄ›tel
const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

async function createButtonAt(
  position,
  parentModule = null,
  direction = null,
  rotY = 0,
  shift = null,
  shiftByModule = null
) {
  const btn = await loadButton();

  btn.position.copy(position);
  btn.position.y = 0.0;
  btn.rotation.set(Math.PI, 0, Math.PI);
  btn.scale.set(1, 1, 1);
  btn.name = "AddButton";

  btn.userData.parentModule = parentModule;
  btn.userData.direction = direction;
  btn.userData.rotY = rotY;
  btn.userData.shift = shift ? shift.clone() : null;
  btn.userData.shiftByModule = shiftByModule || null;
  btn.userData.isButtonRoot = true;

  btn.traverse((o) => {
    if (o.isMesh) {
      o.name = "AddButton";
      o.userData.parentModule = parentModule;
      o.userData.direction = direction;
      o.userData.rotY = rotY;
      o.userData.shift = shift ? shift.clone() : null;
      o.userData.shiftByModule = shiftByModule || null;
      o.userData.isAddButton = true;
      o.raycast = THREE.Mesh.prototype.raycast;
    }
  });

  scene.add(btn);
  return btn;
}

function thumbPaddingForVariant(variantId) {
  // Manila_2... a Manila_3... = NEPĹIBLIĹ˝OVAT (oddĂˇlit)
  if (/^Manila_[23]/.test(variantId)) {
    return 1.25;
  }

  // vĹˇechno ostatnĂ­ (1 / 1D / rohy / kĹ™eslo / atd.) = PĹIBLĂŤĹ˝IT
  return 0.75;
}

// -----------------------------------------------------
//  THUMBNAILS pro picker (auto-render pĹ™es Three.js)
// -----------------------------------------------------
const THUMB_SIZE = 220; // px
const thumbCache = new Map(); // variantId -> dataURL

let thumbRenderer = null;
let thumbScene = null;
let thumbCamera = null;

function initThumbRendererOnce() {
  if (thumbRenderer) return;

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;

  thumbRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // nutnĂ© pro toDataURL()
  });
  thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
  thumbRenderer.setClearColor(0x000000, 0); // transparent

  thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  thumbRenderer.toneMappingExposure = renderer?.toneMappingExposure ?? 3;

  thumbScene = new THREE.Scene();

  // stejnĂ© â€śfeelâ€ť svÄ›tla jako ve scĂ©nÄ› (hemi + dir)
  const hemi = new THREE.HemisphereLight(0xffffff, 0xf0edea, 0.9);
  thumbScene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(0, 50, 0);
  thumbScene.add(dir);

  thumbCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
}

function computeThumbCameraForObject(obj3d, variantId) {
  // BBox z â€śseatâ€ť ÄŤĂˇsti, stejnÄ› jako pouĹľĂ­vĂˇĹˇ pro snap (aby to bylo konzistentnĂ­) :contentReference[oaicite:2]{index=2}
  const is23 = /^Manila_[23]/.test(variantId);

  // pro 2 a 3 dĂ­ly ber celĂ˝ objekt (kvĹŻli podruÄŤkĂˇm)
  // pro ostatnĂ­ ber snap mesh (sedĂˇk), pokud existuje
  const snap = getSnapMesh(obj3d);
  const fitSource = (is23 ? obj3d : (snap || obj3d));

  const box = new THREE.Box3().setFromObject(fitSource);

  const size = new THREE.Vector3();
  box.getSize(size);

  const center = new THREE.Vector3();
  box.getCenter(center);

  // StejnĂˇ logika jako v recomputeCameraFit(): target = center + Y offset :contentReference[oaicite:3]{index=3}
  const target = center.clone();
  target.y += CAMERA_FIT_TARGET_Y;

  // --- dorovnĂˇnĂ­ rohĹŻ do stĹ™edu (protoĹľe jsou asymetrickĂ©) ---
  const isCorner = /Roh/i.test(variantId);
  if (isCorner) {
    // smÄ›r kamery (uĹľ ho stejnÄ› pouĹľĂ­vĂˇĹˇ nĂ­Ĺľ)
    const dir = FIRST_MODULE_DIR.clone().normalize();

    // "pravĂˇ" strana kamery (abychom posouvali roh do stĹ™edu obrazu)
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize(); // vektor doprava v obraze

    // kolik posunout (doladĂ­Ĺˇ: 0.12â€“0.22 bĂ˝vĂˇ OK)
    const shift = size.x * 0.20;

    // L = posun jednĂ­m smÄ›rem, P = opaÄŤnÄ›
    // (u tebe mĂˇĹˇ nĂˇzvy "Roh L" a "Roh P", takĹľe tohle sedĂ­)
    const sign = /(\bL\b|_L\b| L$)/i.test(variantId) ? 1 : -1;

    target.addScaledVector(right, shift * sign);
  }
  // --- konec dorovnĂˇnĂ­ rohĹŻ ---

  const maxDim = Math.max(size.x, size.z);
  const fov = THREE.MathUtils.degToRad(thumbCamera.fov);

  // StejnĂ˝ fitDist vĂ˝poÄŤet jako v recomputeCameraFit() :contentReference[oaicite:4]{index=4}
  const pad = thumbPaddingForVariant(variantId);
  let fitDist = (maxDim / (2 * Math.tan(fov / 2))) * pad;

  // podobnĂ© clamp jako u tebe (aby se to nechovalo divnÄ› na mini dĂ­lech)
  const minDist = is23 ? 2.6 : 1.8;   // 2/3 nechat dĂˇl, ostatnĂ­ jen trochu blĂ­Ĺľ
  fitDist = THREE.MathUtils.clamp(fitDist, minDist, 12);

  // StejnĂ˝ smÄ›r jako â€śpo pĹ™idĂˇnĂ­ prvnĂ­ho moduluâ€ť = FIRST_MODULE_DIR :contentReference[oaicite:5]{index=5}
  const dir = FIRST_MODULE_DIR.clone().normalize();

  const camPos = target.clone().add(dir.multiplyScalar(fitDist));

  thumbCamera.position.copy(camPos);
  thumbCamera.lookAt(target);
  thumbCamera.updateProjectionMatrix();
}

async function getVariantThumbDataURL(variantId) {
  if (thumbCache.has(variantId)) return thumbCache.get(variantId);

  initThumbRendererOnce();

  const cat = getCatalog(variantId);
  if (!cat) return null;

  const modelName = cat.model;
  const original = moduleTemplates[modelName];
  if (!original) return null;

  // clone modelu (stejnÄ› jako spawnModuleMesh)
  const obj = original.clone(true);
  obj.position.set(0, 0, 0);
  obj.quaternion.identity();
  obj.updateMatrixWorld(true);
  forceLegsOnly(obj, "N7");
  obj.updateMatrixWorld(true);

  thumbScene.add(obj);

  computeThumbCameraForObject(obj, variantId);

  thumbRenderer.render(thumbScene, thumbCamera);

  const dataURL = thumbRenderer.domElement.toDataURL("image/png");
  thumbCache.set(variantId, dataURL);

  thumbScene.remove(obj);

  return dataURL;
}

// âś… Service Worker pouze v produkci (v dev vypnutĂ© kvĹŻli cache)
const IS_DEV =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1";

// v dev automaticky SW odregistrovat, aby nikdy necachoval starĂ© modely
if (IS_DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  });
}

if ("serviceWorker" in navigator && !IS_DEV) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(assetUrl("/sw.js")).catch((e) => {
      console.warn("SW register failed:", e);
    });
  });
} else {
  debugLog("SW disabled in DEV to prevent caching issues.");
}

// ===== THUMB QUEUE (aby se picker nezasekĂˇval) =====
const thumbJobQueue = [];
let thumbJobRunning = false;

function runNextThumbJob() {
  if (thumbJobRunning) return;
  const job = thumbJobQueue.shift();
  if (!job) return;

  thumbJobRunning = true;

  const finish = () => {
    thumbJobRunning = false;
    // dalĹˇĂ­ job nechĂˇme aĹľ na dalĹˇĂ­ tick (aĹĄ UI dĂ˝chĂˇ)
    setTimeout(runNextThumbJob, 0);
  };

  // requestIdleCallback kdyĹľ je, jinak fallback
  const schedule = window.requestIdleCallback
    ? (fn) => requestIdleCallback(fn, { timeout: 250 })
    : (fn) => setTimeout(fn, 0);

  schedule(async () => {
    try {
      await job();
    } catch (e) {
      console.warn("Thumb job failed:", e);
    } finally {
      finish();
    }
  });
}

function enqueueThumbJob(fn) {
  thumbJobQueue.push(fn);
  runNextThumbJob();
}

const _thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;

    const imgEl = e.target;
    _thumbObserver.unobserve(imgEl);

    const variantId = imgEl.dataset.variantId;
    if (!variantId) continue;

    enqueueThumbJob(async () => {
      if (!imgEl.isConnected) return;

      const url = await getVariantThumbDataURL(variantId);
      if (!url) return;
      if (!imgEl.isConnected) return;

      imgEl.src = url;
    });
  }
}, { root: null, rootMargin: "300px", threshold: 0.01 });

// ===== THUMBS (uĹľ NErenderujeme v Three.js, jen naÄŤĂ­tĂˇme hotovĂ© PNG) =====

function getThumbUrlForVariant(variantId) {
  const cat = getCatalog?.(variantId);

  // Primárně podle názvu GLB.
  // generate-thumbs.mjs ukládá PNG se stejným basename jako GLB:
  // Manchester_1D_L.glb -> Manchester_1D_L.png
  const baseName = cat?.model || variantId;

  // Pojistka proti mezerám.
  const safe = String(baseName).trim().replace(/\s+/g, "_");

  const lower = safe.toLowerCase();

  const folder =
    lower.startsWith("manila") ? "Manila" :
    lower.startsWith("mendoza") ? "Mendoza" :
    lower.startsWith("melbourne") ? "Melbourne" :
    lower.startsWith("manchester") ? "Manchester" :
    "";

  const url = folder
    ? `/thumbs/${folder}/${encodeURIComponent(safe)}.png`
    : `/thumbs/${encodeURIComponent(safe)}.png`;
  return assetUrl(url);
}

function attachThumbToImg(variantId, imgEl) {
  imgEl.dataset.variantId = variantId;

  // placeholder
  imgEl.src = `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==`;

  imgEl.onerror = () => {
    // kdyĹľ PNG nenĂ­, nech placeholder (nebo si sem dej fallback obrĂˇzek)
    imgEl.onerror = null;
  };

  imgEl.src = getThumbUrlForVariant(variantId);
}

async function placeAddButton(position) {
  return createButtonAt(position);
}

function spawnModuleMesh(moduleName, position) {
  const original = moduleTemplates[moduleName];
  if (!original) return null;

  const moduleMesh = original.clone(true);
  moduleMesh.position.copy(position);
  moduleMesh.userData.isModule = true;
  moduleMesh.userData.moduleName = moduleName;
  moduleMesh.name = "Module";

  // uloĹľit originalMaterial pro hover reset (bez clone = rychlejĹˇĂ­)
  moduleMesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;

    // kdyĹľ je material pole, uloĹľ reference na pole
    if (Array.isArray(o.material)) {
      o.userData.originalMaterial = o.material.slice();
    } else {
      o.userData.originalMaterial = o.material;
    }
  });

  // snapMesh (seat)
  moduleMesh.userData.snapMesh = null;
  moduleMesh.traverse((o) => {
    if (o.isMesh && o.name.toLowerCase().includes("seat")) {
      moduleMesh.userData.snapMesh = o;
    }
  });

  return moduleMesh;
}

function forceLegsOnly(root, legCode) {
  if (!root || !legCode) return;

  // =========================
  // âś… MENDOZA â€“ speciĂˇlnĂ­ logika (nohy zĂˇvisĂ­ na typu podruÄŤek)
  // =========================
  const isMendoza = /^mendoza/i.test(root?.userData?.moduleName || "");
  if (isMendoza) {
    const raw = String(legCode || "").toUpperCase();
    const allowed = new Set(["N1", "N8", "N11"]);
    const eff = allowed.has(raw) ? raw : "N8"; // fallback

    // "smooth" = zĂˇkladnĂ­ podruÄŤka (P/L), "sharp" = polohovacĂ­ (P2/L2)
    const armMode =
      String(selectedArmrests || "smooth").toLowerCase() === "sharp"
        ? "adjustable"
        : "basic";

    // 1) zjisti, co v modulu fakt existuje (nÄ›kterĂ© moduly nemajĂ­ Nx duplikĂˇty)
    const present = {
      legs_n1: false, legs_n8: false, legs_n11: false,
      n1: false, n8: false, n11: false,
    };

    root.traverse((o) => {
      if (!o?.isMesh) return;
      const n = (o.name || "").toLowerCase();
      if (!n) return;
      if (n in present) present[n] = true;
    });

    const legsName = `legs_${eff.toLowerCase()}`; // legs_n8
    const plainName = eff.toLowerCase();          // n8

    const hasLegsTarget = present[legsName] === true;
    const hasPlainTarget = present[plainName] === true;

    // 2) vyber co ukĂˇzat â€“ kdyĹľ cĂ­lovĂ˝ objekt neexistuje, NIC NEMÄšĹ‡ (zĹŻstane pĹŻvodnĂ­ viditelnost)
    let chosen = null;

    if (armMode === "basic") {
      // zĂˇkladnĂ­ podruÄŤka => preferuj legs_Nx, fallback Nx
      if (hasLegsTarget) chosen = legsName;
      else if (hasPlainTarget) chosen = plainName;
      else return; // modul nemĂˇ ani jednu variantu => nech to jak je
    } else {
      // polohovacĂ­ podruÄŤka => preferuj Nx, fallback legs_Nx
      if (hasPlainTarget) chosen = plainName;
      else if (hasLegsTarget) chosen = legsName;
      else return; // modul nemĂˇ ani jednu variantu => nech to jak je
    }

    // 3) teprve teÄŹ enforce: schovej vĹˇechny kandidĂˇty a nech jen zvolenĂ˝
    root.traverse((o) => {
      if (!o?.isMesh) return;
      const n = (o.name || "").toLowerCase();
      if (!n) return;

      const isLegsGroup = n.startsWith("legs_"); // legs_n1, legs_n8, legs_n11
      const isPlainN = /^n\d+$/.test(n);         // n1, n8, n11

      if (!isLegsGroup && !isPlainN) return;

      o.visible = n === chosen;
    });

    return; // â›” dĂˇl uĹľ nepouĹˇtÄ›j Manila logiku
  }

  // =========================
  // âś… MANILA (pĹŻvodnĂ­ chovĂˇnĂ­)
  // =========================
  const legNeedle = String(legCode)
    .replace(/[-/\\.^$*+?()|[\]{}]/g, "\\$&");

  const wantRe = new RegExp(`${legNeedle}(?!\\d)`, "i");

  const isLegThing = (name) => {
    const n = (name || "").toLowerCase();
    return (
      n.includes("legs") ||
      n.includes("noha") ||
      n.includes("nohy") ||
      n.includes("podnoz") ||
      n.includes("feet")
    );
  };

  root.traverse((o) => {
    if (!o?.isMesh) return;

    const n = (o.name || "").toLowerCase();
    if (!n) return;

    const isLegCandidate = isLegThing(n) || wantRe.test(n);
    if (!isLegCandidate) return;

    o.visible = wantRe.test(n);
  });
}

// ===== PODRUÄŚKY: v modulu ukazuj jen vybranĂ˝ typ ("smooth" / "sharp") =====
function forceArmrestsOnly(root, type = "smooth") {
  if (!root) return;

  // =========================
  // âś… MENDOZA â€“ podruÄŤky + body + hinge/hinge2
  // =========================
  const isMendoza = /^mendoza/i.test(root?.userData?.moduleName || "");
  if (isMendoza) {
    // "smooth" = zĂˇkladnĂ­ podruÄŤka (P/L), "sharp" = polohovacĂ­ (P2/L2)
    const adjustableWanted = String(type).toLowerCase() === "sharp";

    // 1) zjisti, co tenhle modul fakt mĂˇ (nÄ›kterĂ© moduly nemajĂ­ body2 / hinge2 / podruÄŤky)
    const present = {
      body1: false, body2: false,
      armrest_p: false, armrest_p2: false,
      armrest_l: false, armrest_l2: false,
      hinge: false, hinge2: false,
    };

    root.traverse((o) => {
      const n = (o?.name || "").toLowerCase();
      if (!n) return;
      if (n in present) present[n] = true;
    });

    const hasAnyArmrest =
      present.armrest_p || present.armrest_p2 || present.armrest_l || present.armrest_l2;

    // 2) jen kdyĹľ ten modul skuteÄŤnÄ› umĂ­ polohovacĂ­ podruÄŤky, dovol pĹ™epnutĂ­
    const adjustable = hasAnyArmrest && adjustableWanted && (present.armrest_p2 || present.armrest_l2);

    // body swap jen pokud existuje body2
    const showBody2 = adjustable && present.body2;
    const showBody1 = !showBody2;

    // P strana: kdyĹľ P2 neexistuje, nech P
    const showP2 = adjustable && present.armrest_p2;
    const showP  = !showP2;

    // L strana: kdyĹľ L2 neexistuje, nech L
    const showL2 = adjustable && present.armrest_l2;
    const showL  = !showL2;

    // hinge vĹľdy, hinge2 jen pĹ™i polohovacĂ­
    const showHinge  = present.hinge ? true : false;
    const showHinge2 = adjustableWanted && present.hinge2;

    root.traverse((obj) => {
      const n = (obj.name || "").toLowerCase();
      if (!n) return;

      // sedĂˇky + opÄ›rky musĂ­ bĂ˝t vĹľdy
      if (n.startsWith("seat_") || n.startsWith("backrest_")) {
        obj.visible = true;
        return;
      }

      // body vĹľdy vidÄ›t
      if (n === "body") {
        obj.visible = true;
        return;
      }

      // hinge / hinge2
      if (n === "hinge") {
        obj.visible = showHinge;
        return;
      }
      if (n === "hinge2") {
        obj.visible = showHinge2;
        return;
      }

      // body1/body2 podle typu podruÄŤky (s fallbackem, kdyĹľ body2 nenĂ­)
      if (n === "body1") {
        obj.visible = showBody1;
        return;
      }
      if (n === "body2") {
        obj.visible = showBody2;
        return;
      }

      // podruÄŤky P/L vs P2/L2 (s fallbackem, kdyĹľ P2/L2 neexistuje)
      if (n === "armrest_p") {
        obj.visible = showP;
        return;
      }
      if (n === "armrest_p2") {
        obj.visible = showP2;
        return;
      }
      if (n === "armrest_l") {
        obj.visible = showL;
        return;
      }
      if (n === "armrest_l2") {
        obj.visible = showL2;
        return;
      }
    });

    return; // â›” dĂˇl uĹľ nepouĹˇtÄ›j Manila logiku
  }

  // =========================
  // âś… MANILA (pĹŻvodnĂ­ chovĂˇnĂ­: smooth/sharp varianty)
  // =========================
  const wantSharp = String(type).toLowerCase() === "sharp";

  root.traverse((obj) => {
    const n = (obj.name || "").toLowerCase();
    if (!n) return;

    // Ĺ™eĹˇĂ­me jen objekty, co jsou nÄ›jakĂˇ podruÄŤka
    if (!n.includes("armrest")) return;

    const isSharp = n.includes("armrest_sharp");

    // Smooth varianty: pĹ™esnÄ› armrest_l / armrest_p
    const isSmooth =
      n === "armrest_l" || n === "armrest_p";

    // Sharp varianty: armrest_sharp_l / armrest_sharp_p
    const isSharpNamed =
      n === "armrest_sharp_l" || n === "armrest_sharp_p";

    // KdyĹľ se v nĂˇzvu objevĂ­ "armrest" a nenĂ­ to ani smooth ani sharp (podle oÄŤekĂˇvĂˇnĂ­),
    // radĹˇi to schovej, aĹĄ se ti tam neukĂˇĹľe nÄ›co nechtÄ›nĂ©ho
    if (!isSmooth && !isSharpNamed) {
      obj.visible = false;
      return;
    }

    // Logika vĂ˝bÄ›ru:
    if (wantSharp) {
      obj.visible = isSharp && isSharpNamed;
    } else {
      obj.visible = !isSharp && isSmooth;
    }
  });
}

// ===============================
// APPLY HINGES TO MODULES
// ===============================

function applyHingeMaterial(mesh, hingeType) {
  if (!mesh) return;

  // mapovĂˇnĂ­ UI hodnot -> tvoje metal ID (z METAL_TEX)
  const metalId = (hingeType === "softclose")
    ? "metal_matte_black"
    : "metal_chrome"; // default "standard"

  // âś… vezmi stejnĂ© PBR materiĂˇly, jako pouĹľĂ­vĂˇĹˇ pro kovovĂ© nohy
  const baseMat = getMetalLegMaterial(metalId);

  mesh.traverse((obj) => {
    if (!obj?.isMesh) return;

    const name = (obj.name || "").toLowerCase();
    if (!name.includes("hinge")) return;

    obj.material = baseMat.clone();
    obj.material.needsUpdate = true;
    obj.userData.materialRole = "other";
    obj.userData.originalMaterial = obj.material.clone();
  });
}

function applyHingesToAllModules() {
  for (const rec of activeModules) {
    if (!rec?.mesh) continue;

    applyHingeMaterial(rec.mesh, selectedHinges);

    // âś… aĹĄ se po zmÄ›nÄ› pantĹŻ sprĂˇvnÄ› nastavĂ­ hinge2 (jen pro Mendoza)
    applyMendozaVisibility(rec.mesh, {
      armrestType: selectedArmrests || "smooth",
      legCode: selectedLegs || "N7",
    });

    applyMelbourneVisibility(rec.mesh, {
      legCode: selectedLegs || "N9",
    });

    applyManchesterVisibility(rec.mesh, {
      armrestType: selectedArmrests || "smooth",
      legCode: selectedLegs || "N21",
    });
  }

  saveStateDebounced();
}

function getDefaultLegCodeForCurrentSofa() {
  const sofa = String(appState?.model || "").toLowerCase();
  // Mendoza default = N8
  if (sofa.includes("mendoza")) return "N8";
  if (sofa.includes("melbourne")) return "N9";
  if (sofa.includes("manchester")) return "N21";
  // Manila (a ostatnĂ­) default = N7
  return "N7";
}

function applyArmrestsToAllModules() {
  activeModules.forEach((r) => {
    if (!r?.mesh) return;

    // 1) PodruÄŤky (Manila Ĺ™eĹˇĂ­ forceArmrestsOnly, Mendoza si uvnitĹ™ dÄ›lĂˇ fallbacky)
    forceArmrestsOnly(r.mesh, selectedArmrests || "smooth");

    // 2) Mendoza: body1/body2, hinge2 atd. podle toho, jestli je podruÄŤka polohovacĂ­
    applyMendozaVisibility(r.mesh, {
      armrestType: selectedArmrests || "smooth",
      legCode: selectedLegs || "N7",
    });

    applyMelbourneVisibility(r.mesh, {
      legCode: selectedLegs || "N9",
    });

    // 3) ✅ obecné nohy nejdřív
    forceLegsOnly(r.mesh, selectedLegs || "N7");

    // 4) ✅ Manchester až nakonec jako finální override:
    // schová buď legs_N*, nebo N* podle typu područky
    applyManchesterVisibility(r.mesh, {
      armrestType: selectedArmrests || "smooth",
      legCode: selectedLegs || "N21",
    });

    r.mesh.updateMatrixWorld(true);

    r.mesh.updateMatrixWorld(true);
  });

  updateButtons?.();
  scheduleSummaryRecalc?.();
  saveStateDebounced?.(50);
  updateBuildModeUI();
}

// ===============================
// MENDOZA: VIDITELNOST DĂŤLĹ® PODLE PODRUÄŚEK / NOHOU
// - hinge vĹľdy vidÄ›t
// - hinge2 jen kdyĹľ jsou polohovacĂ­ podruÄŤky
// - body1/body2 pĹ™epĂ­nat jen kdyĹľ existujĂ­ oba
// - legs_N* vs N* pĹ™epĂ­nat podle podruÄŤek, ale jen kdyĹľ cĂ­lovĂ© objekty existujĂ­
// - Manila to NEOVLIVNĂŤ: bÄ›ĹľĂ­ jen pro variantId "Mendoza_*"
// ===============================
function applyMendozaVisibility(root, { armrestType, legCode } = {}) {
  if (!root) return;

  const vid = String(root?.userData?.variantId || "").toLowerCase();
  if (!vid.startsWith("mendoza_")) return; // âś… Manila ignoruj

  // --- Mendoza: headrest/backrest reĹľim ---
  // - backrest_1P/L/S = dole (default)
  // - backrest_2P/L/S = nahoĹ™e
  // - Hinge_P/L/S: vidÄ›t jen kdyĹľ je aktivnĂ­ "2" (nahoĹ™e)
  // Stav uklĂˇdĂˇme do root.userData._mendozaBackrestState, aby se neztrĂˇcel pĹ™i zmÄ›nÄ› nohou/podruÄŤek/hinges.
  const ensureMendozaBackrestState = () => {
    if (root.userData._mendozaBackrestState) return root.userData._mendozaBackrestState;

    // default: vĹˇechno "1" (dole)
    const st = { p: 1, l: 1, s: 1 };

    // VĂ˝chozĂ­ "nahoĹ™e" podle tvĂ©ho popisu:
    // 2, 2L -> 2P
    // 2M, 2P -> 2L
    // 3, 3L, 3M, 3P -> 2S
    // roh + kĹ™eslo -> vĹˇechno dole
    const key = vid.replace(/^mendoza_/, "");
    if (key === "2" || key === "2l") st.p = 2;
    else if (key === "2m" || key === "2p") st.l = 2;
    else if (key === "3" || key === "3l" || key === "3m" || key === "3p") st.s = 2;

    root.userData._mendozaBackrestState = st;
    return st;
  };

  const setByBase = (baseLower, visible) => {
    root.traverse((o) => {
      const n = (o?.name || "").toLowerCase();
      if (!n) return;
      if (n === baseLower || n.startsWith(baseLower + ".") || n.startsWith(baseLower + "_")) {
        o.visible = visible;
      }
    });
  };

  const applyMendozaBackrestsAndHinges = () => {
    const st = ensureMendozaBackrestState();
    for (const k of ["p", "l", "s"]) {
      const isUp = st?.[k] === 2;
      setByBase(`backrest_1${k}`, !isUp);
      setByBase(`backrest_2${k}`, isUp);
      setByBase(`hinge_${k}`, isUp);
    }
  };

  const wantAdjustable = String(armrestType || "smooth").toLowerCase() === "sharp"; 
  // â†‘ pouĹľĂ­vĂˇme tvĹŻj existujĂ­cĂ­ vĂ˝bÄ›r: sharp = polohovacĂ­, smooth = zĂˇkladnĂ­

  const leg = String(legCode || "").toUpperCase();

  const findExact = (lowerName) => {
    const out = [];
    root.traverse((o) => {
      const n = (o?.name || "").toLowerCase();
      if (n === lowerName) out.push(o);
    });
    return out;
  };

  const setVis = (arr, v) => arr.forEach((o) => (o.visible = v));

  // --- vÄ›ci, kterĂ© majĂ­ bĂ˝t vĹľdy vidÄ›t (pokud existujĂ­) ---
  root.traverse((o) => {
    const n = (o?.name || "").toLowerCase();
    if (!n) return;

    if (
      n.startsWith("seat_") ||
      n === "body" ||
      n === "hinge"
    ) {
      o.visible = true;
    }

    applyMendozaBackrestsAndHinges();
  });

  // --- hinge2: jen pĹ™i polohovacĂ­ch podruÄŤkĂˇch (pokud existuje) ---
  const hinge2 = findExact("hinge2");
  if (hinge2.length) setVis(hinge2, wantAdjustable);

  // --- body1/body2: pĹ™epĂ­nej jen kdyĹľ existujĂ­ oba ---
  const body1 = findExact("body1");
  const body2 = findExact("body2");
  if (body1.length && body2.length) {
    setVis(body1, !wantAdjustable);
    setVis(body2, wantAdjustable);
  }
  // pokud body2 neexistuje â†’ nic nemÄ›Ĺ (zĹŻstane body1 / pĹŻvodnĂ­)

  // --- armrest_P / armrest_P2 a armrest_L / armrest_L2: pĹ™epĂ­nej jen kdyĹľ existujĂ­ oba ---
  const aP = findExact("armrest_p");
  const aP2 = findExact("armrest_p2");
  if (aP.length && aP2.length) {
    setVis(aP, !wantAdjustable);
    setVis(aP2, wantAdjustable);
  }

  const aL = findExact("armrest_l");
  const aL2 = findExact("armrest_l2");
  if (aL.length && aL2.length) {
    setVis(aL, !wantAdjustable);
    setVis(aL2, wantAdjustable);
  }
  // pokud tĹ™eba prostĹ™ednĂ­ modul nemĂˇ podruÄŤky â†’ nic se nestane

  // --- NOHY: legs_N* vs N* ---
  // zĂˇkladnĂ­ podruÄŤky: preferuj legs_N*
  // polohovacĂ­ podruÄŤky: preferuj N* (bez legs_)
  // ale jen kdyĹľ cĂ­lovĂ˝ typ existuje â€” jinak nech pĹŻvodnĂ­
  if (leg) {
    const legsNamed = findExact(`legs_${leg.toLowerCase()}`); // legs_n8
    const plain = findExact(leg.toLowerCase());              // n8

    // PomocnĂ˝ "safe" reĹľim: schovej ostatnĂ­ legs_n* / n* jen pokud opravdu pĹ™epĂ­nĂˇme
    const hideOtherLegSets = (mode /* "legs" | "plain" */) => {
      root.traverse((o) => {
        const n = (o?.name || "").toLowerCase();
        if (!n) return;

        const isLegLike =
          n.startsWith("legs_n") || n === "n1" || n === "n8" || n === "n11";
        if (!isLegLike) return;

        if (mode === "legs") {
          o.visible = (n === `legs_${leg.toLowerCase()}`);
        } else {
          o.visible = (n === leg.toLowerCase());
        }
      });
    };

    if (wantAdjustable) {
      // polohovacĂ­: chci N* (bez legs_) kdyĹľ existuje
      if (plain.length) {
        hideOtherLegSets("plain");
      } else if (legsNamed.length) {
        // fallback: kdyĹľ N* neexistuje, nech legs_ variantu
        hideOtherLegSets("legs");
      }
      // kdyĹľ neexistuje ani jedno â†’ nic nemÄ›Ĺ
    } else {
      // zĂˇkladnĂ­: chci legs_N* kdyĹľ existuje
      if (legsNamed.length) {
        hideOtherLegSets("legs");
      } else if (plain.length) {
        // fallback: kdyĹľ legs_ neexistuje, nech N*
        hideOtherLegSets("plain");
      }
    }
  }
  // âś… MENDOZA: N8 = kov; default chrom, ale respektuj vybranou metal barvu
  if (leg === "N8") {
    const selected = document.getElementById("legsColorSelect")?.value || "metal_chrome";
    const mat = getMetalLegMaterial(selected);

    root.traverse((o) => {
      if (!o?.isMesh) return;
      if (!o.visible) return;

      const n = (o.name || "").toLowerCase();
      if (n === "legs_n8" || n === "n8") {
        o.material = mat;
        o.material.needsUpdate = true;
      }
    });
  }
}

// ===============================
// MANCHESTER: VIDITELNOST DÍLŮ PODLE PODRUČEK / NOHOU
// - default / polohovací područka: armrest_L/P + body1 + legs_N*
// - změněná / hranatá područka: armrest_L2/P2 + body2 + N*
// - vždy viditelné: body, headrest_L/P/S, seat_L/P/S
// - ostatní meshe se skryjí
// ===============================
function applyManchesterVisibility(root, { armrestType, legCode } = {}) {
  if (!root) return;

  const vid = String(root?.userData?.variantId || "").toLowerCase();
  const moduleName = String(root?.userData?.moduleName || "").toLowerCase();

  if (!vid.startsWith("manchester_") && !moduleName.startsWith("manchester")) return;

  // Manchester:
  // smooth = polohovací
  // sharp  = hranatá / druhá područka
  const isSecondArmrest = String(armrestType || "smooth").toLowerCase() === "sharp";

  const leg = String(legCode || "N21").toUpperCase();

  const cleanName = (objName) => {
    return String(objName || "")
      .trim()
      .toLowerCase()
      .replace(/\.\d+$/, "");
  };

  const is1DModule =
    /^manchester_1xd_[lp]$/i.test(vid) ||
    /^manchester_1d_[lp]$/i.test(vid) ||
    /1xd_[lp]$/i.test(moduleName) ||
    /1d_[lp]$/i.test(moduleName);

  const exactExists = (lowerName) => {
    let found = false;
    root.traverse((o) => {
      if (!o?.isMesh) return;
      if (cleanName(o.name) === lowerName) found = true;
    });
    return found;
  };

  const hasBody2 = exactExists("body2");
  const hasSeat2 = exactExists("seat2");

  const showBody1 = !isSecondArmrest || !hasBody2;
  const showBody2 = isSecondArmrest && hasBody2;

  const showSeat = !is1DModule || !isSecondArmrest || !hasSeat2;
  const showSeat2 = is1DModule && isSecondArmrest && hasSeat2;

  // DŮLEŽITÉ:
  // polohovací područka = legs_N*
  // hranatá / druhá područka = N*
  const preferredLegName = isSecondArmrest
    ? leg.toLowerCase()
    : `legs_${leg.toLowerCase()}`;

  const fallbackLegName = isSecondArmrest
    ? `legs_${leg.toLowerCase()}`
    : leg.toLowerCase();

  const hasPreferredLeg = exactExists(preferredLegName);
  const hasFallbackLeg = exactExists(fallbackLegName);

  const chosenLegName =
    hasPreferredLeg ? preferredLegName :
    hasFallbackLeg ? fallbackLegName :
    null;

  const alwaysVisible = new Set([
    "body",
    "headrest_l",
    "headrest_p",
    "headrest_s",
    "seat_l",
    "seat_p",
    "seat_s",
  ]);

  const allManchesterLegs = new Set([
    "legs_n1", "legs_n8", "legs_n9", "legs_n11", "legs_n21",
    "n1", "n8", "n9", "n11", "n21",
  ]);

  root.traverse((o) => {
    if (!o?.isMesh) return;

    const n = cleanName(o.name);
    if (!n) return;

    // defaultně schovej všechno, co Manchester nechce
    o.visible = false;

    // vždy viditelné části
    if (alwaysVisible.has(n)) {
      o.visible = true;
      return;
    }

    // 1D / 1XD má seat + seat2
    // seat = první područka
    // seat2 = druhá područka
    if (n === "seat") {
      o.visible = showSeat;
      return;
    }

    if (n === "seat2") {
      o.visible = showSeat2;
      return;
    }

    // body1 / body2 podle područky
    if (n === "body1") {
      o.visible = showBody1;
      return;
    }

    if (n === "body2") {
      o.visible = showBody2;
      return;
    }

    // první sada područek
    if (n === "armrest_l" || n === "armrest_p") {
      o.visible = !isSecondArmrest;
      return;
    }

    // druhá sada područek
    if (n === "armrest_l2" || n === "armrest_p2") {
      o.visible = isSecondArmrest;
      return;
    }

    // nohy — tady se natvrdo schová druhá sada
    if (allManchesterLegs.has(n)) {
      o.visible = chosenLegName
        ? n === chosenLegName
        : n === "legs_n21";

      return;
    }
  });

  root.updateMatrixWorld?.(true);
}

function applyMelbourneVisibility(root, { legCode } = {}) {
  if (!root) return;

  const vid = String(root?.userData?.variantId || "").toLowerCase();
  if (!vid.startsWith("melbourne_")) return;

  const ensureMelbourneBackrestState = () => {
    if (root.userData._melbourneBackrestState) return root.userData._melbourneBackrestState;

    const st = { p: 1, l: 1, s: 1 };
    const key = vid.replace(/^melbourne_/, "");

    if (key === "2" || key === "2l") st.p = 2;
    else if (key === "2m" || key === "2p") st.l = 2;
    else if (key === "3" || key === "3l" || key === "3m" || key === "3p") st.s = 2;

    root.userData._melbourneBackrestState = st;
    return st;
  };

  const setByBase = (baseLower, visible) => {
    root.traverse((o) => {
      const n = (o?.name || "").toLowerCase();
      if (!n) return;
      if (n === baseLower || n.startsWith(baseLower + ".") || n.startsWith(baseLower + "_")) {
        o.visible = visible;
      }
    });
  };

  const st = ensureMelbourneBackrestState();

  root.traverse((o) => {
    const n = (o?.name || "").toLowerCase();
    if (!n) return;

    if (o.isMesh && n.includes("paspule")) {
      o.userData.materialRole = "paspule";
      if (!selectedPaspuleFabric?.baseColorUrl) {
        o.material = MAT_PASPULE.clone();
        o.userData.originalMaterial = o.material.clone();
        o.material.needsUpdate = true;
      }
    }

    if (
      n === "body" ||
      n === "seat" ||
      n.startsWith("seat_") ||
      n === "paspule" ||
      n === "plane" ||
      n === "armrest_l" ||
      n === "armrest_p" ||
      n === "paspule001" ||
      n === "paspule003"
    ) {
      o.visible = true;
      return;
    }

    if (n === "cube") {
      o.visible = false;
      return;
    }
  });

  for (const k of ["p", "l", "s"]) {
    const isUp = st?.[k] === 2;
    setByBase(`backrest_1${k}`, !isUp);
    setByBase(`backrest_2${k}`, isUp);
    setByBase(`paspule_1${k}`, !isUp);
    setByBase(`paspule_2${k}`, isUp);
    setByBase(`hinge_${k}`, isUp);
  }

  const leg = String(legCode || "N9").toUpperCase();
  const allowedLegs = new Set(["legs_n9", "legs_n21", "legs_n1", "legs_n11", "n9", "n21", "n1", "n11"]);

  root.traverse((o) => {
    if (!o?.isMesh) return;
    const n = (o.name || "").toLowerCase();
    if (!allowedLegs.has(n)) return;
    o.visible = n === `legs_${leg.toLowerCase()}` || n === leg.toLowerCase();
  });
}

// -----------------------------------------------------
//  PĹ™idĂˇnĂ­ modulu + generovĂˇnĂ­ tlaÄŤĂ­tek
// -----------------------------------------------------

async function addModule(
  moduleName,
  position,
  variantId,
  replaceTarget = null,
  replaceRecord = null,   // âś… NOVĂ‰
  connectDirection = null,
  connectBaseModule = null
) {
  moduleName = (moduleName ?? "").trim();
  variantId = (variantId ?? "").trim();

  // Skryj start button
  if (startButton) startButton.visible = false;

  // REPLACE (odeber starĂ˝ mesh ze scĂ©ny)
  if (replaceTarget) {
  // nejdĹ™Ă­v uklidit headrest puntĂ­ky starĂ©ho modulu
    removeHeadrestDotsForModule(replaceTarget);
    scene.remove(replaceTarget);
  }

  // CREATE MODULE (z cache GLB mĂ­sto moduleTemplates)
  const sofaFolder =
    (typeof normalizeSofaKey === "function" ? normalizeSofaKey(appState?.model) : "") ||
    getSofaFolderFromModelName(moduleName);

  const url = `/models/${sofaFolder}/${moduleName}.glb`;
  const gltf = await loadGLBCached(url);

  const moduleMesh = gltf.scene.clone(true);

  // âś… DĹ®LEĹ˝ITĂ‰: variantId hned, aĹĄ to applyDefaultMaterials poznĂˇ (Mendoza vs Manila)
  moduleMesh.userData.variantId = (variantId ?? "").trim();

  // aplikuj naĹˇe materiĂˇly hned po klonu
  applyDefaultMaterials(moduleMesh);

  moduleMesh.position.copy(position);
  moduleMesh.userData.isModule = true;
  moduleMesh.userData.moduleName = moduleName;
  moduleMesh.name = "Module";

  scene.add(moduleMesh);

  moduleMesh.updateMatrixWorld(true);

  forceLegsOnly(moduleMesh, selectedLegs || "N7");
  forceArmrestsOnly(moduleMesh, selectedArmrests || "smooth");
  applyHingeMaterial(moduleMesh, selectedHinges || "standard");

  // âś… Mendoza: viditelnost body1/body2, hinge2, legs_ vs N* podle podruÄŤek
  applyMendozaVisibility(moduleMesh, {
    armrestType: selectedArmrests || "smooth",
    legCode: selectedLegs || "N8",
  });

  applyMelbourneVisibility(moduleMesh, {
    legCode: selectedLegs || "N9",
  });

  applyManchesterVisibility(moduleMesh, {
    armrestType: selectedArmrests || "smooth",
    legCode: selectedLegs || "N21",
  });

  moduleMesh.updateMatrixWorld(true);
  moduleMesh.traverse((o) => {
    if (o.updateMatrixWorld) o.updateMatrixWorld(true);
  });

  setupHeadrestDotsForModule(moduleMesh);

  // uloĹľit originalMaterial pro kaĹľdĂ˝ mesh (pro hover reset) â€“ MUSĂŤ bĂ˝t clone
  moduleMesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;

    if (Array.isArray(o.material)) {
      o.userData.originalMaterial = o.material.map((m) => m?.clone?.() ?? m);
    } else {
      o.userData.originalMaterial = o.material.clone ? o.material.clone() : o.material;
    }
  });

  // najĂ­t snapMesh v klonovanĂ©m modelu
  moduleMesh.userData.snapMesh = null;
  moduleMesh.traverse((o) => {
    if (o.isMesh && o.name.toLowerCase().includes("seat")) {
      moduleMesh.userData.snapMesh = o;
    }
  });

  // âś… pokud nÄ›kdo v connections ukazuje na starĂ˝ mesh, pĹ™esmÄ›ruj to na novĂ˝
  if (replaceTarget) {
    activeModules.forEach((r) => {
      if (!r?.connections) return;
      ["left", "right", "front", "back"].forEach((dir) => {
        if (r.connections[dir] === replaceTarget) {
          r.connections[dir] = moduleMesh;
        }
      });
    });
  }

  // âś… FIX: kdyĹľ je replace, nepĹ™idĂˇvej novĂ˝ record â€“ pĹ™epiĹˇ ten pĹŻvodnĂ­
  const record = replaceRecord || {
    name: (variantId ?? "").trim(), // varianta (Manila_2XM)
    model: moduleName,              // GLB (Manila_2M)
    mesh: moduleMesh,
    pos: position.clone(),
    connections: { left: null, right: null, front: null, back: null },
    buttons: {},
  };

  if (replaceRecord) {
    // âś… NEJDĹ®LEĹ˝ITÄšJĹ ĂŤ oprava pro reload:
    // zaktualizuj record, aby se uklĂˇdal novĂ˝ model/varianta (ne starĂ˝)
    record.name = (variantId ?? "").trim();
    record.model = moduleName;
    record.mesh = moduleMesh;
    record.pos = position.clone();
    record.buttons = {};
  } else {
    activeModules.push(record);

    // prĹŻbÄ›ĹľnÄ› si pĹ™iprav canonical analĂ˝zu pro krok 2 -> 3
    if (isBuildStepActive()) {
      scheduleCanonicalRebuildAnalysis();
    }
  }

  // âś… TEPRVE TEÄŽ: novĂ˝ modul uĹľ je v activeModules (nebo je replaceRecord pĹ™epsanĂ˝)
  const legsColorId = document.getElementById("legsColorSelect")?.value;
  if (legsColorId) {
    const legCode = String(selectedLegs || "").toUpperCase();
    const isMetalLeg = (legCode === "N1" || legCode === "N8" || legCode === "N11" || legCode === "N21"); // kovovĂ© nohy

    if (isMetalLeg) {
      applyMetalColorToAllLegs(legsColorId);
    } else {
      await applyWoodColorToAllLegs(legsColorId);
    }
  }

  applyShelfColorToMelbournePlanes(selectedShelfColor || "wood_buk_br_281");
  syncMelbourneShelfTabVisibility();

  // panty uĹľ aplikujeĹˇ pĹ™Ă­mo na moduleMesh vĂ˝Ĺˇ (applyHingeMaterial),
  // ale pokud chceĹˇ "pojistku" pro celou scĂ©nu, nech to tady:
  if (typeof applyHingesToAllModules === "function") {
    applyHingesToAllModules();
  }

  // CREATE BUTTONS (jen pokud mĂˇ mĂ­t tlaÄŤĂ­tka)
  if (shouldHaveButtons(variantId)) {
    const cleanId = normalizeOffsetKey(variantId);
    const offsets = getModuleAddButtonOffsets()[cleanId] || [];

    for (const item of offsets) {
      const worldPos = moduleMesh.localToWorld(item.offset.clone());
      const btn = await createButtonAt(
        worldPos,
        moduleMesh,
        item.direction,
        item.rotY || 0,
        item.shift || null,
        item.shiftByModule || null
      );

      record.buttons[item.direction] = btn;

      activeButtons.push({
        mesh: btn,
        parentModule: moduleMesh,
        direction: item.direction,
        rotY: item.rotY || 0,
        shift: item.shift ? item.shift.clone() : null,
      });
    }
  }

  updateButtons();
  scheduleSummaryRecalc();

  recomputeCameraFit();
  if (!camera || !controls) return;

  saveStateDebounced();
  return moduleMesh;
}

function connectModules(base, other, direction) {
  const opp = oppositeDirection(direction);

  // zapiĹˇ spojenĂ­ do obou modulĹŻ
  base.connections[direction] = other;
  other.connections[opp] = base;
}

function resetSceneState() {
  // zavĹ™Ă­t UI a blokery (aĹĄ ti nic "neĹľere" kliky)
  closeActionMenu();
  document.getElementById("actionMenuBlocker")?.classList.remove("active");
  document.getElementById("modulePicker")?.classList.add("hidden");

  // reset hover/drag stavĹŻ
  clearHoverEffects?.();
  downCandidate = null;
  mouseDown = false;
  dragDistance = 0;

  // odstranit starĂ˝ start button (!!!)
  if (startButton) {
    scene.remove(startButton);
    startButton.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach(m => m?.dispose?.());
        else o.material?.dispose?.();
      }
    });
    startButton = null;
  }

  // odstranit vĹˇechny moduly
  activeModules.forEach(m => { if (m.mesh) scene.remove(m.mesh); });

  // odstranit vĹˇechna tlaÄŤĂ­tka
  activeButtons.forEach(b => { if (b.mesh) scene.remove(b.mesh); });

  for (const rec of activeModules) {
    if (rec?.mesh) removeHeadrestDotsForModule(rec.mesh);
  }
  headrestDots.length = 0;
  hoveredHeadrestDot = null;

  activeModules.length = 0;
  activeButtons.length = 0;

  // reset promÄ›nnĂ˝ch pro klikĂˇnĂ­
  downCandidate = null;
  hoveredModule = null;
  hoveredButton = null;
  selectedModule = null;

  createButtonAt(new THREE.Vector3(0, 0, 0)).then(btn => {
    startButton = btn;
    startButton.userData.isStartButton = true;

    // viditelnĂ© jen kdyĹľ je scĂ©na prĂˇzdnĂˇ
    startButton.visible = (activeModules.length === 0);
  });

  recomputeCameraFit();
  debugLog("RESET hotovĂ˝");

  updateSummaryUI();
  scheduleSummaryRecalc();
  saveStateDebounced();
}

async function disconnectModule(root) {
  const rec = activeModules.find((m) => m.mesh === root);
  if (!rec) return;

  const neighbors = [];

  for (const side of ["left", "right", "front", "back"]) {
    const neighborMesh = rec.connections[side];
    if (!neighborMesh) continue;

    neighbors.push({ side, neighborMesh });

    const neighborRec = activeModules.find((m) => m.mesh === neighborMesh);
    if (neighborRec) {
      const neighborSide = getConnectionSide(neighborRec.mesh, rec.mesh);
      neighborRec.connections[neighborSide] = null;
    }

    rec.connections[side] = null;
  }

  // regenerace tlaÄŤĂ­tek u sousedĹŻ podle uloĹľenĂ˝ch dat
  for (const { side, neighborMesh } of neighbors) {
    const neighborRec = activeModules.find((m) => m.mesh === neighborMesh);
    if (!neighborRec) continue;

    const opp = oppositeDirection(side);
    if (!neighborRec.buttons[opp]) {
      const offsets = getModuleAddButtonOffsets()[normalizeOffsetKey(neighborRec.name)] || [];
      const offsetDef = offsets.find((o) => o.direction === opp);
      if (!offsetDef) continue;

      const worldPos = neighborRec.mesh.localToWorld(offsetDef.offset.clone());
      const newBtn = await createButtonAt(worldPos, neighborRec.mesh, opp);

      neighborRec.buttons[opp] = newBtn;
      activeButtons.push({ mesh: newBtn, parentModule: neighborRec.mesh, direction: opp });
    }
  }

  saveStateDebounced();

}

function updateButtons() {
  // âś… TlaÄŤĂ­tka (plusy) smĂ­ bĂ˝t vidÄ›t jen ve STEP 2
  const buildEnabled = isBuildStepActive();

  // 1) defaultnÄ› nastav viditelnost podle toho, jestli jsem ve step 2
  activeButtons.forEach((b) => {
    const mesh = b?.mesh || b;
    if (mesh) mesh.visible = buildEnabled;
  });

  // kdyĹľ nejsem ve step 2, tak uĹľ nic dalĹˇĂ­ho neĹ™eĹˇ (ĹľĂˇdnĂ© â€śzobrazovĂˇnĂ­â€ť)
  if (!buildEnabled) return;

  // 2) ve step 2 schovej tlaÄŤĂ­tka tam, kde uĹľ je spojenĂ­
  for (const module of activeModules) {
    const con = module.connections;
    const btns = module.buttons;
    if (!btns) continue;

    if (con.left && btns.left) btns.left.visible = false;
    if (con.right && btns.right) btns.right.visible = false;
    if (con.front && btns.front) btns.front.visible = false;
    if (con.back && btns.back) btns.back.visible = false;
  }
}

function computeTotalsFromActiveModules() {
  // Cena
  let totalPrice = 0;

  for (const rec of activeModules) {
    const upgradeKey = getUpgradeKeyForRec(rec);
    totalPrice += getSummaryPriceForRecSafe(rec, getAppliedFabricPriceGroup(), upgradeKey);
  }

  // RozmÄ›ry sestavy z reĂˇlnĂ˝ch meshĹŻ (nejpĹ™esnÄ›jĹˇĂ­)
  const box = new THREE.Box3();
  let hasAny = false;

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;
    box.expandByObject(rec.mesh);
    hasAny = true;
  }

  if (!hasAny) {
    return { totalPrice, dimsCm: { w: 0, d: 0, h: 0 } };
  }

  const size = new THREE.Vector3();
  box.getSize(size); // v jednotkĂˇch scĂ©ny (u tebe to vypadĂˇ jako metry)

  // pĹ™evod na cm (pokud 1 jednotka = 1 metr)
  const dimsCm = {
    w: Math.round(size.x * 100),
    d: Math.round(size.z * 100),
    h: Math.round(size.y * 100),
  };

  return { totalPrice, dimsCm };
}

// =====================================================
//  SUMMARY: nĂˇzev + odkaz podle vybranĂ©ho modelu
// =====================================================
const SOFA_SUMMARY_META = {
  Manila: {
    title: "Manila",
    url: "https://madros.cz/soupravy-na-miru/161-manila-sedaci-souprava.html",
  },
  Mendoza: {
    title: "Mendoza",
    url: "https://madros.cz/soupravy-na-miru/218-mendoza.html",
  },
  Melbourne: {
    title: "Melbourne",
    url: "https://madros.cz/soupravy-na-miru/158-melbourne-sedaci-souprava.html",
  },
  Manchester: {
    title: "Manchester",
    url: "https://madros.cz/soupravy-na-miru/160-manchester.html",
  },
};

function getActiveSofaKeyFromScene() {
  // 1) kdyĹľ je prĂˇzdnĂˇ scĂ©na (jeĹˇtÄ› ĹľĂˇdnĂ˝ modul), vezmi vybranĂ˝ model z appState
  const fromModel = appState?.model;
  if (fromModel) {
    const s = String(fromModel).trim();
    if (s) {
      // "MANILA" -> "Manila", "MENDOZA" -> "Mendoza"
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    }
  }

  // 2) jinak ber prvnĂ­ modul ve scĂ©nÄ› a vezmi prefix pĹ™ed prvnĂ­m podtrĹľĂ­tkem
  const first = activeModules?.[0]?.name;
  if (!first) return "Manila"; // fallback
  return String(first).split("_")[0] || "Manila";
}

function isSummaryDepth1DVariant(variantId) {
  const v = String(variantId || "").trim().toUpperCase();
  return (
    v.endsWith("_1D_L") ||
    v.endsWith("_1XD_L") ||
    v.endsWith("_1D_P") ||
    v.endsWith("_1XD_P")
  );
}

function getSummaryBranchCountSafe() {
  try {
    const fromUi = Number(document.getElementById("sofaDimsRows")?.dataset?.branches);
    if (Number.isFinite(fromUi) && fromUi > 0) return fromUi;
  } catch (e) {}

  try {
    if (typeof detectBranchCount === "function") {
      const fallback = Number(detectBranchCount());
      if (Number.isFinite(fallback) && fallback > 0) return fallback;
    }
  } catch (e) {}

  return 1;
}

function getSummaryPlanNodeKey(node) {
  try {
    const root = getModuleRoot(node?.root || node?.rec?.mesh || node?.mesh || null);
    return root?.uuid || node?.root?.uuid || node?.rec?.mesh?.uuid || null;
  } catch (e) {
    return null;
  }
}

function getSummaryDepthDimKeyForRecSafe(rec) {
  try {
    const variantId = rec?.name;
    if (!isSummaryDepth1DVariant(variantId)) return null;

    const branchCount = getSummaryBranchCountSafe();
    if (branchCount >= 4) return "D";
    if (branchCount === 2) return "B";
    if (branchCount !== 3) return null;

    if (
      typeof window === "undefined" ||
      typeof window.__getConnectedPlanNodes !== "function" ||
      typeof window.__getMainWidthAxisNodes !== "function" ||
      typeof window.__getSideDepthAxisNodes !== "function"
    ) {
      return null;
    }

    const recKey = getModuleRoot(rec?.mesh || null)?.uuid || null;
    if (!recKey) return null;

    const nodes = window.__getConnectedPlanNodes() || [];
    const widthAxisNodes = window.__getMainWidthAxisNodes(nodes) || [];
    const depthAxes = window.__getSideDepthAxisNodes(nodes, widthAxisNodes) || {};

    const leftKeys = new Set((depthAxes.left || []).map(getSummaryPlanNodeKey).filter(Boolean));
    const rightKeys = new Set((depthAxes.right || []).map(getSummaryPlanNodeKey).filter(Boolean));

    if (leftKeys.has(recKey)) return "L";
    if (rightKeys.has(recKey)) return "R";
  } catch (e) {}

  return null;
}

function getSummaryPriceForRecSafe(rec, fabricId, baseUpgradeKey, options = {}) {
  const variantId = rec?.name;
  if (!variantId) return 0;

  const upgradeKey = baseUpgradeKey || null;
  const effectiveUpgradeKey = getManchesterArmrestPriceKey(variantId, fabricId, upgradeKey, {
    armrestType: options.armrestType ?? selectedArmrests,
    modelKey: options.modelKey || getVariantModelKey(variantId) || getModelKey(),
    disabled: Boolean(options.disableManchesterArmrest),
  });
  const fallbackPrice = getModulePrice(variantId, fabricId, effectiveUpgradeKey) || 0;

  try {
    if (!isSummaryDepth1DVariant(variantId)) return fallbackPrice;

    const dimKey = getSummaryDepthDimKeyForRecSafe(rec);
    const currentDepth = Number(dimKey ? window.__sofaDims?.[dimKey] : NaN);
    const isExtended = Number.isFinite(currentDepth) && currentDepth > 180;
    const cat = getCatalog?.(variantId);
    const extendedBase = cat?.upgradePrices?.extendedBase?.[fabricId];
    const extendedStorage = cat?.upgradePrices?.extendedStorage?.[fabricId];
    const extendedArmrest = cat?.upgradePrices?.extendedArmrest?.[fabricId];

    if (!isExtended) return fallbackPrice;

    if (effectiveUpgradeKey === "armrest") {
      if (extendedArmrest != null && Number.isFinite(Number(extendedArmrest)) && Number(extendedArmrest) > 0) {
        return Number(extendedArmrest);
      }
      return fallbackPrice;
    }

    if (upgradeKey === "storage") {
      if (extendedStorage != null && Number.isFinite(Number(extendedStorage)) && Number(extendedStorage) > 0) {
        return Number(extendedStorage);
      }
      return fallbackPrice;
    }

    if (upgradeKey) return fallbackPrice;

    if (extendedBase != null && Number.isFinite(Number(extendedBase)) && Number(extendedBase) > 0) {
      return Number(extendedBase);
    }
  } catch (e) {}

  return fallbackPrice;
}

function ensureSummaryRangeLayout() {
  const legacyRangeEl = document.getElementById("sumDimsRange");
  const legacyPreviewEl = document.getElementById("sumDims");

  if (legacyPreviewEl) {
    const previewLine = legacyPreviewEl.closest(".line");
    if (previewLine) previewLine.style.display = "none";
  }

  const rangeLine = legacyRangeEl?.closest(".line");
  if (rangeLine && !rangeLine.dataset.splitRangeReady) {
    rangeLine.classList.add("summaryRangeBlock");
    rangeLine.innerHTML = `
      <span class="summaryRangeTitle">Rozměr:</span>
      <div class="summaryMetrics">
        <div class="line summaryMetric">
          <span class="summaryMetricLabel">Šířka:</span>
          <span class="hint">
            <span id="sumWidthRange" class="hintValue">0–0 cm</span>
            <span class="qmark">?</span>
            <span class="tooltip">Šířka udává celkový rozměr sestavy zleva doprava při pohledu na její přední stranu. Za přední stranu se považuje hlavní, nejdelší strana sestavy.</span>
          </span>
        </div>
        <div class="line summaryMetric">
          <span class="summaryMetricLabel">Hloubka:</span>
          <span class="hint">
            <span id="sumDepthRange" class="hintValue">0–0 cm</span>
            <span class="qmark">?</span>
            <span class="tooltip">Hloubka udává celkový rozměr sestavy zepředu dozadu při pohledu na její přední stranu. Za přední stranu se považuje hlavní, nejdelší strana sestavy.</span>
          </span>
        </div>
      </div>
    `;
    rangeLine.dataset.splitRangeReady = "1";
  }

  return {
    widthRangeEl: document.getElementById("sumWidthRange"),
    depthRangeEl: document.getElementById("sumDepthRange"),
  };
}

function getSummaryDisplayOrientationSafe() {
  try {
    const nodes =
      (typeof window !== "undefined" && typeof window.__getConnectedPlanNodes === "function")
        ? window.__getConnectedPlanNodes()
        : [];

    if (!Array.isArray(nodes) || !nodes.length) return "front";

    const orientation =
      (typeof window !== "undefined" && typeof window.__getPlanRenderOrientation === "function")
        ? window.__getPlanRenderOrientation(nodes)
        : "front";

    return ["front", "right", "back", "left"].includes(orientation) ? orientation : "front";
  } catch (e) {
    return "front";
  }
}

function updateSummaryUI() {
  const priceEl = document.getElementById("sumPrice");
  const { widthRangeEl, depthRangeEl } = ensureSummaryRangeLayout();
  if (!priceEl || !widthRangeEl || !depthRangeEl) return;

  // ===== 0) MODEL: nĂˇzev + odkaz v Summary =====
  const sofaLinkEl = document.getElementById("sumSofaLink");
  const sofaNameEl = document.getElementById("sumSofaName");

  const sofaKey = getActiveSofaKeyFromScene();
  const meta = SOFA_SUMMARY_META[sofaKey] || SOFA_SUMMARY_META.Manila;

  if (sofaLinkEl) sofaLinkEl.href = meta.url;
  if (sofaNameEl) sofaNameEl.textContent = meta.title;

  // âś… kdyĹľ ve scĂ©nÄ› nic nenĂ­ â†’ vĹˇe na nulu a konec
  if (activeModules.length === 0) {
    renderPriceWithDiscount(priceEl, 0);
    widthRangeEl.textContent = "0–0 cm";
    depthRangeEl.textContent = "0–0 cm";
    return;
  }

  // ===== 1) CENA (bere potah + pĹ™Ă­platky per modul) =====
  let sumPrice = 0;

  for (const rec of activeModules) {
    const variantId = rec?.name;
    if (!variantId) continue;

    // zjisti vybranĂ˝ pĹ™Ă­platek pro tenhle konkrĂ©tnĂ­ mesh
    let choice = "none";
    if (rec?.mesh) {
      choice = extrasChoiceByModuleUuid.get(rec.mesh.uuid) || "none";
    }

    // normalizace
    if (choice === "unset") choice = "none";
    if (choice === "sleep") choice = "bed"; // kdyby nÄ›kde zĹŻstalo starĂ©

    // pĹ™evod na upgrade key pro getModulePrice
    const upgradeKey =
      (choice === "bed" || choice === "bed2" || choice === "storage") ? choice : null;

    sumPrice += getSummaryPriceForRecSafe(rec, getAppliedFabricPriceGroup(), upgradeKey);
  }

  renderPriceWithDiscount(priceEl, sumPrice);
  updateFabricCategoryTabPrices();
  refreshManchesterArmrestPriceLabels();

  // ===== 2) ROZMÄšRY: NOMINĂLNĂŤ (z connections), ne z reĂˇlnĂ˝ch world pozic =====

  function getFootprintDimsCm(rec, mode /* "min"|"max"|undefined */) {
    const v = getCatalog(rec?.name);
    if (!v) return { w: 0, d: 0 };

    const isX = /(^|_)X/.test(rec?.name || "");
    const dims = isX
      ? (v.xDimsCm || v.dimsCm || v.baseDimsCm)
      : (v.baseDimsCm || v.dimsCm || v.xDimsCm);

    let d = Number(dims?.d || 0);

    // âś… pokud mĂˇ modul nastavitelnou hloubku (napĹ™. 1D), pouĹľij ji pro RANGE min/max
    if (v.depthRangeCm && (mode === "min" || mode === "max")) {
      const dMin = Number(v.depthRangeCm.min);
      const dMax = Number(v.depthRangeCm.max);
      if (Number.isFinite(dMin) && Number.isFinite(dMax) && dMin > 0 && dMax > 0) {
        d = (mode === "min") ? dMin : dMax;
      }
    }

    return { w: Number(dims?.w || 0), d };
  }

  function getFootprintWidthRangeCm(rec) {
    const v = getCatalog(rec?.name);
    if (!v) return { min: 0, max: 0 };

    // v katalogu je to uloĹľenĂ© pĹ™Ă­mo pro KAĹ˝DOU variantu zvlĂˇĹˇĹĄ:
    // base varianta mĂˇ seatWidthRangeCm = baseRangeCm
    // X varianta mĂˇ seatWidthRangeCm = xRangeCm
    const r = v.seatWidthRangeCm;

    // fallback kdyby nÄ›co chybÄ›lo -> vezmi pevnou ĹˇĂ­Ĺ™ku z dims
    const dims = getFootprintDimsCm(rec);
    const min = (r?.min != null) ? r.min : dims.w;
    const max = (r?.max != null) ? r.max : dims.w;

    return { min, max };
  }

  function worldFootprintHalfExtents(rec) {
    let { w, d } = getFootprintDimsCm(rec);
    const hw = w / 2;
    const hd = d / 2;

    // otoÄŤenĂ­ o 90Â°? (lokĂˇlnĂ­ "right" mĂ­Ĺ™Ă­ do world front/back)
    const root = getModuleRoot(rec.mesh);
    const wr = dirFromModuleToWorld(root, "right");
    const rotated90 = (wr === "front" || wr === "back");

    return rotated90 ? { hx: hd, hz: hw } : { hx: hw, hz: hd };
  }

  // âś… 1D_L (a obecnÄ› moduly s d > 103) jsou asymetrickĂ©: extra dĂ©lka jde jen "dopĹ™edu"
  function shiftedCenterForAsymDepth(meshRoot, rec, p) {
    const { d } = getFootprintDimsCm(rec);

    // standardnĂ­ hloubka celĂ© sestavy (vÄ›tĹˇina modulĹŻ)
    const STANDARD_D = 102;

    // nic neposouvĂˇme
    if (!(d > STANDARD_D)) return p;

    // posun o polovinu "extra" hloubky (napĹ™. 180 -> shift 38.5)
    const shift = (d - STANDARD_D) / 2;

    // kam mĂ­Ĺ™Ă­ lokĂˇlnĂ­ "front" modulu ve world?
    const frontWorld = dirFromModuleToWorld(meshRoot, "front");

    let x = p.x;
    let z = p.z;

    if (frontWorld === "front") z += shift;
    else if (frontWorld === "back") z -= shift;
    else if (frontWorld === "right") x += shift;
    else if (frontWorld === "left") x -= shift;

    return { x, z };
  }

  function worldJoinHalfExtents(rec) {
    // stejnĂ© jako footprint, ale "napojovacĂ­ hloubka" pro 1D je jen 103 cm
    let { w, d } = getFootprintDimsCm(rec);

    const id = rec?.name || "";
    const isChaise1D = /(^|_)1D(_|$)/.test(id);

    if (isChaise1D && d) {
      d = Math.min(d, 102); // 1D se napojuje standardnĂ­ hloubkou (pĹ™esah neovlivnĂ­ posun)
    }

    const hw = w / 2;
    const hd = d / 2;

    const root = getModuleRoot(rec.mesh);
    const wr = dirFromModuleToWorld(root, "right");
    const rotated90 = (wr === "front" || wr === "back");

    return rotated90 ? { hx: hd, hz: hw } : { hx: hw, hz: hd };
  }

  // 1) rychlĂˇ mapka mesh -> record
  const byMesh = new Map(activeModules.map(r => [getModuleRoot(r.mesh), r]));

  // 2) BFS: vypoÄŤĂ­tĂˇme "nominĂˇlnĂ­" stĹ™edy v cm (nezĂˇvislĂ© na overlapu)
  const anchor = pickAnchorRecord();
  if (!anchor) {
    widthRangeEl.textContent = "0–0 cm";
    depthRangeEl.textContent = "0–0 cm";
    return;
  }

  const posCm = new Map(); // rootMesh -> { x, z } v cm
  const q = [];

  const anchorRoot = getModuleRoot(anchor.mesh);
  posCm.set(anchorRoot, { x: 0, z: 0 });
  q.push(anchorRoot);

  while (q.length) {
    const curMesh = q.shift();
    const curRec = byMesh.get(curMesh);
    if (!curRec?.connections) continue;

    const curJoin = worldJoinHalfExtents(curRec);
    const curPos = posCm.get(curMesh);

    for (const localSide of ["left", "right", "front", "back"]) {
      const nbMeshRaw = curRec.connections[localSide];
      if (!nbMeshRaw) continue;

      const nbRoot = getModuleRoot(nbMeshRaw);
      const nbRec = byMesh.get(nbRoot);
      if (!nbRec) continue;

      // pĹ™evedeme "localSide" na WORLD smÄ›r (right/left/front/back)
      const worldDir = dirFromModuleToWorld(curMesh, localSide);
      const nbJoin = worldJoinHalfExtents(nbRec);

      // nominĂˇlnĂ­ posun stĹ™edĹŻ = souÄŤet pĹŻl-rozmÄ›rĹŻ (ignorujeme overlap)
      let nx = curPos.x;
      let nz = curPos.z;

      if (worldDir === "right") nx += (curJoin.hx + nbJoin.hx);
      if (worldDir === "left")  nx -= (curJoin.hx + nbJoin.hx);
      if (worldDir === "front") nz += (curJoin.hz + nbJoin.hz);
      if (worldDir === "back")  nz -= (curJoin.hz + nbJoin.hz);

      // pokud jeĹˇtÄ› nemĂˇ pozici, zapiĹˇ a pokraÄŤuj BFS
      if (!posCm.has(nbRoot)) {
        posCm.set(nbRoot, { x: nx, z: nz });
        q.push(nbRoot);
      }
    }
  }

  // 3) z nominĂˇlnĂ­ch stĹ™edĹŻ udÄ›lĂˇme extenty a finĂˇlnĂ­ W/D
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const [mesh, p] of posCm.entries()) {
    const rec = byMesh.get(mesh);
    if (!rec) continue;

    const { hx, hz } = worldFootprintHalfExtents(rec);

    // âś… posuĹ mÄ›Ĺ™icĂ­ stĹ™ed pro asymetrickĂ© moduly (typicky 1D_L)
    const pc = shiftedCenterForAsymDepth(mesh, rec, p);

    minX = Math.min(minX, pc.x - hx);
    maxX = Math.max(maxX, pc.x + hx);
    minZ = Math.min(minZ, pc.z - hz);
    maxZ = Math.max(maxZ, pc.z + hz);
  }
  // ===== ARMREST RANGE CORRECTION (aplikuje se jen na ROZSAH minâ€“max) =====
  // KatalogovĂ© ĹˇĂ­Ĺ™ky "end" modulĹŻ jsou dÄ›lanĂ© s nÄ›jakou BASE ĹˇĂ­Ĺ™kou podruÄŤky (napĹ™. 25 cm).
  // Tady udÄ›lĂˇme korekci: (selected - base) na kaĹľdĂ© WORLD stranÄ›, kde podruÄŤka reĂˇlnÄ› existuje.
  // DĹŻleĹľitĂ©: kdyĹľ je U a jsou 2 podruÄŤky na stejnĂ© WORLD stranÄ›, zapoÄŤĂ­tĂˇ se to jen jednou.

  const ARMREST_RANGE_RULES = {
    MENDOZA: {
      baseCm: 25,
      // selectedArmrests = "smooth" nebo "sharp"
      types: {
        // Mendoza: "smooth" = hranatá nastavitelná 10–25
        smooth: { kind: "variable", min: 10, max: 25, defaultCm: 25 },

        // Mendoza: "sharp" = polohovací pevná 33
        sharp:  { kind: "fixed", valueCm: 33 },
      },
    },

    MANILA: {
      baseCm: 20,
      types: {
        // Manila: "smooth" = kulatá pevná 14
        smooth: { kind: "fixed", valueCm: 14 },

        // Manila: "sharp" = hranatá nastavitelná 10–25
        sharp:  { kind: "variable", min: 10, max: 25, defaultCm: 20 },
      },
    },

    MELBOURNE: {
      baseCm: 13,
      types: {
        smooth: { kind: "fixed", valueCm: 13 },
      },
    },

    MANCHESTER: {
      // Manchester má v catalogue.js rozměry počítané s područkou 40 cm.
      // SummaryUI tedy musí počítat delta: zvolená šířka - 40.
      //
      // smooth = Polohovací: 30 / 35 / 40 cm
      // sharp  = Hranatá:    15 / 20 / 25 cm
      baseCm: 40,
      types: {
        smooth: { kind: "variable", min: 30, max: 40, defaultCm: 40 },
        sharp:  { kind: "variable", min: 15, max: 25, defaultCm: 25 },
      },
    },
  };

  function getSceneModelKeyFromModules() {
    const n = activeModules?.[0]?.name || "";
    // rec.name vypadá jako "Manila_..." / "Mendoza_..." / "Manchester_..."
    return (n.split("_")[0] || String(appState?.model || "")).toUpperCase();
  }

  function getSelectedArmrestWidthCm(modelKey, armrestType) {
    const rules = ARMREST_RANGE_RULES[modelKey];
    if (!rules) return null;

    const t = String(armrestType || "smooth").trim().toLowerCase();
    const typeRule = rules.types?.[t];
    if (!typeRule) return null;

    if (typeRule.kind === "fixed") {
      return Number(typeRule.valueCm);
    }

    // DŮLEŽITÉ:
    // Nové UI ukládá aktuální hodnotu do window.selectedArmrestWidth.
    // selectedArmrestSharpWidthCm tam může zůstat jako starší/fallback hodnota.
    const raw = Number(
      window.selectedArmrestWidth ||
      window.selectedArmrestSharpWidthCm ||
      selectedArmrestSharpWidthCm ||
      typeRule.defaultCm
    );

    const fallback = Number(typeRule.defaultCm);
    const v = Number.isFinite(raw) ? raw : fallback;

    return Math.max(typeRule.min, Math.min(typeRule.max, v));
  }

  function getSelectedArmrestWidthCm(modelKey, armrestType) {
    const rules = ARMREST_RANGE_RULES[modelKey];
    if (!rules) return null;

    const t = (armrestType || "smooth").toLowerCase();
    const typeRule = rules.types?.[t];
    if (!typeRule) return null;

    if (typeRule.kind === "fixed") return Number(typeRule.valueCm);

    // variable: bere se z globĂˇlnĂ­ho slider stavu (u tebe: selectedArmrestSharpWidthCm)
    const raw = Number(window.selectedArmrestSharpWidthCm);
    const fallback = Number(typeRule.defaultCm);

    const v = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.max(typeRule.min, Math.min(typeRule.max, v));
    return clamped;
  }

  function computeArmrestRangeDeltaByWorldSide() {
    const modelKey = getSceneModelKeyFromModules();
    const rules = ARMREST_RANGE_RULES[modelKey];
    if (!rules) {
      return { left: 0, right: 0, front: 0, back: 0 };
    }

    // Zjisti, na kterĂ˝ch WORLD stranĂˇch podruÄŤka reĂˇlnÄ› je (aspoĹ jedna)
    const present = { left: false, right: false, front: false, back: false };

    for (const rec of activeModules) {
      if (!rec?.mesh) continue;

      const role = getRole(rec.name);
      if (role !== "L" && role !== "P") continue; // "end" moduly (L/P) â€” viz filterIdsByTab(end) :contentReference[oaicite:1]{index=1}

      // L = lokĂˇlnÄ› levĂˇ strana modulu, P = lokĂˇlnÄ› pravĂˇ strana modulu
      const localSide = (role === "L") ? "left" : "right";

      const root = getModuleRoot(rec.mesh);
      const worldSide = dirFromModuleToWorld(root, localSide); // "left/right/front/back"
      if (worldSide && present.hasOwnProperty(worldSide)) {
        present[worldSide] = true;
      }
    }

    const selectedType = (window.selectedArmrests || "smooth"); // u tebe selectedArmrests se uklĂˇdĂˇ do tĂ©to promÄ›nnĂ©
    const selectedCm = getSelectedArmrestWidthCm(modelKey, selectedType);

    // Pokud nejsme schopni urÄŤit selected, nic neupravuj
    if (!Number.isFinite(selectedCm)) {
      return { left: 0, right: 0, front: 0, back: 0 };
    }

    const delta = selectedCm - Number(rules.baseCm); // tohle je pĹ™esnÄ› "odeÄŤĂ­st base a pĹ™iÄŤĂ­st selected"
    return {
      left:  present.left  ? delta : 0,
      right: present.right ? delta : 0,
      front: present.front ? delta : 0,
      back:  present.back  ? delta : 0,
    };
  }

  // ===== 3) ROZSAH (minâ€“max) =====
  // Ĺ Ă­Ĺ™ka = sÄŤĂ­tĂˇme min/max ĹˇĂ­Ĺ™ky modulĹŻ pĹ™es stejnou BFS geometrii jako teÄŹ.
  // Hloubka zatĂ­m nemĂˇ range v katalogu, tak ji drĹľĂ­me jako "pevnou" (stejnĂ˝ vĂ˝poÄŤet),
  // ale pĹ™ipravenĂ© tak, Ĺľe pozdÄ›ji mĹŻĹľeĹˇ doplnit range i pro hloubku (napĹ™. u 1D).

  function worldHalfExtentsForRange(rec, mode /* "min" | "max" */) {
    const { d } = getFootprintDimsCm(rec, mode);         // âś… hloubka podle min/max
    const wr = getFootprintWidthRangeCm(rec);            // ĹˇĂ­Ĺ™ka min/max z katalogu
    const w = (mode === "min") ? wr.min : wr.max;

    const hw = w / 2;
    const hd = d / 2;

    const root = getModuleRoot(rec.mesh);
    const wrDir = dirFromModuleToWorld(root, "right");
    const rotated90 = (wrDir === "front" || wrDir === "back");

    return rotated90 ? { hx: hd, hz: hw } : { hx: hw, hz: hd };
  }

  function shiftedCenterForAsymDepth_usingD(meshRoot, d, p) {
    const STANDARD_D = 102;
    if (!(d > STANDARD_D)) return p;

    const shift = (d - STANDARD_D) / 2;
    const frontWorld = dirFromModuleToWorld(meshRoot, "front");

    let x = p.x, z = p.z;
    if (frontWorld === "front") z += shift;
    else if (frontWorld === "back") z -= shift;
    else if (frontWorld === "right") x += shift;
    else if (frontWorld === "left")  x -= shift;

    return { x, z };
  }

  function computeRangeTotals(mode /* "min"|"max" */) {
    // 1) BFS pozice pro danĂ˝ mode (min/max)
    const posMode = new Map(); // rootMesh -> {x,z} v cm
    const q2 = [];

    posMode.set(anchorRoot, { x: 0, z: 0 });
    q2.push(anchorRoot);

    while (q2.length) {
      const curMesh = q2.shift();
      const curRec = byMesh.get(curMesh);
      if (!curRec?.connections) continue;

      const curJoin = worldHalfExtentsForRange(curRec, mode);
      const curPos = posMode.get(curMesh);

      for (const localSide of ["left", "right", "front", "back"]) {
        const nbMeshRaw = curRec.connections[localSide];
        if (!nbMeshRaw) continue;

        const nbRoot = getModuleRoot(nbMeshRaw);
        const nbRec = byMesh.get(nbRoot);
        if (!nbRec) continue;

        const worldDir = dirFromModuleToWorld(curMesh, localSide);
        const nbJoin = worldHalfExtentsForRange(nbRec, mode);

        let nx = curPos.x;
        let nz = curPos.z;

        if (worldDir === "right") nx += (curJoin.hx + nbJoin.hx);
        if (worldDir === "left")  nx -= (curJoin.hx + nbJoin.hx);
        if (worldDir === "front") nz += (curJoin.hz + nbJoin.hz);
        if (worldDir === "back")  nz -= (curJoin.hz + nbJoin.hz);

        if (!posMode.has(nbRoot)) {
          posMode.set(nbRoot, { x: nx, z: nz });
          q2.push(nbRoot);
        }
      }
    }

    // 2) extenty -> W/D
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const [mesh, p] of posMode.entries()) {
      const rec = byMesh.get(mesh);
      if (!rec) continue;

      const { d } = getFootprintDimsCm(rec, mode);           // âś… hloubka podle min/max
      const { hx, hz } = worldHalfExtentsForRange(rec, mode);

      // stejnĂ© posunutĂ­ stĹ™edu pro asymetrickou hloubku jako u normĂˇlnĂ­ch rozmÄ›rĹŻ
      const pc = shiftedCenterForAsymDepth_usingD(mesh, d, p);

      minX = Math.min(minX, pc.x - hx);
      maxX = Math.max(maxX, pc.x + hx);
      minZ = Math.min(minZ, pc.z - hz);
      maxZ = Math.max(maxZ, pc.z + hz);
    }

    let W = Math.round((maxX - minX) + 1e-6);
    let D = Math.round((maxZ - minZ) + 1e-6);

    // âś… Korekce podruÄŤek jen pro RANGE (min/max)
    const armDelta = computeArmrestRangeDeltaByWorldSide();
    W = Math.round((W + armDelta.left + armDelta.right) + 1e-6);
    D = Math.round((D + armDelta.front + armDelta.back) + 1e-6);

    return { W, D };
  }

  const rMin = computeRangeTotals("min");
  const rMax = computeRangeTotals("max");
  const summaryOrientation = getSummaryDisplayOrientationSafe();
  const shouldSwapSummaryAxes =
    summaryOrientation === "left" || summaryOrientation === "right";

  const displayWidthMin = shouldSwapSummaryAxes ? rMin.D : rMin.W;
  const displayWidthMax = shouldSwapSummaryAxes ? rMax.D : rMax.W;
  const displayDepthMin = shouldSwapSummaryAxes ? rMin.W : rMin.D;
  const displayDepthMax = shouldSwapSummaryAxes ? rMax.W : rMax.D;

  widthRangeEl.textContent = `${displayWidthMin}–${displayWidthMax} cm`;
  depthRangeEl.textContent = `${displayDepthMin}–${displayDepthMax} cm`;
}

const backOffsets = {
  // ===== 1D =====
  Manila_1D_L: -0.317,
  Manila_1XD_L: -0.317,
  Manila_1D_P: -0.315,
  Manila_1XD_P: -0.315,

  // ===== 1 =====
  Manila_1L: -0.018,
  Manila_1XL: -0.018,
  Manila_1M: -0.02,
  Manila_1XM: -0.02,
  Manila_1P: -0.016,
  Manila_1XP: -0.016,

  // ===== 1MO =====
  Manila_1MO_L: -0.003,
  Manila_1XMO_L: -0.003,
  Manila_1MO_P: -0.003,
  Manila_1XMO_P: -0.003,

  // ===== 2 =====
  Manila_2: 0,
  Manila_2X: 0,
  Manila_2L: 0,
  Manila_2XL: 0,
  Manila_2M: 0,
  Manila_2XM: 0,
  Manila_2P: 0.001,
  Manila_2XP: 0.001,

  // ===== 3 =====
  Manila_3: -0.009,
  Manila_3X: -0.009,
  Manila_3L: -0.009,
  Manila_3XL: -0.009,
  Manila_3M: -0.009,
  Manila_3XM: -0.009,
  Manila_3P: -0.009,
  Manila_3XP: -0.009,

  // ===== KĹ™eslo =====
  Manila_kreslo: 0,
  Manila_Xkreslo: 0,

  // ===== Rohy =====
  Manila_roh_P: -0.0145,
  Manila_roh_L: -0.0145,


  // =================================
  // ========= MENDOZA (TODO) =========
  // =================================

  // ===== 1D =====
  Mendoza_1D_L: -0.365,
  Mendoza_1XD_L: -0.365,
  Mendoza_1D_P: -0.48,
  Mendoza_1XD_P: -0.48,

  // ===== 1 =====
  Mendoza_1L: 0.02,
  Mendoza_1XL: 0.02,
  Mendoza_1M: -0.045,
  Mendoza_1XM:-0.045,
  Mendoza_1P: 0.024,
  Mendoza_1XP: 0.024,

  // ===== 1MO =====
  Mendoza_1MO_L: 0.009,
  Mendoza_1XMO_L: 0.009,
  Mendoza_1MO_P: 0.004,
  Mendoza_1XMO_P: 0.004,

  // ===== 2 =====
  Mendoza_2: 0,
  Mendoza_2X: 0,
  Mendoza_2L: -0.014,
  Mendoza_2XL: -0.014,
  Mendoza_2M: 0,
  Mendoza_2XM: 0,
  Mendoza_2P: -0.047,
  Mendoza_2XP: -0.047,

  // ===== 3 =====
  Mendoza_3: 0,
  Mendoza_3X: 0,
  Mendoza_3L: 0.049,
  Mendoza_3XL: 0.049,
  Mendoza_3M: 0,
  Mendoza_3XM: 0,
  Mendoza_3P: 0.007,
  Mendoza_3XP: 0.007,

  // ===== KĹ™eslo =====
  Mendoza_kreslo: 0,
  Mendoza_Xkreslo: 0,

  // ===== Rohy =====
  Mendoza_roh_P: 0,
  Mendoza_roh_L: 0,

  // =================================
  // ========= MELBOURNE =============
  // =================================

  // ===== 1D =====
  Melbourne_1D_L: -0.5405,
  Melbourne_1XD_L: -0.5405,
  Melbourne_1D_P: -0.5405,
  Melbourne_1XD_P: -0.5405,

  // ===== 1 =====
  Melbourne_1L: -0.52,
  Melbourne_1XL: -0.52,
  Melbourne_1M: -0.49,
  Melbourne_1XM: -0.49,
  Melbourne_1P: -0.52,
  Melbourne_1XP: -0.52,

  // ===== 1MO =====
  Melbourne_1MO_L: -0.425,
  Melbourne_1XMO_L: -0.425,
  Melbourne_1MO_P: -0.523,
  Melbourne_1XMO_P: -0.523,

  // ===== 2 =====
  Melbourne_2: 0,
  Melbourne_2X: 0,
  Melbourne_2L: -0.42,
  Melbourne_2XL: -0.42,
  Melbourne_2M: 0,
  Melbourne_2XM: 0,
  Melbourne_2P: -0.42,
  Melbourne_2XP: -0.42,

  // ===== 3 =====
  Melbourne_3: 0,
  Melbourne_3X: 0,
  Melbourne_3L: -0.52,
  Melbourne_3XL: -0.52,
  Melbourne_3M: -0.497,
  Melbourne_3XM: -0.497,
  Melbourne_3P: -0.52,
  Melbourne_3XP: -0.52,

  // ===== Křeslo =====
  Melbourne_kreslo: 0,
  Melbourne_Xkreslo: 0,

  // ===== Rohy =====
  Melbourne_roh_P: 0,
  Melbourne_roh_L: 0,

  // =================================
  // ========= MANCHESTER ============
  // =================================

  // ===== 1D =====
  Manchester_1D_L: -0.385,
  Manchester_1XD_L: -0.385,
  Manchester_1D_P: -0.38,
  Manchester_1XD_P: -0.38,

  // ===== 1 =====
  Manchester_1L: 0.06,
  Manchester_1XL: 0.06,
  Manchester_1M: 0,
  Manchester_1XM: 0,
  Manchester_1P: -0.04,
  Manchester_1XP: -0.04,

  // ===== 1MO =====
  Manchester_1MO_L: 0.05,
  Manchester_1XMO_L: 0.05,
  Manchester_1MO_P: 0.05,
  Manchester_1XMO_P: 0.05,

  // ===== 2 =====
  Manchester_2: 0,
  Manchester_2X: 0,
  Manchester_2L: -0.0025,
  Manchester_2XL: -0.0025,
  Manchester_2M: 0,
  Manchester_2XM: 0,
  Manchester_2P: -0.04,
  Manchester_2XP: -0.04,

  // ===== 3 =====
  Manchester_3: 0,
  Manchester_3X: 0,
  Manchester_3L: 0.52,
  Manchester_3XL: 0.52,
  Manchester_3M: 0,
  Manchester_3XM: 0,
  Manchester_3P: 0.095,
  Manchester_3XP: 0.095,

  // ===== Křeslo =====
  Manchester_kreslo: 0,
  Manchester_kresloX: 0,
  Manchester_Xkreslo: 0,

  // ===== Rohy =====
  Manchester_roh_P: 0,
  Manchester_roh_L: 0,
};

const sideOffsets = {
  // ===== 1D =====
  Manila_1D_L: 0,
  Manila_1XD_L: 0,
  Manila_1D_P: 0.,
  Manila_1XD_P: 0,

  // ===== 1 =====
  Manila_1L: 0.006,
  Manila_1XL: 0.006,
  Manila_1M: 0.007,
  Manila_1XM: 0.007,
  Manila_1P: 0.011,
  Manila_1XP: 0.011,

  // ===== 1MO =====
  Manila_1MO_L: 0.007,
  Manila_1XMO_L: 0.007,
  Manila_1MO_P: 0.018,
  Manila_1XMO_P: 0.018,

  // ===== 2 =====
  Manila_2: 0,
  Manila_2X: 0,
  Manila_2L: 0,
  Manila_2XL: 0,
  Manila_2M: 0.005,
  Manila_2XM: 0.005,
  Manila_2P: 0.005,
  Manila_2XP: 0.005,

  // ===== 3 =====
  Manila_3: 0,
  Manila_3X: 0,
  Manila_3L: 0,
  Manila_3XL: 0,
  Manila_3M: 0.014,
  Manila_3XM: 0.014,
  Manila_3P: 0.007,
  Manila_3XP: 0.007,

  // ===== KĹ™eslo =====
  Manila_kreslo: 0,
  Manila_Xkreslo: 0,

  // ===== Rohy =====
  Manila_roh_P: 0,
  Manila_roh_L: 0,

  // =================================
  // ========= MENDOZA (TODO) =========
  // =================================

  // ===== 1D =====
  Mendoza_1D_L: 0,
  Mendoza_1XD_L: 0,
  Mendoza_1D_P: 0,
  Mendoza_1XD_P: 0,

  // ===== 1 =====
  Mendoza_1L: 0.009,
  Mendoza_1XL: 0.009,
  Mendoza_1M: 0,
  Mendoza_1XM: 0,
  Mendoza_1P: 0.009,
  Mendoza_1XP: 0.009,

  // ===== 1MO =====
  Mendoza_1MO_L: 0,
  Mendoza_1XMO_L: 0,
  Mendoza_1MO_P: 0.003,
  Mendoza_1XMO_P: 0.003,

  // ===== 2 =====
  Mendoza_2: 0,
  Mendoza_2X: 0,
  Mendoza_2L: 0.005,
  Mendoza_2XL: 0.005,
  Mendoza_2M: 0.005,
  Mendoza_2XM: 0.005,
  Mendoza_2P: 0.004,
  Mendoza_2XP: 0.004,

  // ===== 3 =====
  Mendoza_3: 0,
  Mendoza_3X: 0,
  Mendoza_3L: 0.005,
  Mendoza_3XL: 0.005,
  Mendoza_3M: 0.005,
  Mendoza_3XM: 0.005,
  Mendoza_3P: 0.005,
  Mendoza_3XP: 0.005,

  // ===== KĹ™eslo =====
  Mendoza_kreslo: 0,
  Mendoza_Xkreslo: 0,

  // ===== Rohy =====
  Mendoza_roh_P: 0,
  Mendoza_roh_L: 0,

  // =================================
  // ========= MELBOURNE =============
  // =================================

  // ===== 1D =====
  Melbourne_1D_L: 0.019,
  Melbourne_1XD_L: 0.019,
  Melbourne_1D_P: 0.019,
  Melbourne_1XD_P: 0.019,

  // ===== 1 =====
  Melbourne_1L: 0.005,
  Melbourne_1XL: 0.005,
  Melbourne_1M: 0.0035,
  Melbourne_1XM: 0.0035,
  Melbourne_1P: 0.005,
  Melbourne_1XP: 0.005,

  // ===== 1MO =====
  Melbourne_1MO_L: 0.01,
  Melbourne_1XMO_L: 0.01,
  Melbourne_1MO_P: 0.005,
  Melbourne_1XMO_P: 0.005,

  // ===== 2 =====
  Melbourne_2: 0,
  Melbourne_2X: 0,
  Melbourne_2L: 0.007,
  Melbourne_2XL: 0.007,
  Melbourne_2M: 0.0035,
  Melbourne_2XM: 0.0035,
  Melbourne_2P: 0.007,
  Melbourne_2XP: 0.007,

  // ===== 3 =====
  Melbourne_3: 0,
  Melbourne_3X: 0,
  Melbourne_3L: 0.008,
  Melbourne_3XL: 0.008,
  Melbourne_3M: 0.008,
  Melbourne_3XM: 0.008,
  Melbourne_3P: 0.008,
  Melbourne_3XP: 0.008,

  // ===== Křeslo =====
  Melbourne_kreslo: 0,
  Melbourne_Xkreslo: 0,

  // ===== Rohy =====
  Melbourne_roh_P: 0,
  Melbourne_roh_L: 0,

  // =================================
  // ========= MANCHESTER ============
  // =================================

  // ===== 1D =====
  Manchester_1D_L: 0.018,
  Manchester_1XD_L: 0.018,
  Manchester_1D_P: 0.015,
  Manchester_1XD_P: 0.015,

  // ===== 1 =====
  Manchester_1L: 0.012,
  Manchester_1XL: 0.012,
  Manchester_1M: 0.012,
  Manchester_1XM: 0.012,
  Manchester_1P: 0.002,
  Manchester_1XP: 0.002,

  // ===== 1MO =====
  Manchester_1MO_L: 0.005,
  Manchester_1XMO_L: 0.005,
  Manchester_1MO_P: 0,
  Manchester_1XMO_P: 0,

  // ===== 2 =====
  Manchester_2: 0,
  Manchester_2X: 0,
  Manchester_2L: 0.002,
  Manchester_2XL: 0.002,
  Manchester_2M: 0.012,
  Manchester_2XM: 0.012,
  Manchester_2P: -0.0015,
  Manchester_2XP: -0.0015,

  // ===== 3 =====
  Manchester_3: 0,
  Manchester_3X: 0,
  Manchester_3L: 0.012,
  Manchester_3XL: 0.012,
  Manchester_3M: 0.012,
  Manchester_3XM: 0.012,
  Manchester_3P: 0.008,
  Manchester_3XP: 0.008,

  // ===== Křeslo =====
  Manchester_kreslo: 0,
  Manchester_kresloX: 0,
  Manchester_Xkreslo: 0,

  // ===== Rohy =====
  Manchester_roh_P: 0,
  Manchester_roh_L: 0,
};

// âś… speciĂˇlnĂ­ boÄŤnĂ­ offsety podle smÄ›ru (jen kdyĹľ je modul nesymetrickĂ˝)
const sideOffsetsByDir = {
  Manila_1M:  { left: 0.016, right: 0.007 },   // <- sem si doplnĂ­Ĺˇ svoje hodnoty
  Manila_1XM: { left: 0.016, right: 0.007 },   // pokud je X varianta taky nesymetrickĂˇ

  // ===== MENDOZA =====

  Mendoza_1M:   { left: 0.016, right: 0.007 },
  Mendoza_1XM:  { left: 0.016, right: 0.007 },

  // ===== MELBOURNE =====

  Melbourne_1M:   { left: 0.0035, right: 0.008 },
  Melbourne_1XM:  { left: 0.0035, right: 0.008 },
};

async function rebuildAllAddButtons() {
  // 1) odstranit vĹˇechny button meshe ze scĂ©ny
  for (let i = activeButtons.length - 1; i >= 0; i--) {
    const btn = activeButtons[i].mesh;
    if (btn) scene.remove(btn);
  }
  activeButtons.length = 0;

  // 2) vyÄŤistit record.buttons
  for (const rec of activeModules) {
    rec.buttons = {};
  }

  // 3) znovu vytvoĹ™it tlaÄŤĂ­tka jen tam, kde nenĂ­ spoj
  const tasks = [];

  for (const rec of activeModules) {

    if (!shouldHaveButtons(rec.name)) continue;

    const key = normalizeOffsetKey(rec.name);
    const offsets = getModuleAddButtonOffsets()[key] || [];

    for (const def of offsets) {
      if (rec.connections?.[def.direction]) continue;

      const worldPos = rec.mesh.localToWorld(def.offset.clone());

      tasks.push(
        createButtonAt(
          worldPos,
          rec.mesh,
          def.direction,
          def.rotY || 0,
          def.shift || null,
          def.shiftByModule || null
        ).then((btn) => {
          rec.buttons[def.direction] = btn;
          activeButtons.push({
            mesh: btn,
            parentModule: rec.mesh,
            direction: def.direction,
            rotY: def.rotY || 0,
            shift: def.shift ? def.shift.clone() : null,
          });
        })
      );
    }
  }

  await Promise.all(tasks);

  // aĹĄ se hned schovĂˇ pĹ™Ă­padnĂ© pĹ™ebyteÄŤnĂ© (kdyby nÄ›co)
  updateButtons();
}

function normalizeOffsetKey(id) {
  id = (id ?? "").trim();

  // obecnÄ›: "PREFIX_1D_PX" -> "PREFIX_1XD_P"
  id = id.replace(/^([^_]+)_(\d+)D_([LMP])X$/, "$1_$2XD_$3");

  // obecnÄ›: "PREFIX_1MO_PX" -> "PREFIX_1XMO_P"
  id = id.replace(/^([^_]+)_(\d+)MO_([LP])X$/, "$1_$2XMO_$3");

  return id;
}

const moduleAddButtonOffsetsManila = {
  // ===== 1D =====
  Manila_1D_L: [
    { offset: new THREE.Vector3(0.7, 0, -0.3), direction: "right" },
  ],
  Manila_1XD_L: [
    { offset: new THREE.Vector3(0.7, 0, -0.3), direction: "right" },
  ],

  Manila_1D_P: [
    { offset: new THREE.Vector3(-0.7, 0, -0.3), direction: "left" },
  ],
  Manila_1XD_P: [
    { offset: new THREE.Vector3(-0.7, 0, -0.3), direction: "left" },
  ],

  // ===== 1 =====
  Manila_1L: [
    { offset: new THREE.Vector3(0.7, 0, 0), direction: "right" },
  ],
  Manila_1XL: [
    { offset: new THREE.Vector3(0.7, 0, 0), direction: "right" },
  ],

  Manila_1M: [
    { offset: new THREE.Vector3(0.7, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-0.7, 0, 0), direction: "left" },
  ],
  Manila_1XM: [
    { offset: new THREE.Vector3(0.7, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-0.7, 0, 0), direction: "left" },
  ],

  Manila_1P: [
    { offset: new THREE.Vector3(-0.7, 0, 0), direction: "left" },
  ],
  Manila_1XP: [
    { offset: new THREE.Vector3(-0.7, 0, 0), direction: "left" },
  ],

  // ===== 1MO =====
  Manila_1MO_L: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],
  Manila_1XMO_L: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],

  Manila_1MO_P: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],
  Manila_1XMO_P: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],

  // ===== 2 =====
  Manila_2: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manila_2X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Manila_2L: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],
  Manila_2XL: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],

  Manila_2M: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],
  Manila_2XM: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],

  Manila_2P: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],
  Manila_2XP: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],

  // ===== 3 =====
  Manila_3: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manila_3X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Manila_3L: [
    { offset: new THREE.Vector3(1.3, 0, 0), direction: "right" },
  ],
  Manila_3XL: [
    { offset: new THREE.Vector3(1.3, 0, 0), direction: "right" },
  ],

  Manila_3M: [
    { offset: new THREE.Vector3(1.3, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.3, 0, 0), direction: "left" },
  ],
  Manila_3XM: [
    { offset: new THREE.Vector3(1.3, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.3, 0, 0), direction: "left" },
  ],

  Manila_3P: [
    { offset: new THREE.Vector3(-1.3, 0, 0), direction: "left" },
  ],
  Manila_3XP: [
    { offset: new THREE.Vector3(-1.3, 0, 0), direction: "left" },
  ],

  // ===== KĹ™eslo =====
  Manila_kreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manila_Xkreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  // ===== Rohy =====
  Manila_roh_P: [
    { offset: new THREE.Vector3(-0.85, 0, 0), direction: "left" },
    { offset: new THREE.Vector3(0, 0, 0.85), direction: "front", rotY: -Math.PI / 2 },
  ],

  Manila_roh_L: [
    { offset: new THREE.Vector3(0.85, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0.85), direction: "front", rotY: +Math.PI / 2 },
  ],
};

const moduleAddButtonOffsetsMendoza = {
  // ===== 1D =====
  Mendoza_1D_L: [
    { offset: new THREE.Vector3(0.8, 0, -0.3), direction: "right" },
  ],
  Mendoza_1XD_L: [
    { offset: new THREE.Vector3(0.8, 0, -0.3), direction: "right" },
  ],

  Mendoza_1D_P: [
    { offset: new THREE.Vector3(-0.8, 0, -0.3), direction: "left" },
  ],
  Mendoza_1XD_P: [
    { offset: new THREE.Vector3(-0.8, 0, -0.3), direction: "left" },
  ],

  // ===== 1 =====
  Mendoza_1L: [
    { offset: new THREE.Vector3(0.8, 0, 0), direction: "right" },
  ],
  Mendoza_1XL: [
    { offset: new THREE.Vector3(0.8, 0, 0), direction: "right" },
  ],

  Mendoza_1M: [
    { offset: new THREE.Vector3(0.8, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-0.8, 0, 0), direction: "left" },
  ],
  Mendoza_1XM: [
    { offset: new THREE.Vector3(0.8, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-0.8, 0, 0), direction: "left" },
  ],

  Mendoza_1P: [
    { offset: new THREE.Vector3(-0.8, 0, 0), direction: "left" },
  ],
  Mendoza_1XP: [
    { offset: new THREE.Vector3(-0.8, 0, 0), direction: "left" },
  ],

  // ===== 1MO =====
  Mendoza_1MO_L: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],
  Mendoza_1XMO_L: [
    { offset: new THREE.Vector3(1, 0, 0), direction: "right" },
  ],

  Mendoza_1MO_P: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],
  Mendoza_1XMO_P: [
    { offset: new THREE.Vector3(-1, 0, 0), direction: "left" },
  ],

  // ===== 2 =====
  Mendoza_2: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Mendoza_2X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Mendoza_2L: [
    { offset: new THREE.Vector3(1.1, 0, 0), direction: "right" },
  ],
  Mendoza_2XL: [
    { offset: new THREE.Vector3(1.1, 0, 0), direction: "right" },
  ],

  Mendoza_2M: [
    { offset: new THREE.Vector3(1.1, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.1, 0, 0), direction: "left" },
  ],
  Mendoza_2XM: [
    { offset: new THREE.Vector3(1.1, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.1, 0, 0), direction: "left" },
  ],

  Mendoza_2P: [
    { offset: new THREE.Vector3(-1.1, 0, 0), direction: "left" },
  ],
  Mendoza_2XP: [
    { offset: new THREE.Vector3(-1.1, 0, 0), direction: "left" },
  ],

  // ===== 3 =====
  Mendoza_3: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Mendoza_3X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Mendoza_3L: [
    { offset: new THREE.Vector3(1.5, 0, 0), direction: "right" },
  ],
  Mendoza_3XL: [
    { offset: new THREE.Vector3(1.5, 0, 0), direction: "right" },
  ],

  Mendoza_3M: [
    { offset: new THREE.Vector3(1.4, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.4, 0, 0), direction: "left" },
  ],
  Mendoza_3XM: [
    { offset: new THREE.Vector3(1.4, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.4, 0, 0), direction: "left" },
  ],

  Mendoza_3P: [
    { offset: new THREE.Vector3(-1.5, 0, 0), direction: "left" },
  ],
  Mendoza_3XP: [
    { offset: new THREE.Vector3(-1.5, 0, 0), direction: "left" },
  ],

  // ===== KĹ™eslo =====
  Mendoza_kreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Mendoza_Xkreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  // ===== Rohy =====
  Mendoza_roh_P: [
    { offset: new THREE.Vector3(-0.85, 0, 0), direction: "left" },
    { offset: new THREE.Vector3(0, 0, 0.85), direction: "front", rotY: -Math.PI / 2 },
  ],

  Mendoza_roh_L: [
    { offset: new THREE.Vector3(0.85, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0.85), direction: "front", rotY: +Math.PI / 2 },
  ],
};

const moduleAddButtonOffsetsMelbourne = {
  Melbourne_1D_L: [
    { offset: new THREE.Vector3(0.8, 0, 0.4), direction: "right" },
  ],
  Melbourne_1XD_L: [
    { offset: new THREE.Vector3(0.8, 0, 0.4), direction: "right" },
  ],

  Melbourne_1D_P: [
    { offset: new THREE.Vector3(-0.8, 0, 0.4), direction: "left" },
  ],
  Melbourne_1XD_P: [
    { offset: new THREE.Vector3(-0.8, 0, 0.4), direction: "left" },
  ],

  Melbourne_1L: [
    { offset: new THREE.Vector3(0.8, 0, 0.4), direction: "right" },
  ],
  Melbourne_1XL: [
    { offset: new THREE.Vector3(0.8, 0, 0.4), direction: "right" },
  ],

  Melbourne_1M: [
    { offset: new THREE.Vector3(0.8, 0, 0.45), direction: "right" },
    { offset: new THREE.Vector3(-0.8, 0, 0.45), direction: "left" },
  ],
  Melbourne_1XM: [
    { offset: new THREE.Vector3(0.8, 0, 0.45), direction: "right" },
    { offset: new THREE.Vector3(-0.8, 0, 0.45), direction: "left" },
  ],

  Melbourne_1P: [
    { offset: new THREE.Vector3(-0.8, 0, 0.4), direction: "left" },
  ],
  Melbourne_1XP: [
    { offset: new THREE.Vector3(-0.8, 0, 0.4), direction: "left" },
  ],

  Melbourne_1MO_L: [
    { offset: new THREE.Vector3(1.1, 0, 0.5), direction: "right" },
  ],
  Melbourne_1XMO_L: [
    { offset: new THREE.Vector3(1.1, 0, 0.5), direction: "right" },
  ],

  Melbourne_1MO_P: [
    { offset: new THREE.Vector3(-1.05, 0, 0.4), direction: "left" },
  ],
  Melbourne_1XMO_P: [
    { offset: new THREE.Vector3(-1.05, 0, 0.4), direction: "left" },
  ],

  Melbourne_2: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Melbourne_2X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Melbourne_2L: [
    { offset: new THREE.Vector3(1.2, 0, 0.5), direction: "right" },
  ],
  Melbourne_2XL: [
    { offset: new THREE.Vector3(1.2, 0, 0.05), direction: "right" },
  ],

  Melbourne_2M: [
    { offset: new THREE.Vector3(1.15, 0, 0.95), direction: "right" },
    { offset: new THREE.Vector3(-1.15, 0, 0.95), direction: "left" },
  ],
  Melbourne_2XM: [
    { offset: new THREE.Vector3(1.15, 0, 0.95), direction: "right" },
    { offset: new THREE.Vector3(-1.15, 0, 0.95), direction: "left" },
  ],

  Melbourne_2P: [
    { offset: new THREE.Vector3(-1.2, 0, 0.5), direction: "left" },
  ],
  Melbourne_2XP: [
    { offset: new THREE.Vector3(-1.2, 0, 0.5), direction: "left" },
  ],

  Melbourne_3: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Melbourne_3X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Melbourne_3L: [
    { offset: new THREE.Vector3(1.55, 0, 0.4), direction: "right" },
  ],
  Melbourne_3XL: [
    { offset: new THREE.Vector3(1.55, 0, 0.4), direction: "right" },
  ],

  Melbourne_3M: [
    { offset: new THREE.Vector3(1.55, 0, 0.4), direction: "right" },
    { offset: new THREE.Vector3(-1.5, 0, 0.4), direction: "left" },
  ],
  Melbourne_3XM: [
    { offset: new THREE.Vector3(1.55, 0, 0.4), direction: "right" },
    { offset: new THREE.Vector3(-1.5, 0, 0.4), direction: "left" },
  ],

  Melbourne_3P: [
    { offset: new THREE.Vector3(-1.6, 0, 0.4), direction: "left" },
  ],
  Melbourne_3XP: [
    { offset: new THREE.Vector3(-1.6, 0, 0.4), direction: "left" },
  ],

  Melbourne_kreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Melbourne_kresloX: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Melbourne_Xkreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Melbourne_roh_P: [
    { offset: new THREE.Vector3(-0.9, 0, 0.5), direction: "left" },
    { offset: new THREE.Vector3(0, 0, 1.4), direction: "front", rotY: -Math.PI / 2 },
  ],

  Melbourne_roh_L: [
    { offset: new THREE.Vector3(0.9, 0, 0.5), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 1.4), direction: "front", rotY: +Math.PI / 2 },
  ],
};

const moduleAddButtonOffsetsManchester = {
  // ===== 1D =====
  Manchester_1D_L: [
    { offset: new THREE.Vector3(0.9, 0, -0.35), direction: "right" },
  ],
  Manchester_1XD_L: [
    { offset: new THREE.Vector3(0.9, 0, -0.35), direction: "right" },
  ],

  Manchester_1D_P: [
    { offset: new THREE.Vector3(-0.95, 0, -0.35), direction: "left" },
  ],
  Manchester_1XD_P: [
    { offset: new THREE.Vector3(-0.95, 0, -0.35), direction: "left" },
  ],

  // ===== 1 =====
  Manchester_1L: [
    { offset: new THREE.Vector3(0.9, 0, 0.05), direction: "right" },
  ],
  Manchester_1XL: [
    { offset: new THREE.Vector3(0.9, 0, 0.05), direction: "right" },
  ],

  Manchester_1M: [
    { offset: new THREE.Vector3(0.75, 0, 0.05), direction: "right" },
    { offset: new THREE.Vector3(-0.75, 0, 0.05), direction: "left" },
  ],
  Manchester_1XM: [
    { offset: new THREE.Vector3(0.75, 0, 0.05), direction: "right" },
    { offset: new THREE.Vector3(-0.75, 0, 0.05), direction: "left" },
  ],

  Manchester_1P: [
    { offset: new THREE.Vector3(-0.9, 0, 0), direction: "left" },
  ],
  Manchester_1XP: [
    { offset: new THREE.Vector3(-0.9, 0, 0), direction: "left" },
  ],

  // ===== 1MO =====
  Manchester_1MO_L: [
    { offset: new THREE.Vector3(0.95, 0, 0.05), direction: "right" },
  ],
  Manchester_1XMO_L: [
    { offset: new THREE.Vector3(0.95, 0, 0.05), direction: "right" },
  ],

  Manchester_1MO_P: [
    { offset: new THREE.Vector3(-0.95, 0, 0.05), direction: "left" },
  ],
  Manchester_1XMO_P: [
    { offset: new THREE.Vector3(-0.95, 0, 0.05), direction: "left" },
  ],

  // ===== 2 =====
  Manchester_2: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manchester_2X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Manchester_2L: [
    { offset: new THREE.Vector3(1.2, 0, 0), direction: "right" },
  ],
  Manchester_2XL: [
    { offset: new THREE.Vector3(1.2, 0, 0), direction: "right" },
  ],

  Manchester_2M: [
    { offset: new THREE.Vector3(1.025, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.025, 0, 0), direction: "left" },
  ],
  Manchester_2XM: [
    { offset: new THREE.Vector3(1.025, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.025, 0, 0), direction: "left" },
  ],

  Manchester_2P: [
    { offset: new THREE.Vector3(-1.1, 0, -0.05), direction: "left" },
  ],
  Manchester_2XP: [
    { offset: new THREE.Vector3(-1.1, 0, -0.05), direction: "left" },
  ],

  // ===== 3 =====
  Manchester_3: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manchester_3X: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  Manchester_3L: [
    { offset: new THREE.Vector3(1.7, 0, 0.53), direction: "right" },
  ],
  Manchester_3XL: [
    { offset: new THREE.Vector3(1.7, 0, 0.53), direction: "right" },
  ],

  Manchester_3M: [
    { offset: new THREE.Vector3(1.35, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.35, 0, 0), direction: "left" },
  ],
  Manchester_3XM: [
    { offset: new THREE.Vector3(1.35, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(-1.35, 0, 0), direction: "left" },
  ],

  Manchester_3P: [
    { offset: new THREE.Vector3(-1.65, 0, 0.08), direction: "left" },
  ],
  Manchester_3XP: [
    { offset: new THREE.Vector3(-1.65, 0, 0.08), direction: "left" },
  ],

  // ===== Křeslo =====
  Manchester_kreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manchester_kresloX: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],
  Manchester_Xkreslo: [
    { offset: new THREE.Vector3(0, 0, 0), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0), direction: "left" },
  ],

  // ===== Rohy =====
  Manchester_roh_P: [
    { offset: new THREE.Vector3(-0.9, 0, 0.03), direction: "left" },
    { offset: new THREE.Vector3(0, 0, 0.9), direction: "front", rotY: -Math.PI / 2 },
  ],

  Manchester_roh_L: [
    { offset: new THREE.Vector3(0.9, 0, 0.03), direction: "right" },
    { offset: new THREE.Vector3(0, 0, 0.9), direction: "front", rotY: +Math.PI / 2 },
  ],
};

function getModuleAddButtonOffsets() {
  const model = String(appState?.model || "").toUpperCase();

  if (model === "MENDOZA") return moduleAddButtonOffsetsMendoza;
  if (model === "MELBOURNE") return moduleAddButtonOffsetsMelbourne;
  if (model === "MANCHESTER") return moduleAddButtonOffsetsManchester;
  if (model === "MANILA") return moduleAddButtonOffsetsManila;

  // fallback â€“ kdyĹľ pĹ™idĂˇĹˇ novou sedaÄŤku a zapomeneĹˇ offsets
  return moduleAddButtonOffsetsManila;
}

// GLTF loader â€“ tlaÄŤĂ­tko (CACHE: stĂˇhne se jen 1Ă—)
let _buttonTemplatePromise = null;

function loadButtonTemplate() {
  if (_buttonTemplatePromise) return _buttonTemplatePromise;

  _buttonTemplatePromise = new Promise((resolve) => {
    addButtonLoader.load(
      "/models/Button/Button.glb",
      (gltf) => {
        const template = gltf.scene;

        // materiĂˇly + raycast nastavĂ­me jen na template
        template.traverse((o) => {
          if (!o.isMesh) return;

          o.castShadow = true;
          o.receiveShadow = true;

          const n = (o.name || "").toLowerCase();

          if (n.includes("cross") || n.includes("plus") || n.includes("x")) {
            o.material = BUTTON_CROSS_MAT.clone();
          } else if (n.includes("button") || n.includes("add") || n.includes("body")) {
            o.material = BUTTON_BODY_MAT.clone();
          } else {
            o.material = BUTTON_BODY_MAT.clone();
          }

          // uloĹľit originĂˇl (pro hover reset)
          o.userData.originalMaterial = o.material.clone();

          // pojistka raycastu
          o.raycast = THREE.Mesh.prototype.raycast;
        });

        resolve(template);
      },
      undefined,
      (err) => console.error("Chyba načítání tlačítka:", err)
    );
  });

  return _buttonTemplatePromise;
}

// vyrobĂ­ NOVOU instanci tlaÄŤĂ­tka (clone) z cache template
async function createButtonInstance() {
  const template = await loadButtonTemplate();
  const btn = template.clone(true);

  // po klonu si udÄ›lĂˇme vlastnĂ­ kopie materiĂˇlĹŻ, aĹĄ hover nemÄ›nĂ­ vĹˇem najednou
  btn.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material) o.material = o.material.clone();
    o.userData.originalMaterial = o.material ? o.material.clone() : null;
  });

  return btn;
}

// -----------------------------------------------------
//  ANIMACE
// -----------------------------------------------------

function animate() {
  requestAnimationFrame(animate);

  updateButtonHoverAnimations();
  updateHeadrestAnimations();

  if (autoCamActive && !autoCamBlocked) {
    camera.position.lerp(camGoalPos, CAMERA_LERP);
    controls.target.lerp(camGoalTarget, CAMERA_LERP);

    const donePos = camera.position.distanceTo(camGoalPos) < AUTO_EPS_POS;
    const doneTgt = controls.target.distanceTo(camGoalTarget) < AUTO_EPS_TGT;

    if (donePos && doneTgt) {
      camera.position.copy(camGoalPos);
      controls.target.copy(camGoalTarget);
      autoCamActive = false; // âś… hotovo, dĂˇl uĹľ do kamery nezasahujeme
    }
  }

  controls.update();
  preventCameraInsideModules();

  renderer.render(scene, camera);
}

animate();

function updateSummaryBox() {
  const priceEl = document.getElementById("sumPrice");
  const dimsEl  = document.getElementById("sumDims");
  if (!priceEl || !dimsEl) return;

  // 1) Cena
  const total = getConfiguredTotalPrice();
  priceEl.textContent = `${total.toLocaleString("cs-CZ")} Kč`;

  // 2) RozmÄ›ry: vezmeme "snapBox" (sedĂˇky) pro kaĹľdĂ˝ modul
  if (activeModules.length === 0) {
    dimsEl.textContent = `0 × 0 × 0 cm`;
    return;
  }

  const box = new THREE.Box3();

  for (const rec of activeModules) {
    if (!rec?.mesh) continue;

    // getSnapBox uĹľ vracĂ­ world-space Box3 (a bere jen "seat")
    const b = getSnapBox(rec.mesh);
    box.union(b);
  }

  const size = new THREE.Vector3();
  box.getSize(size);

  // ĹˇĂ­Ĺ™ka = osa X, hloubka = osa Z, vĂ˝Ĺˇka = osa Y
  const w = Math.round((size.x || 0) * SCENE_UNITS_TO_CM);
  const d = Math.round((size.z || 0) * SCENE_UNITS_TO_CM);
  const h = Math.round((size.y || 0) * SCENE_UNITS_TO_CM);

  dimsEl.textContent = `${w} × ${d} × ${h} cm`;
}

// eventy pro hover + click na modul
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerdown", onPointerDown);
renderer.domElement.addEventListener("pointerup", onPointerUp);
renderer.domElement.addEventListener("pointerleave", () => {
  clearHoverEffects();
});

// -----------------------------------------------------
//  HOVER / DRAG LOGIKA
// -----------------------------------------------------

function clearHoverEffects() {
  if (hoveredButton) {
    resetButtonHover(hoveredButton);
    hoveredButton = null;
  }

  if (hoveredModule) {
    hoveredModule.traverse((o) => {
      if (!o.isMesh) return;

      // uklidit pĹ™Ă­padnĂ© "highlight" hodnoty
      const mats = Array.isArray(o.material) ? o.material : [o.material];

      mats.forEach((mat) => {
        if (!mat || !mat.emissive) return;

        if (mat.userData._hoverOrigEmissive) {
          mat.emissive.copy(mat.userData._hoverOrigEmissive);
          mat.emissiveIntensity = mat.userData._hoverOrigEmissiveIntensity ?? 0;
          mat.needsUpdate = true;
        } else {
          // fallback
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
          mat.needsUpdate = true;
        }
      });
    });
  }

  hoveredModule = null;
  document.body.style.cursor = "default";
}

function onPointerMove(event) {

  // âś… KROK 3 (a mimo krok 2): ĹľĂˇdnĂ˝ hover, ĹľĂˇdnĂ˝ pointer kurzor
  if (!isBuildStepActive()) {
    clearHoverEffects();
    document.body.style.cursor = "default";
    return;
  }

  const pickerOpen = !document.getElementById("modulePicker").classList.contains("hidden");
  const menuOpen = moduleActionMenu?.classList.contains("visible");

  // kdyĹľ je otevĹ™enĂ˝ picker nebo menu, nechceme hover v 3D
  if (pickerOpen || menuOpen) {
    clearHoverEffects();
    document.body.style.cursor = "default";
    return;
  }

  // 1) drag mÄ›Ĺ™enĂ­
  if (mouseDown) {
    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;

    dragDistance += Math.abs(dx) + Math.abs(dy);

    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  }

  // 2) kdyĹľ tahĂˇme kamerou, ĹľĂˇdnĂ˝ hover
  if (mouseDown && dragDistance > 20) {
    clearHoverEffects();
    document.body.style.cursor = "default";
    return;
  }

  // 3) souĹ™adnice myĹˇi vĹŻÄŤi canvasu (renderer.domElement)
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // --- reset pĹ™edchozĂ­ch hoverĹŻ ---
  if (hoveredButton) {
    resetButtonHover(hoveredButton);
    hoveredButton = null;
  }

  if (hoveredModule) {
    hoveredModule.traverse((o) => {
      if (!o.isMesh || !o.material) return;

      const mats = Array.isArray(o.material) ? o.material : [o.material];

      mats.forEach((mat) => {
        if (!mat || !mat.emissive) return;

        // vrĂˇtĂ­me pĹŻvodnĂ­ emissive hodnoty, pokud existujĂ­
        if (mat.userData._hoverOrigEmissive) {
          mat.emissive.copy(mat.userData._hoverOrigEmissive);
          mat.emissiveIntensity = mat.userData._hoverOrigEmissiveIntensity ?? 0;
          mat.needsUpdate = true;
        } else {
          // fallback (kdyby tam nic nebylo)
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
          mat.needsUpdate = true;
        }
      });
    });

    hoveredModule = null;
  }

  if (hoveredModule) {
    resetHoverMaterial(hoveredModule);
    hoveredModule = null;
  }

  if (hoveredHeadrestDot) {
    resetHeadrestDotHover(hoveredHeadrestDot);
    hoveredHeadrestDot = null;
  }

  document.body.style.cursor = "default";

  // --- 1) headrest doty Ĺ™eĹˇ pĹ™ednostnÄ› vlastnĂ­m raycastem ---
  const dotTargets = headrestDots.filter(d => d && d.visible && d.parent);
  const dotHits = raycaster.intersectObjects(dotTargets, true);
  if (dotHits.length > 0) {
    const dotRoot = getHeadrestDotRoot(dotHits[0].object);
    if (dotRoot) {
      hoveredHeadrestDot = dotRoot;
      applyHeadrestDotHover(hoveredHeadrestDot);
      document.body.style.cursor = "pointer";
      return;
    }
  }

  // --- 2) ostatnĂ­ interakce (buttony + moduly) ---
  const buttonTargets = [
    ...(startButton && startButton.visible && startButton.parent ? [startButton] : []),
    ...activeButtons.filter(b => b.mesh && b.mesh.visible && b.mesh.parent).map(b => b.mesh),
  ];

  const moduleTargets = activeModules.flatMap((m) =>
    m?.mesh && m.mesh.visible && m.mesh.parent ? getVisibleRaycastMeshesFromRoot(m.mesh) : []
  );

  const hits = raycaster.intersectObjects([...moduleTargets, ...buttonTargets], true);
  if (hits.length === 0) return;

  const hitObj = hits[0].object;

  // --- 2) Je nejbliĹľĹˇĂ­ zĂˇsah BUTTON? (jen pokud je to "naĹˇe" tlaÄŤĂ­tko) ---
  const rootBtn = getButtonRoot(hitObj);
  const isKnownButton =
    rootBtn &&
    rootBtn.visible &&
    (rootBtn === startButton || activeButtons.some(b => b.mesh === rootBtn));

  if (isKnownButton) {
    hoveredButton = rootBtn;
    applyButtonHover(hoveredButton);
    document.body.style.cursor = "pointer";
    return;
  }

  // --- 3) Jinak je nejbliĹľĹˇĂ­ zĂˇsah MODUL ---
  let root = getModuleRoot(hitObj);
  if (!root) return;

  if (!activeModules.some(m => m.mesh === root)) return;

  hoveredModule = root;
  document.body.style.cursor = "pointer";

  root.traverse((o) => {
    if (!o.isMesh || !o.material || !o.visible) return;

    // zajistĂ­me, Ĺľe materiĂˇl na tomhle meshi je unikĂˇtnĂ­ (jinak se to projevĂ­ na vĹˇech modulech)
    makeHoverMaterialUnique(o);

    const mats = Array.isArray(o.material) ? o.material : [o.material];

    mats.forEach((mat) => {
      if (!mat) return;

      // âś… kdyĹľ emissive neexistuje, vytvoĹ™Ă­me ho
      if (!mat.emissive) mat.emissive = new THREE.Color(0x000000);

      // âś… uloĹľĂ­me originĂˇl jen poprvĂ©
      if (mat.userData._hoverOrigEmissive === undefined) {
        mat.userData._hoverOrigEmissive = mat.emissive.clone();
        mat.userData._hoverOrigEmissiveIntensity = mat.emissiveIntensity ?? 0;
      }

      // âś… jemnĂ© zesvÄ›tlenĂ­ (laditelnĂˇ sĂ­la)
      mat.emissive.setHex(0xffffff);     // bĂ­lĂ© emissive
      mat.emissiveIntensity = 0.06;      // jemnĂ© (zkus 0.04 â€“ 0.10)
      mat.needsUpdate = true;
    });
  });
}

function onModuleClick(event) {
  if (!moduleActionMenu) {
    console.warn("Chybí #moduleActionMenu v HTML");
    return;
  }
  const blocker = document.getElementById("actionMenuBlocker");
  if (!blocker) {
    console.warn("Chybí #actionMenuBlocker v HTML");
    return;
  }

  // KdyĹľ je picker otevĹ™enĂ˝ â†’ neklikej na moduly
  if (!document.getElementById("modulePicker").classList.contains("hidden")) {
    return;
  }

  // pokud se myĹˇ pohnula â†’ byl to drag, ne klik
  if (dragDistance > 12) return;

  if (!hoveredModule) return;

  selectedModule = hoveredModule;

  // ✅ menu se zobrazí přesně tam, kde kliknul uživatel
  const x = event.clientX;
  const y = event.clientY;

  // âś… Povolit mazĂˇnĂ­ jen leaf (krajnĂ­ modul)
  const deleteBtn = document.querySelector(".module-action-btn.delete");
  const canDelete = isLeafModule(selectedModule);

  // DELETE button (je to div, ne button -> ĹľĂˇdnĂ© .disabled)
  deleteBtn.classList.toggle("disabled", !canDelete);

  // dĹŻleĹľitĂ©: zruĹˇ inline opacity, jinak hover nikdy neprobÄ›hne
  deleteBtn.style.opacity = "";

  // klikatelnost
  deleteBtn.style.pointerEvents = "auto"; // vĹľdycky chytĂˇ klik
}

async function regenerateNeighborButtons(rec) {
  for (const side of ["left", "right", "front", "back"]) {
    const neighborMesh = rec.connections[side];
    if (!neighborMesh) continue;

    const neighborRec = activeModules.find((m) => m.mesh === neighborMesh);
    if (!neighborRec) continue;

    const opp = oppositeDirection(side);

    if (!neighborRec.buttons[opp]) {
      const offsets = getModuleAddButtonOffsets()[normalizeOffsetKey(neighborRec.name)] || [];
      const offsetDef = offsets.find((o) => o.direction === opp);
      if (!offsetDef) continue;

      const worldPos = neighborRec.mesh.localToWorld(offsetDef.offset.clone());

      const newBtn = await createButtonAt(worldPos, neighborRec.mesh, opp);

      neighborRec.buttons[opp] = newBtn;

      activeButtons.push({
        mesh: newBtn,
        parentModule: neighborRec.mesh,
        direction: opp,
      });
    }
  }
}

function boxWithMargin(box, margin) {
  // margin > 0 => box "zmenĹˇĂ­me" (tolerujeme prĹŻniky)
  // margin < 0 => box "zvÄ›tĹˇĂ­me" (zpĹ™Ă­snĂ­me)
  const b = box.clone();
  b.min.addScalar(margin);
  b.max.addScalar(-margin);
  return b;
}

function boxesIntersect(a, b, eps = 0) {
  // eps > 0 trochu povolĂ­ dotyk / mikropĹ™ekryv
  return !(
    (a.max.x < b.min.x + eps) || (a.min.x > b.max.x - eps) ||
    (a.max.y < b.min.y + eps) || (a.min.y > b.max.y - eps) ||
    (a.max.z < b.min.z + eps) || (a.min.z > b.max.z - eps)
  );
}

function getNeighborMeshes(record) {
  const out = [];
  if (!record?.connections) return out;
  for (const side of ["left", "right", "front", "back"]) {
    if (record.connections[side]) out.push(record.connections[side]);
  }
  return out;
}

/**
 * VrĂˇtĂ­ true, kdyĹľ je umĂ­stÄ›nĂ­ OK (nepĹ™ekrĂ˝vĂˇ se s cizĂ­mi moduly).
 *
 * allowNeighborPenetration = kolik "zapuĹˇtÄ›nĂ­" dovolĂ­me u sousedĹŻ (v metrech jednotek scĂ©ny)
 * strictEps = tolerance pro cizĂ­ moduly (typicky 0.001 aĹľ 0.005)
 */
function placementIsValid(newRecord, baseRecord, {
  allowNeighborPenetration = 0.02,
  strictEps = 0.002
} = {}) {
  const newMesh = newRecord.mesh;

  const variantSofaKey = (variantId) => {
    const id = String(variantId || "").trim();
    if (id.startsWith("Melbourne_")) return "Melbourne";
    if (id.startsWith("Mendoza_")) return "Mendoza";
    if (id.startsWith("Manila_")) return "Manila";
    return null;
  };

  const isCornerVariant = (variantId) =>
    /_roh_[LP]$/i.test(String(variantId || "").trim());

  const getAllowedNeighborPenetration = (otherRecord) => {
    const newSofa = variantSofaKey(newRecord?.name);
    const baseSofa = variantSofaKey(baseRecord?.name);
    const otherSofa = variantSofaKey(otherRecord?.name);

    if (newSofa !== "Melbourne" || baseSofa !== "Melbourne" || otherSofa !== "Melbourne") {
      return allowNeighborPenetration;
    }

    const baseIsCorner = isCornerVariant(baseRecord?.name);
    const otherIsCorner = isCornerVariant(otherRecord?.name);

    // Melbourne rohy maji v GLB sedakove boxy a dorovnavaci offsety s vetsim presahem.
    // Pri pridani se connection zapise az po validaci, takze moduly sdilene pres roh
    // potrebuji stejnou toleranci uz v teto predbezne kontrole.
    if (baseIsCorner || otherIsCorner) {
      return Math.max(allowNeighborPenetration, 0.56);
    }

    return allowNeighborPenetration;
  };

  // Box pro novĂ˝ modul
  const newBoxRaw = getSnapBox(newMesh);

  // pro cizĂ­ moduly budeme pouĹľĂ­vat "zpĹ™Ă­snÄ›nĂ˝" box (mĂ­rnÄ› zvÄ›tĹˇenĂ˝)
  const newBoxStrict = boxWithMargin(newBoxRaw, -strictEps);

  // sousedĂ© = base + jeho pĹ™Ă­mĂ­ sousedĂ©
  const allowed = new Set([baseRecord.mesh, ...getNeighborMeshes(baseRecord)]);

  for (const rec of activeModules) {
    const other = rec.mesh;
    if (other === newMesh) continue;

    const otherBoxRaw = getSnapBox(other);

    if (allowed.has(other)) {
      // u sousedĹŻ povolĂ­me malĂ© zapuĹˇtÄ›nĂ­: zmenĹˇĂ­me oba boxy
      const neighborPenetration = getAllowedNeighborPenetration(rec);
      const a = boxWithMargin(newBoxRaw, neighborPenetration);
      const b = boxWithMargin(otherBoxRaw, neighborPenetration);
      // i kdyby se protĂ­naly mimo "zapuĹˇtÄ›nĂ­", bude to true a zakĂˇĹľeme
      if (boxesIntersect(a, b, 0)) return false;
    } else {
      // u cizĂ­ch modulĹŻ: ĹľĂˇdnĂ˝ prĹŻnik
      const bStrict = boxWithMargin(otherBoxRaw, -strictEps);
      if (boxesIntersect(newBoxStrict, bStrict, 0)) return false;
    }
  }

  return true;
}

function areDirectNeighbors(meshA, meshB) {
  const recA = activeModules.find(r => r.mesh === meshA);
  if (!recA?.connections) return false;

  for (const side of ["left", "right", "front", "back"]) {
    if (recA.connections[side] === meshB) return true;
  }
  return false;
}

function isCornerMesh(mesh) {
  const rec = activeModules.find(r => r.mesh === mesh);
  const name = rec?.name || "";
  return name.includes("roh"); // Manila_roh_P / Manila_roh_L
}

// true kdyĹľ A a B jsou oba napojenĂ­ na STEJNĂť rohovĂ˝ modul
function shareSameCornerNeighbor(meshA, meshB) {
  for (const rec of activeModules) {
    const corner = rec?.mesh;
    if (!corner) continue;
    if (!isCornerMesh(corner)) continue;

    // staÄŤĂ­ kdyĹľ roh "vidĂ­" oba (nebo opaÄŤnÄ›, podle toho jak mĂˇĹˇ napojenĂ­)
    const aLinked =
      areDirectNeighbors(corner, meshA) || areDirectNeighbors(meshA, corner);
    const bLinked =
      areDirectNeighbors(corner, meshB) || areDirectNeighbors(meshB, corner);

    if (aLinked && bLinked) return true;
  }
  return false;
}

/**
 * GlobĂˇlnĂ­ kontrola: ĹľĂˇdnĂ© kolize mezi NE-sousedy,
 * a u sousedĹŻ povolĂ­me malĂ© "zapuĹˇtÄ›nĂ­" (stejnÄ› jako u placementIsValid).
 */
function hasAnyGlobalCollision({
  allowNeighborPenetration = 0.03,
  strictEps = 0.002
} = {}) {
  // aktualizuj world matrice
  for (const rec of activeModules) rec.mesh?.updateMatrixWorld?.(true);

  for (let i = 0; i < activeModules.length; i++) {
    const a = activeModules[i]?.mesh;
    if (!a) continue;

    const aRaw = getSnapBox(a);

    for (let j = i + 1; j < activeModules.length; j++) {
      const b = activeModules[j]?.mesh;
      if (!b) continue;

      const bRaw = getSnapBox(b);

      const neighbors =
      areDirectNeighbors(a, b) || areDirectNeighbors(b, a) ||
      shareSameCornerNeighbor(a, b); // âś… vĂ˝jimka pro dva moduly na stejnĂ©m rohu

      if (neighbors) {
        // sousedĂ©: povolĂ­me malĂ© zapuĹˇtÄ›nĂ­ => zmenĹˇĂ­me oba boxy
        const aa = boxWithMargin(aRaw, allowNeighborPenetration);
        const bb = boxWithMargin(bRaw, allowNeighborPenetration);

        // pokud se protĂ­najĂ­ i po "zmenĹˇenĂ­", je to kolize
        if (boxesIntersect(aa, bb, 0)) return true;
      } else {
        // cizĂ­ moduly: ĹľĂˇdnĂ˝ prĹŻnik => lehce zpĹ™Ă­snĂ­me boxy
        const aa = boxWithMargin(aRaw, -strictEps);
        const bb = boxWithMargin(bRaw, -strictEps);

        if (boxesIntersect(aa, bb, 0)) return true;
      }
    }
  }

  return false;
}

/**
 * VrĂˇtĂ­ Set vĹˇech kolizĂ­ mezi NE-sousedy ve formĂˇtu "uuidA|uuidB".
 * PouĹľĂ­vĂˇ stejnou logiku jako hasAnyGlobalCollision pro cizĂ­ moduly.
 */
function getNonNeighborCollisionPairs({ strictEps = 0.002 } = {}) {
  // aktualizuj world matrice
  for (const rec of activeModules) rec.mesh?.updateMatrixWorld?.(true);

  const out = new Set();

  for (let i = 0; i < activeModules.length; i++) {
    const a = activeModules[i]?.mesh;
    if (!a) continue;

    const aRaw = getSnapBox(a);

    for (let j = i + 1; j < activeModules.length; j++) {
      const b = activeModules[j]?.mesh;
      if (!b) continue;

      // jen NE-sousedy
      const neighbors =
        areDirectNeighbors(a, b) || areDirectNeighbors(b, a) ||
        shareSameCornerNeighbor(a, b); // âś… vĂ˝jimka pro dva moduly na stejnĂ©m rohu
      if (neighbors) continue;

      const bRaw = getSnapBox(b);

      // cizĂ­ moduly: ĹľĂˇdnĂ˝ prĹŻnik => lehce zpĹ™Ă­snĂ­me boxy
      const aa = boxWithMargin(aRaw, -strictEps);
      const bb = boxWithMargin(bRaw, -strictEps);

      if (boxesIntersect(aa, bb, 0)) {
        // stabilnĂ­ klĂ­ÄŤ (menĹˇĂ­ uuid prvnĂ­)
        const key =
          a.uuid < b.uuid ? `${a.uuid}|${b.uuid}` : `${b.uuid}|${a.uuid}`;
        out.add(key);
      }
    }
  }

  return out;
}

function getSnapBox(moduleRoot) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let found = false;

  moduleRoot.updateWorldMatrix(true, true);

  moduleRoot.traverse((o) => {
    if (o.isMesh && o.name.toLowerCase().includes("seat")) {
      o.updateWorldMatrix(true, false);
      tmp.setFromObject(o);
      if (!found) box.copy(tmp);
      else box.union(tmp);
      found = true;
    }
  });

  if (!found) box.setFromObject(moduleRoot);
  return box;
}

// dorovnĂˇnĂ­ "kolmo na spoj" (asymetrie rohĹŻ)
// pĹ™i left/right zarovnĂˇvĂˇm Z â†’ pouĹľĂ­vĂˇm LR mapu
const alignLR = {
  Manila_1D_L: 0.0,
  Manila_2M: 0.0,
  Manila_1P: 0.0,
  Manila_roh_P: 0.0, // <- sem budeĹˇ ladit "levou Ĺ™adu"
};

// pĹ™i front/back zarovnĂˇvĂˇm X â†’ pouĹľĂ­vĂˇm FB mapu
const alignFB = {
  Manila_1D_L: 0.0,
  Manila_2M: 0.0,
  Manila_1P: 0.0,
  Manila_roh_P: 0.0, // <- sem budeĹˇ ladit "pĹ™ednĂ­ Ĺ™adu"
};

// --- helper: z variantId poznĂˇme, pro jakou pohovku je dĂ­l ---
function sofaKeyFromVariantId(id) {
  id = String(id || "").trim();
  if (id.startsWith("Manila_")) return "Manila";
  if (id.startsWith("Mendoza_")) return "Mendoza";
  if (id.startsWith("Melbourne_")) return "Melbourne";
  if (id.startsWith("Manchester_")) return "Manchester";
  return null;
}

// --- EXTRA posuny pro rohy: oddÄ›lenÄ› pro kaĹľdou pohovku ---
const cornerExtraBySofa = {
  Manila: {
    roh_P: {
      front: {
        // 1
        Manila_1M:  { x: -0.0015, z: -0.022 },
        Manila_1XM: { x: -0.0015, z: -0.022 },
        Manila_1P:  { x: 0.006,  z: -0.025 },
        Manila_1XP: { x: 0.006,  z: -0.025 },
        Manila_1MO_P:  { x: 0.026, z: -0.032 },
        Manila_1XMO_P: { x: 0.026, z: -0.032 },

        // 2
        Manila_2M:  { x: 0.011, z: -0.02  },
        Manila_2XM: { x: 0.011, z: -0.02  },
        Manila_2P:  { x: 0.013, z: -0.018 },
        Manila_2XP: { x: 0.013, z: -0.018 },

        // 3
        Manila_3M:  { x: 0.015, z: -0.023 },
        Manila_3XM: { x: 0.015, z: -0.023 },
        Manila_3P:  { x: 0.009, z: -0.024 },
        Manila_3XP: { x: 0.009, z: -0.024 },
      },

      side: {
        // 1
        Manila_1M:  { x: 0.0006, z: 0.0    },
        Manila_1XM: { x: 0.006,  z: 0.0    },
        Manila_1L:  { x: 0.0055, z: 0.0001 },
        Manila_1XL: { x: 0.0055, z: 0.0001 },
        Manila_1MO_L:  { x: 0.011, z: 0.0 },
        Manila_1XMO_L: { x: 0.011, z: 0.0 },

        // 2
        Manila_2M:  { x: 0.01,  z: 0.0001 },
        Manila_2XM: { x: 0.01,  z: 0.0001 },
        Manila_2L:  { x: 0.004, z: 0.0    },
        Manila_2XL: { x: 0.004, z: 0.0    },

        // 3
        Manila_3M:  { x: 0.0,    z: 0.0     },
        Manila_3XM: { x: 0.0,    z: 0.0     },
        Manila_3L:  { x: 0.0135, z: -0.0004 },
        Manila_3XL: { x: 0.0135, z: -0.0004 },
      },
    },

    roh_L: {
      front: {
        // 1
        Manila_1M:  { x: 0.016,  z: -0.026 },
        Manila_1XM: { x: 0.016,  z: -0.026 },
        Manila_1L:  { x: 0.0122, z: -0.024 },
        Manila_1XL: { x: 0.0122, z: -0.024 },
        Manila_1MO_L:  { x: -0.0001, z: -0.032 },
        Manila_1XMO_L: { x: -0.0001, z: -0.032 },

        // 2
        Manila_2M:  { x: -0.011,  z: -0.024 },
        Manila_2XM: { x: -0.011,  z: -0.024 },
        Manila_2L:  { x: -0.0115, z: -0.018 },
        Manila_2XL: { x: -0.0115, z: -0.018 },

        // 3
        Manila_3M:  { x: 0.010,  z: -0.028 },
        Manila_3XM: { x: 0.010,  z: -0.028 },
        Manila_3L:  { x: -0.0023, z: -0.027 },
        Manila_3XL: { x: -0.0023, z: -0.027 },
      },

      side: {
        // 1
        Manila_1M:  { x: 0.005, z: 0.0 },
        Manila_1XM: { x: 0.005, z: 0.0 },
        Manila_1P:  { x: 0.0,   z: 0.0 },
        Manila_1XP: { x: 0.0,   z: 0.0 },
        Manila_1MO_P:  { x: 0.0, z: 0.0 },
        Manila_1XMO_P: { x: 0.0, z: 0.0 },

        // 2
        Manila_2M:  { x: 0.0,   z: 0.0 },
        Manila_2XM: { x: 0.0,   z: 0.0 },
        Manila_2P:  { x: -0.005, z: 0.0 },
        Manila_2XP: { x: -0.005, z: 0.0 },

        // 3
        Manila_3M:  { x: 0.0,   z: 0.0 },
        Manila_3XM: { x: 0.0,   z: 0.0 },
        Manila_3P:  { x: -0.005, z: 0.0 },
        Manila_3XP: { x: -0.005, z: 0.0 },
      },
    },
  },

  // âś… Mendoza zatĂ­m â€śskeletonâ€ť â€“ doplnĂ­Ĺˇ/odladĂ­Ĺˇ si hodnoty podle potĹ™eby
  Mendoza: {
    // ===== kdyĹľ je BASE ROH P =====
    roh_P: {
      // napojenĂ­ na roh_P ze ZEPĹEDU (front/back) -> vĹˇechny M + P
      front: {
        // 1
        Mendoza_1M:   { x: -0.019, z: -0.011 },
        Mendoza_1XM:  { x: -0.019, z: -0.011 },
        Mendoza_1P:   { x: 0.055, z: -0.013 },
        Mendoza_1XP:  { x: 0.055, z: -0.013 },
        Mendoza_1MO_P:  { x: 0.026, z: -0.011 },
        Mendoza_1XMO_P: { x: 0.026, z: -0.011 },

        // 2
        Mendoza_2M:   { x: 0.026, z: -0.013 },
        Mendoza_2XM:  { x: 0.026, z: -0.013 },
        Mendoza_2P:   { x: -0.024, z: -0.011 },
        Mendoza_2XP:  { x: -0.024, z: -0.011 },

        // 3
        Mendoza_3M:   { x: 0.028, z: -0.011 },
        Mendoza_3XM:  { x: 0.028, z: -0.011 },
        Mendoza_3P:   { x: 0.034, z: -0.011 },
        Mendoza_3XP:  { x: 0.034, z: -0.011 },
      },

      // napojenĂ­ na roh_P z BOKU (left/right) -> vĹˇechny M + L
      side: {
        // 1
        Mendoza_1M:   { x: 0.0, z: 0.008 },
        Mendoza_1XM:  { x: 0.0, z: 0.008 },
        Mendoza_1L:   { x: 0.006, z: 0.009 },
        Mendoza_1XL:  { x: 0.006, z: 0.009 },
        Mendoza_1MO_L:  { x: 0.011, z: 0.009 },
        Mendoza_1XMO_L: { x: 0.011, z: 0.009 },

        // 2
        Mendoza_2M:   { x: 0.006, z: 0.009 },
        Mendoza_2XM:  { x: 0.006, z: 0.009 },
        Mendoza_2L:   { x: 0.006, z: 0.008 },
        Mendoza_2XL:  { x: 0.006, z: 0.008 },

        // 3
        Mendoza_3M:   { x: 0.005, z: 0.008 },
        Mendoza_3XM:  { x: 0.005, z: 0.008 },
        Mendoza_3L:   { x: 0.006, z: 0.008 },
        Mendoza_3XL:  { x: 0.006, z: 0.008 },
      },
    },

    // ===== kdyĹľ je BASE ROH L =====
    roh_L: {
      // napojenĂ­ na roh_L ze ZEPĹEDU (front/back) -> vĹˇechny M + L
      front: {
        // 1
        Mendoza_1M:   { x: 0.022, z: -0.008 },
        Mendoza_1XM:  { x: 0.022, z: -0.008 },
        Mendoza_1L:   { x: -0.029, z: -0.010 },
        Mendoza_1XL:  { x: -0.029, z: -0.010 },
        Mendoza_1MO_L:  { x: -0.031, z: -0.010 },
        Mendoza_1XMO_L: { x: -0.031, z: -0.010 },

        // 2
        Mendoza_2M:   { x: -0.016, z: -0.008 },
        Mendoza_2XM:  { x: -0.016, z: -0.008 },
        Mendoza_2L:   { x: -0.004, z: -0.009 },
        Mendoza_2XL:  { x: -0.004, z: -0.009 },

        // 3
        Mendoza_3M:   { x: -0.016, z: -0.006 },
        Mendoza_3XM:  { x: -0.016, z: -0.006 },
        Mendoza_3L:   { x: -0.067, z: -0.008 },
        Mendoza_3XL:  { x: -0.067, z: -0.008 },
      },

      // napojenĂ­ na roh_L z BOKU (left/right) -> vĹˇechny M + P
      side: {
        // 1
        Mendoza_1M:   { x: 0.005, z: -0.034 },
        Mendoza_1XM:  { x: 0.005, z: -0.034 },
        Mendoza_1P:   { x: -0.002, z: -0.032 },
        Mendoza_1XP:  { x: -0.002, z: -0.032 },
        Mendoza_1MO_P:  { x: -0.004, z: -0.029 },
        Mendoza_1XMO_P: { x: -0.004, z: -0.029 },

        // 2
        Mendoza_2M:   { x: -0.004, z: -0.029 },
        Mendoza_2XM:  { x: -0.004, z: -0.029 },
        Mendoza_2P:   { x: -0.004, z: -0.029 },
        Mendoza_2XP:  { x: -0.004, z: -0.029 },

        // 3
        Mendoza_3M:   { x: -0.004, z: -0.032 },
        Mendoza_3XM:  { x: -0.004, z: -0.032 },
        Mendoza_3P:   { x: -0.004, z: -0.034 },
        Mendoza_3XP:  { x: -0.004, z: -0.034 },
      },
    },
  },

  Melbourne: {
    roh_P: {
      front: {
        // 1
        Melbourne_1M: { x: 0.435, z: -0.028 },
        Melbourne_1XM: { x: 0.435, z: -0.028 },
        Melbourne_1P: { x: 0.405, z: -0.028 },
        Melbourne_1XP: { x: 0.405, z: -0.028 },
        Melbourne_1MO_P: { x: 0.40, z: -0.03 },
        Melbourne_1XMO_P: { x: 0.40, z: -0.03 },

        // 2
        Melbourne_2M: { x: 0.923, z: -0.035 },
        Melbourne_2XM: { x: 0.923, z: -0.035 },
        Melbourne_2P: { x: 0.5025, z: -0.031 },
        Melbourne_2XP: { x: 0.5025, z: -0.031 },

        // 3
        Melbourne_3M: { x: 0.428, z: -0.033 },
        Melbourne_3XM: { x: 0.428, z: -0.033 },
        Melbourne_3P: { x: 0.405, z: -0.033 },
        Melbourne_3XP: { x: 0.405, z: -0.033 },
      },

      side: {
        // 1
        Melbourne_1M: { x: 0.005, z: -0.448 },
        Melbourne_1XM: { x: 0.005, z: -0.448 },
        Melbourne_1L: { x: 0.005, z: -0.448 },
        Melbourne_1XL: { x: 0.005, z: -0.448 },
        Melbourne_1MO_L: { x: 0.005, z: -0.448 },
        Melbourne_1XMO_L: { x: 0.005, z: -0.448 },

        // 2
        Melbourne_2M: { x: 0.005, z: -0.445 },
        Melbourne_2XM: { x: 0.005, z: -0.445 },
        Melbourne_2L: { x: 0.005, z: -0.445 },
        Melbourne_2XL: { x: 0.005, z: -0.445 },

        // 3
        Melbourne_3M: { x: 0.005, z: -0.445 },
        Melbourne_3XM: { x: 0.005, z: -0.445 },
        Melbourne_3L: { x: 0.005, z: -0.445 },
        Melbourne_3XL: { x: 0.005, z: -0.445 },
      },
    },

    roh_L: {
      front: {
        // 1
        Melbourne_1M: { x: -0.425, z: -0.031 },
        Melbourne_1XM: { x: -0.425, z: -0.031 },
        Melbourne_1L: { x: -0.393, z: -0.027 },
        Melbourne_1XL: { x: -0.393, z: -0.027 },
        Melbourne_1MO_L: { x: -0.485, z: -0.031 },
        Melbourne_1XMO_L: { x: -0.485, z: -0.031 },

        // 2
        Melbourne_2M: { x: -0.915, z: -0.031 },
        Melbourne_2XM: { x: -0.915, z: -0.031 },
        Melbourne_2L: { x: -0.492, z: -0.031 },
        Melbourne_2XL: { x: -0.492, z: -0.031 },

        // 3
        Melbourne_3M: { x: -0.413, z: -0.031 },
        Melbourne_3XM: { x: -0.413, z: -0.031 },
        Melbourne_3L: { x: -0.392, z: -0.031 },
        Melbourne_3XL: { x: -0.392, z: -0.031 },
      },

      side: {
        // 1
        Melbourne_1M: { x: -0.005, z: -0.448 },
        Melbourne_1XM: { x: -0.005, z: -0.448 },
        Melbourne_1P: { x: -0.005, z: -0.448 },
        Melbourne_1XP: { x: -0.005, z: -0.448 },
        Melbourne_1MO_P: { x: -0.005, z: -0.448 },
        Melbourne_1XMO_P: { x: -0.005, z: -0.448 },

        // 2
        Melbourne_2M: { x: -0.01, z: -0.445 },
        Melbourne_2XM: { x: -0.01, z: -0.445 },
        Melbourne_2P: { x: -0.01, z: -0.445 },
        Melbourne_2XP: { x: -0.01, z: -0.445 },

        // 3
        Melbourne_3M: { x: -0.01, z: -0.445 },
        Melbourne_3XM: { x: -0.01, z: -0.445 },
        Melbourne_3P: { x: -0.01, z: -0.445 },
        Melbourne_3XP: { x: -0.01, z: -0.445 },
      },
    },
  },

  // =================================
  // ========= MANCHESTER ============
  // =================================

  Manchester: {

    roh_P: {
      front: {
        // 1
        Manchester_1M:     { x: 0.025, z: -0.025 },
        Manchester_1XM:    { x: 0.025, z: -0.025 },
        Manchester_1P:     { x: -0.027, z: -0.0248 },
        Manchester_1XP:    { x: -0.027, z: -0.0248 },
        Manchester_1MO_P:  { x: 0.06, z: -0.015 },
        Manchester_1XMO_P: { x: 0.06, z: -0.015 },

        // 2
        Manchester_2M:  { x: 0.025, z: -0.03 },
        Manchester_2XM: { x: 0.025, z: -0.03 },
        Manchester_2P:  { x: -0.027, z: -0.0248 },
        Manchester_2XP: { x: -0.027, z: -0.0248 },

        // 3
        Manchester_3M:  { x: 0.022, z: -0.03 },
        Manchester_3XM: { x: 0.022, z: -0.03 },
        Manchester_3P:  { x: 0.1125, z: -0.02 },
        Manchester_3XP: { x: 0.1125, z: -0.02 },
      },

      // napojení na roh_P z boku (left/right) -> M + L moduly
      side: {
        // 1
        Manchester_1M:     { x: 0.01, z: 0.006 },
        Manchester_1XM:    { x: 0.01, z: 0.006 },
        Manchester_1L:     { x: 0.01, z: 0.004 },
        Manchester_1XL:    { x: 0.01, z: 0.004 },
        Manchester_1MO_L:  { x: 0.01, z: 0.008 },
        Manchester_1XMO_L: { x: 0.01, z: 0.008 },

        // 2
        Manchester_2M:  { x: 0.01, z: 0.006 },
        Manchester_2XM: { x: 0.01, z: 0.006 },
        Manchester_2L:  { x: 0.015, z: 0.006 },
        Manchester_2XL: { x: 0.015, z: 0.006 },

        // 3
        Manchester_3M:  { x: 0.01, z: 0.008 },
        Manchester_3XM: { x: 0.01, z: 0.008 },
        Manchester_3L:  { x: 0.01, z: 0.007 },
        Manchester_3XL: { x: 0.01, z: 0.007 },
      },
    },

    // ===== když je BASE ROH L =====
    roh_L: {
      // napojení na roh_L zepředu (front/back) -> M + L moduly
      front: {
        // 1
        Manchester_1M:     { x: 0.013, z: -0.028 },
        Manchester_1XM:    { x: 0.013, z: -0.028 },
        Manchester_1L:     { x: -0.047, z: -0.025 },
        Manchester_1XL:    { x: -0.047, z: -0.025 },
        Manchester_1MO_L:  { x: -0.038, z: -0.02 },
        Manchester_1XMO_L: { x: -0.038, z: -0.02 },

        // 2
        Manchester_2M:  { x: 0.014, z: -0.025 },
        Manchester_2XM: { x: 0.014, z: -0.025 },
        Manchester_2L:  { x: 0.006, z: -0.025 },
        Manchester_2XL: { x: 0.006, z: -0.025 },

        // 3
        Manchester_3M:  { x: 0.018, z: -0.025 },
        Manchester_3XM: { x: 0.018, z: -0.025 },
        Manchester_3L:  { x: -0.504, z: -0.02 },
        Manchester_3XL: { x: -0.504, z: -0.02 },
      },

      // napojení na roh_L z boku (left/right) -> M + P moduly
      side: {
        // 1
        Manchester_1M:     { x: -0.012, z: 0.005 },
        Manchester_1XM:    { x: -0.012, z: 0.005 },
        Manchester_1P:     { x: -0.015, z: 0.008 },
        Manchester_1XP:    { x: -0.015, z: 0.008 },
        Manchester_1MO_P:  { x: -0.015, z: 0.008 },
        Manchester_1XMO_P: { x: -0.015, z: 0.008 },

        // 2
        Manchester_2M:  { x: -0.015, z: 0.006 },
        Manchester_2XM: { x: -0.015, z: 0.006 },
        Manchester_2P:  { x: -0.018, z: 0.005 },
        Manchester_2XP: { x: -0.018, z: 0.005 },

        // 3
        Manchester_3M:  { x: -0.015, z: 0.008 },
        Manchester_3XM: { x: -0.015, z: 0.008 },
        Manchester_3P:  { x: -0.015, z: 0.008 },
        Manchester_3XP: { x: -0.015, z: 0.008 },
      },
    },
  },
};

function addOnAxis(obj, axisWorldVec, amount) {
  obj.position.add(axisWorldVec.clone().multiplyScalar(amount));
}

function applyExtraLocal(added, base, extra) {
  if (!extra) return;

  base.updateMatrixWorld(true);

  // lokĂˇlnĂ­ osy base pĹ™evedenĂ© do svÄ›ta
  const baseRight   = new THREE.Vector3(1, 0, 0).applyQuaternion(base.quaternion); // "right" base
  const baseForward = new THREE.Vector3(0, 0, 1).applyQuaternion(base.quaternion); // "front" base

  // extra.x = posun "do strany" (po baseRight)
  // extra.z = posun "dopĹ™edu/dozadu" (po baseForward)
  addOnAxis(added, baseRight,   extra.x || 0);
  addOnAxis(added, baseForward, extra.z || 0);
}

// zarovnĂˇnĂ­ modulĹŻ podle sedĂˇkĹŻ
function snapModules(baseRecord, newRecord, direction) {
  const base  = baseRecord.mesh;
  const added = newRecord.mesh;

  base.updateMatrixWorld(true);
  added.updateMatrixWorld(true);

  // lokĂˇlnĂ­ osy base modulu ve svÄ›tÄ›
  const baseRight   = new THREE.Vector3(1, 0, 0).applyQuaternion(base.quaternion).normalize();
  const baseForward = new THREE.Vector3(0, 0, 1).applyQuaternion(base.quaternion).normalize();

  // interval projekce Box3 na danou osu (vezmeme 8 rohĹŻ)
  function projectBoxToAxis(box, axis) {
    const pts = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      const d = p.dot(axis);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { min, max };
  }

  // posun added tak, aby jeho interval na ose "axis" dosedl na base interval (touch)
  // side = +1 => added jde na "max" stranu base (right/front)
  // side = -1 => added jde na "min" stranu base (left/back)
  function moveToTouchOnAxis(axis, side, extra = 0) {
    // 0) jistota: aĹĄ jsou world matice aktuĂˇlnĂ­ pĹ™ed vĂ˝poÄŤtem boxĹŻ
    base.updateMatrixWorld(true);
    added.updateMatrixWorld(true);

    // 1) prvnĂ­ posun (stejnÄ› jako dĹ™Ă­v)
    let baseBox = getSnapBox(base);
    let newBox  = getSnapBox(added);

    let A = projectBoxToAxis(baseBox, axis);
    let B = projectBoxToAxis(newBox, axis);

    // cĂ­lovĂ˝ dotyk vÄŤetnÄ› extra
    const target = side > 0 ? (A.max + extra) : (A.min - extra);

    let delta;
    if (side > 0) delta = target - B.min;  // B.min -> target
    else          delta = target - B.max;  // B.max -> target

    added.position.add(axis.clone().multiplyScalar(delta));
    added.updateMatrixWorld(true);

    // 2) doraz (po zmÄ›nÄ› world boxu) â€“ OPÄšT do stejnĂ©ho targetu vÄŤetnÄ› extra
    base.updateMatrixWorld(true);
    added.updateMatrixWorld(true);

    baseBox = getSnapBox(base);
    newBox  = getSnapBox(added);

    A = projectBoxToAxis(baseBox, axis);
    B = projectBoxToAxis(newBox, axis);

    const target2 = side > 0 ? (A.max + extra) : (A.min - extra);

    let fix;
    if (side > 0) fix = target2 - B.min;
    else          fix = target2 - B.max;

    if (Math.abs(fix) > 1e-6) {
      added.position.add(axis.clone().multiplyScalar(fix));
      added.updateMatrixWorld(true);
    }
  }

  // dorovnĂˇnĂ­ na ose (kolmĂˇ osa) na target = base + offset
  function alignOnAxis(axis, offsetValue) {
    const baseProj  = base.position.dot(axis);
    const addedProj = added.position.dot(axis);
    const target = baseProj + offsetValue;
    const delta = target - addedProj;
    added.position.add(axis.clone().multiplyScalar(delta));
  }

  // --- offsety (tvĂ© ladÄ›nĂ­ zachovanĂ©) ---
  const baseBack  = backOffsets[baseRecord.name] || 0;
  const addedBack = backOffsets[newRecord.name] || 0;

  function getSideOffsetFor(recordName, dir) {
    const byDir = sideOffsetsByDir[recordName];
    if (!byDir) return sideOffsets[recordName] || 0;

    // pro left/right pouĹľij specifickou hodnotu, jinak fallback
    if (dir === "left" || dir === "right") {
      return byDir[dir] ?? (sideOffsets[recordName] || 0);
    }
    return sideOffsets[recordName] || 0;
  }

  const baseSide  = getSideOffsetFor(baseRecord.name, direction);
  const addedSide = getSideOffsetFor(newRecord.name, oppositeDirection(direction));

  const baseCornerKey =
    /_roh_P$/i.test(String(baseRecord.name || "").trim()) ? "roh_P" :
    /_roh_L$/i.test(String(baseRecord.name || "").trim()) ? "roh_L" :
    null;

  const addedCornerKey =
    /_roh_P$/i.test(String(newRecord.name || "").trim()) ? "roh_P" :
    /_roh_L$/i.test(String(newRecord.name || "").trim()) ? "roh_L" :
    null;

  const baseIsCorner  = !!baseCornerKey;
  const addedIsCorner = !!addedCornerKey;

  const baseSofaKey  = sofaKeyFromVariantId(baseRecord.name);
  const addedSofaKey = sofaKeyFromVariantId(newRecord.name);

  // --- 1) HLAVNĂŤ POSUN = pĹ™ipojenĂ­ po lokĂˇlnĂ­ ose base modulu ---
  if (direction === "right") {
    // Ĺ™ada jde po baseRight na +
    moveToTouchOnAxis(baseRight, +1, -(baseSide + addedSide));

    // kolmo dorovnĂˇme "back/front" po baseForward
    alignOnAxis(baseForward, (baseBack - addedBack));

    // EXTRA rohy (lokĂˇlnÄ› podle base)
    if (baseIsCorner) {
      const extra = cornerExtraBySofa?.[baseSofaKey]?.[baseCornerKey]?.side?.[newRecord.name];
      applyExtraLocal(added, base, extra);
    }

    if (addedIsCorner) {
      const extra = cornerExtraBySofa?.[addedSofaKey]?.[addedCornerKey]?.side?.[baseRecord.name];
      if (extra) applyExtraLocal(added, base, { x: -(extra.x || 0), z: -(extra.z || 0) });
    }

  } else if (direction === "left") {
    moveToTouchOnAxis(baseRight, -1, -(baseSide + addedSide));
    alignOnAxis(baseForward, (baseBack - addedBack));

    if (baseIsCorner) {
      const extra = cornerExtraBySofa?.[baseSofaKey]?.[baseCornerKey]?.side?.[newRecord.name];
      applyExtraLocal(added, base, extra);
    }

    if (addedIsCorner) {
      const extra = cornerExtraBySofa?.[addedSofaKey]?.[addedCornerKey]?.side?.[baseRecord.name];
      if (extra) applyExtraLocal(added, base, { x: -(extra.x || 0), z: -(extra.z || 0) });
    }

  } else if (direction === "front") {
    // Ĺ™ada jde po baseForward na +
    moveToTouchOnAxis(baseForward, +1, 0);

    // kolmo dorovnĂˇme "left/right" po baseRight
    alignOnAxis(baseRight, (baseSide - addedSide));

    if (baseIsCorner) {
      const extra = cornerExtraBySofa?.[baseSofaKey]?.[baseCornerKey]?.front?.[newRecord.name];
      applyExtraLocal(added, base, extra);
    }
    if (addedIsCorner) {
      const extra = cornerExtraBySofa?.[addedSofaKey]?.[addedCornerKey]?.front?.[baseRecord.name];
      if (extra) applyExtraLocal(added, base, { x: -(extra.x || 0), z: -(extra.z || 0) });
    }

  } else if (direction === "back") {
    moveToTouchOnAxis(baseForward, -1, 0);
    alignOnAxis(baseRight, (baseSide - addedSide));

    if (baseIsCorner) {
      const extra = cornerExtraBySofa?.[baseSofaKey]?.[baseCornerKey]?.front?.[newRecord.name];
      applyExtraLocal(added, base, extra);
    }
    if (addedIsCorner) {
      const extra = cornerExtraBySofa?.[addedSofaKey]?.[addedCornerKey]?.front?.[baseRecord.name];
      if (extra) applyExtraLocal(added, base, { x: -(extra.x || 0), z: -(extra.z || 0) });
    }
  }

  added.updateMatrixWorld(true);
}

function repositionButtonsForModule(record) {
  const offsets = getModuleAddButtonOffsets()[normalizeOffsetKey(record.name)] || [];

  for (const def of offsets) {
    const btn = record.buttons[def.direction];
    if (!btn) continue;

    const worldPos = record.mesh.localToWorld(def.offset.clone());
    btn.position.copy(worldPos);
  }
}

// -----------------------------------------------------
//  AKCE MODUL MENU (DELETE / REPLACE)
// -----------------------------------------------------

document.querySelector(".module-action-btn.delete").onclick = async () => {
  if (!selectedModule) return;

  // âťŚ ZakĂˇzat mazĂˇnĂ­ prostĹ™ednĂ­ch modulĹŻ
  if (!isLeafModule(selectedModule)) {
    showPlacementMessage(
      "Pro odstranění tohoto modulu nejdříve odstraňte krajní moduly.",
      5000
    );

    // zavĹ™Ă­t menu + blocker
    moduleActionMenu.classList.remove("visible");
    selectedModule = null;
    document.getElementById("actionMenuBlocker")?.classList.remove("active");
    return;
  }

  // âś… KdyĹľ se maĹľe poslednĂ­ modul â†’ reset celĂ© scĂ©ny
  if (activeModules.length === 1) {
    // selectedModule je mesh
    scene.remove(selectedModule);

    // kompletnĂ­ reset (vytvoĹ™Ă­ novĂ˝ start button)
    resetSceneState();
    resetFabricSelectionState({ save: true });

    updateSummaryUI();
    scheduleSummaryRecalc();

    moduleActionMenu.classList.remove("visible");
    selectedModule = null;
    document.getElementById("actionMenuBlocker")?.classList.remove("active");
    return;
  }

  const root = selectedModule;

  // 1) najdi RECORD modulu
  const rec = activeModules.find((m) => m.mesh === root);
  if (!rec) return;

  // 2) Odpoj sousedy (sprĂˇvnÄ› i pro rohy/rotace)
  for (const side of ["left", "right", "front", "back"]) {
    const neighborMesh = rec.connections?.[side];
    if (!neighborMesh) continue;

    const nb = activeModules.find((m) => m.mesh === neighborMesh);
    if (nb) {
      const neighborSide = getConnectionSide(nb.mesh, rec.mesh);
      if (neighborSide) nb.connections[neighborSide] = null;
    }
  }

  // 3) Odpoj rec od vĹˇech
  for (const side of ["left", "right", "front", "back"]) {
    if (rec.connections) rec.connections[side] = null;
  }

  // 4) odstranit modul ze scĂ©ny
  scene.remove(root);

  // 5) odstranit modul z activeModules (jen jednou)
  let removed = false;
  for (let i = activeModules.length - 1; i >= 0; i--) {
    if (activeModules[i].mesh === root) {
      activeModules.splice(i, 1);
      removed = true;
      break;
    }
  }

  // 6) kdyĹľ je scĂ©na prĂˇzdnĂˇ â†’ ukaĹľ start button
  if (removed && activeModules.length === 0 && startButton) {
    startButton.visible = true;
  }

  // 7) UI + tlaÄŤĂ­tka + layout
  updateButtons();
  relayoutFromAnchor();
  await rebuildAllAddButtons();
  recomputeCameraFit();
  scheduleSummaryRecalc();
  refreshStepValidityAfterCompositionChange();

  if (isBuildStepActive()) {
    scheduleCanonicalRebuildAnalysis();
  }

  // 8) zavĹ™Ă­t menu + blocker
  moduleActionMenu.classList.remove("visible");
  selectedModule = null;
  document.getElementById("actionMenuBlocker")?.classList.remove("active");
};

moduleActionMenu.addEventListener("pointerdown", (e) => {
  e.stopPropagation(); // zabrĂˇnĂ­ kliknutĂ­ na modul pod tĂ­m
});

document.querySelector(".module-action-btn.replace").onclick = () => {
  if (!selectedModule) return;

  const replaceBtn = document.querySelector(".module-action-btn.replace");

  // âś… kdyĹľ je roh zakĂˇzanĂ˝, ukaĹľ hlĂˇĹˇku a nic nedÄ›lej
  if (replaceBtn?.classList.contains("disabled")) {
    showPlacementMessage(
      "Roh nejde vyměnit, pokud jsou na něj napojené moduly z obou stran.",
      5000
    );
    return;
  }

  replaceTarget = getModuleRoot(selectedModule); // âś… ROOT

  const pos = new THREE.Vector3();
  replaceTarget.getWorldPosition(pos);
  pendingAddPosition = pos;

  openModulePicker(pos);

  moduleActionMenu.classList.remove("visible");
  selectedModule = null;
  document.getElementById("actionMenuBlocker").classList.remove("active");
};

// -----------------------------------------------------
//  HOVER EFEKTY NA TLAÄŚĂŤTKA
// -----------------------------------------------------

function applyButtonHover(btn) {
  if (!btn) return;

  // init per-button anim data (jen jednou)
  btn.userData._hoverT = 1;     // target: 1 = hover ON
  if (btn.userData._hoverX == null) btn.userData._hoverX = 0;  // current (0..1)
  if (btn.userData._hoverV == null) btn.userData._hoverV = 0;  // velocity

  // zesvÄ›tlenĂ­ udÄ›lej jen pĹ™i â€śenterâ€ť, ne kaĹľdĂ˝m framem
  if (!btn.userData._hoverBright) {
    btn.userData._hoverBright = true;

    btn.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.material) return;

      const mat = mesh.material.clone();
      if (mat.color) mat.color.offsetHSL(0, 0, 0.12);
      mesh.material = mat;
    });
  }
}

function resetButtonHover(btn) {
  if (!btn) return;

  // target: 0 = hover OFF (pruĹľina si to dojede zpĂˇtky)
  btn.userData._hoverT = 0;
  if (btn.userData._hoverX == null) btn.userData._hoverX = 0;
  if (btn.userData._hoverV == null) btn.userData._hoverV = 0;

  // materiĂˇl vraĹĄ hned (aĹĄ to vizuĂˇlnÄ› reaguje okamĹľitÄ›)
  btn.userData._hoverBright = false;

  btn.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (mesh.userData.originalMaterial) {
      mesh.material = mesh.userData.originalMaterial.clone();
    }
  });
}

const BTN_BASE_SCALE = 1.0;
const BTN_HOVER_SCALE = 1.18;   // jak moc se zvÄ›tĹˇĂ­ (zkus 1.15â€“1.22)
const BTN_SPRING_K = 0.18;      // sĂ­la pruĹľiny (vyĹˇĹˇĂ­ = rychlejĹˇĂ­ + vĂ­c bounce)
const BTN_DAMPING = 0.74;       // tlumenĂ­ (niĹľĹˇĂ­ = vĂ­c houpĂˇnĂ­)

function updateButtonHoverAnimations() {
  const roots = [];

  // startButton
  if (startButton && startButton.parent && startButton.visible) roots.push(startButton);

  // ostatnĂ­ aktivnĂ­ tlaÄŤĂ­tka
  for (const b of activeButtons) {
    if (b?.mesh && b.mesh.parent && b.mesh.visible) roots.push(b.mesh);
  }

  for (const btn of roots) {
    const t = (btn.userData._hoverT != null) ? btn.userData._hoverT : 0;
    let x = (btn.userData._hoverX != null) ? btn.userData._hoverX : 0;
    let v = (btn.userData._hoverV != null) ? btn.userData._hoverV : 0;

    // spring physics: v += (target-current)*k; v*=damping; x+=v
    v += (t - x) * BTN_SPRING_K;
    v *= BTN_DAMPING;
    x += v;

    // kdyĹľ je skoro hotovo, pĹ™icvakni a zastav (ĹˇetĹ™Ă­ mikro-kmitĂˇnĂ­)
    if (Math.abs(v) < 0.0005 && Math.abs(t - x) < 0.0005) {
      x = t;
      v = 0;
    }

    btn.userData._hoverX = x;
    btn.userData._hoverV = v;

    const s = BTN_BASE_SCALE + (BTN_HOVER_SCALE - BTN_BASE_SCALE) * x;
    btn.scale.set(s, s, s);
  }
}

// === RESIZE ===
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// zavĹ™enĂ­ pickeru pĹ™es âś•
document.getElementById("modulePickerClose").onclick = () => {
  pickerClosedManually = true;
  closePicker();
};

// ZavĹ™Ă­t module menu pĹ™i kliknutĂ­ mimo + DRAG START
window.addEventListener("pointerdown", (event) => {
  if (!moduleActionMenu?.classList.contains("visible")) return;

  // klik mimo menu -> zavĹ™Ă­t vĹľdy
  if (!moduleActionMenu.contains(event.target)) {
    closeActionMenu();

    downCandidate = null;
    mouseDown = false;
    dragDistance = 0;
  }
}, true); // <-- capture!

function panicCloseUI() {
  closeActionMenu();
  clearHoverEffects();
  downCandidate = null;
  mouseDown = false;
  dragDistance = 0;
}

window.addEventListener("blur", panicCloseUI);
window.addEventListener("pointercancel", panicCloseUI, true);

// kdyĹľ pustĂ­Ĺˇ tlaÄŤĂ­tko mimo canvas, three uĹľ pointerup nedostane:
window.addEventListener("pointerup", () => {
  mouseDown = false;
  dragDistance = 0;
}, true);


function dumpUIState(label = "") {
  const menu = document.getElementById("moduleActionMenu");
  const picker = document.getElementById("modulePicker");
  const blocker = document.getElementById("actionMenuBlocker");
  const canvas = renderer.domElement;

  const cs = (el) => el ? getComputedStyle(el) : null;

  debugLog("=== UI STATE", label, "===");
  debugLog("menu visible class:", menu?.classList.contains("visible"));
  debugLog("menu display:", cs(menu)?.display, "pointerEvents:", cs(menu)?.pointerEvents, "z:", cs(menu)?.zIndex);

  debugLog("picker hidden class:", picker?.classList.contains("hidden"));
  debugLog("picker display:", cs(picker)?.display, "pointerEvents:", cs(picker)?.pointerEvents, "z:", cs(picker)?.zIndex);

  debugLog("blocker active class:", blocker?.classList.contains("active"));
  debugLog("blocker pointerEvents:", cs(blocker)?.pointerEvents, "z:", cs(blocker)?.zIndex);

  // Kdo je nahoĹ™e pod kurzorem (tohle je killer diagnostika)
  const x = lastMouseX || window.innerWidth/2;
  const y = lastMouseY || window.innerHeight/2;
  debugLog("elementFromPoint:", document.elementFromPoint(x, y));

  debugLog("downCandidate:", downCandidate);
  debugLog("mouseDown:", mouseDown, "dragDistance:", dragDistance);
  debugLog("===========================");
}

// zavolej pĹ™i kaĹľdĂ©m â€śklik nejdeâ€ť
window.addEventListener("keydown", (e) => {
  if (e.key === "F8") dumpUIState("F8");
});

window.addEventListener("resize", () => {
  try { syncEquipLayout(); } catch (e) {}
});


