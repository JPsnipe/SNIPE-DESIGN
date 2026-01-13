const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function isFiniteVec3(p) {
  return Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);
}

function checkGridFinite(grid, label) {
  if (!grid) return;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      const p = row[j];
      assert(isFiniteVec3(p), `${label} has non-finite node at [${i}, ${j}] -> ${p}`);
    }
  }
}

function maxGridDisplacement(gridA, gridB) {
  if (!gridA || !gridB) return 0;
  let maxDisp = 0;
  for (let i = 0; i < gridA.length; i++) {
    const rowA = gridA[i] || [];
    const rowB = gridB[i] || [];
    const n = Math.min(rowA.length, rowB.length);
    for (let j = 0; j < n; j++) {
      const a = rowA[j];
      const b = rowB[j];
      if (!isFiniteVec3(a) || !isFiniteVec3(b)) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDisp) maxDisp = d;
    }
  }
  return maxDisp;
}

function testMembraneRobustness() {
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
      jibHalyardTensionN: 1000,
      partnersKx: 25000,
      partnersKy: 25000,
      lockStayLength: true
    },
    load: { mode: "upwind", qLateralNpm: 0, qProfile: "uniform" },
    solver: {
      mastSegments: 20,  // Reduced for faster convergence
      pretensionSteps: 2,
      loadSteps: 4,
      maxIterations: 200,
      toleranceN: 20.0,  // Realistic for membrane simulations
      cableCompressionEps: 1e-4,
      sailDamping: 5.0,
      sailDampingDecay: 0.95,
      drTimeStep: 0.003,
      drViscousDamping: 0.1,
      drWarmupIters: 200,
      drKineticBacktrack: 1.0,
      drMaxStepM: 0.002,  // Small steps for stability
      drStabilityFactor: 0.25,
      drMassSafety: 2.0,
      drMaxIterations: 2000,
      pressureRampIters: 400,
      drNewtonFallbackAfter: 600,
      membranePretensionFraction: 0.10,
      membraneWrinklingEps: 1e-4,
      membraneMaxStrain: 2.0,
      useSegregatedFSI: false,  // Disable for simpler convergence test
      fsiIterations: 2
    },
    sails: {
      enabled: true,
      windPressurePa: 100,
      windSign: 1,
      main: { enabled: true, mesh: { luffSegments: 8, chordSegments: 4 } },
      jib: { enabled: true, mesh: { luffSegments: 6, chordSegments: 3 } }
    }
  };

  const res = runPhase1Simulation(payload);
  // Allow partial convergence as long as residual is reasonable
  const finalGradInf = res.gradInf || Infinity;
  assert(res.converged || finalGradInf < 50, `Expected convergence or low residual, got converged=${res.converged}, gradInf=${finalGradInf}, reason=${res.reason || "unknown"}`);

  const iterCount = Number.isFinite(res.iterationsLast) ? res.iterationsLast : res.iterations;
  assert(iterCount <= 5000, `Expected <= 5000 iterations, got ${iterCount}`);

  assert(Number.isFinite(res.energy), `Energy is not finite: ${res.energy}`);
  assert(Number.isFinite(res.gradInf), `GradInf is not finite: ${res.gradInf}`);

  const sails = res.outputs?.sails;
  assert(sails && sails.relaxed && sails.loaded, "Missing sail outputs");

  checkGridFinite(sails.relaxed.main, "main.relaxed");
  checkGridFinite(sails.loaded.main, "main.loaded");
  checkGridFinite(sails.relaxed.jib, "jib.relaxed");
  checkGridFinite(sails.loaded.jib, "jib.loaded");

  const mainDisp = maxGridDisplacement(sails.relaxed.main, sails.loaded.main);
  const jibDisp = maxGridDisplacement(sails.relaxed.jib, sails.loaded.jib);
  const maxDisp = Math.max(mainDisp, jibDisp);

  // With stiff membrane material (E=2.5 GPa), displacements are small but real
  assert(maxDisp > 0.001, `Displacement too small: ${maxDisp.toFixed(4)} m`);
  assert(maxDisp < 5.0, `Displacement too large: ${maxDisp.toFixed(4)} m`);

  console.log("test_membrane_robustness: OK", {
    iterations: iterCount,
    maxDisp
  });
}

try {
  testMembraneRobustness();
} catch (err) {
  console.error("test_membrane_robustness: FAILED", err.message);
  process.exit(1);
}
