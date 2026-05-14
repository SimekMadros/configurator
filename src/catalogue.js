// src/catalogue.js

// ====================
//  POTAHY + UPGRADES
// ====================

export const UPGRADES = {
  storage: { id: "storage", label: "Úložný prostor" },
  bed: { id: "bed", label: "Rozklad" },
  bed2: { id: "bed2", label: "Rozklad 2" },
};

export const FABRICS = {
  g1: { id: "g1", label: "Látka 1" },
  g2: { id: "g2", label: "Látka 2" },
  g3: { id: "g3", label: "Látka 3" },
  leather: { id: "leather", label: "Kůže" },
};

export function formatCzk(n) {
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: "CZK",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n || 0);
}

// ====================
//  HELPERS
// ====================

const F_KEYS = ["g1", "g2", "g3", "leather"];

// vracĂ­ {g1:0,g2:0,g3:0,leather:0}
const Z = () => ({ g1: 0, g2: 0, g3: 0, leather: 0 });

// bezpeÄŤnĂ˝ merge cen (kdyĹľ doplnĂ­Ĺˇ jen g1 a zbytek pozdÄ›ji)
function fillPrices(partial) {
  const out = Z();
  if (!partial) return out;
  for (const k of F_KEYS) {
    if (partial[k] != null) out[k] = partial[k];
  }
  return out;
}

/**
 * Standard tvar pro ceny (CENA CELĂ‰HO MODULU):
 * base:    {g1,g2,g3,leather}
 * storage: {g1,g2,g3,leather}   // cena modulu s ĂşloĹľĂˇkem
 * bed:     {g1,g2,g3,leather}   // cena modulu s rozkladem
 */
function makePriceEntry({
  base,
  storage,
  bed,
  bed2,
  extendedBase,
  extendedStorage
} = {}) {
  return {
    base: fillPrices(base),
    storage: fillPrices(storage),
    bed: fillPrices(bed),
    bed2: fillPrices(bed2),
    extendedBase: fillPrices(extendedBase),
    extendedStorage: fillPrices(extendedStorage),
  };
}

// Factory pro variantu
function makeVariant({
  id,
  label,
  model,
  dimsCm = { w: 0, d: 0, h: 0 },
  seatWidthRangeCm = { min: 0, max: 0 },
  depthRangeCm = null, // { min, max } | null
  allowedUpgrades = [],
  scaleX = 1.0,
  priceEntry = null, // {base,storage,bed,bed2}
}) {
  const p = priceEntry || makePriceEntry();

  return {
    id,
    label,
    model,
    dimsCm,
    seatWidthRangeCm,
    depthRangeCm,

    // NOTE:
    // prices = base cena
    // upgradePrices = CENA MODULU s upgradem (ne pĹ™Ă­platek)
    prices: p.base,
    upgradePrices: {
      storage: p.storage,
      bed: p.bed,
      bed2: p.bed2,
      extendedBase: p.extendedBase,
      extendedStorage: p.extendedStorage,
    },

    allowedUpgrades,
    scaleX,
  };
}

/**
 * PĹ™idĂˇ base + X variantu (stejnĂ˝ GLB model) do catalogu.
 * X varianta dostane id automaticky (Manila_2M -> Manila_2XM).
 */
function addBaseAndX(catalog, {
  baseId,
  baseLabel,
  model,
  allowX = true,
  xSuffix = "X",

  baseDimsCm,
  xDimsCm,
  baseRangeCm,
  xRangeCm,
  depthRangeCm = null, // {min,max} | null

  allowedUpgradesBase = [],
  allowedUpgradesX = null, // kdyĹľ null -> zdÄ›dĂ­ base
  priceBase = null,        // makePriceEntry(.)
  priceX = null,           // makePriceEntry(.)
  scaleXBase = 1.0,
  scaleXX = 1.0,
}) {
  // base
  catalog[baseId] = makeVariant({
    id: baseId,
    label: baseLabel,
    model,
    dimsCm: baseDimsCm,
    seatWidthRangeCm: baseRangeCm,
    depthRangeCm,
    allowedUpgrades: allowedUpgradesBase,
    scaleX: scaleXBase,
    priceEntry: priceBase,
  });

  if (!allowX) return;

  // vytvoĹ™enĂ­ xId typu Manila_2XM z Manila_2M
  const xId = baseId.replace(/_([0-9A-Za-z]+)$/, (_, tail) => {
    const m = tail.match(/^(\d+)([A-Za-z].*)$/);
    if (!m) return `_${tail}${xSuffix}`;
    const num = m[1];
    const rest = m[2];
    if (/^[MLP]$/.test(rest)) return `_${num}${xSuffix}${rest}`;
    return `_${num}${xSuffix}${rest}`;
  });

  // FIX pro 1D/1MO (X patĹ™Ă­ doprostĹ™ed) â€” univerzĂˇlnÄ› pro jakoukoliv sedaÄŤku
  let xIdFixed = xId;
  xIdFixed = xIdFixed.replace(/^([A-Za-z]+)_(\d+)D_([LMP])X$/, "$1_$2XD_$3");
  xIdFixed = xIdFixed.replace(/^([A-Za-z]+)_(\d+)MO_([LP])X$/, "$1_$2XMO_$3");

  const xLabel = (() => {
    const m = baseLabel.match(/^(\d+)([A-Za-z].*)$/);
    if (!m) return `${baseLabel}${xSuffix}`;
    const num = m[1];
    const rest = m[2];
    if (/^[MLP]$/.test(rest)) return `${num}${xSuffix}${rest}`;
    return `${num}${xSuffix}${rest}`;
  })();

  // FIX i pro label, aĹĄ nevznikĂˇ 1MO_PX apod.
  let xLabelFixed = xLabel;
  xLabelFixed = xLabelFixed.replace(/^(\d+)D_([LMP])X$/, "$1XD_$2");
  xLabelFixed = xLabelFixed.replace(/^(\d+)MO_([LP])X$/, "$1XMO_$2");

  catalog[xIdFixed] = makeVariant({
    id: xIdFixed,
    label: xLabelFixed,
    model, // STEJNĂť GLB
    dimsCm: xDimsCm ?? { w: 0, d: 0, h: 0 },
    seatWidthRangeCm: xRangeCm ?? { min: 0, max: 0 },
    depthRangeCm,
    allowedUpgrades: (allowedUpgradesX ?? allowedUpgradesBase),
    scaleX: scaleXX,
    priceEntry: priceX,
  });
}

// ====================
//  1) CENY (DOPLĹ‡UJEĹ  JEN TADY)
// ====================
//
// Sem doplnĂ­Ĺˇ ceny pro KAĹ˝DOU VARIANTU, kterou mĂˇĹˇ v tabulce.
// KlĂ­ÄŤ = variantId (napĹ™. "Manila_2M", "Manila_2XM").
//
// base    = cena modulu bez upgradu
// storage = cena modulu s ĂşloĹľĂˇkem (pokud existuje)
// bed     = cena modulu s rozkladem (pokud existuje)
//
// Pokud nÄ›co neexistuje, nech 0 (nebo nedoplĹ) a hlavnÄ› to NEDĂVEJ do allowedUpgrades.
// (UI pak nebude nabĂ­zet storage/bed u toho modulu.)
//

