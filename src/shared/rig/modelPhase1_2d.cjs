const { clamp, sub3, norm3 } = require("./math3.cjs");

/**
 * Física del Jib Halyard en un Snipe:
 *
 * La driza del foque es el mecanismo principal de energización de la jarcia.
 * Funciona así:
 *
 * 1. La driza pasa por una roldana en los hounds y se conecta al puño de driza del foque
 * 2. El tack del foque está fijo en el bow fitting
 * 3. Cuando tensas la driza, creas una fuerza en los hounds que:
 *    - Tira hacia adelante (hacia el bow) - energiza el forestay
 *    - Comprime el mástil axialmente
 *
 * El ángulo del grátil (luff) determina cómo se descompone la tensión:
 *    θ = atan(bowY / houndsZ)
 *    F_forward = T * sin(θ) = T * bowY / sqrt(bowY² + houndsZ²)
 *    F_down = T * cos(θ) = T * houndsZ / sqrt(bowY² + houndsZ²)
 *
 * En el modelo 2D (solo X-Y como DOFs), aplicamos la componente Y (hacia proa).
 */

/**
 * Puntos de anclaje en el mástil (de abajo hacia arriba):
 *
 *   MASTHEAD ─────────────── Tope del mástil
 *       │
 *   HOUNDS (forestayZM) ──── Donde sale la driza y conecta el forestay
 *       │                    Típicamente 4860-4962mm desde el pie
 *       │
 *   SHROUD ATTACH ────────── Donde conectan los obenques superiores
 *   (shroudAttachZM)         Puede ser igual o ligeramente inferior a hounds
 *       │
 *   SPREADERS ────────────── Crucetas que desvían los obenques
 *       │
 *   PARTNERS ─────────────── Donde el mástil atraviesa la cubierta
 *       │
 *   MAST STEP ────────────── Pie del mástil (z=0)
 *
 * Los TIROS importantes:
 * - Forestay/Driza: Tira desde hounds hacia el bow (proa)
 * - Shrouds: Tiran desde shroudAttach hacia los chainplates (banda)
 * - Spreaders: Desvían los shrouds creando soporte lateral
 */

