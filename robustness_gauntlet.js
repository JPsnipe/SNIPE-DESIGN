/**
 * ROBUSTNESS GAUNTLET - Automated Stress Test Suite
 *
 * ANTIGRAVITY ASCENSION v1.0
 *
 * This script systematically tests the SnipeDesign solver across hundreds of
 * configurations to identify edge cases and verify numerical stability.
 *
 * TEST CATEGORIES:
 * 1. Preset Sweep - All built-in presets with default and extreme parameters
 * 2. Wind Load Sweep - 0% to 200% wind load for each preset
 * 3. Sail Pressure Sweep - 0 to 500 Pa in steps
 * 4. Geometry Perturbation - Random variations in critical dimensions
 * 5. Stiffness Extremes - Very soft to very stiff mast configurations
 *
 * TARGET: Zero NaN returns, zero crashes across 500+ configurations
 *
 * Usage: node robustness_gauntlet.js [--verbose] [--quick]
 */

const { runPhase1Simulation } = require("./src/shared/rig/runPhase1.cjs");
const { getPresets } = require("./src/shared/rig/presets.cjs");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Test intensity
  verbose: process.argv.includes("--verbose"),
  quick: process.argv.includes("--quick"),

  // Wind load sweep range (percentage of preset value)
  windLoadSweep: {
    min: 0,
    max: 200,
    step: 25  // 0, 25, 50, 75, 100, 125, 150, 175, 200
  },

  // Sail pressure sweep (Pa)
  sailPressureSweep: {
    min: 0,
    max: 500,
    step: 100  // 0, 100, 200, 300, 400, 500
  },

  // Geometry perturbation range (mm)
  geometryPerturbation: {
    houndsZ: [-200, 200],
    spreaderZ: [-300, 300],
    chainplateX: [-100, 100],
    spreaderLength: [-100, 100]
  },

  // Stiffness extremes
  stiffnessSweep: [
    { name: "Very Soft", mastEIBase: 3000, mastEITop: 1500 },
    { name: "Soft", mastEIBase: 5000, mastEITop: 2500 },
    { name: "Standard", mastEIBase: 7500, mastEITop: 3500 },
    { name: "Stiff", mastEIBase: 10000, mastEITop: 5000 },
    { name: "Very Stiff", mastEIBase: 15000, mastEITop: 7500 }
  ],

  // Solver timeout (ms)
  timeout: 60000
};

// ═══════════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

class TestResult {
  constructor(name, category) {
    this.name = name;
    this.category = category;
    this.passed = false;
    this.converged = false;
    this.iterations = 0;
    this.gradInf = Infinity;
    this.energy = NaN;
    this.error = null;
    this.duration = 0;
    this.warnings = [];
    this.diagnostics = null;
  }

  toString() {
    const status = this.passed ? "PASS" : "FAIL";
    const conv = this.converged ? "CONV" : "NCONV";
    return `[${status}] ${this.category}/${this.name}: ${conv}, iter=${this.iterations}, grad=${this.gradInf?.toExponential(2) ?? "N/A"}, ${this.duration}ms`;
  }
}

class GauntletRunner {
  constructor() {
    this.results = [];
    this.passed = 0;
    this.failed = 0;
    this.startTime = Date.now();
  }

  async runTest(name, category, payload) {
    const result = new TestResult(name, category);
    const start = Date.now();

    try {
      // Add timeout wrapper
      const simPromise = new Promise((resolve, reject) => {
        try {
          const simResult = runPhase1Simulation(payload);
          resolve(simResult);
        } catch (e) {
          reject(e);
        }
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timeout")), CONFIG.timeout);
      });

      const simResult = await Promise.race([simPromise, timeoutPromise]);

      result.duration = Date.now() - start;
      result.converged = simResult.converged ?? false;
      result.iterations = simResult.iterations ?? 0;
      result.gradInf = simResult.gradInf ?? Infinity;
      result.energy = simResult.energy ?? NaN;
      result.diagnostics = simResult.diagnostics ?? null;

      // Check for NaN or explosion
      const hasNaN = !Number.isFinite(result.energy) || !Number.isFinite(result.gradInf);
      const hasExplosion = result.gradInf > 1e12;

      if (hasNaN) {
        result.error = "NaN detected";
        result.passed = false;
      } else if (hasExplosion) {
        result.error = "Numerical explosion";
        result.passed = false;
      } else {
        result.passed = true;
      }

      // Check for warnings
      if (simResult.reason === "max_iter") {
        result.warnings.push("Did not converge within iteration limit");
      }
      if (simResult.diagnostics?.cappedCount > 0) {
        result.warnings.push(`${simResult.diagnostics.cappedCount} elements capped`);
      }

    } catch (e) {
      result.duration = Date.now() - start;
      result.error = e.message;
      result.passed = false;
    }

    this.results.push(result);
    if (result.passed) this.passed++;
    else this.failed++;

    if (CONFIG.verbose || !result.passed) {
      console.log(result.toString());
      if (result.error) console.log(`    Error: ${result.error}`);
      if (result.warnings.length > 0) console.log(`    Warnings: ${result.warnings.join(", ")}`);
    }

    return result;
  }

