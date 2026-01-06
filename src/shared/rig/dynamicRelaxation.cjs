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
 */

const { zeros, dot, normInf, add } = require("./linsolve.cjs");

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

    // Inicialización
    const x = x0.slice();
    const v = zeros(n);  // Velocidades
    const m = new Array(n).fill(massScale);  // Masas nodales (uniformes)

    let prevKE = 0;  // Energía cinética anterior
    let peakCount = 0;  // Contador de picos de KE

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
            for (let i = 0; i < n; i++) v[i] = 0;
            peakCount++;
            prevKE = 0;
        } else {
            prevKE = KE;
        }

        // Actualizar velocidades: v += (F/m) * dt
        // F = -grad (fuerza = negativo del gradiente de energía)
        for (let i = 0; i < n; i++) {
            v[i] += (-grad[i] / m[i]) * dt;
        }

        // Actualizar posiciones: x += v * dt
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

    const x = x0.slice();
    const v = zeros(n);
    const m = new Array(n).fill(1.0);

    let peakCount = 0;


    const history = [];
    let forces = computeForces(x);
    let grad = forces.grad;

    const massValue = options.fixedMass ?? 10.0;
    for (let i = 0; i < n; i++) {
        m[i] = options.fixedMasses ? options.fixedMasses[i] : massValue;
    }
    let dt = dtBase;

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
                metrics: forces.metrics || {} // Nuevas métricas de membrana
            });
            if (!Number.isFinite(gInf)) break;
        }

        if (gInf < tol) {
            return { x, converged: true, iterations: iter, gradInf: gInf, energy: forces.energy, history, reason: "converged", solver: "dynamic_relaxation" };
        }

        // Kinetic damping (Power check)
        let power = 0;
        for (let i = 0; i < n; i++) power += -grad[i] * v[i];

        // Warm-up: No permitir acelerar dt todavía si estamos en el inicio
        const isWarmingUp = iter < 200;

        if (power < 0 && iter > 5) {
            // Peak detectado: Reiniciar velocidades
            for (let i = 0; i < n; i++) {
                // Opcional: Retroceder a la posición del peak
                x[i] -= 0.5 * v[i] * dt;
                v[i] = 0;
            }
            peakCount++;
            forces = computeForces(x);
            grad = forces.grad;
            dt = Math.max(dtBase * 0.1, dt * 0.5);
        } else {
            // Aceleración suave
            if (!isWarmingUp) {
                dt = Math.min(dtBase * 5, dt * 1.01);
            }
        }

        // Symplectic Euler
        for (let i = 0; i < n; i++) {
            v[i] += (-grad[i] / m[i]) * dt;
            x[i] += v[i] * dt;
        }

        forces = computeForces(x);
        grad = forces.grad;

        if (!Number.isFinite(forces.energy) || !Number.isFinite(normInf(grad))) {
            return { x, converged: false, iterations: iter, gradInf: gInf, history, reason: "nan_detected", solver: "dynamic_relaxation" };
        }
    }

    return { x, converged: false, iterations: maxIter, gradInf: normInf(grad), energy: forces.energy, history, reason: "max_iter", solver: "dynamic_relaxation" };
}

module.exports = {
    solveDynamicRelaxation,
    solveDynamicRelaxationAdaptive
};
