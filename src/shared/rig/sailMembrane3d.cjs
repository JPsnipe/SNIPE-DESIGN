/**
 * MODELO DE MEMBRANA PARA VELAS
 *
 * Implementación de elementos finitos de membrana triangulares (CST)
 * para simular el comportamiento físico correcto de velas bajo presión.
 *
 * FÍSICA:
 * - Las velas son membranas: resisten tensión en el plano pero NO flexión
 * - Bajo presión, la membrana adopta una forma de equilibrio donde:
 *   Tensión de membrana × Curvatura = Presión
 * - Sin pretensión, la membrana es singular (no tiene rigidez)
 *
 * FORMULACIÓN:
 * - Elementos triangulares de 3 nodos (CST - Constant Strain Triangle)
 * - Formulación Lagrangiana Total para grandes desplazamientos
 * - Tensor de deformación Green-Lagrange
 * - Presión como "follower load" (sigue la normal deformada)
 *
 * ESTABILIZACIÓN (basada en literatura):
 * - Tension Field Theory: wrinkling cuando hay compresión
 * - Rigidez residual pequeña (1e-4) para evitar singularidad
 * - Pretensión geométrica basada en presión esperada
 */

const { zeros, sub3, norm3, cross3, dot3, add3, scale3, skew3 } = require("./math3.cjs");
const { normInf } = require("./linsolve.cjs");

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES MATEMÁTICAS PARA MEMBRANAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calcula la normal unitaria de un triángulo
 */
function triangleNormal(p0, p1, p2) {
  const e1 = sub3(p1, p0);
  const e2 = sub3(p2, p0);
  const n = cross3(e1, e2);
  const len = norm3(n);
  if (len < 1e-12) return [0, 0, 1]; // Fallback
  return [n[0] / len, n[1] / len, n[2] / len];
}

/**
 * Calcula el área de un triángulo
 */
function triangleArea(p0, p1, p2) {
  const e1 = sub3(p1, p0);
  const e2 = sub3(p2, p0);
  const n = cross3(e1, e2);
  return 0.5 * norm3(n);
}

/**
 * Producto exterior de dos vectores 3D → matriz 3x3
 */
function outer3(a, b) {
  return [
    [a[0] * b[0], a[0] * b[1], a[0] * b[2]],
    [a[1] * b[0], a[1] * b[1], a[1] * b[2]],
    [a[2] * b[0], a[2] * b[1], a[2] * b[2]]
  ];
}

/**
 * Matriz identidad 2x2
 */
function eye2() {
  return [[1, 0], [0, 1]];
}

/**
 * Multiplica matriz 2x2 por vector 2
 */
function mv2(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1],
    M[1][0] * v[0] + M[1][1] * v[1]
  ];
}

/**
 * Multiplica matrices 2x2
 */
function mm2(A, B) {
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]
  ];
}

/**
 * Transpone matriz 2x2
 */
function transpose2(M) {
  return [[M[0][0], M[1][0]], [M[0][1], M[1][1]]];
}

/**
 * Determinante de matriz 2x2
 */
function det2(M) {
  return M[0][0] * M[1][1] - M[0][1] * M[1][0];
}

/**
 * Inversa de matriz 2x2
 */
function inv2(M) {
  const d = det2(M);
  // Un determinante de 1e-12 significa un triángulo muy deformado o pequeño.
  // Es mejor ignorarlo que producir fuerzas astronómicas.
  if (Math.abs(d) < 1e-12) return [[1, 0], [0, 1]];
  return [
    [M[1][1] / d, -M[0][1] / d],
    [-M[1][0] / d, M[0][0] / d]
  ];
}

/**
 * Calcula valores propios de matriz simétrica 2x2
 * Retorna [lambda1, lambda2] ordenados de mayor a menor
 */
