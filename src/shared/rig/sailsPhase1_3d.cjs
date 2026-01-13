const { SNIPE_RULES_M } = require("./snipeRules.cjs");
const { clamp, sub3, norm3, cross3 } = require("./math3.cjs");
const { createMembraneMesh } = require("./sailMembrane3d.cjs");

/**
 * VELAS 3D - MODELO DE MEMBRANA
 *
 * Las velas se modelan como membranas (elementos finitos triangulares CST)
 * que resisten tensión en el plano pero NO flexión.
 *
 * FÍSICA:
 * - La membrana tiene rigidez en el plano (E, ν, espesor)
 * - Pretensión inicial para estabilidad numérica
 * - La presión actúa perpendicular a la superficie (follower load)
 * - El equilibrio se alcanza cuando: Tensión × Curvatura = Presión
 *
 * VENTAJAS sobre el modelo de cables:
 * - Comportamiento continuo de la tela
 * - Forma de equilibrio físicamente correcta bajo presión
 * - No necesita springs artificiales para mantener forma
 */

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist3(a, b) {
  return norm3(sub3(b, a));
}

function triArea(a, b, c) {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const cr = cross3(ab, ac);
  return 0.5 * norm3(cr);
}

/**
 * Calcula la normal de un cuadrilátero (promedio de las normales de sus 2 triángulos)
 * Retorna un vector unitario perpendicular al panel
 */
function quadNormal(a, b, c, d) {
  // Triángulo ABC
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const n1 = cross3(ab, ac);

  // Triángulo ACD
  const ad = sub3(d, a);
  const n2 = cross3(ac, ad);

  // Promedio de normales
  const nx = n1[0] + n2[0];
  const ny = n1[1] + n2[1];
  const nz = n1[2] + n2[2];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-12) return [1, 0, 0]; // Fallback si el panel es degenerado
  return [nx / len, ny / len, nz / len];
}

function sectionValue(t, arr, fallback) {
  const n = Array.isArray(arr) ? arr.length : 0;
  if (n === 0) return fallback;
  if (n === 1) return arr[0];
  const tt = clamp01(t) * (n - 1);
  const i = Math.floor(tt);
  const u = tt - i;
  const a = arr[i] ?? fallback;
  const b = arr[Math.min(n - 1, i + 1)] ?? a;
  return lerp(a, b, u);
}

function camberAt(s, m, p) {
  const x = clamp01(s);
  const mm = Math.max(0, m);
  const pp = Math.max(1e-6, Math.min(1 - 1e-6, p));
  if (x < pp) return (mm / (pp * pp)) * (2 * pp * x - x * x);
  return (mm / ((1 - pp) * (1 - pp))) * ((1 - 2 * pp) + 2 * pp * x - x * x);
}

function interpStations(stations, t) {
  const tt = clamp01(t);
  if (!stations?.length) return 0;
  if (tt <= stations[0].t) return stations[0].v;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1];
    const b = stations[i];
    if (tt <= b.t + 1e-12) {
      const u = Math.abs(b.t - a.t) < 1e-12 ? 0 : (tt - a.t) / (b.t - a.t);
      return lerp(a.v, b.v, u);
    }
  }
  return stations[stations.length - 1].v;
}

function pickUniform(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const nn = Math.max(1, Math.trunc(n));
  if (nn === 1) return [arr[0]];
  if (nn >= arr.length) return arr.slice();
  const out = [];
  for (let i = 0; i < nn; i++) {
    const t = i / (nn - 1);
    const idx = Math.round(t * (arr.length - 1));
    out.push(arr[idx]);
  }
  const seen = new Set();
  return out.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

function normalizeSections(arr, count, fallback, min, max) {
  const n = clamp(Math.trunc(count), 2, 6);
  const src = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = Number(src[i]);
    const val = Number.isFinite(v) ? clamp(v, min, max) : fallback;
    out.push(val);
  }
  return out;
}

function findClosestNodeIdByZ(model, zTarget) {
  let bestId = model.mastNodeIds[0];
  let bestDz = Infinity;
  for (const id of model.mastNodeIds) {
    const z = model.nodes[id].p0[2];
    const dz = Math.abs(z - zTarget);
    if (dz < bestDz) {
      bestDz = dz;
      bestId = id;
    }
  }
  return bestId;
}

function indexInArray(arr, value) {
  const idx = arr.indexOf(value);
  if (idx === -1) throw new Error(`Missing value in array: ${value}`);
  return idx;
}

