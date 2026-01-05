const test = require("node:test");
const assert = require("node:assert/strict");

const { runPhase1Simulation } = require("../src/shared/rig/runPhase1.cjs");
const { buildPhase1Model3d } = require("../src/shared/rig/modelPhase1_3d.cjs");
const { solveEquilibrium3d } = require("../src/shared/rig/solverPhase1_3d.cjs");

function mmToM(mm) {
  return mm / 1000;
}

function kNpmToNpm(kNpm) {
  return kNpm * 1000;
}

function kNToN(kN) {
  return kN * 1000;
}

function makePayload({
  mastLengthMm = 6500,
  partnersZMm = 395,
  spreaderZMm = 2500,
  houndsZMm = 4911,
  shroudAttachZMm = 4860,
  chainplateXMm = 550,
  chainplateYMm = -50,
  bowYMm = 1511,
  spreaderLengthMm = 425,
  spreaderSweepAftMm = 150,
  shroudDeltaPortMm = 3,
  shroudDeltaStbdMm = 3,
  jibHalyardTensionkN = 1.5,
  partnersKx_kNpm = 30,
  partnersKy_kNpm = 30,
  loadMode = "upwind",
  qLateralNpm = 60,
  qProfile = "triangular",
  mastSegments = 24,
  pretensionSteps = 8,
  loadSteps = 8,
  maxIterations = 300,
  toleranceN = 0.5,
  cableCompressionEps = 1e-5
} = {}) {
  return {
    geometry: {
      mastLengthM: mmToM(mastLengthMm),
      partnersZM: mmToM(partnersZMm),
      spreaderZM: mmToM(spreaderZMm),
      houndsZM: mmToM(houndsZMm),
      shroudAttachZM: mmToM(shroudAttachZMm),
      chainplateXM: mmToM(chainplateXMm),
      chainplateYM: mmToM(chainplateYMm),
      bowYM: mmToM(bowYMm)
    },
    controls: {
      spreaderLengthM: mmToM(spreaderLengthMm),
      spreaderSweepAftM: mmToM(spreaderSweepAftMm),
      shroudDeltaL0PortM: mmToM(shroudDeltaPortMm),
      shroudDeltaL0StbdM: mmToM(shroudDeltaStbdMm),
      jibHalyardTensionN: kNToN(jibHalyardTensionkN),
      partnersKx: kNpmToNpm(partnersKx_kNpm),
      partnersKy: kNpmToNpm(partnersKy_kNpm)
    },
    load: {
      mode: loadMode,
      qLateralNpm,
      qProfile
    },
    solver: {
      mastSegments,
      pretensionSteps,
      loadSteps,
      maxIterations,
      toleranceN,
      cableCompressionEps
    }
  };
}

test("phase1: converges baseline preset", () => {
  const payload = makePayload();
  const res = runPhase1Simulation(payload);
  assert.equal(res.converged, true, res.reason ?? "not converged");
  assert.ok(res.outputs);
  assert.ok(res.outputs.mastCurveLoaded.length > 5);
});

test("phase1: symmetric no-load keeps lateral near zero", () => {
  const payload = makePayload({
    loadMode: "none",
    qLateralNpm: 0,
    jibHalyardTensionkN: 0,
    shroudDeltaPortMm: 3,
    shroudDeltaStbdMm: 3
  });
  const res = runPhase1Simulation(payload);
  assert.equal(res.converged, true, res.reason ?? "not converged");

  const { shroudPortN, shroudStbdN } = res.outputs.tensions;
  // When both shroud tensions are very small (< 1 N), they're essentially at zero
  // and numerical noise dominates - only check absolute difference
  const bothNearZero = shroudPortN < 1 && shroudStbdN < 1;
  const diff = Math.abs(shroudPortN - shroudStbdN);
  const denom = Math.max(1, Math.max(shroudPortN, shroudStbdN));
  const ok = bothNearZero ? diff < 0.1 : diff / denom < 1e-3;
  assert.ok(ok, `port/stbd mismatch: ${shroudPortN} vs ${shroudStbdN}`);

  const curve = res.outputs.mastCurveLoaded;
  const maxAbsX = Math.max(...curve.map((p) => Math.abs(p.x)));
  assert.ok(maxAbsX < 1e-3, `unexpected lateral x: ${maxAbsX}`);
});