function eigenvalues2x2(M) {
  const a = M[0][0];
  const b = M[0][1];
  const c = M[1][0];
  const d = M[1][1];

  const trace = a + d;
  const det = a * d - b * c;
  const disc = trace * trace - 4 * det;

  if (disc < 0) {
    // No debería pasar para matriz simétrica real
    return [trace / 2, trace / 2];
  }

  const sqrtDisc = Math.sqrt(disc);
  const lambda1 = (trace + sqrtDisc) / 2;
  const lambda2 = (trace - sqrtDisc) / 2;

  return [lambda1, lambda2];
}

/**
 * Calcula vectores propios de matriz simétrica 2x2
 * Retorna [[v1x, v1y], [v2x, v2y]] correspondientes a [lambda1, lambda2]
 */
function eigenvectors2x2(M, eigenvals) {
  const [lambda1, lambda2] = eigenvals;
  const a = M[0][0];
  const b = M[0][1];

  // Vector propio para lambda1
  let v1;
  if (Math.abs(b) > 1e-12) {
    v1 = [lambda1 - M[1][1], b];
  } else if (Math.abs(a - lambda1) > 1e-12) {
    v1 = [b, lambda1 - a];
  } else {
    v1 = [1, 0];
  }
  const n1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1]);
  if (n1 > 1e-12) v1 = [v1[0] / n1, v1[1] / n1];

  // Vector propio para lambda2 (perpendicular a v1 para matriz simétrica)
  const v2 = [-v1[1], v1[0]];

  return [v1, v2];
}

// ═══════════════════════════════════════════════════════════════════════════
// ELEMENTO DE MEMBRANA CST (Constant Strain Triangle)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea un elemento de membrana triangular
 *
 * @param {number[]} nodeIds - IDs de los 3 nodos [i, j, k]
 * @param {Object} material - Propiedades del material
 * @param {number} material.E - Módulo de Young (Pa)
 * @param {number} material.nu - Coeficiente de Poisson
 * @param {number} material.thickness - Espesor de la membrana (m)
 * @param {number} material.prestress - Pretensión inicial (Pa)
 */
function createMembraneElement(nodeIds, material) {
  return {
    type: "membrane",
    nodeIds: nodeIds.slice(),
    E: material.E ?? 5e7,           // 50 MPa típico para velas de Dacron
    nu: material.nu ?? 0.3,
    thickness: material.thickness ?? 0.00025,  // 0.25 mm
    prestress: material.prestress ?? 0,        // Pretensión explícita
    // Rigidez residual en compresión (Tension Field Theory)
    // Valor típico: 1e-4 a 1e-6 del valor en tensión
    wrinklingEps: material.wrinklingEps ?? 1e-4
  };
}

/**
 * Calcula la matriz constitutiva de membrana (tensión plana)
 *
 * Para material isótropo en tensión plana:
 * [σ11]     E      [1  ν  0 ] [ε11]
 * [σ22] = ------ * [ν  1  0 ] [ε22]
 * [σ12]   1-ν²     [0  0 (1-ν)/2] [2ε12]
 */
function membraneConstitutive(E, nu) {
  const factor = E / (1 - nu * nu);
  return [
    [factor, factor * nu, 0],
    [factor * nu, factor, 0],
    [0, 0, factor * (1 - nu) / 2]
  ];
}

/**
 * Calcula la base local del triángulo en la configuración de referencia
 * Retorna dos vectores tangentes y la normal
 */
function computeLocalBasis(p0, p1, p2) {
  // e1 = dirección del primer lado
  const e1_raw = sub3(p1, p0);
  const len1 = norm3(e1_raw);
  const e1 = len1 > 1e-12 ? scale3(e1_raw, 1 / len1) : [1, 0, 0];

  // n = normal al plano
  const e2_raw = sub3(p2, p0);
  const n_raw = cross3(e1_raw, e2_raw);
  const lenN = norm3(n_raw);
  const n = lenN > 1e-12 ? scale3(n_raw, 1 / lenN) : [0, 0, 1];

  // e2 = perpendicular a e1 en el plano del triángulo
  const e2 = cross3(n, e1);

  return { e1, e2, n, area: 0.5 * lenN };
}

