/**
 * Solver Worker - Ejecuta simulaciones en segundo plano
 * Usa worker_threads para no bloquear el hilo principal
 */
const { parentPort, workerData } = require("worker_threads");
const { runPhase1Simulation } = require("../shared/rig/runPhase1.cjs");

// Interceptar console.log para capturar debug del solver
const originalLog = console.log;
const originalError = console.error;

let lastProgressTime = 0;
const MIN_PROGRESS_INTERVAL = 50; // ms entre actualizaciones

console.log = (...args) => {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");

  // Parsear métricas del solver desde los mensajes DEBUG
  if (msg.includes("DEBUG:") || msg.includes("Starting DR")) {
    const now = Date.now();
    if (now - lastProgressTime >= MIN_PROGRESS_INTERVAL) {
      lastProgressTime = now;

      const metrics = parseDebugMessage(msg);
      if (metrics) {
        parentPort.postMessage({ type: "progress", metrics });
      }
    }
  }

  // También enviar al log original para debugging
  originalLog.apply(console, args);
};

console.error = (...args) => {
  parentPort.postMessage({
    type: "log",
    level: "error",
    message: args.map(a => String(a)).join(" ")
  });
  originalError.apply(console, args);
};

function parseDebugMessage(msg) {
  const metrics = {};

  // Parsear "Energy=2.1961e+0"
  const energyMatch = msg.match(/Energy=([0-9.e+-]+)/i);
  if (energyMatch) {
    metrics.energy = parseFloat(energyMatch[1]);
  }

  // Parsear "GradMax=1.4700e+4"
  const gradMatch = msg.match(/GradMax=([0-9.e+-]+)/i);
  if (gradMatch) {
    metrics.gradMax = parseFloat(gradMatch[1]);
  }

  // Parsear "xNorm=0.0000e+0"
  const xNormMatch = msg.match(/xNorm=([0-9.e+-]+)/i);
  if (xNormMatch) {
    metrics.xNorm = parseFloat(xNormMatch[1]);
  }

  // Parsear "dt=0.002"
  const dtMatch = msg.match(/dt=([0-9.e+-]+)/i);
  if (dtMatch) {
    metrics.dt = parseFloat(dtMatch[1]);
  }

  // Parsear "maxIter=10000"
  const maxIterMatch = msg.match(/maxIter=([0-9]+)/i);
  if (maxIterMatch) {
    metrics.maxIter = parseInt(maxIterMatch[1]);
  }

  // Parsear "mRange=[1.00e+0, 2.04e+3]"
  const mRangeMatch = msg.match(/mRange=\[([0-9.e+-]+),\s*([0-9.e+-]+)\]/i);
  if (mRangeMatch) {
    metrics.massMin = parseFloat(mRangeMatch[1]);
    metrics.massMax = parseFloat(mRangeMatch[2]);
  }

  // Detectar tipo de mensaje
  if (msg.includes("Starting DR")) {
    metrics.solver = "DR";
    metrics.stage = "iterating";
  } else if (msg.includes("Initial state")) {
    metrics.stage = "step_start";
  }

  metrics.timestamp = Date.now();

  return Object.keys(metrics).length > 1 ? metrics : null;
}

// Ejecutar simulación
async function runSimulation() {
  const { payload, jobId } = workerData;

  parentPort.postMessage({
    type: "started",
    jobId,
    timestamp: Date.now()
  });

  try {
    const startTime = Date.now();
    const result = runPhase1Simulation(payload);
    const duration = Date.now() - startTime;

    parentPort.postMessage({
      type: "completed",
      jobId,
      result,
      duration,
      timestamp: Date.now()
    });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      jobId,
      error: {
        message: error.message,
        stack: error.stack
      },
      timestamp: Date.now()
    });
  }
}

runSimulation();
