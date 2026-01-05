function resultsToCsv(results) {
  if (!results || !results.outputs) return "invalid_results\n";

  const lines = [];
  lines.push("section,key,value,units");
  lines.push(`summary,converged,${results.converged},`);
  lines.push(`summary,iterations,${results.iterations},`);
  lines.push(`summary,gradInf,${results.gradInf},N`);

  const t = results.outputs.tensions;
  lines.push(`tension,shroud_port,${t.shroudPortN},N`);
  lines.push(`tension,shroud_stbd,${t.shroudStbdN},N`);
  lines.push(`tension,forestay,${t.forestayN},N`);

  const s = results.outputs.spreaders;
  lines.push(`spreader,port_axial,${s.portAxialN},N`);
  lines.push(`spreader,stbd_axial,${s.stbdAxialN},N`);

  lines.push("");
  lines.push("z_m,x_prebend_m,y_prebend_m,x_loaded_m,y_loaded_m");
  const pre = results.outputs.mastCurvePrebend;
  const load = results.outputs.mastCurveLoaded;
  const n = Math.max(pre.length, load.length);
  for (let i = 0; i < n; i++) {
    const a = pre[i] ?? { z: "", x: "", y: "" };
    const b = load[i] ?? { z: a.z ?? "", x: "", y: "" };
    lines.push(`${a.z},${a.x},${a.y},${b.x},${b.y}`);
  }

  return lines.join("\n");
}

module.exports = { resultsToCsv };