/**
 * Proyecta un punto 3D al sistema local 2D del triángulo
 */
function projectToLocal(p, p0, e1, e2) {
  const dp = sub3(p, p0);
  return [dot3(dp, e1), dot3(dp, e2)];
}

/**
 * Calcula el gradiente de deformación F para un elemento de membrana
 *
 * F = ∂x/∂X donde x es la posición deformada y X es la referencia
 *
 * Para CST, F es constante en todo el elemento
 */
function computeDeformationGradient(elem, nodesRef, nodesCur) {
  const [i, j, k] = elem.nodeIds;

  // Posiciones de referencia
  const X0 = nodesRef[i];
  const X1 = nodesRef[j];
  const X2 = nodesRef[k];

  // Posiciones actuales
  const x0 = nodesCur[i];
  const x1 = nodesCur[j];
  const x2 = nodesCur[k];

  // Base local de referencia
  const { e1, e2, n, area } = computeLocalBasis(X0, X1, X2);

  // Coordenadas locales de referencia (2D)
  const P0 = [0, 0]; // Origen en el primer nodo
  const P1 = projectToLocal(X1, X0, e1, e2);
  const P2 = projectToLocal(X2, X0, e1, e2);

  // Coordenadas locales actuales (proyectadas al mismo sistema)
  const p0 = projectToLocal(x0, X0, e1, e2);
  const p1 = projectToLocal(x1, X0, e1, e2);
  const p2 = projectToLocal(x2, X0, e1, e2);

  // Matriz de referencia (lados del triángulo en coordenadas locales)
  // Dm = [X1-X0, X2-X0] como columnas
  const Dm = [
    [P1[0] - P0[0], P2[0] - P0[0]],
    [P1[1] - P0[1], P2[1] - P0[1]]
  ];

  // Matriz deformada
  // Ds = [x1-x0, x2-x0] como columnas
  const Ds = [
    [p1[0] - p0[0], p2[0] - p0[0]],
    [p1[1] - p0[1], p2[1] - p0[1]]
  ];

  // F = Ds * Dm^(-1)
  const DmInv = inv2(Dm);
  const F = mm2(Ds, DmInv);

  return { F, Dm, Ds, DmInv, e1, e2, n, area, P0, P1, P2, p0, p1, p2 };
}

/**
 * Calcula el tensor de deformación Green-Lagrange
 * E = 0.5 * (F^T * F - I)
 */
function greenLagrangeStrain(F) {
  const FtF = mm2(transpose2(F), F);
  return [
    [0.5 * (FtF[0][0] - 1), 0.5 * FtF[0][1]],
    [0.5 * FtF[1][0], 0.5 * (FtF[1][1] - 1)]
  ];
}

/**
 * Convierte tensor 2x2 simétrico a vector de Voigt [E11, E22, 2*E12]
 */
function toVoigt(E) {
  return [E[0][0], E[1][1], 2 * E[0][1]];
}

/**
 * Convierte vector de Voigt a tensor 2x2 simétrico
 */
function fromVoigt(v) {
  return [[v[0], v[2] / 2], [v[2] / 2, v[1]]];
}

// ═══════════════════════════════════════════════════════════════════════════
// MODELO DE WRINKLING (Tension Field Theory)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estado de la membrana según tensiones principales
 */
const MEMBRANE_STATE = {
  TAUT: 0,      // Ambas tensiones principales positivas (tensión biaxial)
  WRINKLED: 1,  // Una tensión positiva, otra negativa (arrugas)
  SLACK: 2      // Ambas tensiones negativas (membrana floja)
};

