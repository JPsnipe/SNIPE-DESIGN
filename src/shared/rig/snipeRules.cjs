function mmToM(mm) {
  return mm / 1000;
}

const SNIPE_RULES = {
  rig: {
    mastLengthMm: { min: 6480, max: 6500 },
    houndsZMm: { min: 4860, max: 4962 },
    partnersZMm: { min: 390, max: 400 },
    bowYMm: { min: 1498, max: 1524 },
    spreaderTipToTipMm: { min: 735, max: 773 },
    lowerBandZMm: 1387,
    upperBandZMm: 6499,

    // F.3.4 / C.9.* (SCIRA 2025-01-01)
    mainsailLuffMastDistanceMm: { max: 5112 },

    // F.4.2 (SCIRA 2025-01-01)
    boomOuterPointDistanceMm: { max: 2559 },
    boomTotalFromMastAftEdgeMm: { max: 2642 }
  },

  sails: {
    // G.3.2 (SCIRA 2025-01-01). "All dimensions are maximums unless otherwise noted."
    mainsail: {
      topWidthMm: 176,
      threeQuarterWidthMm: 1067,
      halfWidthMm: 1755,
      quarterWidthMm: 2238,
      leechLengthMm: 5334
    },

    // G.4.2 (SCIRA 2025-01-01)
    jib: {
      topWidthMm: 30,
      halfWidthMm: 1025,
      luffLengthMm: 3770,
      leechLengthMm: 3545,
      footLengthMm: 1956
    }
  }
};

const SNIPE_RULES_M = {
  rig: {
    mastLengthM: { min: mmToM(SNIPE_RULES.rig.mastLengthMm.min), max: mmToM(SNIPE_RULES.rig.mastLengthMm.max) },
    houndsZM: { min: mmToM(SNIPE_RULES.rig.houndsZMm.min), max: mmToM(SNIPE_RULES.rig.houndsZMm.max) },
    partnersZM: { min: mmToM(SNIPE_RULES.rig.partnersZMm.min), max: mmToM(SNIPE_RULES.rig.partnersZMm.max) },
    bowYM: { min: mmToM(SNIPE_RULES.rig.bowYMm.min), max: mmToM(SNIPE_RULES.rig.bowYMm.max) },
    spreaderTipToTipM: { min: mmToM(SNIPE_RULES.rig.spreaderTipToTipMm.min), max: mmToM(SNIPE_RULES.rig.spreaderTipToTipMm.max) },
    mainsailLuffMastDistanceM: { max: mmToM(SNIPE_RULES.rig.mainsailLuffMastDistanceMm.max) },
    boomOuterPointDistanceM: { max: mmToM(SNIPE_RULES.rig.boomOuterPointDistanceMm.max) },
    boomTotalFromMastAftEdgeM: { max: mmToM(SNIPE_RULES.rig.boomTotalFromMastAftEdgeMm.max) },
    lowerBandZM: mmToM(SNIPE_RULES.rig.lowerBandZMm),
    upperBandZM: mmToM(SNIPE_RULES.rig.upperBandZMm)
  },
  sails: {
    mainsail: {
      topWidthM: mmToM(SNIPE_RULES.sails.mainsail.topWidthMm),
      threeQuarterWidthM: mmToM(SNIPE_RULES.sails.mainsail.threeQuarterWidthMm),
      halfWidthM: mmToM(SNIPE_RULES.sails.mainsail.halfWidthMm),
      quarterWidthM: mmToM(SNIPE_RULES.sails.mainsail.quarterWidthMm),
      leechLengthM: mmToM(SNIPE_RULES.sails.mainsail.leechLengthMm)
    },
    jib: {
      topWidthM: mmToM(SNIPE_RULES.sails.jib.topWidthMm),
      halfWidthM: mmToM(SNIPE_RULES.sails.jib.halfWidthMm),
      luffLengthM: mmToM(SNIPE_RULES.sails.jib.luffLengthMm),
      leechLengthM: mmToM(SNIPE_RULES.sails.jib.leechLengthMm),
      footLengthM: mmToM(SNIPE_RULES.sails.jib.footLengthMm)
    }
  }
};

module.exports = { SNIPE_RULES, SNIPE_RULES_M, mmToM };

