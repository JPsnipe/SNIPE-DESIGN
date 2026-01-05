const { clamp, sub3, dot3, norm3, normalize3, scale3, add3 } = require("./math3.cjs");

function buildDofMap(nodes) {
  const map = new Map();
  let nDof = 0;
  for (const node of nodes) {
    if (node.fixed) continue;
    map.set(node.id, nDof);
    nDof += 3;
  }
  return { map, nDof };
}

function positionsFromX(nodes, dofMap, x) {
  const p = new Array(nodes.length);
  for (const node of nodes) {
    const p0 = node.p0;
    if (node.fixed) {
      p[node.id] = p0;
    } else {
      const base = dofMap.map.get(node.id);
      p[node.id] = [p0[0] + x[base], p0[1] + x[base + 1], p0[2] + x[base + 2]];
    }
  }
  return p;
}

function addGradNode(grad, dofMap, nodeId, v) {
  const base = dofMap.map.get(nodeId);
  if (base === undefined) return;
  grad[base] += v[0];
  grad[base + 1] += v[1];
  grad[base + 2] += v[2];
}

function axialEnergyAndGrad({
  nodesPos,
  bars,
  dofMap,
  cableCompressionEps
}) {
  let E = 0;
  const grad = new Array(dofMap.nDof).fill(0);
  const axialForces = {};
  const slackCables = [];

  for (const e of bars) {
    const pi = nodesPos[e.i];
    const pj = nodesPos[e.j];
    const d = sub3(pj, pi);
    const { v: n, n: L } = normalize3(d);
    const dL = L - e.L0;

    let k = e.EA / e.L0;
    if (e.kind === "cable" && dL < 0) k *= cableCompressionEps;

    const N = k * dL;
    E += 0.5 * k * dL * dL;

    const fi = scale3(n, -N);
    const fj = scale3(n, +N);
    addGradNode(grad, dofMap, e.i, fi);
    addGradNode(grad, dofMap, e.j, fj);

    axialForces[e.name] = N;
    if (e.kind === "cable" && dL < 0) slackCables.push(e.name);
  }

  return { E, grad, axialForces, slackCables };
}

function bendEnergyAndGrad({ nodesPos, hinges, dofMap }) {
  let E = 0;
  const grad = new Array(dofMap.nDof).fill(0);

  for (const h of hinges) {
    const pa = nodesPos[h.a];
    const pb = nodesPos[h.b];
    const pc = nodesPos[h.c];

    const e1 = sub3(pb, pa);
    const e2 = sub3(pc, pb);
    const l1 = norm3(e1);
    const l2 = norm3(e2);
    if (l1 < 1e-12 || l2 < 1e-12) continue;

    const c = clamp(dot3(e1, e2) / (l1 * l2), -1, 1);
    const theta = Math.acos(c);
    const sinTheta = Math.sqrt(Math.max(0, 1 - c * c));
    if (sinTheta < 1e-9 || theta < 1e-9) continue;

    const kB = h.EI / h.ds;
    E += 0.5 * kB * theta * theta;

    const invL1L2 = 1 / (l1 * l2);
    const dcos_de1 = add3(
      scale3(e2, invL1L2),
      scale3(e1, -c / (l1 * l1))
    );
    const dcos_de2 = add3(
      scale3(e1, invL1L2),
      scale3(e2, -c / (l2 * l2))
    );

    const coef = (-kB * theta) / sinTheta;
    const dE_de1 = scale3(dcos_de1, coef);
    const dE_de2 = scale3(dcos_de2, coef);

    addGradNode(grad, dofMap, h.a, scale3(dE_de1, -1));
    addGradNode(grad, dofMap, h.b, add3(dE_de1, scale3(dE_de2, -1)));
    addGradNode(grad, dofMap, h.c, dE_de2);
  }

  return { E, grad };
}

function springEnergyAndGrad({ nodesPos, springs, nodes, dofMap }) {
  let E = 0;
  const grad = new Array(dofMap.nDof).fill(0);

  for (const s of springs) {
    const node = nodes[s.nodeId];
    if (!node || node.fixed) continue;
    const p0 = node.p0;
    const p = nodesPos[s.nodeId];
    const dx = p[0] - p0[0];
    const dy = p[1] - p0[1];
    const dz = p[2] - p0[2];
    E += 0.5 * (s.kx * dx * dx + s.ky * dy * dy + s.kz * dz * dz);
    addGradNode(grad, dofMap, s.nodeId, [s.kx * dx, s.ky * dy, s.kz * dz]);
  }

  return { E, grad };
}

function externalWorkAndGrad({ forces, nodes, dofMap, x }) {
  let W = 0;
  const grad = new Array(dofMap.nDof).fill(0);
  for (const node of nodes) {
    if (node.fixed) continue;
    const base = dofMap.map.get(node.id);
    const f = forces[node.id] ?? [0, 0, 0];
    const u = [x[base], x[base + 1], x[base + 2]];
    W += f[0] * u[0] + f[1] * u[1] + f[2] * u[2];
    grad[base] -= f[0];
    grad[base + 1] -= f[1];
    grad[base + 2] -= f[2];
  }
  return { W, grad };
}

function makeValueAndGrad(model, solver) {
  const dofMap = buildDofMap(model.nodes);

  return {
    dofMap,
    valueAndGrad: (x) => {
      const nodesPos = positionsFromX(model.nodes, dofMap, x);

      const ax = axialEnergyAndGrad({
        nodesPos,
        bars: model.axialBars,
        dofMap,
        cableCompressionEps: solver.cableCompressionEps
      });

      const bend = bendEnergyAndGrad({
        nodesPos,
        hinges: model.bendHinges,
        dofMap
      });

      const spring = springEnergyAndGrad({
        nodesPos,
        springs: model.springs,
        nodes: model.nodes,
        dofMap
      });

      const ext = externalWorkAndGrad({
        forces: model.forces,
        nodes: model.nodes,
        dofMap,
        x
      });

      const value = ax.E + bend.E + spring.E - ext.W;
      const grad = new Array(dofMap.nDof).fill(0);
      for (let i = 0; i < dofMap.nDof; i++) {
        grad[i] =
          ax.grad[i] + bend.grad[i] + spring.grad[i] + ext.grad[i];
      }

      return {
        value,
        grad,
        meta: { axialForces: ax.axialForces, slackCables: ax.slackCables, nodesPos }
      };
    }
  };
}

module.exports = { buildDofMap, positionsFromX, makeValueAndGrad };
