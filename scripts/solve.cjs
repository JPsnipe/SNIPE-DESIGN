const { getPresets } = require("../src/shared/rig/presets.cjs");
const { runPhase1Simulation } = require("../src/shared/rig/runPhase1.cjs");

function mmToM(mm) {
  return mm / 1000;
}

function kNpmToNpm(kNpm) {
  return kNpm * 1000;
}

function kNToN(kN) {
  return kN * 1000;
}

function presetToPayload(preset) {
  const spreaderLengthMm = preset.controls.spreaderLengthMm;
  const spreaderSweepAftMm =
    preset.controls.spreaderSweepAftMm ??
    (spreaderLengthMm * Math.sin(((preset.controls.spreaderAngleDeg ?? 0) * Math.PI) / 180));

  return {
    geometry: {
      mastLengthM: mmToM(preset.geometry.mastLengthMm),
      partnersZM: mmToM(preset.geometry.partnersZMm),
      spreaderZM: mmToM(preset.geometry.spreaderZMm),
      houndsZM: mmToM(preset.geometry.houndsZMm),
      chainplateXM: mmToM(preset.geometry.chainplateXMm),
      chainplateYM: mmToM(preset.geometry.chainplateYMm),
      bowYM: mmToM(preset.geometry.bowYMm)
    },
    controls: {
      spreaderLengthM: mmToM(spreaderLengthMm),
      spreaderSweepAftM: mmToM(spreaderSweepAftMm),
      shroudDeltaL0PortM: mmToM(preset.controls.shroudDeltaPortMm),
      shroudDeltaL0StbdM: mmToM(preset.controls.shroudDeltaStbdMm),
      jibHalyardTensionN: kNToN(preset.controls.jibHalyardTensionkN ?? 0),
      partnersKx: kNpmToNpm(preset.controls.partnersKx_kNpm),
      partnersKy: kNpmToNpm(preset.controls.partnersKy_kNpm)
    },
    load: preset.load,
    solver: preset.solver
  };
}

const preset = getPresets()[0];
const payload = presetToPayload(preset);
const res = runPhase1Simulation(payload);

console.log(JSON.stringify({
  converged: res.converged,
  iterations: res.iterations,
  gradInf: res.gradInf,
  tensions: res.outputs?.tensions,
  spreaders: res.outputs?.spreaders
}, null, 2));