function getDefaultSailsConfig() {
  return {
    enabled: false,
    windPressurePa: 0,
    windSign: 1,
    main: {
      enabled: true,
      // Veleria: Forma de la vela
      draftDepth: 0.08,
      draftPos: 0.4,
      shapeSections: 4,
      draftDepthSections: [],
      draftPosSections: [],
      tackZM: null,
      luffLengthM: SNIPE_RULES_M.rig.mainsailLuffMastDistanceM.max,
      footLengthM: SNIPE_RULES_M.rig.boomOuterPointDistanceM.max,
      // Trimado: Controles Dirichlet (desplazamientos directos)
      cunninghamMm: 0,          // Tensión grátil - modifica draft position
      boomAngleDeg: 0,          // Ángulo horizontal de la botavara (escota)
      boomTiltDeg: 0,           // Ángulo vertical de la botavara (trapa/vang)
      outhaulMm: 0,             // Desplazamiento del puño de escota (foot tension)
      sheetLeadYM: -2.2,        // Posición del carro de escota
      mesh: { luffSegments: 12, chordSegments: 4 }
    },
    jib: {
      enabled: true,
      // Veleria: Forma del foque
      draftDepth: 0.07,
      draftPos: 0.35,
      shapeSections: 4,
      draftDepthSections: [],
      draftPosSections: [],
      luffLengthM: SNIPE_RULES_M.sails.jib.luffLengthM,
      footLengthM: SNIPE_RULES_M.sails.jib.footLengthM,
      // Trimado: Controles Dirichlet (desplazamientos directos)
      clewDisplaceMm: 0,        // Desplazamiento del puño hacia el carro
      sheetSideSign: 0,         // Lado del carro (-1=Er, 0=centro, +1=Br)
      sheetLeadXMm: 400,        // Posición X del carro (desde crujía)
      sheetLeadYMm: -1800,      // Posición Y del carro (desde palo)
      mesh: { luffSegments: 8, chordSegments: 4 },
      stayTopSegments: 1
    }
  };
}

function normalizeSailsConfig(sails, geometry) {
  const defaults = getDefaultSailsConfig();
  const input = sails && typeof sails === "object" ? sails : {};

  const out = {
    enabled: Boolean(input.enabled),
    windPressurePa: Number.isFinite(input.windPressurePa) ? input.windPressurePa : defaults.windPressurePa,
    windSign: Number.isFinite(input.windSign) ? (input.windSign >= 0 ? 1 : -1) : defaults.windSign,
    main: { ...defaults.main, ...(input.main && typeof input.main === "object" ? input.main : {}) },
    jib: { ...defaults.jib, ...(input.jib && typeof input.jib === "object" ? input.jib : {}) }
  };

  out.windPressurePa = Math.max(0, out.windPressurePa);

  // Main sail: Veleria
  out.main.enabled = Boolean(out.main.enabled);
  out.main.draftDepth = clamp(out.main.draftDepth ?? defaults.main.draftDepth, 0, 0.25);
  out.main.draftPos = clamp(out.main.draftPos ?? defaults.main.draftPos, 0.05, 0.95);
  out.main.shapeSections = clamp(Math.trunc(out.main.shapeSections ?? defaults.main.shapeSections), 2, 6);
  out.main.draftDepthSections = normalizeSections(out.main.draftDepthSections, out.main.shapeSections, out.main.draftDepth, 0, 0.25);
  out.main.draftPosSections = normalizeSections(out.main.draftPosSections, out.main.shapeSections, out.main.draftPos, 0.05, 0.95);
  out.main.luffLengthM = clamp(
    Number(out.main.luffLengthM ?? defaults.main.luffLengthM),
    0.5,
    SNIPE_RULES_M.rig.mainsailLuffMastDistanceM.max
  );
  out.main.footLengthM = clamp(
    Number(out.main.footLengthM ?? defaults.main.footLengthM),
    0.5,
    SNIPE_RULES_M.rig.boomOuterPointDistanceM.max
  );
  // Main sail: Trimado Dirichlet
  out.main.cunninghamMm = clamp(Number(out.main.cunninghamMm ?? 0), 0, 100);
  out.main.boomAngleDeg = clamp(Number(out.main.boomAngleDeg ?? 0), 0, 90);
  out.main.boomTiltDeg = clamp(Number(out.main.boomTiltDeg ?? 0), -10, 30);
  out.main.outhaulMm = clamp(Number(out.main.outhaulMm ?? 0), -50, 100);
  out.main.sheetLeadYM = Number.isFinite(out.main.sheetLeadYM) ? out.main.sheetLeadYM : defaults.main.sheetLeadYM;
  out.main.mesh = {
    luffSegments: clamp(Math.trunc(out.main.mesh?.luffSegments ?? defaults.main.mesh.luffSegments), 2, 40),
    chordSegments: clamp(Math.trunc(out.main.mesh?.chordSegments ?? defaults.main.mesh.chordSegments), 2, 40)
  };

  // Jib: Veleria
  out.jib.enabled = Boolean(out.jib.enabled);
  out.jib.draftDepth = clamp(out.jib.draftDepth ?? defaults.jib.draftDepth, 0, 0.25);
  out.jib.draftPos = clamp(out.jib.draftPos ?? defaults.jib.draftPos, 0.05, 0.95);
  out.jib.shapeSections = clamp(Math.trunc(out.jib.shapeSections ?? defaults.jib.shapeSections), 2, 6);
  out.jib.draftDepthSections = normalizeSections(out.jib.draftDepthSections, out.jib.shapeSections, out.jib.draftDepth, 0, 0.25);
  out.jib.draftPosSections = normalizeSections(out.jib.draftPosSections, out.jib.shapeSections, out.jib.draftPos, 0.05, 0.95);
  out.jib.luffLengthM = clamp(
    Number(out.jib.luffLengthM ?? defaults.jib.luffLengthM),
    0.5,
    SNIPE_RULES_M.sails.jib.luffLengthM
  );
  out.jib.footLengthM = clamp(
    Number(out.jib.footLengthM ?? defaults.jib.footLengthM),
    0.5,
    SNIPE_RULES_M.sails.jib.footLengthM
  );
  // Jib: Trimado Dirichlet
  out.jib.clewDisplaceMm = clamp(Number(out.jib.clewDisplaceMm ?? 0), 0, 300);
  out.jib.sheetSideSign = Number.isFinite(out.jib.sheetSideSign) ? Math.sign(out.jib.sheetSideSign) : defaults.jib.sheetSideSign;
  out.jib.sheetLeadXMm = clamp(Number(out.jib.sheetLeadXMm ?? defaults.jib.sheetLeadXMm), 0, 600);
  out.jib.sheetLeadYMm = clamp(Number(out.jib.sheetLeadYMm ?? defaults.jib.sheetLeadYMm), -2500, 0);
  out.jib.mesh = {
    luffSegments: clamp(Math.trunc(out.jib.mesh?.luffSegments ?? defaults.jib.mesh.luffSegments), 2, 40),
    chordSegments: clamp(Math.trunc(out.jib.mesh?.chordSegments ?? defaults.jib.mesh.chordSegments), 2, 40)
  };
  out.jib.stayTopSegments = Math.max(1, Math.trunc(out.jib.stayTopSegments ?? defaults.jib.stayTopSegments));

  return out;
}

