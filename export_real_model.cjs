const { getPresets } = require('./src/shared/rig/presets.cjs');
const { buildPhase1Model3d } = require('./src/shared/rig/modelPhase1_3d.cjs');
const { applySailsPhase1ToModel3d } = require('./src/shared/rig/sailsPhase1_3d.cjs');
const fs = require('fs');

function buildConstants() {
    return {
        mastEA: 1.0e7,
        mastEA_real: 3.0e7,
        boomEA: 1.0e7,
        mastEI: 7500,
        spreaderEA: 1.0e8,
        rigEA: 1.2e8,
        sailEA: 8e4,
        sailShapeKx: 1000,
        sailShapeKy: 10,
        sailShapeKz: 10,
        clothCompressionEps: 0.1,
        clothSmoothDeltaM: 1e-3,
        membraneE: 5e7,
        membraneNu: 0.3,
        membraneThickness: 0.00025,
        membranePretensionFraction: 0.50,
        membraneWrinklingEps: 1e-4,
        membraneCurvatureRadius: 1.5
    };
}

function exportRealModel() {
    console.log("Building real model (SCIRA Standard 20x20)...");

    const presetList = getPresets();
    const preset = presetList.find(p => p.name === 'SCIRA Standard (Medium)');

    // 1. Geometry (Presets mm -> Model m)
    const geometry = {
        mastLengthM: preset.geometry.mastLengthMm / 1000,
        partnersZM: preset.geometry.partnersZMm / 1000,
        spreaderZM: preset.geometry.spreaderZMm / 1000,
        houndsZM: preset.geometry.houndsZMm / 1000,
        shroudAttachZM: (preset.geometry.shroudAttachZMm ?? preset.geometry.houndsZMm) / 1000,
        chainplateXM: preset.geometry.chainplateXMm / 1000,
        chainplateYM: preset.geometry.chainplateYMm / 1000,
        bowYM: preset.geometry.bowYMm / 1000,
        sailMeshResolution: 20
    };

    // 2. Controls (Presets mm/deg -> Model m)
    const sLenM = preset.controls.spreaderLengthMm / 1000;
    const sAngleRad = (preset.controls.spreaderAngleDeg ?? 0) * Math.PI / 180;

    const controls = {
        spreaderLengthM: sLenM,
        spreaderSweepAftM: sLenM * Math.sin(sAngleRad),
        shroudBaseDeltaM: (preset.controls.shroudBaseDeltaMm ?? 0) / 1000,
        shroudDeltaL0PortM: (preset.controls.shroudDeltaPortMm ?? 0) / 1000,
        shroudDeltaL0StbdM: (preset.controls.shroudDeltaStbdMm ?? 0) / 1000,
        jibHalyardTensionN: (preset.controls.jibHalyardTensionkN ?? 0) * 1000,
        partnersKx: (preset.controls.partnersKx_kNpm ?? 250) * 1000,
        partnersKy: (preset.controls.partnersKy_kNpm ?? 250) * 1000,
        partnersOffsetXM: (preset.controls.partnersOffsetXMm ?? 0) / 1000,
        partnersOffsetYM: (preset.controls.partnersOffsetYMm ?? 0) / 1000,
        lockStayLength: preset.controls.lockStayLength ?? true
    };

    const solver = preset.solver;
    const state = {
        loadScale: 0.5, // Start with some load
        standingScale: 1.0,
        halyardScale: 1.0,
        load: { windSpeed: 5, windAngle: 45, mode: 'upwind', qProfile: 'triangular', qLateralNpm: 45 },
        sails: { enabled: true, main: { enabled: true }, jib: { enabled: true } }
    };
    const constants = buildConstants();

    let model = buildPhase1Model3d({ geometry, controls, solver, state, constants });
    applySailsPhase1ToModel3d({ model, geometry, state, constants, sails: state.sails });

    console.log(`Model built: ${model.nodes.length} nodes, ${model.membranes.length} membranes.`);

    // Extract relevant data for GPU
    const nodes = model.nodes.map((n, i) => ({
        pos: [n.x, n.y, n.z],
        fixed: n.fixed ? 1.0 : 0.0,
        mass: n.mass || 0.1,
        id: i
    }));

    const membranes = model.membranes.map(m => ({
        nodeIndices: [model.nodes.indexOf(m.n0), model.nodes.indexOf(m.n1), model.nodes.indexOf(m.n2)],
        E: m.E || constants.membraneE,
        nu: m.nu || constants.membraneNu,
        thickness: m.thickness || constants.membraneThickness,
        area0: m.area0 || 0.001
    }));

    const exportData = { nodes, membranes, params: { dt: 0.001, damping: 0.05 } };

    fs.writeFileSync('real_model_data.json', JSON.stringify(exportData, null, 2));
    console.log("Saved real_model_data.json");
}

exportRealModel();
