// src/connectionRules.js

const SIDES = ["left", "right", "front", "back"];

// vezme "Manila_1L" -> "1L", "Mendoza_roh_P" -> "roh_P"
function stripSofaPrefix(id) {
  id = (id ?? "").trim();
  const i = id.indexOf("_");
  if (i === -1) return id;
  return id.slice(i + 1);
}

function isCorner(id) {
  const raw = stripSofaPrefix(id);
  return raw === "roh_P" || raw === "roh_L";
}

function isCornerP(id) {
  return stripSofaPrefix(id) === "roh_P";
}
function isCornerL(id) {
  return stripSofaPrefix(id) === "roh_L";
}

function is1D(id) {
  const raw = stripSofaPrefix(id);
  return raw.startsWith("1D_") || raw.startsWith("1XD_");
}

function cornerAllowedSides(baseId) {
  // povolíme i "front", aby šlo na roh připojit něco zepředu
  if (isCornerP(baseId)) return new Set(["left", "front"]);
  if (isCornerL(baseId)) return new Set(["right", "front"]);
  return new Set();
}

export function getRole(id) {
  id = (id ?? "").trim();
  const raw = stripSofaPrefix(id);

  // rohy
  if (raw === "roh_P") return "cornerP";
  if (raw === "roh_L") return "cornerL";

  // L/P/M role podle koncovky (už bez prefixu)
  // - 1L, 2M, 3P
  // - 1XL, 2XM, 3XP
  if (/XL$/.test(raw) || /L$/.test(raw)) return "L";
  if (/XP$/.test(raw) || /P$/.test(raw)) return "P";
  if (/XM$/.test(raw) || /M$/.test(raw)) return "M";

  // SOLO (bez L/M/P): 2, 3, 2X, 3X ...
  if (/^\d+X?$/.test(raw)) return "SOLO";

  // křeslo bereme jako SOLO (nepřipojovat)
  if (raw === "kreslo" || raw === "kresloX" || raw === "Xkreslo") return "SOLO";

  return "unknown";
}

export function canAttach({ baseId, baseSide, newId }) {
  const baseRole = getRole(baseId);
  const newRole  = getRole(newId);

  // KDYŽ JE NOVÝ DÍL ROH a base není roh
  if (isCorner(newId) && !isCorner(baseId)) {
    // roh nepřipojuj na 1D díly
    if (is1D(baseId)) return false;

    // dovolíme připojení rohu i na L/M/P díly (nejen M)
    if (!["L", "M", "P"].includes(baseRole)) return false;

    // roh připojujeme jen ze stran
    if (!["left", "right"].includes(baseSide)) return false;

    // mapování: levá strana -> roh_L, pravá strana -> roh_P
    if (baseSide === "left")  return isCornerL(newId);
    if (baseSide === "right") return isCornerP(newId);

    return false;
  }

  // 0) SOLO se nikdy nepřipojuje ani na něj nic
  if (baseRole === "SOLO" || newRole === "SOLO") return false;

  // 1) rohy se nesmí napojit na rohy
  if (isCorner(baseId) && isCorner(newId)) return false;

  // 2) ROH jako BASE: co se na něj smí napojit
  if (isCorner(baseId)) {
    const allowed = cornerAllowedSides(baseId);
    if (!allowed.has(baseSide)) return false;

    // ❌ zakázané na roh: všechny 1D, rohy, samostatné (SOLO)
    if (is1D(newId)) return false;
    if (isCorner(newId)) return false;
    if (newRole === "SOLO") return false;

    // unknown radši zakázat
    if (newRole === "unknown") return false;

    // ✅ omezení podle tlačítka rohu:
    // roh_P:
    // - front: jen M nebo P
    // - left: jen M nebo L
    if (isCornerP(baseId)) {
      if (baseSide === "front") {
        if (!["M", "P"].includes(newRole)) return false;
      } else if (baseSide === "left") {
        if (!["M", "L"].includes(newRole)) return false;
      }
    }

    // roh_L:
    // - front: jen M nebo L
    // - right: jen M nebo P
    if (isCornerL(baseId)) {
      if (baseSide === "front") {
        if (!["M", "L"].includes(newRole)) return false;
      } else if (baseSide === "right") {
        if (!["M", "P"].includes(newRole)) return false;
      }
    }

    return true;
  }

  // 3) KDYŽ JE NOVÝ DÍL ROH (roh se připojuje NA jiný díl z boku)
  if (isCorner(newId)) {
    // nic na SOLO/unknown
    if (baseRole === "SOLO" || baseRole === "unknown") return false;

    // zákaz roh-roh
    if (isCorner(baseId)) return false;

    // zákaz 1D <-> roh
    if (is1D(baseId)) return false;

    // mapování: levá strana base => roh_L, pravá strana => roh_P
    if (baseSide === "left")  return isCornerL(newId);
    if (baseSide === "right") return isCornerP(newId);

    return false;
  }

  // 4) KLASIKA L/M/P pravidla
  if (baseRole === "L") {
    if (baseSide !== "right") return false;
    return (newRole === "M" || newRole === "P");
  }

  if (baseRole === "P") {
    if (baseSide !== "left") return false;
    return (newRole === "M" || newRole === "L");
  }

  if (baseRole === "M") {
    if (baseSide === "left")  return (newRole === "L" || newRole === "M");
    if (baseSide === "right") return (newRole === "M" || newRole === "P");
    return false;
  }

  return false;
}

export function filterVariantIdsForPicker({ baseId, baseSide, variantIds }) {
  return variantIds.filter((newId) => canAttach({ baseId, baseSide, newId }));
}

export function shouldHaveButtons(variantId) {
  const role = getRole(variantId);
  if (role === "SOLO") return false;
  if (role === "unknown") return false;
  return true;
}