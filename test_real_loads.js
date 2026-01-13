/**
 * Test con cargas reales - Simula condiciones de navegacion
 */
const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');
const { getPresets } = require('./src/shared/rig/presets.cjs');

// Convertir mm a metros
const mmToM = (mm) => mm / 1000;
const kNToN = (kN) => kN * 1000;

// Obtener preset base
const presets = getPresets();
const preset = presets[1]; // SCIRA Standard (Medium)

console.log('=== TEST CON CARGAS REALES ===\n');
console.log('Preset:', preset.name);

// Construir payload como lo hace el renderer
const payload = {
  geometry: {
    mastLengthM: mmToM(preset.geometry.mastLengthMm),
    partnersZM: mmToM(preset.geometry.partnersZMm),
    spreaderZM: mmToM(preset.geometry.spreaderZMm),
    houndsZM: mmToM(preset.geometry.houndsZMm),
    shroudAttachZM: mmToM(preset.geometry.shroudAttachZMm),
    tackZM: mmToM(preset.geometry.tackZMm),
    chainplateXM: mmToM(preset.geometry.chainplateXMm),
    chainplateYM: mmToM(preset.geometry.chainplateYMm),
    bowYM: mmToM(preset.geometry.bowYMm)
  },
  controls: {
    spreaderLengthM: mmToM(preset.controls.spreaderLengthMm),
    spreaderSweepAftM: mmToM(preset.controls.spreaderLengthMm * Math.sin((preset.controls.spreaderAngleDeg || 22) * Math.PI / 180)),
    shroudDeltaL0PortM: mmToM(preset.controls.shroudDeltaPortMm || 0),
    shroudDeltaL0StbdM: mmToM(preset.controls.shroudDeltaStbdMm || 0),
    jibHalyardTensionN: kNToN(preset.controls.jibHalyardTensionkN || 1.5),
    partnersKx: (preset.controls.partnersKx_kNpm || 30) * 1000,
    partnersKy: (preset.controls.partnersKy_kNpm || 30) * 1000,
    partnersOffsetXM: mmToM(preset.controls.partnersOffsetXMm || 0),
    partnersOffsetYM: mmToM(preset.controls.partnersOffsetYMm || 0),
    lockStayLength: preset.controls.lockStayLength !== false
  },
  load: {
    mode: preset.load.mode || 'upwind',
    qLateralNpm: preset.load.qLateralNpm || 45,
    qProfile: preset.load.qProfile || 'triangular'
  },
  solver: {
    mastSegments: preset.solver.mastSegments || 60,
    pretensionSteps: preset.solver.pretensionSteps || 10,
    loadSteps: preset.solver.loadSteps || 10,
    maxIterations: preset.solver.maxIterations || 150,
    toleranceN: preset.solver.toleranceN || 1.0,
    cableCompressionEps: preset.solver.cableCompressionEps || 1e-3
  },
  stiffness: {
    mastEIBase: preset.stiffness?.mastEIBase || 7500,
    mastEITop: preset.stiffness?.mastEITop || 3500,
    taperStartZMm: preset.stiffness?.taperStartZMm || 4500
  },
  sails: { enabled: false }  // Primero sin velas
};

console.log('\n--- Payload construido ---');
console.log('Geometria:', JSON.stringify(payload.geometry, null, 2));
console.log('Controles:', JSON.stringify(payload.controls, null, 2));
console.log('Carga:', JSON.stringify(payload.load, null, 2));

console.log('\n--- Ejecutando simulacion SIN velas ---');
const startTime = Date.now();

try {
  const result = runPhase1Simulation(payload);
  const elapsed = Date.now() - startTime;

  console.log('\n=== RESULTADO ===');
  console.log('Converged:', result.converged);
  console.log('OK:', result.ok);
  console.log('Reason:', result.reason || 'none');
  console.log('Tiempo:', elapsed, 'ms');

  if (result.outputs) {
    console.log('\n--- Outputs ---');
    console.log('Mast curve points:', result.outputs.mastCurveLoaded?.length || 0);
    console.log('Tensiones:', JSON.stringify(result.outputs.tensions, null, 2));
    console.log('Spreaders:', JSON.stringify(result.outputs.spreaders, null, 2));

    if (result.outputs.sails) {
      console.log('Sails main:', result.outputs.sails.loaded?.main ? 'SI' : 'NO');
      console.log('Sails jib:', result.outputs.sails.loaded?.jib ? 'SI' : 'NO');
    }
  } else {
    console.log('\nSIN OUTPUTS - Simulacion fallo');
  }

  // Ahora probar CON velas
  console.log('\n\n--- Ejecutando simulacion CON velas ---');

  const payloadWithSails = {
    ...payload,
    sails: {
      enabled: true,
      windPressurePa: 80,
      windSign: 1,
      main: {
        enabled: true,
        tackZM: mmToM(preset.geometry.tackZMm || 1387),
        luffLengthM: 4.5,
        footLengthM: 2.5,
        draftDepth: 0.08,
        draftPos: 0.4,
        sheetDeltaL0M: 0,
        sheetLeadXM: 0,
        sheetLeadYM: -2.5,
        sheetLeadZM: 0,
        outhaulDeltaL0M: 0,
        vangDeltaL0M: 0,
        mesh: { luffSegments: 4, chordSegments: 3 }  // Malla reducida para test
      },
      jib: {
        enabled: true,
        luffLengthM: 4.0,
        footLengthM: 1.8,
        draftDepth: 0.10,
        draftPos: 0.35,
        sheetDeltaL0M: 0,
        sheetSideSign: 1,
        sheetLeadXM: 0.3,
        sheetLeadYM: 0.5,
        sheetLeadZM: 0.1,
        mesh: { luffSegments: 4, chordSegments: 3 }  // Malla reducida para test
      }
    }
  };

  const startTime2 = Date.now();
  const result2 = runPhase1Simulation(payloadWithSails);
  const elapsed2 = Date.now() - startTime2;

  console.log('\n=== RESULTADO CON VELAS ===');
  console.log('Converged:', result2.converged);
  console.log('OK:', result2.ok);
  console.log('Reason:', result2.reason || 'none');
  console.log('Tiempo:', elapsed2, 'ms');

  if (result2.outputs) {
    console.log('\n--- Outputs ---');
    console.log('Mast curve points:', result2.outputs.mastCurveLoaded?.length || 0);
    console.log('Tensiones:', JSON.stringify(result2.outputs.tensions, null, 2));

    if (result2.outputs.sails?.loaded) {
      const mainGrid = result2.outputs.sails.loaded.main;
      const jibGrid = result2.outputs.sails.loaded.jib;
      console.log('Main sail grid:', mainGrid ? `${mainGrid.length} rows x ${mainGrid[0]?.length || 0} cols` : 'NO');
      console.log('Jib sail grid:', jibGrid ? `${jibGrid.length} rows x ${jibGrid[0]?.length || 0} cols` : 'NO');
    } else {
      console.log('Sails loaded: NO');
    }
  } else {
    console.log('\nSIN OUTPUTS CON VELAS - Simulacion fallo');
    if (result2.history) {
      console.log('History entries:', result2.history.length);
      const lastEntry = result2.history[result2.history.length - 1];
      if (lastEntry) {
        console.log('Last phase:', lastEntry.phase);
        console.log('Last lambda:', lastEntry.lambda);
        console.log('Last converged:', lastEntry.converged);
        console.log('Last reason:', lastEntry.reason);
      }
    }
  }

} catch (error) {
  console.error('\n!!! ERROR EN SIMULACION !!!');
  console.error('Message:', error.message);
  console.error('Stack:', error.stack);
}