const PRICES = {
  // ===== 1D =====
  Manila_1D_L: makePriceEntry({
    base:            { g1: 33251, g2: 34731, g3: 37099, leather: 52096 },
    storage:         { g1: 33251, g2: 34731, g3: 37099, leather: 52096 },
    extendedBase:    { g1: 36576, g2: 38204, g3: 40809, leather: 57306 },
    extendedStorage: { g1: 36576, g2: 38204, g3: 40809, leather: 57306 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1XD_L: makePriceEntry({
    base:            { g1: 36576, g2: 38204, g3: 40808, leather: 57305 },
    storage:         { g1: 36576, g2: 38204, g3: 40808, leather: 57305 },
    extendedBase:    { g1: 40234, g2: 42024, g3: 44889, leather: 63036 },
    extendedStorage: { g1: 40234, g2: 42024, g3: 44889, leather: 63036 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1D_P: makePriceEntry({
    base:            { g1: 33251, g2: 34731, g3: 37099, leather: 52096 },
    storage:         { g1: 33251, g2: 34731, g3: 37099, leather: 52096 },
    extendedBase:    { g1: 36576, g2: 38204, g3: 40809, leather: 57306 },
    extendedStorage: { g1: 36576, g2: 38204, g3: 40809, leather: 57306 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1XD_P: makePriceEntry({
    base:            { g1: 36576, g2: 38204, g3: 40808, leather: 57305 },
    storage:         { g1: 36576, g2: 38204, g3: 40808, leather: 57305 },
    extendedBase:    { g1: 40234, g2: 42024, g3: 44889, leather: 63036 },
    extendedStorage: { g1: 40234, g2: 42024, g3: 44889, leather: 63036 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1 =====
  Manila_1L: makePriceEntry({
    base:    { g1: 19240, g2: 20325, g3: 22299, leather: 30488 },
    storage: { g1: 21213, g2: 22299, g3: 24272, leather: 32461 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1XL: makePriceEntry({
    base:    { g1: 21164, g2: 22358, g3: 24528, leather: 33537 },
    storage: { g1: 23335, g2: 24528, g3: 26699, leather: 35707 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_1M: makePriceEntry({
    base:    { g1: 16773, g2: 17563, g3: 19141, leather: 26344 },
    storage: { g1: 18747, g2: 19536, g3: 21115, leather: 28317 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_1XM: makePriceEntry({
    base:    { g1: 18451, g2: 19319, g3: 21055, leather: 28978 },
    storage: { g1: 20621, g2: 21490, g3: 23226, leather: 31149 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_1P: makePriceEntry({
    base:    { g1: 19240, g2: 20325, g3: 22299, leather: 30488 },
    storage: { g1: 21213, g2: 22299, g3: 24272, leather: 32461 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_1XP: makePriceEntry({
    base:    { g1: 21164, g2: 22358, g3: 24528, leather: 33537 },
    storage: { g1: 23335, g2: 24528, g3: 26699, leather: 35707 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1MO =====
  Manila_1MO_L: makePriceEntry({
    base:    { g1: 27133, g2: 29600, g3: 32067, leather: 44400 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1XMO_L: makePriceEntry({
    base:    { g1: 29847, g2: 32560, g3: 35273, leather: 48840 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1MO_P: makePriceEntry({
    base:    { g1: 27133, g2: 29600, g3: 32067, leather: 44400 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
  Manila_1XMO_P: makePriceEntry({
    base:    { g1: 29847, g2: 32560, g3: 35273, leather: 48840 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 2 =====
  Manila_2: makePriceEntry({
    base:    { g1: 38480, g2: 40651, g3: 44597, leather: 62949 },
    storage: { g1: 42427, g2: 44597, g3: 48544, leather: 66896 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_2X: makePriceEntry({
    base:    { g1: 42328, g2: 44716, g3: 49057, leather: 69244 },
    storage: { g1: 46669, g2: 49057, g3: 53398, leather: 73585 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_2L: makePriceEntry({
    base:    { g1: 36013, g2: 37888, g3: 41440, leather: 56832 },
    storage: { g1: 39960, g2: 41835, g3: 45386, leather: 62752 },
    bed:     { g1: 40947, g2: 43216, g3: 47360, leather: 64824 },
  }),

  Manila_2XL: makePriceEntry({
    base:    { g1: 39615, g2: 41677, g3: 45584, leather: 62515 },
    storage: { g1: 43956, g2: 46018, g3: 49925, leather: 69027 },
    bed:     { g1: 45041, g2: 47537, g3: 52096, leather: 71306 },
  }),

  Manila_2M: makePriceEntry({
    base:    { g1: 33547, g2: 35125, g3: 38283, leather: 52688 },
    storage: { g1: 37493, g2: 39072, g3: 42229, leather: 58608 },
    bed:     { g1: 38480, g2: 40453, g3: 44203, leather: 60680 },
  }),

  Manila_2XM: makePriceEntry({
    base:    { g1: 36901, g2: 38638, g3: 42111, leather: 57958 },
    storage: { g1: 41243, g2: 42979, g3: 46452, leather: 64469 },
    bed:     { g1: 42328, g2: 44499, g3: 48623, leather: 66748 },
  }),

  Manila_2P: makePriceEntry({
    base:    { g1: 36013, g2: 37888, g3: 41440, leather: 56832 },
    storage: { g1: 39960, g2: 41835, g3: 45386, leather: 62752 },
    bed:     { g1: 40947, g2: 43216, g3: 47360, leather: 64824 },
  }),

  Manila_2XP: makePriceEntry({
    base:    { g1: 39615, g2: 41677, g3: 45584, leather: 62515 },
    storage: { g1: 43956, g2: 46018, g3: 49925, leather: 69027 },
    bed:     { g1: 45041, g2: 47537, g3: 52096, leather: 71306 },
  }),

  // ===== 3 =====
  Manila_3: makePriceEntry({
    base:    { g1: 55253, g2: 58213, g3: 63738, leather: 87320 },
    storage: { g1: 59200, g2: 62160, g3: 67685, leather: 91266 },
    bed:     { g1: 60186, g2: 63541, g3: 69658, leather: 95312 },
  }),

  Manila_3X: makePriceEntry({
    base:    { g1: 60778, g2: 64034, g3: 70112, leather: 96052 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_3L: makePriceEntry({
    base:    { g1: 52786, g2: 55450, g3: 60581, leather: 83179 },
    storage: { g1: 56733, g2: 59397, g3: 64528, leather: 87122 },
    bed:     { g1: 57720, g2: 60778, g3: 66501, leather: 91168 },
  }),

  Manila_3XL: makePriceEntry({
    base:    { g1: 58065, g2: 60996, g3: 66639, leather: 91493 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_3M: makePriceEntry({
    base:    { g1: 50320, g2: 52688, g3: 57424, leather: 79032 },
    storage: { g1: 54266, g2: 56634, g3: 61370, leather: 82978 },
    bed:     { g1: 55253, g2: 58016, g3: 63344, leather: 87024 },
  }),

  Manila_3XM: makePriceEntry({
    base:    { g1: 55352, g2: 57957, g3: 63166, leather: 86935 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_3P: makePriceEntry({
    base:    { g1: 52786, g2: 55450, g3: 60581, leather: 8179 },
    storage: { g1: 56733, g2: 59397, g3: 64528, leather: 87122 },
    bed:     { g1: 57720, g2: 60778, g3: 66501, leather: 91168 },
  }),

  Manila_3XP: makePriceEntry({
    base:    { g1: 58065, g2: 60996, g3: 66639, leather: 91493 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== KĹESLO =====
  Manila_kreslo: makePriceEntry({
    base:    { g1: 21707, g2: 23088, g3: 25456, leather: 34632 },
    storage: { g1: 23680, g2: 25061, g3: 27429, leather: 36605 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_kresloX: makePriceEntry({
    base:    { g1: 23877, g2: 25397, g3: 28001, leather: 38095 },
    storage: { g1: 26048, g2: 27567, g3: 30172, leather: 40266 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== ROHY (bez X) =====
  Manila_roh_L: makePriceEntry({
    base:    { g1: 24469, g2: 25456, g3: 27627, leather: 38184 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manila_roh_P: makePriceEntry({
    base:    { g1: 24469, g2: 25456, g3: 27627, leather: 38184 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),


  // =====================
  //  MENDOZA â€” Ĺ ABLONY CEN
  //  (doplĹ si hodnoty)
  // =====================

  // ===== 1D =====
  Mendoza_1D_L: makePriceEntry({
    base:            { g1: 35088, g2: 36567, g3: 38919, leather: 54850 },
    storage:         { g1: 39769, g2: 41248, g3: 43600, leather: 54850 },
    extendedBase:    { g1: 38597, g2: 40224, g3: 42811, leather: 60335 },
    extendedStorage: { g1: 43746, g2: 45373, g3: 47960, leather: 60335 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XD_L: makePriceEntry({
    base:            { g1: 40351, g2: 42052, g3: 44757, leather: 63077 },
    storage:         { g1: 45032, g2: 46733, g3: 49438, leather: 67758 },
    extendedBase:    { g1: 44386, g2: 46257, g3: 49233, leather: 69385 },
    extendedStorage: { g1: 49535, g2: 51406, g3: 54382, leather: 74534 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1D_P: makePriceEntry({
    base:            { g1: 35088, g2: 36567, g3: 38919, leather: 54850 },
    storage:         { g1: 39769, g2: 41248, g3: 43600, leather: 54850 },
    extendedBase:    { g1: 38597, g2: 40224, g3: 42811, leather: 60335 },
    extendedStorage: { g1: 43746, g2: 45373, g3: 47960, leather: 60335 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XD_P: makePriceEntry({
    base:            { g1: 40351, g2: 42052, g3: 44757, leather: 63077 },
    storage:         { g1: 45032, g2: 46733, g3: 49438, leather: 67758 },
    extendedBase:    { g1: 44386, g2: 46257, g3: 49233, leather: 69385 },
    extendedStorage: { g1: 49535, g2: 51406, g3: 54382, leather: 74534 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1 =====
  Mendoza_1L: makePriceEntry({
    base:    { g1: 21493, g2: 23089, g3: 24652, leather: 34634 },
    storage: { g1: 26174, g2: 27770, g3: 29333, leather: 39315 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XL: makePriceEntry({
    base:    { g1: 24717, g2: 26553, g3: 28350, leather: 39829 },
    storage: { g1: 29398, g2: 31234, g3: 33031, leather: 44510 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1M: makePriceEntry({
    base:    { g1: 18670, g2: 19460, g3: 21022, leather: 29189 },
    storage: { g1: 23351, g2: 24141, g3: 25703, leather: 33870 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XM: makePriceEntry({
    base:    { g1: 21470, g2: 22379, g3: 24176, leather: 33568 },
    storage: { g1: 26151, g2: 27060, g3: 28857, leather: 38249 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1P: makePriceEntry({
    base:    { g1: 21493, g2: 23089, g3: 24652, leather: 34634 },
    storage: { g1: 26174, g2: 27770, g3: 29333, leather: 39315 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XP: makePriceEntry({
    base:    { g1: 24717, g2: 26553, g3: 28350, leather: 39829 },
    storage: { g1: 29398, g2: 31234, g3: 33031, leather: 44510 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1MO =====
  Mendoza_1MO_L: makePriceEntry({
    base:    { g1: 24904, g2: 26971, g3: 29055, leather: 40448 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XMO_L: makePriceEntry({
    base:    { g1: 28640, g2: 31017, g3: 33413, leather: 46516 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1MO_P: makePriceEntry({
    base:    { g1: 24904, g2: 26971, g3: 29055, leather: 40448 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_1XMO_P: makePriceEntry({
    base:    { g1: 28640, g2: 31017, g3: 33413, leather: 46516 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 2 =====
  Mendoza_2: makePriceEntry({
    base:    { g1: 42818, g2: 45070, g3: 49103, leather: 67604 },
    storage: { g1: 47499, g2: 49751, g3: 53784, leather: 72285 },
    bed:     { g1: 50620, g2: 52872, g3: 56905, leather: 75406 },
    bed2:     { g1: 54521, g2: 56773, g3: 60806, leather: 79307 },
  }),

  Mendoza_2X: makePriceEntry({
    base:    { g1: 49240, g2: 51830, g3: 56468, leather: 77745 },
    storage: { g1: 53921, g2: 56511, g3: 56468, leather: 82426 },
    bed:     { g1: 57042, g2: 59632, g3: 64270, leather: 85547 },
    bed2:     { g1: 60943, g2: 63533, g3: 68171, leather: 89448 },
  }),

  Mendoza_2L: makePriceEntry({
    base:    { g1: 40163, g2: 42095, g3: 45675, leather: 63151 },
    storage: { g1: 44844, g2: 46776, g3: 50356, leather: 67832 },
    bed:     { g1: 47965, g2: 49897, g3: 53477, leather: 70953 },
    bed2:     { g1: 51866, g2: 53798, g3: 57378, leather: 74854 },
  }),

  Mendoza_2XL: makePriceEntry({
    base:    { g1: 46187, g2: 48410, g3: 52526, leather: 72624 },
    storage: { g1: 50868, g2: 53091, g3: 57207, leather: 77305 },
    bed:     { g1: 53989, g2: 56212, g3: 60328, leather: 80426 },
    bed2:     { g1: 57890, g2: 60113, g3: 64229, leather: 84327 },
  }),

  Mendoza_2M: makePriceEntry({
    base:    { g1: 37340, g2: 38919, g3: 42045, leather: 58379 },
    storage: { g1: 41921, g2: 43600, g3: 46726, leather: 63060 },
    bed:     { g1: 45142, g2: 46721, g3: 49847, leather: 66181 },
    bed2:    { g1: 49043, g2: 50622, g3: 53748, leather: 70082 },
  }),

  Mendoza_2XM: makePriceEntry({
    base:    { g1: 42940, g2: 44757, g3: 48352, leather: 67136 },
    storage: { g1: 47621, g2: 49438, g3: 53033, leather: 71817 },
    bed:     { g1: 50742, g2: 52559, g3: 56154, leather: 74938 },
    bed2:    { g1: 54643, g2: 56460, g3: 60055, leather: 78839 },
  }),

  Mendoza_2P: makePriceEntry({
    base:    { g1: 40163, g2: 42095, g3: 45675, leather: 63151 },
    storage: { g1: 44844, g2: 46776, g3: 50356, leather: 67832 },
    bed:     { g1: 47965, g2: 49897, g3: 53477, leather: 70953 },
    bed2:     { g1: 51866, g2: 53798, g3: 57378, leather: 74854 },
  }),

  Mendoza_2XP: makePriceEntry({
    base:    { g1: 46187, g2: 48410, g3: 52526, leather: 72624 },
    storage: { g1: 50868, g2: 53091, g3: 57207, leather: 77305 },
    bed:     { g1: 53989, g2: 56212, g3: 60328, leather: 80426 },
    bed2:     { g1: 57890, g2: 60113, g3: 64229, leather: 84327 },
  }),

  // ===== 3 =====
  Mendoza_3: makePriceEntry({
    base:    { g1: 61488, g2: 64529, g3: 70125, leather: 96794 },
    storage: { g1: 66169, g2: 69210, g3: 74806, leather: 101475 },
    bed:     { g1: 69290, g2: 72331, g3: 77927, leather: 104596 },
    bed2:    { g1: 73191, g2: 76232, g3: 81828, leather: 108497 },
  }),

  Mendoza_3X: makePriceEntry({
    base:    { g1: 70711, g2: 74209, g3: 80644, leather: 111313 },
    storage: { g1: 75392, g2: 78890, g3: 85325, leather: 115994 },
    bed:     { g1: 78513, g2: 82011, g3: 88446, leather: 119115 },
  }),

  Mendoza_3L: makePriceEntry({
    base:    { g1: 58832, g2: 61538, g3: 66697, leather: 92307 },
    storage: { g1: 63513, g2: 66219, g3: 71378, leather: 96988 },
    bed:     { g1: 66634, g2: 69340, g3: 74499, leather: 100109 },
    bed2:    { g1: 70535, g2: 73241, g3: 78400, leather: 104010 },
  }),

  Mendoza_3XL: makePriceEntry({
    base:    { g1: 67657, g2: 70769, g3: 76702, leather: 106153 },
    storage: { g1: 72338, g2: 75450, g3: 81383, leather: 110834 },
    bed:     { g1: 75459, g2: 78571, g3: 84504, leather: 113955 },
  }),

  Mendoza_3M: makePriceEntry({
    base:    { g1: 56009, g2: 58379, g3: 63067, leather: 87568 },
    storage: { g1: 60690, g2: 63060, g3: 67748, leather: 92249 },
    bed:     { g1: 63811, g2: 66181, g3: 70869, leather: 95370 },
    bed2:    { g1: 67712, g2: 70082, g3: 74770, leather: 99271 },
  }),

  Mendoza_3XM: makePriceEntry({
    base:    { g1: 64411, g2: 67136, g3: 72527, leather: 100703 },
    storage: { g1: 69092, g2: 71817, g3: 77208, leather: 105384 },
    bed:     { g1: 72213, g2: 74938, g3: 80329, leather: 108505 },
  }),

  Mendoza_3P: makePriceEntry({
    base:    { g1: 58832, g2: 61538, g3: 66697, leather: 92307 },
    storage: { g1: 63513, g2: 66219, g3: 71378, leather: 96988 },
    bed:     { g1: 66634, g2: 69340, g3: 74499, leather: 100109 },
    bed2:    { g1: 70535, g2: 73241, g3: 78400, leather: 104010 },
  }),

  Mendoza_3XP: makePriceEntry({
    base:    { g1: 67657, g2: 70769, g3: 76702, leather: 106153 },
    storage: { g1: 72338, g2: 75450, g3: 81383, leather: 110834 },
    bed:     { g1: 75459, g2: 78571, g3: 84504, leather: 113955 },
  }),

  // ===== KĹESLO =====
  Mendoza_kreslo: makePriceEntry({
    base:    { g1: 24148, g2: 25610, g3: 28080, leather: 38415 },
    storage: { g1: 28829, g2: 30291, g3: 32761, leather: 43096 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_kresloX: makePriceEntry({
    base:    { g1: 27770, g2: 29452, g3: 32292, leather: 44177 },
    storage: { g1: 32451, g2: 34133, g3: 36973, leather: 48858 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== ROHY (bez X) =====
  Mendoza_roh_L: makePriceEntry({
    base:    { g1: 27795, g2: 28836, g3: 31122, leather: 43255 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Mendoza_roh_P: makePriceEntry({
    base:    { g1: 27795, g2: 28836, g3: 31122, leather: 43255 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // =====================
  //  MELBOURNE — ŠABLONY CEN
  //  (doplň si hodnoty)
  // =====================

  // ===== 1D =====
  Melbourne_1D_L: makePriceEntry({
    base:            { g1: 35088, g2: 36567, g3: 38919, leather: 54850 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 38597, g2: 40224, g3: 42811, leather: 60335 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XD_L: makePriceEntry({
    base:            { g1: 38597, g2: 40223, g3: 42811, leather: 60335 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 42457, g2: 44245, g3: 47092, leather: 66369 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1D_P: makePriceEntry({
    base:            { g1: 35088, g2: 36567, g3: 38919, leather: 54850 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 38597, g2: 40224, g3: 42811, leather: 60335 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XD_P: makePriceEntry({
    base:            { g1: 38597, g2: 40223, g3: 42811, leather: 60335 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 42457, g2: 44245, g3: 47092, leather: 66369 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1 =====
  Melbourne_1L: makePriceEntry({
    base:    { g1: 21493, g2: 23089, g3: 24652, leather: 34634 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XL: makePriceEntry({
    base:    { g1: 23642, g2: 25398, g3: 27117, leather: 38097 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1M: makePriceEntry({
    base:    { g1: 18670, g2: 19460, g3: 21022, leather: 29189 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XM: makePriceEntry({
    base:    { g1: 20537, g2: 21406, g3: 23125, leather: 32108 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1P: makePriceEntry({
    base:    { g1: 21493, g2: 23089, g3: 24652, leather: 34634 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XP: makePriceEntry({
    base:    { g1: 23642, g2: 25398, g3: 27117, leather: 38097 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1MO =====
  Melbourne_1MO_L: makePriceEntry({
    base:    { g1: 24904, g2: 26971, g3: 29055, leather: 40465 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XMO_L: makePriceEntry({
    base:    { g1: 27395 , g2: 29668, g3: 31960, leather: 44512 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1MO_P: makePriceEntry({
    base:    { g1: 24904, g2: 26971, g3: 29055, leather: 40465 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_1XMO_P: makePriceEntry({
    base:    { g1: 27395 , g2: 29668, g3: 31960, leather: 44512 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 2 =====
  Melbourne_2: makePriceEntry({
    base:    { g1: 42986, g2: 45271, g3: 49304, leather: 67907 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 54689, g2: 56974, g3: 61007, leather: 79610 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2X: makePriceEntry({
    base:    { g1: 47284, g2: 49798, g3: 54235, leather: 74698 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 58987, g2: 61501, g3: 65938, leather: 86401 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2L: makePriceEntry({
    base:    { g1: 40163, g2: 42095, g3: 45675, leather: 63151 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 51866, g2: 53798, g3: 57378, leather: 74854 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2XL: makePriceEntry({
    base:    { g1: 44179, g2: 46305, g3: 50242, leather: 69466 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 55882, g2: 58008, g3: 61945, leather: 81169 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2M: makePriceEntry({
    base:    { g1: 37340, g2: 38919, g3: 42045, leather: 58379 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 49043, g2: 50622, g3: 53748, leather: 70082 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2XM: makePriceEntry({
    base:    { g1: 41074, g2: 42811 , g3: 46249, leather: 64217 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 52777, g2: 54514, g3: 57952, leather: 75920 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2P: makePriceEntry({
    base:    { g1: 40163, g2: 42095, g3: 45675, leather: 63151 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 51866, g2: 53798, g3: 57378, leather: 74854 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_2XP: makePriceEntry({
    base:    { g1: 44179, g2: 46305, g3: 50242, leather: 69466 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 55882, g2: 58008, g3: 61945, leather: 81169 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 3 =====
  Melbourne_3: makePriceEntry({
    base:    { g1: 61656, g2: 64714, g3: 70327, leather: 97079 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 73359, g2: 76417, g3: 82030, leather: 108782 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3X: makePriceEntry({
    base:    { g1: 67821, g2: 71185, g3: 77359, leather: 106787 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3L: makePriceEntry({
    base:    { g1: 58832, g2: 61538, g3: 66697, leather: 92307 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 70535, g2: 73241, g3: 78400, leather: 104010 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3XL: makePriceEntry({
    base:    { g1: 64716, g2: 67692, g3: 73367, leather: 101538 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3M: makePriceEntry({
    base:    { g1: 56009, g2: 58379, g3: 63067, leather: 87568 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 67712, g2: 70082, g3: 74770, leather: 99271 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3XM: makePriceEntry({
    base:    { g1: 61610, g2: 64217, g3: 69374, leather: 96325 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3P: makePriceEntry({
    base:    { g1: 58832, g2: 61538, g3: 66697, leather: 92307 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 70535, g2: 73241, g3: 78400, leather: 104010 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_3XP: makePriceEntry({
    base:    { g1: 64716, g2: 67692, g3: 73367, leather: 101538 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== KŘESLO =====
  Melbourne_kreslo: makePriceEntry({
    base:    { g1: 24316, g2: 25812, g3: 28282, leather: 38718 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_kresloX: makePriceEntry({
    base:    { g1: 26748, g2: 28393 , g3: 31110, leather: 42589 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== ROHY (bez X) =====
  Melbourne_roh_L: makePriceEntry({
    base:    { g1: 27795, g2: 28836, g3: 31122, leather: 43255 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Melbourne_roh_P: makePriceEntry({
    base:    { g1: 27795, g2: 28836, g3: 31122, leather: 43255 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // =====================
  //  MANCHESTER — ŠABLONY CEN
  // =====================

  // ===== 1D =====
  Manchester_1D_L: makePriceEntry({
    base:            { g1: 30433, g2: 31526, g3: 33727, leather: 47288 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 33476, g2: 34679, g3: 37100, leather: 52017 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XD_L: makePriceEntry({
    base:            { g1: 34257, g2: 35488, g3: 37974, leather: 53232 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 37683, g2: 39037, g3: 41771, leather: 58555 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1D_P: makePriceEntry({
    base:            { g1: 30433, g2: 31526, g3: 33727, leather: 47288 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 33476, g2: 34679, g3: 37100, leather: 52017 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XD_P: makePriceEntry({
    base:            { g1: 34257, g2: 35488, g3: 37974, leather: 53232 },
    storage:         { g1: 0, g2: 0, g3: 0, leather: 0 },
    extendedBase:    { g1: 37683, g2: 39037, g3: 41771, leather: 58555 },
    extendedStorage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:             { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:            { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1 =====
  Manchester_1L: makePriceEntry({
    base:    { g1: 27425, g2: 28686, g3: 30147, leather: 43020 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XL: makePriceEntry({
    base:    { g1: 30798, g2: 32222, g3: 33858, leather: 48323 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1M: makePriceEntry({
    base:    { g1: 22484, g2: 23577, g3: 24736, leather: 35357 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XM: makePriceEntry({
    base:    { g1: 25857, g2: 27113, g3: 28447, leather: 40660 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1P: makePriceEntry({
    base:    { g1: 27425, g2: 28686, g3: 30147, leather: 43020 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XP: makePriceEntry({
    base:    { g1: 30798, g2: 32222, g3: 33858, leather: 48323 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 1MO =====
  Manchester_1MO_L: makePriceEntry({
    base:    { g1: 35760, g2: 38071, g3: 40428, leather: 57098 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XMO_L: makePriceEntry({
    base:    { g1: 39133, g2: 41607, g3: 44139, leather: 62401 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1MO_P: makePriceEntry({
    base:    { g1: 35760, g2: 38071, g3: 40428, leather: 57098 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_1XMO_P: makePriceEntry({
    base:    { g1: 39133, g2: 41607, g3: 44139, leather: 62401 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 2 =====
  Manchester_2: makePriceEntry({
    base:    { g1: 54850, g2: 57370, g3: 60294, leather: 86056 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2X: makePriceEntry({
    base:    { g1: 63077, g2: 65976, g3: 69339, leather: 98964 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2L: makePriceEntry({
    base:    { g1: 49910, g2: 52262, g3: 54883, leather: 78393 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2XL: makePriceEntry({
    base:    { g1: 56655, g2: 59335, g3: 62304, leather: 89003 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2M: makePriceEntry({
    base:    { g1: 44969, g2: 47153, g3: 49472, leather: 70730 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2XM: makePriceEntry({
    base:    { g1: 51714, g2: 54226, g3: 56893, leather: 81340 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2P: makePriceEntry({
    base:    { g1: 49910, g2: 52262, g3: 54883, leather: 78393 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_2XP: makePriceEntry({
    base:    { g1: 56655, g2: 59335, g3: 62304, leather: 89003 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== 3 =====
  Manchester_3: makePriceEntry({
    base:    { g1: 77334, g2: 80947, g3: 85031, leather: 121412 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3X: makePriceEntry({
    base:    { g1: 88934, g2: 93089, g3: 97785, leather: 139624 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3L: makePriceEntry({
    base:    { g1: 72394, g2: 75839, g3: 79620, leather: 113750 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3XL: makePriceEntry({
    base:    { g1: 82512, g2: 86449, g3: 90751, leather: 129663 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3M: makePriceEntry({
    base:    { g1: 67453, g2: 70730, g3: 74209, leather: 106087 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3XM: makePriceEntry({
    base:    { g1: 77571, g2: 81340, g3: 85340, leather: 122000 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3P: makePriceEntry({
    base:    { g1: 72394, g2: 75839, g3: 79620, leather: 113750 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_3XP: makePriceEntry({
    base:    { g1: 82512, g2: 86449, g3: 90751, leather: 129663 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== KŘESLO =====
  Manchester_kreslo: makePriceEntry({
    base:    { g1: 27963, g2: 28047, g3: 31794, leather: 42062 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_kresloX: makePriceEntry({
    base:    { g1: 32157, g2: 32254, g3: 36563, leather: 48371 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  // ===== ROHY (bez X) =====
  Manchester_roh_L: makePriceEntry({
    base:    { g1: 25946, g2: 27038, g3: 29240, leather: 40549 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),

  Manchester_roh_P: makePriceEntry({
    base:    { g1: 25946, g2: 27038, g3: 29240, leather: 40549 },
    storage: { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed:     { g1: 0, g2: 0, g3: 0, leather: 0 },
    bed2:    { g1: 0, g2: 0, g3: 0, leather: 0 },
  }),
};

// PomocnĂ˝ getter: kdyĹľ v PRICES nÄ›co chybĂ­, vrĂˇtĂ­ prĂˇzdnĂ© ceny
function getPriceEntry(variantId) {
  return PRICES?.[variantId] ?? makePriceEntry();
}

// ====================
//  2) DEFINICE VARIANT (ROZMÄšRY + LOGIKA X)
// ====================

export const modulesCatalog = {};

// default upgrady pro â€śbÄ›ĹľnĂ©â€ť sedacĂ­ moduly (mĹŻĹľeĹˇ zmÄ›nit)
const DEFAULT_UPGRADES = ["storage", "bed"];
const STORAGE_ONLY = ["storage"];
const NONE = [];
const MENDOZA_BED_UPGRADES = ["storage", "bed", "bed2"];

// ---- Manila_1D_L / 1D_P ----
// POZOR: ve tvĂ©m pĹŻvodnĂ­m kĂłdu bylo allowedUpgrades: [storage] -> to je chyba (storage nenĂ­ promÄ›nnĂˇ).
// sprĂˇvnÄ›: ["storage"]
addBaseAndX(modulesCatalog, {
  baseId: "Manila_1D_L",
  baseLabel: "1D L",
  model: "Manila_1D_L",
  allowX: true,
  baseDimsCm: { w: 80, d: 180, h: 0 },
  xDimsCm:    { w: 95, d: 180, h: 0 },
  baseRangeCm:{ min: 70, max: 90 },
  xRangeCm:   { min: 91, max: 100 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: ["storage"],
  // ceny se doplnĂ­ z PRICES aĹľ nĂ­Ĺľe
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_1D_P",
  baseLabel: "1D P",
  model: "Manila_1D_P",
  allowX: true,
  baseDimsCm: { w: 80, d: 180, h: 0 },
  xDimsCm:    { w: 95, d: 180, h: 0 },
  baseRangeCm:{ min: 70, max: 90 },
  xRangeCm:   { min: 91, max: 100 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: ["storage"],
});

// ---- 1L / 1M / 1P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manila_1L",
  baseLabel: "1L",
  model: "Manila_1L",
  allowX: true,
  baseDimsCm: { w: 80, d: 103, h: 0 },
  xDimsCm:    { w: 95, d: 103, h: 0 },
  baseRangeCm:{ min: 80, max: 90 },
  xRangeCm:   { min: 91, max: 100 },
  allowedUpgradesBase: ["storage"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_1M",
  baseLabel: "1M",
  model: "Manila_1M",
  allowX: true,
  baseDimsCm: { w: 60, d: 103, h: 0 },
  xDimsCm:    { w: 75, d: 103, h: 0 },
  baseRangeCm:{ min: 50, max: 70 },
  xRangeCm:   { min: 71, max: 80 },
  allowedUpgradesBase: ["storage"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_1P",
  baseLabel: "1P",
  model: "Manila_1P",
  allowX: true,
  baseDimsCm: { w: 80, d: 103, h: 0 },
  xDimsCm:    { w: 95, d: 103, h: 0 },
  baseRangeCm:{ min: 70, max: 90 },
  xRangeCm:   { min: 91, max: 100 },
  allowedUpgradesBase: ["storage"],
});

// ---- 1MO_L / 1MO_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manila_1MO_L",
  baseLabel: "1MO L",
  model: "Manila_1MO_L",
  allowX: true,
  baseDimsCm: { w: 100, d: 103, h: 0 },
  xDimsCm:    { w: 125, d: 103, h: 0 },
  baseRangeCm:{ min: 80, max: 120 },
  xRangeCm:   { min: 121, max: 130 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_1MO_P",
  baseLabel: "1MO P",
  model: "Manila_1MO_P",
  allowX: true,
  baseDimsCm: { w: 100, d: 103, h: 0 },
  xDimsCm:    { w: 125, d: 103, h: 0 },
  baseRangeCm:{ min: 80, max: 120 },
  xRangeCm:   { min: 121, max: 130 },
  allowedUpgradesBase: NONE,
});

// ---- 2 / 2L / 2M / 2P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manila_2",
  baseLabel: "2",
  model: "Manila_2",
  allowX: true,
  baseDimsCm: { w: 160, d: 103, h: 0 },
  xDimsCm:    { w: 190, d: 103, h: 0 },
  baseRangeCm:{ min: 140, max: 180 },
  xRangeCm:   { min: 181, max: 200 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_2L",
  baseLabel: "2L",
  model: "Manila_2L",
  allowX: true,
  baseDimsCm: { w: 140, d: 103, h: 0 },
  xDimsCm:    { w: 170, d: 103, h: 0 },
  baseRangeCm:{ min: 120, max: 160 },
  xRangeCm:   { min: 161, max: 180 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_2M",
  baseLabel: "2M",
  model: "Manila_2M",
  allowX: true,
  baseDimsCm: { w: 120, d: 103, h: 0 },
  xDimsCm:    { w: 150, d: 103, h: 0 },
  baseRangeCm:{ min: 100, max: 140 },
  xRangeCm:   { min: 141, max: 160 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_2P",
  baseLabel: "2P",
  model: "Manila_2P",
  allowX: true,
  baseDimsCm: { w: 140, d: 103, h: 0 },
  xDimsCm:    { w: 170, d: 103, h: 0 },
  baseRangeCm:{ min: 120, max: 160 },
  xRangeCm:   { min: 161, max: 180 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
});

// ---- 3 / 3L / 3M / 3P ----
// tady ukazuju pĹ™esnÄ› tvĹŻj pĹ™Ă­pad:
// base mĂˇ storage+bed, X mĂˇ jen storage
addBaseAndX(modulesCatalog, {
  baseId: "Manila_3",
  baseLabel: "3",
  model: "Manila_3",
  allowX: true,
  baseDimsCm: { w: 220, d: 103, h: 0 },
  xDimsCm:    { w: 265, d: 103, h: 0 },
  baseRangeCm:{ min: 190, max: 250 },
  xRangeCm:   { min: 251, max: 280 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_3L",
  baseLabel: "3L",
  model: "Manila_3L",
  allowX: true,
  baseDimsCm: { w: 200, d: 103, h: 0 },
  xDimsCm:    { w: 245, d: 103, h: 0 },
  baseRangeCm:{ min: 170, max: 230 },
  xRangeCm:   { min: 231, max: 260 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_3M",
  baseLabel: "3M",
  model: "Manila_3M",
  allowX: true,
  baseDimsCm: { w: 180, d: 103, h: 0 },
  xDimsCm:    { w: 225, d: 103, h: 0 },
  baseRangeCm:{ min: 150, max: 210 },
  xRangeCm:   { min: 211, max: 240 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_3P",
  baseLabel: "3P",
  model: "Manila_3P",
  allowX: true,
  baseDimsCm: { w: 200, d: 103, h: 0 },
  xDimsCm:    { w: 245, d: 103, h: 0 },
  baseRangeCm:{ min: 170, max: 230 },
  xRangeCm:   { min: 231, max: 260 },
  allowedUpgradesBase: DEFAULT_UPGRADES,
  allowedUpgradesX: NONE,
});

// ---- KĹ™eslo ----
addBaseAndX(modulesCatalog, {
  baseId: "Manila_kreslo",
  baseLabel: "KĹ™eslo",
  model: "Manila_kreslo",
  allowX: true,
  baseDimsCm: { w: 100, d: 103, h: 0 },
  xDimsCm:    { w: 115, d: 103, h: 0 },
  baseRangeCm:{ min: 90, max: 110 },
  xRangeCm:   { min: 111, max: 120 },
  allowedUpgradesBase: ["storage"], // uprav dle reality
});

if (modulesCatalog["Manila_kresloX"]) {
  modulesCatalog["Manila_kresloX"].label = "1X - Křeslo";
}

// ---- Rohy (bez X variant) ----
addBaseAndX(modulesCatalog, {
  baseId: "Manila_roh_L",
  baseLabel: "Roh L",
  model: "Manila_roh_L",
  allowX: false,
  baseDimsCm: { w: 103, d: 103, h: 0 },
  baseRangeCm:{ min: 103, max: 103 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manila_roh_P",
  baseLabel: "Roh P",
  model: "Manila_roh_P",
  allowX: false,
  baseDimsCm: { w: 103, d: 103, h: 0 },
  baseRangeCm:{ min: 103, max: 103 },
  allowedUpgradesBase: NONE,
});

// ====================
//  MENDOZA â€” MODULY
//  (doplĹ si dimsCm + rangeCm + allowedUpgrades podle reality)
// ====================

// pouĹľij stejnĂ© upgrady jako u Manily
// DEFAULT_UPGRADES = ["storage","bed"]
// STORAGE_ONLY = ["storage"]
// NONE = []
// (ty konstanty uĹľ mĂˇĹˇ definovanĂ© vĂ˝Ĺˇ) :contentReference[oaicite:8]{index=8}

// ---- Mendoza_1D_L / 1D_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1D_L",
  baseLabel: "1D L",
  model: "Mendoza_1D_L",
  allowX: true,
  baseDimsCm: { w: 95, d: 180, h: 0 },
  xDimsCm:    { w: 120, d: 180, h: 0 },
  baseRangeCm:{ min: 75, max: 100 },
  xRangeCm:   { min: 101, max: 125 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: ["storage"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1D_P",
  baseLabel: "1D P",
  model: "Mendoza_1D_P",
  allowX: true,
  baseDimsCm: { w: 95, d: 180, h: 0 },
  xDimsCm:    { w: 120, d: 180, h: 0 },
  baseRangeCm:{ min: 75, max: 100 },
  xRangeCm:   { min: 101, max: 125 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: ["storage"],
});

// ---- 1L / 1M / 1P ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1L",
  baseLabel: "1L",
  model: "Mendoza_1L",
  allowX: true,
  baseDimsCm: { w: 95, d: 102, h: 0 },
  xDimsCm:    { w: 120, d: 102, h: 0 },
  baseRangeCm:{ min: 75, max: 100 },
  xRangeCm:   { min: 101, max: 125 },
  allowedUpgradesBase: ["storage"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1M",
  baseLabel: "1M",
  model: "Mendoza_1M",
  allowX: true,
  baseDimsCm: { w: 65, d: 102, h: 0 },
  xDimsCm:    { w: 90, d: 102, h: 0 },
  baseRangeCm:{ min: 50, max: 75 },
  xRangeCm:   { min: 76, max: 100 },
  allowedUpgradesBase: ["storage"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1P",
  baseLabel: "1P",
  model: "Mendoza_1P",
  allowX: true,
  baseDimsCm: { w: 95, d: 102, h: 0 },
  xDimsCm:    { w: 120, d: 102, h: 0 },
  baseRangeCm:{ min: 75, max: 100 },
  xRangeCm:   { min: 101, max: 125 },
  allowedUpgradesBase: ["storage"],
});

// ---- 1MO_L / 1MO_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1MO_L",
  baseLabel: "1MO L",
  model: "Mendoza_1MO_L",
  allowX: true,
  baseDimsCm: { w: 115, d: 102, h: 0 },
  xDimsCm:    { w: 140, d: 102, h: 0 },
  baseRangeCm:{ min: 100, max: 125 },
  xRangeCm:   { min: 126, max: 150 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_1MO_P",
  baseLabel: "1MO P",
  model: "Mendoza_1MO_P",
  allowX: true,
  baseDimsCm: { w: 115, d: 102, h: 0 },
  xDimsCm:    { w: 140, d: 102, h: 0 },
  baseRangeCm:{ min: 100, max: 125 },
  xRangeCm:   { min: 126, max: 150 },
  allowedUpgradesBase: NONE,
});

// ---- 2 / 2L / 2M / 2P ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_2",
  baseLabel: "2",
  model: "Mendoza_2",
  allowX: true,
  baseDimsCm: { w: 190, d: 102, h: 0 },
  xDimsCm:    { w: 240, d: 102, h: 0 },
  baseRangeCm:{ min: 150, max: 200 },
  xRangeCm:   { min: 201, max: 250 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_2L",
  baseLabel: "2L",
  model: "Mendoza_2L",
  allowX: true,
  baseDimsCm: { w: 170, d: 102, h: 0 },
  xDimsCm:    { w: 220, d: 102, h: 0 },
  baseRangeCm:{ min: 125, max: 175 },
  xRangeCm:   { min: 176, max: 225 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_2M",
  baseLabel: "2M",
  model: "Mendoza_2M",
  allowX: true,
  baseDimsCm: { w: 140, d: 102, h: 0 },
  xDimsCm:    { w: 190, d: 102, h: 0 },
  baseRangeCm:{ min: 100, max: 150 },
  xRangeCm:   { min: 151, max: 200 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_2P",
  baseLabel: "2P",
  model: "Mendoza_2P",
  allowX: true,
  baseDimsCm: { w: 170, d: 102, h: 0 },
  xDimsCm:    { w: 220, d: 102, h: 0 },
  baseRangeCm:{ min: 125, max: 175 },
  xRangeCm:   { min: 176, max: 225 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
});

// ---- 3 / 3L / 3M / 3P ----
// stejnÄ› jako Manila: X varianty nech bez upgradĹŻ (allowedUpgradesX: NONE)
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_3",
  baseLabel: "3",
  model: "Mendoza_3",
  allowX: true,
  baseDimsCm: { w: 265, d: 102, h: 0 },
  xDimsCm:    { w: 340, d: 102, h: 0 },
  baseRangeCm:{ min: 200, max: 275 },
  xRangeCm:   { min: 276, max: 350 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_3L",
  baseLabel: "3L",
  model: "Mendoza_3L",
  allowX: true,
  baseDimsCm: { w: 240, d: 102, h: 0 },
  xDimsCm:    { w: 315, d: 102, h: 0 },
  baseRangeCm:{ min: 175, max: 250 },
  xRangeCm:   { min: 251, max: 325 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_3M",
  baseLabel: "3M",
  model: "Mendoza_3M",
  allowX: true,
  baseDimsCm: { w: 220, d: 102, h: 0 },
  xDimsCm:    { w: 390, d: 102, h: 0 },
  baseRangeCm:{ min: 150, max: 225 },
  xRangeCm:   { min: 226, max: 300 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_3P",
  baseLabel: "3P",
  model: "Mendoza_3P",
  allowX: true,
  baseDimsCm: { w: 240, d: 102, h: 0 },
  xDimsCm:    { w: 315, d: 102, h: 0 },
  baseRangeCm:{ min: 175, max: 250 },
  xRangeCm:   { min: 251, max: 325 },
  allowedUpgradesBase: MENDOZA_BED_UPGRADES,
  allowedUpgradesX: NONE,
});

// ---- KĹ™eslo ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_kreslo",
  baseLabel: "KĹ™eslo",
  model: "Mendoza_kreslo",
  allowX: true,
  baseDimsCm: { w: 120, d: 102, h: 0 },
  xDimsCm:    { w: 145, d: 102, h: 0 },
  baseRangeCm:{ min: 100, max: 125 },
  xRangeCm:   { min: 126, max: 150 },
  allowedUpgradesBase: ["storage"], // uprav dle reality
});

// ---- Rohy (bez X variant) ----
addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_roh_L",
  baseLabel: "Roh L",
  model: "Mendoza_roh_L",
  allowX: false,
  baseDimsCm: { w: 102, d: 102, h: 0 },
  baseRangeCm:{ min: 102, max: 102 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Mendoza_roh_P",
  baseLabel: "Roh P",
  model: "Mendoza_roh_P",
  allowX: false,
  baseDimsCm: { w: 102, d: 102, h: 0 },
  baseRangeCm:{ min: 102, max: 102 },
  allowedUpgradesBase: NONE,
});

// ====================
//  MELBOURNE â€” MODULY
//  (doplĹ si dimsCm + rangeCm + allowedUpgrades podle reality)
// ====================

// ---- Melbourne_1D_L / 1D_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1D_L",
  baseLabel: "1D L",
  model: "Melbourne_1D_L",
  allowX: true,
  baseDimsCm: { w: 90, d: 180, h: 0 },
  xDimsCm:    { w: 100, d: 180, h: 0 },
  baseRangeCm:{ min: 73, max: 93 },
  xRangeCm:   { min: 94, max: 103 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1D_P",
  baseLabel: "1D P",
  model: "Melbourne_1D_P",
  allowX: true,
  baseDimsCm: { w: 90, d: 180, h: 0 },
  xDimsCm:    { w: 100, d: 180, h: 0 },
  baseRangeCm:{ min: 73, max: 93 },
  xRangeCm:   { min: 94, max: 103 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: NONE,
});

// ---- 1L / 1M / 1P ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1L",
  baseLabel: "1L",
  model: "Melbourne_1L",
  allowX: true,
  baseDimsCm: { w: 90, d: 107, h: 0 },
  xDimsCm:    { w: 100, d: 107, h: 0 },
  baseRangeCm:{ min: 73, max: 93 },
  xRangeCm:   { min: 94, max: 103 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1M",
  baseLabel: "1M",
  model: "Melbourne_1M",
  allowX: true,
  baseDimsCm: { w: 75, d: 107, h: 0 },
  xDimsCm:    { w: 85, d: 107, h: 0 },
  baseRangeCm:{ min: 60, max: 80 },
  xRangeCm:   { min: 81, max: 90 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1P",
  baseLabel: "1P",
  model: "Melbourne_1P",
  allowX: true,
  baseDimsCm: { w: 90, d: 107, h: 0 },
  xDimsCm:    { w: 100, d: 107, h: 0 },
  baseRangeCm:{ min: 73, max: 93 },
  xRangeCm:   { min: 94, max: 103 },
  allowedUpgradesBase: NONE,
});

// ---- 1MO_L / 1MO_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1MO_L",
  baseLabel: "1MO L",
  model: "Melbourne_1MO_L",
  allowX: true,
  baseDimsCm: { w: 125, d: 107, h: 0 },
  xDimsCm:    { w: 135, d: 107, h: 0 },
  baseRangeCm:{ min: 110, max: 130 },
  xRangeCm:   { min: 131, max: 140 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_1MO_P",
  baseLabel: "1MO P",
  model: "Melbourne_1MO_P",
  allowX: true,
  baseDimsCm: { w: 125, d: 107, h: 0 },
  xDimsCm:    { w: 135, d: 107, h: 0 },
  baseRangeCm:{ min: 110, max: 130 },
  xRangeCm:   { min: 131, max: 140 },
  allowedUpgradesBase: NONE,
});

// ---- 2 / 2L / 2M / 2P ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_2",
  baseLabel: "2",
  model: "Melbourne_2",
  allowX: true,
  baseDimsCm: { w: 180, d: 107, h: 0 },
  xDimsCm:    { w: 200, d: 107, h: 0 },
  baseRangeCm:{ min: 146, max: 186 },
  xRangeCm:   { min: 187, max: 206 },
  allowedUpgradesBase: ["bed"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_2L",
  baseLabel: "2L",
  model: "Melbourne_2L",
  allowX: true,
  baseDimsCm: { w: 170, d: 107, h: 0 },
  xDimsCm:    { w: 190, d: 107, h: 0 },
  baseRangeCm:{ min: 133, max: 173 },
  xRangeCm:   { min: 174, max: 193 },
  allowedUpgradesBase: ["bed"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_2M",
  baseLabel: "2M",
  model: "Melbourne_2M",
  allowX: true,
  baseDimsCm: { w: 150, d: 107, h: 0 },
  xDimsCm:    { w: 170, d: 107, h: 0 },
  baseRangeCm:{ min: 120, max: 160 },
  xRangeCm:   { min: 161, max: 180 },
  allowedUpgradesBase: ["bed"],
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_2P",
  baseLabel: "2P",
  model: "Melbourne_2P",
  allowX: true,
  baseDimsCm: { w: 170, d: 107, h: 0 },
  xDimsCm:    { w: 190, d: 107, h: 0 },
  baseRangeCm:{ min: 133, max: 173 },
  xRangeCm:   { min: 174, max: 193 },
  allowedUpgradesBase: ["bed"],
});

// ---- 3 / 3L / 3M / 3P ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_3",
  baseLabel: "3",
  model: "Melbourne_3",
  allowX: true,
  baseDimsCm: { w: 230, d: 107, h: 0 },
  xDimsCm:    { w: 260, d: 107, h: 0 },
  baseRangeCm:{ min: 206, max: 236 },
  xRangeCm:   { min: 237, max: 266 },
  allowedUpgradesBase: ["bed"],
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_3L",
  baseLabel: "3L",
  model: "Melbourne_3L",
  allowX: true,
  baseDimsCm: { w: 220, d: 107, h: 0 },
  xDimsCm:    { w: 250, d: 107, h: 0 },
  baseRangeCm:{ min: 193, max: 233 },
  xRangeCm:   { min: 234, max: 253 },
  allowedUpgradesBase: ["bed"],
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_3M",
  baseLabel: "3M",
  model: "Melbourne_3M",
  allowX: true,
  baseDimsCm: { w: 180, d: 107, h: 0 },
  xDimsCm:    { w: 225, d: 107, h: 0 },
  baseRangeCm:{ min: 180, max: 210 },
  xRangeCm:   { min: 211, max: 240 },
  allowedUpgradesBase: ["bed"],
  allowedUpgradesX: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_3P",
  baseLabel: "3P",
  model: "Melbourne_3P",
  allowX: true,
  baseDimsCm: { w: 220, d: 107, h: 0 },
  xDimsCm:    { w: 250, d: 107, h: 0 },
  baseRangeCm:{ min: 193, max: 233 },
  xRangeCm:   { min: 234, max: 253 },
  allowedUpgradesBase: ["bed"],
  allowedUpgradesX: NONE,
});

// ---- Křeslo ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_kreslo",
  baseLabel: "Křeslo",
  model: "Melbourne_kreslo",
  allowX: true,
  baseDimsCm: { w: 100, d: 107, h: 0 },
  xDimsCm:    { w: 110, d: 107, h: 0 },
  baseRangeCm:{ min: 86, max: 106 },
  xRangeCm:   { min: 107, max: 116 },
  allowedUpgradesBase: NONE,
});

if (modulesCatalog["Melbourne_kresloX"]) {
  modulesCatalog["Melbourne_kresloX"].label = "1X - Křeslo";
}

// ---- Rohy (bez X variant) ----
addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_roh_L",
  baseLabel: "Roh L",
  model: "Melbourne_roh_L",
  allowX: false,
  baseDimsCm: { w: 107, d: 107, h: 0 },
  baseRangeCm:{ min: 107, max: 107 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Melbourne_roh_P",
  baseLabel: "Roh P",
  model: "Melbourne_roh_P",
  allowX: false,
  baseDimsCm: { w: 107, d: 107, h: 0 },
  baseRangeCm:{ min: 107, max: 107 },
  allowedUpgradesBase: NONE,
});

// ====================
//  MANCHESTER - MODULY
//  Bez příplatků; ceny můžeš doplnit později do PRICES.
// ====================

// ---- Manchester_1D_L / 1D_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1D_L",
  baseLabel: "1D L",
  model: "Manchester_1D_L",
  allowX: true,
  baseDimsCm: { w: 110, d: 180, h: 0 },
  xDimsCm:    { w: 120, d: 180, h: 0 },
  baseRangeCm:{ min: 90, max: 110 },
  xRangeCm:   { min: 111, max: 120 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1D_P",
  baseLabel: "1D P",
  model: "Manchester_1D_P",
  allowX: true,
  baseDimsCm: { w: 110, d: 180, h: 0 },
  xDimsCm:    { w: 120, d: 180, h: 0 },
  baseRangeCm:{ min: 90, max: 110 },
  xRangeCm:   { min: 111, max: 120 },
  depthRangeCm: { min: 150, max: 200 },
  allowedUpgradesBase: NONE,
});

// ---- 1L / 1M / 1P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1L",
  baseLabel: "1L",
  model: "Manchester_1L",
  allowX: true,
  baseDimsCm: { w: 110, d: 100, h: 0 },
  xDimsCm:    { w: 120, d: 100, h: 0 },
  baseRangeCm:{ min: 90, max: 110 },
  xRangeCm:   { min: 111, max: 120 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1M",
  baseLabel: "1M",
  model: "Manchester_1M",
  allowX: true,
  baseDimsCm: { w: 70, d: 100, h: 0 },
  xDimsCm:    { w: 80, d: 100, h: 0 },
  baseRangeCm:{ min: 50, max: 70 },
  xRangeCm:   { min: 71, max: 80 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1P",
  baseLabel: "1P",
  model: "Manchester_1P",
  allowX: true,
  baseDimsCm: { w: 110, d: 100, h: 0 },
  xDimsCm:    { w: 120, d: 100, h: 0 },
  baseRangeCm:{ min: 90, max: 110 },
  xRangeCm:   { min: 111, max: 120 },
  allowedUpgradesBase: NONE,
});

// ---- 1MO_L / 1MO_P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1MO_L",
  baseLabel: "1MO L",
  model: "Manchester_1MO_L",
  allowX: true,
  baseDimsCm: { w: 120, d: 100, h: 0 },
  xDimsCm:    { w: 130, d: 100, h: 0 },
  baseRangeCm:{ min: 100, max: 120 },
  xRangeCm:   { min: 121, max: 130 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_1MO_P",
  baseLabel: "1MO P",
  model: "Manchester_1MO_P",
  allowX: true,
  baseDimsCm: { w: 120, d: 100, h: 0 },
  xDimsCm:    { w: 130, d: 100, h: 0 },
  baseRangeCm:{ min: 100, max: 120 },
  xRangeCm:   { min: 121, max: 130 },
  allowedUpgradesBase: NONE,
});

// ---- 2 / 2L / 2M / 2P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_2",
  baseLabel: "2",
  model: "Manchester_2",
  allowX: true,
  baseDimsCm: { w: 220, d: 100, h: 0 },
  xDimsCm:    { w: 240, d: 100, h: 0 },
  baseRangeCm:{ min: 180, max: 220 },
  xRangeCm:   { min: 221, max: 240 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_2L",
  baseLabel: "2L",
  model: "Manchester_2L",
  allowX: true,
  baseDimsCm: { w: 180, d: 100, h: 0 },
  xDimsCm:    { w: 190, d: 100, h: 0 },
  baseRangeCm:{ min: 140, max: 180 },
  xRangeCm:   { min: 181, max: 200 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_2M",
  baseLabel: "2M",
  model: "Manchester_2M",
  allowX: true,
  baseDimsCm: { w: 140, d: 100, h: 0 },
  xDimsCm:    { w: 160, d: 100, h: 0 },
  baseRangeCm:{ min: 100, max: 140 },
  xRangeCm:   { min: 141, max: 160 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_2P",
  baseLabel: "2P",
  model: "Manchester_2P",
  allowX: true,
  baseDimsCm: { w: 180, d: 100, h: 0 },
  xDimsCm:    { w: 190, d: 100, h: 0 },
  baseRangeCm:{ min: 140, max: 180 },
  xRangeCm:   { min: 181, max: 200 },
  allowedUpgradesBase: NONE,
});

// ---- 3 / 3L / 3M / 3P ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_3",
  baseLabel: "3",
  model: "Manchester_3",
  allowX: true,
  baseDimsCm: { w: 290, d: 100, h: 0 },
  xDimsCm:    { w: 320, d: 100, h: 0 },
  baseRangeCm:{ min: 230, max: 290 },
  xRangeCm:   { min: 291, max: 320 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_3L",
  baseLabel: "3L",
  model: "Manchester_3L",
  allowX: true,
  baseDimsCm: { w: 250, d: 100, h: 0 },
  xDimsCm:    { w: 280, d: 100, h: 0 },
  baseRangeCm:{ min: 190, max: 250 },
  xRangeCm:   { min: 251, max: 280 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_3M",
  baseLabel: "3M",
  model: "Manchester_3M",
  allowX: true,
  baseDimsCm: { w: 210, d: 100, h: 0 },
  xDimsCm:    { w: 240, d: 100, h: 0 },
  baseRangeCm:{ min: 150, max: 210 },
  xRangeCm:   { min: 211, max: 240 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_3P",
  baseLabel: "3P",
  model: "Manchester_3P",
  allowX: true,
  baseDimsCm: { w: 250, d: 100, h: 0 },
  xDimsCm:    { w: 280, d: 100, h: 0 },
  baseRangeCm:{ min: 190, max: 250 },
  xRangeCm:   { min: 251, max: 280 },
  allowedUpgradesBase: NONE,
});

// ---- Křeslo ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_kreslo",
  baseLabel: "Křeslo",
  model: "Manchester_kreslo",
  allowX: true,
  baseDimsCm: { w: 150, d: 100, h: 0 },
  xDimsCm:    { w: 160, d: 100, h: 0 },
  baseRangeCm:{ min: 130, max: 150 },
  xRangeCm:   { min: 151, max: 160 },
  allowedUpgradesBase: NONE,
});

if (modulesCatalog["Manchester_kresloX"]) {
  modulesCatalog["Manchester_kresloX"].label = "1X - Křeslo";
}

// ---- Rohy (bez X variant) ----
addBaseAndX(modulesCatalog, {
  baseId: "Manchester_roh_L",
  baseLabel: "Roh L",
  model: "Manchester_roh_L",
  allowX: false,
  baseDimsCm: { w: 100, d: 100, h: 0 },
  baseRangeCm:{ min: 100, max: 100 },
  allowedUpgradesBase: NONE,
});

addBaseAndX(modulesCatalog, {
  baseId: "Manchester_roh_P",
  baseLabel: "Roh P",
  model: "Manchester_roh_P",
  allowX: false,
  baseDimsCm: { w: 100, d: 100, h: 0 },
  baseRangeCm:{ min: 100, max: 100 },
  allowedUpgradesBase: NONE,
});

// ====================
//  3) NAPOJENĂŤ CEN Z PRICES DO modulesCatalog
// ====================
//
// Tohle je klĂ­ÄŤ: teÄŹ uĹľ doplĹujeĹˇ jen PRICES a nic jinĂ©ho.
for (const variantId of Object.keys(modulesCatalog)) {
  const entry = getPriceEntry(variantId);

  modulesCatalog[variantId].prices = entry.base;
  modulesCatalog[variantId].upgradePrices.storage = entry.storage;
  modulesCatalog[variantId].upgradePrices.bed = entry.bed;
  modulesCatalog[variantId].upgradePrices.bed2 = entry.bed2;
  modulesCatalog[variantId].upgradePrices.extendedBase = entry.extendedBase;
  modulesCatalog[variantId].upgradePrices.extendedStorage = entry.extendedStorage;
}
// ====================
//  PUBLIC API
// ====================

export const moduleVariantIds = Object.keys(modulesCatalog);

export function getCatalog(id) {
  return modulesCatalog[id] || null;
}

/**
 * VrĂˇtĂ­ cenu modulu podle potahu a vybranĂ©ho upgradu.
 * selectedUpgrade: null | "storage" | "bed"
 * - pokud je upgrade vybranĂ˝ => pouĹľĂ­vĂˇme upgradePrices jako CENU CELĂ‰HO MODULU
 */
export function getModulePrice(variantId, fabricId = "g1", selectedUpgrade = null) {
  const c = getCatalog(variantId);
  if (!c) return 0;

  if (selectedUpgrade) {
    if (!c.allowedUpgrades?.includes(selectedUpgrade)) return c.prices?.[fabricId] || 0;

    const up = c.upgradePrices?.[selectedUpgrade]?.[fabricId];
    if (up != null) return up || 0;
  }

  return c.prices?.[fabricId] || 0;
}

/**
 * sizeVec3 je THREE.Vector3 v jednotkĂˇch scĂ©ny (u tebe 1 = 1m)
 */
export function bboxSizeCmFromThreeSize(sizeVec3) {
  return {
    w: Math.round((sizeVec3.x || 0) * 100),
    d: Math.round((sizeVec3.z || 0) * 100),
    h: Math.round((sizeVec3.y || 0) * 100),
  };
}

/**
 * SpoÄŤĂ­tĂˇ cenu celĂ© sestavy.
 * activeModules = pole recordĹŻ (rec.name by mÄ›lo bĂ˝t VARIANTA, tj. Manila_2M / Manila_2XM)
 * Pozn.: upgrady per modul doplnĂ­Ĺˇ pozdÄ›ji (a pĹ™edĂˇĹˇ je sem pĹ™es rec.upgrade apod.)
 */
export function calcTotalPrice(activeModules, selectedFabricKey = "g1") {
  let total = 0;

  for (const rec of activeModules) {
    const variantId = rec?.variantId || rec?.name;
    const selectedUpgrade = rec?.upgrade || null; // pĹ™ipravenĂ© do budoucna

    total += getModulePrice(variantId, selectedFabricKey, selectedUpgrade);
  }

  return total;
}

// âś… vezme "MANILA" / "Manila" / "manila" a udÄ›lĂˇ z toho "Manila"
export function normalizeSofaKey(modelName) {
  if (!modelName) return null;
  const s = String(modelName).trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// âś… vrĂˇtĂ­ jen varianty pro danou sedaÄŤku podle prefixu "Manila_" / "Mendoza_"
export function getVariantIdsForSofa(modelName) {
  const sofaKey = normalizeSofaKey(modelName);
  if (!sofaKey) return [];
  const prefix = `${sofaKey}_`;
  return Object.keys(modulesCatalog).filter((k) => k.startsWith(prefix));
}
