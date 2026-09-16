# RutaCash — Oficinas y cierre de semana

**Informe para el socio · Septiembre de 2026**

---

## 1. En una frase

RutaCash ya organiza la empresa por **Oficinas**, y la liquidación semanal dejó de
ser un número en pantalla para convertirse en un **documento guardado** que cierra la
semana y protege las cifras.

---

## 2. Qué problema resolvimos

Antes, RutaCash veía la empresa como una lista plana de rutas. Si usted tenía doce
rutas en tres ciudades, las veía las doce juntas, sin manera de preguntar "¿cómo va
Barranquilla?".

Y la liquidación semanal se calculaba, se miraba y se perdía. Al día siguiente el
mismo cálculo podía dar otro número, porque alguien había corregido un pago viejo.
No había forma de decir *"esta semana ya está cerrada, estas son sus cifras y no se
tocan"*.

Las dos cosas están resueltas.

---

## 3. Qué es una Oficina

Una **Oficina** es una agrupación de rutas: una ciudad, una sede, una zona. Sirve
para mirar el negocio por partes en lugar de todo revuelto.

Tres cosas importantes:

- Una Oficina **puede existir sin rutas** (la crea hoy, le asigna rutas mañana).
- Una ruta **puede existir sin Oficina**. Esas aparecen agrupadas como
  **"Sin Oficina"**, con toda normalidad. No es un error ni algo pendiente.
- Crear una ruta **no** obliga a elegir Oficina.

---

## 4. La regla que no cambia nunca

> **La Oficina organiza. La Ruta manda sobre quién ve qué.**

Esto merece leerse dos veces, porque es la garantía de que nadie ve lo que no debe:

**Que una persona tenga una ruta de la Oficina Barranquilla NO le da acceso a las
demás rutas de Barranquilla.** Sigue viendo exactamente las rutas que usted le
asignó, ni una más.

La Oficina es una forma de **mirar**. El permiso sigue viniendo, como siempre, de las
rutas asignadas a cada persona. Agrupar no reparte llaves.

---

## 5. Los usuarios no pertenecen a una Oficina

Sus empleados son **de la empresa**, no de una sede. Una supervisora puede tener dos
rutas en Barranquilla y una en Santa Marta sin ningún problema, y en su pantalla verá
esas tres agrupadas por Oficina.

Esto tiene una consecuencia práctica que cuidamos especialmente: **editar las rutas
de una persona desde el panel de una Oficina no le quita las rutas que tenga en otra
Oficina.** Solo se toca lo que usted está viendo.

---

## 6. Qué ve usted ahora en pantalla

**En el panel de la empresa**: una tarjeta por Oficina con sus clientes, su cartera y
lo recaudado hoy, más un comparativo entre Oficinas. Es una lectura, no un ranking:
no hay "la mejor" ni "la peor", hay números al lado de números.

**Al entrar a una Oficina**: sus rutas, sus indicadores del día, su cartera, su caja
consolidada, las personas relacionadas, las alertas y ahora también sus
**liquidaciones**.

**Cuando su alcance es parcial**, la pantalla lo dice. Si usted solo tiene autorizadas
2 de las 4 rutas de una Oficina, verá "2/4 rutas" en lugar de un total que aparente
ser el de toda la Oficina. Preferimos un número honesto a uno cómodo.

---

## 7. Cerrar la semana

En **Liquidación semanal** hay ahora dos acciones distintas:

| Acción | Qué hace |
|---|---|
| **Generar** | Calcula y muestra. Es una vista previa. No guarda nada. |
| **Cerrar semana** | **Guarda la liquidación** como documento y cierra el período. |

Al cerrar, las cifras de esa semana quedan **congeladas**. Quedan guardados también
quién cerró y cuándo.

Se cierra **por ruta**, nunca por Oficina entera. Cada ruta es una caja independiente,
y sumarlas en una sola liquidación mezclaría cajas distintas.

---

## 8. Qué protege el cierre

Esta es la parte que más le interesa al negocio.

**Con la semana abierta**, el Secretario corrige un pago mal registrado directamente.

**Con la semana cerrada**, ya no puede. El sistema le dice que el pago está en un
período cerrado y le genera una **Solicitud de ajuste**, que tiene que aprobar un
Administrador.

Es decir: después de cerrar, **nadie toca las cifras de esa semana sin que quede
constancia y sin que alguien con mando lo autorice.**

Un detalle que importa: cuenta **la fecha en que se cobró el dinero**, no la fecha en
que se digitó. Un pago que se recibió el miércoles pero se registró dos semanas
después pertenece a la semana del miércoles, y queda protegido por el cierre de esa
semana.

---

## 9. Reabrir una semana

A veces hay que corregir algo de una semana ya cerrada. Se puede, pero de forma
controlada:

1. Solo un **Super Administrador** o un **Administrador** puede reabrir, y solo en
   rutas que tenga autorizadas.
2. **El motivo es obligatorio.** Sin escribirlo, el botón no funciona.
3. El motivo queda guardado **para siempre**, junto con quién reabrió y cuándo.
4. Reabrir **no borra nada**. El documento del cierre se conserva entero.

Mientras la semana está reabierta, los pagos de esas fechas vuelven a ser corregibles
directamente. Al terminar, se vuelve a cerrar.

---

## 10. El historial: nada se sobrescribe

Cuando usted cierra, reabre, corrige y vuelve a cerrar, RutaCash **no borra el cierre
anterior**. Guarda un cierre nuevo, lo numera como **versión 2**, y deja la versión 1
enlazada a él.

Así el recorrido completo queda a la vista:

> Se cerró la semana con $4.000 → se reabrió porque *"el cobro del miércoles quedó mal
> digitado"* → se corrigió → se volvió a cerrar con $9.000.

