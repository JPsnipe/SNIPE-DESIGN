/* global snipeApi */

// Web bridge for non-Electron environment
if (typeof snipeApi === "undefined") {
  window.snipeApi = {
    listPresets: async () => {
      const resp = await fetch("/api/presets", {
        headers: { "ngrok-skip-browser-warning": "true" }
      });
      return resp.json();
    },
    runPhase1: async (payload) => {
      const resp = await fetch("/api/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        body: JSON.stringify(payload)
      });
      return resp.json();
    },
    // Async version for web (fallback to sync)
    runPhase1Async: async (payload) => {
      const resp = await fetch("/api/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true"
        },
        body: JSON.stringify(payload)
      });
      return resp.json();
    },
    cancelSimulation: async () => ({ cancelled: false }),
    getSimulationStatus: async () => ({ running: false }),
    onSimulationProgress: () => () => {},
    onSimulationStarted: () => () => {},
    exportJson: async ({ suggestedName, data }) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
    },
    exportCsv: async ({ suggestedName, results }) => {
      // Very basic CSV export for web
      const csv = "z,x,y\n" + (results.outputs.mastCurveLoaded || []).map(p => `${p.z},${p.x},${p.y}`).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
    }
  };
}

// Live metrics state
let liveMetricsState = {
  startTime: null,
  elapsedTimer: null,
  lastEnergy: null,
  unsubProgress: null,
  unsubStarted: null
};

function showLiveMetrics() {
  const panel = byId("liveMetricsPanel");
  const cancelBtn = byId("cancelBtn");
  const runBtn = byId("runBtn");
  if (panel) panel.hidden = false;
  if (cancelBtn) cancelBtn.hidden = false;
  if (runBtn) runBtn.disabled = true;

  liveMetricsState.startTime = Date.now();
  liveMetricsState.lastEnergy = null;

  // Start elapsed time counter
  updateElapsedTime();
  liveMetricsState.elapsedTimer = setInterval(updateElapsedTime, 100);
}

function hideLiveMetrics() {
  const panel = byId("liveMetricsPanel");
  const cancelBtn = byId("cancelBtn");
  const runBtn = byId("runBtn");
  if (panel) panel.hidden = true;
  if (cancelBtn) cancelBtn.hidden = true;
  if (runBtn) runBtn.disabled = false;

  if (liveMetricsState.elapsedTimer) {
    clearInterval(liveMetricsState.elapsedTimer);
    liveMetricsState.elapsedTimer = null;
  }

  // Cleanup subscriptions
  if (liveMetricsState.unsubProgress) {
    liveMetricsState.unsubProgress();
    liveMetricsState.unsubProgress = null;
  }
  if (liveMetricsState.unsubStarted) {
    liveMetricsState.unsubStarted();
    liveMetricsState.unsubStarted = null;
  }
}

function updateElapsedTime() {
  if (!liveMetricsState.startTime) return;
  const elapsed = (Date.now() - liveMetricsState.startTime) / 1000;
  const el = byId("liveElapsed");
  if (el) el.textContent = elapsed.toFixed(1) + "s";
}

function updateLiveMetrics(metrics) {
  // Energy
  const energyEl = byId("liveEnergy");
  if (energyEl && metrics.energy !== undefined) {
    const formatted = metrics.energy.toExponential(3);
    energyEl.textContent = formatted;

    // Color based on trend
    if (liveMetricsState.lastEnergy !== null) {
      if (metrics.energy < liveMetricsState.lastEnergy) {
        energyEl.classList.add("improving");
        energyEl.classList.remove("degrading");
      } else if (metrics.energy > liveMetricsState.lastEnergy * 1.1) {
        energyEl.classList.add("degrading");
        energyEl.classList.remove("improving");
      }
    }
    liveMetricsState.lastEnergy = metrics.energy;
  }

  // Gradient Max
  const gradEl = byId("liveGradMax");
  if (gradEl && metrics.gradMax !== undefined) {
    gradEl.textContent = metrics.gradMax.toExponential(2);
  }

  // dt
  const dtEl = byId("liveDt");
  if (dtEl && metrics.dt !== undefined) {
    dtEl.textContent = metrics.dt.toExponential(2);
  }

  // Mass range
  const massEl = byId("liveMassRange");
  if (massEl && metrics.massMin !== undefined && metrics.massMax !== undefined) {
    massEl.textContent = `[${metrics.massMin.toExponential(1)}, ${metrics.massMax.toExponential(1)}]`;
  }

  // Progress bar (estimate based on energy reduction)
  const progressEl = byId("liveProgressFill");
  if (progressEl && metrics.energy !== undefined && metrics.gradMax !== undefined) {
    // Rough progress estimate: log scale of gradient reduction
    const logGrad = Math.log10(Math.max(1, metrics.gradMax));
    const progress = Math.max(0, Math.min(100, (10 - logGrad) * 10));
    progressEl.style.width = progress + "%";
  }
}

const rigView = { yaw: -1.0, pitch: 0.4, zoom: 1.0 };
let rigCanvasEl = null;
let rigStatusEl = null;
let rigSettingsEl = null;
let rigChangesEl = null;
let rigScene = null;
let lastConvergenceHistory = [];
let lastConvergenceTol = null;
let presetsCache = [];
let currentPresetIdx = 0;
let lastResults = null;

function byId(id) {
  const el = document.getElementById(id);
  // if (!el) throw new Error(`Missing element #${id}`); // Lofter caution: don't throw if missing, some might be temporary
  return el;
}

function reorganizeResultsUi() {
  const forcesOverlay = byId("rigForcesOverlay");
  if (forcesOverlay) {
    const tensionsCard = byId("card-tensions");
    const spreaderCard = byId("card-spreader");
    if (tensionsCard) forcesOverlay.appendChild(tensionsCard);
    if (spreaderCard) forcesOverlay.appendChild(spreaderCard);
  }

  const debugLeft = byId("debugLeft");
  const debugRight = byId("debugRight");
  if (debugLeft) {
    const convergenceCard = byId("card-convergence");
    const equilibriumCard = byId("card-equilibrium");
    if (convergenceCard) debugLeft.appendChild(convergenceCard);
    if (equilibriumCard) debugLeft.appendChild(equilibriumCard);
  }
  if (debugRight) {
    const plotCanvas = byId("plotConvergence");
    const plotCard = plotCanvas ? plotCanvas.closest(".plotCard") : null;
    if (plotCard) debugRight.appendChild(plotCard);
  }

  const resultsLayout = document.querySelector(".results-layout");
  if (resultsLayout) resultsLayout.style.display = "none";
}

function setResValue(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setStatus(id, state, text) {
  const el = byId(id);
  if (!el) return;
  el.textContent = text;
  el.className = "status-badge " + (state === "success" ? "status-success" : state === "warning" ? "status-warning" : "status-error");
}

function setValue(id, value) {
  byId(id).value = String(value);
}

function getNumber(id) {
  const raw = byId(id).value;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${id}`);
  return n;
}

function getOptionalNumber(id) {
  const el = byId(id);
  if (!el) return null;
  const raw = String(el.value ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${id}`);
  return n;
}

function mmToM(mm) {
  return mm / 1000;
}

function kNpmToNpm(kNpm) {
  return kNpm * 1000;
}

function kNToN(kN) {
  return kN * 1000;
}

