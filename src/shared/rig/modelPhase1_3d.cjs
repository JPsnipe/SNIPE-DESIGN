const { clamp, sub3, norm3, dot3, add3, scale3 } = require("./math3.cjs");

// Interpolación lineal
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * MODELO 3D DEL MASTIL - Phase 1 con 3 DOF por nodo (x, y, z)
 *
 * CORRECCIONES FISICAS IMPLEMENTADAS:
 *
 * 1. DOF en Z (Compresion Axial):
 *    - Los nodos del mastil pueden desplazarse verticalmente
 *    - Esto permite capturar el efecto P-Delta real
 *    - El mastil se "acorta" bajo la carga de la jarcia
 *
 * 2. Fuerzas de Compresion de Jarcia:
 *    - Las fuerzas Fz de obenques y forestay se aplican correctamente
 *    - La compresion axial del mastil es fisica, no artificial
 *
 * 3. Crucetas con Geometria de Arco:
 *    - Las crucetas se modelan como barras rigidas que rotan
 *    - Acoplamiento geometrico correcto x-y-z
 *
 * 4. Pre-tension Realista:
 *    - La compresion axial reduce la rigidez efectiva a flexion
 *    - Efecto P-Delta correcto: mas carga = mas flexible
 */

function buildPhase1Model3d({ geometry, controls, solver, state, constants }) {
  const {
    mastLengthM,
    partnersZM,
    spreaderZM,
    houndsZM,
    shroudAttachZM,
    chainplateXM,
    chainplateYM,
    bowYM
  } = geometry;

  const effectiveShroudAttachZM = shroudAttachZM ?? houndsZM;

  const nSeg = solver.mastSegments;
  const ds = mastLengthM / nSeg;

  // EI variable con altura (conicidad)
  const mastEIBase = constants.mastEIBase || constants.mastEI || 7500;
  const mastEITop = constants.mastEITop || mastEIBase * 0.4;
  const taperStartZM = constants.taperStartZM || 4.5;

  function getEIAtZ(z) {
    if (z <= taperStartZM) {
      return mastEIBase;
    }
    const t = (z - taperStartZM) / (mastLengthM - taperStartZM);
    return mastEIBase + t * (mastEITop - mastEIBase);
  }

  // Rigidez axial del mastil - Reducida para mejor condicionamiento numerico
  // El valor real seria E*A ~ 28 MN, pero usamos un valor menor que captura
  // el efecto P-Delta sin causar problemas de condicionamiento.
  const mastEA = constants.mastEA_real || 5e5;
  const spreaderEA = constants.spreaderEA;
  const rigEA = constants.rigEA;
  const rigSmoothDeltaM = constants.rigSmoothDeltaM ?? 1e-6;
  // Partners en Z: por defecto libre (el pasacubierta no tiene por qué aportar reacciA3n vertical)
  const partnersKz = constants.partnersKz ?? 0;

  const nodes = [];
  const addNode = (name, p0, fixed) => {
    const id = nodes.length;
    nodes.push({
      id,
      name,
      p0: p0.slice(), // Clonar para evitar mutaciones
      fixed: Boolean(fixed)
    });
    return id;
  };

  // Pie del mastil: completamente fijo (x=y=z=0)
  const stepId = addNode("mast_step", [0, 0, 0], true);

  // Nodos del mastil: libres en X, Y, Z (3 DOF por nodo)
  const mastNodeIds = [stepId];
  for (let i = 1; i <= nSeg; i++) {
    const z = ds * i;
    mastNodeIds.push(addNode(`mast_${i}`, [0, 0, z], false));
  }
  const mastHeadId = mastNodeIds[mastNodeIds.length - 1];

  // Indices de nodos especiales
  const spreaderIndex = clamp(
    Math.round((spreaderZM / mastLengthM) * nSeg),
    1,
    nSeg - 1
  );
  const spreaderRootId = mastNodeIds[spreaderIndex];
  const spreaderRootZ = nodes[spreaderRootId].p0[2];

  const partnersIndex = clamp(
    Math.round((partnersZM / mastLengthM) * nSeg),
    1,
    nSeg - 1
  );
  const partnersNodeId = mastNodeIds[partnersIndex];

  const houndsIndex = clamp(
    Math.round((houndsZM / mastLengthM) * nSeg),
    1,
    nSeg
  );
  const houndsNodeId = mastNodeIds[houndsIndex];

  const shroudAttachIndex = clamp(
    Math.round((effectiveShroudAttachZM / mastLengthM) * nSeg),
    1,
    nSeg
  );
  const shroudAttachNodeId = mastNodeIds[shroudAttachIndex];

  // Crucetas: posicion inicial
  const spreaderLengthM = controls.spreaderLengthM;
  const spreaderSweepAftM = controls.spreaderSweepAftM;
  const ySweep = -spreaderSweepAftM;
  const xOut = Math.sqrt(Math.max(0, spreaderLengthM ** 2 - ySweep ** 2));

  // Tips de crucetas: libres en X, Y, Z
  // Definición física: Babor (Port) = Left = -X, Estribor (Starboard) = Right = +X
  const tipPortId = addNode(
    "spreader_tip_port",
    [-xOut, ySweep, spreaderRootZ],
    false
  );
  const tipStbdId = addNode(
    "spreader_tip_stbd",
    [xOut, ySweep, spreaderRootZ],
    false
  );

  // Puntos de anclaje fijos
  const chainPortId = addNode("chainplate_port", [-chainplateXM, chainplateYM, 0], true);
  const chainStbdId = addNode("chainplate_stbd", [chainplateXM, chainplateYM, 0], true);
  const bowId = addNode("bow_fitting", [0, bowYM, 0], true);

  const axial = [];
  const addAxial = (e) => {
    axial.push(e);
  };

  // MASTIL segments
  for (let i = 0; i < mastNodeIds.length - 1; i++) {
    const a = mastNodeIds[i];
    const b = mastNodeIds[i + 1];
    const L0 = norm3(sub3(nodes[b].p0, nodes[a].p0));
    addAxial({
      name: `mast_seg_${i}`,
      i: a,
      j: b,
      EA: mastEA,
      L0,
      kind: "bar"
    });
  }

  // SPREADERS
  addAxial({
    name: "spreader_port",
    i: spreaderRootId,
    j: tipPortId,
    EA: spreaderEA,
    L0: spreaderLengthM,
    kind: "bar"
  });
  addAxial({
    name: "spreader_stbd",
    i: spreaderRootId,
    j: tipStbdId,
    EA: spreaderEA,
    L0: spreaderLengthM,
    kind: "bar"
  });

  // HELPER PARA DISCRETIZAR CABLES
  const nCableSeg = solver.cableSegments || 1;

  const addDiscretizedLine = (name, nodeAId, nodeBId, EA, L0_total, kind, nodesArray, axialArray) => {
    if (nCableSeg <= 1) {
      axialArray.push({ name, i: nodeAId, j: nodeBId, EA, L0: L0_total, kind, smoothDeltaM: rigSmoothDeltaM });
      return;
    }
    const pA = nodesArray[nodeAId].p0;
    const pB = nodesArray[nodeBId].p0;
    let lastId = nodeAId;
    for (let i = 1; i <= nCableSeg; i++) {
      const t = i / nCableSeg;
      const p = [lerp(pA[0], pB[0], t), lerp(pA[1], pB[1], t), lerp(pA[2], pB[2], t)];
      const nextId = (i === nCableSeg) ? nodeBId : addNode(`${name}_node_${i}`, p, false);
      axialArray.push({
        name: `${name}_seg_${i}`,
        i: lastId,
        j: nextId,
        EA,
        L0: L0_total / nCableSeg,
        kind: "cable",
        smoothDeltaM: rigSmoothDeltaM
      });
      lastId = nextId;
    }
  };

  // SHROUDS
  const computeShroudL0Path = (side) => {
    const tipId = side === "port" ? tipPortId : tipStbdId;
    const chainId = side === "port" ? chainPortId : chainStbdId;
    const LUpper = norm3(sub3(nodes[tipId].p0, nodes[shroudAttachNodeId].p0));
    const LLower = norm3(sub3(nodes[chainId].p0, nodes[tipId].p0));
    return { LUpper, LLower };
  };

  const standingScale = Number.isFinite(state?.standingScale) ? state.standingScale : 1;
  const shroudBaseDelta = standingScale * (controls.shroudBaseDeltaM || 0);
  const shroudDeltaPort = standingScale * (controls.shroudDeltaL0PortM || 0);
  const shroudDeltaStbd = standingScale * (controls.shroudDeltaL0StbdM || 0);

  const pathPort = computeShroudL0Path("port");
  const pathStbd = computeShroudL0Path("stbd");

  const totalL0Port = (pathPort.LUpper + pathPort.LLower) - (shroudBaseDelta + shroudDeltaPort);
  const totalL0Stbd = (pathStbd.LUpper + pathStbd.LLower) - (shroudBaseDelta + shroudDeltaStbd);

  // Proporción de L0 para cada tramo (asumiendo estiramiento uniforme o simplemente geométrica)
  const ratioUpperPort = pathPort.LUpper / (pathPort.LUpper + pathPort.LLower);
  const ratioUpperStbd = pathStbd.LUpper / (pathStbd.LUpper + pathStbd.LLower);

  if (nCableSeg <= 1) {
    addAxial({ name: "shroud_port", i: shroudAttachNodeId, k: tipPortId, j: chainPortId, EA: rigEA, L0: totalL0Port, kind: "cable_path", smoothDeltaM: rigSmoothDeltaM });
    addAxial({ name: "shroud_stbd", i: shroudAttachNodeId, k: tipStbdId, j: chainStbdId, EA: rigEA, L0: totalL0Stbd, kind: "cable_path", smoothDeltaM: rigSmoothDeltaM });
  } else {
    // Dividimos los 50 segmentos entre los dos tramos (proporcionalmente o 25/25)
    const nUp = Math.round(nCableSeg / 2);
    const nLow = nCableSeg - nUp;

    const oldNCableSeg = solver.cableSegments;
    // Reutilizamos addDiscretizedLine temporalmente cambiando nCableSeg? No, mejor pasarla.
    const addCustomDisc = (name, n, nA, nB, ea, l0) => {
      const pA = nodes[nA].p0;
      const pB = nodes[nB].p0;
      let last = nA;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const p = [lerp(pA[0], pB[0], t), lerp(pA[1], pB[1], t), lerp(pA[2], pB[2], t)];
        const next = (i === n) ? nB : addNode(`${name}_node_${i}`, p, false);
        addAxial({ name: `${name}_seg_${i}`, i: last, j: next, EA: ea, L0: l0 / n, kind: "cable", smoothDeltaM: rigSmoothDeltaM });
        last = next;
      }
    };

    addCustomDisc("shroud_port_up", nUp, shroudAttachNodeId, tipPortId, rigEA, totalL0Port * ratioUpperPort);
    addCustomDisc("shroud_port_low", nLow, tipPortId, chainPortId, rigEA, totalL0Port * (1 - ratioUpperPort));
    addCustomDisc("shroud_stbd_up", nUp, shroudAttachNodeId, tipStbdId, rigEA, totalL0Stbd * ratioUpperStbd);
    addCustomDisc("shroud_stbd_low", nLow, tipStbdId, chainStbdId, rigEA, totalL0Stbd * (1 - ratioUpperStbd));
  }

  // FORESTAY
  const stayTensionTarget = Math.max(0, (state.halyardScale || 0) * (controls.jibHalyardTensionN || 0));
  const lockStay = controls.lockStayLength === true;

  if ((lockStay || nCableSeg > 1) && stayTensionTarget > 0) {
    const p1 = nodes[houndsNodeId].p0;
    const p2 = nodes[bowId].p0;
    const L_current = norm3(sub3(p2, p1));
    const L0_stay = (rigEA * L_current) / (rigEA + stayTensionTarget);

    if (nCableSeg <= 1) {
      addAxial({ name: "stay_jib", i: houndsNodeId, j: bowId, EA: rigEA, L0: L0_stay, kind: "cable", smoothDeltaM: rigSmoothDeltaM });
    } else {
      let last = houndsNodeId;
      for (let i = 1; i <= nCableSeg; i++) {
        const t = i / nCableSeg;
        const p = [lerp(p1[0], p2[0], t), lerp(p1[1], p2[1], t), lerp(p1[2], p2[2], t)];
        const next = (i === nCableSeg) ? bowId : addNode(`stay_jib_node_${i}`, p, false);
        addAxial({ name: `stay_jib_seg_${i}`, i: last, j: next, EA: rigEA, L0: L0_stay / nCableSeg, kind: "cable", smoothDeltaM: rigSmoothDeltaM });
        last = next;
      }
    }
  } else {
    // Si no está bloqueado ni discretizado, se trata como una fuerza de tensión pura
    addAxial({
      name: "stay_jib",
      i: houndsNodeId,
      j: bowId,
      N: stayTensionTarget,
      kind: "tension"
    });
  }

  // Partners offset solo aplica cuando hay tensión REAL en el sistema
  // Con tensión 0 (estado relajado), el palo debe quedarse recto sin fuerzas forzadas
  // Usamos una rampa suave: offset aumenta linealmente de 0 a 100% cuando tensión sube de 0 a 500N
  const tensionRampN = 500; // A partir de 500N de tensión, el offset es completo
  const systemActive = stayTensionTarget > 0 ? Math.min(1, stayTensionTarget / tensionRampN) : 0;
  const scaledPartnersOffsetX = systemActive * (controls.partnersOffsetXM || 0);
  const scaledPartnersOffsetY = systemActive * (controls.partnersOffsetYM || 0);

  const springs = [
    {
      name: "partners_spring",
      nodeId: partnersNodeId,
      kx: controls.partnersKx,
      ky: controls.partnersKy,
      kz: partnersKz,
      targetX: scaledPartnersOffsetX,
      targetY: scaledPartnersOffsetY
    }
  ];

  // CRUCETAS: Conexión rígida (sin springs)
  // La unión cruceta-mástil transfiere los 6 DOF. El bar element ya mantiene
  // la distancia fija. La posición del tip se determina por:
  // 1. El bar element (distancia fija desde root)
  // 2. La tensión del obenque que pasa por el tip (el cable corre por un agujero)
  // 3. La geometría inicial (sweep angle)
  // NO hay springs adicionales - la física real posiciona el tip.

  // FUERZAS EXTERNAS
  const forces = new Array(nodes.length).fill(null).map(() => [0, 0, 0]);
  for (let i = 1; i < mastNodeIds.length; i++) {
    const nodeId = mastNodeIds[i];
    const z = nodes[nodeId].p0[2];
    let q = 0;
    if (state.loadScale > 0 && state.load.mode !== "none") {
      const base = state.load.mode === "downwind" ? 0.3 * state.load.qLateralNpm : state.load.qLateralNpm;
      const shape = state.load.qProfile === "triangular" ? z / mastLengthM : 1;
      q = base * shape;
    }
    const windSign = state.sails?.windSign ?? 1;
    const fx = state.loadScale * q * ds * (-windSign);
    forces[nodeId] = [forces[nodeId][0] + fx, forces[nodeId][1], forces[nodeId][2]];
  }

  return {
    nodes,
    mastNodeIds,
    mastHeadId,
    partnersNodeId,
    houndsNodeId,
    shroudAttachNodeId,
    tipPortId,
    tipStbdId,
    chainPortId,
    chainStbdId,
    bowId,
    axial,
    springs,
    forces,
    beam: { getEIAtZ, ds, mastLengthM }
  };
}

module.exports = { buildPhase1Model3d };