Las dos versiones siguen ahí. Cualquiera puede reconstruir qué pasó y por qué.

---

## 11. La Oficina queda grabada en el cierre

Cuando se cierra una semana, RutaCash graba en el documento **en qué Oficina estaba
esa ruta en ese momento**.

¿Por qué importa? Porque las rutas se reorganizan. Si en noviembre usted mueve la
Ruta Centro de Barranquilla a Santa Marta, la liquidación de septiembre debe seguir
diciendo **Barranquilla**. Si no lo grabáramos, reorganizar el catálogo reescribiría
el pasado.

Si la ruta no tenía Oficina, el cierre dice **"Sin Oficina"**. No se inventa ninguna.

---

## 12. El CSV de una semana cerrada

Cuando usted descarga el CSV de una liquidación cerrada, sale **del documento
guardado**, no de un cálculo nuevo.

Esto es deliberado. Si se recalculara, un pago corregido meses después cambiaría el
CSV de una semana ya cerrada, y el archivo dejaría de servir como prueba de nada. El
CSV incluye además el estado, la versión, el motivo de la reapertura si la hubo y la
Oficina del cierre.

---

## 13. Quién puede hacer cada cosa

| Rol | Cerrar semana | Reabrir | Corregir pago con la semana cerrada |
|---|---|---|---|
| Super Administrador | Sí | Sí | Sí |
| Administrador | Sí, en sus rutas | Sí, en sus rutas | Sí |
| Socio | No | No | No (solo consulta) |
| Supervisor | No | No | No |
| Cobrador | No | No | No |
| Secretario | No | No | No — genera Solicitud de ajuste |

El Secretario es quien más nota el cambio: es exactamente a quien el cierre le
restringe la corrección directa, y por eso **no puede levantarlo él mismo**.

Cerrar y reabrir se validan siempre **contra las rutas autorizadas**. Tener el cargo
de Administrador no alcanza: hay que tener esa ruta asignada.

---

## 14. Cómo comprobarlo usted mismo

Diez pruebas, en orden. Puede hacerlas en la versión DEMO sin miedo a dañar nada.

1. **Cree una Oficina** desde el menú Oficinas. Póngale nombre y código. Debe poder
   crearla **sin asignarle ninguna ruta**.

2. **Cree una ruta sin elegir Oficina.** Debe dejarla crear, y la ruta debe aparecer
   agrupada bajo **"Sin Oficina"**.

3. **Asigne esa ruta a la Oficina** que creó. Entre a la Oficina: la ruta debe
   aparecer en su lista, con sus indicadores sumados a los de la Oficina.

4. **Compruebe la regla de acceso.** Tome un usuario que tenga **una sola** ruta de
   una Oficina con varias rutas, e ingrese con él. Debe ver **solo su ruta**, nunca
   las hermanas. Si su alcance es parcial, la pantalla debe decirlo (por ejemplo
   "1/3 rutas").

5. **Genere una liquidación.** Vaya a Liquidación semanal, elija la ruta y la semana,
   y pulse **Generar**. Aparecen las cifras. Todavía **no** hay nada guardado.

6. **Cierre la semana.** Pulse **Cerrar semana**. Debe aparecer en el **historial de
   liquidaciones archivadas**, con su semana, su **versión 1**, su **Oficina al
   cierre** y su saldo final.

7. **Intente cerrarla otra vez.** El sistema debe impedirlo y explicar que la semana
   ya está cerrada y hay que reabrirla primero.

8. **Intente corregir un pago de esa semana con el usuario Secretario.** Debe
   rechazarlo y ofrecer generar una **Solicitud de ajuste**. Esa solicitud debe
   aparecerle al Administrador para aprobar o rechazar.

9. **Reabra la semana.** Primero intente reabrir **sin escribir motivo**: no debe
   dejarlo. Escriba el motivo y confirme. El estado debe pasar a **"Período
   reabierto"**, el motivo debe quedar visible, y el Secretario debe poder volver a
   corregir directamente.

10. **Vuelva a cerrar y mueva la ruta de Oficina.** Tras recerrar debe aparecer una
    **versión 2**, con la versión 1 todavía en la lista marcada como sustituida.
    Ahora mueva la ruta a otra Oficina y vuelva al historial: los cierres anteriores
    deben **seguir mostrando la Oficina original**. Descargue su CSV y confirme que
    dice lo mismo.

Si las diez se comportan así, lo entregado funciona.

---

## 15. Qué **no** incluye esta entrega

Con toda claridad, para que no haya sorpresas:

- **No hay servidor ni sincronización entre dispositivos.** RutaCash sigue guardando
  todo en el navegador del equipo donde se usa. Dos equipos no comparten datos.
- **No hay cierre consolidado por Oficina.** Es una decisión, no un olvido: cada ruta
  es una caja independiente y sumarlas en una sola liquidación mezclaría cajas
  distintas.
- **No hay PDF** de Oficina ni de liquidación. Las exportaciones son en CSV, que se
  abre en Excel.
- **Los cierres de semanas anteriores a esta actualización** no muestran Oficina, y
  aparecen con un guion. Es a propósito: no sabemos en qué Oficina estaba esa ruta
  entonces, y ponerle la Oficina actual sería inventar historia.

---

### Sobre la verificación

Lo entregado se apoya en **932 pruebas automáticas**, todas en verde. Entre ellas hay
seis recorridos completos que reproducen, de principio a fin, lo que haría una
persona real: crear la Oficina, registrar el pago, cerrar la semana, comprobar que el
Secretario ya no puede corregir, reabrir con motivo, recerrar y mover la ruta de
Oficina.