// 3D version: forces are [fx, fy, fz]
function addNode3d(model, name, p0, fixed) {
  const id = model.nodes.length;
  model.nodes.push({ id, name, p0: p0.slice(), fixed: Boolean(fixed) });
  model.forces[id] = model.forces[id] ?? [0, 0, 0];
  return id;
}

function addAxial(model, e) {
  model.axial.push(e);
}

function buildSailGrid3d({
  model,
  namePrefix,
  luffNodeIds,
  chordStations,
  chordSegments,
  draftDepth,
  draftPos,
  draftDepthSections,
  draftPosSections,
  chordDirY,
  useFootNodeIds
}) {
  const nRows = luffNodeIds.length - 1;
  const nCols = chordSegments;
  const grid = new Array(nRows + 1);

  for (let i = 0; i <= nRows; i++) {
    const t = nRows === 0 ? 0 : i / nRows;
    const luffId = luffNodeIds[i];
    const base = model.nodes[luffId].p0;
    const chordLen = interpStations(chordStations, t);
    const rowDraftDepth = sectionValue(t, draftDepthSections, draftDepth);
    const rowDraftPos = sectionValue(t, draftPosSections, draftPos);

    const row = new Array(nCols + 1);
    for (let j = 0; j <= nCols; j++) {
      if (j === 0) {
        row[j] = luffId;
        continue;
      }
      if (useFootNodeIds && i === 0) {
        row[j] = useFootNodeIds[j];
        continue;
      }

      const s = nCols === 0 ? 0 : j / nCols;
      const camber = camberAt(s, rowDraftDepth, rowDraftPos) * chordLen;
      const p0 = [base[0] + camber, base[1] + chordDirY * (s * chordLen), base[2]];
      row[j] = addNode3d(model, `${namePrefix}_${i}_${j}`, p0, false);
    }
    grid[i] = row;
  }

  return { grid, nRows, nCols };
}

function addGridCables({
  model,
  grid,
  nRows,
  nCols,
  namePrefix,
  EA,
  footEdgeDeltaTotalM,
  compressionEps,
  smoothDeltaM
}) {
  const edges = new Set();
  const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const addEdge = (a, b, deltaL0M = 0) => {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (edges.has(key)) return;
    edges.add(key);
    const L = dist3(model.nodes[a].p0, model.nodes[b].p0);
    const L0 = Math.max(1e-6, L - Math.max(0, deltaL0M));
    addAxial(model, { name: `${namePrefix}_${edges.size}`, i: a, j: b, EA, L0, kind: "cable", compressionEps, smoothDeltaM });
  };

  const footDeltaPerEdge = Math.max(0, footEdgeDeltaTotalM ?? 0) / Math.max(1, nCols);

  for (let i = 0; i <= nRows; i++) {
    for (let j = 0; j <= nCols; j++) {
      const id = grid[i][j];
      if (j < nCols) {
        const right = grid[i][j + 1];
        const isFoot = i === 0;
        addEdge(id, right, isFoot ? footDeltaPerEdge : 0);
      }
      if (i < nRows) {
        const up = grid[i + 1][j];
        addEdge(id, up, 0);
      }
      if (i < nRows && j < nCols) {
        const d1 = grid[i + 1][j + 1];
        const d2 = grid[i + 1][j];
        const d3 = grid[i][j + 1];
        addEdge(id, d1, 0);
        addEdge(d2, d3, 0);
      }
    }
  }
}

/**
 * Aplica presión aerodinámica PERPENDICULAR a cada panel de la vela.
 *
 * FÍSICA CORRECTA:
 * - La presión del viento actúa perpendicular a la superficie de la vela
 * - La fuerza sobre cada panel es: F = P * A * n
 *   donde P es la presión, A es el área, y n es la normal unitaria
 * - La fuerza se distribuye entre los 4 nodos del panel
 *
 * CONVENCIÓN DE SIGNOS:
 * - windSign > 0: Viento de estribor (amura estribor), empuja hacia babor (-X)
 * - windSign < 0: Viento de babor (amura babor), empuja hacia estribor (+X)
 * - La normal del panel apunta hacia sotavento (lado convexo de la vela)
 */
