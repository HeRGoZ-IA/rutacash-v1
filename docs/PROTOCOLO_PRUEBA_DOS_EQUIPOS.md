# RutaCash — Protocolo de prueba manual con dos equipos

Valida en navegador real lo que la suite financiera ya prueba de forma determinista:
que **Admin y Cobrador/Supervisor producen el mismo resultado financiero** y que el
antiguo *congelamiento de abonos* ya no puede ocurrir.

**Duración estimada:** 15 minutos. **Modo:** DEMO en ambos equipos.

---

## 0. Preparación (OBLIGATORIA en los DOS equipos)

Sin este paso la prueba no es válida: una IndexedDB antigua produce datos distintos
en cada máquina y es justo lo que confundió la prueba anterior.

| # | Acción | Equipo A | Equipo B |
| - | ------ | :------: | :------: |
| 0.1 | Abrir la misma URL de DEMO (**exactamente la misma**, no una demo y otra limpia) | ☐ | ☐ |
| 0.2 | Banner superior debe decir **«MODO DEMO — Datos ficticios»** | ☐ | ☐ |
| 0.3 | Pulsar **«Restaurar datos demo»** en el banner y confirmar | ☐ | ☐ |
| 0.4 | Esperar a que recargue en `/login` | ☐ | ☐ |
| 0.5 | DevTools → Application → IndexedDB → `RutaCashDB` → anotar **versión** (debe ser **8** en ambos) | ☐ | ☐ |
| 0.6 | DevTools → Network → anotar el hash del bundle `index-*.js` (**debe coincidir** entre A y B) | ☐ | ☐ |

> Si los hashes de 0.6 no coinciden, **deténganse**: están probando builds distintos.

---

## 1. Datos de partida

Todo sale del seed DEMO; tras el reset son idénticos en ambos equipos.

| Dato | Valor |
| ---- | ----- |
| Empresa | Credirutas Norte |
| Ruta | **Ruta Norte** |
| Cliente | **Ana Martínez** — Peluquería Bella |
| Venta | $200.000 al 20% → **total $240.000** |
| Parcelas | **20 de $12.000** (frecuencia diaria) |
| Parcelas pagadas al inicio | **5 de 20** |
| **Saldo inicial** | **$180.000** |
| **Parcela actual** | **#6** ($12.000, vence hoy) |

**Sesiones:**

| Equipo | Usuario | Contraseña | Pantalla |
| ------ | ------- | ---------- | -------- |
| **A** | `admin@demo.com` | `123456` | Administrador → **Ventas activas** |
| **B** | `cobrador@demo.com` | `123456` | Cobrador → **Ruta** → Ana Martínez → **Registrar abono** |

> Para probar además el **Supervisor**, repitan el bloque 2 en el Equipo B con
> `supervisor@demo.com` / `123456`. Debe comportarse **exactamente igual**: es el
> mismo componente y el mismo servicio.

---

## 2. CASO CRÍTICO — Estado obsoleto (el antiguo congelamiento)

Reproduce literalmente el fallo reportado. **El Equipo B no debe refrescar en ningún momento.**

| # | Equipo | Acción | Resultado esperado |
| - | :----: | ------ | ------------------ |
| 2.1 | **B** | Entrar a Ana Martínez y abrir la pantalla **Registrar abono**. **Dejarla abierta y NO refrescar.** | Muestra `Saldo $180.000` · `Parcela $12.000` · `Pagando parcela 6 de 20` |
| 2.2 | **A** | Ventas activas → Ana Martínez → **Registrar pago** → confirmar **$12.000** | Toast «Pago registrado correctamente». Lista: **Saldo $168.000**, **Parcelas 6/20** |
| 2.3 | **B** | **Sin refrescar**, escribir **$12.000** y pulsar **Registrar abono** | ✅ «¡Abono registrado!» · **«Parcela 7 de 20 registrada»** · **«Nuevo saldo: $156.000»** |
| 2.4 | **A** | Refrescar Ventas activas | **Saldo $156.000** · **Parcelas 7/20** |

### Criterio de aceptación del caso crítico

- [ ] La parcela 6 **sigue pagada** (no fue reescrita por el equipo B).
- [ ] El abono de B entró en la **parcela 7**, no en la 6.
- [ ] El saldo bajó por **ambos** pagos: 180.000 → 168.000 → **156.000**.
- [ ] `payment A + payment B = 24.000` = aplicado real a parcelas.
- [ ] **Ningún pago quedó sin aplicar.**

> **Comportamiento anterior (para contraste):** el equipo B habría mostrado
> «Parcela 6 registrada» y el saldo se habría quedado en **$168.000**, perdiendo
> $12.000 ya cobrados. Si vuelven a ver eso, el build no incluye el cambio.

**Verificación adicional en B** (DevTools → Console):

```js
await rutacash.diagnostico()
```

Debe imprimir **exactamente una** incidencia, y siempre la misma:

| Campo | Valor esperado |
| ----- | -------------- |
| Código | `LEGACY-001` |
| Cliente | **María García** (la PRIMERA venta demo, no Ana Martínez) |
| Diferencia | **$12.000** |