test("phase1: shroud load path closes at chainplates", () => {
  const payload = makePayload({ loadMode: "none", qLateralNpm: 0 });
  const res = runPhase1Simulation(payload);
  assert.equal(res.converged, true, res.reason ?? "not converged");

  const t = res.outputs.tensions;
  const rP = res.outputs.reactions.chainplate_port;
  const rS = res.outputs.reactions.chainplate_stbd;
  assert.ok(Array.isArray(rP) && rP.length >= 3, "missing chainplate_port reaction");
  assert.ok(Array.isArray(rS) && rS.length >= 3, "missing chainplate_stbd reaction");

  const magP = Math.hypot(rP[0] || 0, rP[1] || 0, rP[2] || 0);
  const magS = Math.hypot(rS[0] || 0, rS[1] || 0, rS[2] || 0);
  const tolRel = 2e-3;

  assert.ok(
    Math.abs(magP - t.shroudPortN) / Math.max(1, t.shroudPortN) < tolRel,
    `port load path mismatch: shroud=${t.shroudPortN} |R|=${magP}`
  );
  assert.ok(
    Math.abs(magS - t.shroudStbdN) / Math.max(1, t.shroudStbdN) < tolRel,
    `stbd load path mismatch: shroud=${t.shroudStbdN} |R|=${magS}`
  );
});

test("phase1: stay is controlled by target tension", () => {
  const targetkN = 2.0;
  const base = makePayload({ loadMode: "none", qLateralNpm: 0, jibHalyardTensionkN: targetkN });
  const tight = makePayload({
    loadMode: "none",
    qLateralNpm: 0,
    jibHalyardTensionkN: targetkN,
    shroudDeltaPortMm: 6,
    shroudDeltaStbdMm: 6
  });

  const r1 = runPhase1Simulation(base);
  const r2 = runPhase1Simulation(tight);
  assert.equal(r1.converged, true, r1.reason ?? "not converged");
  assert.equal(r2.converged, true, r2.reason ?? "not converged");

  const targetN = kNToN(targetkN);
  const tolN = 1e-9 * Math.max(1, targetN);
  assert.ok(Math.abs(r1.outputs.tensions.forestayN - targetN) <= tolN, `base forestay=${r1.outputs.tensions.forestayN} target=${targetN}`);
  assert.ok(Math.abs(r2.outputs.tensions.forestayN - targetN) <= tolN, `tight forestay=${r2.outputs.tensions.forestayN} target=${targetN}`);
});

test("phase1: higher lateral load increases top deflection", () => {
  const low = makePayload({ qLateralNpm: 30, loadMode: "upwind" });
  const high = makePayload({ qLateralNpm: 90, loadMode: "upwind" });

  const r1 = runPhase1Simulation(low);
  const r2 = runPhase1Simulation(high);
  assert.equal(r1.converged, true, r1.reason ?? "not converged");
  assert.equal(r2.converged, true, r2.reason ?? "not converged");

  const xTop1 = r1.outputs.mastCurveLoaded.at(-1).x;
  const xTop2 = r2.outputs.mastCurveLoaded.at(-1).x;
  assert.ok(Math.abs(xTop2) > Math.abs(xTop1), `top x did not grow: ${xTop1} -> ${xTop2}`);
});

test("phase1: equilibrium closes across variants", () => {
  const cases = [
    makePayload({ loadMode: "none", qLateralNpm: 0 }),
    makePayload({ loadMode: "upwind", qLateralNpm: 60, qProfile: "triangular" }),
    makePayload({ loadMode: "upwind", qLateralNpm: 60, qProfile: "uniform" }),
    makePayload({ loadMode: "downwind", qLateralNpm: 60, qProfile: "triangular" }),
    makePayload({ shroudDeltaPortMm: 6, shroudDeltaStbdMm: 3, loadMode: "none", qLateralNpm: 0 }),
    makePayload({ partnersKx_kNpm: 10, partnersKy_kNpm: 40, loadMode: "none", qLateralNpm: 0 }),
    makePayload({ spreaderSweepAftMm: 100 }),
    makePayload({ houndsZMm: 4860, shroudAttachZMm: 4860 }),
    makePayload({ shroudAttachZMm: 4760 }),
    makePayload({ chainplateYMm: -80 }),
    makePayload({ mastSegments: 16, pretensionSteps: 6, loadSteps: 6 }),
    makePayload({ cableCompressionEps: 1e-3 })
  ];

  for (const [idx, payload] of cases.entries()) {
    const res = runPhase1Simulation(payload);
    assert.equal(res.converged, true, `case ${idx}: ${res.reason ?? "not converged"}`);
    assert.ok(res.outputs?.equilibrium, `case ${idx}: missing equilibrium`);

    const eq = res.outputs.equilibrium;
    assert.ok(Number.isFinite(eq.mastStepRx), `case ${idx}: invalid mastStepRx=${eq.mastStepRx}`);
    assert.ok(Number.isFinite(eq.mastStepRy), `case ${idx}: invalid mastStepRy=${eq.mastStepRy}`);
    assert.ok(Number.isFinite(eq.mastStepRz), `case ${idx}: invalid mastStepRz=${eq.mastStepRz}`);

    assert.ok(Math.abs(eq.sumFx) < 10, `case ${idx}: sumFx=${eq.sumFx}`);
    assert.ok(Math.abs(eq.sumFy) < 10, `case ${idx}: sumFy=${eq.sumFy}`);
    assert.ok(Math.abs(eq.sumFz) < 1e-6, `case ${idx}: sumFz=${eq.sumFz}`);
    assert.ok(eq.magnitude < 10, `case ${idx}: |sumF|=${eq.magnitude}`);
  }
});

