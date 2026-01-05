const { clamp, sub3, norm3, normalize3, outer3, scale3 } = require("./math3.cjs");
const { zeros, dot, normInf, add, solveLinearSystem } = require("./linsolve.cjs");

function buildDofMap2d(nodes) {
  const map = new Map();
  let nDof = 0;
  for (const node of nodes) {
    if (node.fixed) continue;
    map.set(node.id, nDof);
    nDof += 2;
  }
  return { map, nDof };
}

function getU(nodeId, dofMap, x) {
  const base = dofMap.map.get(nodeId);
  if (base === undefined) return [0, 0];
  return [x[base], x[base + 1]];
}

function addGrad(nodeId, dofMap, grad, v2) {
  const base = dofMap.map.get(nodeId);
  if (base === undefined) return;
  grad[base] += v2[0];
  grad[base + 1] += v2[1];
}

function addKBlock(nodeA, nodeB, dofMap, K, block2x2, scale = 1) {
  const a = dofMap.map.get(nodeA);
  const b = dofMap.map.get(nodeB);
  if (a === undefined || b === undefined) return;
  K[a][b] += scale * block2x2[0][0];
  K[a][b + 1] += scale * block2x2[0][1];
  K[a + 1][b] += scale * block2x2[1][0];
  K[a + 1][b + 1] += scale * block2x2[1][1];
}

function addDiagonal(K, lambda) {
  for (let i = 0; i < K.length; i++) K[i][i] += lambda;
  return K;
}

function cloneMatrix(A) {
  return A.map((r) => r.slice());
}

function cableResponse({ dL, k0, epsComp, delta }) {
  const r = Math.sqrt(dL * dL + delta * delta);
  const s = 0.5 * (1 + dL / r); // 0..1

  // kEff(dL) interpola suavemente entre epsComp*k0 (compresiA3n) y k0 (tracciA3n)
  const kEff = k0 * (epsComp + (1 - epsComp) * s);
  const N = kEff * dL;

  // Tangente exacta: dN/ddL
  const ds = 0.5 * (delta * delta) / (r * r * r);
  const dkEff = k0 * (1 - epsComp) * ds;
  const kTangent = kEff + dL * dkEff;

  // EnergA-a consistente (U = ƒ^® N ddL)
  const asinh = Math.asinh(dL / delta);
  const energy =
    0.25 * k0 * (1 + epsComp) * dL * dL +
    0.25 * k0 * (1 - epsComp) * (dL * r - delta * delta * asinh);

  return { N, kTangent, energy };
}