/**
 * Aplica el modelo de wrinkling (Tension Field Theory)
 *
 * Cuando una membrana está en compresión en una dirección, forma arrugas.
 * No puede soportar compresión, así que la tensión en esa dirección se anula.
 *
 * @param {number[]} S_voigt - Tensor de tensión [S11, S22, S12] en Voigt
 * @param {number} wrinklingEps - Rigidez residual en compresión (típico 1e-4)
 * @returns {Object} - Estado, tensión modificada, y factor de rigidez
 */
function applyWrinklingModel(S_voigt, wrinklingEps) {
  const S_tensor = fromVoigt(S_voigt);
  const eigenvals = eigenvalues2x2(S_tensor);
  const [sigma1, sigma2] = eigenvals; // sigma1 >= sigma2

  let state = MEMBRANE_STATE.TAUT;
  let stiffnessFactor = 1.0;
  let S_modified = S_voigt.slice();

  if (sigma2 < 0 && sigma1 > 0) {
    // WRINKLED: Una dirección en tensión, otra en compresión
    state = MEMBRANE_STATE.WRINKLED;

    // Reducir rigidez en dirección de compresión
    // Reconstruir tensor con sigma2 → sigma2 * wrinklingEps
    const eigenvecs = eigenvectors2x2(S_tensor, eigenvals);
    const [v1, v2] = eigenvecs;

    // S_new = sigma1 * v1⊗v1 + sigma2*eps * v2⊗v2
    const sigma2_mod = sigma2 * wrinklingEps;
    S_modified = [
      sigma1 * v1[0] * v1[0] + sigma2_mod * v2[0] * v2[0],
      sigma1 * v1[1] * v1[1] + sigma2_mod * v2[1] * v2[1],
      2 * (sigma1 * v1[0] * v1[1] + sigma2_mod * v2[0] * v2[1])
    ];

    stiffnessFactor = 0.5 + 0.5 * wrinklingEps; // Factor medio

  } else if (sigma1 <= 0) {
    // SLACK: Ambas direcciones en compresión
    state = MEMBRANE_STATE.SLACK;

    // Reducir toda la rigidez
    S_modified = [
      S_voigt[0] * wrinklingEps,
      S_voigt[1] * wrinklingEps,
      S_voigt[2] * wrinklingEps
    ];

    stiffnessFactor = wrinklingEps;
  }

  return { state, S_modified, stiffnessFactor, principalStresses: [sigma1, sigma2] };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENERGÍA Y GRADIENTE DE MEMBRANA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calcula la energía de deformación y el gradiente (fuerzas internas)
 * para un elemento de membrana, incluyendo modelo de wrinkling
 */
function membraneEnergyAndGrad(elem, nodesRef, nodesCur, dofMap) {
  const [i, j, k] = elem.nodeIds;

  // Calcular gradiente de deformación
  const { F, Dm, DmInv, e1, e2, n, area } =
    computeDeformationGradient(elem, nodesRef, nodesCur);

  if (area < 1e-7) {
    return { energy: 0, grad: new Array(dofMap.nDof).fill(0), Ke: Array.from({ length: 9 }, () => new Array(9).fill(0)), nodeIds: [i, j, k], forces: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], stress: [0, 0, 0], strain: [0, 0, 0], area, wrinklingState: MEMBRANE_STATE.TAUT, principalStresses: [0, 0] };
  }

  // Deformación Green-Lagrange
  const E_tensor = greenLagrangeStrain(F);
  const E_voigt = toVoigt(E_tensor);

  // Matriz constitutiva
  const C = membraneConstitutive(elem.E, elem.nu);

  // Segundo tensor de Piola-Kirchhoff (en Voigt)
  // S = C : E + pretensión
  const prestress = elem.prestress || 0;
  let S_voigt = [
    C[0][0] * E_voigt[0] + C[0][1] * E_voigt[1] + C[0][2] * E_voigt[2] + prestress,
    C[1][0] * E_voigt[0] + C[1][1] * E_voigt[1] + C[1][2] * E_voigt[2] + prestress,
    C[2][0] * E_voigt[0] + C[2][1] * E_voigt[1] + C[2][2] * E_voigt[2]
  ];

  // Aplicar modelo de wrinkling
  const wrinklingEps = elem.wrinklingEps ?? 1e-4;
  const wrinkling = applyWrinklingModel(S_voigt, wrinklingEps);
  S_voigt = wrinkling.S_modified;
  const stiffnessFactor = wrinkling.stiffnessFactor;

  const strainEnergy = 0.5 * (
    E_voigt[0] * S_voigt[0] +
    E_voigt[1] * S_voigt[1] +
    E_voigt[2] * S_voigt[2] / 2  // Factor 1/2 porque S12 ya tiene 2*E12
  );
  const energy = strainEnergy * elem.thickness * area;

  // Primer tensor de Piola-Kirchhoff P = F * S
  const S_tensor = fromVoigt(S_voigt);
  const P_tensor = mm2(F, S_tensor);

  // Gradiente de funciones de forma en coordenadas de referencia
  // Para CST: ∂N/∂X = DmInv^T * [[-1,-1], [1,0], [0,1]]
  const dNdX = [
    mv2(transpose2(DmInv), [-1, -1]),
    mv2(transpose2(DmInv), [1, 0]),
    mv2(transpose2(DmInv), [0, 1])
  ];

  // Fuerzas internas en cada nodo (en coordenadas locales 2D)
  // f_a = -∫ P * ∂N_a/∂X dA = -P * ∂N_a/∂X * t * A
  const fLocal = [
    scale2(mv2(P_tensor, dNdX[0]), -elem.thickness * area),
    scale2(mv2(P_tensor, dNdX[1]), -elem.thickness * area),
    scale2(mv2(P_tensor, dNdX[2]), -elem.thickness * area)
  ];

  // Convertir fuerzas locales 2D a globales 3D
  const fGlobal = fLocal.map(fl => [
    fl[0] * e1[0] + fl[1] * e2[0],
    fl[0] * e1[1] + fl[1] * e2[1],
    fl[0] * e1[2] + fl[1] * e2[2]
  ]);

  const nodeIds = [i, j, k];
  /* targetGrad removed to avoid double counting - assembleSystem handles accumulation */

  // Matriz de rigidez del elemento (9x9)
  const Ke = computeCstStiffness(elem, S_tensor, dNdX, area, e1, e2, stiffnessFactor);

  return {
    energy,
    Ke,
    nodeIds,
    forces: fGlobal,
    stress: S_voigt,
    strain: E_voigt,
    area,
    wrinklingState: wrinkling.state,
    principalStresses: wrinkling.principalStresses
  };
}

