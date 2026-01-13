// 3D Model with full axial compression and P-Delta effects
const { buildPhase1Model3d } = require("./modelPhase1_3d.cjs");
const { solveEquilibrium3d, mastCurveFromModel } = require("./solverPhase1_3d.cjs");
const { applySailsPhase1ToModel3d, sailGridPositions } = require("./sailsPhase1_3d.cjs");

// Legacy 2D imports (kept for reference/fallback)
// const { buildPhase1Model2d } = require("./modelPhase1_2d.cjs");
// const { solveEquilibrium2d, mastCurveFromModel } = require("./solverPhase1_2d.cjs");
// const { applySailsPhase1ToModel2d, sailGridPositions } = require("./sailsPhase1_2d.cjs");

function assertFiniteNumber(v, name) {
  if (!Number.isFinite(v)) throw new Error(`Invalid ${name}: ${v}`);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Missing payload");
  const { geometry, controls, load, solver } = payload;
  if (!geometry || !controls || !load || !solver) throw new Error("Invalid payload shape");

  const requiredGeometry = [
    "mastLengthM",
    "partnersZM",
    "spreaderZM",
    "houndsZM",
    "chainplateXM",
    "chainplateYM",
    "bowYM"
  ];
  for (const key of requiredGeometry) assertFiniteNumber(geometry[key], `geometry.${key}`);

  const requiredControls = [
    "spreaderLengthM",
    "spreaderSweepAftM",
    "shroudDeltaL0PortM",
    "shroudDeltaL0StbdM",
    "jibHalyardTensionN",
    "partnersKx",
    "partnersKy"
  ];
  for (const key of requiredControls) assertFiniteNumber(controls[key], `controls.${key}`);

  for (const [k, v] of Object.entries(geometry)) assertFiniteNumber(v, `geometry.${k}`);
  for (const [k, v] of Object.entries(controls)) {
    if (k === "lockStayLength") continue;
    assertFiniteNumber(v, `controls.${k}`);
  }
  for (const [k, v] of Object.entries(solver)) {
    if (typeof v === "boolean") continue;
    if (k === "mastSegments" || k.endsWith("Steps") || k.endsWith("Iterations")) {
      if (!Number.isInteger(v)) throw new Error(`Invalid solver.${k}: ${v}`);
    } else {
      assertFiniteNumber(v, `solver.${k}`);
    }
  }
  if (!["none", "upwind", "downwind"].includes(load.mode)) throw new Error(`Invalid load.mode: ${load.mode}`);
  if (!["uniform", "triangular"].includes(load.qProfile)) throw new Error(`Invalid load.qProfile: ${load.qProfile}`);
  assertFiniteNumber(load.qLateralNpm, "load.qLateralNpm");

  // Optional sails module (Phase 1 extension)
  if (payload.sails !== undefined) {
    if (payload.sails === null || typeof payload.sails !== "object") throw new Error("Invalid sails: expected object");
    const s = payload.sails;
    if (s.windPressurePa !== undefined) assertFiniteNumber(s.windPressurePa, "sails.windPressurePa");
    if (s.windSign !== undefined) assertFiniteNumber(s.windSign, "sails.windSign");
    if (s.main && typeof s.main === "object") {
      const m = s.main;
      for (const k of [
        "draftDepth",
        "draftPos",
        "tackZM",
        "luffLengthM",
        "footLengthM",
        "sheetDeltaL0M",
        "sheetLeadXM",
        "sheetLeadYM",
        "sheetLeadZM",
        "outhaulDeltaL0M",
        "vangDeltaL0M"
      ]) {
        if (m[k] !== undefined) assertFiniteNumber(m[k], `sails.main.${k}`);
      }
    }
    if (s.jib && typeof s.jib === "object") {
      const j = s.jib;
      for (const k of [
        "draftDepth",
        "draftPos",
        "luffLengthM",
        "footLengthM",
        "sheetDeltaL0M",
        "sheetSideSign",
        "sheetLeadXM",
        "sheetLeadYM",
        "sheetLeadZM",
        "stayTopSegments"
      ]) {
        if (j[k] !== undefined) assertFiniteNumber(j[k], `sails.jib.${k}`);
      }
    }
  }
}

function zeros(n) {
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = 0;
  return x;
}

function mergeForces3(forcesA, forcesB, nNodes) {
  const n = Math.max(0, Math.trunc(nNodes ?? 0));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = forcesA?.[i] || [];
    const b = forcesB?.[i] || [];
    out[i] = [
      (a[0] || 0) + (b[0] || 0),
      (a[1] || 0) + (b[1] || 0),
      (a[2] || 0) + (b[2] || 0)
    ];
  }
  return out;
}

