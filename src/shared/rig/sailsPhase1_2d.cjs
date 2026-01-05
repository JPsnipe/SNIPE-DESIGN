const { SNIPE_RULES_M } = require("./snipeRules.cjs");
const { clamp, sub3, norm3 } = require("./math3.cjs");

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

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function triArea(a, b, c) {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const cr = cross3(ab, ac);
  return 0.5 * norm3(cr);
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

// NACA-like camber line with max camber m at position p (both normalized 0..1).
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
  // De-dup just in case rounding repeats
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
      draftDepth: 0.08,
      draftPos: 0.4,
      shapeSections: 4,
      draftDepthSections: [],
      draftPosSections: [],
      tackZM: null, // default: partnersZM
      luffLengthM: SNIPE_RULES_M.rig.mainsailLuffMastDistanceM.max,
      footLengthM: SNIPE_RULES_M.rig.boomOuterPointDistanceM.max,
      cunninghamMm: 0,
      boomAngleDeg: 0,
      boomTiltDeg: 0,
      outhaulMm: 0,
      sheetDeltaL0M: 0,
      sheetLeadXM: 0,
      sheetLeadYM: -1.8,
      sheetLeadZM: 0,
      outhaulDeltaL0M: 0,
      vangDeltaL0M: 0,
      mesh: { luffSegments: 12, chordSegments: 4 }
    },
    jib: {
      enabled: true,
      draftDepth: 0.07,
      draftPos: 0.35,
      shapeSections: 4,
      draftDepthSections: [],
      draftPosSections: [],
      luffLengthM: SNIPE_RULES_M.sails.jib.luffLengthM,
      footLengthM: SNIPE_RULES_M.sails.jib.footLengthM,
      clewDisplaceMm: 0,
      sheetDeltaL0M: 0,
      sheetSideSign: 0, // 0=centerline, +1=port, -1=stbd
      sheetLeadXM: null, // default: |chainplateXM|
      sheetLeadYM: null, // default: chainplateYM
      sheetLeadZM: 0,
      sheetLeadXMm: 400,
      sheetLeadYMm: -1800,
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
  out.main.cunninghamMm = clamp(Number(out.main.cunninghamMm ?? 0), 0, 100);
  out.main.boomAngleDeg = clamp(Number(out.main.boomAngleDeg ?? 0), 0, 90);
  out.main.boomTiltDeg = clamp(Number(out.main.boomTiltDeg ?? 0), -10, 30);
  out.main.outhaulMm = clamp(Number(out.main.outhaulMm ?? 0), -50, 100);
  out.main.sheetDeltaL0M = Math.max(0, Number(out.main.sheetDeltaL0M ?? 0));
  out.main.outhaulDeltaL0M = Math.max(0, Number(out.main.outhaulDeltaL0M ?? 0));
  out.main.sheetLeadXM = Number.isFinite(out.main.sheetLeadXM) ? out.main.sheetLeadXM : defaults.main.sheetLeadXM;
  out.main.sheetLeadYM = Number.isFinite(out.main.sheetLeadYM) ? out.main.sheetLeadYM : defaults.main.sheetLeadYM;
  out.main.sheetLeadZM = Number.isFinite(out.main.sheetLeadZM) ? out.main.sheetLeadZM : defaults.main.sheetLeadZM;
  out.main.vangDeltaL0M = Math.max(0, Number(out.main.vangDeltaL0M ?? 0));
  out.main.mesh = {
    luffSegments: Math.max(2, Math.trunc(out.main.mesh?.luffSegments ?? defaults.main.mesh.luffSegments)),
    chordSegments: clamp(Math.trunc(out.main.mesh?.chordSegments ?? defaults.main.mesh.chordSegments), 2, 6)
  };

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
  out.jib.clewDisplaceMm = clamp(Number(out.jib.clewDisplaceMm ?? 0), 0, 300);
  out.jib.sheetDeltaL0M = Math.max(0, Number(out.jib.sheetDeltaL0M ?? 0));
  out.jib.sheetSideSign = Number.isFinite(out.jib.sheetSideSign) ? Math.sign(out.jib.sheetSideSign) : defaults.jib.sheetSideSign;
  out.jib.sheetLeadXM = Number.isFinite(out.jib.sheetLeadXM) ? out.jib.sheetLeadXM : Math.abs(geometry.chainplateXM ?? 0);
  // Default jib sheet lead slightly aft of the clew's expected range
  out.jib.sheetLeadYM = Number.isFinite(out.jib.sheetLeadYM) ? out.jib.sheetLeadYM : -1.8;
  out.jib.sheetLeadZM = Number.isFinite(out.jib.sheetLeadZM) ? out.jib.sheetLeadZM : defaults.jib.sheetLeadZM;
  out.jib.sheetLeadXMm = clamp(Number(out.jib.sheetLeadXMm ?? defaults.jib.sheetLeadXMm), 0, 600);
  out.jib.sheetLeadYMm = clamp(Number(out.jib.sheetLeadYMm ?? defaults.jib.sheetLeadYMm), -2500, 0);
  out.jib.mesh = {
    luffSegments: Math.max(2, Math.trunc(out.jib.mesh?.luffSegments ?? defaults.jib.mesh.luffSegments)),
    chordSegments: clamp(Math.trunc(out.jib.mesh?.chordSegments ?? defaults.jib.mesh.chordSegments), 2, 6)
  };
  out.jib.stayTopSegments = Math.max(1, Math.trunc(out.jib.stayTopSegments ?? defaults.jib.stayTopSegments));

  return out;
}

