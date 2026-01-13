const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');
const fs = require('fs');

async function test() {
    const logFile = 'test_segregated_output.txt';
    const log = (msg) => {
        fs.appendFileSync(logFile, msg + '\n');
        console.log(msg);
    };

    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

    try {
        const payload = {
            geometry: {
                mastLengthM: 6.5, partnersZM: 0.4, spreaderZM: 2.5, houndsZM: 4.9,
                shroudAttachZM: 4.9, chainplateXM: 0.55, chainplateYM: -0.05, bowYM: 1.511
            },
            controls: {
                spreaderLengthM: 0.415, spreaderSweepAftM: 0.1, shroudBaseDeltaM: 0,
                shroudDeltaL0PortM: 0, shroudDeltaL0StbdM: 0, jibHalyardTensionN: 1300,
                partnersKx: 25000, partnersKy: 25000,
                lockStayLength: true
            },
            load: { mode: "upwind", qLateralNpm: 45, qProfile: "triangular" },
            solver: {
                mastSegments: 20, pretensionSteps: 2, loadSteps: 4,
                maxIterations: 200, toleranceN: 20.0, cableCompressionEps: 1e-3,
                sailDamping: 5.0, sailDampingDecay: 0.95,
                useDynamicRelaxation: true,
                drTimeStep: 0.003,
                drMaxIterations: 2000,
                drMaxStepM: 0.002,
                useSegregatedFSI: false,  // Disable segregated for simpler test
                fsiIterations: 2
            },
            sails: {
                enabled: true,
                windPressurePa: 50,  // Moderate pressure for stability test
                windSign: 1,
                main: {
                    enabled: true,
                    draftDepth: 0.08,
                    draftPos: 0.4,
                    mesh: { luffSegments: 8, chordSegments: 3 }
                },
                jib: {
                    enabled: true,
                    draftDepth: 0.07,
                    draftPos: 0.35,
                    mesh: { luffSegments: 6, chordSegments: 3 }
                }
            }
        };

        log("Starting LIGHT Segregated Simulation...");
        const start = Date.now();
        const res = runPhase1Simulation(payload);
        const end = Date.now();
        log(`Simulation finished in ${(end - start) / 1000}s. Converged: ${res.converged}`);

        log("\n--- Final Tensions ---");
        if (res.outputs && res.outputs.tensions) {
            log(`Stay: ${res.outputs.tensions.forestayN.toFixed(1)} N`);
            log(`Shroud Port: ${res.outputs.tensions.shroudPortN.toFixed(1)} N`);
        }

        if (res.diagnostics.history) {
            log("\n--- Phase History ---");
            res.diagnostics.history.forEach(h => {
                log(`Phase: ${h.phase} | lambda: ${h.lambda.toFixed(2)} | Iter: ${h.iterations} | GradInf: ${h.gradInf.toExponential(2)}`);
            });
        }

    } catch (e) {
        log("ERROR: " + e.message);
        if (e.stack) log(e.stack);
    }
}

test();
