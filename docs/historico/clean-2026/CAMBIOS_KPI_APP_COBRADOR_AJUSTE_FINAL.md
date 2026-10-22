# Ajuste final — KPIs superiores App Cobrador

Versión: RutaCash V1 (desarrollo local).
Alcance: **solo ajuste visual fino** de los 3 KPIs superiores del dashboard móvil
del cobrador. No se cambió lógica, conteos, cálculos ni el diseño general.

KPIs afectados:
- **Pendientes** (ámbar tenue)
- **Abonado hoy** (verde tenue)
- **Ventas activas** (azul/primario tenue)

---

## Archivos modificados

- `src/components/ui/KpiCard.tsx` — único componente de las 3 tarjetas KPI.

> Nota: las 3 tarjetas se renderizan con el **mismo componente** `KpiCard` desde
> `src/pages/collector/CollectorHomePage.tsx`. Ajustar el componente garantiza que
> las 3 mantengan exactamente la misma altura, anchura, padding y estructura.
> Este componente **solo** se usa en la App Cobrador (el Dashboard del
> Administrador usa otro componente distinto, `KPICard` de `Card.tsx`), por lo que
> el cambio queda aislado.

---

## Qué se ajustó en los KPIs

Antes (causa del problema):

```
contenedor: h-20 px-2 py-2
valor:      text-2xl (24px) ... truncate
etiqueta:   text-[12px]
```

Después:

```
contenedor: h-16 px-1.5 py-2
valor:      text-sm (14px) ... truncate (red de seguridad)
etiqueta:   text-[11px]
```

Detalle de cambios:

- **Tamaño del valor numérico:** se redujo de `text-2xl` (24px) a `text-sm` (14px),
  manteniendo `font-bold`, `tabular-nums` (dígitos de ancho uniforme) y
  `leading-none`.
- **Altura de la tarjeta:** de `h-20` (80px) a `h-16` (64px) → más compacta y
  proporcional al contenido.
- **Padding horizontal:** de `px-2` (8px) a `px-1.5` (6px) → da un poco más de
  ancho útil al número sin verse cramped.
- **Valor centrado:** se mantiene centrado horizontal y verticalmente (área
  flexible con `flex items-center justify-center`, ahora con `w-full` y
  `text-center` para centrado consistente).
- **Etiqueta descriptiva:** ligeramente más pequeña (`text-[11px]`) para equilibrar
  con el nuevo tamaño del valor; sigue centrada, legible y bien alineada.
- **Fondos tenues por color:** intactos (ámbar / verde / azul), igual que antes.

---

## Cómo se resolvió el problema de valores largos

El problema era doble:

1. El valor usaba `text-2xl` (24px), demasiado grande para una columna de 1/3 de
   ancho en móvil.
2. Tenía `truncate`, por lo que un monto como `$ 1.940.000` se **cortaba con "…"**
   en lugar de mostrarse completo (se "salía"/quedaba ajustado).

Solución:

- Al bajar el valor a `text-sm` (14px) con `tabular-nums`, un monto típico como
  `$ 1.940.000` ocupa ~76px en una columna de ~89px útiles, por lo que **entra
  completo y centrado** en teléfonos comunes (incluso montos de 8 dígitos).
- Se conserva `truncate` únicamente como **red de seguridad** para valores
  extremos en pantallas muy estrechas; con el tamaño nuevo no se activa en los
  casos normales.

---

## Qué se cambió en altura / tamaño visual

| Propiedad | Antes | Después |
|---|---|---|
| Altura tarjeta | `h-20` (80px) | `h-16` (64px) |
| Tamaño valor | `text-2xl` (24px) | `text-sm` (14px) |
| Padding horizontal | `px-2` (8px) | `px-1.5` (6px) |
| Tamaño etiqueta | `text-[12px]` | `text-[11px]` |
| Padding vertical | `py-2` | `py-2` (sin cambio) |
| Fondos / bordes | tenues por color | igual |

---

## Riesgos detectados

- En monedas/idiomas con montos muy largos (p. ej. más de 9–10 dígitos) en
  pantallas muy angostas, podría activarse `truncate` como protección. Es el
  comportamiento esperado para no romper el layout.
- El tamaño del valor (`text-sm`) es deliberadamente conservador para priorizar
  que **nunca se desborde**; si en el futuro se desea un número algo más grande,
  se puede subir a `text-[15px]` evaluando el caso real en dispositivo.
- Cambio puramente de presentación: no afecta datos ni estados.

---

## Qué NO se cambió

- No se modificó la lógica de negocio.
- No se cambiaron conteos ni cálculos (Pendientes, Abonado hoy, Ventas activas se
  calculan igual en `CollectorHomePage.tsx`).
- No se tocó backend, GitHub, Vercel ni se hizo commit/push/deploy.
- No se rediseñó el dashboard: el resto de bloques (Recaudo, Clientes y ventas,
  Gastos y cuadre, Sincronización) quedó intacto.
- No se cambiaron los colores/fondos tenues de las tarjetas.
- No se modificó el componente `KPICard` del Administrador.

---

## Pruebas manuales recomendadas

1. `npm run dev:clean` arranca correctamente.
2. `npm run dev:demo` arranca correctamente.
3. Los 3 KPIs se ven **más compactos** (menor altura).
4. Los 3 KPIs conservan **simetría** (misma altura, ancho y padding).
5. **"Abonado hoy"** con valores grandes ya **no se sale** del bloque.
6. Valores como **`$ 1.940.000`** se ven **completos y centrados**.
7. Las etiquetas ("Pendientes", "Abonado hoy", "Ventas activas") se leen bien.
8. La App Cobrador no se rompe; el resto del dashboard se ve igual.
9. `npm run build` finaliza sin errores.