function applyPressureToGrid3d({
  model,
  grid,
  nRows,
  nCols,
  pressurePa,
  windSign
}) {
  const pMag = Math.max(0, pressurePa);
  if (pMag < 1e-12) return;

  // Dirección del viento: windSign >= 0 significa viento de estribor
  // La presión empuja la vela hacia sotavento
  const pressureSign = windSign >= 0 ? -1 : 1;

  for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < nCols; j++) {
      const aId = grid[i][j];
      const bId = grid[i + 1][j];
      const cId = grid[i + 1][j + 1];
      const dId = grid[i][j + 1];

      const a = model.nodes[aId].p0;
      const b = model.nodes[bId].p0;
      const c = model.nodes[cId].p0;
      const d = model.nodes[dId].p0;

      // Área total del cuadrilátero (suma de 2 triángulos)
      const area1 = triArea(a, b, c);
      const area2 = triArea(a, c, d);
      const totalArea = area1 + area2;

      // Normal unitaria del panel (perpendicular a la superficie)
      const normal = quadNormal(a, b, c, d);

      // Fuerza total sobre el panel: F = P * A
      // Dirección: perpendicular al panel, hacia sotavento
      // La normal calculada apunta "hacia afuera" del lado convexo
      // Multiplicamos por pressureSign para ajustar según el lado del viento
      const forceMag = pMag * totalArea * pressureSign;

      // Distribuir la fuerza entre los 4 nodos del panel (1/4 cada uno)
      const fx = (forceMag * normal[0]) / 4;
      const fy = (forceMag * normal[1]) / 4;
      const fz = (forceMag * normal[2]) / 4;

      // Aplicar a cada nodo
      model.forces[aId][0] += fx;
      model.forces[aId][1] += fy;
      model.forces[aId][2] += fz;

      model.forces[bId][0] += fx;
      model.forces[bId][1] += fy;
      model.forces[bId][2] += fz;

      model.forces[cId][0] += fx;
      model.forces[cId][1] += fy;
      model.forces[cId][2] += fz;

      model.forces[dId][0] += fx;
      model.forces[dId][1] += fy;
      model.forces[dId][2] += fz;
    }
  }
}

/**
 * Añade resortes de forma a los nodos de la vela para mantener el draft diseñado.
 *
 * FÍSICA:
 * - Los resortes penalizan la desviación de cada nodo respecto a su posición inicial (p0)
 * - Esto mantiene la forma de la vela (draft/camber) bajo presión
 * - Sin estos resortes, la vela se deformaría excesivamente
 *
 * RIGIDEZ EN CADA DIRECCIÓN:
 * - kx: Penaliza desplazamiento lateral (perpendicular a la vela) - MÁS IMPORTANTE
 * - ky: Penaliza desplazamiento en la dirección de la cuerda - MENOR
 * - kz: Penaliza desplazamiento vertical - MENOR
 *
 * Los valores de ky y kz son fracciones de kx porque:
 * - La vela DEBE poder deformarse en la dirección de la cuerda (estirarse)
 * - La vela DEBE poder moverse verticalmente con el mástil
 * - Pero queremos mantener cierta forma
 */
function addShapeSpringsForGrid3d({ model, grid, kx, ky, kz, namePrefix }) {
  if (!Number.isFinite(kx) || kx <= 0) return;
  if (!Array.isArray(grid) || grid.length < 2) return;
  model.springs = model.springs || [];

  // Valores por defecto: ky y kz son fracciones de kx
  // kx es la rigidez principal (perpendicular a la vela)
  // ky es menor para permitir estiramiento de la tela
  // kz es menor para permitir movimiento con el mástil
  const effectiveKy = Number.isFinite(ky) ? ky : kx * 0.15;
  const effectiveKz = Number.isFinite(kz) ? kz : kx * 0.10;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    for (let j = 1; j < row.length; j++) {
      const id = row[j];
      const node = model.nodes[id];
      if (!node || node.fixed) continue;

      // Resorte de forma: mantiene el nodo cerca de su posición inicial
      model.springs.push({
        name: `${namePrefix}_${i}_${j}`,
        nodeId: id,
        kx: kx,
        ky: effectiveKy,
        kz: effectiveKz
      });
    }
  }
}