  printSummary() {
    const totalTime = Date.now() - this.startTime;
    const total = this.results.length;

    console.log("\n" + "═".repeat(70));
    console.log("ROBUSTNESS GAUNTLET - FINAL REPORT");
    console.log("═".repeat(70));

    console.log(`\nTotal tests: ${total}`);
    console.log(`Passed: ${this.passed} (${(this.passed / total * 100).toFixed(1)}%)`);
    console.log(`Failed: ${this.failed} (${(this.failed / total * 100).toFixed(1)}%)`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`Average time per test: ${(totalTime / total).toFixed(0)}ms`);

    if (this.failed > 0) {
      console.log("\n" + "─".repeat(70));
      console.log("FAILED TESTS:");
      console.log("─".repeat(70));
      for (const r of this.results.filter(r => !r.passed)) {
        console.log(`  ${r.category}/${r.name}: ${r.error}`);
      }
    }

    // Categorize results
    const byCategory = {};
    for (const r of this.results) {
      if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, failed: 0 };
      if (r.passed) byCategory[r.category].passed++;
      else byCategory[r.category].failed++;
    }

    console.log("\n" + "─".repeat(70));
    console.log("RESULTS BY CATEGORY:");
    console.log("─".repeat(70));
    for (const [cat, stats] of Object.entries(byCategory)) {
      const total = stats.passed + stats.failed;
      const pct = (stats.passed / total * 100).toFixed(0);
      const status = stats.failed === 0 ? "OK" : "ISSUES";
      console.log(`  ${cat.padEnd(30)} ${stats.passed}/${total} (${pct}%) [${status}]`);
    }

    console.log("\n" + "═".repeat(70));
    if (this.failed === 0) {
      console.log("GAUNTLET PASSED - All configurations stable");
    } else {
      console.log(`GAUNTLET FAILED - ${this.failed} configurations need attention`);
    }
    console.log("═".repeat(70) + "\n");