/**
 * Calcula la matriz de rigidez tangente 9x9 para un elemento CST
 */
function computeCstStiffness(elem, S, dNdX, area, e1, e2, stiffnessFactor) {
  const Ke = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const t = elem.thickness;
  const vol = t * area;

  // 1. Rigidez Material (Km)
  const C = membraneConstitutive(elem.E * stiffnessFactor, elem.nu);

  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const kab = computeMaterialStiffnessBlock(a, b, dNdX, C, vol, e1, e2);
      const kgeo = computeGeometricStiffnessBlock(a, b, dNdX, S, vol, e1, e2);

      for (let ii = 0; ii < 3; ii++) {
        for (let jj = 0; jj < 3; jj++) {
          Ke[a * 3 + ii][b * 3 + jj] = kab[ii][jj] + kgeo[ii][jj];
        }
      }
    }
  }

  return Ke;
}

function computeMaterialStiffnessBlock(a, b, dNdX, C, vol, e1, e2) {
  const K = Array.from({ length: 3 }, () => new Array(3).fill(0));
  const dNa = dNdX[a];
  const dNb = dNdX[b];

  const k11 = (C[0][0] * dNa[0] * dNb[0] + C[2][2] * dNa[1] * dNb[1]) * vol;
  const k12 = (C[0][1] * dNa[0] * dNb[1] + C[2][2] * dNa[1] * dNb[0]) * vol;
  const k21 = (C[1][0] * dNa[1] * dNb[0] + C[2][2] * dNa[0] * dNb[1]) * vol;
  const k22 = (C[1][1] * dNa[1] * dNb[1] + C[2][2] * dNa[0] * dNb[0]) * vol;

  // Rotar k_loc (2x2) a 3D (3x3) usando base {e1, e2}
  const basis = [e1, e2];
  for (let ii = 0; ii < 3; ii++) {
    for (let jj = 0; jj < 3; jj++) {
      K[ii][jj] = k11 * basis[0][ii] * basis[0][jj] +
        k12 * basis[0][ii] * basis[1][jj] +
        k21 * basis[1][ii] * basis[0][jj] +
        k22 * basis[1][ii] * basis[1][jj];
    }
  }
  return K;
}

