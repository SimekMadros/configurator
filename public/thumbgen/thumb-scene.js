import * as THREE from "/vendor/three/build/three.module.js";
import { GLTFLoader } from "/vendor/three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "/vendor/three/examples/jsm/environments/RoomEnvironment.js";

console.log("thumb-scene.js loaded ✅");

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});

renderer.setSize(512, 512, false);
renderer.setPixelRatio(1);

// stejné jako appka (máš to tak už teď)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;

renderer.physicallyCorrectLights = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f5f2);

const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.ShadowMaterial({ opacity: 0.18 })
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.y = 0;     // budeš to držet u země
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

const shadowLight = new THREE.DirectionalLight(0xffffff, 0.35);
shadowLight.position.set(0, 4.5, 0);     // přímo nad
shadowLight.target.position.set(0, 0, 0);
scene.add(shadowLight);
scene.add(shadowLight.target);

shadowLight.castShadow = true;
shadowLight.shadow.mapSize.set(1024, 1024);
shadowLight.shadow.bias = -0.0002;
shadowLight.shadow.normalBias = 0.02;

// oblast stínové kamery (ať stín je jen pod sedačkou)
shadowLight.shadow.camera.left = -2.0;
shadowLight.shadow.camera.right = 2.0;
shadowLight.shadow.camera.top = 2.0;
shadowLight.shadow.camera.bottom = -2.0;
shadowLight.shadow.camera.near = 0.5;
shadowLight.shadow.camera.far = 10.0;

// === "FALEŠNÉ HDRI" jen pro kov (tmavší, aby chrom nezmizel) ===
const pmrem = new THREE.PMREMGenerator(renderer);

function createDarkMetalEnvMap() {
  const envScene = new THREE.Scene();

  // tmavá "místnost"
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(10, 6, 10),
    new THREE.MeshBasicMaterial({ color: 0x2a2b2e, side: THREE.BackSide })
  );
  envScene.add(room);

  // světlý panel (udělá hezký highlight na chromu)
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panel1 = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 2.2), panelMat);
  panel1.position.set(-1.5, 1.2, -4.9);
  envScene.add(panel1);

  // druhý panel z boku (ať to má "tvar" v odlesku)
  const panel2 = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), panelMat);
  panel2.position.set(4.9, 1.6, 0.8);
  panel2.rotation.y = -Math.PI / 2;
  envScene.add(panel2);

  // lehce šedý panel zhora (jemný fill, ale ne bílá)
  const panel3 = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshBasicMaterial({ color: 0x5a5a5a }) 
  );
  panel3.position.set(0, 2.9, 0);
  panel3.rotation.x = Math.PI / 2;
  envScene.add(panel3);

  // vygeneruj env mapu
  const rt = pmrem.fromScene(envScene, 0.0);
  return rt.texture;
}

const METAL_ENVMAP = createDarkMetalEnvMap();

// důležité: environment nesmí být globální, jinak ovlivní i látku
scene.environment = null;

// kamera (níž)
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
camera.position.set(0, 0.50, 2.5);
camera.lookAt(0, 0.22, 0);
camera.updateProjectionMatrix();

// světla (jemnější, aby se to nepřepalovalo)
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.50);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 0.95);
dir.position.set(3, 4, 2);
scene.add(dir);

const rim = new THREE.DirectionalLight(0xffffff, 0.8);
rim.position.set(-2, 2, -2);
scene.add(rim);

// ====== TVOJE LÁTKA: public/textures/fabric/basecolor ======
// podle screenshotu máš soubory např.
// basecolor_COL_VAR2_2K.jpg (albedo)
// basecolor_NRM_2K.jpg      (normal)
// basecolor_GLOSS_2K.jpg    (gloss -> z toho uděláme roughness)
const FABRIC_COLOR_URL = "/textures/fabric/basecolor/basecolor_COL_VAR2_2K.jpg";
const FABRIC_GLOSS_URL = "/textures/fabric/basecolor/basecolor_GLOSS_2K.jpg"; // gloss -> invert na roughness
const FABRIC_NRM_URL   = "/textures/fabric/basecolor/basecolor_NRM_2K.jpg";

const texLoader = new THREE.TextureLoader();

function loadTexAsync(url, opts) {
  return new Promise((resolve, reject) => {
    texLoader.load(
      url,
      (t) => resolve(setupTex(t, opts)),
      undefined,
      (e) => reject(e)
    );
  });
}