function applySailsPhase1ToModel3d({ model, geometry, state, constants, sails }) {
  const cfg = normalizeSailsConfig(sails, geometry);
  if (!cfg.enabled) return model;

  // Rigidez de la jarcia (forestay, obenques)
  const rigEA = constants.rigEA ?? 1.2e8;
  // Rigidez axial de la botavara
  const boomEA = constants.boomEA ?? 1.0e2;
  // Rigidez a flexión de la botavara
  const boomEI = constants.boomEI ?? 5000;

  /**
   * PROPIEDADES DEL MATERIAL DE MEMBRANA PARA VELAS
   *
   * Las velas se modelan como membranas elásticas con las siguientes propiedades:
   *
   * E (Módulo de Young): Rigidez del material
   *   - Dacron estándar: 200-500 MPa
   *   - Dacron de regata: 400-800 MPa
   *   - Laminados (Kevlar/Carbon): 1000-3000 MPa
   *   - Valor típico: 500 MPa (5e8 Pa)
   *
   * nu (Coeficiente de Poisson): Relación deformación transversal/axial
   *   - Telas tejidas: 0.2-0.4
   *   - Valor típico: 0.3
   *
   * thickness (Espesor): Grosor de la tela
   *   - Velas ligeras (Snipe): 0.15-0.25 mm
   *   - Velas medianas: 0.25-0.40 mm
   *   - Velas pesadas: 0.40-0.60 mm
   *   - Valor típico: 0.25 mm (0.00025 m)
   *
   * prestress (Pretensión inicial): Tensión inicial en la membrana
   *   - Necesaria para estabilidad numérica (evita modos singulares)
   *   - Representa la tensión residual del corte de la vela
   *   - Valor típico: 500-2000 Pa
   *   - Demasiado bajo: inestabilidad numérica
   *   - Demasiado alto: vela demasiado rígida
   */
  const modeScale = state?.load?.mode === "downwind" ? 0.3 : 1.0;
  const effPressure = (state?.loadScale ?? 0) * cfg.windPressurePa * modeScale;

  /**
   * PARÁMETROS DE MEMBRANA BASADOS EN FÍSICA REAL
   *
   * Para estabilidad numérica y convergencia, necesitamos:
   * 1. E (Módulo de Young): Controla la rigidez en el plano
   * 2. Pretensión: Tensión inicial que estabiliza modos fuera del plano
   * 3. Wrinkling epsilon: Rigidez residual cuando la membrana está en compresión
   *
   * FÍSICA DE LA PRETENSIÓN:
   * Para una membrana esférica bajo presión P con radio R:
   *   Tensión de membrana σ = P * R / (2 * t)
   *
   * Para velas, el radio de curvatura típico es ~1-2m, así que:
   *   σ = 80 Pa * 1.5 m / (2 * 0.00025 m) = 240,000 Pa = 240 kPa
   *
   * Pero necesitamos una pretensión MENOR que la tensión de equilibrio
   * para que la membrana pueda deformarse. Típico: 5-10% de la tensión esperada.
   */
  // Típico Dacron: 0.5-1.0 GPa. Para alta rigidez (fibras): 2.0-3.0 GPa
  const membraneE = constants.membraneE ?? 2.5e9;           // 2.5 GPa (Dacron)
  const membraneNu = constants.membraneNu ?? 0.3;
  const membraneThickness = constants.membraneThickness ?? 0.00025;  // 0.25 mm

  // Radio de curvatura esperado de la vela (típico 1-2m para Snipe)
  const expectedCurvatureRadius = constants.membraneCurvatureRadius ?? 1.5;

  // Tensión de equilibrio esperada bajo presión máxima
  // σ_eq = P * R / (2 * t)
  const maxPressure = Math.max(cfg.windPressurePa, 50); // Mínimo 50 Pa para estabilidad
  const expectedEquilibriumStress = (maxPressure * expectedCurvatureRadius) / (2 * membraneThickness);

  // Pretensión: SOLO para estabilidad numérica, NO proporcional a loadScale
  // La pretensión proporcional a loadScale causa discontinuidad y explosión numérica.
  // La fuerza principal sobre la membrana viene de effPressure (presión de viento),
  // que ya tiene un ramp interno en el solver (pressureRampIters).
  const pretensionFraction = constants.membranePretensionFraction ?? 0.10; // Reducido: 50% era demasiado alto
  const membranePrestress = constants.membranePrestress ?? (expectedEquilibriumStress * pretensionFraction);
  console.log(`SAIL MEMBRANE: prestress=${membranePrestress.toFixed(0)} Pa (fraction=${pretensionFraction}, eqStress=${expectedEquilibriumStress.toFixed(0)})`);

  // Wrinkling epsilon: rigidez residual en compresión (Tension Field Theory)
  // Valor típico: 1e-4 (muy pequeño pero no cero para estabilidad numérica)
  const wrinklingEps = constants.membraneWrinklingEps ?? 1e-4;
  const membraneMaxStrain = constants.membraneMaxStrain ?? 2.0;

  // Rigidez espúrea para estabilizar flexión - DESHABILITADA
  // La pretensión de membrana debería proporcionar suficiente estabilidad
  // Los springs de estabilización causaban conflicto con el movimiento del mástil
  // porque intentaban mantener los nodos en p0 (posición inicial, no deformada)
  const spuriousK = 0;  // DESHABILITADO - era: (membraneE * membraneThickness) / 100.0;

  const membraneMaterial = {
    E: membraneE,
    nu: membraneNu,
    thickness: membraneThickness,
    prestress: membranePrestress,
    wrinklingEps: wrinklingEps,
    maxStrain: membraneMaxStrain
  };

  model.sails = { cfg, main: null, jib: null };
  model.beams = model.beams || [];

  // --- MAINSAIL + BOOM (DIRICHLET CONTROLS) ---
  if (cfg.main.enabled) {
    const tackZ = Number.isFinite(cfg.main.tackZM) ? cfg.main.tackZM : geometry.partnersZM;
    const tackNodeId = findClosestNodeIdByZ(model, tackZ);
    const tackZSnap = model.nodes[tackNodeId].p0[2];

    const headZ = Math.min(geometry.mastLengthM, tackZSnap + cfg.main.luffLengthM);
    const headNodeId = findClosestNodeIdByZ(model, headZ);

    const iTack = indexInArray(model.mastNodeIds, tackNodeId);
    const iHead = indexInArray(model.mastNodeIds, headNodeId);
    const start = Math.min(iTack, iHead);
    const end = Math.max(iTack, iHead);
    const mastLuffNodes = model.mastNodeIds.slice(start, end + 1);

    const luffNodes = pickUniform(mastLuffNodes, cfg.main.mesh.luffSegments + 1);
    if (luffNodes[0] !== tackNodeId) luffNodes[0] = tackNodeId;
    if (luffNodes[luffNodes.length - 1] !== headNodeId) luffNodes[luffNodes.length - 1] = headNodeId;

    // Cunningham effect: shifts draft position forward (increases draftPos parameter effect)
    const cunninghamEffect = (cfg.main.cunninghamMm || 0) / 100 * 0.1; // max ~10% shift
    const effectiveDraftPos = clamp(cfg.main.draftPos - cunninghamEffect, 0.1, 0.9);
    const effectiveDraftPosSections = (cfg.main.draftPosSections || []).map((p) => clamp(p - cunninghamEffect, 0.1, 0.9));

    // DIRICHLET: Boom position based on angle controls (not cables)
    const boomSeg = cfg.main.mesh.chordSegments;
    const boomAngleRad = (cfg.main.boomAngleDeg || 0) * Math.PI / 180;
    const boomTiltRad = (cfg.main.boomTiltDeg || 0) * Math.PI / 180;
    const outhaulOffsetM = (cfg.main.outhaulMm || 0) / 1000;

    // Boom lies on a plane tilted by boomTiltDeg, rotated by boomAngleDeg around mast
    // At angle=0, boom points directly aft (-Y)
    // Positive angle rotates boom to starboard (+X direction)
    const boomNodeIds = new Array(boomSeg + 1);
    boomNodeIds[0] = tackNodeId;

    for (let j = 1; j <= boomSeg; j++) {
      const t = j / boomSeg;
      const dist = cfg.main.footLengthM * t + (j === boomSeg ? outhaulOffsetM : 0);
      // Horizontal projection
      const xProj = dist * Math.sin(boomAngleRad);
      const yProj = -dist * Math.cos(boomAngleRad);
      // Vertical offset from tilt
      const zOffset = dist * Math.sin(boomTiltRad);

      const boomX = xProj;
      const boomY = yProj;
      const boomZ = tackZSnap + zOffset;

      // DIRICHLET: Boom nodes are FIXED at their prescribed positions
      boomNodeIds[j] = addNode3d(model, `boom_${j}`, [boomX, boomY, boomZ], true);
    }

    // Boom bars for visualization (stiff, but nodes are fixed)
    for (let j = 0; j < boomSeg; j++) {
      const a = boomNodeIds[j];
      const b = boomNodeIds[j + 1];
      const L = dist3(model.nodes[a].p0, model.nodes[b].p0);
      addAxial(model, { name: `boom_seg_${j + 1}`, i: a, j: b, EA: boomEA, L0: L, kind: "bar" });
    }
    model.beams.push({
      name: "boom",
      nodeIds: boomNodeIds,
      ds: cfg.main.footLengthM / boomSeg,
      EI: boomEI
    });

    // NO mainsheet cable - position is controlled by Dirichlet BC (fixed boom nodes)
    // NO vang cable - vertical position is controlled by boomTiltDeg

    const chordStations = [
      { t: 0, v: cfg.main.footLengthM },
      { t: 0.25, v: SNIPE_RULES_M.sails.mainsail.quarterWidthM },
      { t: 0.5, v: SNIPE_RULES_M.sails.mainsail.halfWidthM },
      { t: 0.75, v: SNIPE_RULES_M.sails.mainsail.threeQuarterWidthM },
      { t: 1.0, v: SNIPE_RULES_M.sails.mainsail.topWidthM }
    ];

    const { grid, nRows, nCols } = buildSailGrid3d({
      model,
      namePrefix: "sail_main",
      luffNodeIds: luffNodes,
      chordStations,
      chordSegments: cfg.main.mesh.chordSegments,
      draftDepth: cfg.main.draftDepth,
      draftPos: effectiveDraftPos,
      draftDepthSections: cfg.main.draftDepthSections,
      draftPosSections: effectiveDraftPosSections,
      chordDirY: -1,
      useFootNodeIds: boomNodeIds
    });

    // ═══════════════════════════════════════════════════════════════════
    // MODELO DE MEMBRANA PARA VELA MAYOR
    // ═══════════════════════════════════════════════════════════════════
    const mainMembranes = createMembraneMesh(grid, {
      E: membraneMaterial.E,
      nu: membraneMaterial.nu,
      thickness: membraneMaterial.thickness,
      prestress: membraneMaterial.prestress,
      wrinklingEps: membraneMaterial.wrinklingEps,
      maxStrain: membraneMaterial.maxStrain
    });

    // Añadir membranas al modelo
    model.membranes = model.membranes || [];
    model.membranes.push(...mainMembranes);

    // Estabilización espúrea (bending stiffness proxy)
    addShapeSpringsForGrid3d({
      model,
      grid,
      kx: spuriousK,
      ky: spuriousK * 0.01,
      kz: spuriousK * 0.01,
      namePrefix: "stab_main"
    });

    model.sails.main = { gridNodeIds: grid, nRows, nCols, boomNodeIds, membraneCount: mainMembranes.length };
  }

  // --- JIB + STAY + SHEET ---
  if (cfg.jib.enabled) {
    const stay = model.axial.find((e) => e.name === "stay_jib");
    if (!stay) throw new Error("Sails enabled but model is missing stay_jib");

    model.axial = model.axial.filter((e) => e.name !== "stay_jib");

    const bowId = stay.i;
    const houndsId = stay.j;
    const bowFixed = model.nodes[bowId]?.fixed;
    const houndsFixed = model.nodes[houndsId]?.fixed;
    const stayTopId = bowFixed && !houndsFixed ? houndsId : houndsFixed && !bowFixed ? bowId : houndsId;
    const stayBottomId = bowFixed && !houndsFixed ? bowId : houndsFixed && !bowFixed ? houndsId : bowId;

    const pBottom = model.nodes[stayBottomId].p0;
    const pTop = model.nodes[stayTopId].p0;
    const Lbase = dist3(pBottom, pTop);
    const luffL = Math.min(cfg.jib.luffLengthM, Math.max(0.5, Lbase - 0.05));
    const tHead = clamp01(luffL / Math.max(1e-9, Lbase));

    const jibHeadP0 = [
      lerp(pBottom[0], pTop[0], tHead),
      lerp(pBottom[1], pTop[1], tHead),
      lerp(pBottom[2], pTop[2], tHead)
    ];

    const jibHeadNodeId = addNode3d(model, "jib_head", jibHeadP0, false);

    const luffSeg = cfg.jib.mesh.luffSegments;
    const luffNodeIds = new Array(luffSeg + 1);
    luffNodeIds[0] = stayBottomId;
    luffNodeIds[luffSeg] = jibHeadNodeId;
    for (let k = 1; k < luffSeg; k++) {
      const tt = k / luffSeg;
      const p0 = [
        lerp(pBottom[0], jibHeadP0[0], tt),
        lerp(pBottom[1], jibHeadP0[1], tt),
        lerp(pBottom[2], jibHeadP0[2], tt)
      ];
      luffNodeIds[k] = addNode3d(model, `jib_luff_${k}`, p0, false);
    }

    const stayNodeIds = [stayBottomId, ...luffNodeIds.slice(1)];
    if (cfg.jib.stayTopSegments > 1) {
      for (let k = 1; k < cfg.jib.stayTopSegments; k++) {
        const tt = k / cfg.jib.stayTopSegments;
        const p0 = [
          lerp(jibHeadP0[0], pTop[0], tt),
          lerp(jibHeadP0[1], pTop[1], tt),
          lerp(jibHeadP0[2], pTop[2], tt)
        ];
        stayNodeIds.push(addNode3d(model, `stay_top_${k}`, p0, false));
      }
    }
    stayNodeIds.push(stayTopId);

    let Lsum = 0;
    const segLens = [];
    for (let k = 0; k < stayNodeIds.length - 1; k++) {
      const a = stayNodeIds[k];
      const b = stayNodeIds[k + 1];
      const L = dist3(model.nodes[a].p0, model.nodes[b].p0);
      segLens.push(L);
      Lsum += L;
    }

    /**
     * CORRECCIÓN CRÍTICA: El stay SIEMPRE debe ser un cable elástico cuando hay velas.
     *
     * FÍSICA:
     * - El grátil del foque está cosido/enganchado al stay (forestay)
     * - Cuando el viento presiona la vela, el grátil "empuja" el stay
     * - El stay debe resistir este empuje con su rigidez EA
     * - Si usamos elementos "tension" (fuerza constante), no hay restricción de longitud
     *   y los nodos del grátil pueden moverse arbitrariamente
     *
     * CONVERSIÓN DE TENSION A CABLE:
     * - Si el stay original tenía tensión N, calculamos L0 para que:
     *   N = EA * (L - L0) / L0  →  L0 = L / (1 + N/EA)
     * - Esto garantiza que el cable tenga la tensión deseada en la posición inicial
     */
    /**
     * TENSIÓN MÍNIMA DEL STAY: 0.3 kN (300N)
     *
     * El stay debe tener suficiente tensión para:
     * 1. Proporcionar un borde de ataque estable para el foque
     * 2. Evitar que el grátil "pandee" bajo la presión del viento
     * 3. Mantener la geometría del aparejo
     *
     * 300N es aproximadamente el peso de 30 kg - suficiente para
     * mantener el cable tenso pero no excesivo para el aparejo.
     */
    const MIN_STAY_TENSION_N = 50; // Reducido a 50N para evitar colapso en fases iniciales (pretension baja)

    let L0ratio;
    if (stay.kind === "tension") {
      // Convertir tensión constante a cable elástico equivalente
      const tensionN = Math.max(0, Number.isFinite(stay.N) ? stay.N : 0);
      // L0 = L / (1 + N/EA) para obtener tensión N en longitud L
      const effectiveTension = Math.max(tensionN, MIN_STAY_TENSION_N);
      L0ratio = 1 / (1 + effectiveTension / rigEA);
    } else {
      // El stay ya era un cable, usar su L0 original pero garantizar tensión mínima
      const originalL0ratio = stay.L0 / Math.max(1e-9, Lsum);
      const minL0ratio = 1 / (1 + MIN_STAY_TENSION_N / rigEA);
      L0ratio = Math.min(originalL0ratio, minL0ratio); // Más corto = más tensión
    }
    // console.log(`DEBUG sailsPhase1: stay replacement. Kind=${stay.kind}, N=${stay.N}, L=${Lsum.toFixed(3)}, stay.L0=${stay.L0?.toFixed(3)}, ratio=${L0ratio.toFixed(6)}, L0calc=${(Lsum * L0ratio).toFixed(3)}`);




    // Crear segmentos de cable elástico para el stay
    for (let k = 0; k < stayNodeIds.length - 1; k++) {
      const a = stayNodeIds[k];
      const b = stayNodeIds[k + 1];
      const segL0 = segLens[k] * L0ratio;
      addAxial(model, {
        name: `stay_jib_seg_${k + 1}`,
        i: a,
        j: b,
        EA: rigEA,
        L0: segL0,
        kind: "cable",
        compressionEps: 0.01, // Baja rigidez en compresión (cable flojo)
        smoothDeltaM: 1e-4    // Transición suave
      });
    }

    const chordStations = [
      { t: 0, v: cfg.jib.footLengthM },
      { t: 0.5, v: SNIPE_RULES_M.sails.jib.halfWidthM },
      { t: 1.0, v: SNIPE_RULES_M.sails.jib.topWidthM }
    ];

    const { grid, nRows, nCols } = buildSailGrid3d({
      model,
      namePrefix: "sail_jib",
      luffNodeIds,
      chordStations,
      chordSegments: cfg.jib.mesh.chordSegments,
      draftDepth: cfg.jib.draftDepth,
      draftPos: cfg.jib.draftPos,
      draftDepthSections: cfg.jib.draftDepthSections,
      draftPosSections: cfg.jib.draftPosSections,
      chordDirY: -1,
      useFootNodeIds: null
    });

    // DIRICHLET: Mueve el puño de escota hacia el carro (sin cable)
    const jibClewId = grid[0][nCols];
    const clewP0 = model.nodes[jibClewId].p0;
    const leadX = Number.isFinite(cfg.jib.sheetLeadXMm)
      ? (cfg.jib.sheetSideSign || 0) * (cfg.jib.sheetLeadXMm / 1000)
      : (cfg.jib.sheetSideSign || 0) * Math.abs(geometry.chainplateXM ?? 0);
    const leadY = Number.isFinite(cfg.jib.sheetLeadYMm)
      ? (cfg.jib.sheetLeadYMm / 1000)
      : (geometry.chainplateYM ?? 0);
    const leadZ = geometry.partnersZM ?? 0;
    const vecToLead = [leadX - clewP0[0], leadY - clewP0[1], leadZ - clewP0[2]];
    const distLead = norm3(vecToLead) || 1e-9;
    const moveM = Math.min(distLead, Math.max(0, (cfg.jib.clewDisplaceMm || 0) / 1000));
    const tLead = moveM / distLead;
    model.nodes[jibClewId].p0 = [
      clewP0[0] + vecToLead[0] * tLead,
      clewP0[1] + vecToLead[1] * tLead,
      clewP0[2] + vecToLead[2] * tLead
    ];
    model.nodes[jibClewId].fixed = true;

    // ═══════════════════════════════════════════════════════════════════
    // MODELO DE MEMBRANA PARA FOQUE
    // ═══════════════════════════════════════════════════════════════════
    const jibMembranes = createMembraneMesh(grid, {
      E: membraneMaterial.E,
      nu: membraneMaterial.nu,
      thickness: membraneMaterial.thickness,
      prestress: membraneMaterial.prestress,
      wrinklingEps: membraneMaterial.wrinklingEps,
      maxStrain: membraneMaterial.maxStrain
    });

    // Añadir membranas al modelo
    model.membranes = model.membranes || [];
    model.membranes.push(...jibMembranes);

    // Estabilización espúrea (bending stiffness proxy)
    addShapeSpringsForGrid3d({
      model,
      grid,
      kx: spuriousK,
      ky: spuriousK * 0.01,
      kz: spuriousK * 0.01,
      namePrefix: "stab_jib"
    });

    model.sails.jib = { gridNodeIds: grid, nRows, nCols, stayNodeIds, membraneCount: jibMembranes.length };
  }

  // VALIDACIÓN FINAL: Asegurar que no hay posiciones locas
  for (const node of model.nodes) {
    if (!node.p0.every(v => Number.isFinite(v) && Math.abs(v) < 100)) {
      console.error(`FATAL ERROR: Node ${node.id} (${node.name}) has CRAZY p0: ${node.p0}`);
      // Intentar rastrear de dónde vino
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONFIGURAR PRESIÓN DE MEMBRANA (FOLLOWER LOAD)
  // ═══════════════════════════════════════════════════════════════════
  // La presión se aplica perpendicular a la superficie deformada
  // en cada iteración del solver (follower load)
  if (model.membranes && model.membranes.length > 0) {
    model.membranePressure = {
      value: effPressure,
      sign: cfg.windSign >= 0 ? -1 : 1  // Dirección según amura
    };
  }

  return model;
}

function sailGridPositions(gridNodeIds, nodesPos) {
  return gridNodeIds.map((row) => row.map((id) => {
    const p = nodesPos[id];
    return [p[0], p[1], p[2]];
  }));
}

module.exports = { applySailsPhase1ToModel3d, normalizeSailsConfig, sailGridPositions };
