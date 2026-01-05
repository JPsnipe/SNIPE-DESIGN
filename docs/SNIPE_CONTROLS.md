# Catálogo de controles Snipe (Phase 1) y mapeo al modelo

## Reglas/criterios de clase (resumen operativo)

Este MVP implementa un **bloqueo de UI** en “modo regata” para:

- Crucetas/spreaders: **no ajustables durante competición**
- Longitudes efectivas de jarcia fija (standing rig): **no ajustables durante competición**

En cambio, se permite en navegación:

- Driza de foque / jib halyard tensioner (running rigging)

Nota: valida los detalles exactos con el texto SCIRA vigente; aquí solo se aplica el criterio operativo de “standing vs running”.

## Tabla (control → variable física → parámetro del modelo)

| Grupo | Control (UI) | Variable física | Unidades | Entra como… | Permitido en regata |
|---|---|---:|---|---|---|
| Geometría | Mast length | L mástil | mm | `mastLengthM` (discretización en z) | N/A |
| Geometría | Partners z | altura pasacubierta | mm | `partnersZM` (nodo con muelles) | N/A |
| Geometría | Spreader z | altura crucetas | mm | `spreaderZM` (nodo raíz) | N/A |
| Geometría | Chainplate x/y | anclajes obenques | mm | puntos fijos (deck) | N/A |
| Geometría | Bow y | herraje proa estay | mm | punto fijo (bow) | N/A |
| PRE‑RACE | Spreader length | longitud cruceta | mm | `spreaderLengthM` (bar L0) | No |
| PRE‑RACE | Spreader sweep aft | sweep hacia popa | mm | define geometría del tip (y) | No |
| PRE‑RACE | Shroud ΔL0 port/stbd | longitud efectiva | mm | cambia L0 total del obenque (2 tramos) | No |
| PRE‑RACE | Partners kx/ky | “shim stiffness” | kN/m | muelles laterales en partners | No (en MVP) |
| EN NAVEGACIÓN | Stay/Driza tension | tensión objetivo | kN | `jibHalyardTensionN` (N) | Sí |
| EN NAVEGACIÓN | Load mode | escenario | – | escala q(z) (upwind/downwind) | Sí |
| EN NAVEGACIÓN | q lateral | carga equivalente | N/m | fuerzas nodales en el mástil | Sí |
| EN NAVEGACIÓN | Perfil q(z) | distribución | – | uniforme/triangular | Sí |

## Señales de salida (para interpretación y para futuro FSI)

- `mastCurvePrebend`: {x,y,z} por nodo (tras pretensión, sin carga)
- `mastCurveLoaded`: {x,y,z} por nodo (con carga)
- Tensiones: `shroudPortN`, `shroudStbdN`, `forestayN`
- Spreaders: `portAxialN`, `stbdAxialN`
- Diagnóstico: `slackCables`, historial de stepping/convergencia