// gloss(white=lesk) -> roughness(white=drsnost) = invert
function invertToRoughness(glossTex) {
  const img = glossTex.image;
  const w = img.width;
  const h = img.height;

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;

  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;

  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];         // vezmeme R
    const inv = 255 - v;    // invert
    d[i] = d[i + 1] = d[i + 2] = inv;
    d[i + 3] = 255;
  }

  ctx.putImageData(data, 0, 0);

  const rough = new THREE.CanvasTexture(c);
  rough.wrapS = glossTex.wrapS;
  rough.wrapT = glossTex.wrapT;
  rough.repeat.copy(glossTex.repeat);
  rough.anisotropy = glossTex.anisotropy;
  rough.needsUpdate = true;
  return rough;
}

function setupTex(t, { isColor = false, repeat = 3 } = {}) {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (isColor) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function loadTex(url, opts) {
  const t = texLoader.load(url);
  return setupTex(t, opts);
}

// =====================================================
// MATERIÁLY – fabric + metal + hinge
// =====================================================
async function makeFabricMaterial({ repeat = 3 } = {}) {
  const map = await loadTexAsync(FABRIC_COLOR_URL, { isColor: true, repeat });
  const normalMap = await loadTexAsync(FABRIC_NRM_URL, { isColor: false, repeat });

  const glossMap = await loadTexAsync(FABRIC_GLOSS_URL, { isColor: false, repeat });
  const roughnessMap = invertToRoughness(glossMap);

  return new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
}

async function makePaspuleMaterial({ repeat = 3 } = {}) {
  const map = await loadTexAsync("/textures/fabric/basecolor/Paspule-default.png", { isColor: true, repeat });
  const normalMap = await loadTexAsync("/textures/fabric/basecolor/Paspule-normal.png", { isColor: false, repeat });
  const roughnessMap = await loadTexAsync("/textures/fabric/basecolor/Paspule-roughness.png", { isColor: false, repeat });

  return new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
}

async function makeWoodMaterial(baseName, { repeat = 3, roughness = 1.0 } = {}) {
  const map = await loadTexAsync(`/textures/wood/buk/${baseName}.png`, { isColor: true, repeat });
  const normalMap = await loadTexAsync(`/textures/wood/buk/${baseName}_normal.png`, { isColor: false, repeat });
  const roughnessMap = await loadTexAsync(`/textures/wood/buk/${baseName}_roughness.png`, { isColor: false, repeat });

  return new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    roughness,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
}

// kov na nohy (odlesky dělá scene.environment)
function makeMetalMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xd0d0d0,     // nebyla čistě bílá
    metalness: 1.0,
    roughness: 0.10,     // víc "chrom"
    envMapIntensity: 2.2 // silnější odlesk (díky tmavému env to nebude splývat)
  });
  m.envMap = METAL_ENVMAP;
  m.needsUpdate = true;
  return m;
}

// panty – víc “chrom” / odlesky
function makeHingeMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xe0e0e0,
    metalness: 1.0,
    roughness: 0.06,
    envMapIntensity: 2.6,
  });
  m.envMap = METAL_ENVMAP;
  m.needsUpdate = true;
  return m;
}

// =====================================================
// ROZPOZNÁNÍ ČÁSTÍ – podle názvů (jak to už děláš)
// =====================================================
function isUpholsteryName(nameLower) {
  return (
    nameLower === "body" ||
    nameLower === "body1" ||
    nameLower === "body2" ||
    nameLower.startsWith("seat_") ||
    nameLower.startsWith("backrest_") ||
    nameLower.startsWith("armrest_")
  );
}

function isHingeName(nameLower) {
  return nameLower === "hinge" || nameLower === "hinge2";
}

function isLegName(nameLower) {
  return nameLower.startsWith("legs_") || /^n\d+$/.test(nameLower);
}

function matchesBaseName(nameLower, baseLower) {
  return (
    nameLower === baseLower ||
    nameLower.startsWith(baseLower + ".") ||
    nameLower.startsWith(baseLower + "_")
  );
}

let __MAT_CACHE = null;

