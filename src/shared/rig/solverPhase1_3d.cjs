const { clamp, sub3, norm3, normalize3, outer3, scale3, add3, dot3 } = require("./math3.cjs");
const { zeros, dot, normInf, add, solveLinearSystem } = require("./linsolve.cjs");
const { totalMembraneEnergyAndGrad, totalMembranePressure } = require("./sailMembrane3d.cjs");
const { solveDynamicRelaxationAdaptive } = require("./dynamicRelaxation.cjs");

/**
 * SOLVER 3D - Phase 1 con 3 DOF por nodo (x, y, z)
 *
 * CORRECCIONES FÍSICAS:
 *
 * 1. Flexión del mástil (curvatura discreta):
 *    - Usa el stencil [1, -2, 1] en X-Y (modelo reducido)
 *    - El DOF Z captura compresión axial, no curvatura
 *
 * 2. Efecto P-Delta Real:
 *    - La compresión axial del mástil reduce la rigidez a flexión
 *    - Incluido automáticamente con 3 DOF
 *
 * 3. Regularización de Cables Mejorada:
 *    - epsComp más bajo (1e-8) para cables realmente flojos
 *    - Banda de transición más estrecha
 */

function buildDofMap3d(nodes) {
  const map = new Map();
  let nDof = 0;
  for (const node of nodes) {
    if (node.fixed) continue;
    map.set(node.id, nDof);
    nDof += 3; // 3 DOF por nodo: x, y, z
  }
  return { map, nDof };
}

function getU3(nodeId, dofMap, x) {
  const base = dofMap.map.get(nodeId);
  if (base === undefined) return [0, 0, 0];
  return [x[base], x[base + 1], x[base + 2]];
}

function addGrad3(nodeId, dofMap, grad, v3) {
  const base = dofMap.map.get(nodeId);
  if (base === undefined) return;
  grad[base] += v3[0];
  grad[base + 1] += v3[1];
  grad[base + 2] += v3[2];
}

function addKBlock3(nodeA, nodeB, dofMap, K, block3x3, scale = 1) {
  if (!K) return;
  const a = dofMap.map.get(nodeA);
  const b = dofMap.map.get(nodeB);
  if (a === undefined || b === undefined) return;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      K[a + i][b + j] += scale * block3x3[i][j];
    }
  }
}

function addDiagonal(K, lambda) {
  for (let i = 0; i < K.length; i++) K[i][i] += lambda;
  return K;
}

function cloneMatrix(A) {
  return A.map((r) => r.slice());
}

/**
 * Respuesta suave de cable con regularización mejorada
 * epsComp más bajo para cables realmente flojos
 */
function cableResponse({ dL, k0, epsComp, delta }) {
  const r = Math.sqrt(dL * dL + delta * delta);
  const s = 0.5 * (1 + dL / r);

  const kEff = k0 * (epsComp + (1 - epsComp) * s);
  const N = kEff * dL;

  const ds = 0.5 * (delta * delta) / (r * r * r);
  const dkEff = k0 * (1 - epsComp) * ds;
  const kTangent = kEff + dL * dkEff;

  const asinh = Math.asinh(dL / delta);
  const energy =
    0.25 * k0 * (1 + epsComp) * dL * dL +
    0.25 * k0 * (1 - epsComp) * (dL * r - delta * delta * asinh);

  return { N, kTangent, energy };
}

/**
 * Energía y gradiente de flexión con curvatura discreta
 *
 * Usa el stencil [1, -2, 1] para aproximar la curvatura.
 * Funciona solo en el plano X-Y (curvatura lateral del mástil).
 * El DOF Z permite la compresión axial pero no afecta la flexión directamente.
 */