function computeGeometricStiffnessBlock(a, b, dNdX, S, vol, e1, e2) {
  const K = Array.from({ length: 3 }, () => new Array(3).fill(0));
  const dNa = dNdX[a];
  const dNb = dNdX[b];

  // Rigidez geométrica: k_geo = S_ij * ∂Na/∂Xi * ∂Nb/∂Xj * I_3x3
  const S11 = Math.max(0, S[0][0]); // Solo tensión positiva contribuye
  const S22 = Math.max(0, S[1][1]);
  const S12 = S[0][1];

  const s = (S11 * dNa[0] * dNb[0] + S22 * dNa[1] * dNb[1] + S12 * (dNa[0] * dNb[1] + dNa[1] * dNb[0])) * vol;

  for (let ii = 0; ii < 3; ii++) K[ii][ii] = s;
  return K;
}

/**
 * Escala vector 2D
 */
function scale2(v, s) {
  return [v[0] * s, v[1] * s];
}

// ═══════════════════════════════════════════════════════════════════════════
// PRESIÓN COMO FOLLOWER LOAD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Aplica presión a un elemento de membrana como "follower load"
 * La presión siempre actúa perpendicular a la superficie ACTUAL
 *
 * @param {Object} elem - Elemento de membrana
 * @param {Array} nodesCur - Posiciones actuales de los nodos
 * @param {number} pressure - Presión en Pa (positiva = hacia fuera)
 * @param {Object} dofMap - Mapa de grados de libertad
 * @param {number} sign - Signo de la presión (1 o -1)
 */
