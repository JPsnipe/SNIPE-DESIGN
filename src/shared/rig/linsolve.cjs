function zeros(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = 0;
  return a;
}

function identity(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = zeros(n);
    a[i][i] = 1;
  }
  return a;
}

function matVec(A, x) {
  const n = A.length;
  const y = zeros(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = A[i];
    for (let j = 0; j < n; j++) s += row[j] * x[j];
    y[i] = s;
  }
  return y;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function add(a, b, scaleB = 1) {
  const out = zeros(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + scaleB * b[i];
  return out;
}

function normInf(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

function solveLinearSystem(Ain, bIn) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const b = bIn.slice();
  const piv = new Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;

  for (let k = 0; k < n; k++) {
    let maxRow = k;
    let maxVal = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }
    if (maxVal < 1e-18) {
      const err = new Error("Singular matrix in solveLinearSystem");
      err.code = "SINGULAR";
      throw err;
    }
    if (maxRow !== k) {
      const tmp = A[k];
      A[k] = A[maxRow];
      A[maxRow] = tmp;
      const tb = b[k];
      b[k] = b[maxRow];
      b[maxRow] = tb;
      const tp = piv[k];
      piv[k] = piv[maxRow];
      piv[maxRow] = tp;
    }

    const Akk = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const factor = A[i][k] / Akk;
      if (factor === 0) continue;
      A[i][k] = 0;
      for (let j = k + 1; j < n; j++) {
        A[i][j] -= factor * A[k][j];
      }
      b[i] -= factor * b[k];
    }
  }

  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

module.exports = {
  zeros,
  identity,
  matVec,
  dot,
  add,
  normInf,
  solveLinearSystem
};
