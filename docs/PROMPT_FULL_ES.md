# Prompt completo (sin código) — listo para pegar

PROMPT (ESPECIFICACIÓN PARA IA / CODEX, NO GENERAR CÓDIGO AHORA)

Quiero diseñar un software (app de escritorio en Electron) para Snipe (dinghy) que modele jarcia + palo mediante FEA para ayudar a trimar y entender el rig como en regata. NO escribas código en esta respuesta: produce una especificación técnica exhaustiva y un plan de implementación por fases.

0) Alcance y filosofía

Fase 1 (MVP): simulación estructural estática/no lineal del mástil y la jarcia bajo pretensión y cargas equivalentes de navegación (sin vela todavía).

El sistema debe permitir introducir controles típicos del Snipe organizados por “pre‑race” vs “en navegación”, y devolver salidas físicas interpretables (bend, prebend, tensiones, sag proxy, sensibilidad).

Debe respetar restricciones de clase (SCIRA, resumidas):
- Spreaders/crucetas no ajustables durante regata.
- Longitudes efectivas de jarcia fija (standing rig) no ajustables durante regata.
- Running rigging (p.ej. driza de foque) sí puede ajustarse.

1) Arquitectura del software (módulos)

Define módulos separados:
- Datos de barco/rig (geometría, plantillas de mástil, puntos de anclaje).
- Modelo FEA (elementos, ensamblado, BCs, pretensión).
- Solver no lineal (Newton incremental con load stepping + line search).
- Motor de controles (mapear ajustes → parámetros FEA: L0, posiciones, rigideces).
- Cargas equivalentes (upwind/downwind).
- Postproceso (bend curves, tensiones, checks).
- UI/UX (panel de tuning, presets, comparación).
- Validación (tests + casos de regresión + tendencias con guías).

2) Modelo físico (Phase 1, jarcia‑only)

Elementos:
- Mástil: beam (Euler–Bernoulli; discretizado en nodos a lo largo de z, EI parametrizable).
- Spreaders: bars/beam cortos (salida: compresión).
- Jarcia fija (obenques + estay): cable/truss tension‑only con pretensión por rest‑length L0.

No linealidad geométrica:
- Al deformar, cambian direcciones de jarcia y por tanto equilibrio (large displacement a nivel de truss).
- Evitar inestabilidad numérica cuando un cable queda slack: regularización + stepping.

Pretensión:
- PRE‑RACE: ajustar L0 de obenques/estay base (pin/turnbuckle).
- EN NAVEGACIÓN: driza de foque como actuador (control por tensión en kN del estay).

BCs:
- Mast step fijo/pinned.
- Partners como restricción lateral (muelles kx, ky; parametrizable por shims).

Cargas equivalentes:
- q(z) lateral distribuida en el palo (uniforme o triangular).
- upwind/downwind como escalado de carga.

3) Catálogo de controles (Phase 1 mínimo)

Estructura el panel así:
A) PRE‑RACE (bloqueado en modo regata):
- Spreader length
- Spreader sweep/angle (tip‑to‑tip o sweep aft)
- Shroud effective lengths (port/stbd)
- Forestay base effective length
- Partners stiffness (shims)
B) EN NAVEGACIÓN (permitido en regata):
- Jib halyard tensioner (actuador)
- Selección de carga equivalente (upwind/downwind) + intensidad q(z) + perfil

Para cada control, especifica:
- Variable física subyacente (L0, rigidez, posición nodal, carga)
- Unidades
- Efecto cualitativo esperado (prebend, bend, headstay tension)

4) Entradas/Salidas

Entradas:
- Geometría (puntos de anclaje, alturas)
- Parámetros de mástil (EI(z) al menos como plantilla)
- Settings de controles (presets)
- Caso de carga (upwind/downwind + q(z))

Salidas:
- Curva de bend/prebend: x(z), y(z)
- Tensiones en obenques y estay
- Compresión en crucetas
- Reacciones/diagnóstico numérico
- Export JSON/CSV

5) Validación y tests

Incluye:
- Unit tests geométricos (simetría, unidades).
- Casos de regresión (presets base).
- Validación cualitativa con guías de tuning: tendencias correctas al variar spreaders, shrouds, driza.
- Chequeos de estabilidad numérica: convergencia, stepping adaptativo, detección de slack.

6) Roadmap por fases

- Fase 1: jarcia + palo + pretensión + carga lateral simple (robusta).
- Fase 2: actuadores adicionales (vang/gooseneck) + loads equivalentes mejores.
- Fase 3: vela como membrana + acoplamiento reducido (sin CFD).
- Fase 4: calibración con datos reales.

Entrega final en esta respuesta:
- Documento de especificación (SRS técnico).
- Diagrama textual de módulos y flujo de datos.
- Tabla completa de controles con mapeo al modelo.
- Roadmap con hitos y criterios de aceptación.
- Lista de riesgos y mitigaciones (especialmente tensión‑solo).