function membranePressureLoad(elem, nodesCur, pressure, dofMap, sign = 1) {
  if (Math.abs(pressure) < 1e-12) return { work: 0, grad: new Array(dofMap.nDof).fill(0) };

  const [i, j, k] = elem.nodeIds;
  const p0 = nodesCur[i];
  const p1 = nodesCur[j];
  const p2 = nodesCur[k];

  // Normal y área de la configuración ACTUAL
  const n = triangleNormal(p0, p1, p2);
  const area = triangleArea(p0, p1, p2);

  // Fuerza total sobre el elemento
  // F = p * A * n (distribuida uniformemente entre los 3 nodos)
  const pEff = pressure * sign;
  const fTotal = pEff * area;
  const fPerNode = fTotal / 3;

  const fx = fPerNode * n[0];
  const fy = fPerNode * n[1];
  const fz = fPerNode * n[2];

  // Trabajo externo aproximado
  const centroid = [
    (p0[0] + p1[0] + p2[0]) / 3,
    (p0[1] + p1[1] + p2[1]) / 3,
    (p0[2] + p1[2] + p2[2]) / 3
  ];
  const work = (1 / 3) * fTotal * (n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2]);

  // Rigidez de la carga seguidora (Follower Load Stiffness)
  const Kp = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const p6 = pEff / 6;
  const s0 = skew3(sub3(p1, p2));
  const s1 = skew3(sub3(p2, p0));
  const s2 = skew3(sub3(p0, p1));

  const blocks = [
    [skew3([0, 0, 0]), s2, s1],
    [s2, skew3([0, 0, 0]), s0],
    [s1, s0, skew3([0, 0, 0])]
  ];

  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const block = blocks[a][b];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          Kp[a * 3 + row][b * 3 + col] = p6 * block[row][col];
        }
      }
    }
  }

  // Gradiente (fuerzas externas = -gradiente de energía potencial)
  const nDof = dofMap.nDof;
  const grad = new Array(nDof).fill(0);

  const nodeIds = [i, j, k];
  for (let a = 0; a < 3; a++) {
    const base = dofMap.map.get(nodeIds[a]);
    if (base === undefined) continue;
    grad[base] -= fx;
    grad[base + 1] -= fy;
    grad[base + 2] -= fz;
  }

  return { work, grad, Kp, nodeIds, force: [fx, fy, fz], normal: n, area };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTRUCCIÓN DE MALLA DE MEMBRANA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea una malla de membrana a partir de un grid de nodos
 * Divide cada cuadrilátero en 2 triángulos
 *
 * @param {Array} grid - Grid de IDs de nodos [filas][columnas]
 * @param {Object} material - Propiedades del material
 */
function createMembraneMesh(grid, material) {
  const elements = [];
  const nRows = grid.length - 1;

  for (let i = 0; i < nRows; i++) {
    const nCols = Math.min(grid[i].length, grid[i + 1].length) - 1;

    for (let j = 0; j < nCols; j++) {
      // Nodos del cuadrilátero
      const a = grid[i][j];       // abajo-izq
      const b = grid[i + 1][j];   // arriba-izq
      const c = grid[i + 1][j + 1]; // arriba-der
      const d = grid[i][j + 1];   // abajo-der

      // Dividir en 2 triángulos (diagonal a-c)
      elements.push(createMembraneElement([a, b, c], material));
      elements.push(createMembraneElement([a, c, d], material));
    }
  }

  return elements;
}

/**
 * Calcula la energía total y gradiente de todos los elementos de membrana
 */
