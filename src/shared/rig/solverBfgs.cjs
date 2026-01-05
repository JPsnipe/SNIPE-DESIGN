const { zeros, identity, dot, add, normInf, matVec } = require("./linsolve.cjs");

function bfgsMinimize({
  x0,
  valueAndGrad,
  maxIterations,
  gradInfTol,
  c1 = 1e-4,
  lineSearchMax = 60
}) {
  let x = x0.slice();
  let { value: f, grad: g } = valueAndGrad(x);
  let H = identity(x.length);

  const gInf0 = normInf(g);
  if (gInf0 < gradInfTol) {
    return { x, converged: true, iterations: 0, value: f, gradInf: gInf0 };
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    const Hg = matVec(H, g);
    const p = Hg.map((v) => -v);
    const gTp = dot(g, p);

    if (!Number.isFinite(gTp) || gTp >= 0) {
      H = identity(x.length);
    }

    let alpha = 1;
    let accepted = false;
    let xNew = null;
    let fNew = null;
    let gNew = null;

    for (let ls = 0; ls < lineSearchMax; ls++) {
      xNew = add(x, p, alpha);
      const vg = valueAndGrad(xNew);
      fNew = vg.value;
      gNew = vg.grad;

      if (Number.isFinite(fNew) && fNew <= f + c1 * alpha * gTp) {
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }

    if (!accepted) {
      return {
        x,
        converged: false,
        iterations: iter,
        value: f,
        gradInf: normInf(g),
        reason: "line_search_failed"
      };
    }

    const s = xNew.map((v, i) => v - x[i]);
    const y = gNew.map((v, i) => v - g[i]);
    const ys = dot(y, s);

    x = xNew;
    f = fNew;
    g = gNew;

    const gInf = normInf(g);
    if (gInf < gradInfTol) {
      return { x, converged: true, iterations: iter + 1, value: f, gradInf: gInf };
    }

    if (!Number.isFinite(ys) || ys <= 1e-12) {
      H = identity(x.length);
      continue;
    }

    const rho = 1 / ys;
    const Hy = matVec(H, y);
    const yHy = dot(y, Hy);
    const coeffSS = rho * (1 + rho * yHy);

    const n = x.length;
    const Hnew = new Array(n);
    for (let i = 0; i < n; i++) {
      Hnew[i] = zeros(n);
      for (let j = 0; j < n; j++) {
        const termSS = coeffSS * s[i] * s[j];
        const termSy = rho * (s[i] * Hy[j] + Hy[i] * s[j]);
        Hnew[i][j] = H[i][j] + termSS - termSy;
      }
    }
    H = Hnew;
  }

  return {
    x,
    converged: false,
    iterations: maxIterations,
    value: f,
    gradInf: normInf(g),
    reason: "max_iterations"
  };
}

module.exports = { bfgsMinimize };
