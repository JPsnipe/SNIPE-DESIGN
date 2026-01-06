const { runPhase1Simulation } = require('./src/shared/rig/runPhase1.cjs');
const fs = require('fs');

async function runScenario(name, payload) {
    console.log(`\n=== Scenario: ${name} ===`);
    try {
        const res = runPhase1Simulation(payload);
        console.log("Converged:", res.converged);
        if (res.outputs && res.outputs.tensions) {
            const t = res.outputs.tensions;
            console.log(`Stay Tension: ${t.forestayN.toFixed(1)} N`);
            console.log(`Shroud Port: ${t.shroudPortN.toFixed(1)} N`);
            console.log(`Shroud Stbd: ${t.shroudStbdN.toFixed(1)} N`);
            return t.forestayN;
        }
    } catch (e) {
        console.error("ERROR:", e.message);
    }
    return null;
}

async function test() {
    const basePayload = {
        geometry: {
            mastLengthM: 6.5, partnersZM: 0.4, spreaderZM: 2.5, houndsZM: 4.9,
            shroudAttachZM: 4.9, chainplateXM: 0.55, chainplateYM: -0.05, bowYM: 1.5
        },
        controls: {
            spreaderLengthM: 0.415, spreaderSweepAftM: 0.1, shroudBaseDeltaM: 0,
            shroudDeltaL0PortM: 0.01, shroudDeltaL0StbdM: 0.01, jibHalyardTensionN: 1000,
            partnersKx: 25000, partnersKy: 25000,
            lockStayLength: true
        },
        load: { mode: "none", qLateralNpm: 0, qProfile: "uniform" },
        solver: {
            mastSegments: 50, pretensionSteps: 2, loadSteps: 1,
            maxIterations: 300, toleranceN: 1.0, cableCompressionEps: 1e-6,
            sailDamping: 5.0, sailDampingDecay: 0.95,
            drTimeStep: 0.002
        },
        sails: { enabled: false }
    };

    // 1. Base state (locked at 1000N)
    const t0 = await runScenario("Base State (Lock @ 1000N)", basePayload);

    // 2. Increase rake (move bow forward by 1cm)
    // In our coord system, bow is at +Y. Moving it further forward (+Y) should increase distance.
    const forwardPayload = JSON.parse(JSON.stringify(basePayload));
    forwardPayload.geometry.bowYM = 1.51;
    const t1 = await runScenario("Bow Move Forward +1cm", forwardPayload);

    // 3. Decrease rake (move bow aft by 1cm)
    const aftPayload = JSON.parse(JSON.stringify(basePayload));
    aftPayload.geometry.bowYM = 1.49;
    const t2 = await runScenario("Bow Move Aft -1cm", aftPayload);

    console.log("\n--- Verification Summary ---");
    if (t0 !== null && t1 !== null && t2 !== null) {
        if (t1 > t0) console.log("✅ Physical response: Tension INCREASED when lengthening path (bow forward).");
        else console.log("❌ Unexpected response: Tension did NOT increase when lengthening path.");

        if (t2 < t0) console.log("✅ Physical response: Tension DECREASED when shortening path (bow aft).");
        else console.log("❌ Unexpected response: Tension did NOT decrease when shortening path.");

        console.log(`T0: ${t0.toFixed(1)} N`);
        console.log(`T1 (Forward): ${t1.toFixed(1)} N (+ ${(t1 - t0).toFixed(1)} N)`);
        console.log(`T2 (Aft): ${t2.toFixed(1)} N (- ${(t0 - t2).toFixed(1)} N)`);
    } else {
        console.log("❌ Simulation failed in one or more scenarios.");
    }
}

test();