> ⚠️ **Esta incidencia es NORMAL en DEMO y no la provoca la prueba.** El seed
> (`src/data/seed.ts`, líneas 431-445) siembra a propósito un pago de ejemplo
> «Pago sin conexión» que nunca se aplica a parcelas, así que **toda base DEMO
> recién restaurada nace con ese desajuste de un valor de parcela**. Es un defecto
> del dato de demostración, no del motor de pagos.
>
> Lo que importa: **Ana Martínez NO debe aparecer en el informe.**

---

## 3. CASO — Pago superior al saldo

Saldo de partida: **$156.000** (viene del bloque 2).

| # | Equipo | Acción | Resultado esperado |
| - | :----: | ------ | ------------------ |
| 3.0 | **A** | Menú **Caja** → Ruta Norte → anotar el valor de **«Cobros»** | Valor de referencia (llamémoslo `C`) |
| 3.1 | **A** | Ventas activas → Ana Martínez → **Registrar pago** | El botón **«Completar parcela»** propone **$12.000** (saldo real de la parcela, no un nominal) |
| 3.2 | **A** | Escribir **$500.000** en «Valor del pago» | Bajo el campo aparece: *«Supera el saldo: se registrará $156.000»* |
| 3.3 | **A** | Confirmar pago | ⚠️ Toast: **«El pago se limitó al saldo pendiente: $156.000. La deuda queda en $0.»** |
| 3.4 | **A** | Ver la venta en la lista | **Saldo $0** · Estado **finalizada** · **Parcelas 20/20** |
| 3.5 | **A** | Menú **Caja** → Ruta Norte | **«Cobros» = `C` + 156.000** (NO `C` + 500.000) |

### Criterio de aceptación del sobrepago

- [ ] Mensaje claro de que el valor fue limitado.
- [ ] **Valor guardado = $156.000** (no $500.000).
- [ ] Venta **finalizada** con saldo **exactamente $0** (nunca negativo).
- [ ] **Caja sube solo $156.000.** Sin dinero fantasma.
- [ ] No se creó ningún crédito a favor.

**Verificación de auditoría** (DevTools → Console, en el Equipo A):

```js
await rutacash.auditoriaPagos(5)
```

La fila más reciente debe mostrar:

| campo | valor esperado |
| ----- | -------------- |
| `solicitado` | `500000` |
| `aplicado` | `156000` |
| `topado` | `true` |
| `excedenteRechazado` | `344000` |
| `saldoAntes` → `saldoDespues` | `156000` → `0` |

Esto es lo que permite reconstruir después **qué intentó registrar el usuario** y
**qué aceptó realmente RutaCash**.

---

## 4. CASOS DE RECHAZO (rápidos)

| # | Equipo | Acción | Resultado esperado |
| - | :----: | ------ | ------------------ |
| 4.1 | **A** | Intentar registrar otro pago sobre Ana Martínez (ya finalizada) | El botón «Registrar pago» **no aparece** en el detalle. Si se fuerza, el servicio responde «Esta venta no está activa: no admite nuevos pagos» |
| 4.2 | **B** | Menú **Desembolsos** → elegir una venta **pendiente de desembolso** → intentar abonar | «Esta venta aún no está desembolsada». **Ningún pago registrado** |
| 4.3 | **A** | Ventas activas → cualquier venta activa → **Marcar perdida** → luego intentar cobrarla | Rechazo por estado. La venta **sigue «perdida»** (un pago no la revive) |

- [ ] 4.1 rechazado
- [ ] 4.2 rechazado en el flujo operativo
- [ ] 4.3 rechazado y la venta no vuelve a «activa»

---

## 5. Cierre — Conciliación final

En **ambos** equipos, DevTools → Console:

```js
await rutacash.diagnostico()
```

- [ ] Equipo A: **una sola** incidencia — `LEGACY-001`, **María García**, **$12.000** (la del seed DEMO)
- [ ] Equipo B: **idéntica** a la del equipo A
- [ ] **Ana Martínez NO aparece** en ninguno de los dos informes
- [ ] Los dos informes son **iguales entre sí**

> Si aparece cualquier otra incidencia, o si Ana Martínez figura en el informe,
> copien el resultado completo de `await rutacash.diagnosticoJSON()`: sería un caso
> que la suite automatizada no cubre.

---

## Resumen de resultados

| Bloque | Resultado |
| ------ | --------- |
| 0. Preparación (misma versión de BD y mismo bundle) | ☐ OK ☐ FALLÓ |
| 2. Estado obsoleto / congelamiento | ☐ OK ☐ FALLÓ |
| 3. Pago superior al saldo | ☐ OK ☐ FALLÓ |
| 4. Rechazos por estado y desembolso | ☐ OK ☐ FALLÓ |
| 5. Conciliación limpia en ambos equipos | ☐ OK ☐ FALLÓ |

**Observaciones:**

```
(anotar aquí cualquier diferencia entre A y B)
```
