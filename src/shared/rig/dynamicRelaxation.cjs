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
    const a = zeros(n);  // Aceleraciones

    // Masas adaptativas (se ajustan durante la simulación)
    const m = new Array(n).fill(1.0);

    let prevKE = 0;
    let peakCount = 0;
    let dt = dtBase;

    const history = [];
    let forces = computeForces(x);
    let grad = forces.grad;

    const gInf0 = normInf(grad);
    // console.log("DR Start:", { energy: forces.energy, gInf: gInf0 });

    // Estimar masas basándose en gradiente inicial o valor mínimo seguro
    // Para elementos muy rígidos (mástil), necesitamos masas mayores
    const massBase = Math.max(10, gInf0 / n);
    for (let i = 0; i < n; i++) {
        m[i] = Math.max(1.0, Math.abs(grad[i]) / (gInf0 + 1e-9) * massBase);
    }

    for (let iter = 0; iter < maxIter; iter++) {
        // Energía cinética
        let KE = 0;
        for (let i = 0; i < n; i++) {
            KE += 0.5 * m[i] * v[i] * v[i];
        }

        const gInf = normInf(grad);

        if (iter % 100 === 0) {
            history.push({ iter, residual: gInf, energy: forces.energy, KE, peaks: peakCount, dt });
        }

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

        // Kinetic damping con hysteresis
        if (KE > prevKE * 1.01 && iter > 20) {
            for (let i = 0; i < n; i++) v[i] = 0;
            peakCount++;
            prevKE = 0;
            dt = Math.max(dtBase * 0.5, dt * 0.9);  // Reducir dt después de peak
        } else {
            prevKE = KE;
            dt = Math.min(dtBase * 2, dt * 1.01);  // Aumentar dt gradualmente
        }

        // Leapfrog integration (más estable que Euler)
        // v(t+dt/2) = v(t-dt/2) + a(t) * dt
        // x(t+dt) = x(t) + v(t+dt/2) * dt
        for (let i = 0; i < n; i++) {
            a[i] = -grad[i] / m[i];
            v[i] += a[i] * dt;
            x[i] += v[i] * dt;
        }

        forces = computeForces(x);
        grad = forces.grad;

        if (!Number.isFinite(forces.energy)) {
            return {
                x,
                converged: false,
                iterations: iter,
                gradInf: gInf,
                history,
                reason: "nan_detected"
            };
        }
    }

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

module.exports = {
    solveDynamicRelaxation,
    solveDynamicRelaxationAdaptive
};
