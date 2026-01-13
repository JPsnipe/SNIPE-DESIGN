const { getPresets } = require("./src/shared/rig/presets.cjs");
const { buildPhase1Model3d } = require("./src/shared/rig/modelPhase1_3d.cjs");
const { applySailsPhase1ToModel3d } = require("./src/shared/rig/sailsPhase1_3d.cjs");
const { solveEquilibrium3d } = require("./src/shared/rig/solverPhase1_3d.cjs");

// SEVERE BENCHMARK: CPU Baseline (Original Code)
// Reduced to 20x20 to avoid the O(N^2) hang in mass initialization.
async function runSevereBenchmark() {
    console.log("--- SNIPEDESIGN SEVERE BENCHMARK (CPU) ---");

    // 1. Setup high-resolution payload
    const presets = getPresets();
    const payload = JSON.parse(JSON.stringify(presets[1])); // SCIRA Standard

    // NORMALIZE UNITS
    const geometry = {
        mastLengthM: payload.geometry.mastLengthMm / 1000,
        partnersZM: payload.geometry.partnersZMm / 1000,
        spreaderZM: payload.geometry.spreaderZMm / 1000,
        houndsZM: payload.geometry.houndsZMm / 1000,
        shroudAttachZM: payload.geometry.shroudAttachZMm / 1000,
        tackZM: payload.geometry.tackZMm / 1000,
        chainplateXM: payload.geometry.chainplateXMm / 1000,
        chainplateYM: payload.geometry.chainplateYMm / 1000,
        bowYM: payload.geometry.bowYMm / 1000
    };

    const controls = {
        spreaderLengthM: payload.controls.spreaderLengthMm / 1000,
        spreaderSweepAftM: (payload.controls.spreaderLengthMm * Math.sin(payload.controls.spreaderAngleDeg * Math.PI / 180)) / 1000,
        shroudDeltaL0PortM: payload.controls.shroudDeltaPortMm / 1000,
        shroudDeltaL0StbdM: payload.controls.shroudDeltaStbdMm / 1000,
        jibHalyardTensionN: payload.controls.jibHalyardTensionkN * 1000,
        partnersKx: payload.controls.partnersKx_kNpm,
        partnersKy: payload.controls.partnersKy_kNpm,
        lockStayLength: payload.controls.lockStayLength
    };

    const solver = {
        ...payload.solver,
        mastSegments: 60,
        drMaxIterations: 500,
        cableSegments: 1,
        toleranceN: 1.0
    };

    const sails = {
        enabled: true,
        windPressurePa: 80,
        windSign: 1,
        main: {
            enabled: true,
            draftDepth: 0.1,
            draftPos: 0.4,
            luffLengthM: 5.5,
            footLengthM: 2.5,
            mesh: { luffSegments: 20, chordSegments: 20 }
        },
        jib: {
            enabled: true,
            draftDepth: 0.08,
            draftPos: 0.35,
            luffLengthM: 4.5,
            footLengthM: 2.0,
            mesh: { luffSegments: 20, chordSegments: 20 }
        }
    };

    const constants = {
        mastEIBase: payload.stiffness.mastEIBase,
        mastEITop: payload.stiffness.mastEITop,
        taperStartZM: payload.stiffness.taperStartZMm / 1000,
        rigEA: 1.2e8,
        mastEA_real: 3.0e7,
        spreaderEA: 1.0e8,
        membraneE: 5e7,
        membraneNu: 0.3,
        membraneThickness: 0.00025,
        membranePretensionFraction: 0.50,
        membraneWrinklingEps: 1e-4,
        membraneCurvatureRadius: 1.5
    };

    const state = {
        loadScale: 1.0,
        load: payload.load,
        sails: sails,
        standingScale: 1.0,
        halyardScale: 1.0
    };

    console.log(`Model Resolution: ${solver.mastSegments} mast segments.`);
    console.log(`Sail Resolution: Main 20x20, Jib 20x20.`);

    // 2. Build Model
    const t0_build = performance.now();
    let model = buildPhase1Model3d({
        geometry,
        controls,
        solver,
        state,
        constants
    });

    model = applySailsPhase1ToModel3d({
        model,
        geometry,
        state,
        constants,
        sails
    });
    const t1_build = performance.now();

    const numNodes = model.nodes.length;
    const numElements = (model.axial?.length || 0) + (model.membranes?.length || 0);
    console.log(`Model built in ${(t1_build - t0_build).toFixed(2)}ms`);
    console.log(`Nodes: ${numNodes}, Elements: ${numElements}`);

    // 3. Solve (CPU)
    console.log(`Starting Dynamic Relaxation (${solver.drMaxIterations} iterations)...`);
    const t0_solve = performance.now();

    const result = solveEquilibrium3d({
        model,
        solver: {
            ...solver,
            drDebug: false,
            onProgress: (p) => {
                if (p.iteration % 100 === 0) {
                    process.stdout.write(`.`);
                }
            }
        },
        x0: null
    });
    console.log("\n");

    const t1_solve = performance.now();
    const totalTime = t1_solve - t0_solve;

    console.log("--- RESULTS ---");
    console.log(`Total Solve Time: ${totalTime.toFixed(2)}ms`);
    console.log(`Time per Iteration: ${(totalTime / result.iterations).toFixed(4)}ms (${result.iterations} iters)`);
    console.log(`Converged: ${result.converged} (Final Residual: ${result.gradInf.toFixed(6)})`);
    console.log(`-------------------------------------------`);
}

runSevereBenchmark().catch(err => {
    console.error("Benchmark failed:", err);
    if (err.stack) console.error(err.stack);
});
