/**
 * Presets para Snipe según reglas SCIRA
 *
 * Geometría del mástil (medidas desde el pie):
 * - houndsZMm: Altura de la roldana de driza / forestay (4860-4962mm SCIRA)
 * - shroudAttachZMm: Altura de anclaje de obenques superiores
 *   (puede ser igual o ligeramente inferior a hounds, típicamente 0-100mm menos)
 *
 * Rigidez del mástil (stiffness):
 * - mastEIBase: Rigidez flexural sección constante inferior (N·m²)
 *   Típico Snipe (Selden C060, 6061-T6): ~7500 N·m² (E=70GPa, I≈10.7cm⁴)
 * - mastEITop: Rigidez en la punta cónica (reducción ~50%)
 * - taperStartZMm: Altura donde comienza la conicidad
 *   Según SCIRA: debe ser sobre la intersección de stays (~4500mm)
 *
 * Los TIROS en el mástil:
 * - Driza/Forestay: Tira desde houndsZ hacia proa (energiza la jarcia)
 * - Obenques: Tiran desde shroudAttachZ hacia los chainplates (soporte lateral)
 */

function getPresets() {
  return [
    {
      name: "Default (User Settings)",
      geometry: {
        mastLengthMm: 6500,
        partnersZMm: 395,
        spreaderZMm: 2500,
        houndsZMm: 4800,        // Altura driza/forestay
        shroudAttachZMm: 4980,  // Altura obenques
        tackZMm: 1387,
        chainplateXMm: 550,
        chainplateYMm: -363,
        bowYMm: 1511
      },
      controls: {
        spreaderLengthMm: 534,
        spreaderAngleDeg: 32.0,
        shroudBaseDeltaMm: 27,
        shroudDeltaPortMm: 1.0,
        shroudDeltaStbdMm: 1.0,
        jibHalyardTensionkN: 0,
        partnersKx_kNpm: 25,
        partnersKy_kNpm: 0,
        mainSheetMm: 0,
        mainOuthaulMm: 0,
        mainVangMm: 0,
        mainSheetLeadYM: -2500
      },
      load: {
        mode: "upwind",
        qLateralNpm: 45,
        qProfile: "triangular"
      },
      solver: {
        mastSegments: 100,
        pretensionSteps: 20,
        loadSteps: 20,
        maxIterations: 300,
        toleranceN: 0.5,
        cableCompressionEps: 1e-3
      },
      stiffness: {
        mastEIBase: 7500,
        mastEITop: 3500,
        taperStartZMm: 4500
      }
    },
    {
      name: "SCIRA Standard (Medium)",
      geometry: {
        mastLengthMm: 6500,
        partnersZMm: 395,
        spreaderZMm: 2500,
        houndsZMm: 4911,        // Altura driza/forestay
        shroudAttachZMm: 4860,  // Altura obenques
        tackZMm: 1387,          // Banda inferior SCIRA (Altura botavara)
        chainplateXMm: 550,
        chainplateYMm: -50,
        bowYMm: 1511
      },
      controls: {
        spreaderLengthMm: 410,
        spreaderAngleDeg: 22.0, // ~153mm flecha, ~760mm tip-to-tip
        shroudDeltaPortMm: 3.0,
        shroudDeltaStbdMm: 3.0,
        jibHalyardTensionkN: 1.5, // Tensión objetivo stay/driza
        partnersKx_kNpm: 30,
        partnersKy_kNpm: 30,
        mainSheetMm: 0,
        mainOuthaulMm: 0,
        mainVangMm: 0,
        mainSheetLeadYM: -2500
      },
      load: {
        mode: "upwind",
        qLateralNpm: 60,
        qProfile: "triangular"
      },
      solver: {
        mastSegments: 100,
        pretensionSteps: 20,
        loadSteps: 20,
        maxIterations: 300,
        toleranceN: 0.5,
        cableCompressionEps: 1e-3
      },
      // Rigidez típica Snipe (Selden C060, aluminio 6061-T6)
      stiffness: {
        mastEIBase: 7500,      // N·m² sección constante (E=70GPa, I≈10.7cm⁴)
        mastEITop: 3500,       // N·m² punta cónica (~50% reducción)
        taperStartZMm: 4500    // mm desde pie (sobre intersección stays SCIRA)
      }
    },
    {
      name: "SCIRA Light Wind",
      geometry: {
        mastLengthMm: 6500,
        partnersZMm: 395,
        spreaderZMm: 2500,
        houndsZMm: 4911,
        shroudAttachZMm: 4860,
        tackZMm: 1387,
        chainplateXMm: 550,
        chainplateYMm: -50,
        bowYMm: 1511
      },
      controls: {
        spreaderLengthMm: 415,
        spreaderAngleDeg: 19.7, // ~140mm flecha
        shroudDeltaPortMm: 1.0,
        shroudDeltaStbdMm: 1.0,
        jibHalyardTensionkN: 1.0,
        partnersKx_kNpm: 25,
        partnersKy_kNpm: 25,
        mainSheetMm: 0,
        mainOuthaulMm: 0,
        mainVangMm: 0,
        mainSheetLeadYM: -2500
      },
      load: {
        mode: "upwind",
        qLateralNpm: 45,
        qProfile: "triangular"
      },
      solver: {
        mastSegments: 100,
        pretensionSteps: 20,
        loadSteps: 20,
        maxIterations: 300,
        toleranceN: 0.5,
        cableCompressionEps: 1e-3
      },
      // Rigidez típica Snipe - palo más blando para viento ligero
      stiffness: {
        mastEIBase: 7000,      // N·m² sección constante (ligeramente más blando)
        mastEITop: 3200,       // N·m² punta cónica
        taperStartZMm: 4500    // mm desde pie
      }
    },
    {
      name: "SCIRA Heavy Wind",
      geometry: {
        mastLengthMm: 6500,
        partnersZMm: 395,
        spreaderZMm: 2500,
        houndsZMm: 4911,
        shroudAttachZMm: 4860,
        tackZMm: 1387,
        chainplateXMm: 550,
        chainplateYMm: -50,
        bowYMm: 1511
      },
      controls: {
        spreaderLengthMm: 435,
        spreaderAngleDeg: 21.6, // ~160mm flecha
        shroudDeltaPortMm: 5.0,
        shroudDeltaStbdMm: 5.0,
        jibHalyardTensionkN: 2.0,
        partnersKx_kNpm: 35,
        partnersKy_kNpm: 35,
        mainSheetMm: 0,
        mainOuthaulMm: 0,
        mainVangMm: 0,
        mainSheetLeadYM: -2500
      },
      load: {
        mode: "upwind",
        qLateralNpm: 75,
        qProfile: "triangular"
      },
      solver: {
        mastSegments: 100,
        pretensionSteps: 20,
        loadSteps: 20,
        maxIterations: 300,
        toleranceN: 0.5,
        cableCompressionEps: 1e-3
      },
      // Rigidez típica Snipe - palo más rígido para viento fuerte
      stiffness: {
        mastEIBase: 8000,      // N·m² sección constante (más rígido)
        mastEITop: 3800,       // N·m² punta cónica
        taperStartZMm: 4500    // mm desde pie
      }
    }
  ];
}

module.exports = { getPresets };