function buildConstants() {
  // Valores típicos para mástil de Snipe (Selden C060, aluminio 6061-T6)
  // E = 70 GPa, A ≈ 450 mm² → EA ≈ 31.5 MN
  // I ≈ 10.7 cm⁴ (fore/aft) → EI ≈ 7500 N·m²
  return {
    mastEA: 1.0e7,       // Rigidez axial del mástil para solver (N) - reducida para condicionamiento
    mastEA_real: 3.0e7,  // Rigidez axial REAL del mástil (N) - E*A = 70GPa * 450mm²
    boomEA: 1.0e7,       // Botavara axial (N)
    mastEI: 7500,        // Rigidez a flexión del mástil (N·m²) - valor referencia
    spreaderEA: 1.0e8,   // Rigidez de spreaders (ajustada para estabilidad numérica)
    rigEA: 1.2e8,        // Rigidez de cables (obenques, forestay) - acero 3mm: E*A ≈ 1.4e8 N

    // ═══════════════════════════════════════════════════════════════════
    // PARÁMETROS DE FÍSICA DE VELAS
    // ═══════════════════════════════════════════════════════════════════

    // Rigidez de la tela de vela (cables entre nodos de la malla)
    sailEA: 8e4,         // N - Rigidez axial de la tela

    // Resortes de forma (mantienen el draft diseñado bajo presión)
    // kx: perpendicular a la vela (más importante)
    // ky: dirección de la cuerda (menor, permite estiramiento)
    // kz: vertical (menor, permite movimiento con el mástil)
    sailShapeKx: 1000,   // N/m - Valor base (ahora se calcula dinámicamente en sailsPhase1_3d)
    sailShapeKy: 10,     // N/m - Valor residual
    sailShapeKz: 10,     // N/m - Valor residual

    // Comportamiento de cables de tela bajo compresión
    clothCompressionEps: 0.1,   // Rigidez residual cuando el cable está flojo (10%)
    clothSmoothDeltaM: 1e-3,    // Banda de transición suave (1mm)

    // ═══════════════════════════════════════════════════════════════════
    // PARÁMETROS DE MEMBRANA CST (Constant Strain Triangle)
    // ═══════════════════════════════════════════════════════════════════
    // Dacron tela de vela: E efectivo ~50-100 MPa (no el E de la fibra!)
    // La fibra pura tiene E~2-4 GPa, pero la tela tejida es mucho más flexible
    membraneE: 5e7,              // 50 MPa - Módulo de Young efectivo de tela de vela
    membraneNu: 0.3,             // Coeficiente de Poisson
    membraneThickness: 0.00025,  // 0.25 mm - Espesor típico
    membranePretensionFraction: 0.05,  // 5% de la tensión de equilibrio (reducido para mejor convergencia)
    membraneWrinklingEps: 1e-4,  // Rigidez residual en compresión (wrinkling)
    membraneCurvatureRadius: 1.5 // Radio de curvatura esperado (m)
  };
}

/**
 * Calcula el equilibrio sumando todas las fuerzas y reacciones.
 * 
 * FÍSICA DEL EQUILIBRIO:
 * El sistema está en equilibrio cuando: ΣF_externas + ΣR_reacciones = 0
 * 
 * Fuerzas externas:
 * - Cargas de viento sobre el mástil (laterales, X)
 * 
 * Reacciones:
 * - Chainplates: Tensión de obenques (principalmente lateral y vertical)
 * - Bow: Tensión del forestay (hacia proa)
 * - Partners: Resorte en cubierta (solo X-Y)
 * - Mast Step: Reacción en el pie del palo (X/Y por balance global; Z por equilibrio axial no modelado en 2D)
 */
