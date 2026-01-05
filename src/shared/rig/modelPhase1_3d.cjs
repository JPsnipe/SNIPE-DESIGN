const { clamp, sub3, norm3, dot3, add3, scale3 } = require("./math3.cjs");

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

  // SHROUDS
  const computeShroudL0Total = (deltaTotalM, baseDeltaM, side) => {
    const tipId = side === "port" ? tipPortId : tipStbdId;
    const chainId = side === "port" ? chainPortId : chainStbdId;
    const LUpper = norm3(sub3(nodes[tipId].p0, nodes[shroudAttachNodeId].p0));
    const LLower = norm3(sub3(nodes[chainId].p0, nodes[tipId].p0));
    const L_path = LUpper + LLower;
    return L_path - (baseDeltaM + deltaTotalM);
  };

  const standingScale = Number.isFinite(state?.standingScale) ? state.standingScale : 1;
  const shroudBaseDelta = standingScale * (controls.shroudBaseDeltaM || 0);
  const shroudDeltaPort = standingScale * (controls.shroudDeltaL0PortM || 0);
  const shroudDeltaStbd = standingScale * (controls.shroudDeltaL0StbdM || 0);
  const shroudPortL0 = computeShroudL0Total(shroudDeltaPort, shroudBaseDelta, "port");
  const shroudStbdL0 = computeShroudL0Total(shroudDeltaStbd, shroudBaseDelta, "stbd");

  addAxial({
    name: "shroud_port",
    i: shroudAttachNodeId,
    k: tipPortId,
    j: chainPortId,
    EA: rigEA,
    L0: shroudPortL0,
    smoothDeltaM: rigSmoothDeltaM,
    kind: "cable_path"
  });
  addAxial({
    name: "shroud_stbd",
    i: shroudAttachNodeId,
    k: tipStbdId,
    j: chainStbdId,
    EA: rigEA,
    L0: shroudStbdL0,
    smoothDeltaM: rigSmoothDeltaM,
    kind: "cable_path"
  });

  // FORESTAY
  addAxial({
    name: "stay_jib",
    i: houndsNodeId,
    j: bowId,
    N: Math.max(0, (state.halyardScale || 0) * (controls.jibHalyardTensionN || 0)),
    kind: "tension"
  });

  const springs = [
    {
      name: "partners_spring",
      nodeId: partnersNodeId,
      kx: controls.partnersKx,
      ky: controls.partnersKy,
      kz: partnersKz
    }
  ];

  const spreaderSweepK = constants.spreaderSweepK ?? Math.min(1e9, spreaderEA / Math.max(1e-6, spreaderLengthM));
  springs.push({ name: "spreader_sweep_port", nodeIdA: tipPortId, nodeIdB: spreaderRootId, kx: 0, ky: spreaderSweepK, kz: spreaderSweepK });
  springs.push({ name: "spreader_sweep_stbd", nodeIdA: tipStbdId, nodeIdB: spreaderRootId, kx: 0, ky: spreaderSweepK, kz: spreaderSweepK });

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