function formatN(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)} kN`;
  return `${n.toFixed(1)} N`;
}

function formatBool(b) {
  return b ? "si" : "no";
}

function clampValue(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function readSectionArray(prefixDepth, prefixPos, count, fallbackDepth, fallbackPos) {
  const depth = [];
  const pos = [];
  const n = clampValue(Math.trunc(count), 2, 6);
  for (let i = 1; i <= 6; i++) {
    const dEl = byId(`${prefixDepth}${i}`);
    const pEl = byId(`${prefixPos}${i}`);
    const dVal = dEl ? Number(dEl.value) : NaN;
    const pVal = pEl ? Number(pEl.value) : NaN;
    depth.push(Number.isFinite(dVal) ? dVal / 100 : fallbackDepth);
    pos.push(Number.isFinite(pVal) ? pVal / 100 : fallbackPos);
  }
  return {
    depth: depth.slice(0, n),
    pos: pos.slice(0, n)
  };
}

function setSectionRowsVisible(prefixDepth, prefixPos, count) {
  const raw = Number(count);
  const n = Number.isFinite(raw) ? clampValue(Math.trunc(raw), 2, 6) : 2;
  for (let i = 1; i <= 6; i++) {
    const depthEl = byId(`${prefixDepth}${i}`);
    const posEl = byId(`${prefixPos}${i}`);
    const row = depthEl?.closest(".section-row") || posEl?.closest(".section-row");
    if (!row) continue;
    const visible = i <= n;
    row.hidden = !visible;
    if (depthEl) depthEl.disabled = !visible;
    if (posEl) posEl.disabled = !visible;
  }
}

function clearSectionCustomFlags(prefixDepth, prefixPos) {
  for (let i = 1; i <= 6; i++) {
    const depthEl = byId(`${prefixDepth}${i}`);
    const posEl = byId(`${prefixPos}${i}`);
    if (depthEl) delete depthEl.dataset.custom;
    if (posEl) delete posEl.dataset.custom;
  }
}

function syncSectionCustomFlag(el, globalValue, epsilon = 1e-6) {
  if (!el) return;
  const v = Number(el.value);
  if (!Number.isFinite(v)) {
    delete el.dataset.custom;
    return;
  }
  if (Math.abs(v - globalValue) <= epsilon) delete el.dataset.custom;
  else el.dataset.custom = "1";
}

function syncSectionsFromGlobal(prefix, globalValue, epsilon = 1e-6) {
  if (!Number.isFinite(globalValue)) return;
  for (let i = 1; i <= 6; i++) {
    const el = byId(`${prefix}${i}`);
    if (!el) continue;
    if (el.dataset.custom === "1") continue;
    el.value = String(globalValue);
  }
  for (let i = 1; i <= 6; i++) {
    const el = byId(`${prefix}${i}`);
    syncSectionCustomFlag(el, globalValue, epsilon);
  }
}

function debounce(fn, ms) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

function initColumnResizer() {
  const handle = document.getElementById("colResizer");
  const layout = document.querySelector(".layout");
  if (!handle || !layout) return;

  const rootStyle = document.documentElement.style;
  const minPx = 360;
  const maxPx = 900;
  const defaultPx = 500;

  const setWidth = (px) => {
    const clamped = Math.max(minPx, Math.min(maxPx, px));
    rootStyle.setProperty("--sidebar-width", `${clamped}px`);
  };

  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    const newW = e.clientX - rect.left;
    setWidth(newW);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
  };

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    onMove(e);
  });

  handle.addEventListener("pointermove", onMove);
  ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
    handle.addEventListener(evt, stop)
  );

  handle.addEventListener("dblclick", () => setWidth(defaultPx));

  setWidth(
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) ||
    defaultPx
  );
}

function sampleCurveAtZ(curve, targetZ) {
  if (!Array.isArray(curve) || curve.length === 0) return null;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    const zMin = Math.min(a.z, b.z);
    const zMax = Math.max(a.z, b.z);
    if (targetZ >= zMin && targetZ <= zMax) {
      const t = Math.abs(b.z - a.z) < 1e-9 ? 0 : (targetZ - a.z) / (b.z - a.z);
      // Interpolar también z para mantener consistencia con la curva deformada
      const zInterp = lerp(a.z, b.z, t);
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: zInterp };
    }
  }
  return curve[curve.length - 1];
}

// Encontrar el punto más cercano en Z de una curva (sin interpolación)
function findClosestPointAtZ(curve, targetZ) {
  if (!Array.isArray(curve) || curve.length === 0) return null;
  let closest = curve[0];
  let minDist = Math.abs(curve[0].z - targetZ);
  for (const p of curve) {
    const dist = Math.abs(p.z - targetZ);
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  }
  return closest;
}

function toRenderVec(p) {
  // Map model axes to view axes (y up on screen)
  return { x: p.x, y: p.z, z: p.y };
}

function rotateVec(v, yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // yaw around vertical (y) axis
  const x1 = v.x * cy + v.z * sy;
  const z1 = -v.x * sy + v.z * cy;

  // pitch around x axis
  const y2 = v.y * cp - z1 * sp;
  const z2 = v.y * sp + z1 * cp;

  return { x: x1, y: y2, z: z2 };
}

function buildProjector(bounds, view, canvas) {
  if (!canvas) return null;

  // FIXED SCALE: Use a fixed world height (e.g. 7.5m) to avoid jitter during rotation
  const fixedWorldHeight = 7.5;
  const pad = 20;

  // Base scale calculation: how many pixels per meter?
  // We want the 7.5m mast to fit in the canvas height minus padding
  const baseScale = (canvas.height - pad * 2) / fixedWorldHeight;
  const scale = baseScale * (view.zoom ?? 1.0);

  // FIXED CENTER: Center rotation on the middle of the mast in world space
  // Render axes: x=Lateral, y=Height, z=Longitudinal
  const worldCenter = { x: 0, y: 3.5, z: 0 };
  const projectedCenter = rotateVec(worldCenter, view.yaw, view.pitch);

  return {
    project(p) {
      const r = rotateVec(toRenderVec(p), view.yaw, view.pitch);
      return {
        // Project relative to the projected world center, then shift to canvas center
        x: canvas.width / 2 + (r.x - projectedCenter.x) * scale,
        y: canvas.height / 2 - (r.y - projectedCenter.y) * scale,
        depth: r.z
      };
    }
  };
}

function drawRigScene(scene) {
  if (!rigCanvasEl) return;
  const ctx = rigCanvasEl.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, rigCanvasEl.width, rigCanvasEl.height);

  if (!scene) {
    setRigStatus("Simula para ver la jarcia en 3D");
    return;
  }

  const projector = buildProjector(scene.bounds, rigView, rigCanvasEl);
  if (!projector) {
    setRigStatus("Sin datos 3D disponibles");
    return;
  }

  setRigStatus("");

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, rigCanvasEl.height - 24);
  ctx.lineTo(rigCanvasEl.width - 24, rigCanvasEl.height - 24);
  ctx.stroke();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const line of scene.lines) {
    if (!line.points?.length) continue;
    ctx.setLineDash(line.dash ?? []);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width ?? 1;
    ctx.beginPath();
    line.points.forEach((p, idx) => {
      const proj = projector.project(p);
      if (idx === 0) ctx.moveTo(proj.x, proj.y);
      else ctx.lineTo(proj.x, proj.y);
    });
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.fillStyle = "#e7edf7";
  ctx.font = "11px ui-monospace, monospace";
  for (const marker of scene.markers ?? []) {
    const proj = projector.project(marker.point);
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(marker.label, proj.x + 6, proj.y - 6);
  }

}

function buildRigScene(payload, results) {
  if (!payload || !results?.outputs) return null;

  const g = payload.geometry;
  const c = payload.controls;
  const relaxed = results.outputs.mastCurveRelaxed ?? [];
  const prebend = results.outputs.mastCurvePrebend ?? [];
  const loaded = results.outputs.mastCurveLoaded ?? [];
  if (prebend.length === 0 || loaded.length === 0) return null;

  // Sin amplificación visual - escala 1:1
  const visualAmp = 1;
  const loadedVisual = loaded;

  // Calculate max deflection from reference line
  let maxDeflection = 0;
  for (const pt of loaded) {
    const dx = Math.abs(pt.x ?? 0);
    const dy = Math.abs(pt.y ?? 0);
    maxDeflection = Math.max(maxDeflection, Math.sqrt(dx * dx + dy * dy));
  }

  const topLoaded = loadedVisual[loadedVisual.length - 1];
  // Usar punto más cercano de la curva AMPLIFICADA para que la jarcia esté sobre ella
  const houndsLoaded = findClosestPointAtZ(loadedVisual, g.houndsZM) ?? sampleCurveAtZ(loadedVisual, g.houndsZM) ?? topLoaded;
  const shroudAttachLoaded = findClosestPointAtZ(loadedVisual, g.shroudAttachZM ?? g.houndsZM) ?? sampleCurveAtZ(loadedVisual, g.shroudAttachZM ?? g.houndsZM) ?? houndsLoaded;

  const deckOutline = [
    { x: -g.chainplateXM, y: g.chainplateYM, z: 0 },
    { x: g.chainplateXM, y: g.chainplateYM, z: 0 },
    { x: g.chainplateXM * 1.05, y: g.bowYM, z: 0 },
    { x: -g.chainplateXM * 1.05, y: g.bowYM, z: 0 },
    { x: -g.chainplateXM, y: g.chainplateYM, z: 0 }
  ];

  // Usar puntos de la curva AMPLIFICADA para conexiones visuales
  const spreaderBase =
    findClosestPointAtZ(loadedVisual, g.spreaderZM) ?? sampleCurveAtZ(loadedVisual, g.spreaderZM) ?? { x: 0, y: 0, z: g.spreaderZM };
  const partnersBase =
    findClosestPointAtZ(loadedVisual, g.partnersZM) ?? sampleCurveAtZ(loadedVisual, g.partnersZM) ?? { x: 0, y: 0, z: g.partnersZM };

  // Posiciones de referencia de las crucetas (geometría inicial sin deformación)
  const ySweep = -c.spreaderSweepAftM;
  const xOut = Math.sqrt(Math.max(0, c.spreaderLengthM * c.spreaderLengthM - ySweep * ySweep));
  const portTipRef = { x: -xOut, y: ySweep, z: g.spreaderZM };
  const stbdTipRef = { x: xOut, y: ySweep, z: g.spreaderZM };

  // Usar posiciones REALES de las crucetas del solver si existen
  const spreaderOutput = results.outputs.spreaders;
  let portTip, stbdTip;

  if (spreaderOutput?.tipPort && spreaderOutput?.tipStbd) {
    // Posiciones reales del solver - amplificar solo la DEFLEXIÓN, no la posición completa
    const portDeflection = {
      x: spreaderOutput.tipPort.x - portTipRef.x,
      y: spreaderOutput.tipPort.y - portTipRef.y
    };
    const stbdDeflection = {
      x: spreaderOutput.tipStbd.x - stbdTipRef.x,
      y: spreaderOutput.tipStbd.y - stbdTipRef.y
    };
    portTip = {
      x: portTipRef.x + portDeflection.x * visualAmp,
      y: portTipRef.y + portDeflection.y * visualAmp,
      z: spreaderOutput.tipPort.z
    };
    stbdTip = {
      x: stbdTipRef.x + stbdDeflection.x * visualAmp,
      y: stbdTipRef.y + stbdDeflection.y * visualAmp,
      z: spreaderOutput.tipStbd.z
    };
  } else {
    // Fallback: usar posición base del mástil amplificada + offset geométrico
    portTip = { x: spreaderBase.x - xOut, y: spreaderBase.y + ySweep, z: spreaderBase.z };
    stbdTip = { x: spreaderBase.x + xOut, y: spreaderBase.y + ySweep, z: spreaderBase.z };
  }
  const chainPort = { x: -g.chainplateXM, y: g.chainplateYM, z: 0 };
  const chainStbd = { x: g.chainplateXM, y: g.chainplateYM, z: 0 };
  const bow = { x: 0, y: g.bowYM, z: 0 };
  const markers = [];

  const sailBounds = [];
  const sailsRelaxed = results.outputs?.sails?.relaxed ?? null;
  const sailsLoaded = results.outputs?.sails?.loaded ?? null;
  const toPoint = (p) => ({ x: p[0], y: p[1], z: p[2] });

  let forestayPoints = [houndsLoaded, bow];
  if (sailsLoaded?.jib) {
    const jibGrid = sailsLoaded.jib;
    // La primera columna (index 0) del grid del foque es el gratil (luff)
    // El orden en sailsPhase1_3d es de abajo (stayBottomId) hacia arriba (jibHeadNodeId)
    const luffPoints = jibGrid.map(row => toPoint(row[0]));
    // El stay continua desde el jibHead hasta el houndsLoaded
    forestayPoints = [...luffPoints, houndsLoaded];
  }

  const cc = results.outputs.cableCurves || {};
  let forestayPointsPath = forestayPoints;
  if (cc.stay_jib?.length > 0) {
    forestayPointsPath = [houndsLoaded, ...cc.stay_jib.map(p => ({ x: p.x, y: p.y, z: p.z })), bow];
  }

  let shPortPoints = [shroudAttachLoaded, portTip, chainPort];
  if (cc.shroud_port?.length > 0) {
    const up = cc.shroud_port.filter(n => n.name.includes("_up_")).map(p => ({ x: p.x, y: p.y, z: p.z }));
    const low = cc.shroud_port.filter(n => n.name.includes("_low_")).map(p => ({ x: p.x, y: p.y, z: p.z }));
    shPortPoints = [shroudAttachLoaded, ...up, portTip, ...low, chainPort];
  }

  let shStbdPoints = [shroudAttachLoaded, stbdTip, chainStbd];
  if (cc.shroud_stbd?.length > 0) {
    const up = cc.shroud_stbd.filter(n => n.name.includes("_up_")).map(p => ({ x: p.x, y: p.y, z: p.z }));
    const low = cc.shroud_stbd.filter(n => n.name.includes("_low_")).map(p => ({ x: p.x, y: p.y, z: p.z }));
    shStbdPoints = [shroudAttachLoaded, ...up, stbdTip, ...low, chainStbd];
  }

  // Generar curva de referencia RECTA (geometría original sin deformación)
  const referenceStraight = relaxed.map(p => ({ x: 0, y: 0, z: p.z }));

  // NOTA: En el panel 3D mostramos:
  // - Referencia recta (línea punteada azul clara) para comparar
  // - Mástil CARGADO (línea verde gruesa) que es el estado deformado con la jarcia conectada
  // Si la deflexión es muy pequeña, se amplifica visualmente para que sea perceptible
  const lines = [
    { name: "deck", points: deckOutline, color: "rgba(255,255,255,0.12)", width: 1, dash: [5, 4] },
    { name: "reference", points: referenceStraight, color: "#479ef5", width: 2, dash: [4, 6] },  // Azul - referencia recta
    { name: "loaded", points: loadedVisual, color: "#8dfa46", width: 3.5 },  // Verde - mástil deformado (amplificado si necesario)
    { name: "forestay", points: forestayPointsPath, color: "rgba(255,255,255,0.26)", width: 1.4 },
    { name: "shroud_port", points: shPortPoints, color: "rgba(255,255,255,0.28)", width: 1.3 },
    { name: "shroud_stbd", points: shStbdPoints, color: "rgba(255,255,255,0.28)", width: 1.3 },
    { name: "spreader_port", points: [spreaderBase, portTip], color: "#ffcc00", width: 2.2 },
    { name: "spreader_stbd", points: [spreaderBase, stbdTip], color: "#ffcc00", width: 2.2 },
    { name: "partners", points: [{ x: 0, y: 0, z: 0 }, partnersBase], color: "rgba(255,255,255,0.18)", width: 1 }
  ];
  const addSailGrid = (grid, prefix, color) => {
    if (!Array.isArray(grid) || grid.length < 2) return;
    const rows = grid.map((row) => (Array.isArray(row) ? row.map(toPoint) : [])).filter((r) => r.length > 1);
    if (!rows.length) return;

    rows.forEach((row, idx) => {
      lines.push({ name: `${prefix}_row_${idx}`, points: row, color, width: 1.5 });
      sailBounds.push(...row);
    });

    const nCols = rows[0].length;
    for (let j = 0; j < nCols; j++) {
      const col = rows.map((r) => r[j]).filter(Boolean);
      if (col.length > 1) {
        lines.push({ name: `${prefix}_col_${j}`, points: col, color, width: 1.5 });
        sailBounds.push(...col);
      }
    }
  };

  // Velas RELAJADAS (sin carga de viento) - referencia en color tenue
  if (sailsRelaxed?.main) {
    addSailGrid(sailsRelaxed.main, "sail_main_ref", "rgba(100, 200, 255, 0.25)");
  }
  if (sailsRelaxed?.jib) {
    addSailGrid(sailsRelaxed.jib, "sail_jib_ref", "rgba(255, 255, 255, 0.25)");
  }

  // Velas CARGADAS (bajo presión de viento) - estado deformado
  if (sailsLoaded?.main) {
    addSailGrid(sailsLoaded.main, "sail_main", "rgba(100, 200, 255, 0.8)");
    const mainGrid = sailsLoaded.main;
    const mainClew = toPoint(mainGrid[0][mainGrid[0].length - 1]);
    markers.push({ label: "Main Clew", point: mainClew });
  }
  if (sailsLoaded?.jib) {
    addSailGrid(sailsLoaded.jib, "sail_jib", "rgba(255, 255, 255, 0.7)");
    const jibGrid = sailsLoaded.jib;
    const jibClew = toPoint(jibGrid[0][jibGrid[0].length - 1]);
    markers.push({ label: "Jib Clew", point: jibClew });
  }

  // Pressure force vectors (P × normal) for debugging
  const showPressureVectors = byId("showPressureVectors")?.checked;
  if (showPressureVectors && payload.sails?.windPressurePa > 0) {
    const pressure = payload.sails.windPressurePa;
    const windSign = Number(payload.sails.windSign ?? 1);
    const addPressureVectors = (grid, prefix, color) => {
      if (!Array.isArray(grid) || grid.length < 2) return;
      for (let i = 0; i < grid.length - 1; i++) {
        for (let j = 0; j < grid[i].length - 1 && j < grid[i + 1].length - 1; j++) {
          const a = grid[i][j], b = grid[i + 1][j];
          const c = grid[i + 1][j + 1], d = grid[i][j + 1];
          if (!a || !b || !c || !d) continue;

          // Panel center
          const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
          const cy = (a[1] + b[1] + c[1] + d[1]) / 4;
          const cz = (a[2] + b[2] + c[2] + d[2]) / 4;

          // Cross product for normal (triangle a-b-c)
          const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const nx = e1[1] * e2[2] - e1[2] * e2[1];
          const ny = e1[2] * e2[0] - e1[0] * e2[2];
          const nz = e1[0] * e2[1] - e1[1] * e2[0];
          const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nLen < 1e-9) continue;

          // Force vector = pressure × (area direction) × windSign
          const scale = 0.01 * pressure * windSign; // Increased scale for visibility
          const fx = scale * nx / nLen;
          const fy = scale * ny / nLen;
          const fz = scale * nz / nLen;

          const start = toPoint([cx, cy, cz]);
          const end = toPoint([cx + fx, cy + fy, cz + fz]);

          lines.push({
            name: `${prefix}_press_${i}_${j}`,
            points: [start, end],
            color: color,
            width: 2.5
          });

          // Arrowhead: small perpendicular lines at the tip
          const arrowLen = 0.03;
          const dirX = fx / (Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-9);
          const dirY = fy / (Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-9);
          const dirZ = fz / (Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-9);
          // Perpendicular in XY plane
          const perpX = -dirY * arrowLen;
          const perpY = dirX * arrowLen;
          const tipBack = 0.7; // How far back the arrowhead base is
          const baseX = cx + fx * tipBack;
          const baseY = cy + fy * tipBack;
          const baseZ = cz + fz * tipBack;
          const arrow1 = toPoint([baseX + perpX, baseY + perpY, baseZ]);
          const arrow2 = toPoint([baseX - perpX, baseY - perpY, baseZ]);
          lines.push({
            name: `${prefix}_arrow_${i}_${j}`,
            points: [arrow1, end, arrow2],
            color: color,
            width: 2
          });
        }
      }
    };
    if (sailsLoaded?.main) addPressureVectors(sailsLoaded.main, "main", "#ff5555");
    if (sailsLoaded?.jib) addPressureVectors(sailsLoaded.jib, "jib", "#ff8888");
  }

  // Draw Boom, Vang and Mainsheet if available
  if (sailsLoaded?.main) {
    const mainGrid = sailsLoaded.main;
    const boomNodes = mainGrid[0].map(toPoint);
    lines.push({ name: "boom", points: boomNodes, color: "#ffffff", width: 2.5 });

    // Vang: Using the same ratio as in sailsPhase1_2d.cjs (approx 1/3)
    const vangBoomIdx = Math.round((boomNodes.length - 1) * 0.3);
    const vangBoomPt = boomNodes[vangBoomIdx];
    const vangMastZ = boomNodes[0].z - 0.15;
    const vangMastPt = sampleCurveAtZ(loaded, vangMastZ) ?? partnersBase;
    lines.push({ name: "vang", points: [vangBoomPt, vangMastPt], color: "rgba(255,255,255,0.85)", width: 2.2 });
  }

  markers.push(
    { label: "Masthead", point: topLoaded },
    { label: "Spreader", point: spreaderBase },
    { label: "Partners", point: partnersBase },
    { label: "Bow", point: bow }
  );

  const bounds = [
    ...deckOutline,
    ...prebend,
    ...loaded,
    ...sailBounds,
    bow,
    chainPort,
    chainStbd,
    portTip,
    stbdTip,
    { x: 0, y: 0, z: 0 }
  ];

  return { lines, markers, bounds, visualAmp, maxDeflection };
}

function deltaLabel(currentMm, baseMm) {
  if (!Number.isFinite(currentMm) || !Number.isFinite(baseMm)) return "";
  const delta = currentMm - baseMm;
  if (Math.abs(delta) < 0.05) return "";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)} mm vs preset`;
}

