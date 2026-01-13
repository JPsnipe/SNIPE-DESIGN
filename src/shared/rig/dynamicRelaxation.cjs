/**
 * DYNAMIC RELAXATION SOLVER FOR MEMBRANES
 *
 * Método estándar usado por software profesional de membranas (EASY, etc.)
 *
 * ALGORITMO:
 * 1. Simula el sistema como si tuviera masa e inercia
 * 2. Deja que el sistema "vibre" hasta alcanzar equilibrio
 * 3. Usa damping cinético: reinicia velocidades cuando KE empieza a subir
 *
 * VENTAJAS:
 * - No necesita ensamblar ni invertir matriz de rigidez
 * - O(n) por iteración vs O(n³) para solver directo
 * - Muy robusto para grandes deformaciones y wrinkling
 * - Naturalmente estable para membranas no-lineales
 *
 * ANTIGRAVITY ASCENSION v1.0:
 * - Enhanced stability monitoring via system health metrics
 * - Adaptive dt reduction based on membrane health
 * - Graceful degradation with detailed diagnostics
 * - Early warning system for divergence patterns
 */

const { zeros, dot, normInf, add } = require("./linsolve.cjs");

function clampValue(v, min, max) {
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}

// ANTIGRAVITY ASCENSION v1.0: Stability thresholds
const HEALTH_WARNING_THRESHOLD = 0.9;    // Warn if health ratio drops below 90%
const HEALTH_CRITICAL_THRESHOLD = 0.7;   // Critical if below 70%
const FORCE_SPIKE_FACTOR = 100;          // Force increase factor that triggers alarm
const RESIDUAL_DIVERGENCE_LIMIT = 3;     // Max consecutive residual increases

/**
 * Dynamic Relaxation con Kinetic Damping
 * 
 * @param {Function} computeForces - Función que calcula fuerzas dado x: (x) => { grad, energy }
 * @param {number[]} x0 - Posición inicial
 * @param {Object} options - Opciones del solver
 * @returns {Object} - Resultado con x, converged, iterations, etc.
 */
function solveDynamicRelaxation(computeForces, x0, options = {}) {
    const n = x0.length;
    const maxIter = options.maxIter ?? 5000;
    const tol = options.tol ?? 1.0;  // Tolerancia en fuerza (N)
    const dt = options.dt ?? 0.01;   // Paso de tiempo virtual
    const massScale = options.massScale ?? 1.0;  // Factor de masa
    const warmupIters = options.warmupIters ?? 200;
    const viscousDamping = clampValue(options.viscousDamping ?? 0, 0, 1);

    // Inicialización
    const x = x0.slice();
    const v = zeros(n);  // Velocidades
    const m = new Array(n).fill(massScale);  // Masas nodales (uniformes)

    let prevKE = 0;  // Energía cinética anterior
    let peakCount = 0;  // Contador de picos de KE
    let xPrev = x.slice();

    // Historial para debugging
    const history = [];

    // Primer cálculo de fuerzas
    let forces = computeForces(x);
    let grad = forces.grad;

    for (let iter = 0; iter < maxIter; iter++) {
        // Calcular energía cinética
        let KE = 0;
        for (let i = 0; i < n; i++) {
            KE += 0.5 * m[i] * v[i] * v[i];
        }

        // Norma del gradiente (residuo de fuerza)
        const gInf = normInf(grad);

        // Guardar historial cada 50 iteraciones
        if (iter % 50 === 0) {
            history.push({
                iter,
                residual: gInf,
                energy: forces.energy,
                kineticEnergy: KE,
                peaks: peakCount
            });
        }

        // Convergencia
        if (gInf < tol) {
            return {
                x,
                converged: true,
                iterations: iter,
                gradInf: gInf,
                energy: forces.energy,
                history,
                reason: "converged"
            };
        }

        // KINETIC DAMPING: Si KE empieza a subir, reiniciar velocidades
        // Esto es el "truco" que hace DR tan robusto
        if (KE > prevKE && iter > 10) {
            // Pico de energía cinética detectado
            // Reiniciar velocidades a cero - el sistema está en un mínimo local
            for (let i = 0; i < n; i++) {
                // Backtrack simple a la última posición estable
                x[i] = xPrev[i];
                v[i] = 0;
            }
            peakCount++;
            prevKE = 0;
        } else {
            prevKE = KE;
        }

        // Actualizar velocidades: v += (F/m) * dt
        // F = -grad (fuerza = negativo del gradiente de energía)
        for (let i = 0; i < n; i++) {
            if (iter < warmupIters && viscousDamping > 0) {
                v[i] *= (1 - viscousDamping);
            }
            v[i] += (-grad[i] / m[i]) * dt;
        }

        // Actualizar posiciones: x += v * dt
        xPrev = x.slice();
        for (let i = 0; i < n; i++) {
            x[i] += v[i] * dt;
        }

        // Recalcular fuerzas en nueva posición
        forces = computeForces(x);
        grad = forces.grad;

        // Verificar NaN
        if (!Number.isFinite(forces.energy)) {
            return {
                x,
                converged: false,
                iterations: iter,
                gradInf: gInf,
                energy: forces.energy,
                history,
                reason: "nan_detected"
            };
        }
    }

    // No convergió
    return {
        x,
        converged: false,
        iterations: maxIter,
        gradInf: normInf(grad),
        energy: forces.energy,
        history,
        reason: "max_iter"
    };
}

