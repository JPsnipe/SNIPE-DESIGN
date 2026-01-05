const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');

async function test() {
    try {
        const payload = {
            geometry: {
                mastLengthM: 6.5, partnersZM: 0.4, spreaderZM: 2.5, houndsZM: 4.9,
                shroudAttachZM: 4.9, chainplateXM: 0.55, chainplateYM: -0.05, bowYM: 1.511
            },
            controls: {
                spreaderLengthM: 0.415, spreaderSweepAftM: 0.1, shroudBaseDeltaM: 0,
                shroudDeltaL0PortM: 0, shroudDeltaL0StbdM: 0, jibHalyardTensionN: 1000,
                partnersKx: 25000, partnersKy: 25000
            },
            load: { mode: "upwind", qLateralNpm: 45, qProfile: "triangular" },
            solver: {
                mastSegments: 50, pretensionSteps: 2, loadSteps: 2,
                maxIterations: 200, toleranceN: 10.0, cableCompressionEps: 1e-3,
                sailDamping: 5.0, sailDampingDecay: 0.95
            },
            sails: {
                enabled: true, windPressurePa: 80, windSign: 1,
                main: {
                    enabled: true, draftDepth: 0.08, draftPos: 0.4,
                    luffLengthM: 5.1, footLengthM: 2.5,
                    mesh: { luffSegments: 4, chordSegments: 3 }
                },
                jib: {
                    enabled: true, draftDepth: 0.07, draftPos: 0.35,
                    luffLengthM: 4.5, footLengthM: 2.1,
                    mesh: { luffSegments: 4, chordSegments: 3 }
                }
            }
        };

        console.time("Simulation");
        const res = await runPhase1Simulation(payload);
        console.timeEnd("Simulation");
        console.log("Converged:", res.converged);
        console.log("Solver used:", res.solver || "newton");
        if (res.gradInf) console.log("Final Gradient Norm:", res.gradInf.toFixed(4));
        if (res.reason) console.log("Exit reason:", res.reason);

        if (res.outputs.sails?.loaded?.main) {
            console.log("Main Sail Grid:", res.outputs.sails.loaded.main.length, "x", res.outputs.sails.loaded.main[0].length);
        } else {
            console.log("Sails disabled or no output");
        }

        if (res.diagnostics.convergenceHistory && res.diagnostics.convergenceHistory.length > 0) {
            console.log("Convergence History (first 1):");
            console.log(JSON.stringify(res.diagnostics.convergenceHistory[0]));
            console.log("Convergence History (last 3):");
            console.log(res.diagnostics.convergenceHistory.slice(-3));
        }
    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
}

test();
