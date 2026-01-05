# Phase 1 — Snipe rig simulator (jarcia + palo) — Especificación técnica

## 0) Objetivo (MVP útil)

Resolver el equilibrio estático (no lineal por geometría + tensión‑solo) del sistema:

- Mástil (beam Euler–Bernoulli discretizado)
- Crucetas/spreaders (bars)
- Jarcia fija: obenques + estay (cables/truss **tension‑only**)
- Restricciones simplificadas: mast step + partners (muelles laterales)
- Pretensión por ajuste de longitudes efectivas (L0) y control de tensión de driza/estay (kN)
- Cargas equivalentes de navegación (perfil q(z) lateral, upwind/downwind)

Entregables físicos:

- Curva de prebend (x(z), y(z)) y curva bajo carga
- Tensiones en estay y obenques
- Compresión/tensión axial en crucetas
- Diagnóstico numérico: convergencia, cables slack, stepping usado

## 1) Arquitectura software (Electron)

**Procesos**

- `src/main/main.cjs`: ventana + IPC + export a JSON/CSV
- `src/preload/preload.cjs`: API segura hacia renderer (`contextIsolation`)
- `src/renderer/*`: UI/UX (panel tuning + plots)

**Núcleo físico‑numérico**

- `src/shared/rig/runPhase1.cjs`: orquestación fase 1 (stepping + outputs)
- `src/shared/rig/modelPhase1_2d.cjs`: construcción de geometría + elementos (a partir de “controls”)
- `src/shared/rig/solverPhase1_2d.cjs`: ensamblado (energía+residuo+rigidez) y solver Newton con line search
- `src/shared/rig/presets.cjs`: presets para evaluar tendencias y estabilidad
- `tests/phase1-solver.test.cjs`: validación automática (unit/regresión)

**Flujo de datos**

UI → payload JSON (inputs) → IPC → `runPhase1Simulation()` → resultados JSON → UI (plots/tabla) + export.

## 2) Modelo físico (Phase 1)

### 2.1 Sistema de coordenadas

- `z`: arriba desde el mast step
- `x`: lateral babor‑estribor
- `y`: proa‑popa (positivo hacia proa)

### 2.2 Mástil (beam)

- Discretización en `N` segmentos, nodos a lo largo de `z`.
- DOFs de la fase 1 actual: desplazamiento lateral `x(z)` y fore/aft `y(z)` (el `z` del nodo se mantiene en su altura de referencia).
- Energía de flexión tipo Euler–Bernoulli por diferencias finitas (curvatura discreta):
  - Para cada nodo interior `i`: `d2x = x(i-1) - 2x(i) + x(i+1)` y análogo para `y`.
  - Energía: `0.5 * (EI / ds^3) * (d2x^2 + d2y^2)`

Notas:

- Esta fase no resuelve acortamiento axial del palo; la no linealidad principal viene de la jarcia (direcciones) y de la activación tensión‑solo.
- EI es constante en el MVP, pero la interfaz queda lista para EI(z) por segmentos.

### 2.3 Spreaders (bars)

- Cada cruceta se modela como un bar entre:
  - Nodo raíz en el mástil (altura `z_spreader`)
  - Nodo “tip” (posición definida por longitud + sweep hacia popa)
- Salida: fuerza axial (compresión típica).

### 2.4 Jarcia fija (cables tension‑only)

- Obenques por banda, modelados como 2 tramos: `masthead ↔ tip ↔ chainplate`.
- Estay: `masthead ↔ bow fitting`.
- Ley axial:
  - `N = (EA/L0) * (L - L0)` en tracción
  - En compresión: `N` se reduce con `ε` (`cableCompressionEps`) para evitar singularidades numéricas.
- Pretensión por control de `L0` (longitud de referencia/rest‑length), que es equivalente al ajuste real de pin/turnbuckle.

### 2.5 Restricciones y apoyos

- `mast_step`: nodo fijo.
- `partners`: muelles laterales en el nodo a altura `z_partners` (`kx`, `ky` en N/m).

### 2.6 Cargas equivalentes (sin vela en Phase 1)

- Carga distribuida lateral `q(z)` aplicada como fuerzas nodales:
  - Perfil: uniforme o triangular (más carga arriba).
  - Modos: upwind y downwind (downwind escala la carga lateral).

## 3) Núcleo numérico (robustez)

### 3.1 Problema

Encontrar `u` tal que:

- `∇Π(u) = 0` (equilibrio)
- `Π = U_internal - W_external`

Con no linealidad por:

- Direcciones de elementos (L(u), n(u))
- Tensión‑solo (activación/desactivación de rigidez)

### 3.2 Solver

- Newton–Raphson sobre el residuo `g = internal - external`.
- Ensamblado de rigidez tangente (matriz K):
  - Beam: rigidez constante (por construcción)
  - Cables/barras: rigidez tangente tipo truss (material + geométrica)
- Line search (Armijo) para estabilizar y evitar “explosiones”.

### 3.3 Continuation / stepping

Para mejorar convergencia (sobre todo con tensión‑solo):

1. **Standing pretension**: ramp de `L0` de obenques/estay base
2. **Jib halyard**: ramp de tensión objetivo del estay (actuador permitido en regata)
3. **Sailing load**: ramp de carga `q(z)`

Si un subpaso falla: step‑halving automático hasta un mínimo.

## 4) Validación (Phase 1)

### 4.1 Tests automáticos (ya incluidos)

- `tests/phase1-solver.test.cjs`:
  - converge preset base
  - simetría (sin carga) → shroud port/stbd iguales, x(z) ~ 0
  - más tensión objetivo (driza/estay) → aumenta tensión de estay
  - más q(z) → aumenta deflexión en tope

### 4.2 Validación cualitativa (manual)

Comparar tendencias con guías (Quantum/North/SnipeToday):

- +tensión obenques / +tensión driza foque → +tensión estay, menos sag proxy
- +sweep aft spreaders → tendencia a más prebend / “depower”

## 5) Roadmap (conexión futura con vela/FSI)

- Phase 2: actuadores adicionales (vang/gooseneck simplificado) + mejores cargas equivalentes
- Phase 3: membrana de vela + acoplamiento reducido (sin CFD)
- Phase 4: calibración con datos reales (tensión medida + rake + fotos)