function bendEnergyAndGrad3d({ nodesPos, model, dofMap, reactions }) {
  let E = 0;
  const n = dofMap.nDof;
  const grad = zeros(n);

  const mastNodeIds = model.mastNodeIds;
  const beam = model.beam;
  if (!mastNodeIds || mastNodeIds.length < 3 || !beam) return { E, grad };

  const ds = beam.ds;
  const getEIAtZ = beam.getEIAtZ;
  const c = [1, -2, 1];

  for (let i = 1; i < mastNodeIds.length - 1; i++) {
    const aId = mastNodeIds[i - 1];
    const bId = mastNodeIds[i];
    const cId = mastNodeIds[i + 1];

    // EI local (variable con altura)
    const zCurr = model.nodes[bId].p0[2];
    const EI = getEIAtZ ? getEIAtZ(zCurr) : (beam.EI || 7500);
    const kB = EI / Math.pow(ds, 3);

    // Posiciones actuales
    const pa = nodesPos[aId];
    const pb = nodesPos[bId];
    const pc = nodesPos[cId];

    // Curvatura discreta en X-Y (plano de flexion lateral)
    const curX = pa[0] * c[0] + pb[0] * c[1] + pc[0] * c[2];
    const curY = pa[1] * c[0] + pb[1] * c[1] + pc[1] * c[2];

    // Energia de flexion
    E += 0.5 * kB * (curX * curX + curY * curY);

    // Gradiente (y reacciones si el nodo es fijo)
    const ga = [kB * curX * c[0], kB * curY * c[0], 0];
    const gb = [kB * curX * c[1], kB * curY * c[1], 0];
    const gc = [kB * curX * c[2], kB * curY * c[2], 0];

    addGrad3(aId, dofMap, grad, ga);
    addGrad3(bId, dofMap, grad, gb);
    addGrad3(cId, dofMap, grad, gc);

    if (reactions) {
      const nodeA = model.nodes[aId];
      const nodeB = model.nodes[bId];
      const nodeC = model.nodes[cId];
      if (nodeA?.fixed && reactions[nodeA.name]) {
        reactions[nodeA.name][0] += ga[0];
        reactions[nodeA.name][1] += ga[1];
        reactions[nodeA.name][2] += ga[2];
      }
      if (nodeB?.fixed && reactions[nodeB.name]) {
        reactions[nodeB.name][0] += gb[0];
        reactions[nodeB.name][1] += gb[1];
        reactions[nodeB.name][2] += gb[2];
      }
      if (nodeC?.fixed && reactions[nodeC.name]) {
        reactions[nodeC.name][0] += gc[0];
        reactions[nodeC.name][1] += gc[1];
        reactions[nodeC.name][2] += gc[2];
      }
    }
  }

  return { E, grad };
}

