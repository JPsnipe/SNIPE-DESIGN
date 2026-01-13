/**
 * SnipeDesign Mobile — Core Logic & Renderer
 * Isolated from Electron api, uses Fetch for simulation.
 */

const rigView = { yaw: -1.0, pitch: 0.4, zoom: 1.0 };
let mobileCanvasEl = null;
let rigScene = null;
let frontProfileCanvasEl = null;
let sideProfileCanvasEl = null;
let presetsCache = [];
let currentResults = null;

function byId(id) {
    return document.getElementById(id);
}

// Formatters
function formatN(n) {
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)} kN`;
    return `${n.toFixed(1)} N`;
}

function mmToM(mm) { return mm / 1000; }
function kNToN(kN) { return kN * 1000; }

// --- Simulation API ---

async function runSimulation() {
    const statusEl = byId('canvasStatus');
    statusEl.textContent = 'Simulando...';

    const payload = gatherPayload();

    try {
        const resp = await fetch('/api/simulate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify(payload)
        });

        const results = await resp.json();
        currentResults = results;

        updateUI(results);
        rigScene = buildRigScene(payload, results);
        drawScene();

        statusEl.textContent = results.converged ? 'Convergido' : 'Error convergencia';
        showToast('Simulación completada');
    } catch (err) {
        console.error(err);
        statusEl.textContent = 'Error de conexión';
    }
}

function gatherPayload() {
    // Get values from sliders and inputs
    const getVal = (id) => {
        const el = byId(id);
        return el ? Number(el.value) : 0;
    };

    const g = {
        mastLengthM: mmToM(getVal('mastLengthMmSlider') || 6500),
        partnersZM: mmToM(getVal('partnersZMmSlider') || 395),
        spreaderZM: mmToM(getVal('spreaderZMmSlider') || 2500),
        houndsZM: mmToM(getVal('houndsZMmSlider') || 4800),
        chainplateXM: mmToM(getVal('chainplateXMmSlider') || 550),
        chainplateYM: mmToM(getVal('chainplateYMmSlider') || -363),
        bowYM: mmToM(1511),
    };

    const c = {
        spreaderLengthM: mmToM(getVal('spreaderLengthMmSlider') || 450),
        spreaderSweepAftM: mmToM((getVal('spreaderLengthMmSlider') || 450) * Math.sin((getVal('spreaderAngleSlider') || 8.4) * Math.PI / 180)),
        shroudDeltaL0PortM: 0,
        shroudDeltaL0StbdM: 0,
        shroudBaseDeltaM: mmToM(getVal('shroudBaseDeltaMmSlider') || 0),
        jibHalyardTensionN: kNToN(getVal('jibHalyardTensionkNSlider') || 0),
        partnersKx: 100000, // Standard stiffness
        partnersKy: 100000,
        partnersOffsetX: 0,
        partnersOffsetY: mmToM(getVal('partnersOffsetYSlider') || 0)
    };

    const stiffness = {
        mastEIBase: getVal('mastEIBaseSlider') || 7500,
        mastEITop: getVal('mastEITopSlider') || 3500,
        taperStartZM: mmToM(getVal('taperStartZMmSlider') || 4500),
    };

    const load = {
        mode: byId('loadMode')?.value || 'none',
        qLateralNpm: getVal('qLateralSlider') || 0,
        qProfile: 'uniform'
    };

    return {
        geometry: g,
        controls: c,
        stiffness: stiffness,
        load: load,
        sails: { enabled: false },
        solver: {
            mastSegments: 150,
            pretensionSteps: 5,
            loadSteps: 5,
            maxIterations: 200,
            toleranceN: 0.5,
            cableCompressionEps: 1e-7
        }
    };
}

function updateUI(results) {
    if (!results || !results.outputs) return;
    const o = results.outputs;
    const t = o.tensions || {};
    const eq = o.equilibrium || {};
    const spr = o.spreaders || {};

    // Helper to set text and apply slack class
    const setTension = (id, val) => {
        const el = byId(id);
        if (!el) return;
        el.textContent = formatN(val);
        if (val < 1) {
            el.classList.add('slack');
        } else {
            el.classList.remove('slack');
        }
    };

    // Tensions
    setTension('res-shroud-port', t.shroudPortN || 0);
    setTension('res-shroud-stbd', t.shroudStbdN || 0);
    setTension('res-stay', t.forestayN || 0);
    setTension('res-spr-port', spr.portAxialN || 0);
    setTension('res-spr-stbd', spr.stbdAxialN || 0);

    // Reactions
    byId('res-partners-rx').textContent = formatN(eq.partnersRx || 0);
    byId('res-partners-ry').textContent = formatN(eq.partnersRy || 0);
    byId('res-step-rx').textContent = formatN(eq.mastStepRx || 0);
    byId('res-step-ry').textContent = formatN(eq.mastStepRy || 0);
    byId('res-step-rz').textContent = formatN(eq.mastStepRz || 0);

    // Equilibrium
    const mag = eq.magnitude || 0;
    byId('res-eq-magnitude').textContent = `${mag.toFixed(1)} N`;
    const statusEl = byId('res-eq-status');
    if (eq.isBalanced) {
        statusEl.textContent = '✓ Balanceado';
        statusEl.className = 'eq-status eq-ok';
    } else if (mag < 50) {
        statusEl.textContent = '⚠ Casi balanceado';
        statusEl.className = 'eq-status eq-warn';
    } else {
        statusEl.textContent = '✗ Desequilibrio';
        statusEl.className = 'eq-status eq-err';
    }

    // Deflection (calculate max from loaded curve)
    const loaded = o.mastCurveLoaded || [];
    let maxDefl = 0;
    for (const p of loaded) {
        const defl = Math.sqrt((p.x || 0) ** 2 + (p.y || 0) ** 2);
        if (defl > maxDefl) maxDefl = defl;
    }
    byId('res-flecha').textContent = `${(maxDefl * 1000).toFixed(1)} mm`;

    // Slack Alerts
    const alertsEl = byId('slack-alerts');
    alertsEl.innerHTML = '';
    const slackItems = [];
    if ((t.shroudPortN || 0) < 1) slackItems.push('Obenque Babor');
    if ((t.shroudStbdN || 0) < 1) slackItems.push('Obenque Estribor');
    if ((t.forestayN || 0) < 1) slackItems.push('Forestay');

    for (const item of slackItems) {
        const div = document.createElement('div');
        div.className = 'slack-alert';
        div.innerHTML = `<span class="alert-icon">⚠️</span><span class="alert-text">${item} está SLACK (sin tensión)</span>`;
        alertsEl.appendChild(div);
    }

    // Update Overlay
    byId('overlay-stay').textContent = formatN(t.forestayN || 0);
    byId('overlay-shrouds').textContent = formatN(Math.max(t.shroudPortN || 0, t.shroudStbdN || 0));
    byId('overlay-defl').textContent = `${(maxDefl * 1000).toFixed(1)} mm`;
}

// --- 3D Rendering (Canvas 2D) ---

function lerp(a, b, t) { return a + (b - a) * t; }

function rotateVec(v, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // yaw around Y (up)
    const x1 = v.x * cy + v.z * sy;
    const z1 = -v.x * sy + v.z * cy;
    // pitch around X
    const y2 = v.y * cp - z1 * sp;
    const z2 = v.y * sp + z1 * cp;
    return { x: x1, y: y2, z: z2 };
}

const debounceRun = (() => {
    let timeout;
    return () => {
        clearTimeout(timeout);
        timeout = setTimeout(runSimulation, 400);
    };
})();

function buildRigScene(payload, results) {
    if (!results || !results.outputs) return null;
    const g = payload.geometry;
    const c = payload.controls;
    const o = results.outputs;
    const loaded = o.mastCurveLoaded || [];
    const prebend = o.mastCurvePrebend || [];

    const lines = [
        { points: prebend.map(p => ({ x: p.x, y: p.z, z: p.y })), color: 'rgba(71, 158, 245, 0.4)', width: 1.5 },
        { points: loaded.map(p => ({ x: p.x, y: p.z, z: p.y })), color: '#8dfa46', width: 3 }
    ];

    // Helpers
    const sample = (curve, z) => {
        if (!curve.length) return { x: 0, y: z, z: 0 };
        for (let i = 1; i < curve.length; i++) {
            if (z >= curve[i - 1].z && z <= curve[i].z) {
                const t = (z - curve[i - 1].z) / (curve[i].z - curve[i - 1].z);
                return { x: lerp(curve[i - 1].x, curve[i].x, t), y: z, z: lerp(curve[i - 1].y, curve[i].y, t) };
            }
        }
        return { x: 0, y: z, z: 0 };
    };

    const mastAtSpr = sample(loaded, g.spreaderZM);
    const hounds = sample(loaded, g.houndsZM);
    const top = loaded[loaded.length - 1] || { x: 0, y: 6.5, z: 0 };

    // Spreaders
    const xOut = c.spreaderLengthM; // Simplified
    const ySweep = -c.spreaderSweepAftM;
    const sprPort = { x: mastAtSpr.x - xOut, y: g.spreaderZM, z: mastAtSpr.z + ySweep };
    const sprStbd = { x: mastAtSpr.x + xOut, y: g.spreaderZM, z: mastAtSpr.z + ySweep };
    lines.push({ points: [mastAtSpr, sprPort], color: '#ffcc00', width: 2 });
    lines.push({ points: [mastAtSpr, sprStbd], color: '#ffcc00', width: 2 });

    // Rigging
    const chainP = { x: -g.chainplateXM, y: 0, z: g.chainplateYM };
    const chainS = { x: g.chainplateXM, y: 0, z: g.chainplateYM };
    const bow = { x: 0, y: 0, z: g.bowYM };

    // ForeStay
    lines.push({ points: [hounds, bow], color: 'rgba(255,255,255,0.4)', width: 1 });
    // Shrouds
    lines.push({ points: [hounds, sprPort, chainP], color: 'rgba(255,255,255,0.4)', width: 1 });
    // Use hounds for both unless shroudAttachZM is defined
    lines.push({ points: [hounds, sprStbd, chainS], color: 'rgba(255,255,255,0.4)', width: 1 });

    // Deck outline (very simplified)
    lines.push({
        points: [
            { x: -g.chainplateXM, y: 0, z: g.chainplateYM },
            { x: g.chainplateXM, y: 0, z: g.chainplateYM },
            { x: 0, y: 0, z: g.bowYM },
            { x: -g.chainplateXM, y: 0, z: g.chainplateYM }
        ],
        color: 'rgba(255,255,255,0.1)',
        width: 1
    });

    return { lines };
}

function drawScene() {
    if (!rigScene || !mobileCanvasEl) return;
    const ctx = mobileCanvasEl.getContext('2d');
    const w = mobileCanvasEl.width;
    const h = mobileCanvasEl.height;
    ctx.clearRect(0, 0, w, h);

    const scale = (h * 0.8 / 7.0) * rigView.zoom;
    // Lower center for better view of 6.5m mast
    const center = { x: w / 2, y: h * 0.95 };

    function project(p) {
        const r = rotateVec(p, rigView.yaw, rigView.pitch);
        return {
            x: center.x + r.x * scale,
            y: center.y - r.y * scale
        };
    }

    rigScene.lines.forEach(line => {
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.width;
        ctx.beginPath();
        line.points.forEach((p, i) => {
            const pt = project(p);
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
    });

    drawDualProfiles();
}

function drawDualProfiles() {
    drawProfile(frontProfileCanvasEl, 'x'); // Front view (X deflection)
    drawProfile(sideProfileCanvasEl, 'y');  // Side view (Y deflection)
}

function drawProfile(canvas, axis) {
    if (!canvas || !currentResults || !currentResults.outputs) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const o = currentResults.outputs;
    const loaded = o.mastCurveLoaded || [];
    if (loaded.length < 2) return;

    const mastH = 6.5;
    const padding = 8;
    const drawH = h - 2 * padding;
    const drawW = w - 2 * padding;

    const scaleZ = drawH / mastH;

    let maxDefl = 0.001;
    loaded.forEach(p => {
        const d = Math.abs(p[axis] || 0);
        if (d > maxDefl) maxDefl = d;
    });
    const scaleAxis = drawW / (Math.max(0.1, maxDefl) * 2.2);

    const getCoord = (p) => ({
        x: w / 2 + (p[axis] || 0) * scaleAxis,
        y: h - padding - (p.z || p.y) * scaleZ
    });

    // Grid / Graduations (Height)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'right';

    for (let mz = 0; mz <= mastH; mz += 1) {
        const yPos = h - padding - mz * scaleZ;
        ctx.beginPath();
        ctx.moveTo(padding, yPos);
        ctx.lineTo(w - padding, yPos);
        ctx.stroke();

        // Meter labels
        ctx.fillText(mz + 'm', w - 2, yPos + 3);
    }

    // Zero Reference
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 2, padding);
    ctx.lineTo(w / 2, h - padding);
    ctx.stroke();

    // Curve
    ctx.strokeStyle = axis === 'x' ? '#58a6ff' : '#8dfa46';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 4;
    ctx.shadowColor = axis === 'x' ? 'rgba(88,166,255,0.5)' : 'rgba(141,250,70,0.5)';
    ctx.beginPath();
    loaded.forEach((p, i) => {
        const c = getCoord(p);
        if (i === 0) ctx.moveTo(c.x, c.y);
        else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0; // Reset
}

// --- Interactions ---

function initInteractions() {
    mobileCanvasEl = byId('mobileCanvas');
    frontProfileCanvasEl = byId('frontProfileCanvas');
    sideProfileCanvasEl = byId('sideProfileCanvas');
    // Disable default touch behaviors to prevent scrolling while interacting with the 3D view
    mobileCanvasEl.style.touchAction = 'none';

    const resize = () => {
        const rect = mobileCanvasEl.parentElement.getBoundingClientRect();
        mobileCanvasEl.width = rect.width * devicePixelRatio;
        mobileCanvasEl.height = rect.height * devicePixelRatio;

        [frontProfileCanvasEl, sideProfileCanvasEl].forEach(canvas => {
            if (canvas) {
                const pr = canvas.getBoundingClientRect();
                canvas.width = pr.width * devicePixelRatio;
                canvas.height = pr.height * devicePixelRatio;
            }
        });
        drawScene();
    };
    window.addEventListener('resize', resize);
    resize();

    // Orbit
    let dragging = false;
    let lastX = 0, lastY = 0;

    const start = (e) => {
        dragging = true;
        const touch = e.touches ? e.touches[0] : e;
        lastX = touch.clientX;
        lastY = touch.clientY;
    };
    const move = (e) => {
        if (!dragging) return;
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - lastX;
        const dy = touch.clientY - lastY;
        rigView.yaw += dx * 0.01;
        rigView.pitch = Math.max(-1.5, Math.min(1.5, rigView.pitch + dy * 0.01));
        lastX = touch.clientX;
        lastY = touch.clientY;
        drawScene();
    };
    const end = () => dragging = false;

    mobileCanvasEl.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    mobileCanvasEl.addEventListener('touchstart', start);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', end);

    // Zoom
    byId('zoomIn').onclick = () => { rigView.zoom *= 1.2; drawScene(); };
    byId('zoomOut').onclick = () => { rigView.zoom /= 1.2; drawScene(); };

    // POV
    document.querySelectorAll('.pov-btn').forEach(btn => {
        btn.onclick = () => {
            const pov = btn.dataset.pov;
            if (pov === 'side') { rigView.yaw = -Math.PI / 2; rigView.pitch = 0; }
            if (pov === 'front') { rigView.yaw = 0; rigView.pitch = 0; }
            if (pov === 'top') { rigView.yaw = 0; rigView.pitch = Math.PI / 2; }
            if (pov === 'iso') { rigView.yaw = -1.0; rigView.pitch = 0.4; }
            drawScene();
        };
    });

    byId('resetView').onclick = () => {
        rigView.zoom = 1.0;
        drawScene();
        showToast('Zoom ajustado');
    };

    // Inputs
    document.querySelectorAll('input[type="range"]').forEach(slider => {
        const display = byId('val-' + slider.id.replace('Slider', ''));
        slider.oninput = () => {
            if (display) display.textContent = slider.value;
            debounceRun();
        };
    });
    byId('loadMode').onchange = debounceRun;

    byId('runBtn').onclick = runSimulation;
}

function showToast(msg) {
    const toast = byId('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

// Preset loading
async function initPresets() {
    try {
        const resp = await fetch('/api/presets', {
            headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        const presets = await resp.json();
        presetsCache = presets;

        const select = byId('presetSelect');
        presets.forEach((p, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = p.name || `Preset ${i}`;
            select.appendChild(opt);
        });

        select.onchange = () => applyPreset(select.value);
        if (presets.length > 0) applyPreset(0);

    } catch (err) { console.error('Error loading presets', err); }
}

function applyPreset(idx) {
    const p = presetsCache[idx];
    if (!p) return;

    // Simple mapper for mobile UI
    const map = (id, val) => {
        const el = byId(id + 'Slider');
        if (el) {
            el.value = val;
            const disp = byId('val-' + id);
            if (disp) disp.textContent = val;
        }
    };

    if (p.geometry) {
        map('mastLengthMm', p.geometry.mastLengthMm);
        map('partnersZMm', p.geometry.partnersZMm);
        map('spreaderZMm', p.geometry.spreaderZMm);
        map('houndsZMm', p.geometry.houndsZMm);
        map('chainplateXMm', p.geometry.chainplateXMm);
        map('chainplateYMm', p.geometry.chainplateYMm);
    }
    if (p.controls) {
        map('spreaderLengthMm', p.controls.spreaderLengthMm);
        map('spreaderAngle', p.controls.spreaderAngle);
        map('shroudBaseDeltaMm', p.controls.shroudBaseDeltaMm);
        map('partnersOffsetY', p.controls.partnersOffsetY);
        map('jibHalyardTensionkN', p.controls.jibHalyardTensionkN);
    }

    runSimulation();
}

// Start
window.onload = () => {
    initInteractions();
    initPresets();
};