function buildPhase1Model2d({ geometry, controls, solver, state, constants }) {
  const {
    mastLengthM,
    partnersZM,
    spreaderZM,
    houndsZM,          // Altura de driza/forestay (roldana de driza)
    shroudAttachZM,    // Altura de anclaje de obenques superiores (puede ser diferente)
    chainplateXM,
    chainplateYM,
    bowYM
  } = geometry;

  // Si no se especifica shroudAttachZM, usar houndsZM (comportamiento legacy)
  const effectiveShroudAttachZM = shroudAttachZM ?? houndsZM;

  const nSeg = solver.mastSegments;
  const ds = mastLengthM / nSeg;

  // EI variable con altura (conicidad)
  const mastEIBase = constants.mastEIBase || constants.mastEI || 2000;
  const mastEITop = constants.mastEITop || mastEIBase * 0.4;  // Por defecto 40% del base
  const taperStartZM = constants.taperStartZM || 4.5;

  // Función que devuelve EI a una altura z dada
  function getEIAtZ(z) {
    if (z <= taperStartZM) {
      return mastEIBase;  // Sección constante desde el pie hasta taperStart
    }
    // Interpolación lineal desde taperStartZM hasta el tope
    const t = (z - taperStartZM) / (mastLengthM - taperStartZM);
    return mastEIBase + t * (mastEITop - mastEIBase);
  }

  const mastEA = constants.mastEA;
  const spreaderEA = constants.spreaderEA;
  const rigEA = constants.rigEA;
  const rigSmoothDeltaM = constants.rigSmoothDeltaM ?? 1e-6;

  const nodes = [];
  const addNode = (name, p0, fixed) => {
    const id = nodes.length;
    nodes.push({ id, name, p0, fixed: Boolean(fixed) });
    return id;
  };

  const stepId = addNode("mast_step", [0, 0, 0], true);

  const mastNodeIds = [stepId];
  for (let i = 1; i <= nSeg; i++) {
    const z = ds * i;
    mastNodeIds.push(addNode(`mast_${i}`, [0, 0, z], false));
  }
  const mastHeadId = mastNodeIds[mastNodeIds.length - 1];

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

  // Nodo para el forestay/driza (hounds)
  const houndsIndex = clamp(
    Math.round((houndsZM / mastLengthM) * nSeg),
    1,
    nSeg
  );
  const houndsNodeId = mastNodeIds[houndsIndex];

  // Nodo para los obenques superiores (puede ser diferente de hounds)
  const shroudAttachIndex = clamp(
    Math.round((effectiveShroudAttachZM / mastLengthM) * nSeg),
    1,
    nSeg
  );
  const shroudAttachNodeId = mastNodeIds[shroudAttachIndex];

  const spreaderLengthM = controls.spreaderLengthM;
  const spreaderSweepAftM = controls.spreaderSweepAftM;
  const ySweep = -spreaderSweepAftM;
  const xOut = Math.sqrt(Math.max(0, spreaderLengthM ** 2 - ySweep ** 2));

  const tipPortId = addNode(
    "spreader_tip_port",
    [xOut, ySweep, spreaderRootZ],
    false
  );
  const tipStbdId = addNode(
    "spreader_tip_stbd",
    [-xOut, ySweep, spreaderRootZ],
    false
  );

  const chainPortId = addNode("chainplate_port", [chainplateXM, chainplateYM, 0], true);
  const chainStbdId = addNode("chainplate_stbd", [-chainplateXM, chainplateYM, 0], true);
  const bowId = addNode("bow_fitting", [0, bowYM, 0], true);

  const axial = [];
  const addAxial = (e) => {
    axial.push(e);
  };

  // Mástil: segmentos axiales (resiste elongación por desplazamientos laterales)
  for (let i = 0; i < mastNodeIds.length - 1; i++) {
    const a = mastNodeIds[i];
    const b = mastNodeIds[i + 1];
    const L0 = norm3(sub3(nodes[b].p0, nodes[a].p0));
    addAxial({ name: `mast_seg_${i}`, i: a, j: b, EA: mastEA, L0, kind: "bar" });
  }

  addAxial({ name: "spreader_port", i: spreaderRootId, j: tipPortId, EA: spreaderEA, L0: spreaderLengthM, kind: "bar" });
  addAxial({ name: "spreader_stbd", i: spreaderRootId, j: tipStbdId, EA: spreaderEA, L0: spreaderLengthM, kind: "bar" });

  // Bloquear la rotación de las crucetas mediante TRIANGULACIÓN
  // Conectamos un nodo adyacente del mástil (el anterior a la raíz) con el tip
  // Esto crea un triángulo rígido [spreaderRoot, prevNode, tip] que bloquea el giro.
  // La triangulaciA3n (prevNode->tip) no bloquea el sweep en este modelo;
  // el bloqueo de orientaciA3n se hace con springs relativos (ver secciA3n de springs).

  // Bloquear la orientación (sweep) de las crucetas con un triángulo rígido
  // (el modelo 2D no tiene momentos en la unión, así que un solo bar deja la cruceta libre de girar).
  /**
   * SHROUDS (Obenques)
   *
   * Los obenques conectan desde shroudAttachNodeId (no necesariamente hounds)
   * pasando por los spreader tips hasta los chainplates.
   *
   * El TIRO de los shrouds:
   * - Componente lateral (X): Soporta el mástil contra la escora
   * - Componente longitudinal (Y): Pequeña, hacia popa por el sweep del spreader
   * - Componente vertical (Z): Compresión axial del mástil
   *
   * FÍSICA DEL EFECTO "ARCO":
   * - L0 se calcula usando la distancia STRAIGHT-LINE (shroudAttach → chainplate)
   * - Esto es independiente de la longitud de las crucetas
   * - Crucetas más largas = camino más largo para un cable de L0 fija = más tensión
   * - Más tensión = más compresión en crucetas = empuje hacia proa en el mástil
   */
  const computeShroudL0Total = (deltaTotalM, baseDeltaM, side) => {
    const tipId = side === "port" ? tipPortId : tipStbdId;
    const chainId = side === "port" ? chainPortId : chainStbdId;

    // Longitud actual del camino geométrico (con crucetas en su posición neutral)
    const LUpper = norm3(sub3(nodes[tipId].p0, nodes[shroudAttachNodeId].p0));
    const LLower = norm3(sub3(nodes[chainId].p0, nodes[tipId].p0));
    const L_path = LUpper + LLower;

    // L0 reference: Ahora usamos el camino geométrico real (L_path) como referencia 0.
    // Esto evita la pre-tensión masiva que ocurría al usar la distancia recta (sin crucetas).
    // baseDeltaM = Pletinas (Mast Rake)
    // deltaTotalM = Ajuste dinámico por calibración/carga
    const L0_total = L_path - (baseDeltaM + deltaTotalM);

    // Distribuir L0 proporcionalmente según la geometría del path actual
    return L0_total;
  };

  const standingScale = Number.isFinite(state?.standingScale) ? state.standingScale : 1;
  const shroudBaseDelta = standingScale * (controls.shroudBaseDeltaM || 0);
  const shroudDeltaPort = standingScale * (controls.shroudDeltaL0PortM || 0);
  const shroudDeltaStbd = standingScale * (controls.shroudDeltaL0StbdM || 0);

  const shroudPortL0 = computeShroudL0Total(shroudDeltaPort, shroudBaseDelta, "port");
  const shroudStbdL0 = computeShroudL0Total(shroudDeltaStbd, shroudBaseDelta, "stbd");

  // Shrouds: cable continuo pasando por el tip de la cruceta (tensión única en ambos tramos)
  addAxial({ name: "shroud_port", i: shroudAttachNodeId, k: tipPortId, j: chainPortId, EA: rigEA, L0: shroudPortL0, smoothDeltaM: rigSmoothDeltaM, kind: "cable_path" });
  addAxial({ name: "shroud_stbd", i: shroudAttachNodeId, k: tipStbdId, j: chainStbdId, EA: rigEA, L0: shroudStbdL0, smoothDeltaM: rigSmoothDeltaM, kind: "cable_path" });

  // Tensión Stay/Driza: control por fuerza (N) en vez de por ΔL0
  addAxial({
    name: "stay_jib",
    i: houndsNodeId,
    j: bowId,
    N: Math.max(0, (state.halyardScale || 0) * (controls.jibHalyardTensionN || 0)),
    kind: "tension"
  });

  const spreaderSweepKy = constants.spreaderSweepKy ?? Math.min(
    1e9,
    spreaderEA / Math.max(1e-6, spreaderLengthM)
  );

  const springs = [
    {
      name: "partners_spring",
      nodeId: partnersNodeId,
      kx: controls.partnersKx,
      ky: controls.partnersKy
    },
    {
      name: "spreader_sweep_port",
      nodeIdA: tipPortId,
      nodeIdB: spreaderRootId,
      kx: 0,
      ky: spreaderSweepKy
    },
    {
      name: "spreader_sweep_stbd",
      nodeIdA: tipStbdId,
      nodeIdB: spreaderRootId,
      kx: 0,
      ky: spreaderSweepKy
    }
  ];

  const forces = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) forces[i] = [0, 0];

  // Cargas de viento laterales sobre el mástil
  for (let i = 1; i < mastNodeIds.length; i++) {
    const nodeId = mastNodeIds[i];
    const z = nodes[nodeId].p0[2];
    let q = 0;
    if (state.loadScale > 0 && state.load.mode !== "none") {
      const base =
        state.load.mode === "downwind"
          ? 0.3 * state.load.qLateralNpm
          : state.load.qLateralNpm;
      const shape = state.load.qProfile === "triangular" ? z / mastLengthM : 1;
      q = base * shape;
    }
    const fx = state.loadScale * q * ds;
    // Sumar a fuerzas existentes (puede haber fuerza de halyard si este nodo es hounds)
    forces[nodeId] = [forces[nodeId][0] + fx, forces[nodeId][1]];
  }

  return {
    nodes,
    mastNodeIds,
    mastHeadId,
    partnersNodeId,
    tipPortId,
    tipStbdId,
    axial,
    springs,
    forces,
    beam: { getEIAtZ, ds, mastLengthM }
  };
}

module.exports = { buildPhase1Model2d };
