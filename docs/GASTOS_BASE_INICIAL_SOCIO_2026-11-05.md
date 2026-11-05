# Tipos de gasto: base inicial pedida por el socio (2026-11-05)

Fuente: archivo del socio «Listado de gastos funcionarios y Adm.xlsx» (2026-11-05). Pendiente **3.29** del [listado canónico](./ADEX_PENDIENTES_CONSOLIDADOS_2026-10-24.md).

Decisiones del propietario (2026-11-05):
- Esta lista es la **base inicial**. Después, cada Administrador la cambia en «Categorías de gasto».
- Se aplica a las **empresas nuevas** y también a **BlueLine**: se añaden los tipos que le falten. No se borra ningún tipo ni ningún gasto ya registrado.
- Se corrige la **ortografía** (tildes y «@»).

El sistema usa **un solo listado** con la casilla **«Para Cobradores»** (decisión 2.1.15):
- el Cobrador y el Supervisor solo ven los tipos marcados;
- el Administrador ve todos.

## Marcados «Para Cobradores» (11)

Gasolina · Aceite · Despinchada moto · Mantenimiento moto · Recarga celular · Arriendo funcionario · Seguro de moto · Impuesto CNPJ · Pago cadena · Medicamentos · Otros

## Solo Administrador (39)

Arriendo administrativo · Seguro de carro · Honorarios contador · Pago abogado · Pago PM / PC · Arreglo celular · Compra celular · SIM card celular · Artículos hogar funcionarios · Préstamos funcionarios · Comisión · Sueldo revisador · Sueldo panfleteador(a) · Sueldo secretario(a) · Dotación funcionarios · Compra de moto · Vistoria · IPVA y licenciamiento · Transferencia de moto · Cartório · Pago de multas · Declaración de renta · Descuadres · Fondo multas · Documentos funcionarios · Integración funcionarios · Interés · Lavada de moto · Prima funcionarios · Liquidación · Pago de sistema o aplicativo · Pago de administración · Panfletos · Sello panfletos · Pasaje aéreo · Reembolso · Seguro de repatriación · Viáticos · Uber

Total: 50 tipos. El listado administrativo del Excel incluye los 10 tipos del trabajador, menos «Arriendo funcionario». Con un solo listado, el Administrador también verá ese tipo.

## Notas para el chat Central

- Hoy las categorías iniciales se crean en `adex_control.create_company` (la última versión está en `saas/db/migrations/0023_remove_socio_admin_transfers.sql`). Esa lista es Transporte, Alimentación, Papelería, Combustible, Comunicación, Mantenimiento y Otros.
- La función `adex.default_collector_category` de la migración 0040 marca Transporte, Alimentación y Combustible. Hay que cambiarla para que marque los 11 tipos de arriba.
- **BlueLine:**
  - añadir los tipos que falten, sin duplicar por nombre (sin distinguir mayúsculas ni tildes);
  - **marcar «Para Cobradores» solo los tipos nuevos que se añaden ahora**;
  - los tipos que ya tiene (por ejemplo Transporte o Combustible) se quedan como están. Su Administrador decide si los desactiva;
  - es un cambio de datos en BlueLine: hay que pedirle permiso explícito a Helmer y que él ejecute la migración.
- Revisar también la lista que usa la demo (`saas/src/demo/history.ts`) y `online/src/owner/plane/expenseCategoryDefaults.ts`, que solo sirve como referencia.
- Las capturas de gastos sin conexión con tipos viejos siguen la regla de 3.14: se aceptan con aviso al Administrador.
- Ojo con el nombre «Liquidación» (pago a un funcionario al salir): es distinto de la pantalla «Liquidaciones». Se puede renombrar a «Liquidación funcionario» si el socio está de acuerdo.
