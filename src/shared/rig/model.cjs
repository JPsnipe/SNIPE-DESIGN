const { clamp, sub3, norm3 } = require("./math3.cjs");

function buildPhase1Model({
  geometry,
  controls,
  solver,
  state,
  constants
}) {
  const {
    mastLengthM,
    partnersZM,
    spreaderZM,
    chainplateXM,
    chainplateYM,
    bowYM
  } = geometry;

  const nSeg = solver.mastSegments;

  const mastEA = constants.mastEA;
  const mastEI = constants.mastEI;
  const spreaderEA = constants.spreaderEA;
  const rigEA = constants.rigEA;

  const nodes = [];
  const addNode = (name, p0, fixed) => {
    const id = nodes.length;
    nodes.push({ id, name, p0, fixed: Boolean(fixed) });
    return id;
  };

  const stepId = addNode("mast_step", [0, 0, 0], true);

  const mastNodeIds = [stepId];
  for (let i = 1; i <= nSeg; i++) {
    const z = (mastLengthM * i) / nSeg;
    mastNodeIds.push(addNode(`mast_${i}`, [0, 0, z], false));
  }
  const mastHeadId = mastNodeIds[mastNodeIds.length - 1];

  const spreaderIndex = clamp(
    Math.round((spreaderZM / mastLengthM) * nSeg),
    1,
    nSeg - 1
  );
  const spreaderRootId = mastNodeIds[spreaderIndex];

  const partnersIndex = clamp(
    Math.round((partnersZM / mastLengthM) * nSeg),
    1,
    nSeg - 1
  );
  const partnersNodeId = mastNodeIds[partnersIndex];

  const spreaderLengthM = controls.spreaderLengthM;
  const spreaderSweepAftM = controls.spreaderSweepAftM;
  const ySweep = -spreaderSweepAftM;
  const xOut = Math.sqrt(Math.max(0, spreaderLengthM ** 2 - ySweep ** 2));

  const tipPortId = addNode("spreader_tip_port", [xOut, ySweep, nodes[spreaderRootId].p0[2]], false);
  const tipStbdId = addNode("spreader_tip_stbd", [-xOut, ySweep, nodes[spreaderRootId].p0[2]], false);

  const chainPortId = addNode("chainplate_port", [chainplateXM, chainplateYM, 0], true);
  const chainStbdId = addNode("chainplate_stbd", [-chainplateXM, chainplateYM, 0], true);
  const bowId = addNode("bow_fitting", [0, bowYM, 0], true);

  const axialBars = [];
  const addAxial = (name, i, j, EA, L0, kind) => {
    axialBars.push({ name, i, j, EA, L0, kind });
  };

  for (let i = 0; i < mastNodeIds.length - 1; i++) {
    const a = mastNodeIds[i];
    const b = mastNodeIds[i + 1];
    const L0 = norm3(sub3(nodes[b].p0, nodes[a].p0));
    addAxial(`mast_seg_${i}`, a, b, mastEA, L0, "bar");
  }

  addAxial("spreader_port", spreaderRootId, tipPortId, spreaderEA, spreaderLengthM, "bar");
  addAxial("spreader_stbd", spreaderRootId, tipStbdId, spreaderEA, spreaderLengthM, "bar");

  const bendHinges = [];
  for (let i = 1; i < mastNodeIds.length - 1; i++) {
    const a = mastNodeIds[i - 1];
    const b = mastNodeIds[i];
    const c = mastNodeIds[i + 1];
    const ds = axialBars[i - 1].L0;
    bendHinges.push({ name: `mast_bend_${i}`, a, b, c, EI: mastEI, ds });
  }

  const scaleShroud = (deltaTotalM, side) => {
    const tipId = side === "port" ? tipPortId : tipStbdId;
    const chainId = side === "port" ? chainPortId : chainStbdId;

    const LUpper = norm3(sub3(nodes[tipId].p0, nodes[mastHeadId].p0));
    const LLower = norm3(sub3(nodes[chainId].p0, nodes[tipId].p0));
    const total = LUpper + LLower;
    const target = total + deltaTotalM;
    const s = target / total;
    return { L0Upper: LUpper * s, L0Lower: LLower * s };
  };

  const shroudDeltaPort = state.standingScale * controls.shroudDeltaL0PortM;
  const shroudDeltaStbd = state.standingScale * controls.shroudDeltaL0StbdM;

  const shroudPort = scaleShroud(shroudDeltaPort, "port");
  const shroudStbd = scaleShroud(shroudDeltaStbd, "stbd");

  addAxial("shroud_port_upper", mastHeadId, tipPortId, rigEA, shroudPort.L0Upper, "cable");
  addAxial("shroud_port_lower", tipPortId, chainPortId, rigEA, shroudPort.L0Lower, "cable");
  addAxial("shroud_stbd_upper", mastHeadId, tipStbdId, rigEA, shroudStbd.L0Upper, "cable");
  addAxial("shroud_stbd_lower", tipStbdId, chainStbdId, rigEA, shroudStbd.L0Lower, "cable");

  // Forestay: longitud geométrica real
  const forestayBaseDelta = state.standingScale * controls.forestayBaseDeltaL0M;
  const forestayLBase = norm3(sub3(nodes[bowId].p0, nodes[mastHeadId].p0));
  const forestayL0 = forestayLBase + forestayBaseDelta;
  addAxial("forestay", mastHeadId, bowId, rigEA, forestayL0, "cable");

  const springs = [
    {
      name: "partners_spring",
      nodeId: partnersNodeId,
      kx: controls.partnersKx,
      ky: controls.partnersKy,
      kz: 0
    }
  ];

  const forces = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) forces[i] = [0, 0, 0];

  /**
   * JIB HALYARD - Física de energización de la jarcia
   *
   * La driza aplica una fuerza en el masthead (donde se une el forestay en este modelo)
   * en la dirección del grátil del foque.
   */
  const halyardTensionN =
    Number.isFinite(controls.jibHalyardTensionN)
      ? controls.jibHalyardTensionN
      : Number.isFinite(controls.jibHalyardDeltaL0M)
        ? (rigEA / forestayLBase) * controls.jibHalyardDeltaL0M
        : 0;
  const halyardForce = Math.max(0, (state.halyardScale || 0) * halyardTensionN);
  if (halyardForce > 1e-9) {

    const mastHeadPos = nodes[mastHeadId].p0;
    const bowPos = nodes[bowId].p0;
    const luffVec = sub3(bowPos, mastHeadPos);
    const luffLength = norm3(luffVec);

    if (luffLength > 1e-9) {
      const Fx = halyardForce * (luffVec[0] / luffLength);
      const Fy = halyardForce * (luffVec[1] / luffLength);
      const Fz = halyardForce * (luffVec[2] / luffLength);
      forces[mastHeadId] = [Fx, Fy, Fz];
    }
  }

  // Cargas de viento laterales
  const ds = mastLengthM / nSeg;
  for (let i = 1; i < mastNodeIds.length; i++) {
    const nodeId = mastNodeIds[i];
    const z = nodes[nodeId].p0[2];
    let q = 0;
    if (state.loadScale > 0 && state.load.mode !== "none") {
      const base =
        state.load.mode === "downwind"
          ? 0.3 * state.load.qLateralNpm
          : state.load.qLateralNpm;
      const profile = state.load.qProfile;
      const shape = profile === "triangular" ? z / mastLengthM : 1;
      q = base * shape;
    }
    const fx = state.loadScale * q * ds;
    forces[nodeId] = [forces[nodeId][0] + fx, forces[nodeId][1], forces[nodeId][2]];
  }

  return {
    nodes,
    mastNodeIds,
    mastHeadId,
    tipPortId,
    tipStbdId,
    chainPortId,
    chainStbdId,
    bowId,
    axialBars,
    bendHinges,
    springs,
    forces,
    constants
  };
}

module.exports = { buildPhase1Model };
