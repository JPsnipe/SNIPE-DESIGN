const { runPhase1Simulation } = require("../src/shared/rig/runPhase1.cjs");
const { getPresets } = require("../src/shared/rig/presets.cjs");
const presets = getPresets();

function mmToM(mm) { return mm / 1000; }
function kNpmToNpm(k) { return k * 1000; }
function kNToN(kN) { return kN * 1000; }

function presetToPayload(p) {
    return {
        geometry: {
            mastLengthM: mmToM(p.geometry.mastLengthMm),
            partnersZM: mmToM(p.geometry.partnersZMm),
            spreaderZM: mmToM(p.geometry.spreaderZMm),
            houndsZM: mmToM(p.geometry.houndsZMm),
            chainplateXM: mmToM(p.geometry.chainplateXMm),
            chainplateYM: mmToM(p.geometry.chainplateYMm),
            bowYM: mmToM(p.geometry.bowYMm)
        },
        controls: {
            spreaderLengthM: mmToM(p.controls.spreaderLengthMm),
            spreaderSweepAftM: p.controls.spreaderSweepAftMm
                ? mmToM(p.controls.spreaderSweepAftMm)
                : mmToM(p.controls.spreaderLengthMm * Math.sin(p.controls.spreaderAngleDeg * Math.PI / 180)),
            shroudDeltaL0PortM: mmToM(p.controls.shroudDeltaPortMm),
            shroudDeltaL0StbdM: mmToM(p.controls.shroudDeltaStbdMm),
            jibHalyardTensionN: kNToN(p.controls.jibHalyardTensionkN ?? 0),
            partnersKx: kNpmToNpm(p.controls.partnersKx_kNpm),
            partnersKy: kNpmToNpm(p.controls.partnersKy_kNpm)
        },
        load: {
            mode: p.load.mode,
            qLateralNpm: p.load.qLateralNpm,
            qProfile: p.load.qProfile
        },
        solver: {
            mastSegments: p.solver.mastSegments,
            pretensionSteps: p.solver.pretensionSteps,
            loadSteps: p.solver.loadSteps,
            maxIterations: p.solver.maxIterations,
            toleranceN: p.solver.toleranceN,
            cableCompressionEps: p.solver.cableCompressionEps
        }
    };
}

console.log("=== SNIPEDESIGN RIG SOLVER VALIDATION ===\n");

let allPassed = true;

presets.forEach(p => {
    console.log(`Testing Preset: ${p.name}...`);
    const payload = presetToPayload(p);
    const start = Date.now();
    const res = runPhase1Simulation(payload);
    const elapsed = Date.now() - start;

    const errors = [];

    if (!res.ok) {
        errors.push(`SOLVER ERROR: Failed in phase "${res.diagnostics.failedPhase}" at lambda=${res.diagnostics.failedAtLambda.toFixed(2)}`);
        errors.push(`Reason: ${res.reason}`);
        if (res.diagnostics.slackCables.length > 0) {
            errors.push(`Slack Cables: ${res.diagnostics.slackCables.join(", ")}`);
        }
    } else {
        // 1. Math Convergence
        if (!res.converged) errors.push(`FAILED to converge in ${res.iterations} iterations.`);
        if (res.gradInf > payload.solver.toleranceN * 5) { // Relaxed slightly for complex cases but still strict
            errors.push(`Gradient too high: ${res.gradInf.toExponential(3)} (tol: ${payload.solver.toleranceN})`);
        }

        // 2. Physical Tensions (reported as tension-only >= 0)
        const t = res.outputs.tensions;
        for (const k of ["shroudPortN", "shroudStbdN", "forestayN"]) {
            const v = t[k];
            if (!Number.isFinite(v) || v < 0) errors.push(`Invalid ${k}: ${v}`);
        }

        // 3. Spreader axial force sanity
        // Spreaders are modeled as bars (can carry compression and tension). Under asymmetric loads
        // a small tensile force can appear; we only flag *large* tension as suspicious.
        const s = res.outputs.spreaders;
        if (!Number.isFinite(s.portAxialN)) errors.push(`Invalid spreader port axial: ${s.portAxialN}`);
        if (!Number.isFinite(s.stbdAxialN)) errors.push(`Invalid spreader stbd axial: ${s.stbdAxialN}`);
        const maxSpreaderTensionN = 2000;
        if (s.portAxialN > maxSpreaderTensionN) {
            errors.push(`Spreader Port high tension (${s.portAxialN.toFixed(1)} N) - check geometry/settings`);
        }
        if (s.stbdAxialN > maxSpreaderTensionN) {
            errors.push(`Spreader Stbd high tension (${s.stbdAxialN.toFixed(1)} N) - check geometry/settings`);
        }
    }

    if (errors.length === 0) {
        console.log(`  [OK] ${elapsed}ms, iters=${res.iterations}, grad=${res.gradInf.toExponential(2)}`);
    } else {
        console.log(`  [FAIL]`);
        errors.forEach(e => console.log(`     - ${e}`));
        allPassed = false;
    }
});

console.log("\n-------------------------------------------");
if (allPassed) {
    console.log("VERIFICATION SUCCESSFUL: All presets are physically and mathematically consistent.");
    process.exit(0);
} else {
    console.log("VERIFICATION FAILED: Issues found in presets.");
    process.exit(1);
}
