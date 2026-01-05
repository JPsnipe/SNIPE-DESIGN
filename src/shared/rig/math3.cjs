function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm3(a) {
  return Math.sqrt(dot3(a, a));
}

function normalize3(a) {
  const n = norm3(a);
  if (n < 1e-15) return { v: [0, 0, 0], n: 0 };
  return { v: [a[0] / n, a[1] / n, a[2] / n], n };
}

function outer3(a, b) {
  return [
    [a[0] * b[0], a[0] * b[1], a[0] * b[2]],
    [a[1] * b[0], a[1] * b[1], a[1] * b[2]],
    [a[2] * b[0], a[2] * b[1], a[2] * b[2]]
  ];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function skew3(v) {
  return [
    [0, -v[2], v[1]],
    [v[2], 0, -v[0]],
    [-v[1], v[0], 0]
  ];
}

module.exports = {
  clamp,
  add3,
  sub3,
  scale3,
  dot3,
  norm3,
  normalize3,
  outer3,
  cross3,
  skew3
};