function assembleSystem({ model, dofMap, x, cableCompressionEps }) {
  const n = dofMap.nDof;
  const grad = zeros(n);
  const K = new Array(n);
  for (let i = 0; i < n; i++) K[i] = zeros(n);

  let energyInternal = 0;
  let workExternal = 0;

  const nodesPos = new Array(model.nodes.length);
  for (const node of model.nodes) {
    const [ux, uy] = getU(node.id, dofMap, x);
    nodesPos[node.id] = [node.p0[0] + ux, node.p0[1] + uy, node.p0[2]];
  }

  const beams = model.beams || [];
  // Support legacy single mast beam if present
  const mastBeam = model.beam ? {
    nodeIds: model.mastNodeIds,
    ds: model.beam.ds,
    getEIAtZ: model.beam.getEIAtZ,
    EI: model.beam.EI
  } : null;
  const activeBeams = [...beams];
  if (mastBeam && !activeBeams.some(b => b.isMast)) {
    mastBeam.isMast = true;
    activeBeams.push(mastBeam);
  }

  const c = [1, -2, 1];

  for (const b of activeBeams) {
    if (!b.nodeIds || b.nodeIds.length < 3) continue;
    const ds = b.ds || 0.1;

    for (let i = 1; i < b.nodeIds.length - 1; i++) {
      const prev = b.nodeIds[i - 1];
      const curr = b.nodeIds[i];
      const next = b.nodeIds[i + 1];

      // EI variable or constant
      let EILocal = b.EI || 1400;
      if (b.getEIAtZ) {
        const zCurr = model.nodes[curr].p0[2];
        EILocal = b.getEIAtZ(zCurr);
      }
      const kB = EILocal / Math.pow(ds, 3);

      const [xPrev, yPrev] = getU(prev, dofMap, x);
      const [xCurr, yCurr] = getU(curr, dofMap, x);
      const [xNext, yNext] = getU(next, dofMap, x);

      const curX = xPrev * c[0] + xCurr * c[1] + xNext * c[2];
      const curY = yPrev * c[0] + yCurr * c[1] + yNext * c[2];

      energyInternal += 0.5 * kB * (curX * curX + curY * curY);

      addGrad(prev, dofMap, grad, [kB * curX * c[0], kB * curY * c[0]]);
      addGrad(curr, dofMap, grad, [kB * curX * c[1], kB * curY * c[1]]);
      addGrad(next, dofMap, grad, [kB * curX * c[2], kB * curY * c[2]]);

      for (let ii = 0; ii < 3; ii++) {
        for (let jj = 0; jj < 3; jj++) {
          const kBlock = [
            [kB * c[ii] * c[jj], 0],
            [0, kB * c[ii] * c[jj]]
          ];
          addKBlock(b.nodeIds[i - 1 + ii], b.nodeIds[i - 1 + jj], dofMap, K, kBlock);
        }
      }
    }
  }

  for (const s of model.springs) {
    // Relative spring: penaliza (uA - uB) en x/y (sin reacciA3n a tierra).
    if (s.nodeIdB !== undefined && s.nodeIdB !== null) {
      const aId = s.nodeIdA ?? s.nodeId;
      const bId = s.nodeIdB;
      const [ax, ay] = getU(aId, dofMap, x);
      const [bx, by] = getU(bId, dofMap, x);
      const dx = ax - bx;
      const dy = ay - by;
      const kx = s.kx || 0;
      const ky = s.ky || 0;

      energyInternal += 0.5 * (kx * dx * dx + ky * dy * dy);
      addGrad(aId, dofMap, grad, [kx * dx, ky * dy]);
      addGrad(bId, dofMap, grad, [-kx * dx, -ky * dy]);

      const Kaa = [
        [kx, 0],
        [0, ky]
      ];
      const Kab = [
        [-kx, 0],
        [0, -ky]
      ];

      addKBlock(aId, aId, dofMap, K, Kaa, +1);
      addKBlock(aId, bId, dofMap, K, Kab, +1);
      addKBlock(bId, aId, dofMap, K, Kab, +1);
      addKBlock(bId, bId, dofMap, K, Kaa, +1);
      continue;
    }

    // Ground spring: penaliza (u - 0) en x/y (reacciA3n a tierra).
    const base = dofMap.map.get(s.nodeId);
    if (base === undefined) continue;
    const ux = x[base];
    const uy = x[base + 1];
    energyInternal += 0.5 * (s.kx * ux * ux + s.ky * uy * uy);
    grad[base] += s.kx * ux;
    grad[base + 1] += s.ky * uy;
    K[base][base] += s.kx;
    K[base + 1][base + 1] += s.ky;
  }

  const axialForces = {};
  const slackCables = [];

  // Reacciones en nodos fijos (acumuladas de todos los elementos conectados)
  const reactions = {};
  for (const node of model.nodes) {
    if (node.fixed) {
      reactions[node.name] = [0, 0, 0]; // [Rx, Ry, Rz]
    }
  }

  for (const e of model.axial) {
    if (e.kind === "tension") {
      const pi = nodesPos[e.i];
      const pj = nodesPos[e.j];
      const d = sub3(pj, pi);
      const { v: n3, n: L } = normalize3(d);
      if (!(L > 1e-12)) continue;

      const N = Math.max(0, Number.isFinite(e.N) ? e.N : 0);
      energyInternal += N * L;

      // Gradiente en X-Y (2 DOF)
      addGrad(e.i, dofMap, grad, [-N * n3[0], -N * n3[1]]);
      addGrad(e.j, dofMap, grad, [N * n3[0], N * n3[1]]);

      axialForces[e.name] = N;

      // Reacciones (incluye componente Z por geometría)
      const nodeI = model.nodes[e.i];
      const nodeJ = model.nodes[e.j];
      if (nodeI.fixed && reactions[nodeI.name]) {
        reactions[nodeI.name][0] += -N * n3[0];
        reactions[nodeI.name][1] += -N * n3[1];
        reactions[nodeI.name][2] += -N * n3[2];
      }
      if (nodeJ.fixed && reactions[nodeJ.name]) {
        reactions[nodeJ.name][0] += N * n3[0];
        reactions[nodeJ.name][1] += N * n3[1];
        reactions[nodeJ.name][2] += N * n3[2];
      }

      // Rigidez geométrica (2D): K = (N/L) * (I - n n^T) en X-Y
      const geo = N / L;
      const P = [
        [geo * (1 - n3[0] * n3[0]), geo * (-n3[0] * n3[1])],
        [geo * (-n3[1] * n3[0]), geo * (1 - n3[1] * n3[1])]
      ];

      const iFree = dofMap.map.has(e.i);
      const jFree = dofMap.map.has(e.j);
      if (iFree && jFree) {
        addKBlock(e.i, e.i, dofMap, K, P, +1);
        addKBlock(e.i, e.j, dofMap, K, P, -1);
        addKBlock(e.j, e.i, dofMap, K, P, -1);
        addKBlock(e.j, e.j, dofMap, K, P, +1);
      } else if (iFree && !jFree) {
        addKBlock(e.i, e.i, dofMap, K, P, +1);
      } else if (!iFree && jFree) {
        addKBlock(e.j, e.j, dofMap, K, P, +1);
      }

      continue;
    }
    if (e.kind === "cable_path") {
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
      const epsComp = Number.isFinite(epsInput) ? clamp(epsInput, 0, 1) : 0;

      // Banda de transiciA3n muy estrecha (proporcional a L0, sin bias: N(0)=0)
      const delta = Number.isFinite(e.smoothDeltaM)
        ? Math.max(1e-9, e.smoothDeltaM)
        : Math.max(1e-4, e.L0 * 1e-4);

      const { N, kTangent, energy } = cableResponse({ dL, k0, epsComp, delta });
      energyInternal += energy;

      // Gradiente (∂U/∂x) con L = |k-i| + |j-k|
      // gi = -N*n1 ; gj = +N*n2 ; gk = N*(n1 - n2)
      addGrad(e.i, dofMap, grad, [-N * n1[0], -N * n1[1]]);
      addGrad(e.k, dofMap, grad, [N * (n1[0] - n2[0]), N * (n1[1] - n2[1])]);
      addGrad(e.j, dofMap, grad, [N * n2[0], N * n2[1]]);

      axialForces[e.name] = N;
      if (isSlack) slackCables.push(e.name);

      // Reacciones en nodos fijos (reacciA3n del apoyo sobre la estructura)
      const nodeI = model.nodes[e.i];
      const nodeK = model.nodes[e.k];
      const nodeJ = model.nodes[e.j];
      if (nodeI.fixed && reactions[nodeI.name]) {
        reactions[nodeI.name][0] += -N * n1[0];
        reactions[nodeI.name][1] += -N * n1[1];
        reactions[nodeI.name][2] += -N * n1[2];
      }
      if (nodeK.fixed && reactions[nodeK.name]) {
        reactions[nodeK.name][0] += N * (n1[0] - n2[0]);
        reactions[nodeK.name][1] += N * (n1[1] - n2[1]);
        reactions[nodeK.name][2] += N * (n1[2] - n2[2]);
      }
      if (nodeJ.fixed && reactions[nodeJ.name]) {
        reactions[nodeJ.name][0] += N * n2[0];
        reactions[nodeJ.name][1] += N * n2[1];
        reactions[nodeJ.name][2] += N * n2[2];
      }

      // Rigidez (2D) por energA-a: K = dN/dL * (∂L/∂x ⊗ ∂L/∂x) + N * ∂²L/∂x²
      // Material (acopla 3 nodos porque N depende de L1+L2)
      const ids = [e.i, e.k, e.j];
      const Ds = [
        [-n1[0], -n1[1]],
        [n1[0] - n2[0], n1[1] - n2[1]],
        [n2[0], n2[1]]
      ];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const block = [
            [kTangent * Ds[a][0] * Ds[b][0], kTangent * Ds[a][0] * Ds[b][1]],
            [kTangent * Ds[a][1] * Ds[b][0], kTangent * Ds[a][1] * Ds[b][1]]
          ];
          addKBlock(ids[a], ids[b], dofMap, K, block, +1);
        }
      }

      // GeomA©trica (por cada tramo). Para cable flojo anulamos (N/L) como en el truss.
      const geo1 = (!isSlack && L1 > 1e-12) ? N / L1 : 0;
      const geo2 = (!isSlack && L2 > 1e-12) ? N / L2 : 0;

      if (geo1 !== 0) {
        const P1 = [
          [geo1 * (1 - n1[0] * n1[0]), geo1 * (-n1[0] * n1[1])],
          [geo1 * (-n1[1] * n1[0]), geo1 * (1 - n1[1] * n1[1])]
        ];
        addKBlock(e.i, e.i, dofMap, K, P1, +1);
        addKBlock(e.i, e.k, dofMap, K, P1, -1);
        addKBlock(e.k, e.i, dofMap, K, P1, -1);
        addKBlock(e.k, e.k, dofMap, K, P1, +1);
      }

      if (geo2 !== 0) {
        const P2 = [
          [geo2 * (1 - n2[0] * n2[0]), geo2 * (-n2[0] * n2[1])],
          [geo2 * (-n2[1] * n2[0]), geo2 * (1 - n2[1] * n2[1])]
        ];
        addKBlock(e.k, e.k, dofMap, K, P2, +1);
        addKBlock(e.k, e.j, dofMap, K, P2, -1);
        addKBlock(e.j, e.k, dofMap, K, P2, -1);
        addKBlock(e.j, e.j, dofMap, K, P2, +1);
      }

      continue;
    }

    const pi = nodesPos[e.i];
    const pj = nodesPos[e.j];
    const d = sub3(pj, pi);
    const { v: n3, n: L } = normalize3(d);
    const dL = L - e.L0;

    const isCable = e.kind === "cable";
    const isSlack = isCable && dL < 0;

    // Cables tension-only con regularización suave cerca de dL~0:
    // evita saltos enormes de rigidez con cableCompressionEps muy pequeño.
    const k0 = e.EA / e.L0;
    const epsInput = Number.isFinite(e.compressionEps) ? e.compressionEps : cableCompressionEps;
    const epsComp = isCable && Number.isFinite(epsInput) ? clamp(epsInput, 0, 1) : 0;

    let N = 0;
    let kTangent = k0;

    if (!isCable) {
      N = k0 * dL;
      energyInternal += 0.5 * k0 * dL * dL;
    } else {
      // Banda de transición muy estrecha (proporcional a L0, sin bias: N(0)=0)
      const delta = Number.isFinite(e.smoothDeltaM)
        ? Math.max(1e-9, e.smoothDeltaM)
        : Math.max(1e-4, e.L0 * 1e-4);
      const r = Math.sqrt(dL * dL + delta * delta);
      const s = 0.5 * (1 + dL / r); // 0..1

      // kEff(dL) interpola suavemente entre epsComp*k0 (compresión) y k0 (tracción)
      const kEff = k0 * (epsComp + (1 - epsComp) * s);
      N = kEff * dL;

      // Tangente exacta: dN/ddL
      const ds = 0.5 * (delta * delta) / (r * r * r);
      const dkEff = k0 * (1 - epsComp) * ds;
      kTangent = kEff + dL * dkEff;

      // Energía consistente (U = ∫ N ddL)
      const asinh = Math.asinh(dL / delta);
      energyInternal +=
        0.25 * k0 * (1 + epsComp) * dL * dL +
        0.25 * k0 * (1 - epsComp) * (dL * r - delta * delta * asinh);
    }

    // Gradiente (fuerzas internas) - siempre se aplica
    const fi = [-N * n3[0], -N * n3[1]];
    const fj = [N * n3[0], N * n3[1]];
    addGrad(e.i, dofMap, grad, fi);
    addGrad(e.j, dofMap, grad, fj);

    axialForces[e.name] = N;
    if (isSlack) slackCables.push(e.name);

    // Acumular reacciones en nodos fijos
    // La fuerza del elemento sobre el nodo i es fi (en 3D: -N * n3)
    // La fuerza del elemento sobre el nodo j es fj (en 3D: +N * n3)
    const nodeI = model.nodes[e.i];
    const nodeJ = model.nodes[e.j];
    if (nodeI.fixed && reactions[nodeI.name]) {
      reactions[nodeI.name][0] += -N * n3[0];
      reactions[nodeI.name][1] += -N * n3[1];
      reactions[nodeI.name][2] += -N * n3[2];
    }
    if (nodeJ.fixed && reactions[nodeJ.name]) {
      reactions[nodeJ.name][0] += N * n3[0];
      reactions[nodeJ.name][1] += N * n3[1];
      reactions[nodeJ.name][2] += N * n3[2];
    }

    // Rigidez truss = (dN/ddL) * (n ⊗ n) + (N/L) * (I - n ⊗ n)
    // Para cables flojos: anulamos la parte geométrica (N/L), pero mantenemos una
    // rigidez axial regularizada (dN/ddL) para favorecer convergencia.
    const nn = outer3(n3, n3);
    const geo = (!isSlack && L > 1e-12) ? N / L : 0;

    const I = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];

    const K3 = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        K3[a][b] = kTangent * nn[a][b] + geo * (I[a][b] - nn[a][b]);
      }
    }
    const Kxy = [
      [K3[0][0], K3[0][1]],
      [K3[1][0], K3[1][1]]
    ];

    const iFree = dofMap.map.has(e.i);
    const jFree = dofMap.map.has(e.j);

    if (iFree && jFree) {
      addKBlock(e.i, e.i, dofMap, K, Kxy, +1);
      addKBlock(e.i, e.j, dofMap, K, Kxy, -1);
      addKBlock(e.j, e.i, dofMap, K, Kxy, -1);
      addKBlock(e.j, e.j, dofMap, K, Kxy, +1);
    } else if (iFree && !jFree) {
      addKBlock(e.i, e.i, dofMap, K, Kxy, +1);
    } else if (!iFree && jFree) {
      addKBlock(e.j, e.j, dofMap, K, Kxy, +1);
    }
  }

  for (const node of model.nodes) {
    const base = dofMap.map.get(node.id);
    if (base === undefined) continue;
    const f = model.forces[node.id] ?? [0, 0];
    workExternal += f[0] * x[base] + f[1] * x[base + 1];
    grad[base] -= f[0];
    grad[base + 1] -= f[1];
  }

  // Fuerzas de los springs (partners) - estas son reacciones sobre la estructura
  const springsForces = {};
  for (const s of model.springs) {
    if (s.nodeIdB !== undefined && s.nodeIdB !== null) continue;
    const base = dofMap.map.get(s.nodeId);
    if (base === undefined) continue;
    const ux = x[base];
    const uy = x[base + 1];
    // Fuerza del resorte: F = -k*u (reacción sobre la cubierta = k*u)
    springsForces[s.name] = { fx: s.kx * ux, fy: s.ky * uy };
  }

  const energy = energyInternal - workExternal;

  return { energy, grad, K, meta: { axialForces, slackCables, nodesPos, reactions, springsForces } };
}