async function getMaterials({ repeat = 3 } = {}) {
  if (__MAT_CACHE) return __MAT_CACHE;

  const MAT_FABRIC = await makeFabricMaterial({ repeat });
  const MAT_PASPULE = await makePaspuleMaterial({ repeat });
  const MAT_METAL = makeMetalMaterial();
  const MAT_HINGE = makeHingeMaterial();
  const MAT_WOOD_N9 = await makeWoodMaterial("buk_prirodni", { repeat });
  const MAT_WOOD_CORNER = await makeWoodMaterial("buk_br_281", { repeat, roughness: 0.9 });

  __MAT_CACHE = { MAT_FABRIC, MAT_PASPULE, MAT_METAL, MAT_HINGE, MAT_WOOD_N9, MAT_WOOD_CORNER };
  return __MAT_CACHE;
}

async function applyMaterials(root, { repeat = 3 } = {}) {
  const { MAT_FABRIC, MAT_PASPULE, MAT_METAL, MAT_HINGE, MAT_WOOD_N9, MAT_WOOD_CORNER } = await getMaterials({ repeat });

  root.traverse((o) => {
    if (!o?.isMesh) return;

    const n = (o.name || "").toLowerCase();

    // výjimky:
    if (isHingeName(n)) {
      o.material = MAT_HINGE;
      return;
    }

    if (isLegName(n)) {
      if (n === "legs_n9" || n === "n9" || n === "legs_n7" || n === "n7") {
        o.material = MAT_WOOD_N9;
      } else {
        o.material = MAT_METAL;
      }
      return;
    }

    if (n === "plane") {
      o.material = MAT_WOOD_CORNER;
      return;
    }

    if (n.includes("paspule")) {
      o.material = MAT_PASPULE;
      return;
    }

    // default: všechno ostatní je čalounění
    o.material = MAT_FABRIC;
  });
}

