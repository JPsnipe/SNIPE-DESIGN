const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');
const fs = require('fs');

async function test() {
    const logFile = 'test_output.txt';
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
                shroudDeltaL0PortM: 0, shroudDeltaL0StbdM: 0, jibHalyardTensionN: 1000,
                partnersKx: 25000, partnersKy: 25000,
                lockStayLength: true
            },
            load: { mode: "upwind", qLateralNpm: 45, qProfile: "triangular" },
            solver: {
                mastSegments: 50, pretensionSteps: 1, loadSteps: 1,
                maxIterations: 100, toleranceN: 1.0, cableCompressionEps: 1e-6,
                sailDamping: 5.0, sailDampingDecay: 0.95,
                drTimeStep: 0.002
            },
            sails: {
                enabled: false, windPressurePa: 0, windSign: 1
            }
        };

        log("Starting Simulation...");
        const res = runPhase1Simulation(payload);
        log("Simulation finished. Converged: " + res.converged);

        if (res.convergenceHistory && res.convergenceHistory.length > 0) {
            log("\n--- Convergence History (Last 5) ---");
            const hist = res.convergenceHistory;
            for (let i = Math.max(0, hist.length - 5); i < hist.length; i++) {
                const h = hist[i];
                let mStr = "";
                if (h.membranes) {
                    mStr = ` | Stress: ${h.membranes.maxPrincipalStress?.toExponential(2)} | Taut: ${h.membranes.tautCount}/${h.membranes.elementCount}`;
                }
                log(`Iter ${h.iter}: GradInf=${h.residual.toExponential(2)} | Energy=${h.energy.toExponential(2)}${mStr}`);
            }
        }

        if (res.outputs && res.outputs.tensions) {
            log("\n--- Final Tensions ---");
            log(`Stay: ${res.outputs.tensions.forestayN.toFixed(1)} N (Locked at ~1000 N, now subject to load)`);
            log(`Shroud Port: ${res.outputs.tensions.shroudPortN.toFixed(1)} N`);
            log(`Shroud Stbd: ${res.outputs.tensions.shroudStbdN.toFixed(1)} N`);
        }
    } catch (e) {
        log("ERROR: " + e.message);
        if (e.stack) log(e.stack);
    }
}

test();
