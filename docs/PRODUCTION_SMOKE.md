# Smoke E2E black-box de producción

```bash
npm run smoke:prod
```

Script: `scripts/prod-smoke.mjs`. Recorre la aplicación **publicada** como una persona: formularios, botones y navegación. No importa código de `src/`, no llama servicios y no lee ni escribe IndexedDB. La propia RutaCash crea sus datos.

## Qué valida (A–H)

Bootstrap por UI desde cero:

- Owner → empresa `SMOKE PRODUCCION <run-id>` → Super Admin
- ruta *Norte Smoke*
- usuarios: Juan (Cobrador), Laura (Supervisora), Andrés (Administrador)
- capital de 5.000.000
- clientes: Carlos (Venta A de 1.000.000) y Diana

| | Escenario | Comprueba |
|---|---|---|
| A | Segundo crédito del Cobrador | Juan no ve venta directa, ve el aviso de crédito activo y genera 1 solicitud pendiente marcada "Cliente con crédito activo"; el reintento se rechaza por duplicado |
| B | Supervisor | Laura ve y aprueba solicitudes, y otorga crédito directo (`sale.createDirect`) |
| C | Base física | 1.500.000 a Juan: el libro no cambia, "sin asignar" baja 1.500.000, "Cuadra" |
| D | Operación | Mi efectivo: 1.500.000 − 500.000 + 300.000 − 100.000 = 1.200.000 |
| E | Cuadre exacto | Entrega 1.200.000 → exacto; el ciclo siguiente queda en 0 |
| F | Faltante | Esperado 1.000.000, entregado 900.000 → faltante 100.000 que se arrastra |
| G | Conciliación | libro = sin asignar + personas; la vía (b) coincide; faltante visible; cartera aparte; "Cuadra" |
| H | Retiro vs custodia | Retirar el libro completo se rechaza; tras una devolución, el disponible sube y el retiro válido se acepta; sigue "Cuadra" |

También comprueba:

- **Sesiones:** cada login muestra el actor, el rol y el layout correctos.
- **Reactividad sin F5:** Base, cuadre, conciliación y "Disponible para retiro". Este último se comprueba en una segunda pestaña de la misma sesión.

## Qué NO valida

- Sincronización entre dispositivos: no existe; los datos viven en cada navegador.
- Cobertura completa de permisos: eso lo cubre `npm test`.
- Rendimiento.
- Datos reales de ningún usuario.

## Por qué no toca datos reales

- Cada ejecución usa un perfil de Chrome nuevo en un directorio temporal, sin cookies, localStorage, IndexedDB, Service Workers ni caché previos. Se elimina al terminar, también si hay error.
- Como RutaCash guarda todo en el navegador, lo que crea el smoke solo existe en ese perfil.
- Nombres, correos (`*.smoke.rutacash.test`), documentos y contraseñas son sintéticos y únicos por ejecución.

## Evidencia

`tmp/prod-smoke/<run-id>/` (ignorado por git):

- `result.json`: escenarios, comprobaciones con esperado/observado, errores de página y confirmación de que se eliminó el perfil. Sin contraseñas.
- `screenshots/`: capturas de cada escenario.

Código de salida: 0 solo si A–H pasan y no hubo errores de página. Un fallo indica escenario, paso, valor esperado y valor observado.

## Configuración

| Variable | Default | Uso |
|---|---|---|
| `RUTACASH_SMOKE_URL` | `https://rutacash-clean.vercel.app` | Otra URL (preview o staging) |
| `CHROME_PATH` | Chrome instalado (detección automática) | Ruta del navegador |
| `RUTACASH_SMOKE_OUT` | `tmp/prod-smoke/<run-id>` | Carpeta de evidencia |
| `RUTACASH_SMOKE_TIMEOUT` | `15000` | Espera máxima por condición (ms) |

Requiere Chrome instalado y `puppeteer-core` (devDependency).