test("phase1: spreader tips keep sweep under load (no free rotation)", () => {
  const payload = makePayload({
    mastSegments: 30,
    pretensionSteps: 10,
    loadSteps: 10,
    maxIterations: 250,
    toleranceN: 0.5,
    cableCompressionEps: 1e-3
  });

  const constants = {
    mastEIBase: 7500,
    mastEITop: 3500,
    taperStartZM: 4.5,
    spreaderEA: 1.0e8,
    rigEA: 1.2e8
  };

  const state = {
    standingScale: 1,
    halyardScale: 1,
    loadScale: 1,
    load: payload.load,
    sails: null
  };

  const model = buildPhase1Model3d({
    geometry: payload.geometry,
    controls: payload.controls,
    solver: payload.solver,
    state,
    constants
  });

  const sol = solveEquilibrium3d({ model, solver: payload.solver, x0: null });
  assert.equal(sol.converged, true, sol.reason ?? "not converged");

  const nodesPos = sol.meta.nodesPos;
  const nSeg = payload.solver.mastSegments;
  const idx = Math.max(
    1,
    Math.min(
      nSeg - 1,
      Math.round((payload.geometry.spreaderZM / payload.geometry.mastLengthM) * nSeg)
    )
  );
  const rootId = model.mastNodeIds[idx];

  const root = nodesPos[rootId];
  const tipPort = nodesPos[model.tipPortId];
  const tipStbd = nodesPos[model.tipStbdId];

  const targetDy = -payload.controls.spreaderSweepAftM;
  const dyPort = tipPort[1] - root[1];
  const dyStbd = tipStbd[1] - root[1];

  assert.ok(Math.abs(dyPort - targetDy) < 1e-4, `port sweep drift: dy=${dyPort} target=${targetDy}`);
  assert.ok(Math.abs(dyStbd - targetDy) < 1e-4, `stbd sweep drift: dy=${dyStbd} target=${targetDy}`);

  const dzPort = tipPort[2] - root[2];
  const dzStbd = tipStbd[2] - root[2];
  assert.ok(Math.abs(dzPort) < 1e-4, `port tip Z drift: dz=${dzPort}`);
  assert.ok(Math.abs(dzStbd) < 1e-4, `stbd tip Z drift: dz=${dzStbd}`);
});

test("phase1: converges with sails enabled (main + jib)", () => {
  const payload = makePayload({
    // Keep mast wind off to isolate sail membrane loads
    loadMode: "upwind",
    qLateralNpm: 0,
    qProfile: "uniform",
    mastSegments: 20,
    pretensionSteps: 8,
    loadSteps: 8,
    maxIterations: 400,
    toleranceN: 1.5,
    cableCompressionEps: 1e-4
  });

  payload.sails = {
    enabled: true,
    windPressurePa: 80,
    windSign: 1,
    main: {
      enabled: true,
      draftDepth: 0.08,
      draftPos: 0.4,
      footLengthM: mmToM(2550),
      sheetDeltaL0M: 0,
      outhaulDeltaL0M: 0
    },
    jib: {
      enabled: true,
      draftDepth: 0.07,
      draftPos: 0.35,
      sheetDeltaL0M: 0,
      sheetSideSign: 0
    }
  };

  const res = runPhase1Simulation(payload);
  const failMsg = res.converged ? "" : `not converged: residual=${res.gradInf?.toFixed(3)}, reason=${res.reason}`;
  assert.equal(res.converged, true, failMsg);
  assert.ok(res.outputs?.sails, "missing sails outputs");
  assert.ok(res.outputs.sails.loaded?.main, "missing main sail grid");
  assert.ok(res.outputs.sails.loaded?.jib, "missing jib sail grid");

  // Basic sanity: sail grids should include finite coordinates
  const mainFlat = res.outputs.sails.loaded.main.flat().flat();
  const jibFlat = res.outputs.sails.loaded.jib.flat().flat();
  assert.ok(mainFlat.every(Number.isFinite), "main sail contains non-finite values");
  assert.ok(jibFlat.every(Number.isFinite), "jib sail contains non-finite values");
});
