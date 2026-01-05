const { zeros, normInf, dot, add, solveLinearSystem } = require("./linsolve.cjs");

function cloneMatrix(A) {
  return A.map((r) => r.slice());
}

function addDiagonal(A, lambda) {
  for (let i = 0; i < A.length; i++) A[i][i] += lambda;
  return A;
}

function finiteDifferenceJacobian({ x, g, valueAndGrad, fdEps }) {
  const n = x.length;
  const J = new Array(n);
  for (let i = 0; i < n; i++) J[i] = zeros(n);

  for (let j = 0; j < n; j++) {
    const base = x[j];
    const h = fdEps * (1 + Math.abs(base));
    x[j] = base + h;
    const gj = valueAndGrad(x).grad;
    x[j] = base;

    for (let i = 0; i < n; i++) {
      J[i][j] = (gj[i] - g[i]) / h;
    }
  }

  return J;
}

function newtonSolve({
  x0,
  valueAndGrad,
  maxIterations,
  gradInfTol,
  fdEps = 1e-6,
  lineSearchMax = 40,
  c1 = 1e-4
}) {
  let x = x0.slice();
  let vg = valueAndGrad(x);
  let f = vg.value;
  let g = vg.grad;

  for (let iter = 0; iter < maxIterations; iter++) {
    const gInf = normInf(g);
    if (gInf < gradInfTol) {
      return { x, converged: true, iterations: iter, value: f, gradInf: gInf };
    }

    const J = finiteDifferenceJacobian({ x, g, valueAndGrad, fdEps });

    let dx = null;
    let lambda = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const A = lambda > 0 ? addDiagonal(cloneMatrix(J), lambda) : cloneMatrix(J);
        const rhs = g.map((v) => -v);
        dx = solveLinearSystem(A, rhs);
        break;
      } catch (err) {
        if (err?.code !== "SINGULAR") throw err;
        lambda = lambda === 0 ? 1e-6 : lambda * 10;
      }
    }

    if (!dx) {
      return {
        x,
        converged: false,
        iterations: iter,
        value: f,
        gradInf: gInf,
        reason: "linear_solve_failed"
      };
    }

    let gTdx = dot(g, dx);
    if (!Number.isFinite(gTdx) || gTdx >= 0) {
      dx = g.map((v) => -v);
      gTdx = dot(g, dx);
    }

    let alpha = 1;
    let accepted = false;
    let xNew = null;
    let vgNew = null;

    for (let ls = 0; ls < lineSearchMax; ls++) {
      xNew = add(x, dx, alpha);
      vgNew = valueAndGrad(xNew);
      const fNew = vgNew.value;
      if (Number.isFinite(fNew) && fNew <= f + c1 * alpha * gTdx) {
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
        gradInf: gInf,
        reason: "line_search_failed"
      };
    }

    x = xNew;
    vg = vgNew;
    f = vg.value;
    g = vg.grad;
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

module.exports = { newtonSolve };
