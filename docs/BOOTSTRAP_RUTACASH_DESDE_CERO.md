# RutaCash — Arranque desde cero

**Entrega 6.1 · Septiembre 2026**

Escrito para: Helmer y Andrés, probando en equipos independientes.

---

## Lo primero: ya no hay versiones

Antes existían dos: **DEMO** (con datos ficticios) y **CLEAN** (vacía). Eso se acabó.

Hay **una sola RutaCash**. Una build, un producto, sin banner de modo y sin datos de
mentira. Una instalación sin datos simplemente está vacía — que es un estado normal,
no una "versión".

```
npm run dev      # desarrollo
npm run build    # producción
```

No hay `build:demo` ni `build:clean`. No hay `.env.demo` ni `.env.clean`.

---

## El ciclo completo

### 1. Abrir RutaCash

Cada equipo tiene su propia IndexedDB. **Durante esta etapa las instalaciones son
independientes y no se sincronizan**: lo que Helmer cree en su equipo no aparece en el
de Andrés, y está bien así. No hay backend y no se ha simulado ninguno.

### 2. Ir a `/owner/login`

Una instalación nueva tiene **0 Owners**. Así que esa URL no muestra un formulario de
acceso —no habría con qué entrar— sino directamente:

> ### Crear primer Owner
> Nombre · Correo electrónico · Contraseña · Confirmar contraseña
>
> **[ Crear Owner ]**

La contraseña la eliges tú y es definitiva. RutaCash **nunca** crea una cuenta con una
contraseña que él conozca.

### 3. Crear el Owner

Al pulsar el botón: se crea la cuenta, se abre la sesión y entras directamente al
**Dashboard RutaCash**. Sin pasos intermedios.

En ese momento:

| | |
|---|---:|
| Owners | 1 |
| Empresas | 0 |
| Routes | 0 |

Crear el Owner **no crea ninguna empresa y ningún SuperAdmin**. Es la primera y única
entidad que existe.

> A partir de aquí, `/owner/login` muestra el **login normal**. El registro público se
> cierra con el primer Owner. Los siguientes se crean desde
> **Configuración → Owners → Nuevo Owner**, ya autenticado.

### 4. Crear la empresa y su primer SuperAdmin

Owner → **Empresas** → **Nueva empresa**:

- Datos comerciales mínimos: nombre, correo, identificación, contacto, plan y tarifa.
- Primer SuperAdmin: nombre, correo y contraseña inicial.

Al guardar, RutaCash muestra las credenciales **una sola vez**. Anótalas: la contraseña
no vuelve a mostrarse en ninguna pantalla.

La empresa nace con su SuperAdmin y **nada más**: sin Oficinas, sin Rutas y sin otros
usuarios. Eso lo monta el cliente.

### 5. El cliente entra por `/login`

El SuperAdmin usa esas credenciales en `/login`. **No se le pide cambiar la
contraseña**: ni pantalla, ni modal, ni recordatorio. Entra y trabaja.

Desde ahí configura su empresa, crea Oficinas, Rutas, otros SuperAdmin, Administradores,
Supervisores, Secretarios, Socios y Cobradores.

### 6. Volver a cero

Owner → **Configuración** → **Zona de pruebas** → **Restablecer**.

Se pide escribir `RESTABLECER`. No se vuelve a pedir la contraseña: ya estás
autenticado.

---

## Qué borra el restablecimiento

**Todo lo que RutaCash controla en ese navegador:**

- La base de datos completa (`db.delete()`, no tabla por tabla): Owners, empresas,
  usuarios, oficinas, rutas, clientes, ventas, cuotas, pagos, gastos, capital,
  transferencias, retiros, liquidaciones, auditoría, cobros SaaS y eventos de control.
- `localStorage` y `sessionStorage` con prefijo `rutacash-`, lo que incluye **las dos
  sesiones**: la de empresa (`rutacash-auth`) y la de plataforma
  (`rutacash-owner-auth`).
- Cache Storage y Service Workers del dominio.

No toca datos de otros sistemas que compartan el navegador.

### Sí, borra también los Owners

Es intencionado. Después del reset **no queda Helmer, no queda Andrés, no queda
ninguna cuenta de plataforma**. Un reset que dejara viva la cuenta raíz no sería un
reset.

La aplicación recarga en `/owner/login` y vuelve a mostrar **«Crear primer Owner»**.
El ciclo empieza otra vez.

---

## Quién puede restablecer

**Solo un Owner autenticado.** Nadie más:

| Quién | Puede |
|---|:---:|
| Owner autenticado | ✅ |
| SuperAdmin | ❌ |
| Admin, Supervisor, Secretario, Socio, Cobrador | ❌ |
| `/login` (portal de empresa) | ❌ |
| `/owner/login` sin sesión (pantalla de creación) | ❌ |

No es cuestión de ocultar un botón: **el portal de empresa no importa el módulo que
ejecuta el borrado**, y hay pruebas (`TENANT-NO-RESET-001..004`) que barren el árbol
de archivos y fallan si alguna vez lo hiciera.

La pantalla pública de creación del primer Owner tampoco lo ofrece: es accesible sin
credenciales, y poner ahí un borrado total sería dejarlo al alcance de cualquiera que
abra la URL.

---

## Retirar la herramienta

El restablecimiento es de **esta etapa de pruebas**, no del producto. Para quitarlo:

```ts
// src/lib/featureFlags.ts
export const ENABLE_FACTORY_RESET = false
```

Eso retira la opción de la interfaz **y** bloquea la ejecución — no solo esconde el
botón. Nada más en la arquitectura depende de esa constante.

Deliberadamente **no** es una variable de entorno: reintroducir `VITE_*` para gobernar
comportamiento es el camino por el que volvieron DEMO y CLEAN.

---

## Resumen de rutas

| Ruta | Quién | Qué muestra |
|---|---|---|
| `/owner/login` | Plataforma | Sin Owners → «Crear primer Owner». Con Owners → login |
| `/owner` | Owner | Dashboard RutaCash |
| `/owner/empresas` | Owner | Listado y alta de empresas |
| `/owner/cobros` | Owner | Cobros SaaS |
| `/owner/configuracion` | Owner | Owners + Zona de pruebas |
| `/login` | Empresa | Login. Sin usuarios → aviso con enlace a `/owner/login` |
| `/admin/*`, `/collector/*`, … | Empresa | Operación del cliente |
