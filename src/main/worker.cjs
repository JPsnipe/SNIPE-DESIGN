const { parentPort, workerData } = require("worker_threads");
const { runPhase1Simulation } = require("../shared/rig/runPhase1.cjs");

try {
    const payload = workerData;
    const results = runPhase1Simulation(payload, (progress) => {
        parentPort.postMessage({ type: "progress", data: progress });
    });
    parentPort.postMessage({ type: "done", data: results });
} catch (err) {
    parentPort.postMessage({ type: "error", error: err.message });
}
