# ADEX Soluciones (antes RutaCash)

Plataforma SaaS multiempresa para negocios de préstamo y cobro diario por rutas: cada empresa sabe cuánto dinero tiene, dónde está y quién responde de él. Publicada como **ADEX Online** (frontend en Vercel, API en Render, PostgreSQL gestionado).

## Carpetas

| Carpeta | Función |
|---|---|
| `src/`, `public/` | Frontend de CLEAN. Su web pública está **retirada**, pero el código sigue en uso: `online/` lo compila y la API reutiliza sus reglas. No borrar |
| `online/` | ADEX Online (empresas y `/owner`): compila `src/` con un puente de datos hacia la API |
| `saas/` | API, migraciones (`saas/db/migrations/`), pruebas y scripts de staging |
| `tests/` | Pruebas de las reglas de CLEAN (`npm test`) |
| `deploy/` | Imagen Docker y `render.yaml` de los servicios de Render |
| `scripts/` | Verificación de despliegue y utilidades de marca |
| `experiments/` | Prueba de concepto SaaS Fase 0A (cerrada; se conserva como referencia) |
| `docs/` | Documentación vigente y resultados de cada ronda |
| `docs/historico/` | Documentos antiguos de la etapa CLEAN |
| `tmp/` | Local e **ignorada por Git**: evidencias de pruebas, arneses, capturas y temporales por ronda (`tmp/rNN/`). Parte de ella no es regenerable |

## Dónde empezar

- Visión y principios aprobados: [docs/VISION_Y_PRINCIPIOS_SAAS_ADEX.md](docs/VISION_Y_PRINCIPIOS_SAAS_ADEX.md)
- Índice histórico oficial (rondas, migraciones, despliegues, decisiones): [docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md](docs/REGISTRO_MAESTRO_EVOLUCION_ADEX.md)
- Reglas de organización de archivos: [docs/AUDITORIA_ORGANIZACION_PROYECTO_ADEX.md §12](docs/AUDITORIA_ORGANIZACION_PROYECTO_ADEX.md)

## Controles

- Las migraciones, las operaciones sobre datos financieros, las empresas reales y las cuentas Owner requieren **autorización expresa del propietario**. Las migraciones de staging las ejecuta el propietario.
- Render se despliega **solo de forma manual**. Un push a `main` puede recompilar ADEX Online en Vercel.
- Nunca se versionan `.env*` (salvo `.env.example`), certificados, claves, datos reales ni el contenido de `tmp/`.