function addNode(model, name, p0, fixed) {
  const id = model.nodes.length;
  model.nodes.push({ id, name, p0, fixed: Boolean(fixed) });
  model.forces[id] = model.forces[id] ?? [0, 0];
  return id;
}

function addAxial(model, e) {
  model.axial.push(e);
}

function buildSailGrid({
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
      row[j] = addNode(model, `${namePrefix}_${i}_${j}`, p0, false);
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

function applyPressureToGrid({
  model,
  grid,
  nRows,
  nCols,
  pressurePa,
  windSign
}) {
  const p = Math.max(0, pressurePa) * (windSign >= 0 ? 1 : -1);
  if (Math.abs(p) < 1e-12) return;

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

      const area1 = triArea(a, b, c);
      const area2 = triArea(a, c, d);

      const f1 = (p * area1) / 3;
      const f2 = (p * area2) / 3;

      // Apply along +x as reduced-order aerodynamic load.
      model.forces[aId][0] += f1 + f2;
      model.forces[bId][0] += f1;
      model.forces[cId][0] += f1 + f2;
      model.forces[dId][0] += f2;
    }
  }
}

function applySailsPhase1ToModel2d({ model, geometry, state, constants, sails }) {
  const cfg = normalizeSailsConfig(sails, geometry);
  if (!cfg.enabled) return model;

  const sailEA = constants.sailEA ?? 8e4;
  const rigEA = constants.rigEA ?? 1.2e8;
  const boomEA = constants.boomEA ?? 1.0e2;
  const clothCompressionEps = constants.clothCompressionEps ?? 0.1;
  const clothSmoothDeltaM = constants.clothSmoothDeltaM ?? 1e-3;
  const boomEI = constants.boomEI ?? 5000;

  model.sails = { cfg, main: null, jib: null };
  model.beams = [];

  // Effective pressure scales with the same load continuation ramp.
  const modeScale = state?.load?.mode === "downwind" ? 0.3 : 1.0;
  const effPressure = (state?.loadScale ?? 0) * cfg.windPressurePa * modeScale;

  // --- MAINSAIL + BOOM ---
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

    // Cunningham effect desplaza draft ligeramente hacia proa
    const cunninghamEffect = (cfg.main.cunninghamMm || 0) / 100 * 0.1;
    const effectiveDraftPos = clamp(cfg.main.draftPos - cunninghamEffect, 0.1, 0.9);
    const effectiveDraftPosSections = (cfg.main.draftPosSections || []).map((p) => clamp(p - cunninghamEffect, 0.1, 0.9));

    // Boom nodes (Dirichlet, controlados por ángulos/outhaul)
    const boomSeg = cfg.main.mesh.chordSegments;
    const boomAngleRad = (cfg.main.boomAngleDeg || 0) * Math.PI / 180;
    const boomTiltRad = (cfg.main.boomTiltDeg || 0) * Math.PI / 180;
    const outhaulOffsetM = (cfg.main.outhaulMm || 0) / 1000;
    const boomNodeIds = new Array(boomSeg + 1);
    boomNodeIds[0] = tackNodeId;
    for (let j = 1; j <= boomSeg; j++) {
      const t = j / boomSeg;
      const dist = cfg.main.footLengthM * t + (j === boomSeg ? outhaulOffsetM : 0);
      const xProj = dist * Math.sin(boomAngleRad);
      const yProj = -dist * Math.cos(boomAngleRad);
      const zOffset = dist * Math.sin(boomTiltRad);
      boomNodeIds[j] = addNode(model, `boom_${j}`, [xProj, yProj, tackZSnap + zOffset], true);
    }
    for (let j = 0; j < boomSeg; j++) {
      const a = boomNodeIds[j];
      const b = boomNodeIds[j + 1];
      const L = dist3(model.nodes[a].p0, model.nodes[b].p0);
      addAxial(model, { name: `boom_seg_${j + 1}`, i: a, j: b, EA: boomEA, L0: L, kind: "bar" });
    }
    // Add boom as a rigid beam
    model.beams.push({
      name: "boom",
      nodeIds: boomNodeIds,
      ds: cfg.main.footLengthM / boomSeg,
      EI: boomEI
    });

    const chordStations = [
      { t: 0, v: cfg.main.footLengthM },
      { t: 0.25, v: SNIPE_RULES_M.sails.mainsail.quarterWidthM },
      { t: 0.5, v: SNIPE_RULES_M.sails.mainsail.halfWidthM },
      { t: 0.75, v: SNIPE_RULES_M.sails.mainsail.threeQuarterWidthM },
      { t: 1.0, v: SNIPE_RULES_M.sails.mainsail.topWidthM }
    ];

    const { grid, nRows, nCols } = buildSailGrid({
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

    addGridCables({
      model,
      grid,
      nRows,
      nCols,
      namePrefix: "cloth_main",
      EA: sailEA,
      footEdgeDeltaTotalM: 0,
      compressionEps: clothCompressionEps,
      smoothDeltaM: clothSmoothDeltaM
    });

    applyPressureToGrid({
      model,
      grid,
      nRows,
      nCols,
      pressurePa: effPressure,
      windSign: cfg.windSign
    });

    model.sails.main = { gridNodeIds: grid, nRows, nCols };
  }

  // --- JIB + STAY + SHEET ---
  if (cfg.jib.enabled) {
    const stay = model.axial.find((e) => e.name === "stay_jib");
    if (!stay) throw new Error("Sails enabled but model is missing stay_jib");

    // Remove single-segment stay, replace with segmented stay to provide attachment points.
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

    const jibHeadNodeId = addNode(model, "jib_head", jibHeadP0, false);

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
      luffNodeIds[k] = addNode(model, `jib_luff_${k}`, p0, false);
    }

    // Optional segmented stay above jib head.
    const stayNodeIds = [stayBottomId, ...luffNodeIds.slice(1)];
    if (cfg.jib.stayTopSegments > 1) {
      for (let k = 1; k < cfg.jib.stayTopSegments; k++) {
        const tt = k / cfg.jib.stayTopSegments;
        const p0 = [
          lerp(jibHeadP0[0], pTop[0], tt),
          lerp(jibHeadP0[1], pTop[1], tt),
          lerp(jibHeadP0[2], pTop[2], tt)
        ];
        stayNodeIds.push(addNode(model, `stay_top_${k}`, p0, false));
      }
    }
    stayNodeIds.push(stayTopId);

    // Distribute L0 across segments based on initial geometry.
    let Lsum = 0;
    const segLens = [];
    for (let k = 0; k < stayNodeIds.length - 1; k++) {
      const a = stayNodeIds[k];
      const b = stayNodeIds[k + 1];
      const L = dist3(model.nodes[a].p0, model.nodes[b].p0);
      segLens.push(L);
      Lsum += L;
    }
    if (stay.kind === "tension") {
      const tensionN = Math.max(0, Number.isFinite(stay.N) ? stay.N : 0);
      for (let k = 0; k < stayNodeIds.length - 1; k++) {
        const a = stayNodeIds[k];
        const b = stayNodeIds[k + 1];
        addAxial(model, { name: `stay_jib_seg_${k + 1}`, i: a, j: b, N: tensionN, kind: "tension" });
      }
    } else {
      const ratio = stay.L0 / Math.max(1e-9, Lsum);
      for (let k = 0; k < stayNodeIds.length - 1; k++) {
        const a = stayNodeIds[k];
        const b = stayNodeIds[k + 1];
        addAxial(model, { name: `stay_jib_seg_${k + 1}`, i: a, j: b, EA: rigEA, L0: segLens[k] * ratio, kind: "cable" });
      }
    }

    const chordStations = [
      { t: 0, v: cfg.jib.footLengthM },
      { t: 0.5, v: SNIPE_RULES_M.sails.jib.halfWidthM },
      { t: 1.0, v: SNIPE_RULES_M.sails.jib.topWidthM }
    ];

    const { grid, nRows, nCols } = buildSailGrid({
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

    // DIRICHLET: mover puño de escota hacia el carro (sin cable de escota)
    const jibClewId = grid[0][nCols];
    const clewP0 = model.nodes[jibClewId].p0;
    const leadX = Number.isFinite(cfg.jib.sheetLeadXMm)
      ? (cfg.jib.sheetSideSign || 0) * (cfg.jib.sheetLeadXMm / 1000)
      : (cfg.jib.sheetSideSign || 0) * (Number.isFinite(cfg.jib.sheetLeadXM) ? cfg.jib.sheetLeadXM : Math.abs(geometry.chainplateXM ?? 0));
    const leadY = Number.isFinite(cfg.jib.sheetLeadYMm)
      ? (cfg.jib.sheetLeadYMm / 1000)
      : (Number.isFinite(cfg.jib.sheetLeadYM) ? cfg.jib.sheetLeadYM : (geometry.chainplateYM ?? 0));
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

    addGridCables({
      model,
      grid,
      nRows,
      nCols,
      namePrefix: "cloth_jib",
      EA: sailEA,
      footEdgeDeltaTotalM: 0,
      compressionEps: clothCompressionEps,
      smoothDeltaM: clothSmoothDeltaM
    });

    applyPressureToGrid({
      model,
      grid,
      nRows,
      nCols,
      pressurePa: effPressure,
      windSign: cfg.windSign
    });

    model.sails.jib = { gridNodeIds: grid, nRows, nCols, stayNodeIds };
  }

  return model;
}

function sailGridPositions(gridNodeIds, nodesPos) {
  return gridNodeIds.map((row) => row.map((id) => {
    const p = nodesPos[id];
    return [p[0], p[1], p[2]];
  }));
}

module.exports = { applySailsPhase1ToModel2d, normalizeSailsConfig, sailGridPositions };