function deltaLabelkN(currentkN, basekN) {
  if (!Number.isFinite(currentkN) || !Number.isFinite(basekN)) return "";
  const delta = currentkN - basekN;
  if (Math.abs(delta) < 0.01) return "";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)} kN vs preset`;
}

function setRigStatus(text) {
  if (!rigStatusEl) return;
  rigStatusEl.textContent = text;
  rigStatusEl.style.opacity = text ? "1" : "0";
}

function updateRigPanel(payload, results, preset) {
  if (results && !results.converged) {
    setRigStatus(`Error: No converge (${results.reason || 'inestabilidad numérica'})`);
  }
  rigScene = buildRigScene(payload, results);
  drawRigScene(rigScene);
  if (!results) {
    setRigStatus("Simula para ver la jarcia en 3D");
  } else if (!rigScene && results?.converged) {
    setRigStatus("Sin datos 3D disponibles");
  }
}

function enableRigOrbit(canvas) {
  if (!canvas) return;
  let isDragging = false;
  let last = { x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => {
    isDragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    rigView.yaw += dx * 0.01;
    rigView.pitch = clampValue(rigView.pitch + dy * 0.01, -Math.PI / 2, Math.PI / 2);
    last = { x: e.clientX, y: e.clientY };
    drawRigScene(rigScene);
  });

  // Mouse wheel zoom
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    rigView.zoom = clampValue(rigView.zoom * factor, 0.1, 10);
    drawRigScene(rigScene);
  }, { passive: false });

  ["pointerup", "pointerleave", "pointercancel"].forEach((evt) =>
    canvas.addEventListener(evt, () => {
      isDragging = false;
    })
  );
}

function plotCurve(canvas, curves, options = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { axisLabel = "x", geometry = null } = options;

  // Clear with background color
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const all = curves.flat();
  if (all.length < 2) return;

  const mastLength = geometry?.mastLengthM || 6.5;
  const xs = all.map((p) => p.value);
  const zs = all.map((p) => p.z);

  // Auto-scale with symmetric X for zero-center look
  const maxAbsX = Math.max(...xs.map(Math.abs), 0.005);
  const minX = -maxAbsX * 1.2;
  const maxX = maxAbsX * 1.2;
  const minZ = 0;
  const maxZ = Math.max(...zs, mastLength);

  const padL = 55, padR = 30, padT = 45, padB = 40;
  const w = canvas.width - padL - padR;
  const h = canvas.height - padT - padB;

  const scaleX = w / (maxX - minX);
  const scaleZ = h / (maxZ - minZ);

  function toPx(p) {
    return {
      x: padL + (p.value - minX) * scaleX,
      y: canvas.height - padB - (p.z - minZ) * scaleZ
    };
  }

  function zToPy(z) {
    return canvas.height - padB - (z - minZ) * scaleZ;
  }

  // 1. Grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let xV = -0.3; xV <= 0.3; xV += 0.05) {
    if (xV < minX || xV > maxX) continue;
    const px = padL + (xV - minX) * scaleX;
    ctx.moveTo(px, padT);
    ctx.lineTo(px, canvas.height - padB);
  }
  for (let zV = 0; zV <= maxZ + 0.5; zV += 1) {
    const py = zToPy(zV);
    if (py < padT) continue;
    ctx.moveTo(padL, py);
    ctx.lineTo(canvas.width - padR, py);
  }
  ctx.stroke();

  // 2. Central axis (X=0)
  const zeroX = padL + (0 - minX) * scaleX;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zeroX, padT);
  ctx.lineTo(zeroX, canvas.height - padB);
  ctx.stroke();

  // Height scale
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "right";
  for (let zV = 0; zV <= maxZ; zV += 1) {
    const py = zToPy(zV);
    if (py < padT) continue;
    ctx.fillText(`${zV.toFixed(0)}m`, padL - 5, py + 3);
  }
  ctx.textAlign = "left";

  // 3. Markers aligned with loaded curve
  if (geometry && curves[2]?.length > 0) {
    const loadedCurve = curves[2];
    const markers = [
      { z: geometry.partnersZM, name: "Deck", color: "#666" },
      { z: geometry.spreaderZM, name: "Spr", color: "#ffcc00" },
      { z: geometry.houndsZM, name: "Drz", color: "#ff4aff" }
    ];
    if (geometry.shroudAttachZM && Math.abs(geometry.shroudAttachZM - geometry.houndsZM) > 0.01) {
      markers.push({ z: geometry.shroudAttachZM, name: "Obn", color: "#4affff" });
    }

    markers.forEach(m => {
      const py = zToPy(m.z);
      if (py < padT || py > canvas.height - padB) return;
      const point = loadedCurve.find(p => Math.abs(p.z - m.z) < 0.15);
      const valueAtZ = point ? point.value * 1000 : 0;

      ctx.strokeStyle = m.color;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      const curveX = point ? toPx(point).x : zeroX;
      ctx.lineTo(curveX, py);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = m.color;
      ctx.font = "bold 9px Inter, sans-serif";
      ctx.fillText(m.name, 5, py + 3);

      if (Math.abs(valueAtZ) > 0.5) {
        ctx.font = "8px ui-monospace, monospace";
        const sign = valueAtZ > 0 ? "+" : "";
        ctx.fillText(`${sign}${valueAtZ.toFixed(0)}mm`, curveX + 4, py - 2);
      }
    });
  }

  // 4. Title and direction
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "bold 11px Inter, sans-serif";
  const title = axisLabel === "x" ? "Lateral (Banda a Banda)" : "Curva Proa/Popa";
  ctx.fillText(title, padL, padT - 25);

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "9px Inter, sans-serif";
  if (axisLabel === "y") {
    ctx.fillText("← Popa", zeroX - 42, padT - 5);
    ctx.fillText("Proa →", zeroX + 5, padT - 5);
  } else {
    ctx.fillText("← Babor", zeroX - 45, padT - 5);
    ctx.fillText("Estribor →", zeroX + 5, padT - 5);
  }

  // 5. Draw curves
  const colors = ["rgba(255,255,255,0.25)", "#479ef5", "#8dfa46"];
  const widths = [1, 2, 2.5];
  curves.forEach((curve, idx) => {
    if (curve.length < 2) return;
    ctx.strokeStyle = colors[idx];
    ctx.lineWidth = widths[idx];
    if (idx === 0) ctx.setLineDash([4, 4]);

    ctx.shadowBlur = idx === 0 ? 0 : 3;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.beginPath();
    curve.forEach((p, i) => {
      const px = toPx(p);
      if (i === 0) ctx.moveTo(px.x, px.y);
      else ctx.lineTo(px.x, px.y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
  });

  // 6. Draft stats (loaded curve)
  if (curves[2]?.length > 2) {
    const loadedCurve = curves[2];
    let maxDraft = 0, maxDraftZ = 0, maxDraftValue = 0;
    loadedCurve.forEach(p => {
      if (Math.abs(p.value) > maxDraft) {
        maxDraft = Math.abs(p.value);
        maxDraftZ = p.z;
        maxDraftValue = p.value;
      }
    });

    const draftMm = maxDraftValue * 1000;
    const draftPct = (maxDraftZ / mastLength) * 100;
    const maxPx = toPx({ value: maxDraftValue, z: maxDraftZ });

    // Max point marker
    ctx.fillStyle = "#8dfa46";
    ctx.beginPath();
    ctx.arc(maxPx.x, maxPx.y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Stats panel
    const statsX = padL + 5, statsY = canvas.height - padB - 55;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(statsX - 3, statsY - 12, 95, 50);

    ctx.font = "bold 9px ui-monospace, monospace";
    ctx.fillStyle = "#8dfa46";
    ctx.fillText("CARGADO", statsX, statsY);

    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    const sign = draftMm >= 0 ? "+" : "";
    ctx.fillText(`Draft: ${sign}${draftMm.toFixed(1)}mm`, statsX, statsY + 12);
    ctx.fillText(`@ ${draftPct.toFixed(0)}% altura`, statsX, statsY + 23);
    ctx.fillText(`(z=${maxDraftZ.toFixed(2)}m)`, statsX, statsY + 34);
  }

  // 7. Legend
  const legX = canvas.width - padR - 70, legY = padT + 5;
  const labels = ["Relajado", "Prebend", "Cargado"];
  labels.forEach((label, idx) => {
    ctx.strokeStyle = colors[idx];
    ctx.lineWidth = widths[idx];
    if (idx === 0) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(legX, legY + idx * 14);
    ctx.lineTo(legX + 15, legY + idx * 14);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "9px Inter, sans-serif";
    ctx.fillText(label, legX + 20, legY + idx * 14 + 3);
  });
}

function formatMm(m) {
  if (!Number.isFinite(m)) return "--";
  return `${(m * 1000).toFixed(1)} mm`;
}

function formatResidualN(n) {
  if (!Number.isFinite(n)) return "--";
  if (n === 0) return "0.0 N";
  if (Math.abs(n) >= 1000) return `${n.toExponential(2)} N`;
  if (Math.abs(n) >= 10) return `${n.toFixed(2)} N`;
  return `${n.toFixed(3)} N`;
}

function ensureCanvas2d(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || canvas.width || 1;
  const cssH = rect.height || canvas.height || 1;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function plotConvergenceHistory(canvas, history, options = {}) {
  const { tol = null } = options;
  const pack = ensureCanvas2d(canvas);
  if (!pack) return;
  const { ctx, w, h } = pack;

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const pts = Array.isArray(history) ? history.filter(p => Number.isFinite(p?.iter) && Number.isFinite(p?.residual)) : [];
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "12px Inter, sans-serif";
    ctx.fillText("Sin historial de convergencia", 12, 22);
    return;
  }

  const minIter = Math.min(...pts.map(p => p.iter));
  const maxIter = Math.max(...pts.map(p => p.iter));
  const denomIter = Math.max(1, maxIter - minIter);

  const eps = 1e-12;
  const logResiduals = pts.map(p => Math.log10(Math.max(eps, p.residual)));
  let minLog = Math.min(...logResiduals);
  let maxLog = Math.max(...logResiduals);
  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog)) return;
  if (Math.abs(maxLog - minLog) < 1e-6) {
    minLog -= 1;
    maxLog += 1;
  }
  minLog = Math.floor(minLog);
  maxLog = Math.ceil(maxLog);

  const dofMm = pts.map(p => (Number.isFinite(p?.maxDof) ? p.maxDof * 1000 : NaN)).filter(Number.isFinite);
  const hasDof = dofMm.length > 1;
  const maxDofMm = hasDof ? Math.max(...dofMm, 0.0001) : 1;

  const padL = 58;
  const padR = 58;
  const padT = 20;
  const padB = 34;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  const xPx = (iter) => padL + ((iter - minIter) / denomIter) * plotW;
  const yResPx = (residual) => {
    const lr = Math.log10(Math.max(eps, residual));
    return padT + ((maxLog - lr) / (maxLog - minLog)) * plotH;
  };
  const yDofPx = (mm) => padT + ((maxDofMm - mm) / maxDofMm) * plotH;

  // Grid + axes
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Vertical grid (iterations)
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = padL + (i / xTicks) * plotW;
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
  }

  // Horizontal grid (log residual)
  for (let lg = minLog; lg <= maxLog; lg++) {
    const y = padT + ((maxLog - lg) / (maxLog - minLog)) * plotH;
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
  }
  ctx.stroke();

  // Tolerance line
  if (Number.isFinite(tol) && tol > 0) {
    const yTol = yResPx(tol);
    if (yTol >= padT && yTol <= padT + plotH) {
      ctx.strokeStyle = "rgba(255, 204, 0, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, yTol);
      ctx.lineTo(padL + plotW, yTol);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Residual curve
  ctx.strokeStyle = "#479ef5";
  ctx.lineWidth = 2.2;
  ctx.shadowBlur = 6;
  ctx.shadowColor = "rgba(71,158,245,0.6)";
  ctx.beginPath();
  pts.forEach((p, idx) => {
    const x = xPx(p.iter);
    const y = yResPx(p.residual);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Max DOF curve (right axis)
  if (hasDof) {
    ctx.strokeStyle = "#8dfa46";
    ctx.lineWidth = 2.2;
    ctx.shadowBlur = 6;
    ctx.shadowColor = "rgba(141,250,70,0.45)";
    ctx.beginPath();
    let started = false;
    pts.forEach((p) => {
      if (!Number.isFinite(p?.maxDof)) return;
      const x = xPx(p.iter);
      const y = yDofPx(p.maxDof * 1000);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Labels
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("Residual (log10 N)", 12, 18);
  ctx.fillText("Max DOF (mm)", w - 12 - ctx.measureText("Max DOF (mm)").width, 18);

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`${minIter}`, padL, padT + plotH + 22);
  ctx.textAlign = "right";
  ctx.fillText(`${maxIter}`, padL + plotW, padT + plotH + 22);
  ctx.textAlign = "left";

  // Y ticks
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  for (let lg = minLog; lg <= maxLog; lg++) {
    const y = padT + ((maxLog - lg) / (maxLog - minLog)) * plotH;
    ctx.fillText(`1e${lg}`, padL - 8, y + 3);
  }
  ctx.textAlign = "left";
  if (hasDof) {
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const mm = (maxDofMm * i) / steps;
      const y = yDofPx(mm);
      ctx.fillText(`${mm.toFixed(1)}`, padL + plotW + 8, y + 3);
    }
  }
  ctx.textAlign = "left";
}

function renderConvergenceLegend(history, tol) {
  const legendEl = byId("plotConvergenceLegend");
  if (!legendEl) return;

  const pts = Array.isArray(history) ? history.filter(p => Number.isFinite(p?.iter) && Number.isFinite(p?.residual)) : [];
  if (!pts.length) {
    legendEl.textContent = "";
    return;
  }

  const last = pts[pts.length - 1];
  const maxDofText = Number.isFinite(last.maxDof) ? formatMm(last.maxDof) : "--";
  const tolText = Number.isFinite(tol) ? formatResidualN(tol) : "--";

  legendEl.textContent = `Iter: ${last.iter} · Residual final: ${formatResidualN(last.residual)} (tol: ${tolText}) · Max DOF final: ${maxDofText}`;
}

function renderConvergenceTable(history) {
  const tbody = byId("convergenceTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const pts = Array.isArray(history) ? history.filter(p => Number.isFinite(p?.iter) && Number.isFinite(p?.residual)) : [];
  if (!pts.length) return;

  const headN = 6;
  const tailN = 80;
  const hasGap = pts.length > headN + tailN;
  const head = pts.slice(0, Math.min(headN, pts.length));
  const tailStart = hasGap ? Math.max(headN, pts.length - tailN) : head.length;
  const tail = pts.slice(tailStart);

  const addRow = (p) => {
    const tr = document.createElement("tr");
    const maxDof = Number.isFinite(p.maxDof) ? formatMm(p.maxDof) : "--";
    tr.innerHTML = `<td>${p.iter}</td><td>${formatResidualN(p.residual)}</td><td>${maxDof}</td>`;
    tbody.appendChild(tr);
  };

  head.forEach(addRow);
  if (hasGap) {
    const gap = document.createElement("tr");
    gap.innerHTML = `<td colspan="3" style="color: rgba(255,255,255,0.35); padding: 6px 10px;">…</td>`;
    tbody.appendChild(gap);
  }
  tail.forEach(addRow);
}

function buildPayloadFromUi() {
  const mainShapeSections = clampValue(getNumber("mainShapeSections"), 2, 6);
  const jibShapeSections = clampValue(getNumber("jibShapeSections"), 2, 6);
  const mainSections = readSectionArray("mainSectionDepth", "mainSectionPos", mainShapeSections, getNumber("mainDraftPct") / 100, getNumber("mainDraftPosPct") / 100);
  const jibSections = readSectionArray("jibSectionDepth", "jibSectionPos", jibShapeSections, getNumber("jibDraftPct") / 100, getNumber("jibDraftPosPct") / 100);

  const payload = {
    geometry: {
      mastLengthM: mmToM(getNumber("mastLengthMm")),
      partnersZM: mmToM(getNumber("partnersZMm")),
      spreaderZM: mmToM(getNumber("spreaderZMm")),
      houndsZM: mmToM(getNumber("houndsZMm")),              // Altura driza/forestay
      shroudAttachZM: mmToM(getNumber("shroudAttachZMm")),  // Altura anclaje obenques
      chainplateXM: mmToM(getNumber("chainplateXMm")),
      chainplateYM: mmToM(getNumber("chainplateYMm")),
      bowYM: mmToM(getNumber("bowYMm"))
    },
    controls: {
      spreaderLengthM: mmToM(getNumber("spreaderLengthMm")),
      spreaderSweepAftM: mmToM(getNumber("spreaderLengthMm") * Math.sin(getNumber("spreaderAngle") * Math.PI / 180)),
      shroudBaseDeltaM: mmToM(getNumber("shroudBaseDeltaMm")),
      shroudDeltaL0PortM: mmToM(getNumber("shroudDeltaPortMm")),
      shroudDeltaL0StbdM: mmToM(getNumber("shroudDeltaStbdMm")),
      jibHalyardTensionN: kNToN(getNumber("jibHalyardTensionkN")),
      lockStayLength: byId("lockStayLength")?.checked || false,
      partnersKx: byId("partnersReleaseX")?.checked ? 0 : kNpmToNpm(getNumber("partnersKx")),
      partnersKy: byId("partnersReleaseY")?.checked ? 0 : kNpmToNpm(getNumber("partnersKy")),
      partnersOffsetXM: mmToM(getNumber("partnersOffsetX") || 0),
      partnersOffsetYM: mmToM(getNumber("partnersOffsetY") || 0)
    },
    load: {
      mode: byId("loadMode").value,
      qLateralNpm: getNumber("qLateral"),
      qProfile: byId("qProfile").value
    },
    solver: {
      mastSegments: Math.trunc(getNumber("mastSegments")),
      cableSegments: Math.trunc(getNumber("cableSegments") || 1),
      pretensionSteps: Math.trunc(getNumber("pretensionSteps")),
      loadSteps: Math.trunc(getNumber("loadSteps")),
      maxIterations: Math.trunc(getNumber("maxIters")),
      toleranceN: getNumber("tol"),
      cableCompressionEps: getNumber("cableEps"),
      sailDamping: getNumber("sailDamping"),
      sailDampingDecay: getNumber("sailDampingDecay"),
      drTimeStep: getNumber("drTimeStep"),
      drViscousDamping: getNumber("drViscousDamping"),
      drWarmupIters: Math.trunc(getNumber("drWarmupIters")),
      drKineticBacktrack: getNumber("drKineticBacktrack"),
      drMaxStepM: getNumber("drMaxStepM"),
      drStabilityFactor: getNumber("drStabilityFactor"),
      drMassSafety: getNumber("drMassSafety"),
      drMaxIterations: Math.trunc(getNumber("drMaxIterations")),
      pressureRampIters: Math.trunc(getNumber("pressureRampIters")),
      drNewtonFallbackAfter: Math.trunc(getNumber("drNewtonFallbackAfter"))
    },
    // Rigidez del palo (variable con altura - conicidad)
    // Valores típicos Snipe (Selden C060, aluminio 6061-T6):
    // - EI base: ~7500 N·m² (sección constante inferior)
    // - EI top: ~3500 N·m² (punta cónica, ~50% reducción)
    // - Conicidad: empieza sobre intersección stays SCIRA (~4500mm)
    stiffness: {
      mastEIBase: getNumber("mastEIBase") || 7500,     // EI sección inferior (N·m²)
      mastEITop: getNumber("mastEITop") || 3500,       // EI sección superior (N·m²)
      taperStartZM: mmToM(getNumber("taperStartZMm") || 4500)  // Altura inicio conicidad
    }
  };

  const membranePrestress = getOptionalNumber("membranePrestress");
  const membranePretensionFraction = getOptionalNumber("membranePretensionFraction");
  const membraneCurvatureRadius = getOptionalNumber("membraneCurvatureRadius");
  const membraneWrinklingEps = getOptionalNumber("membraneWrinklingEps");
  const membraneMaxStrain = getOptionalNumber("membraneMaxStrain");
  if (Number.isFinite(membranePrestress)) payload.solver.membranePrestress = membranePrestress;
  if (Number.isFinite(membranePretensionFraction)) payload.solver.membranePretensionFraction = membranePretensionFraction;
  if (Number.isFinite(membraneCurvatureRadius)) payload.solver.membraneCurvatureRadius = membraneCurvatureRadius;
  if (Number.isFinite(membraneWrinklingEps)) payload.solver.membraneWrinklingEps = membraneWrinklingEps;
  if (Number.isFinite(membraneMaxStrain)) payload.solver.membraneMaxStrain = membraneMaxStrain;

  const sailsEnabledEl = byId("sailsEnabled");
  const sailsEnabled = Boolean(sailsEnabledEl && sailsEnabledEl.checked);
  if (!sailsEnabled) {
    payload.sails = { enabled: false };
    return payload;
  }

  const mainEnabledEl = byId("mainEnabled");
  const jibEnabledEl = byId("jibEnabled");
  const jibSheetSideEl = byId("jibSheetSide");
  const jibSheetSideSign = jibSheetSideEl ? Number(jibSheetSideEl.value) : 0;

  // Wind sign from select element
  const windSignEl = byId("sailWindSign");
  const windSignVal = windSignEl ? Number(windSignEl.value) : 1;

  payload.sails = {
    enabled: true,
    windPressurePa: getNumber("sailPressurePa"),
    windSign: windSignVal < 0 ? -1 : 1,
    main: {
      enabled: Boolean(mainEnabledEl && mainEnabledEl.checked),
      // Veleria: Forma de la vela
      draftDepth: getNumber("mainDraftPct") / 100,
      draftPos: getNumber("mainDraftPosPct") / 100,
      shapeSections: mainShapeSections,
      draftDepthSections: mainSections.depth,
      draftPosSections: mainSections.pos,
      tackZM: mmToM(getNumber("mainTackZMm")),
      footLengthM: mmToM(getNumber("mainFootMm")),
      // Trimado: Controles Dirichlet (desplazamientos directos)
      cunninghamMm: getNumber("mainCunninghamMm") || 0,
      boomAngleDeg: getNumber("mainBoomAngleDeg") || 0,      // Ángulo horizontal de la botavara
      boomTiltDeg: getNumber("mainBoomTiltDeg") || 0,        // Ángulo vertical (trapa/vang)
      outhaulMm: getNumber("mainOuthaulMm") || 0,            // Desplazamiento del puño de escota
      sheetLeadYM: -mmToM(getNumber("mainSheetLeadYMm")),    // Posición del carro
      mesh: {
        luffSegments: clampValue(Math.trunc(getNumber("mainLuffSeg") || 12), 2, 40),
        chordSegments: clampValue(Math.trunc(getNumber("mainChordSeg") || 8), 2, 40)
      }
    },
    jib: {
      enabled: Boolean(jibEnabledEl && jibEnabledEl.checked),
      // Veleria: Forma del foque
      draftDepth: getNumber("jibDraftPct") / 100,
      draftPos: getNumber("jibDraftPosPct") / 100,
      shapeSections: jibShapeSections,
      draftDepthSections: jibSections.depth,
      draftPosSections: jibSections.pos,
      // Trimado: Controles Dirichlet (desplazamientos directos)
      clewDisplaceMm: getNumber("jibClewDisplaceMm") || 0,   // Desplazamiento del puño hacia el carro
      sheetSideSign: Number.isFinite(jibSheetSideSign) ? jibSheetSideSign : 0,
      sheetLeadXMm: getNumber("jibSheetLeadXMm") || 0,       // Posición X del carro
      sheetLeadYMm: getNumber("jibSheetLeadYMm") || -1800,   // Posición Y del carro
      mesh: {
        luffSegments: clampValue(Math.trunc(getNumber("jibLuffSeg") || 8), 2, 40),
        chordSegments: clampValue(Math.trunc(getNumber("jibChordSeg") || 6), 2, 40)
      }
    }
  };

  return payload;
}

function applyPreset(preset) {
  setValue("mastLengthMm", preset.geometry.mastLengthMm);
  setValue("partnersZMm", preset.geometry.partnersZMm);
  setValue("spreaderZMm", preset.geometry.spreaderZMm);
  setValue("houndsZMm", preset.geometry.houndsZMm);
  // shroudAttachZMm: si no existe en preset, usar houndsZMm como fallback
  setValue("shroudAttachZMm", preset.geometry.shroudAttachZMm ?? preset.geometry.houndsZMm);
  setValue("chainplateXMm", preset.geometry.chainplateXMm);
  setValue("chainplateYMm", preset.geometry.chainplateYMm);
  setValue("bowYMm", preset.geometry.bowYMm);
  setValue("mainTackZMm", preset.geometry.tackZMm ?? 1387);

  setValue("spreaderLengthMm", preset.controls.spreaderLengthMm);
  setValue("spreaderAngle", (preset.controls.spreaderAngleDeg ?? 0).toFixed(1));
  setValue("shroudBaseDeltaMm", preset.controls.shroudBaseDeltaMm ?? 0);
  setValue("shroudDeltaPortMm", preset.controls.shroudDeltaPortMm);
  setValue("shroudDeltaStbdMm", preset.controls.shroudDeltaStbdMm);
  setValue("jibHalyardTensionkN", preset.controls.jibHalyardTensionkN ?? 0);
  setValue("partnersKx", preset.controls.partnersKx_kNpm);
  setValue("partnersKy", preset.controls.partnersKy_kNpm);
  setValue("partnersOffsetX", preset.controls.partnersOffsetXMm ?? 0);
  setValue("partnersOffsetY", preset.controls.partnersOffsetYMm ?? 0);

  byId("loadMode").value = preset.load.mode;
  setValue("qLateral", preset.load.qLateralNpm);
  byId("qProfile").value = preset.load.qProfile;

  setValue("mastSegments", preset.solver.mastSegments);
  setValue("cableSegments", preset.solver.cableSegments ?? 1);
  setValue("pretensionSteps", preset.solver.pretensionSteps);
  setValue("loadSteps", preset.solver.loadSteps);
  setValue("maxIters", preset.solver.maxIterations);
  setValue("tol", preset.solver.toleranceN);
  setValue("cableEps", preset.solver.cableCompressionEps);
  setValue("sailDamping", preset.solver.sailDamping ?? 0.1);
  setValue("sailDampingDecay", preset.solver.sailDampingDecay ?? 0.85);
  const defaultDrMaxIterations = (preset.solver.maxIterations ?? 300) * 20;
  setValue("drTimeStep", preset.solver.drTimeStep ?? 0.002);
  setValue("drViscousDamping", preset.solver.drViscousDamping ?? 0.05);
  setValue("drWarmupIters", preset.solver.drWarmupIters ?? 200);
  setValue("drKineticBacktrack", preset.solver.drKineticBacktrack ?? 1.0);
  setValue("drMaxStepM", preset.solver.drMaxStepM ?? 0);
  setValue("drStabilityFactor", preset.solver.drStabilityFactor ?? 0.5);
  setValue("drMassSafety", preset.solver.drMassSafety ?? 2.0);
  setValue("drMaxIterations", preset.solver.drMaxIterations ?? defaultDrMaxIterations);
  setValue("pressureRampIters", preset.solver.pressureRampIters ?? 200);
  setValue("drNewtonFallbackAfter", preset.solver.drNewtonFallbackAfter ?? 1000);
  setValue("membranePrestress", "");
  setValue("membranePretensionFraction", "");
  setValue("membraneCurvatureRadius", "");
  setValue("membraneWrinklingEps", "");
  setValue("membraneMaxStrain", "");

  // Rigidez del palo (valores por defecto si no existen en preset)
  // Valores típicos Snipe según SCIRA y sección Selden C060
  setValue("mastEIBase", preset.stiffness?.mastEIBase ?? 7500);
  setValue("mastEITop", preset.stiffness?.mastEITop ?? 3500);
  setValue("taperStartZMm", preset.stiffness?.taperStartZMm ?? 4500);

  // Velas (opcionales) - valores por defecto
  byId("sailsEnabled").checked = false;
  byId("mainEnabled").checked = true;
  byId("jibEnabled").checked = true;
  setValue("sailPressurePa", 80);
  setValue("sailWindSign", 1);

  // Mayor: Veleria
  setValue("mainDraftPct", 8.0);
  setValue("mainDraftPosPct", 40);
  setValue("mainShapeSections", 4);
  for (let i = 1; i <= 6; i++) {
    setValue(`mainSectionDepth${i}`, 8.0);
    setValue(`mainSectionPos${i}`, 40);
  }
  setValue("mainFootMm", 2550);
  // Mayor: Trimado (Dirichlet)
  setValue("mainCunninghamMm", 0);
  setValue("mainBoomAngleDeg", 10);          // Ángulo inicial moderado
  setValue("mainSheetLeadYMm", 2200);        // Posición carro
  setValue("mainBoomTiltDeg", 0);            // Trapa neutra
  setValue("mainOuthaulMm", 0);              // Outhaul neutro
  setValue("mainLuffSeg", 12);
  setValue("mainChordSeg", 8);

  // Foque: Veleria
  setValue("jibDraftPct", 7.0);
  setValue("jibDraftPosPct", 35);
  setValue("jibShapeSections", 4);
  for (let i = 1; i <= 6; i++) {
    setValue(`jibSectionDepth${i}`, 7.0);
    setValue(`jibSectionPos${i}`, 35);
  }
  // Foque: Trimado (Dirichlet)
  setValue("jibClewDisplaceMm", 50);         // Ligera tensión
  byId("jibSheetSide").value = "0";
  setValue("jibSheetLeadXMm", 400);          // Desde crujía
  setValue("jibSheetLeadYMm", -1800);        // Desde palo (negativo = popa)
  setValue("jibLuffSeg", 8);
  setValue("jibChordSeg", 6);

  // Reset section override flags on preset load
  clearSectionCustomFlags("mainSectionDepth", "mainSectionPos");
  clearSectionCustomFlags("jibSectionDepth", "jibSectionPos");

  // Ensure section table rows match N
  setSectionRowsVisible("mainSectionDepth", "mainSectionPos", byId("mainShapeSections")?.value);
  setSectionRowsVisible("jibSectionDepth", "jibSectionPos", byId("jibShapeSections")?.value);

  // Sync sliders
  document.querySelectorAll('input[type="range"]').forEach(slider => {
    const numId = slider.id.replace("Slider", "");
    try {
      const numInput = byId(numId);
      slider.value = numInput.value;
    } catch (e) { }
  });
}

// Race mode logic removed for Laboratorio de Análisis.


function bindSyncedInput(sliderId, inputId, onChange) {
  const slider = byId(sliderId);
  const input = byId(inputId);
  if (!slider || !input) return;

  const update = (src, dest) => {
    dest.value = src.value;
    if (onChange) onChange();
  };

  slider.addEventListener("input", () => update(slider, input));
  input.addEventListener("input", () => update(input, slider));
}

async function runSimulation() {
  const runBtn = byId("runBtn");
  const exportJsonBtn = byId("exportJsonBtn");
  const exportCsvBtn = byId("exportCsvBtn");

  exportJsonBtn.disabled = true;
  exportCsvBtn.disabled = true;
  lastResults = null;

  byId("solverOut").textContent = "Ejecutando...";
  byId("tensionsOut").textContent = "";
  byId("spreaderOut").textContent = "";
  byId("equilibriumOut").textContent = "";
  setRigStatus("Calculando...");

  try {
    const payload = buildPayloadFromUi();
    const isHighRes = (payload.sails?.enabled) && (
      (payload.sails.main?.enabled && payload.sails.main.mesh.luffSegments * payload.sails.main.mesh.chordSegments > 150) ||
      (payload.sails.jib?.enabled && payload.sails.jib.mesh.luffSegments * payload.sails.jib.mesh.chordSegments > 100)
    );

    if (isHighRes) {
      setRigStatus("Calculando malla densa... (puede tardar)");
    }

    const warnings = [];
    const g = payload.geometry;
    const c = payload.controls;

    // Mast Length: 6480 - 6500 mm (Butt to Top)
    if (g.mastLengthM > 6.500) warnings.push("Mast length exceeds SCIRA limit (max 6500mm).");
    else if (g.mastLengthM < 6.480) warnings.push("Mast length below SCIRA limit (min 6480mm).");

    // Hounds height (Intersection): 4860 - 4962 mm
    if (g.houndsZM > 4.962) warnings.push("Hounds (attachment) too high (max 4962mm).");
    else if (g.houndsZM < 4.860) warnings.push("Hounds too low (min 4860mm).");

    // Fogonadura (Deck height): ~400 mm
    if (g.partnersZM > 0.420) warnings.push("Altura fogonadura muy alta (tipico max 400-420mm).");
    else if (g.partnersZM < 0.380) warnings.push("Altura fogonadura muy baja (min 390mm).");

    // Mast position (Stem to mast front): 1498 - 1524 mm
    if (g.bowYM > 1.524) warnings.push("Mast positioned too far aft (Stem to Front max 1524mm).");
    else if (g.bowYM < 1.498) warnings.push("Mast positioned too far forward (Stem to Front min 1498mm).");

    // Spreader tip-to-tip: 735 - 773 mm
    const xOutFortt = Math.sqrt(Math.max(0, c.spreaderLengthM ** 2 - c.spreaderSweepAftM ** 2));
    const tipToTipMm = 2 * xOutFortt * 1000;
    if (tipToTipMm > 773) warnings.push(`Spreader tip-to-tip (${tipToTipMm.toFixed(0)}mm) > 773mm.`);
    else if (tipToTipMm < 735 && tipToTipMm > 100) warnings.push(`Spreader tip-to-tip (${tipToTipMm.toFixed(0)}mm) < 735mm.`);

    // Show live metrics panel
    showLiveMetrics();

    // Subscribe to progress updates (Electron only)
    if (snipeApi.onSimulationProgress) {
      liveMetricsState.unsubProgress = snipeApi.onSimulationProgress((metrics) => {
        updateLiveMetrics(metrics);
      });
    }

    const startTime = performance.now();

    // Use async API if available
    let res;
    if (snipeApi.runPhase1Async) {
      const asyncResult = await snipeApi.runPhase1Async(payload);
      res = asyncResult.result || asyncResult;
    } else {
      res = await snipeApi.runPhase1(payload);
    }

    const endTime = performance.now();

    // Hide live metrics panel
    hideLiveMetrics();

    lastResults = res;

    const durationMs = (endTime - startTime).toFixed(0);
    const simTime = `Simulado en ${durationMs}ms`;
    setResValue("simulationTime", simTime);
    setResValue("simulationTimeSummary", simTime);

    // 1. Convergencia
    const convState = res.converged ? "success" : "error";
    const convText = res.converged ? "Convergido" : "No converge";
    setStatus("converged-status", convState, convText);
    setStatus("converged-status-summary", convState, convText);
    setResValue("res-iters", res.iterations ?? "?");
    setResValue("res-energy", Number.isFinite(res.energy) ? res.energy.toExponential(4) : "N/A");

    const warnEl = byId("converge-warnings");
    warnEl.innerHTML = "";
    warnings.forEach(w => {
      const item = document.createElement("div");
      item.className = "warn-item";
      item.textContent = w.replace("⚠️ ", "");
      warnEl.appendChild(item);
    });
    if (res.diagnostics?.slackCables?.length) {
      const slack = res.diagnostics.slackCables;
      const clothMainCount = slack.filter(s => s.startsWith("cloth_main")).length;
      const clothJibCount = slack.filter(s => s.startsWith("cloth_jib")).length;
      const others = slack.filter(s => !s.startsWith("cloth_main") && !s.startsWith("cloth_jib"));

      const item = document.createElement("div");
      item.className = "warn-item";
      let msg = "";
      if (clothMainCount) msg += `Paño Mayor: ${clothMainCount} cab. sin tensión. `;
      if (clothJibCount) msg += `Paño Foque: ${clothJibCount} cab. sin tensión. `;
      if (others.length) msg += `Otros: ${others.join(", ")}`;
      item.textContent = msg;
      warnEl.appendChild(item);
    }

    // Debug: convergence history (plot + table)
    const fullHistory = [];
    let iterOffset = 0;
    (res.history || []).forEach(phase => {
      if (phase.convergenceHistory) {
        phase.convergenceHistory.forEach(h => {
          fullHistory.push({ ...h, iter: h.iter + iterOffset });
        });
        iterOffset = fullHistory.length;
      }
    });
    lastConvergenceHistory = fullHistory;
    lastConvergenceTol = payload.solver?.toleranceN ?? null;
    plotConvergenceHistory(byId("plotConvergence"), lastConvergenceHistory, { tol: lastConvergenceTol });
    renderConvergenceLegend(lastConvergenceHistory, lastConvergenceTol);
    renderConvergenceTable(lastConvergenceHistory);

    if (!res.outputs) {
      setRigStatus(res.reason || "Error en el cálculo");
      return;
    }

    const hasMain = !!res.outputs.sails?.loaded?.main;
    const hasJib = !!res.outputs.sails?.loaded?.jib;
    if (hasMain || hasJib) {
      let msg = "Simulación lista. Malla: ";
      if (hasMain) {
        const m = res.outputs.sails.loaded.main;
        msg += `Mayor ${m.length - 1}x${m[0].length - 1} `;
      }
      if (hasJib) {
        const j = res.outputs.sails.loaded.jib;
        msg += `Foque ${j.length - 1}x${j[0].length - 1}`;
      }
      setRigStatus(msg);
    } else {
      setRigStatus("Simulación lista.");
    }

    // 2. Tensiones
    const t = res.outputs.tensions || {};
    const formatKN = (n) => (n / 1000).toFixed(2) + " kN";
    const formatN = (n) => (n || 0).toFixed(1) + " N";

    const formatKNSlack = (id, flagId, n) => {
      const val = formatKN(n);
      const el = byId(id);
      const flag = byId(flagId);
      if (el) {
        el.textContent = val;
        const isSlack = n < 1.0;
        el.classList.toggle("slack", isSlack);
        if (flag) flag.hidden = !isSlack;
      }
    };
    formatKNSlack("res-shroud-port", "flag-shroud-port", t.shroudPortN);
    formatKNSlack("res-shroud-stbd", "flag-shroud-stbd", t.shroudStbdN);
    formatKNSlack("res-stay", "flag-stay", t.forestayN);

    // 3. Spreader
    const s = res.outputs.spreaders;
    const xOutTt = Math.sqrt(Math.max(0, c.spreaderLengthM ** 2 - c.spreaderSweepAftM ** 2));
    const tip2TipMm = 2 * xOutTt * 1000;
    const flechaMm = c.spreaderSweepAftM * 1000;
    setResValue("res-tip-tip", `${tip2TipMm.toFixed(0)} mm`);
    setResValue("res-flecha", `${flechaMm.toFixed(1)} mm`);
    setResValue("res-axial-port", formatN(s.portAxialN));
    setResValue("res-axial-stbd", formatN(s.stbdAxialN));

    // 4. Equilibrio
    const eq = res.outputs.equilibrium || {};
    const eqSumFx = Number.isFinite(eq.openSumFx) ? eq.openSumFx : eq.sumFx;
    const eqSumFy = Number.isFinite(eq.openSumFy) ? eq.openSumFy : eq.sumFy;
    const eqMag = Number.isFinite(eq.openMagnitude) ? eq.openMagnitude : eq.magnitude;
    const eqBalanced = typeof eq.openIsBalanced === "boolean" ? eq.openIsBalanced : eq.isBalanced;

    setStatus("equilibrium-status", eqBalanced ? "success" : "error", eqBalanced ? "Equilibrado" : "Revisar");
    setResValue("res-ext-fx", `${eq.externalFx?.toFixed(1) ?? "0"} N`);
    setResValue("res-ext-fy", `${eq.externalFy?.toFixed(1) ?? "0"} N`);
    const rzVal = `${((eq.mastStepRz ?? 0) / 1000).toFixed(2)} kN`;
    setResValue("res-base-rz", rzVal);
    setResValue("res-base-rz-duplicate", rzVal);
    setResValue("res-partners-fx", `${eq.partnersRx?.toFixed(1) ?? "0"} N`);
    setResValue("res-sum-fx", `${Number.isFinite(eqSumFx) ? eqSumFx.toFixed(1) : "?"} N`);
    setResValue("res-sum-fy", `${Number.isFinite(eqSumFy) ? eqSumFy.toFixed(1) : "?"} N`);
    setResValue("res-sum-mag", `${Number.isFinite(eqMag) ? eqMag.toFixed(1) : "?"} N`);

    // Backward compatibility (old hidden pre tags)
    byId("solverOut").textContent = [...warnings, `converged: ${res.converged}`].join("\n");
    byId("tensionsOut").textContent = `shroud port: ${formatKN(t.shroudPortN)}\nshroud stbd: ${formatKN(t.shroudStbdN)}`;

    const out = res.outputs;

    // DEBUG: Verificar datos de curvas
    const preTop = out.mastCurvePrebend?.[out.mastCurvePrebend.length - 1];
    const loadTop = out.mastCurveLoaded?.[out.mastCurveLoaded.length - 1];
    console.log('=== DEBUG CURVAS (datos del solver) ===');
    console.log('PREBEND top: x=' + ((preTop?.x || 0) * 1000).toFixed(1) + 'mm, y=' + ((preTop?.y || 0) * 1000).toFixed(1) + 'mm');
    console.log('LOADED top:  x=' + ((loadTop?.x || 0) * 1000).toFixed(1) + 'mm, y=' + ((loadTop?.y || 0) * 1000).toFixed(1) + 'mm');
    const prebendMaxX = Math.max(...(out.mastCurvePrebend || []).map(p => Math.abs(p.x))) * 1000;
    const loadedMaxX = Math.max(...(out.mastCurveLoaded || []).map(p => Math.abs(p.x))) * 1000;
    console.log('Max |x| PREBEND: ' + prebendMaxX.toFixed(1) + 'mm');
    console.log('Max |x| LOADED:  ' + loadedMaxX.toFixed(1) + 'mm');
    console.log(loadedMaxX > prebendMaxX ? '✓ CORRECTO: LOADED tiene mas deflexion' : '✗ ERROR: PREBEND tiene mas deflexion!');

    const relaxedXZ = (out.mastCurveRelaxed || []).map((p) => ({ z: p.z, value: p.x }));
    const prebendXZ = (out.mastCurvePrebend || []).map((p) => ({ z: p.z, value: p.x }));
    const loadedXZ = (out.mastCurveLoaded || []).map((p) => ({ z: p.z, value: p.x }));
    plotCurve(byId("plotXZ"), [relaxedXZ, prebendXZ, loadedXZ], { axisLabel: "x", geometry: payload.geometry });

    const relaxedYZ = (out.mastCurveRelaxed || []).map((p) => ({ z: p.z, value: p.y }));
    const prebendYZ = (out.mastCurvePrebend || []).map((p) => ({ z: p.z, value: p.y }));
    const loadedYZ = (out.mastCurveLoaded || []).map((p) => ({ z: p.z, value: p.y }));
    plotCurve(byId("plotYZ"), [relaxedYZ, prebendYZ, loadedYZ], { axisLabel: "y", geometry: payload.geometry });

    updateRigPanel(payload, res, presetsCache[currentPresetIdx]);

    exportJsonBtn.disabled = false;
    exportCsvBtn.disabled = false;
  } catch (err) {
    console.error(err);
    hideLiveMetrics();
    setRigStatus("Fallo al calcular: " + (err.message || err));
    setStatus("converged-status", "error", "Error");
    setStatus("converged-status-summary", "error", "Error");
  }
}

async function main() {
  rigCanvasEl = byId("rig3dCanvas");
  rigStatusEl = byId("rig3dStatus");
  rigSettingsEl = byId("rigSettings");
  rigChangesEl = byId("rigChanges");
  enableRigOrbit(rigCanvasEl);
  initColumnResizer();
  reorganizeResultsUi();

  const debugDetails = byId("debugDetails");
  if (debugDetails) {
    debugDetails.addEventListener("toggle", () => {
      if (!debugDetails.open) return;
      plotConvergenceHistory(byId("plotConvergence"), lastConvergenceHistory, { tol: lastConvergenceTol });
      renderConvergenceLegend(lastConvergenceHistory, lastConvergenceTol);
    });
  }

  const presetSelect = byId("presetSelect");
  const presets = await snipeApi.listPresets();
  presetsCache = presets;

  presets.forEach((p, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  });

  applyPreset(presets[0]);
  currentPresetIdx = 0;
  updateRigPanel(buildPayloadFromUi(), null, presets[currentPresetIdx]);

  // Race mode removed (Laboratorio de Análisis).

  presetSelect.addEventListener("change", () => {
    const idx = Number(presetSelect.value);
    currentPresetIdx = idx;
    applyPreset(presets[idx]);
    updateRigPanel(buildPayloadFromUi(), null, presets[idx]);
  });

  const autoUpdateCb = byId("autoUpdate");
  const debouncedRun = debounce(() => {
    if (autoUpdateCb.checked) runBtn.click();
  }, 250);

  // Sync range sliders with number inputs
  document.querySelectorAll('input[type="range"]').forEach(slider => {
    const numId = slider.id.replace("Slider", "");
    bindSyncedInput(slider.id, numId, debouncedRun);
  });

  // Secciones de forma: mostrar solo las primeras N (evita filas visibles sin efecto).
  const onSectionsCountInput = (prefixDepth, prefixPos) => (e) =>
    setSectionRowsVisible(prefixDepth, prefixPos, e?.target?.value);
  byId("mainShapeSections")?.addEventListener("input", onSectionsCountInput("mainSectionDepth", "mainSectionPos"));
  byId("mainShapeSectionsSlider")?.addEventListener("input", onSectionsCountInput("mainSectionDepth", "mainSectionPos"));
  byId("jibShapeSections")?.addEventListener("input", onSectionsCountInput("jibSectionDepth", "jibSectionPos"));
  byId("jibShapeSectionsSlider")?.addEventListener("input", onSectionsCountInput("jibSectionDepth", "jibSectionPos"));

  // Globales -> secciones: los sliders globales controlan el baseline; las secciones refinan donde haya override.
  const readUiNumber = (id) => {
    const el = byId(id);
    if (!el) return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  };
  const EPS_PCT = 1e-4;

  const syncMainDepth = () => {
    const v = readUiNumber("mainDraftPct");
    if (v === null) return;
    syncSectionsFromGlobal("mainSectionDepth", v, EPS_PCT);
  };
  const syncMainPos = () => {
    const v = readUiNumber("mainDraftPosPct");
    if (v === null) return;
    syncSectionsFromGlobal("mainSectionPos", v, EPS_PCT);
  };
  const syncJibDepth = () => {
    const v = readUiNumber("jibDraftPct");
    if (v === null) return;
    syncSectionsFromGlobal("jibSectionDepth", v, EPS_PCT);
  };
  const syncJibPos = () => {
    const v = readUiNumber("jibDraftPosPct");
    if (v === null) return;
    syncSectionsFromGlobal("jibSectionPos", v, EPS_PCT);
  };

  ["mainDraftPct", "mainDraftPctSlider"].forEach((id) => byId(id)?.addEventListener("input", syncMainDepth));
  ["mainDraftPosPct", "mainDraftPosPctSlider"].forEach((id) => byId(id)?.addEventListener("input", syncMainPos));
  ["jibDraftPct", "jibDraftPctSlider"].forEach((id) => byId(id)?.addEventListener("input", syncJibDepth));
  ["jibDraftPosPct", "jibDraftPosPctSlider"].forEach((id) => byId(id)?.addEventListener("input", syncJibPos));

  // Also trigger auto-run on other inputs (selects, etc)
  document.querySelectorAll("select, .field-row input").forEach(el => {
    if (el.id === "presetSelect") return;
    el.addEventListener("change", debouncedRun);
  });
  // Checkboxes for releasing partners springs
  ["partnersReleaseX", "partnersReleaseY"].forEach(id => {
    const el = byId(id);
    if (el) el.addEventListener("change", debouncedRun);
  });
  document.querySelectorAll(".section-row input").forEach(el => {
    const updateCustomFlag = () => {
      const id = el?.id || "";
      if (id.startsWith("mainSectionDepth")) {
        const g = readUiNumber("mainDraftPct");
        if (g !== null) syncSectionCustomFlag(el, g, EPS_PCT);
      } else if (id.startsWith("mainSectionPos")) {
        const g = readUiNumber("mainDraftPosPct");
        if (g !== null) syncSectionCustomFlag(el, g, EPS_PCT);
      } else if (id.startsWith("jibSectionDepth")) {
        const g = readUiNumber("jibDraftPct");
        if (g !== null) syncSectionCustomFlag(el, g, EPS_PCT);
      } else if (id.startsWith("jibSectionPos")) {
        const g = readUiNumber("jibDraftPosPct");
        if (g !== null) syncSectionCustomFlag(el, g, EPS_PCT);
      }
    };

    el.addEventListener("input", () => {
      updateCustomFlag();
      debouncedRun();
    });
    el.addEventListener("change", () => {
      updateCustomFlag();
      debouncedRun();
    });
  });

  // POV and Zoom Controls
  document.querySelectorAll(".pov-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const pov = btn.dataset.pov;
      const zoom = btn.dataset.zoom;

      if (pov) {
        if (pov === "side") rigView.yaw = -Math.PI / 2, rigView.pitch = 0;
        if (pov === "front") rigView.yaw = 0, rigView.pitch = 0;
        if (pov === "top") rigView.yaw = 0, rigView.pitch = Math.PI / 2;
        if (pov === "iso") rigView.yaw = -Math.PI / 4, rigView.pitch = 0.5;
      }

      if (zoom) {
        if (zoom === "in") rigView.zoom = clampValue(rigView.zoom * 1.2, 0.1, 10);
        if (zoom === "out") rigView.zoom = clampValue(rigView.zoom * 0.8, 0.1, 10);
        if (zoom === "reset") {
          rigView.zoom = 1.0;
          rigView.yaw = -1.0;
          rigView.pitch = 0.4;
        }
      }
      drawRigScene(rigScene);
    });
  });

  const runBtn = byId("runBtn");
  const exportJsonBtn = byId("exportJsonBtn");
  const exportCsvBtn = byId("exportCsvBtn");

  runBtn.addEventListener("click", runSimulation);

  // Cancel button handler
  const cancelBtn = byId("cancelBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (snipeApi.cancelSimulation) {
        const result = await snipeApi.cancelSimulation();
        if (result.cancelled) {
          hideLiveMetrics();
          setRigStatus("Simulacion cancelada");
        }
      }
    });
  }

  exportJsonBtn.addEventListener("click", async () => {
    if (!lastResults) return;
    await snipeApi.exportJson({
      suggestedName: "snipe-phase1-results.json",
      data: lastResults
    });
  });

  exportCsvBtn.addEventListener("click", async () => {
    if (!lastResults) return;
    await snipeApi.exportCsv({
      suggestedName: "snipe-phase1-results.csv",
      results: lastResults
    });
  });
}

main().catch((err) => {
  byId("solverOut").textContent = String(err?.stack ?? err);
  setRigStatus("Fallo al cargar UI");
});