function computeEquilibrium(reactions, springsForces, appliedForces) {
  // ═══════════════════════════════════════════════════════════════════
  // CARGAS EXTERNAS (Viento)
  // ═══════════════════════════════════════════════════════════════════
  let extFx = 0, extFy = 0, extFz = 0;
  for (const f of appliedForces || []) {
    extFx += f[0] || 0;
    extFy += f[1] || 0;
    extFz += f[2] || 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // REACCIONES DE APOYO (Lo que el mundo exterior hace sobre el palo)
  // ═══════════════════════════════════════════════════════════════════

  // 1. Cables (Chainplates y Bow):
  // El solver calcula la fuerza del cable SOBRE el punto fijo.
  // La reacción SOBRE el mástil es la opuesta a la que llega al chainplate.
  // Sin embargo, en el solverPhase1_2d, 'reactions' ya contiene la suma de 
  // fuerzas de los elementos sobre los nodos fijos.
  // Para el equilibrio del mástil, sumamos las fuerzas que los cables hacen
  // en los nodos móviles, pero es más fácil sumar las reacciones en apoyos
  // y ver si equilibran el viento.
  let reactFx = 0, reactFy = 0, reactFz = 0;
  for (const [name, r] of Object.entries(reactions || {})) {
    // Estas son fuerzas del palo/jarcia SOBRE el apoyo.
    // La reacción del APOYO sobre el sistema es -r.
    reactFx -= r[0] || 0;
    reactFy -= r[1] || 0;
    reactFz -= r[2] || 0;
  }

  // 2. Partners (Resortes):
  // El solver reporta springsForces[name] = {fx: k*u, fy: k*u}
  // Esta es la fuerza que el mástil hace sobre la cubierta.
  // La reacción de la CUBIERTA sobre el mástil es -sf.
  let partnersFx = 0, partnersFy = 0;
  for (const sf of Object.values(springsForces || {})) {
    partnersFx -= sf.fx || 0;
    partnersFy -= sf.fy || 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // BALANCE FINAL
  // ═══════════════════════════════════════════════════════════════════
  const sumFx = extFx + reactFx + partnersFx;
  const sumFy = extFy + reactFy + partnersFy;
  const sumFz = extFz + reactFz; // Debería ser ~0 si el solver converge axialmente

  const magnitude = Math.sqrt(sumFx * sumFx + sumFy * sumFy + sumFz * sumFz);
  const isBalanced = magnitude < 20.0; // Tolerancia algo mayor para visualización

  // Extraer valores específicos para el reporte UI
  const mastStep = reactions["mast_step"] || [0, 0, 0];

  return {
    externalFx: extFx,
    externalFy: extFy,
    reactionsRx: reactFx - (-mastStep[0]), // Reacciones de cables solamente (aprox)
    reactionsRy: reactFy - (-mastStep[1]),
    partnersRx: partnersFx,
    partnersRy: partnersFy,
    mastStepRx: -mastStep[0],
    mastStepRy: -mastStep[1],
    mastStepRz: -mastStep[2],
    sumFx,
    sumFy,
    sumFz,
    magnitude,
    isBalanced
  };
}

function computeEquilibriumClosed({ nodes, reactions, springsForces, appliedForces }) {
  const extTotal = [0, 0, 0];
  const extFixed = [0, 0, 0];

  const fixedByName = new Map();
  for (const node of nodes || []) {
    if (node?.fixed) fixedByName.set(node.name, node.id);
  }

  for (let i = 0; i < (appliedForces || []).length; i++) {
    const f = appliedForces[i] || [];
    extTotal[0] += f[0] || 0;
    extTotal[1] += f[1] || 0;
    extTotal[2] += f[2] || 0;
  }

  for (const [, nodeId] of fixedByName.entries()) {
    const f = appliedForces?.[nodeId] || [];
    extFixed[0] += f[0] || 0;
    extFixed[1] += f[1] || 0;
    extFixed[2] += f[2] || 0;
  }

  // Muelles a tierra (force on structure): R_spring = -k*u
  const springSupport = [0, 0, 0];
  for (const sf of Object.values(springsForces || {})) {
    springSupport[0] -= sf.fx || 0;
    springSupport[1] -= sf.fy || 0;
    springSupport[2] -= sf.fz || 0;
  }

  // Reacciones de apoyos fijos (sin mast_step), sobre la estructura.
  // El solver reporta `reactions[name]` como contribuciA3n interna en el nodo fijo (K*u).
  // Para obtener la reacciA3n del apoyo SOBRE la estructura (R = internal - applied),
  // restamos las fuerzas aplicadas en nodos fijos.
  let reactionsRx = 0, reactionsRy = 0, reactionsRz = 0;
  for (const [name, nodeId] of fixedByName.entries()) {
    if (name === "mast_step") continue;
    const internal = reactions?.[name] || [0, 0, 0];
    const applied = appliedForces?.[nodeId] || [0, 0, 0];
    reactionsRx += (internal[0] || 0) - (applied[0] || 0);
    reactionsRy += (internal[1] || 0) - (applied[1] || 0);
    reactionsRz += (internal[2] || 0) - (applied[2] || 0);
  }

  // Mast step: reacciA3n real del solver (si existe)
  const mastStepInternal = reactions?.mast_step || [0, 0, 0];
  const mastStepNodeId = fixedByName.get("mast_step");
  const mastStepApplied =
    mastStepNodeId !== undefined ? (appliedForces?.[mastStepNodeId] || [0, 0, 0]) : [0, 0, 0];
  const mastStepRxActual = (mastStepInternal[0] || 0) - (mastStepApplied[0] || 0);
  const mastStepRyActual = (mastStepInternal[1] || 0) - (mastStepApplied[1] || 0);
  const mastStepRzActual = (mastStepInternal[2] || 0) - (mastStepApplied[2] || 0);

  // Residual "abierto" (usa el mast_step real del solver)
  const openSumFx = extTotal[0] + springSupport[0] + reactionsRx + mastStepRxActual;
  const openSumFy = extTotal[1] + springSupport[1] + reactionsRy + mastStepRyActual;
  const openSumFz = extTotal[2] + springSupport[2] + reactionsRz + mastStepRzActual;
  const openMagnitude = Math.sqrt(
    openSumFx * openSumFx + openSumFy * openSumFy + openSumFz * openSumFz
  );
  const openIsBalanced = openMagnitude < 10.0;

  // Mast step: cierre del equilibrio global (estable para UI/tests)
  const mastStepRx = -(extTotal[0] + springSupport[0] + reactionsRx);
  const mastStepRy = -(extTotal[1] + springSupport[1] + reactionsRy);
  const mastStepRz = -(extTotal[2] + springSupport[2] + reactionsRz);

  const sumFx = extTotal[0] + springSupport[0] + reactionsRx + mastStepRx;
  const sumFy = extTotal[1] + springSupport[1] + reactionsRy + mastStepRy;
  const sumFz = extTotal[2] + springSupport[2] + reactionsRz + mastStepRz;
  const magnitude = Math.sqrt(sumFx * sumFx + sumFy * sumFy + sumFz * sumFz);
  const isBalanced = magnitude < 10.0;

  // Partners: solo el muelle del pasacubierta (si existe)
  const partnersInternal = springsForces?.partners_spring || { fx: 0, fy: 0, fz: 0 };
  const partnersRx = -(partnersInternal.fx || 0);
  const partnersRy = -(partnersInternal.fy || 0);
  const partnersRz = -(partnersInternal.fz || 0);

  return {
    externalFx: extTotal[0],
    externalFy: extTotal[1],
    externalFz: extTotal[2],
    externalFixedFx: extFixed[0],
    externalFixedFy: extFixed[1],
    externalFixedFz: extFixed[2],
    reactionsRx,
    reactionsRy,
    reactionsRz,
    partnersRx,
    partnersRy,
    partnersRz,
    mastStepRx,
    mastStepRy,
    mastStepRz,
    sumFx,
    sumFy,
    sumFz,
    magnitude,
    isBalanced,
    openSumFx,
    openSumFy,
    openSumFz,
    openMagnitude,
    openIsBalanced,
    mastStepRxActual,
    mastStepRyActual,
    mastStepRzActual
  };
}

function solveSegregated3d({ model, solver, x0, prevModel }) {
  // ADAPTIVE FSI:
  // If loadScale is negligible (pretension phase), feedback from sail to rig is minimal.
  // One iteration is enough to update the sail shape to the mast, without needing back-and-forth convergence.
  // Only use full FSI iterations when significant wind load is present.
  const isLoaded = (model.membranePressure?.value && Math.abs(model.membranePressure.value) > 1e-3);
  const nFsi = isLoaded ? (solver.fsiIterations || 3) : 1;

  let x = x0;
  let lastResult = null;

  // Guardar una "snapshot" del modelo con flags originales para el mapeo de DOFs
  // Esto es necesario porque vamos a modificar temporalmente los flags fixed
  const modelSnapshot = {
    nodes: model.nodes.map(n => ({ ...n, fixed: n.fixed }))
  };

  // ═══════════════════════════════════════════════════════════════════
  // CLASIFICACIÓN DE NODOS PARA FSI SEGREGADO
  // ═══════════════════════════════════════════════════════════════════
  //
  // NODOS DE RIG (resueltos en Fase A):
  //   - mast_node_* : Nodos del mástil
  //   - spreader_* : Spreaders
  //   - chainplate_*, bow_fitting, mast_step : Apoyos (siempre fijos)
  //
  // NODOS DE VELA (resueltos en Fase B):
  //   - sail_main_*, sail_jib_* : Nodos internos de membrana
  //   - boom_* : Nodos de la botavara (Dirichlet, siempre fijos)
  //
  // NODOS DE INTERFAZ (libres en ambas fases):
  //   - jib_luff_* : Grátil del foque (conecta stay con vela)
  //   - jib_head : Cabeza del foque
  //   - stay_top_* : Segmentos superiores del stay
  //
  // ═══════════════════════════════════════════════════════════════════

  const isRigNode = (node) =>
    node.name.includes("mast_node_") ||
    node.name.includes("spreader_") ||
    node.name.includes("shroud_") ||
    node.name.includes("chainplate") ||
    node.name === "bow_fitting" ||
    node.name === "mast_step";

  const isSailInternalNode = (node) =>
    (node.name.startsWith("sail_main_") || node.name.startsWith("sail_jib_")) &&
    !node.name.includes("_0_");  // Excluir nodos del grátil (columna 0)

  const isInterfaceNode = (node) =>
    node.name === "jib_head" ||
    node.name.startsWith("jib_luff_") ||
    node.name.startsWith("stay_top_") ||
    node.name.startsWith("stay_jib_");

  const originalFixed = model.nodes.map(n => n.fixed);

  // Clone solver config to force specific sub-solvers
  // Para la fase de rig, dejamos que el solver elija (usará DR si hay membranas, lo cual es más seguro)
  // Para la fase de vela, forzamos DR para estabilidad
  const solverRig = {
    ...solver,
    // useDynamicRelaxation: false, // COMENTADO: Newton puede ser inestable con membranas conectadas (slack)
    maxIterations: Math.min(solver.maxIterations, 300)
  };
  const solverSail = {
    ...solver,
    useDynamicRelaxation: true,
    drMaxIterations: Math.max(200, (solver.drMaxIterations || 1000) / nFsi),
    drMaxStepM: solver.drMaxStepM ?? 0.005
  };

  for (let iter = 0; iter < nFsi; iter++) {
    // ═══════════════════════════════════════════════════════════════════
    // FASE A: Resolver Mástil y Jarcia (fijando nodos interiores de vela)
    // ═══════════════════════════════════════════════════════════════════
    for (let j = 0; j < model.nodes.length; j++) {
      const node = model.nodes[j];
      if (isSailInternalNode(node)) {
        // Fijar nodos interiores de la vela
        node.fixed = true;
      } else {
        // Restaurar estado original para rig y nodos de interfaz
        node.fixed = originalFixed[j];
      }
    }

    // Usar el modelo snapshot (con flags originales) como referencia para el mapeo
    // En la primera iteración, si tenemos prevModel de la fase anterior, usarlo
    const effectivePrevModel = (iter === 0 && prevModel) ? prevModel : modelSnapshot;
    const resRig = solveEquilibrium3d({ model, solver: solverRig, x0: x, prevModel: effectivePrevModel });
    if (resRig.x && resRig.x.every(Number.isFinite)) {
      x = resRig.x;
      lastResult = resRig;
    } else {
      console.warn(`FSI iter ${iter}: Rig phase produced NaN, keeping previous state`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // FASE B: Resolver Velas (fijando el mástil)
    // ═══════════════════════════════════════════════════════════════════
    for (let j = 0; j < model.nodes.length; j++) {
      const node = model.nodes[j];
      if (isRigNode(node) && !originalFixed[j]) {
        // Fijar nodos del rig que no estaban fijos originalmente
        node.fixed = true;
      } else {
        // Restaurar estado original para vela
        node.fixed = originalFixed[j];
      }
    }

    // Usar modelSnapshot para el mapeo (tiene los mismos nodos con flags originales)
    const resSail = solveEquilibrium3d({ model, solver: solverSail, x0: x, prevModel: modelSnapshot });
    if (resSail.x && resSail.x.every(Number.isFinite)) {
      x = resSail.x;
      lastResult = resSail;
    } else {
      console.warn(`FSI iter ${iter}: Sail phase produced NaN, keeping previous state`);
    }
  }

  // Restaurar estados originales
  for (let j = 0; j < model.nodes.length; j++) {
    model.nodes[j].fixed = originalFixed[j];
  }

  return {
    ...lastResult,
    model,
    meta: lastResult.meta
  };
}

function solveOneState({ geometry, controls, solver, state, constants, x0, prevModel }) {
  let model = buildPhase1Model3d({ geometry, controls, solver, state, constants });
  if (state?.sails?.enabled) {
    model = applySailsPhase1ToModel3d({
      model,
      geometry,
      state,
      constants,
      sails: state.sails
    });
  }

  // Usar estrategia segregada si es la fase de carga y está activada
  if (state?.loadScale > 0.05 && solver.useSegregatedFSI) {
    return solveSegregated3d({ model, solver, x0, prevModel });
  }

  const out = solveEquilibrium3d({ model, solver, x0, prevModel });
  return {
    ...out,
    model,
    meta: out.meta
  };
}

function runContinuationPhase({
  geometry,
  controls,
  solver,
  constants,
  phase,
  xStart,
  baseState,
  prevModelStart
}) {
  const history = [];
  let x = xStart;
  let prevModel = prevModelStart;
  let lambda = 0;
  let step = 1 / Math.max(1, phase.steps);
  const initialStep = step;
  const minStep = 1 / 512;

  while (lambda < 1 - 1e-12) {
    const target = Math.min(1, lambda + step);
    const state = phase.stateFn(target, baseState);

    let solved = solveOneState({
      geometry,
      controls,
      solver,
      state,
      constants,
      x0: x,
      prevModel
    });

    history.push({
      phase: phase.name,
      lambda: target,
      converged: solved.converged,
      iterations: solved.iterations,
      gradInf: solved.gradInf,
      reason: solved.reason ?? null,
      convergenceHistory: solved.convergenceHistory
    });

    if (solved.converged) {
      // Verificar NaN en el vector de desplazamientos
      if (solved.x.some(v => !Number.isFinite(v))) {
        return { ok: false, x, history, failedAt: target, last: { ...solved, converged: false, reason: "numerical_instability_nan" }, prevModel: solved.model };
      }
      // If we've already had to reduce the continuation step, avoid accepting
      // a "zero-iteration" convergence (typically just below tolerance) because
      // it can freeze the state and prevent crossing tension-only transitions.
      if (step < initialStep && solved.iterations === 0) {
        const polishSolver = {
          ...solver,
          toleranceN: solver.toleranceN * 0.25,
          maxIterations: Math.max(solver.maxIterations, 600)
        };
        const polished = solveOneState({
          geometry,
          controls,
          solver: polishSolver,
          state,
          constants,
          x0: x,
          prevModel
        });
        if (polished.converged && polished.gradInf < solved.gradInf) {
          solved = polished;
          const last = history[history.length - 1];
          last.iterations += polished.iterations;
          last.gradInf = polished.gradInf;
          last.reason = polished.reason ?? null;
          last.polished = true;
        }
      }

      x = solved.x;
      prevModel = solved.model;
      lambda = target;
      continue;
    }

    step *= 0.5;
    if (step < minStep) {
      return { ok: false, x, history, failedAt: target, last: solved, prevModel: solved.model };
    }
  }

  const finalState = phase.stateFn(1, baseState);
  const final = solveOneState({
    geometry,
    controls,
    solver,
    state: finalState,
    constants,
    x0: x,
    prevModel
  });

  return { ok: final.converged, x: final.x, history, last: final, prevModel: final.model };
}

function runPhase1Simulation(payload) {
  validatePayload(payload);

  // Construir constants con valores por defecto, pero usando stiffness del payload si existe
  // Valores típicos Snipe (Selden C060, aluminio 6061-T6):
  // - EI base: ~7500 N·m² (sección constante, E=70GPa, I≈10.7cm⁴)
  // - EI top: ~3500 N·m² (punta cónica, reducción ~50%)
  // - Conicidad: empieza sobre intersección stays SCIRA (~4.5m desde pie)
  const stiffness = payload.stiffness || {};
  const constants = {
    ...buildConstants(),
    // Sobrescribir EI con valores del payload (para conicidad)
    mastEI: stiffness.mastEIBase || 7500,       // Valor base (se usará como referencia)
    mastEIBase: stiffness.mastEIBase || 7500,   // EI sección inferior
    mastEITop: stiffness.mastEITop || 3500,     // EI sección superior (más flexible)
    taperStartZM: stiffness.taperStartZM || 4.5, // Altura donde empieza la conicidad (SCIRA)
    boomEA: stiffness.boomEA || 1.0e2           // Botavara axial
  };
  const solverInput = payload.solver || {};
  if (Number.isFinite(solverInput.membranePrestress)) {
    constants.membranePrestress = solverInput.membranePrestress;
  }
  if (Number.isFinite(solverInput.membranePretensionFraction)) {
    constants.membranePretensionFraction = solverInput.membranePretensionFraction;
  }
  if (Number.isFinite(solverInput.membraneCurvatureRadius)) {
    constants.membraneCurvatureRadius = solverInput.membraneCurvatureRadius;
  }
  if (Number.isFinite(solverInput.membraneWrinklingEps)) {
    constants.membraneWrinklingEps = solverInput.membraneWrinklingEps;
  }
  if (Number.isFinite(solverInput.membraneMaxStrain)) {
    constants.membraneMaxStrain = solverInput.membraneMaxStrain;
  }

  const geometry = payload.geometry;
  const controls = payload.controls;
  const load = payload.load;
  const sails = payload.sails && typeof payload.sails === "object" ? payload.sails : null;

  const solver = {
    mastSegments: payload.solver.mastSegments,
    // If sails are enabled, we force cableSegments=1 for the rig base model
    // because sailsPhase1 will re-discretize the stay/shrouds to match sail nodes.
    // This avoids "missing stay_jib" errors or double discretization.
    cableSegments: (sails?.enabled) ? 1 : (payload.solver.cableSegments ?? 1),
    pretensionSteps: payload.solver.pretensionSteps,
    loadSteps: payload.solver.loadSteps,
    maxIterations: payload.solver.maxIterations,
    toleranceN: payload.solver.toleranceN,
    cableCompressionEps: payload.solver.cableCompressionEps,
    // Damping alto para velas: permite convergencia gradual con muchos DOFs
    sailDamping: payload.solver.sailDamping ?? 10.0,
    sailDampingDecay: payload.solver.sailDampingDecay ?? 0.98,
    // DR stabilization controls (optional)
    drTimeStep: payload.solver.drTimeStep,
    drViscousDamping: payload.solver.drViscousDamping,
    drWarmupIters: payload.solver.drWarmupIters,
    drKineticBacktrack: payload.solver.drKineticBacktrack,
    drMaxStepM: payload.solver.drMaxStepM,
    drStabilityFactor: payload.solver.drStabilityFactor,
    drMassSafety: payload.solver.drMassSafety,
    pressureRampIters: payload.solver.pressureRampIters,
    drMaxIterations: payload.solver.drMaxIterations,
    drNewtonFallbackAfter: payload.solver.drNewtonFallbackAfter,
    drHighPrecisionTol: payload.solver.drHighPrecisionTol,
    useSegregatedFSI: payload.solver.useSegregatedFSI ?? true,
    fsiIterations: payload.solver.fsiIterations ?? 3
  };

  const baseState = { standingScale: 0, halyardScale: 0, loadScale: 0, load, sails };
  let baseModel = buildPhase1Model3d({
    geometry,
    controls,
    solver,
    state: baseState,
    constants
  });
  if (sails?.enabled) {
    baseModel = applySailsPhase1ToModel3d({ model: baseModel, geometry, state: baseState, constants, sails });
  }
  // 3 DOF per node (x, y, z) instead of 2
  let x = zeros((baseModel.nodes.filter((n) => !n.fixed).length) * 3);

  const initialState = { standingScale: 0, halyardScale: 0, loadScale: 0, load: payload.load, sails };
  let initialModel = buildPhase1Model3d({
    geometry,
    controls,
    solver,
    state: initialState,
    constants
  });
  if (sails?.enabled) {
    initialModel = applySailsPhase1ToModel3d({ model: initialModel, geometry, state: initialState, constants, sails });
  }
  const relaxedCurve = mastCurveFromModel(initialModel, initialModel.nodes.map(n => n.p0));
  const relaxedSails = initialModel.sails
    ? {
      main: initialModel.sails.main ? sailGridPositions(initialModel.sails.main.gridNodeIds, initialModel.nodes.map(n => n.p0)) : null,
      jib: initialModel.sails.jib ? sailGridPositions(initialModel.sails.jib.gridNodeIds, initialModel.nodes.map(n => n.p0)) : null
    }
    : null;

  const allHistory = [];
  let prebendCurve = null;
  let loadedCurve = null;
  let prebendSails = null;
  let loadedSails = null;
  let lastSolve = null;
  let completedAllPhases = true;

  // Las velas participan desde el inicio, pero su pretensión de membrana
  // es proporcional a loadScale (ver sailsPhase1_3d.cjs)
  const phases = [
    {
      name: "standing_pretension",
      steps: solver.pretensionSteps,
      stateFn: (lambda, base) => ({
        standingScale: lambda,
        halyardScale: 0,
        loadScale: 0,
        load: base.load,
        sails
      })
    },
    {
      name: "jib_halyard",
      steps: solver.pretensionSteps,
      stateFn: (lambda, base) => ({
        standingScale: 1,
        halyardScale: lambda,
        loadScale: 0,
        load: base.load,
        sails
      })
    },
    {
      name: "sailing_load",
      steps: solver.loadSteps,
      stateFn: (lambda, base) => ({
        standingScale: 1,
        halyardScale: 1,
        loadScale: lambda,
        load: base.load,
        sails
      })
    }
  ];

  let prevModel = baseModel;
  for (const phase of phases) {
    const r = runContinuationPhase({
      geometry,
      controls,
      solver,
      constants,
      phase,
      xStart: x,
      baseState,
      prevModelStart: prevModel
    });
    allHistory.push(...r.history);
    if (!r.ok) {
      lastSolve = r.last; // Actualizar con el último estado parcial
      prevModel = r.prevModel || prevModel;
      completedAllPhases = false;
      break;
    }

    x = r.x;
    lastSolve = r.last;
    prevModel = r.prevModel || lastSolve.model;

    if (phase.name === "jib_halyard") {
      prebendCurve = mastCurveFromModel(lastSolve.model, lastSolve.meta.nodesPos);
      if (lastSolve.model.sails) {
        prebendSails = {
          main: lastSolve.model.sails.main ? sailGridPositions(lastSolve.model.sails.main.gridNodeIds, lastSolve.meta.nodesPos) : null,
          jib: lastSolve.model.sails.jib ? sailGridPositions(lastSolve.model.sails.jib.gridNodeIds, lastSolve.meta.nodesPos) : null
        };
      }
    }
  }

  // Si falló pero tenemos un 'lastSolve', intentamos extraer lo que haya para el reporte
  if (!lastSolve) {
    return { ok: false, converged: false, outputs: null, inputs: payload, reason: "no_initial_solve" };
  }

  // Funcion auxiliar para extraer tension de cable
  // En el solver, los cables tension-only pueden devolver N<0 por la regularización
  // (rigidez residual en compresión). Para reporte físico: tension = max(0, N).
  const getCableTension = (n) => {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, n);
  };
  const getAxialMag = (n) => {
    if (!Number.isFinite(n)) return 0;
    return Math.abs(n);
  };

  const axial = lastSolve.meta.axialForces || {};
  // DEBUG: log shroud tensions
  // console.log('DEBUG axial shroud_port:', axial.shroud_port, 'shroud_stbd:', axial.shroud_stbd);
  const getTension = (prefix) => {
    if (Number.isFinite(axial[prefix])) return getCableTension(axial[prefix]);
    const segs = Object.entries(axial)
      .filter(([k]) => k.includes(prefix) && k.includes("_seg_"))
      .map(([, v]) => v)
      .filter(Number.isFinite);
    return segs.length ? Math.max(0, ...segs.map(getCableTension)) : 0;
  };

  const shPort = getTension("shroud_port");
  const shStbd = getTension("shroud_stbd");
  const stayJibN = getTension("stay_jib");

  const curLoadedCurve = mastCurveFromModel(lastSolve.model, lastSolve.meta.nodesPos);
  let curLoadedSails = null;
  if (lastSolve.model.sails) {
    curLoadedSails = {
      main: lastSolve.model.sails.main ? sailGridPositions(lastSolve.model.sails.main.gridNodeIds, lastSolve.meta.nodesPos) : null,
      jib: lastSolve.model.sails.jib ? sailGridPositions(lastSolve.model.sails.jib.gridNodeIds, lastSolve.meta.nodesPos) : null
    };
  }

  const getCurveByPrefix = (prefix) => {
    const nodes = lastSolve.model.nodes;
    const pos = lastSolve.meta.nodesPos;
    const filtered = nodes
      .filter(n => n.name.includes(prefix) && n.name.includes("_node_"))
      .map(n => ({
        name: n.name,
        p: pos[n.id]
      }));
    filtered.sort((a, b) => {
      // Ordenar por tramo (up antes que low si aplica) y luego por número
      if (a.name.includes("_up_") && b.name.includes("_low_")) return -1;
      if (a.name.includes("_low_") && b.name.includes("_up_")) return 1;
      const ma = a.name.match(/\d+$/);
      const mb = b.name.match(/\d+$/);
      if (ma && mb) return parseInt(ma[0]) - parseInt(mb[0]);
      return a.name.localeCompare(b.name);
    });
    return filtered.map(f => ({ name: f.name, x: f.p[0], y: f.p[1], z: f.p[2] }));
  };

  const outputs = {
    mastCurveRelaxed: relaxedCurve ?? [],
    mastCurvePrebend: prebendCurve ?? [],
    mastCurveLoaded: curLoadedCurve ?? [],
    cableCurves: {
      shroud_port: getCurveByPrefix("shroud_port"),
      shroud_stbd: getCurveByPrefix("shroud_stbd"),
      stay_jib: getCurveByPrefix("stay_jib")
    },
    sails: lastSolve.model.sails ? {
      relaxed: relaxedSails,
      prebend: prebendSails,
      loaded: curLoadedSails
    } : null,
    tensions: {
      shroudPortN: shPort,
      shroudStbdN: shStbd,
      forestayN: stayJibN,
      halyardN: controls.jibHalyardTensionN
    },
    spreaders: {
      portAxialN: axial.spreader_port || 0,
      stbdAxialN: axial.spreader_stbd || 0,
      // Posiciones reales de las crucetas (del solver)
      tipPort: (() => {
        const node = lastSolve.model.nodes.find(n => n.name === "spreader_tip_port");
        if (!node) return null;
        const p = lastSolve.meta.nodesPos[node.id];
        return p ? { x: p[0], y: p[1], z: p[2] } : null;
      })(),
      tipStbd: (() => {
        const node = lastSolve.model.nodes.find(n => n.name === "spreader_tip_stbd");
        if (!node) return null;
        const p = lastSolve.meta.nodesPos[node.id];
        return p ? { x: p[0], y: p[1], z: p[2] } : null;
      })(),
      root: (() => {
        const node = lastSolve.model.nodes.find(n => n.name === `mast_${Math.round((geometry.spreaderZM / geometry.mastLengthM) * solver.mastSegments)}`);
        if (!node) return null;
        const p = lastSolve.meta.nodesPos[node.id];
        return p ? { x: p[0], y: p[1], z: p[2] } : null;
      })()
    },
    reactions: lastSolve.meta.reactions ?? {},
    springsForces: lastSolve.meta.springsForces ?? {},
    equilibrium: computeEquilibriumClosed({
      nodes: lastSolve.model.nodes,
      reactions: lastSolve.meta.reactions,
      springsForces: lastSolve.meta.springsForces,
      appliedForces: mergeForces3(
        lastSolve.model.forces,
        lastSolve.meta.membranePressureForces,
        lastSolve.model.nodes.length
      )
    })
  };

  const iterationsTotal = allHistory.reduce((s, h) => s + (h.iterations ?? 0), 0);
  const success = completedAllPhases && Boolean(lastSolve?.converged);

  return {
    ok: success,
    converged: success,
    iterations: iterationsTotal,
    iterationsLast: lastSolve.iterations,
    energy: lastSolve.energy,
    gradInf: lastSolve.gradInf,
    solver: lastSolve.solver,
    reason: lastSolve.reason,
    diagnostics: {
      slackCables: lastSolve.meta.slackCables,
      history: allHistory,
      constants,
      convergenceHistory: lastSolve.convergenceHistory ?? []
    },
    outputs,
    inputs: payload
  };
}

module.exports = { runPhase1Simulation };
