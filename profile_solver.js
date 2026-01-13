const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');
const { getPresets } = require('./src/shared/rig/presets.cjs');

function profile() {
    console.log("Starting Profiling...");

    // Manual mapping to be safe
    const presetRaw = getPresets().find(p => p.name.includes("Standard"));

    const C = presetRaw.controls;
    const G = presetRaw.geometry;

    const payload = {
        geometry: {
            mastLengthM: G.mastLengthMm / 1000,
            partnersZM: G.partnersZMm / 1000,
            spreaderZM: G.spreaderZMm / 1000,
            houndsZM: G.houndsZMm / 1000,
            shroudAttachZM: G.shroudAttachZMm / 1000,
            chainplateXM: G.chainplateXMm / 1000,
            chainplateYM: G.chainplateYMm / 1000,
            bowYM: G.bowYMm / 1000
        },
        controls: {
            spreaderLengthM: C.spreaderLengthMm / 1000,
            spreaderSweepAftM: (C.spreaderLengthMm * Math.sin(C.spreaderAngleDeg * Math.PI / 180)) / 1000,
            shroudDeltaL0PortM: C.shroudDeltaPortMm / 1000,
            shroudDeltaL0StbdM: C.shroudDeltaStbdMm / 1000,
            jibHalyardTensionN: C.jibHalyardTensionkN * 1000,
            partnersKx: C.partnersKx_kNpm * 1000,
            partnersKy: C.partnersKy_kNpm * 1000,
            // Defaults that might be missing
            shroudBaseDeltaM: 0
        },
        load: presetRaw.load,
        stiffness: presetRaw.stiffness,
        solver: {
            ...presetRaw.solver,
            maxIterations: 50,
            drMaxIterations: 2000,
            useSegregatedFSI: true, // Force segregated
            pretensionSteps: 2,
            loadSteps: 2
        },
        sails: {
            enabled: true,
            windPressurePa: 50,
            windSign: 1,
            main: { enabled: true, mesh: { luffSegments: 12, chordSegments: 6 } },
            jib: { enabled: true, mesh: { luffSegments: 10, chordSegments: 4 } }
        }
    };

    const start = performance.now();
    try {
        const res = runPhase1Simulation(payload);
        const end = performance.now();
        console.log(`Total Time: ${(end - start).toFixed(2)} ms`);
        console.log(`Converged: ${res.converged}`);
        console.log(`Reason: ${res.reason || "N/A"}`);
        console.log(`History:`, res.convergenceHistory ? res.convergenceHistory.length : 0);

        if (res.outputs && res.outputs.tensions) {
            console.log("Tensions:", res.outputs.tensions);
        }

    } catch (e) {
        console.error("Error:", e.message);
        if (e.stack) console.error(e.stack);
    }
}

profile();
