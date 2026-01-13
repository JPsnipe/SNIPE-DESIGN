const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');

function testMembraneFix() {
  const payload = {
    geometry: {
      mastLengthM: 6.5,
      partnersZM: 0.4,
      spreaderZM: 2.5,
      houndsZM: 4.9,
      shroudAttachZM: 4.9,
      chainplateXM: 0.55,
      chainplateYM: -0.05,
      bowYM: 1.511
    },
    controls: {
      spreaderLengthM: 0.415,
      spreaderSweepAftM: 0.1,
      shroudBaseDeltaM: 0,
      shroudDeltaL0PortM: 0,
      shroudDeltaL0StbdM: 0,
      jibHalyardTensionN: 800,  // Tension de estay
      partnersKx: 25000,
      partnersKy: 25000,
      lockStayLength: true  // Bloquear longitud del estay
    },
    load: { mode: "upwind", qLateralNpm: 0, qProfile: "uniform" },
    solver: {
      mastSegments: 15,
      pretensionSteps: 2,
      loadSteps: 10,  // Más pasos para aplicar presión gradualmente
      maxIterations: 300,
      toleranceN: 30.0,  // Tolerancia razonable
      cableCompressionEps: 1e-4,
      sailDamping: 5.0,
      drTimeStep: 0.002,
      drMaxIterations: 5000
    },
    sails: {
      enabled: true,
      windPressurePa: 80,  // Presion de viento como en tu screenshot
      windSign: 1,
      main: { enabled: true, mesh: { luffSegments: 6, chordSegments: 4 } },
      jib: { enabled: false }  // Solo vela mayor para test rapido
    }
  };

  console.log("Running membrane stability test...");
  console.log("  - Wind pressure: 80 Pa");
  console.log("  - Stay tension (locked): enabled");
  console.log("  - Main sail: enabled");

  const startTime = Date.now();
  const res = runPhase1Simulation(payload);
  const elapsed = Date.now() - startTime;

  console.log("\n=== Results ===");
  console.log(`  Converged: ${res.converged}`);
  console.log(`  Iterations: ${res.iterationsLast || res.iterations}`);
  console.log(`  Residual: ${res.gradInf?.toFixed(2)} N`);
  console.log(`  Energy: ${res.energy?.toExponential(3)}`);
  console.log(`  Time: ${elapsed} ms`);
  console.log(`  Reason: ${res.reason || "converged"}`);

  // Verificar que no hubo explosion numerica
  if (!Number.isFinite(res.energy)) {
    console.error("ERROR: Energy is not finite - numerical explosion!");
    process.exit(1);
  }

  if (!Number.isFinite(res.gradInf)) {
    console.error("ERROR: Gradient is not finite - numerical explosion!");
    process.exit(1);
  }

  // Verificar que las posiciones de la vela son razonables
  const sails = res.outputs?.sails;
  if (sails && sails.loaded && sails.loaded.main) {
    let maxDisp = 0;
    const relaxed = sails.relaxed?.main || [];
    const loaded = sails.loaded.main;

    for (let i = 0; i < loaded.length; i++) {
      for (let j = 0; j < loaded[i].length; j++) {
        const pL = loaded[i][j];
        const pR = relaxed[i]?.[j] || pL;
        const dx = pL[0] - pR[0];
        const dy = pL[1] - pR[1];
        const dz = pL[2] - pR[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > maxDisp) maxDisp = d;
      }
    }

    console.log(`  Max sail displacement: ${(maxDisp * 1000).toFixed(1)} mm`);

    if (maxDisp > 5.0) {
      console.error("ERROR: Sail displacement too large - possible instability!");
      process.exit(1);
    }
  }

  console.log("\n=== TEST PASSED ===");
}

try {
  testMembraneFix();
} catch (err) {
  console.error("TEST FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
}