function totalMembraneEnergyAndGrad(elements, nodesRef, nodesCur, dofMap) {
  let totalEnergy = 0;
  const nDof = dofMap.nDof;
  const totalGrad = new Array(nDof).fill(0);
  const stressData = [];

  // DEBUG: log first call
  const isFirstCall = !totalMembraneEnergyAndGrad.called;
  totalMembraneEnergyAndGrad.called = true;
  if (isFirstCall) {
    console.log(`totalMembraneEnergyAndGrad: first call, elements=${elements.length}, nDof=${nDof}`);
  }


  // Métricas para monitoreo de convergencia
  let maxStress = 0;
  let minStress = Infinity;
  let tautCount = 0;
  let wrinkledCount = 0;
  let slackCount = 0;

  /* skip targetGrad setting */

  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i];
    const res = membraneEnergyAndGrad(elem, nodesRef, nodesCur, dofMap);
    totalEnergy += res.energy;

    if (isFirstCall && i < 2) {
      console.log(`  Elem ${i}: area=${res.area.toFixed(6)}, forcesMax=${normInf(res.forces.flat()).toFixed(6)}`);
    }

    // Debug: catch explosive forces (después de acumular, para ver magnitud real)
    const gn = normInf(res.forces.flat());
    if (gn > 1e12 || !Number.isFinite(gn)) {
      const info = computeDeformationGradient(elem, nodesRef, nodesCur);
      const fs = require('fs');
      const dump = {
        index: i,
        nodeIds: elem.nodeIds,
        nodesRef: elem.nodeIds.map(id => nodesRef[id]),
        nodesCur: elem.nodeIds.map(id => nodesCur[id]),
        forces: res.forces,
        forcesMax: gn,
        area: res.area,
        Dm: info.Dm,
        Ds: info.Ds,
        DmInv: info.DmInv,
        F: info.F,
        elem: { E: elem.E, nu: elem.nu, thickness: elem.thickness, prestress: elem.prestress }
      };
      fs.writeFileSync('debug_explosion.json', JSON.stringify(dump, null, 2));
      console.error(`FATAL: EXPLOSIVE MEMBRANE ELEMENT detected! Index: ${i}. More info in debug_explosion.json`);
      throw new Error(`Numerical explosion in membrane element ${i} (nodes ${elem.nodeIds})`);
    }

    stressData.push({
      Ke: res.Ke,
      nodeIds: res.nodeIds,
      forces: res.forces
    });

    // Acumular en gradiente global
    for (let a = 0; a < 3; a++) {
      const base = dofMap.map.get(res.nodeIds[a]);
      if (base === undefined) continue;
      totalGrad[base] += res.forces[a][0];
      totalGrad[base + 1] += res.forces[a][1];
      totalGrad[base + 2] += res.forces[a][2];
    }

    // Actualizar métricas
    const [s1, s2] = res.principalStresses;
    maxStress = Math.max(maxStress, s1);
    minStress = Math.min(minStress, s2 === -Infinity ? s1 : Math.min(minStress, s2));

    if (res.wrinklingState === MEMBRANE_STATE.TAUT) tautCount++;
    else if (res.wrinklingState === MEMBRANE_STATE.WRINKLED) wrinkledCount++;
    else slackCount++;
  }

  if (dofMap && dofMap.targetGrad) dofMap.targetGrad = undefined;
  console.log("DEBUG: totalMembraneEnergyAndGrad finishing. Keys:", Object.keys(dofMap));

  return {
    energy: totalEnergy,
    grad: totalGrad,
    stressData,
    metrics: {
      maxPrincipalStress: maxStress,
      minPrincipalStress: minStress === Infinity ? 0 : minStress,
      tautCount,
      wrinkledCount,
      slackCount,
      elementCount: elements.length
    }
  };
}

/**
 * Calcula la presión total sobre todos los elementos de membrana
 */
function totalMembranePressure(elements, nodesCur, pressure, dofMap, sign = 1) {
  let totalWork = 0;
  const nDof = dofMap.nDof;
  const totalGrad = new Array(nDof).fill(0);
  const pressStiffnessData = [];
  const nodalForces = new Array(nodesCur.length);
  for (let i = 0; i < nodalForces.length; i++) nodalForces[i] = [0, 0, 0];

  for (const elem of elements) {
    const result = membranePressureLoad(elem, nodesCur, pressure, dofMap, sign);
    totalWork += result.work;
    for (let i = 0; i < nDof; i++) {
      totalGrad[i] += result.grad[i];
    }
    if (result.Kp) {
      pressStiffnessData.push({ Kp: result.Kp, nodeIds: result.nodeIds });
    }
    if (result.force && result.nodeIds) {
      const f = result.force;
      for (const nodeId of result.nodeIds) {
        if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= nodalForces.length) continue;
        nodalForces[nodeId][0] += f[0] || 0;
        nodalForces[nodeId][1] += f[1] || 0;
        nodalForces[nodeId][2] += f[2] || 0;
      }
    }
  }

  return { work: totalWork, grad: totalGrad, pressStiffnessData, nodalForces };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Elementos
  createMembraneElement,
  createMembraneMesh,

  // Energía y gradiente
  membraneEnergyAndGrad,
  totalMembraneEnergyAndGrad,

  // Presión
  membranePressureLoad,
  totalMembranePressure,

  // Utilidades
  triangleNormal,
  triangleArea,
  computeDeformationGradient,
  greenLagrangeStrain,

  // Estados de membrana
  MEMBRANE_STATE,
  applyWrinklingModel
};