function assembleSystem({ model, dofMap, x, cableCompressionEps = 1e-6, skipK = false }) {
  const n = dofMap.nDof;
  const grad = zeros(n);
  const K = skipK ? null : zeros(n).map(() => zeros(n));

  let energyInternal = 0;
  let workExternal = 0;

  // Posiciones actuales de todos los nodos
  const nodesPos = new Array(model.nodes.length);
  for (const node of model.nodes) {
    const [ux, uy, uz] = getU3(node.id, dofMap, x);
    nodesPos[node.id] = [node.p0[0] + ux, node.p0[1] + uy, node.p0[2] + uz];
  }

  // ═══════════════════════════════════════════════════════════════════
  // ENERGIA DE FLEXION (Curvatura discreta)
  // ═══════════════════════════════════════════════════════════════════
  const reactions = {};
  for (const node of model.nodes) {
    if (node.fixed) reactions[node.name] = [0, 0, 0];
  }

  const bendResult = bendEnergyAndGrad3d({ nodesPos, model, dofMap, reactions });
  energyInternal += bendResult.E;
  for (let i = 0; i < n; i++) grad[i] += bendResult.grad[i];

  // Hessiana aproximada de flexion (usando diferencias finitas implicitas via rigidez geometrica)
  // Para mayor eficiencia, usamos una aproximacion basada en curvatura discreta
  const ds = model.beam?.ds || 0.1;
  const mastNodeIds = model.mastNodeIds || [];
  const getEIAtZ = model.beam?.getEIAtZ;

  if (!skipK) {
    for (let i = 1; i < mastNodeIds.length - 1; i++) {
      const aId = mastNodeIds[i - 1];
      const bId = mastNodeIds[i];
      const cId = mastNodeIds[i + 1];

      const zCurr = model.nodes[bId].p0[2];
      const EI = getEIAtZ ? getEIAtZ(zCurr) : (model.beam?.EI || 7500);
      const kB = EI / Math.pow(ds, 3);

      const c = [1, -2, 1];
      const ids = [aId, bId, cId];

      for (let ii = 0; ii < 3; ii++) {
        for (let jj = 0; jj < 3; jj++) {
          const block = [
            [kB * c[ii] * c[jj], 0, 0],
            [0, kB * c[ii] * c[jj], 0],
            [0, 0, 0]
          ];
          addKBlock3(ids[ii], ids[jj], dofMap, K, block, 1);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESORTES (3D)
  // ═══════════════════════════════════════════════════════════════════
  for (const s of model.springs) {
    if (s.nodeIdA !== undefined && s.nodeIdB !== undefined) {
      // Resorte relativo entre dos nodos
      const aId = s.nodeIdA;
      const bId = s.nodeIdB;
      const [ax, ay, az] = getU3(aId, dofMap, x);
      const [bx, by, bz] = getU3(bId, dofMap, x);
      const dx = ax - bx;
      const dy = ay - by;
      const dz = az - bz;
      const kx = s.kx || 0;
      const ky = s.ky || 0;
      const kz = s.kz || 0;

      energyInternal += 0.5 * (kx * dx * dx + ky * dy * dy + kz * dz * dz);
      addGrad3(aId, dofMap, grad, [kx * dx, ky * dy, kz * dz]);
      addGrad3(bId, dofMap, grad, [-kx * dx, -ky * dy, -kz * dz]);

      if (!skipK) {
        const Kaa = [[kx, 0, 0], [0, ky, 0], [0, 0, kz]];
        const Kab = [[-kx, 0, 0], [0, -ky, 0], [0, 0, -kz]];
        addKBlock3(aId, aId, dofMap, K, Kaa, +1);
        addKBlock3(aId, bId, dofMap, K, Kab, +1);
        addKBlock3(bId, aId, dofMap, K, Kab, +1);
        addKBlock3(bId, bId, dofMap, K, Kaa, +1);
      }
      continue;
    }

    // Resorte a tierra
    const base = dofMap.map.get(s.nodeId);
    if (base === undefined) continue;
    const ux = x[base];
    const uy = x[base + 1];
    const uz = x[base + 2];
    const kx = s.kx || 0;
    const ky = s.ky || 0;
    const kz = s.kz || 0;

    energyInternal += 0.5 * (kx * ux * ux + ky * uy * uy + kz * uz * uz);
    grad[base] += kx * ux;
    grad[base + 1] += ky * uy;
    grad[base + 2] += kz * uz;
    if (!skipK) {
      K[base][base] += kx;
      K[base + 1][base + 1] += ky;
      K[base + 2][base + 2] += kz;
    }
  }

  const axialForces = {};
  const slackCables = [];

  // ═══════════════════════════════════════════════════════════════════
  // ELEMENTOS AXIALES (Barras y Cables) - 3D completo
  // ═══════════════════════════════════════════════════════════════════
  // epsComp controla la rigidez residual de cables flojos
  // Valor muy bajo puede causar inestabilidad numerica
  const epsCompDefault = cableCompressionEps ?? 1e-6;

  for (const e of model.axial) {
    if (e.kind === "tension") {
      const pi = nodesPos[e.i];
      const pj = nodesPos[e.j];
      const d = sub3(pj, pi);
      const { v: n3, n: L } = normalize3(d);
      if (!(L > 1e-12)) continue;

      const N = Math.max(0, Number.isFinite(e.N) ? e.N : 0);
      // Potencial equivalente a aplicar una fuerza axial constante entre nodos: V = N * L
      energyInternal += N * L;

      // Gradiente (∂V/∂x): fi = -N*n , fj = +N*n
      const fi = scale3(n3, -N);
      const fj = scale3(n3, N);
      addGrad3(e.i, dofMap, grad, fi);
      addGrad3(e.j, dofMap, grad, fj);

      axialForces[e.name] = N;

      // Reacciones en nodos fijos
      const nodeI = model.nodes[e.i];
      const nodeJ = model.nodes[e.j];
      if (nodeI.fixed && reactions[nodeI.name]) {
        reactions[nodeI.name] = add3(reactions[nodeI.name], fi);
      }
      if (nodeJ.fixed && reactions[nodeJ.name]) {
        reactions[nodeJ.name] = add3(reactions[nodeJ.name], fj);
      }

      if (!skipK) {
        const nn = outer3(n3, n3);
        const geo = N / L;
        const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const K3 = I3.map((row, ii) =>
          row.map((v, jj) => geo * (v - nn[ii][jj]))
        );

        const iFree = dofMap.map.has(e.i);
        const jFree = dofMap.map.has(e.j);

        if (iFree && jFree) {
          addKBlock3(e.i, e.i, dofMap, K, K3, +1);
          addKBlock3(e.i, e.j, dofMap, K, K3, -1);
          addKBlock3(e.j, e.i, dofMap, K, K3, -1);
          addKBlock3(e.j, e.j, dofMap, K, K3, +1);
        } else if (iFree && !jFree) {
          addKBlock3(e.i, e.i, dofMap, K, K3, +1);
        } else if (!iFree && jFree) {
          addKBlock3(e.j, e.j, dofMap, K, K3, +1);
        }
      }

      continue;
    }
    if (e.kind === "cable_path") {
      // Cable continuo pasando por un punto intermedio (shrouds)
      const pi = nodesPos[e.i];
      const pk = nodesPos[e.k];
      const pj = nodesPos[e.j];

      const { v: n1, n: L1 } = normalize3(sub3(pk, pi));
      const { v: n2, n: L2 } = normalize3(sub3(pj, pk));

      if (!(L1 > 1e-12) || !(L2 > 1e-12) || !(e.L0 > 1e-12)) continue;

      const L = L1 + L2;
      const dL = L - e.L0;
      const isSlack = dL < 0;

      const k0 = e.EA / e.L0;
      const epsInput = Number.isFinite(e.compressionEps) ? e.compressionEps : cableCompressionEps;
      const epsComp = Number.isFinite(epsInput) ? clamp(epsInput, 0, 1) : epsCompDefault;

      const delta = Number.isFinite(e.smoothDeltaM)
        ? Math.max(1e-9, e.smoothDeltaM)
        : Math.max(1e-4, e.L0 * 1e-4); // Banda de transicion suave

      const { N, kTangent, energy } = cableResponse({ dL, k0, epsComp, delta });
      energyInternal += energy;

      // Gradiente (3D completo)
      addGrad3(e.i, dofMap, grad, scale3(n1, -N));
      addGrad3(e.k, dofMap, grad, scale3(sub3(n1, n2), N));
      addGrad3(e.j, dofMap, grad, scale3(n2, N));

      axialForces[e.name] = N;
      if (isSlack) slackCables.push(e.name);

      // Reacciones en nodos fijos
      const nodeI = model.nodes[e.i];
      const nodeK = model.nodes[e.k];
      const nodeJ = model.nodes[e.j];
      if (nodeI.fixed && reactions[nodeI.name]) {
        reactions[nodeI.name] = add3(reactions[nodeI.name], scale3(n1, -N));
      }
      if (nodeK.fixed && reactions[nodeK.name]) {
        reactions[nodeK.name] = add3(reactions[nodeK.name], scale3(sub3(n1, n2), N));
      }
      if (nodeJ.fixed && reactions[nodeJ.name]) {
        reactions[nodeJ.name] = add3(reactions[nodeJ.name], scale3(n2, N));
      }

      if (!skipK) {
        const ids = [e.i, e.k, e.j];
        const Ds = [scale3(n1, -1), sub3(n1, n2), n2];
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            const blockCorrect = [
              [kTangent * Ds[a][0] * Ds[b][0], kTangent * Ds[a][0] * Ds[b][1], kTangent * Ds[a][0] * Ds[b][2]],
              [kTangent * Ds[a][1] * Ds[b][0], kTangent * Ds[a][1] * Ds[b][1], kTangent * Ds[a][1] * Ds[b][2]],
              [kTangent * Ds[a][2] * Ds[b][0], kTangent * Ds[a][2] * Ds[b][1], kTangent * Ds[a][2] * Ds[b][2]]
            ];
            addKBlock3(ids[a], ids[b], dofMap, K, blockCorrect, +1);
          }
        }
        const geo1 = (!isSlack && L1 > 1e-12) ? N / L1 : 0;
        const geo2 = (!isSlack && L2 > 1e-12) ? N / L2 : 0;
        const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        if (geo1 !== 0) {
          const nn1 = outer3(n1, n1);
          const P1 = I3.map((row, ii) => row.map((v, jj) => geo1 * (v - nn1[ii][jj])));
          addKBlock3(e.i, e.i, dofMap, K, P1, +1);
          addKBlock3(e.i, e.k, dofMap, K, P1, -1);
          addKBlock3(e.k, e.i, dofMap, K, P1, -1);
          addKBlock3(e.k, e.k, dofMap, K, P1, +1);
        }
        if (geo2 !== 0) {
          const nn2 = outer3(n2, n2);
          const P2 = I3.map((row, ii) => row.map((v, jj) => geo2 * (v - nn2[ii][jj])));
          addKBlock3(e.k, e.k, dofMap, K, P2, +1);
          addKBlock3(e.k, e.j, dofMap, K, P2, -1);
          addKBlock3(e.j, e.k, dofMap, K, P2, -1);
          addKBlock3(e.j, e.j, dofMap, K, P2, +1);
        }
      }

      continue;
    }

    // Barras simples y cables simples
    const pi = nodesPos[e.i];
    const pj = nodesPos[e.j];
    const d = sub3(pj, pi);
    const { v: n3, n: L } = normalize3(d);
    const dL = L - e.L0;

    const isCable = e.kind === "cable";
    const isSlack = isCable && dL < 0;

    const k0 = e.EA / e.L0;
    const epsInput = Number.isFinite(e.compressionEps) ? e.compressionEps : cableCompressionEps;
    const epsComp = isCable && Number.isFinite(epsInput) ? clamp(epsInput, 0, 1) : 0;

    let N = 0;
    let kTangent = k0;

    if (!isCable) {
      N = k0 * dL;
      energyInternal += 0.5 * k0 * dL * dL;
    } else {
      const delta = Number.isFinite(e.smoothDeltaM)
        ? Math.max(1e-9, e.smoothDeltaM)
        : Math.max(1e-4, e.L0 * 1e-4); // Banda de transicion suave
      const r = Math.sqrt(dL * dL + delta * delta);
      const s = 0.5 * (1 + dL / r);

      const kEff = k0 * (epsComp + (1 - epsComp) * s);
      N = kEff * dL;

      const ds = 0.5 * (delta * delta) / (r * r * r);
      const dkEff = k0 * (1 - epsComp) * ds;
      kTangent = kEff + dL * dkEff;

      const asinh = Math.asinh(dL / delta);
      energyInternal +=
        0.25 * k0 * (1 + epsComp) * dL * dL +
        0.25 * k0 * (1 - epsComp) * (dL * r - delta * delta * asinh);
    }

    // Gradiente 3D
    const fi = scale3(n3, -N);
    const fj = scale3(n3, N);
    addGrad3(e.i, dofMap, grad, fi);
    addGrad3(e.j, dofMap, grad, fj);

    axialForces[e.name] = N;
    if (isSlack) slackCables.push(e.name);

    // Reacciones en nodos fijos
    const nodeI = model.nodes[e.i];
    const nodeJ = model.nodes[e.j];
    if (nodeI.fixed && reactions[nodeI.name]) {
      reactions[nodeI.name] = add3(reactions[nodeI.name], fi);
    }
    if (nodeJ.fixed && reactions[nodeJ.name]) {
      reactions[nodeJ.name] = add3(reactions[nodeJ.name], fj);
    }

    if (!skipK) {
      const nn = outer3(n3, n3);
      const geo = (!isSlack && L > 1e-12) ? N / L : 0;
      const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const K3 = I3.map((row, ii) =>
        row.map((v, jj) => kTangent * nn[ii][jj] + geo * (v - nn[ii][jj]))
      );
      const iFree = dofMap.map.has(e.i);
      const jFree = dofMap.map.has(e.j);
      if (iFree && jFree) {
        addKBlock3(e.i, e.i, dofMap, K, K3, +1);
        addKBlock3(e.i, e.j, dofMap, K, K3, -1);
        addKBlock3(e.j, e.i, dofMap, K, K3, -1);
        addKBlock3(e.j, e.j, dofMap, K, K3, +1);
      } else if (iFree && !jFree) {
        addKBlock3(e.i, e.i, dofMap, K, K3, +1);
      } else if (!iFree && jFree) {
        addKBlock3(e.j, e.j, dofMap, K, K3, +1);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ELEMENTOS DE MEMBRANA (Velas)
  // ═══════════════════════════════════════════════════════════════════
  let membranePressureForces = null;
  if (model.membranes && model.membranes.length > 0) {
    // Posiciones de referencia (p0) y actuales
    const nodesRef = model.nodes.map(node => node.p0);

    // Energía y gradiente de deformación de membrana
    const memResult = totalMembraneEnergyAndGrad(
      model.membranes,
      nodesRef,
      nodesPos,
      dofMap
    );
    energyInternal += memResult.energy;
    for (let i = 0; i < n; i++) {
      grad[i] += memResult.grad[i];
    }

    if (!skipK) {
      for (const d of memResult.stressData) {
        const ids = d.nodeIds;
        if (!d.Ke || !ids) continue;
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            const rowBase = dofMap.map.get(ids[a]);
            const colBase = dofMap.map.get(ids[b]);
            if (rowBase === undefined || colBase === undefined) continue;
            for (let i = 0; i < 3; i++) {
              for (let j = 0; j < 3; j++) {
                K[rowBase + i][colBase + j] += d.Ke[a * 3 + i][b * 3 + j];
              }
            }
          }
        }
      }
    }

    // Presión sobre membranas (follower load)
    if (model.membranePressure && Math.abs(model.membranePressure.value) > 1e-12) {
      const pressResult = totalMembranePressure(
        model.membranes,
        nodesPos,
        model.membranePressure.value,
        dofMap,
        model.membranePressure.sign ?? 1
      );
      workExternal += pressResult.work;
      for (let i = 0; i < n; i++) {
        grad[i] += pressResult.grad[i];
      }
      membranePressureForces = pressResult.nodalForces ?? null;

      if (!skipK) {
        for (const d of pressResult.pressStiffnessData || []) {
          const ids = d.nodeIds;
          if (!d.Kp || !ids) continue;
          for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
              const rowBase = dofMap.map.get(ids[a]);
              const colBase = dofMap.map.get(ids[b]);
              if (rowBase === undefined || colBase === undefined) continue;
              for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                  K[rowBase + i][colBase + j] += d.Kp[a * 3 + i][b * 3 + j];
                }
              }
            }
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // FUERZAS EXTERNAS (3D)
  // ═══════════════════════════════════════════════════════════════════
  for (const node of model.nodes) {
    const base = dofMap.map.get(node.id);
    if (base === undefined) continue;
    const f = model.forces[node.id] ?? [0, 0, 0];
    workExternal += f[0] * x[base] + f[1] * x[base + 1] + f[2] * x[base + 2];
    grad[base] -= f[0];
    grad[base + 1] -= f[1];
    grad[base + 2] -= f[2];
  }

  // Fuerzas de springs (para reporte)
  const springsForces = {};
  for (const s of model.springs) {
    if (s.nodeIdA !== undefined && s.nodeIdB !== undefined) continue;
    const base = dofMap.map.get(s.nodeId);
    if (base === undefined) continue;
    const ux = x[base];
    const uy = x[base + 1];
    const uz = x[base + 2];
    springsForces[s.name] = {
      fx: (s.kx || 0) * ux,
      fy: (s.ky || 0) * uy,
      fz: (s.kz || 0) * uz
    };
  }

  const energy = energyInternal - workExternal;

  return {
    energy,
    grad,
    K,
    meta: { axialForces, slackCables, nodesPos, reactions, springsForces, membranePressureForces }
  };
}

function solveEquilibrium3d({ model, solver, x0 }) {
  const dofMap = buildDofMap3d(model.nodes);
  let x = x0?.slice() ?? zeros(dofMap.nDof);
  if (x.length !== dofMap.nDof) x = zeros(dofMap.nDof);

  const tol = solver.toleranceN;
  const maxIt = solver.maxIterations || 300;
  const eps = solver.cableCompressionEps ?? 1e-6;

  // Detectar si hay membranas y usar Dynamic Relaxation
  const hasMembranes = model.membranes && model.membranes.length > 0;
  const useDR = solver.useDynamicRelaxation ?? hasMembranes;

  console.log("DEBUG Solver selection:", { hasMembranes, useDR, membranes: model.membranes?.length });


  if (useDR && hasMembranes) {
    // DYNAMIC RELAXATION - O(n) por iteración, ideal para membranas
    const computeForces = (xCurrent) => {
      const assembled = assembleSystem({ model, dofMap, x: xCurrent, cableCompressionEps: eps, skipK: true });
      return { grad: assembled.grad, energy: assembled.energy, meta: assembled.meta };
    };

    const drResult = solveDynamicRelaxationAdaptive(computeForces, x, {
      maxIter: maxIt * 20,
      tol: tol,
      dt: 0.0005
    });

    // Ensamblar una última vez con K para metadata/reacciones si es necesario
    const finalAssembled = assembleSystem({ model, dofMap, x: drResult.x, cableCompressionEps: eps });

    return {
      x: drResult.x,
      converged: drResult.converged,
      iterations: drResult.iterations,
      energy: drResult.energy,
      gradInf: drResult.gradInf,
      meta: finalAssembled.meta,
      model,
      convergenceHistory: drResult.history,
      solver: "dynamic_relaxation",
      reason: drResult.reason
    };
  }

  // NEWTON-RAPHSON tradicional para sistemas sin membranas o si se fuerza
  const sailDampingInit = Number.isFinite(solver.sailDamping) ? solver.sailDamping : 10.0;
  const sailDampingDecay = Number.isFinite(solver.sailDampingDecay)
    ? clamp(solver.sailDampingDecay, 0.5, 0.99)
    : 0.98;
  const sailDampingMin = Number.isFinite(solver.sailDampingMin)
    ? Math.max(0, solver.sailDampingMin)
    : 0.01;

  // Mayor damping inicial para sistema 3D (más DOFs, y evitar oscilaciones por rigidez alta)
  let sailDampingFloor = hasMembranes ? Math.max(sailDampingMin, sailDampingInit) : sailDampingMin;
  let damping = hasMembranes ? Math.max(10.0, sailDampingInit) : 1.0;
  damping = Math.max(sailDampingFloor, damping);

  // Límite de paso (trust region) opcional, basado en el tamaño de la malla de membrana.
  // Por defecto se deja sin límite para mantener el comportamiento histórico.
  let stepCap = Infinity;
  const hasStepCapFrac = Number.isFinite(solver.sailStepCapFrac);
  const hasMaxStep = Number.isFinite(solver.sailMaxStepM);
  if ((hasStepCapFrac || hasMaxStep) && model.membranes && model.membranes.length > 0) {
    let minEdge = Infinity;
    const nodesRef = model.nodes.map((node) => node.p0);
    for (const elem of model.membranes) {
      const ids = elem?.nodeIds;
      if (!ids || ids.length !== 3) continue;
      const p0 = nodesRef[ids[0]];
      const p1 = nodesRef[ids[1]];
      const p2 = nodesRef[ids[2]];
      if (!p0 || !p1 || !p2) continue;
      minEdge = Math.min(
        minEdge,
        norm3(sub3(p1, p0)),
        norm3(sub3(p2, p1)),
        norm3(sub3(p0, p2))
      );
    }
    if (Number.isFinite(minEdge) && minEdge > 1e-9 && minEdge < Infinity) {
      if (hasStepCapFrac) {
        const frac = clamp(solver.sailStepCapFrac, 0.05, 2.0);
        stepCap = Math.max(1e-4, frac * minEdge);
      }
    }
  }
  if (hasMaxStep) {
    stepCap = Math.min(stepCap, Math.max(1e-4, solver.sailMaxStepM));
  }
  let bestX = x.slice();
  let minGrad = Infinity;

  const convergenceHistory = [];

  let assembled = assembleSystem({ model, dofMap, x, cableCompressionEps: eps });

  for (let iter = 0; iter < maxIt; iter++) {
    const gInf = normInf(assembled.grad);

    convergenceHistory.push({
      iter,
      residual: gInf,
      energy: assembled.energy,
      damping,
      dampingFloor: sailDampingFloor,
      maxDof: normInf(x)
    });

    if (gInf < minGrad) {
      minGrad = gInf;
      bestX = x.slice();
    }

    if (gInf < tol) {
      return {
        x,
        converged: true,
        iterations: iter,
        energy: assembled.energy,
        gradInf: gInf,
        meta: assembled.meta,
        convergenceHistory
      };
    }

    let dx = null;
    let success = false;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const A = addDiagonal(cloneMatrix(assembled.K), damping);
        const rhs = assembled.grad.map((v) => -v);
        dx = solveLinearSystem(A, rhs);
        success = true;
        break;
      } catch (err) {
        damping *= 10;
        if (damping > 1e8) break;
      }
    }

    if (!success) break;

    // Trust region / paso máximo
    if (Number.isFinite(stepCap) && stepCap < Infinity) {
      const maxDx = normInf(dx);
      if (maxDx > stepCap && maxDx > 0) {
        const s = stepCap / maxDx;
        dx = dx.map((v) => v * s);
      }
    }

    // Line search
    let alpha = 1.0;
    let accepted = false;
    for (let ls = 0; ls < 10; ls++) {
      const xTry = add(x, dx, alpha);
      const next = assembleSystem({ model, dofMap, x: xTry, cableCompressionEps: eps });

      if (next.energy < assembled.energy + 1e-6) {
        x = xTry;
        assembled = next;
        damping = Math.max(sailDampingFloor, Math.max(1e-12, damping * 0.5));
        accepted = true;
        break;
      }

      alpha *= 0.5;
    }

    if (accepted) {
      sailDampingFloor = Math.max(sailDampingMin, sailDampingFloor * sailDampingDecay);
      continue;
    }

    // Steepest descent fallback
    damping *= 4;

    const sdDir = assembled.grad.map((v) => -v);
    const g2 = dot(assembled.grad, assembled.grad);
    if (!(g2 > 1e-18)) continue;

    let alphaSd = 1.0;
    {
      let denom = 0;
      for (let i = 0; i < assembled.K.length; i++) {
        let s = 0;
        const row = assembled.K[i];
        for (let j = 0; j < assembled.K.length; j++) s += row[j] * assembled.grad[j];
        denom += assembled.grad[i] * s;
      }
      if (Number.isFinite(denom) && denom > 1e-12) alphaSd = Math.min(1.0, g2 / denom);
      else alphaSd = Math.min(1.0, 1e-2 / Math.sqrt(g2));
    }

    let sdAccepted = false;
    let sdAlpha = alphaSd;
    for (let ls = 0; ls < 18; ls++) {
      const xTry = add(x, sdDir, sdAlpha);
      const next = assembleSystem({ model, dofMap, x: xTry, cableCompressionEps: eps });
      if (next.energy < assembled.energy + 1e-6) {
        x = xTry;
        assembled = next;
        sdAccepted = true;
        break;
      }
      sdAlpha *= 0.5;
    }

    if (sdAccepted) continue;
  }

  const finalG = normInf(assembled.grad);

  convergenceHistory.push({
    iter: maxIt,
    residual: finalG,
    energy: assembled.energy,
    damping,
    dampingFloor: sailDampingFloor,
    maxDof: normInf(x)
  });

  return {
    x: finalG < minGrad ? x : bestX,
    converged: (finalG < minGrad ? finalG : minGrad) < tol,
    iterations: maxIt,
    energy: assembled.energy,
    gradInf: finalG < minGrad ? finalG : minGrad,
    reason: "max_iterations",
    meta: assembled.meta,
    convergenceHistory
  };
}

function mastCurveFromModel(model, nodesPos) {
  return model.mastNodeIds.map((id) => {
    const p = nodesPos[id];
    return { x: p[0], y: p[1], z: p[2] };
  });
}

module.exports = { solveEquilibrium3d, mastCurveFromModel, buildDofMap3d };