    return this.failed === 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════

function createBasePayload(preset) {
  return {
    geometry: {
      mastLengthM: preset.geometry.mastLengthMm / 1000,
      partnersZM: preset.geometry.partnersZMm / 1000,
      spreaderZM: preset.geometry.spreaderZMm / 1000,
      houndsZM: preset.geometry.houndsZMm / 1000,
      shroudAttachZM: (preset.geometry.shroudAttachZMm ?? preset.geometry.houndsZMm) / 1000,
      tackZM: preset.geometry.tackZMm / 1000,
      chainplateXM: preset.geometry.chainplateXMm / 1000,
      chainplateYM: preset.geometry.chainplateYMm / 1000,
      bowYM: preset.geometry.bowYMm / 1000
    },
    controls: {
      spreaderLengthM: preset.controls.spreaderLengthMm / 1000,
      spreaderAngleDeg: preset.controls.spreaderAngleDeg,
      spreaderSweepAftM: 0,
      shroudDeltaL0PortM: (preset.controls.shroudDeltaPortMm ?? 0) / 1000,
      shroudDeltaL0StbdM: (preset.controls.shroudDeltaStbdMm ?? 0) / 1000,
      jibHalyardTensionN: (preset.controls.jibHalyardTensionkN ?? 0) * 1000,
      partnersKx: (preset.controls.partnersKx_kNpm ?? 30) * 1000,
      partnersKy: (preset.controls.partnersKy_kNpm ?? 30) * 1000,
      partnersOffsetXM: (preset.controls.partnersOffsetXMm ?? 0) / 1000,
      partnersOffsetYM: (preset.controls.partnersOffsetYMm ?? 0) / 1000,
      lockStayLength: preset.controls.lockStayLength ?? true
    },
    load: {
      mode: preset.load.mode ?? "upwind",
      qLateralNpm: preset.load.qLateralNpm ?? 60,
      qProfile: preset.load.qProfile ?? "triangular"
    },
    solver: {
      mastSegments: preset.solver?.mastSegments ?? 40,
      cableSegments: preset.solver?.cableSegments ?? 1,
      pretensionSteps: preset.solver?.pretensionSteps ?? 10,
      loadSteps: preset.solver?.loadSteps ?? 10,
      maxIterations: preset.solver?.maxIterations ?? 100,
      toleranceN: preset.solver?.toleranceN ?? 1.0,
      drMaxIterations: preset.solver?.drMaxIterations ?? 1000
    },
    stiffness: {
      mastEIBase: preset.stiffness?.mastEIBase ?? 7500,
      mastEITop: preset.stiffness?.mastEITop ?? 3500,
      taperStartZM: (preset.stiffness?.taperStartZMm ?? 4500) / 1000
    },
    sails: {
      enabled: false
    }
  };
}

async function runPresetSweep(runner) {
  console.log("\n[1/5] PRESET SWEEP");
  console.log("─".repeat(50));

  const presets = getPresets();

  for (const preset of presets) {
    const payload = createBasePayload(preset);
    await runner.runTest(preset.name, "Preset Sweep", payload);
  }
}

async function runWindLoadSweep(runner) {
  console.log("\n[2/5] WIND LOAD SWEEP");
  console.log("─".repeat(50));

  const presets = getPresets();
  const sweep = CONFIG.windLoadSweep;
  const steps = CONFIG.quick ? [0, 100, 200] : range(sweep.min, sweep.max, sweep.step);

  for (const preset of presets) {
    const baseLoad = preset.load.qLateralNpm;

    for (const pct of steps) {
      const payload = createBasePayload(preset);
      payload.load.qLateralNpm = baseLoad * (pct / 100);

      await runner.runTest(
        `${preset.name} @ ${pct}%`,
        "Wind Load Sweep",
        payload
      );
    }
  }
}

async function runSailPressureSweep(runner) {
  console.log("\n[3/5] SAIL PRESSURE SWEEP");
  console.log("─".repeat(50));

  const presets = getPresets().slice(0, CONFIG.quick ? 1 : 2); // Limit for speed
  const sweep = CONFIG.sailPressureSweep;
  const steps = CONFIG.quick ? [0, 200, 500] : range(sweep.min, sweep.max, sweep.step);

  for (const preset of presets) {
    for (const pressure of steps) {
      const payload = createBasePayload(preset);
      payload.sails = {
        enabled: pressure > 0,
        mainSail: {
          enabled: pressure > 0,
          gridRows: 6,
          gridCols: 4,
          pressure: pressure
        },
        jibSail: {
          enabled: pressure > 0,
          gridRows: 5,
          gridCols: 3,
          pressure: pressure
        }
      };

      await runner.runTest(
        `${preset.name} + Sails @ ${pressure}Pa`,
        "Sail Pressure Sweep",
        payload
      );
    }
  }
}

async function runGeometryPerturbation(runner) {
  console.log("\n[4/5] GEOMETRY PERTURBATION");
  console.log("─".repeat(50));

  const basePreset = getPresets()[1]; // SCIRA Standard
  const perturbations = [
    { name: "High Hounds", delta: { houndsZMm: 200 } },
    { name: "Low Hounds", delta: { houndsZMm: -200 } },
    { name: "High Spreader", delta: { spreaderZMm: 300 } },
    { name: "Low Spreader", delta: { spreaderZMm: -300 } },
    { name: "Wide Chainplates", delta: { chainplateXMm: 100 } },
    { name: "Narrow Chainplates", delta: { chainplateXMm: -100 } },
    { name: "Long Spreaders", delta: { spreaderLengthMm: 100 } },
    { name: "Short Spreaders", delta: { spreaderLengthMm: -100 } },
    { name: "Combined Extreme High", delta: { houndsZMm: 200, spreaderZMm: 300, spreaderLengthMm: 100 } },
    { name: "Combined Extreme Low", delta: { houndsZMm: -200, spreaderZMm: -300, spreaderLengthMm: -100 } }
  ];

  for (const perturb of perturbations) {
    const preset = JSON.parse(JSON.stringify(basePreset));

    for (const [key, value] of Object.entries(perturb.delta)) {
      if (key in preset.geometry) {
        preset.geometry[key] += value;
      } else if (key in preset.controls) {
        preset.controls[key] += value;
      } else if (key === "spreaderLengthMm") {
        preset.controls.spreaderLengthMm += value;
      }
    }

    const payload = createBasePayload(preset);
    await runner.runTest(perturb.name, "Geometry Perturbation", payload);
  }
}

async function runStiffnessSweep(runner) {
  console.log("\n[5/5] STIFFNESS SWEEP");
  console.log("─".repeat(50));

  const basePreset = getPresets()[1]; // SCIRA Standard
  const windLoads = CONFIG.quick ? [60] : [30, 60, 90];

  for (const stiffness of CONFIG.stiffnessSweep) {
    for (const windLoad of windLoads) {
      const preset = JSON.parse(JSON.stringify(basePreset));
      preset.stiffness.mastEIBase = stiffness.mastEIBase;
      preset.stiffness.mastEITop = stiffness.mastEITop;
      preset.load.qLateralNpm = windLoad;

      const payload = createBasePayload(preset);
      await runner.runTest(
        `${stiffness.name} @ ${windLoad}N/m`,
        "Stiffness Sweep",
        payload
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function range(min, max, step) {
  const result = [];
  for (let v = min; v <= max; v += step) {
    result.push(v);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("ROBUSTNESS GAUNTLET - SnipeDesign Solver Stress Test");
  console.log("ANTIGRAVITY ASCENSION v1.0");
  console.log("═".repeat(70));

  if (CONFIG.quick) {
    console.log("\n[QUICK MODE] Running reduced test set");
  }

  const runner = new GauntletRunner();

  await runPresetSweep(runner);
  await runWindLoadSweep(runner);
  await runSailPressureSweep(runner);
  await runGeometryPerturbation(runner);
  await runStiffnessSweep(runner);

  const success = runner.printSummary();
  process.exit(success ? 0 : 1);
}

main().catch(e => {
  console.error("Gauntlet crashed:", e);
  process.exit(1);
});