// =====================================================
// CAMERA FIT (bez globální proměnné dist → žádný "dist is not defined")
// =====================================================
function fitCameraToObject(obj3d, padding = 1) {
  // 1) bbox v aktuální pozici
  const box = new THREE.Box3().setFromObject(obj3d);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // 2) vycentruj X/Z, Y uzemni (spodek na y=0)
  obj3d.position.x -= center.x;
  obj3d.position.z -= center.z;
  obj3d.position.y -= box.min.y;

  // 3) po posunu znovu bbox + bounding sphere
  const box2 = new THREE.Box3().setFromObject(obj3d);
  const size2 = new THREE.Vector3();
  box2.getSize(size2);

  const sphere = new THREE.Sphere();
  box2.getBoundingSphere(sphere);

  // 4) pevný směr kamery (trochu víc shora než doteď – Manila look)
  const DIR = new THREE.Vector3(0, 0.28, 1).normalize();

  // 5) míříme na "střed sedačky" (lehce níž než půlka výšky)
  const target = new THREE.Vector3(0, size2.y * 0.42, 0);

  // 6) distance z bounding sphere (řeší i HLoubku Z)
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || (canvas.width / canvas.height);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

  // aby se koule vešla do výšky i šířky
  const distV = sphere.radius / Math.sin(vFov / 2);
  const distH = sphere.radius / Math.sin(hFov / 2);
  let dist = Math.max(distV, distH);

  dist *= padding;

  // 7) posaď kameru
  camera.position.copy(target).addScaledVector(DIR, dist);
  camera.lookAt(target);

  // 8) near/far pojistka
  camera.near = Math.max(0.01, dist / 100);
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadGLB(url) {
  const loader = new GLTFLoader();
  return await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

// =====================================================
// MENDOZA: základní konfigurace (nechávám tvoji logiku)
// =====================================================
function enforceMendozaBaseConfig(root) {
  let looksLikeMendoza = false;
  root.traverse((o) => {
    const n = (o?.name || "").toLowerCase();
    if (n === "body1" || n === "hinge2" || n === "armrest_p2" || n === "armrest_l2") looksLikeMendoza = true;
  });
  if (!looksLikeMendoza) return;

  // viditelnost dílů
  root.traverse((obj) => {
    const n = (obj?.name || "").toLowerCase();
    if (!n) return;

    if (n.startsWith("seat_") || n.startsWith("backrest_")) { obj.visible = true; return; }
    if (n === "body")  { obj.visible = true; return; }

    if (n === "hinge") { obj.visible = true; return; }
    if (n === "hinge2"){ obj.visible = false; return; }

    if (n === "body1") { obj.visible = true; return; }
    if (n === "body2") { obj.visible = false; return; }

    if (n === "armrest_p")  { obj.visible = true; return; }
    if (n === "armrest_l")  { obj.visible = true; return; }
    if (n === "armrest_p2") { obj.visible = false; return; }
    if (n === "armrest_l2") { obj.visible = false; return; }
  });

  // nohy: preferuj legs_n8, fallback n8
  let hasLegsN8 = false;
  let hasPlainN8 = false;

  root.traverse((o) => {
    const n = (o?.name || "").toLowerCase();
    if (n === "legs_n8") hasLegsN8 = true;
    if (n === "n8") hasPlainN8 = true;
  });

  const chosen = hasLegsN8 ? "legs_n8" : (hasPlainN8 ? "n8" : null);
  if (chosen) {
    root.traverse((o) => {
      if (!o?.isMesh) return;
      const n = (o.name || "").toLowerCase();
      const isLegsGroup = n.startsWith("legs_");
      const isPlainN = /^n\d+$/.test(n);
      if (!isLegsGroup && !isPlainN) return;
      o.visible = (n === chosen);
    });
  }
}

function enforceManilaBaseConfig(root) {
  const file = String(window.__thumbCurrentGlbUrl || "").toLowerCase();

  const armrestMode =
    file.includes("manila_roh_") ? "none"
    : (file.includes("manila_1d_l") || file.includes("manila_1l") || file.includes("manila_2l") || file.includes("manila_3l") || file.includes("manila_1mo_l")) ? "left"
    : (file.includes("manila_1d_p") || file.includes("manila_1p") || file.includes("manila_2p") || file.includes("manila_3p") || file.includes("manila_1mo_p")) ? "right"
    : (file.includes("manila_1m") || file.includes("manila_2m") || file.includes("manila_3m")) ? "none"
    : "both";

  root.traverse((obj) => {
    const n = (obj?.name || "").toLowerCase();
    if (!n) return;

    if (n === "armrest_sharp_l" || n === "armrest_sharp_p") {
      obj.visible = false;
      return;
    }

    if (n === "armrest_l") {
      obj.visible = armrestMode === "left" || armrestMode === "both";
      return;
    }

    if (n === "armrest_p") {
      obj.visible = armrestMode === "right" || armrestMode === "both";
      return;
    }
  });

  root.traverse((o) => {
    if (!o?.isMesh) return;
    const n = (o.name || "").toLowerCase();
    const isLegsGroup = n.startsWith("legs_");
    const isPlainN = /^n\d+$/.test(n);
    if (!isLegsGroup && !isPlainN) return;
    o.visible = (n === "legs_n7" || n === "n7");
  });
}

function enforceMelbourneBaseConfig(root) {
  const setByBase = (baseLower, visible) => {
    root.traverse((o) => {
      const n = (o?.name || "").toLowerCase();
      if (!n) return;
      if (n === baseLower || n.startsWith(baseLower + ".") || n.startsWith(baseLower + "_")) {
        o.visible = visible;
      }
    });
  };

  const getDefaultBackrestState = (glbUrl = "") => {
    const file = String(glbUrl || "").toLowerCase();
    const st = { p: 1, l: 1, s: 1 };

    if (file.includes("melbourne_2.glb") || file.includes("melbourne_2l.glb")) st.p = 2;
    else if (file.includes("melbourne_2m.glb") || file.includes("melbourne_2p.glb")) st.l = 2;
    else if (
      file.includes("melbourne_3.glb") ||
      file.includes("melbourne_3l.glb") ||
      file.includes("melbourne_3m.glb") ||
      file.includes("melbourne_3p.glb")
    ) st.s = 2;

    return st;
  };

  root.traverse((obj) => {
    const n = (obj?.name || "").toLowerCase();
    if (!n) return;

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
      obj.visible = true;
      return;
    }

    if (n === "cube") {
      obj.visible = false;
    }
  });

  const st = getDefaultBackrestState(window.__thumbCurrentGlbUrl || "");
  for (const k of ["p", "l", "s"]) {
    const isUp = st[k] === 2;
    setByBase(`backrest_1${k}`, !isUp);
    setByBase(`backrest_2${k}`, isUp);
    setByBase(`paspule_1${k}`, !isUp);
    setByBase(`paspule_2${k}`, isUp);
    setByBase(`hinge_${k}`, isUp);
  }

  root.traverse((o) => {
    if (!o?.isMesh) return;
    const n = (o.name || "").toLowerCase();

    if (n === "legs_n9" || n === "n9") o.visible = true;
    if (n === "legs_n21" || n === "n21" || n === "legs_n1" || n === "n1" || n === "legs_n11" || n === "n11") {
      o.visible = false;
    }
  });
}

function enforceManchesterBaseConfig(root) {
  // DŮLEŽITÉ:
  // Nesmíme schovávat parent/group objekty.
  // Když parent.visible = false, child mesh se nevykreslí ani když má visible = true.
  //
  // Proto viditelnost nastavujeme jen na meshích.
  const ALLOWED_BASES = [
    "legs_n21",
    "body",
    "body1",
    "armrest_l",
    "armrest_p",
    "headrest_l",
    "headrest_p",
    "headrest_s",
    "seat",
    "seat_l",
    "seat_p",
    "seat_s",
  ];

  root.traverse((obj) => {
    if (!obj?.isMesh) return;

    const n = String(obj.name || "").trim().toLowerCase();
    if (!n) return;

    // Nohy:
    // zobrazit POUZE legs_N21
    // plain N21 i všechny ostatní nohy schovat
    if (isLegName(n)) {
      obj.visible = matchesBaseName(n, "legs_n21");
      return;
    }

    obj.visible = ALLOWED_BASES.some((base) =>
      matchesBaseName(n, base)
    );
  });
}

function getPaddingForModel(glbUrl = "") {
  const f = glbUrl.toLowerCase();

  // základ (nejčastější “1L/1M/2” moduly)
  let p = 0.8;

  // menší moduly chceme víc “přiblížit” (menší padding = blíž)
  if (f.includes("kreslo")) p = 0.95;

  // dlouhé / široké moduly chceme víc “oddálit”, aby se vešly
  if (f.includes("3")) p = 1;
  if (f.includes("3l") || f.includes("3m") || f.includes("3p")) p = 1;

  // dlouhé / široké moduly chceme víc “oddálit”, aby se vešly
  if (f.includes("2")) p = 0.9;
  if (f.includes("2l") || f.includes("2m") || f.includes("2p")) p = 0.9;

  // lehátka (1d, 1mo) bývají dlouhá do hloubky → radši trochu dál
  if (f.includes("1d")) p = 0.7;
  if (f.includes("1mo")) p = 0.9;

  // rohy / L a P varianty bývají největší do šířky
  if (f.includes("roh")) p = 0.9;

  return p;
}

// =====================================================
// API pro Puppeteer
// - druhý parametr opts je VOLITELNÝ
// - když nic neposíláš, dá default Clara 01 + repeat 3 (jako v appce)
// =====================================================
window.__renderThumb = async function (glbUrl, opts = {}) {
  const { repeat = 3 } = opts;
  window.__thumbCurrentGlbUrl = glbUrl;

  // vyčisti scénu (ponech světla + shadow plane + target)
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const o = scene.children[i];

    if (o.isLight) continue;
    if (o === shadowCatcher) continue;
    if (o === shadowLight.target) continue;

    scene.remove(o);
  }

  const gltf = await loadGLB(glbUrl);
  const root = gltf.scene;

  const glbLower = String(glbUrl || "").toLowerCase();

  if (glbLower.includes("/melbourne/")) {
    enforceMelbourneBaseConfig(root);
  } else if (glbLower.includes("/manila/")) {
    enforceManilaBaseConfig(root);
  } else if (glbLower.includes("/manchester/")) {
    enforceManchesterBaseConfig(root);
  } else {
    enforceMendozaBaseConfig(root);
  }
  await applyMaterials(root, { repeat });

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;      // model bude házet stín
      o.receiveShadow = false;  // model stín nepřijímá (jen plane)
    }
  });

  scene.add(root);

  shadowCatcher.position.y = 0.0005;

  fitCameraToObject(root, getPaddingForModel(glbUrl));

  // pár framů na “dosednutí” shaderů/textur
  renderer.render(scene, camera);
  await sleep(16);
  renderer.render(scene, camera);
  await sleep(16);
  renderer.render(scene, camera);

  return canvas.toDataURL("image/png");
};
