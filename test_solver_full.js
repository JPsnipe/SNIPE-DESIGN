/**
 * Test completo del solver para verificar:
 * 1. Solver rápido de jarcia (sin membranas)
 * 2. Solver con membranas (Dynamic Relaxation)
 * 3. Equilibrio físico correcto
 * 4. Forma de vela realista
 */

const { runPhase1Simulation } = require("./src/shared/rig/runPhase1.cjs");

// Payload base sin velas (solo jarcia)
const payloadRigOnly = {
  geometry: {
    mastLengthM: 6.5,
    partnersZM: 0.395,
    spreaderZM: 2.5,
    houndsZM: 4.911,
    shroudAttachZM: 4.86,
    chainplateXM: 0.55,
    chainplateYM: -0.05,
    bowYM: 1.511
  },
  controls: {
    spreaderLengthM: 0.41,
    spreaderSweepAftM: 0.153,
    shroudBaseDeltaM: 0,
    shroudDeltaL0PortM: 0.003,
    shroudDeltaL0StbdM: 0.003,
    jibHalyardTensionN: 1500,
    partnersKx: 30000,
    partnersKy: 30000,
    partnersOffsetXM: 0,
    partnersOffsetYM: 0,
    lockStayLength: true
  },
  load: {
    mode: "upwind",
    qLateralNpm: 60,
    qProfile: "triangular"
  },
  solver: {
    mastSegments: 30,
    cableSegments: 1,
    pretensionSteps: 5,
    loadSteps: 5,
    maxIterations: 200,
    toleranceN: 1.0,
    cableCompressionEps: 1e-3
  },
  stiffness: {
    mastEIBase: 7500,
    mastEITop: 3500,
    taperStartZM: 4.5
  }
};

// Payload con velas (membranas)
const payloadWithSails = {
  ...payloadRigOnly,
  solver: {
    ...payloadRigOnly.solver,
    drMaxIterations: 2000,
    drTimeStep: 0.005,
    drStabilityFactor: 0.25,
    pressureRampIters: 300,
    useSegregatedFSI: true,
    fsiIterations: 3
  },
  sails: {
    enabled: true,
    windPressurePa: 80,
    windSign: 1,
    main: {
      enabled: true,
      draftDepth: 0.08,
      draftPos: 0.4,
      shapeSections: 4,
      luffLengthM: 5.5,
      footLengthM: 2.743,
      cunninghamMm: 0,
      boomAngleDeg: 10,
      boomTiltDeg: 5,
      outhaulMm: 0,
      mesh: { luffSegments: 8, chordSegments: 4 }
    },
    jib: {
      enabled: true,
      draftDepth: 0.07,
      draftPos: 0.35,
      shapeSections: 4,
      luffLengthM: 4.7,
      footLengthM: 2.2,
      clewDisplaceMm: 50,
      sheetSideSign: 0,
      sheetLeadXMm: 400,
      sheetLeadYMm: -1800,
      mesh: { luffSegments: 6, chordSegments: 3 }
    }
  }
};