function solveEquilibrium2d({ model, solver, x0 }) {
  const dofMap = buildDofMap2d(model.nodes);
  let x = x0?.slice() ?? zeros(dofMap.nDof);
  if (x.length !== dofMap.nDof) x = zeros(dofMap.nDof);

  const tol = solver.toleranceN;
  const maxIt = solver.maxIterations || 200;
  const eps = solver.cableCompressionEps;

  // Sail-specific damping: starts higher and decays with iterations
  const hasSails = model.sails && (model.sails.main || model.sails.jib);
  const sailDampingInit = Number.isFinite(solver.sailDamping) ? solver.sailDamping : 0.1;
  const sailDampingDecay = Number.isFinite(solver.sailDampingDecay)
    ? clamp(solver.sailDampingDecay, 0.5, 0.99)
    : 0.85;

  // Base damping floor that decays with iterations (for sails stability)
  let sailDampingFloor = hasSails ? sailDampingInit : 0;

  let damping = hasSails ? Math.max(1e-4, sailDampingInit) : 1e-4; // Initial damping (Levenberg-style)
  let bestX = x.slice();
  let minGrad = Infinity;

  // Convergence history for diagnostics
  const convergenceHistory = [];

  let assembled = assembleSystem({ model, dofMap, x, cableCompressionEps: eps });

  for (let iter = 0; iter < maxIt; iter++) {
    const gInf = normInf(assembled.grad);

    // Record convergence data
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

    // Try Newton step with current damping.
    let dx = null;
    let success = false;

    // We try to solve (K + damping*I) dx = -g
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

    if (!success) break; // Hard failure

    // Energy-based line search (simple monotone descent).
    let alpha = 1.0;
    let accepted = false;
    for (let ls = 0; ls < 10; ls++) {
      const xTry = add(x, dx, alpha);
      const next = assembleSystem({ model, dofMap, x: xTry, cableCompressionEps: eps });

      if (next.energy < assembled.energy + 1e-6) {
        x = xTry;
        assembled = next;
        // Reduce damping but respect the decaying floor for sails stability
        damping = Math.max(sailDampingFloor, Math.max(1e-12, damping * 0.5));
        accepted = true;
        break;
      }

      alpha *= 0.5;
    }

    if (accepted) {
      // Decay the sail damping floor each successful iteration
      sailDampingFloor *= sailDampingDecay;
      continue;
    }

    // If Newton step can't be accepted, increase damping and try a steepest-descent step with backtracking.
    damping *= 4;

    const sdDir = assembled.grad.map((v) => -v);
    const g2 = dot(assembled.grad, assembled.grad);
    if (!(g2 > 1e-18)) continue;

    // Quadratic-model step length along -g: alpha ~= (g^T g) / (g^T K g)
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

  // Record final state
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

module.exports = { solveEquilibrium2d, mastCurveFromModel };
