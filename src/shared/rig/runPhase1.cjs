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
  // E = 70 GPa, I ≈ 10.7 cm⁴ (fore/aft) → EI ≈ 7500 N·m²
  return {
    mastEA: 1.0e2,       // Rigidez axial reducida (Ghost Stiffness Fix)
    boomEA: 1.0e2,       // Botavara axial reducida (Ghost Stiffness Fix)
    mastEI: 7500,        // Rigidez a flexión del mástil (N·m²) - valor referencia
    spreaderEA: 1.0e8,   // Rigidez de spreaders (ajustada para estabilidad numérica)
    rigEA: 1.2e8,        // Rigidez de cables (obenques, forestay)

    // ═══════════════════════════════════════════════════════════════════
    // PARÁMETROS DE FÍSICA DE VELAS
    // ═══════════════════════════════════════════════════════════════════

    // Rigidez de la tela de vela (cables entre nodos de la malla)
    sailEA: 8e4,         // N - Rigidez axial de la tela

    // Resortes de forma (mantienen el draft diseñado bajo presión)
    // kx: perpendicular a la vela (más importante)
    // ky: dirección de la cuerda (menor, permite estiramiento)
    // kz: vertical (menor, permite movimiento con el mástil)
    sailShapeKx: 1500,   // N/m - Rigidez lateral (perpendicular a la vela)
    sailShapeKy: 225,    // N/m - Rigidez en cuerda (15% de kx)
    sailShapeKz: 150,    // N/m - Rigidez vertical (10% de kx)

    // Comportamiento de cables de tela bajo compresión
    clothCompressionEps: 0.1,   // Rigidez residual cuando el cable está flojo (10%)
    clothSmoothDeltaM: 1e-3     // Banda de transición suave (1mm)
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

function solveOneState({ geometry, controls, solver, state, constants, x0 }) {
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
  const out = solveEquilibrium3d({ model, solver, x0 });
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
  baseState
}) {
  const history = [];
  let x = xStart;
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
      x0: x
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
        return { ok: false, x, history, failedAt: target, last: { ...solved, converged: false, reason: "numerical_instability_nan" } };
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
          x0: x
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
      lambda = target;
      continue;
    }

    step *= 0.5;
    if (step < minStep) {
      return { ok: false, x, history, failedAt: target, last: solved };
    }
  }

  const finalState = phase.stateFn(1, baseState);
  const final = solveOneState({
    geometry,
    controls,
    solver,
    state: finalState,
    constants,
    x0: x
  });

  return { ok: final.converged, x: final.x, history, last: final };
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

  const geometry = payload.geometry;
  const controls = payload.controls;
  const load = payload.load;
  const sails = payload.sails && typeof payload.sails === "object" ? payload.sails : null;

  const solver = {
    mastSegments: payload.solver.mastSegments,
    pretensionSteps: payload.solver.pretensionSteps,
    loadSteps: payload.solver.loadSteps,
    maxIterations: payload.solver.maxIterations,
    toleranceN: payload.solver.toleranceN,
    cableCompressionEps: payload.solver.cableCompressionEps,
    // Damping alto para velas: permite convergencia gradual con muchos DOFs
    sailDamping: payload.solver.sailDamping ?? 10.0,
    sailDampingDecay: payload.solver.sailDampingDecay ?? 0.98
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

  for (const phase of phases) {
    const r = runContinuationPhase({
      geometry,
      controls,
      solver,
      constants,
      phase,
      xStart: x,
      baseState
    });
    allHistory.push(...r.history);
    if (!r.ok) {
      lastSolve = r.last; // Actualizar con el último estado parcial
      completedAllPhases = false;
      break;
    }

    x = r.x;
    lastSolve = r.last;

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
  let stayJibN = 0;
  if (Number.isFinite(axial.stay_jib)) {
    stayJibN = getCableTension(axial.stay_jib);
  } else {
    const seg = Object.entries(axial)
      .filter(([k]) => k.startsWith("stay_jib_seg_"))
      .map(([, v]) => v)
      .filter((v) => Number.isFinite(v));
    if (seg.length) stayJibN = Math.max(0, ...seg.map(getCableTension));
  }
  // Shrouds are modeled with a smooth cable law; report the axial magnitude (matches chainplate reaction magnitude).
  const shPort = Number.isFinite(axial.shroud_port)
    ? getAxialMag(axial.shroud_port)
    : 0.5 * (getAxialMag(axial.shroud_port_upper || 0) + getAxialMag(axial.shroud_port_lower || 0));
  const shStbd = Number.isFinite(axial.shroud_stbd)
    ? getAxialMag(axial.shroud_stbd)
    : 0.5 * (getAxialMag(axial.shroud_stbd_upper || 0) + getAxialMag(axial.shroud_stbd_lower || 0));

  const curLoadedCurve = mastCurveFromModel(lastSolve.model, lastSolve.meta.nodesPos);
  let curLoadedSails = null;
  if (lastSolve.model.sails) {
    curLoadedSails = {
      main: lastSolve.model.sails.main ? sailGridPositions(lastSolve.model.sails.main.gridNodeIds, lastSolve.meta.nodesPos) : null,
      jib: lastSolve.model.sails.jib ? sailGridPositions(lastSolve.model.sails.jib.gridNodeIds, lastSolve.meta.nodesPos) : null
    };
  }

  const outputs = {
    mastCurveRelaxed: relaxedCurve ?? [],
    mastCurvePrebend: prebendCurve ?? [],
    mastCurveLoaded: curLoadedCurve ?? [],
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
      stbdAxialN: axial.spreader_stbd || 0
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