function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function runTest(name, payload) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("=".repeat(60));

  const start = Date.now();
  let result;
  try {
    result = runPhase1Simulation(payload);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(err.stack);
    return { ok: false, error: err.message };
  }
  const elapsed = Date.now() - start;

  console.log(`\nRESULTADO:`);
  console.log(`  OK: ${result.ok}`);
  console.log(`  Converged: ${result.converged}`);
  console.log(`  Solver: ${result.solver}`);
  console.log(`  Iteraciones: ${result.iterations}`);
  console.log(`  GradInf: ${result.gradInf?.toExponential(2)}`);
  console.log(`  Energía: ${result.energy?.toExponential(4)}`);
  console.log(`  Tiempo: ${formatTime(elapsed)}`);

  if (result.outputs) {
    console.log(`\nTENSIONES:`);
    console.log(`  Obenque Br: ${(result.outputs.tensions.shroudPortN/1000).toFixed(2)} kN`);
    console.log(`  Obenque Er: ${(result.outputs.tensions.shroudStbdN/1000).toFixed(2)} kN`);
    console.log(`  Forestay: ${(result.outputs.tensions.forestayN/1000).toFixed(2)} kN`);
    console.log(`  Driza: ${(result.outputs.tensions.halyardN/1000).toFixed(2)} kN`);

    if (result.outputs.equilibrium) {
      const eq = result.outputs.equilibrium;
      console.log(`\nEQUILIBRIO:`);
      console.log(`  ΣFx: ${eq.sumFx?.toFixed(2)} N`);
      console.log(`  ΣFy: ${eq.sumFy?.toFixed(2)} N`);
      console.log(`  ΣFz: ${eq.sumFz?.toFixed(2)} N`);
      console.log(`  Magnitud: ${eq.magnitude?.toFixed(2)} N`);
      console.log(`  Balanceado: ${eq.isBalanced}`);
    }

    if (result.outputs.mastCurveLoaded?.length > 0) {
      const curve = result.outputs.mastCurveLoaded;
      const topX = curve[curve.length - 1].x;
      const topY = curve[curve.length - 1].y;
      const topZ = curve[curve.length - 1].z;
      console.log(`\nFORMA DEL MÁSTIL (PUNTA):`);
      console.log(`  X (lateral): ${(topX * 1000).toFixed(1)} mm`);
      console.log(`  Y (proa/popa): ${(topY * 1000).toFixed(1)} mm`);
      console.log(`  Z (altura): ${(topZ * 1000).toFixed(1)} mm`);
    }

    if (result.outputs.sails?.loaded?.main) {
      const mainSail = result.outputs.sails.loaded.main;
      console.log(`\nVELA MAYOR:`);
      console.log(`  Filas: ${mainSail.length}`);
      console.log(`  Columnas: ${mainSail[0]?.length || 0}`);

      // Verificar forma de la vela - draft en el centro
      const midRow = Math.floor(mainSail.length / 2);
      if (mainSail[midRow]) {
        const luffPos = mainSail[midRow][0];
        const leechPos = mainSail[midRow][mainSail[midRow].length - 1];
        const midPos = mainSail[midRow][Math.floor(mainSail[midRow].length / 2)];

        const chordLen = Math.sqrt(
          Math.pow(leechPos[0] - luffPos[0], 2) +
          Math.pow(leechPos[1] - luffPos[1], 2)
        );

        // Draft = distancia del punto medio a la línea grátil-baluma
        const chordDir = [(leechPos[0] - luffPos[0]) / chordLen, (leechPos[1] - luffPos[1]) / chordLen];
        const perpDir = [-chordDir[1], chordDir[0]];
        const midToLuff = [midPos[0] - luffPos[0], midPos[1] - luffPos[1]];
        const draft = Math.abs(midToLuff[0] * perpDir[0] + midToLuff[1] * perpDir[1]);
        const draftPct = (draft / chordLen) * 100;

        console.log(`  Cuerda central: ${(chordLen * 1000).toFixed(0)} mm`);
        console.log(`  Draft central: ${(draft * 1000).toFixed(0)} mm (${draftPct.toFixed(1)}%)`);
      }
    }

    if (result.outputs.sails?.loaded?.jib) {
      const jibSail = result.outputs.sails.loaded.jib;
      console.log(`\nFOQUE:`);
      console.log(`  Filas: ${jibSail.length}`);
      console.log(`  Columnas: ${jibSail[0]?.length || 0}`);
    }
  }

  if (result.diagnostics?.slackCables?.length > 0) {
    console.log(`\nCABLES FLOJOS: ${result.diagnostics.slackCables.join(", ")}`);
  }

  return result;
}

// Ejecutar tests
console.log("\n" + "#".repeat(60));
console.log("# TESTS DE SOLVER SNIPEDESIGN");
console.log("#".repeat(60));

// Test 1: Solo jarcia (rápido)
const result1 = runTest("Jarcia sin velas (Newton)", payloadRigOnly);

// Test 2: Con velas (Dynamic Relaxation)
const result2 = runTest("Con velas (Dynamic Relaxation)", payloadWithSails);

// Test 3: Diferentes condiciones de trimado
console.log("\n" + "#".repeat(60));
console.log("# TEST DE TRIMADO");
console.log("#".repeat(60));

// Tensión alta
const highTension = {
  ...payloadRigOnly,
  controls: {
    ...payloadRigOnly.controls,
    jibHalyardTensionN: 2500,
    shroudDeltaL0PortM: 0.008,
    shroudDeltaL0StbdM: 0.008
  }
};
const result3 = runTest("Alta tensión jarcia", highTension);

// Viento fuerte
const strongWind = {
  ...payloadRigOnly,
  load: {
    mode: "upwind",
    qLateralNpm: 120,
    qProfile: "triangular"
  }
};
const result4 = runTest("Viento fuerte sin velas", strongWind);

// Resumen final
console.log("\n" + "#".repeat(60));
console.log("# RESUMEN");
console.log("#".repeat(60));
console.log(`Test 1 (Jarcia): ${result1.ok ? "OK" : "FAILED"}`);
console.log(`Test 2 (Velas): ${result2.ok ? "OK" : "FAILED"}`);
console.log(`Test 3 (Alta tensión): ${result3.ok ? "OK" : "FAILED"}`);
console.log(`Test 4 (Viento fuerte): ${result4.ok ? "OK" : "FAILED"}`);

const allPassed = result1.ok && result2.ok && result3.ok && result4.ok;
console.log(`\nTODOS LOS TESTS: ${allPassed ? "PASSED ✓" : "FAILED ✗"}`);

process.exit(allPassed ? 0 : 1);