/**
 * Dynamic Relaxation adaptivo con masa variable
 * 
 * Versión mejorada que ajusta la masa nodal basándose en la rigidez local
 * para mejor condicionamiento numérico.
 */
function solveDynamicRelaxationAdaptive(computeForces, x0, options = {}) {
    const n = x0.length;
    const maxIter = options.maxIter ?? 10000;
    const tol = options.tol ?? 1.0;
    const dtBase = options.dt ?? 0.005;
    const maxStep = Number.isFinite(options.maxStepM) ? Math.max(1e-6, options.maxStepM) : 0.01;
    const warmupIters = Number.isFinite(options.warmupIters) ? Math.max(0, Math.trunc(options.warmupIters)) : 200;
    const viscousDamping = clampValue(options.viscousDamping ?? 0.1, 0, 0.5);  // Default 10% damping
    const viscousDampingPost = clampValue(
        options.viscousDampingPost ?? (viscousDamping * 0.5),
        0,
        0.5
    );
    const kineticBacktrack = clampValue(options.kineticBacktrack ?? 1.0, 0, 1);
    const dtGrow = Number.isFinite(options.dtGrow) ? clampValue(options.dtGrow, 1.0, 1.2) : 1.005;  // Slower growth
    const dtShrink = Number.isFinite(options.dtShrink) ? clampValue(options.dtShrink, 0.1, 1.0) : 0.5;
    const dtMin = Number.isFinite(options.dtMin) ? Math.max(1e-8, options.dtMin) : dtBase * 0.01;
    const dtMax = Number.isFinite(options.dtMax) ? Math.max(dtMin, options.dtMax) : dtBase * 2;
    const stabilityFactor = Number.isFinite(options.stabilityFactor) ? clampValue(options.stabilityFactor, 0.1, 2.0) : 0.25;  // More conservative
    const residualSpikeFactor = Number.isFinite(options.residualSpikeFactor)
        ? Math.max(1.5, options.residualSpikeFactor)
        : 3.0;  // More sensitive to spikes
    const residualIncreaseTol = Number.isFinite(options.residualIncreaseTol)
        ? Math.max(0, options.residualIncreaseTol)
        : 0.02;  // Tighter tolerance
    const residualIncreaseMax = Number.isFinite(options.residualIncreaseMax)
        ? Math.max(1, Math.trunc(options.residualIncreaseMax))
        : 3;  // Fewer allowed increases
    const minIter = Number.isFinite(options.minIter) ? Math.max(0, Math.trunc(options.minIter)) : 0;
    const minPressureScale = Number.isFinite(options.minPressureScale)
        ? clampValue(options.minPressureScale, 0, 1)
        : null;
    const stiffnessDiag = Array.isArray(options.stiffnessDiag) ? options.stiffnessDiag : null;
    const nanMaxRetries = Number.isFinite(options.nanMaxRetries) ? Math.max(0, Math.trunc(options.nanMaxRetries)) : 5;  // More retries
    const nanShrink = Number.isFinite(options.nanShrink) ? clampValue(options.nanShrink, 0.1, 1.0) : 0.25;  // More aggressive shrink
    const dxEps = Number.isFinite(options.dxEps)
        ? Math.max(1e-12, options.dxEps)
        : (Number.isFinite(maxStep) ? Math.max(1e-6, maxStep * 0.1) : 1e-6);

    const x = x0.slice();
    const v = zeros(n);
    const m = new Array(n).fill(1.0);

    let peakCount = 0;
    let xPrev = x.slice();
    let prevResidual = Infinity;
    let incCount = 0;
    let bestX = x.slice();
    let minResidual = Infinity;
    let nanCount = 0;

    // ANTIGRAVITY ASCENSION v1.0: Health tracking
    let healthDegradationCount = 0;
    let prevHealthRatio = 1.0;
    let forceSpikes = 0;
    let prevMaxElementForce = 0;

    const history = [];
    let forces = computeForces(x, 0);
    let grad = forces.grad;

    const massValue = options.fixedMass ?? 10.0;
    for (let i = 0; i < n; i++) {
        m[i] = options.fixedMasses ? options.fixedMasses[i] : massValue;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADAPTIVE INITIAL dt BASED ON MAXIMUM FORCE
    // ═══════════════════════════════════════════════════════════════════
    // If initial forces are very large, start with a tiny dt to avoid explosion.
    // The goal is: max_displacement = (F_max / m_min) * dt^2 < maxStep
    // So: dt < sqrt(maxStep * m_min / F_max)
    const initialGradMax = normInf(grad);
    let dt = dtBase;
    if (Number.isFinite(initialGradMax) && initialGradMax > 1e-6) {
        const minMass = Math.min(...m.filter(Number.isFinite));
        const dtSafe = Math.sqrt((maxStep * minMass) / initialGradMax);
        if (Number.isFinite(dtSafe) && dtSafe < dtBase) {
            dt = Math.max(dtMin, dtSafe * 0.5);  // Extra safety factor
            if (options.debug) {
                console.log(`DR: Initial gradMax=${initialGradMax.toExponential(2)}, reducing dt from ${dtBase} to ${dt.toExponential(3)}`);
            }
        }
    }

    for (let iter = 0; iter < maxIter; iter++) {
        const gInf = normInf(grad);

        if (options.debug && iter < 50) {
            const vMax = normInf(v);
            const xMax = normInf(x);
            console.log(`DR[${iter}] Res=${gInf.toExponential(3)}, vMax=${vMax.toExponential(3)}, xMax=${xMax.toExponential(3)}`);
        }

        // Registro de historia
        if (iter % 100 === 0 || iter < 20) {
            let KE = 0;
            for (let i = 0; i < n; i++) KE += 0.5 * m[i] * v[i] * v[i];

            history.push({
                iter,
                residual: gInf,
                energy: forces.energy,
                KE,
                peaks: peakCount,
                dt,
                power: Number.isFinite(forces.power) ? forces.power : null,
                accelMax: Number.isFinite(forces.accelMax) ? forces.accelMax : null,
                metrics: forces.metrics || {} // Nuevas métricas de membrana
            });
            if (!Number.isFinite(gInf)) break;
        }

        // ANTIGRAVITY ASCENSION v1.0: System health monitoring
        const systemHealth = forces.metrics?.systemHealth;
        if (systemHealth) {
            const healthRatio = systemHealth.healthRatio ?? 1.0;
            const maxElementForce = systemHealth.maxElementForce ?? 0;

            // Track health degradation
            if (healthRatio < prevHealthRatio - 0.05) {
                healthDegradationCount++;
            } else {
                healthDegradationCount = Math.max(0, healthDegradationCount - 1);
            }
            prevHealthRatio = healthRatio;

            // Track force spikes
            if (prevMaxElementForce > 0 && maxElementForce > prevMaxElementForce * FORCE_SPIKE_FACTOR) {
                forceSpikes++;
                // Aggressive dt reduction on force spike
                dt = Math.max(dtMin, dt * 0.5);
                if (options.debug) {
                    console.log(`DR[${iter}] FORCE SPIKE: ${prevMaxElementForce.toExponential(2)} → ${maxElementForce.toExponential(2)}, reducing dt to ${dt.toExponential(3)}`);
                }
            }
            prevMaxElementForce = maxElementForce;

            // Health-based dt adjustment
            if (healthRatio < HEALTH_CRITICAL_THRESHOLD) {
                // Critical health - reduce dt aggressively
                dt = Math.max(dtMin, dt * 0.25);
                if (options.debug) {
                    console.log(`DR[${iter}] CRITICAL HEALTH: ratio=${healthRatio.toFixed(3)}, reducing dt to ${dt.toExponential(3)}`);
                }
            } else if (healthRatio < HEALTH_WARNING_THRESHOLD && iter > warmupIters) {
                // Warning health - reduce dt slightly
                dt = Math.max(dtMin, dt * 0.75);
            }

            // Too many health degradations - backtrack
            if (healthDegradationCount >= 3) {
                for (let i = 0; i < n; i++) {
                    x[i] = xPrev[i];
                    v[i] = 0;
                }
                peakCount++;
                forces = computeForces(x, iter);
                grad = forces.grad;
                dt = Math.max(dtMin, dt * dtShrink);
                prevResidual = normInf(grad);
                xPrev = x.slice();
                healthDegradationCount = 0;
                continue;
            }
        }

        if (Number.isFinite(gInf) && gInf < minResidual) {
            minResidual = gInf;
            bestX = x.slice();
        }

        const pressureScale = forces.metrics?.pressureScale;
        const pressureReady = minPressureScale === null ||
            !Number.isFinite(pressureScale) ||
            pressureScale >= minPressureScale;
        if (gInf < tol && iter >= minIter && pressureReady) {
            return { x, converged: true, iterations: iter, gradInf: gInf, energy: forces.energy, history, reason: "converged", solver: "dynamic_relaxation" };
        }

        if (Number.isFinite(prevResidual)) {
            if (gInf > prevResidual * (1 + residualIncreaseTol) && iter > 2) incCount++;
            else incCount = 0;
        }

        if (incCount >= residualIncreaseMax) {
            for (let i = 0; i < n; i++) {
                x[i] = xPrev[i];
                v[i] = 0;
            }
            peakCount++;
            forces = computeForces(x, iter);
            grad = forces.grad;
            dt = Math.max(dtMin, dt * dtShrink);
            prevResidual = normInf(grad);
            xPrev = x.slice();
            incCount = 0;
            continue;
        }

        if (Number.isFinite(prevResidual) && prevResidual > 0 && gInf > prevResidual * residualSpikeFactor && iter > 2) {
            for (let i = 0; i < n; i++) {
                x[i] = xPrev[i];
                v[i] = 0;
            }
            peakCount++;
            forces = computeForces(x, iter);
            grad = forces.grad;
            dt = Math.max(dtMin, dt * dtShrink);
            prevResidual = normInf(grad);
            xPrev = x.slice();
            continue;
        }

        // Kinetic damping (Power check)
        let power = 0;
        for (let i = 0; i < n; i++) power += -grad[i] * v[i];
        forces.power = power;

        // Warm-up: No permitir acelerar dt todavía si estamos en el inicio
        const isWarmingUp = iter < warmupIters;

        if (power < 0 && iter > 5) {
            // Peak detectado: Reiniciar velocidades
            for (let i = 0; i < n; i++) {
                // Retroceder hacia la última posición estable
                x[i] = x[i] - kineticBacktrack * (x[i] - xPrev[i]);
                v[i] = 0;
            }
            peakCount++;
            forces = computeForces(x, iter);
            grad = forces.grad;
            dt = Math.max(dtMin, dt * dtShrink);
            prevResidual = normInf(grad);
            xPrev = x.slice();
            incCount = 0;
        } else {
            // Aceleración suave
            if (!isWarmingUp) {
                dt = Math.min(dtMax, dt * dtGrow);
            }
        }

        // Symplectic Euler with step clamping
        let accelMax = 0;
        if (stabilityFactor > 0 && Number.isFinite(maxStep)) {
            for (let i = 0; i < n; i++) {
                const acc = Math.abs(grad[i] / m[i]);
                if (Number.isFinite(acc)) accelMax = Math.max(accelMax, acc);
            }
        }
        forces.accelMax = accelMax;
        if (accelMax > 0 && Number.isFinite(maxStep)) {
            const dtStable = Math.sqrt((maxStep * stabilityFactor) / accelMax);
            if (Number.isFinite(dtStable)) dt = Math.max(dtMin, Math.min(dt, dtStable));
        }
        if (stabilityFactor > 0 && stiffnessDiag && stiffnessDiag.length === n) {
            let dtStiff = dtMax;
            for (let i = 0; i < n; i++) {
                const k = stiffnessDiag[i];
                if (!Number.isFinite(k) || k <= 0) continue;
                const dtLocal = Math.sqrt((stabilityFactor * m[i]) / k);
                if (Number.isFinite(dtLocal)) dtStiff = Math.min(dtStiff, dtLocal);
            }
            if (Number.isFinite(dtStiff)) dt = Math.max(dtMin, Math.min(dt, dtStiff));
        }
        if (stabilityFactor > 0 && Number.isFinite(dxEps)) {
            let dtStep = dtMax;
            for (let i = 0; i < n; i++) {
                const dx = Math.abs(x[i] - xPrev[i]);
                if (!Number.isFinite(dx) || dx < dxEps) continue;
                const kEst = Math.abs(grad[i]) / dx;
                if (!Number.isFinite(kEst) || kEst <= 0) continue;
                const dtLocal = Math.sqrt((stabilityFactor * m[i]) / kEst);
                if (Number.isFinite(dtLocal)) dtStep = Math.min(dtStep, dtLocal);
            }
            if (Number.isFinite(dtStep)) dt = Math.max(dtMin, Math.min(dt, dtStep));
        }

        const vCap = Number.isFinite(options.velocityCap)
            ? Math.max(1e-6, options.velocityCap)
            : (Number.isFinite(maxStep) ? (maxStep / dtBase) : Infinity);

        xPrev = x.slice();
        const stepDamping = isWarmingUp ? viscousDamping : viscousDampingPost;
        let maxDx = 0;
        let clampedCount = 0;
        for (let i = 0; i < n; i++) {
            if (stepDamping > 0) {
                v[i] *= (1 - stepDamping);
            }
            const acc = -grad[i] / m[i];
            // Clamp acceleration to prevent explosion from huge forces
            const maxAcc = maxStep / (dt * dt);
            const accClamped = Math.abs(acc) > maxAcc ? Math.sign(acc) * maxAcc : acc;
            v[i] += accClamped * dt;
            if (Number.isFinite(vCap) && Math.abs(v[i]) > vCap) {
                v[i] = Math.sign(v[i]) * vCap;
            }
            let dx = v[i] * dt;
            // Clamp step to prevent degenerate triangles
            if (Math.abs(dx) > maxStep) {
                dx = Math.sign(dx) * maxStep;
                v[i] = dx / dt; // Adjust velocity to match clamped step
                clampedCount++;
            }
            maxDx = Math.max(maxDx, Math.abs(dx));
            x[i] += dx;

            // SANITY CHECK: Position should not explode
            // El mástil de Snipe mide 6.5m, así que posiciones hasta 20m son razonables
            // Límite aumentado a 50m para cubrir casos extremos sin perder estabilidad
            if (!Number.isFinite(x[i]) || Math.abs(x[i]) > 50) {
                // Revert this DOF to previous value
                x[i] = xPrev[i];
                v[i] = 0;
            }
        }

        // If too many DOFs are being clamped, reduce dt further
        if (clampedCount > n * 0.1 && dt > dtMin) {
            dt = Math.max(dtMin, dt * 0.8);
        }

        forces = computeForces(x, iter);
        grad = forces.grad;

        const gradInfNow = normInf(grad);
        if (!Number.isFinite(forces.energy) || !Number.isFinite(gradInfNow)) {
            if (nanCount < nanMaxRetries) {
                nanCount++;
                for (let i = 0; i < n; i++) {
                    x[i] = xPrev[i];
                    v[i] = 0;
                }
                dt = Math.max(dtMin, dt * nanShrink);
                forces = computeForces(x, iter);
                grad = forces.grad;
                const retryGradInf = normInf(grad);
                if (!Number.isFinite(forces.energy) || !Number.isFinite(retryGradInf)) {
                    return { x: bestX, converged: false, iterations: iter, gradInf: minResidual, history, reason: "nan_detected", solver: "dynamic_relaxation" };
                }
                prevResidual = retryGradInf;
                xPrev = x.slice();
                incCount = 0;
                continue;
            }
            return { x: bestX, converged: false, iterations: iter, gradInf: minResidual, history, reason: "nan_detected", solver: "dynamic_relaxation" };
        }

        prevResidual = gInf;
    }

    // ANTIGRAVITY ASCENSION v1.0: Enhanced return with diagnostics
    return {
        x: bestX,
        converged: false,
        iterations: maxIter,
        gradInf: minResidual,
        energy: forces.energy,
        history,
        reason: "max_iter",
        solver: "dynamic_relaxation",
        // Detailed diagnostics
        diagnostics: {
            peakCount,
            nanCount,
            forceSpikes,
            healthDegradationCount,
            finalHealthRatio: prevHealthRatio,
            finalMaxElementForce: prevMaxElementForce
        }
    };
}

module.exports = {
    solveDynamicRelaxation,
    solveDynamicRelaxationAdaptive
};
