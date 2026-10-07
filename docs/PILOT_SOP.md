# Guía de operación del piloto

Para el propietario y los gerentes de turno de un restaurante piloto, y para quien
instala el equipo. Borrador del 5 de octubre de 2026, escrito sobre `integration/v1`
(la versión que hoy reúne acceso, servicio, menú y venta sin conexión).

**Estado.** Nada de esta guía se ha probado todavía con impresoras térmicas reales,
tablets reales ni una caída real de internet; esas pruebas son condición para el
piloto ([recuperación sin conexión, "Verification"](OFFLINE_RECOVERY.md#verification)).
Esta versión todavía no está en producción: el lanzamiento lo hace el dueño del
negocio con [la entrega de lanzamiento](LAUNCH_HANDOFF.md).

**Convención.** El texto entre comillas angulares (« ») es exactamente lo que dice la
pantalla de Green Monkey; dentro de él, N, HH:mm y … marcan un número, una hora o un
importe que cambia. Los enlaces a otros documentos (en inglés) son para quien instala o da
soporte; esta guía no repite su contenido.

## 1. Impresión y equipo

### 1.1 Cómo imprime Green Monkey hoy

- **Solo a través del diálogo de impresión del navegador.** No hay conexión directa
  con la impresora (USB, red o Bluetooth) ni comandos propios de impresora térmica.
  Green Monkey no corta el papel ni abre el cajón de dinero: eso lo hace, o no, el
  controlador de la impresora en el sistema operativo (sección 1.2).
- **El navegador nunca confirma que salió papel.** La misma app lo avisa: «La
  impresión del navegador no confirma que salió papel.» Revisa el papel; si no salió,
  vuelve a imprimir.
- **Qué se imprime y desde dónde:**

| Documento | Dónde se imprime | Qué lo distingue en el papel |
| --- | --- | --- |
| Recibo | Pantalla del recibo después de «Confirmar cobro» → «Imprimir recibo» | Productos, notas, pagos, cambio |
| Reimpresión del recibo | Detalle de la orden → «Reimprimir recibo» | «REIMPRESIÓN» |
| Cuenta (antes de cobrar) | Detalle de la orden → «Imprimir cuenta» | «Cuenta · no es comprobante de pago» |
| Comanda | Al enviar, si el dispositivo tiene «Imprimir comanda al enviar a cocina»; en «Cocina», «Imprimir comanda» en cada ticket; con ese mismo ajuste, «Reimprimir comanda» después de editar una nota | Una sección por estación (cocina y barra) en el mismo trabajo de impresión |
| Comanda sin conexión | Al guardar una venta sin conexión, «Imprimir comanda»; o en «Comandas (N)» → «Reimprimir» | «COMANDA · SIN CONEXIÓN» y el número provisional |
| Recibos de un cobro conjunto | «Órdenes» → «Cobrar juntas» → «Imprimir recibos (N)» | Un recibo por orden |

- **Ajustes de impresión (por dispositivo).** Se guardan en el navegador de cada
  dispositivo, así que se configuran en cada uno:
  - En «Vender», el botón de impresora («Impresión»); en «Cocina», el botón
    «Impresión». Ahí están «Ancho de papel» («80 mm» o «58 mm»), «Imprimir comanda al
    enviar a cocina» (en Vender, apagado de fábrica) e «Imprimir tickets nuevos
    automáticamente en esta pantalla» (en Cocina, apagado de fábrica).
  - La pantalla del recibo también ofrece «Ancho de papel».
  - En «Sincronización», «Al guardar sin conexión»: «Preguntar» (de fábrica),
    «Imprimir comanda» o «Imprimir comanda y recibo».
- **Detalle técnico para quien instala.** `printDocument()` en `src/print.tsx` dibuja un
  solo documento dentro de `#print-root`, oculta el resto de la página y llama a
  `window.print()`. Las reglas de impresión de `src/styles.css` fijan solo el ancho del
  contenido (72 mm en papel de 80 mm, 48 mm en papel de 58 mm) y `@page { margin: 0 }`
  sin tamaño de página: **el largo lo define el rollo configurado en el controlador**.
  Cuando un envío lleva comandas de dos estaciones, cada una es una sección con salto
  de página. Más detalle: [Service, "Printing (browser/OS)"](SERVICE.md#printing-browseros).

### 1.2 Configurar la impresora térmica (58 u 80 mm) en el sistema operativo

Lista para quien instala, en cada equipo que imprime. Los nombres exactos de las
opciones cambian según el fabricante y el sistema; consulta el manual del controlador.

1. **Controlador.** Instala el controlador del fabricante para el sistema del equipo
   (Windows o macOS) e imprime su página de prueba desde la configuración de
   impresoras del sistema.
2. **Tamaño de papel.** El ancho del rollo (80 mm o 58 mm). Si el controlador ofrece un
   tamaño de rollo continuo o de recibo, úsalo: Green Monkey no fija el largo.
3. **Márgenes: ninguno**, en el controlador y en el diálogo de impresión del navegador.
4. **Escala: 100 %.** No uses la opción de ajustar a la página: encoge el texto.
5. **Encabezados y pies de página del navegador:** desactívalos si en el ticket salen la
   fecha o la dirección de la página.

   **Pasos 3 a 5 sin verificar.** Son una guía general del navegador y no se han
   probado en un equipo real. Los nombres y opciones del diálogo cambian según el
   navegador; confírmalos en la prueba del paso 10. Lo único fijo es lo que pide Green
   Monkey: `@page { margin: 0 }` y ningún tamaño de página (sección 1.1).
6. **Ancho en Green Monkey:** «Ancho de papel» igual al rollo instalado.
7. **Corte automático:** es una función del controlador o de la impresora (por ejemplo,
   cortar al final de cada documento o de cada página). Green Monkey no envía la orden
   de corte. Prueba con un envío que tenga cocina y barra para ver si cada estación sale
   cortada por separado.
8. **Apertura del cajón de dinero:** el cajón se conecta a la impresora y, si el
   controlador tiene esa opción, lo abre al imprimir. Green Monkey no abre el cajón.
   Antes del piloto, decide con el propietario y prueba:
   - si el controlador lo abre en cada documento, también se abrirá al imprimir
     comandas y cuentas en esa impresora;
   - si el cajero no imprime el recibo, el cajón no se abre: define quién guarda la
     llave del cajón o si el recibo de efectivo se imprime siempre;
   - algunos controladores permiten una segunda impresora en el sistema (otra cola
     para el mismo equipo) con otra configuración; verifica en el manual si el tuyo lo
     permite antes de contar con ello.
9. **Impresora predeterminada:** en la caja, deja la térmica como impresora
   predeterminada del sistema. Por defecto Chrome propone la última impresora usada;
   la política administrada `PrintPreviewUseSystemDefaultPrinter` (documentación de
   políticas de Chrome Enterprise) hace que proponga la del sistema.
10. **Prueba completa** en cada dispositivo: un recibo, una cuenta, una comanda con
    cocina y barra, una reimpresión y una comanda sin conexión, con el ancho que usará
    el restaurante.

### 1.3 Imprimir sin diálogo (modo kiosco) según el navegador

En «Cocina», la ventana «Impresión» dice, debajo de «Imprimir tickets nuevos
automáticamente en esta pantalla»: «La impresión sin diálogo no está confirmada: con esta
opción, cada ticket nuevo abre el diálogo de impresión. Sigue la guía del piloto, sección
1.3.» (en inglés: «Printing without a dialog is not confirmed: with this option, each new
ticket opens the print dialog. Follow the pilot guide, section 1.3.»). La guía del piloto
es esta guía («Guía de operación del piloto») y la sección 1.3 es esta. Con la impresión
automática activada, alguien debe tocar «Imprimir» o «Cancelar» en cada diálogo, que
cubre la pantalla de cocina mientras está abierto. La app ya no recomienda abrir Chrome con
impresión de kiosco: ninguna documentación oficial que consultamos lo confirma (LD-17; se
volvió a consultar la documentación de políticas de Chrome Enterprise y la de Chromium el 6
de octubre de 2026).

**Hoy no existe una forma confirmada de imprimir sin diálogo.** Con los pasos siguientes,
el diálogo del navegador aparece en cada recibo, cuenta y comanda.

**Pasos de impresión del piloto, en cada equipo que imprime:**

1. Configura la impresora térmica en el sistema operativo (sección 1.2, pasos 1 a 9) y
   déjala como impresora predeterminada del sistema.
2. En Chrome administrado, activa la política `PrintPreviewUseSystemDefaultPrinter`
   para que el diálogo proponga esa impresora (sección 1.2, paso 9).
3. Cada impresión abre el diálogo del navegador: revisa que el destino sea la térmica y
   confirma con «Imprimir». Cuenta con este paso en cada recibo, cuenta y comanda.
4. Haz la prueba completa de la sección 1.2, paso 10, y revisa que salió papel (el
   navegador nunca lo confirma).
5. Si el propietario quiere probar la opción de inicio `--kiosk-printing` en Windows,
   hazlo solo como prueba en ese equipo, con los pasos 1 a 4 ya hechos, y anota el
   resultado: no está confirmada en documentación oficial (tabla siguiente) ni probada por
   nosotros, así que el piloto no depende de ella.

Lo que podemos afirmar hoy por navegador:

| Navegador | Qué está confirmado en documentación oficial | Qué no está confirmado |
| --- | --- | --- |
| Chrome (Windows, macOS) | Las políticas administradas `PrintPreviewUseSystemDefaultPrinter` (destino predeterminado = impresora del sistema) y `DisablePrintPreview` (abre el diálogo del sistema en lugar de la vista previa de Chrome). Ninguna de las dos imprime sin diálogo. | La opción de inicio `--kiosk-printing`. No aparece en la documentación oficial que consultamos (políticas de Chrome Enterprise y documentación de Chromium); [Service](SERVICE.md#printing-browseros) la cita de fuentes públicas como funcional en Windows. No se ha probado. |
| Edge | — (no consultamos su documentación) | Impresión sin diálogo. |
| Firefox | La opción `--kiosk` abre Firefox en pantalla completa. | Impresión sin diálogo. |
| Safari en iPad o iPhone | — | Imprime con AirPrint ([limitaciones físicas](OFFLINE_RECOVERY.md#physical-limitations)); la mayoría de las impresoras térmicas no son compatibles con AirPrint. No lo verificamos en un iPad real. |
| Chrome en Android | — | Necesita un servicio de impresión del fabricante de la impresora. No se ha probado. |

**Para el piloto, cuenta con que el diálogo de impresión aparece cada vez.** La
impresión automática en «Cocina» solo es práctica en un equipo donde se compruebe que
imprime sin diálogo. Si la cocina no tiene impresora o el iPad no puede imprimir, la
pantalla de cocina y la lista «Comandas (N)» de la caja son la alternativa.

## 2. Tablets y vinculación

El procedimiento completo y sus reglas están en
[Access, "Pairing a terminal"](ACCESS.md#pairing-a-terminal) y
["Runbooks"](ACCESS.md#runbooks). Lo esencial para el turno:

- **Navegadores compatibles:** Chrome o Edge 111+, Safari 16.4+ (iPadOS/iOS 16.4 o
  posterior) y Firefox 114+ ([lista y requisitos](OFFLINE_RECOVERY.md#supported-browsers)).
- **Vincular una tablet:** el propietario o un gerente abre «Configuración» →
  «Dispositivos» → «Vincular un dispositivo», escribe el «Nombre del dispositivo»
  (por ejemplo «Caja 1», «Cocina», «Barra») y toca «Generar código». En la tablet,
  abre la dirección de Green Monkey con `/app`, elige «Vincular este dispositivo»,
  escribe el «Código de vinculación» y toca «Vincular». El código sirve una sola vez y
  vence en 10 minutos. Después, cada persona toca su nombre en «¿Quién entra?» y
  escribe su PIN.
- **Instala la app en la pantalla de inicio** («Instala Green Monkey en la pantalla de
  inicio para conservar mejor los datos sin conexión.»). En iPad, vincula e inicia
  sesión dentro de la app instalada y no alternes entre Safari y la app mientras haya
  ventas sin sincronizar ([detalle](OFFLINE_RECOVERY.md#storage-persistence-and-installing)).
- **Nunca abras la cuenta de Google del propietario en una tablet compartida.** La app
  lo recuerda: «Esta es una terminal compartida. La cuenta del propietario (Google) se
  administra desde tu propio teléfono o computadora.» Para entrar en las cajas, el
  propietario usa su «Mi PIN para terminales compartidas» (en «Equipo»).
- **Plan Free:** «En Free solo un dispositivo inicia ventas. Si este será tu caja,
  selecciónalo en «Registro y equipo Free».» Free también limita el equipo a dos
  empleados además del propietario ([límites](FREE_LIMITS.md)). Para un piloto con
  varias cajas, el acceso Pro lo otorga soporte: **pendiente** (llega con la ola 2,
  área de cuenta). Hasta entonces, solo el dispositivo seleccionado abre caja y vende.
- **Bloqueo:** las sesiones con PIN se bloquean solas a los 3 minutos sin uso (cocina
  nunca, de fábrica). Se cambia por dispositivo en «Dispositivos» → «Editar» →
  «Bloqueo automático». Al alejarte de la caja, toca «Bloquear pantalla».
- **Cocina:** desactiva el apagado automático de pantalla en el sistema de la tablet y
  toca «Activar sonido» después de cada recarga (el navegador bloquea el sonido hasta
  que alguien toca la pantalla).
- **Hora automática:** deja activada la hora automática del sistema. Si la hora de la
  tablet se desvía, la app avisa «La hora de este dispositivo difiere N min de la del
  servidor. Activa la hora automática.»
- **No borres los datos del navegador** de una tablet vinculada: eso la desvincula y
  borra las ventas que no se hayan sincronizado.
- **Tablet perdida o robada:** desde otro dispositivo, «Dispositivos» → «Desvincular».
  Si tenía la caja abierta, sigue el runbook de [Access](ACCESS.md#runbooks).

## 3. Conexión y venta sin conexión

Todo el comportamiento está en [recuperación sin conexión](OFFLINE_RECOVERY.md)
("What staff see", "What can be done offline"). Para el turno:

- **Qué ve el cajero.** Arriba siempre hay un indicador de conexión: «Conectado»,
  «Conexión lenta», «Sin conexión» o «Sin conexión (manual)», más «N por sincronizar»
  cuando la persona que inició sesión tiene ventas guardadas en este dispositivo que
  aún no se sincronizan. Las ventas de otras personas en la misma tablet no se cuentan
  en ese indicador. Sin conexión aparece el aviso «Sin conexión con el servidor. Las
  ventas se guardan en este dispositivo y se envían al volver la conexión.» y la línea
  «Puedes vender sin conexión hasta las HH:mm.»
- **Prepárate con conexión.** Abre caja mientras hay conexión: abrir y cerrar caja, las
  salidas de efectivo, anulaciones, reembolsos, dividir por productos y «Cobrar juntas»
  no funcionan sin conexión.
- **Qué se puede hacer sin conexión** (con la configuración de fábrica):
  - Órdenes nuevas **cobradas completas**. En «Cobrar», con «Efectivo», el botón dice
    «Guardar cobro en este dispositivo»; con «Terminal externa», «Guardar cobro con
    terminal» (confirma la aprobación y escribe la referencia; no se verifica con el
    banco).
  - El recibo muestra un número provisional («Número provisional …» y «El número
    definitivo se asigna al sincronizar.»).
  - **La cocina no recibe nada por la red.** Imprime la comanda o cántala en voz alta;
    «Comandas (N)» en el aviso lista las comandas sin conexión de las últimas 24 horas
    con «Reimprimir». La pantalla de cocina sin conexión dice: «Sin conexión: esta
    pantalla no recibe pedidos nuevos. Pide las comandas impresas o en voz al
    mostrador.»
- **Cuentas abiertas.** Una cuenta que ya estaba abierta muestra «Disponible al volver
  la conexión. Sin conexión, esta cuenta no acepta productos ni cobros en este
  restaurante.» Eso es porque «Servicio de mesa sin conexión» («Beta») viene apagado
  ([detalle](OFFLINE_RECOVERY.md#table-service-offline-beta-off-by-default)).
  **Recomendación para el piloto: déjalo apagado.**
- **«Trabajar sin conexión».** Si la conexión está lenta («La conexión está lenta. Si
  los cobros tardan, trabaja sin conexión.»), cualquier persona puede tocar «Trabajar
  sin conexión» (en ese aviso o en «Sincronización»). Para regresar, «Volver a
  conectarme».
- **Inventario.** Las ventas guardadas sin conexión (también en «Trabajar sin
  conexión») se registran al sincronizar aunque el restaurante tenga «Bloquear la
  venta» en «Cuando un insumo llega a cero»; el insumo queda en «Negativo». Un producto
  marcado como no disponible después de que la tablet guardó el menú sí va a revisión
  de un gerente. Es una decisión aceptada
  ([política de inventario negativo](MENU.md#ingredients-and-the-stock-engine),
  ["Stock policy at sync"](OFFLINE_RECOVERY.md#sync-retries-and-exactly-once)).
- **Cuando termina el periodo sin conexión:** «El periodo sin conexión terminó a las
  HH:mm. No se pueden guardar ventas nuevas hasta reconectar e iniciar sesión. Usa
  papel y captúralas después.» Anota en papel cada venta (hora, productos, total, forma
  de pago); al capturarlas después quedan con la fecha y hora de captura, así que
  conserva la hoja con el corte del día.
- **Al volver la conexión**, las ventas se envían solas mientras la persona que las
  guardó tenga la sesión abierta en ese dispositivo (o cuando vuelva a entrar en él).
  En «Cocina» aparece «Ventas sin conexión por revisar (N)»: toca «Ya se preparó» si la cocina ya la hizo con la
  comanda, o «Preparar ahora» si falta. Las filas «Requiere revisión» en
  «Sincronización» las resuelve un gerente
  ([revisión y archivo](OFFLINE_RECOVERY.md#authenticity-eligibility-review-and-archive)).
- **Respaldo:** si una tablet va a cambiarse o algo falla, en «Sincronización» toca
  «Descargar pendientes» antes de tocar nada más.

## 4. Abrir y cerrar turno

La caja pertenece al **dispositivo**, no a la persona: cada dispositivo que cobra
abre su propia caja, y quien cambia de turno en la misma tablet continúa con la misma
caja. Si el propietario quiere un conteo por cajero, un gerente cierra la caja al
cambio de turno y el siguiente cajero abre otra.

### 4.1 Abrir turno

Antes del primer día del piloto, el propietario llena «Configuración» → «Datos
fiscales» (con su PIN) exactamente como en su Constancia de Situación Fiscal y revisa
que diga «Completo». Si el mismo RFC tiene otros locales, marca «Este RFC tiene más de
una sucursal» y escribe el domicilio de este local. Sin esos datos, cada ticket dice
«Ticket sin datos fiscales del emisor.».

1. Enciende el módem, la impresora (con papel) y las tablets.
2. En la caja, toca tu nombre en «¿Quién entra?» y escribe tu PIN.
3. Revisa que el indicador de conexión diga «Conectado». Si dice «Sin conexión»,
   espera: abrir caja necesita conexión.
4. Si aparece «Hay una nueva versión lista.», toca «Actualizar ahora» antes de empezar
   (no se aplica mientras haya ventas sin sincronizar: «Sincroniza las ventas
   pendientes antes de actualizar.»).
5. Abre la caja. El cajero entra a «Caja»; el propietario o un gerente, a «Operación» →
   «Caja». La pantalla dice «Caja cerrada» y ofrece «Abrir caja». En la ventana «Abrir
   caja», escribe en «Importe» el fondo que contaste (el campo trae 500.00 escrito:
   cámbialo por lo que realmente hay) y toca «Guardar». La pantalla muestra «Caja
   abierta», «Fondo inicial» y «Efectivo esperado».
6. Repite en cada dispositivo que vaya a cobrar. Sin caja abierta, «Cobrar» avisa «Abre
   caja en este dispositivo antes de cobrar.» con el botón «Ir a Caja».
7. En la cocina, la persona de cocina entra con su PIN, elige la «Estación» («Todas»,
   «Cocina» o «Barra») y toca «Activar sonido».
8. En cada dispositivo que cobra, un gerente abre «Sincronización»: ahí ve las ventas
   pendientes de todas las personas en ese dispositivo (el indicador de conexión solo
   cuenta las de quien tiene la sesión abierta). «Reintentar sincronización» solo envía
   las de quien tiene la sesión abierta. Las ventas de cada persona se envían cuando
   esa persona vuelve a entrar en este dispositivo; si no puede regresar, el gerente
   las revisa (concilia o archiva). Lo que quede en «Requiere revisión» también lo
   resuelve un gerente.

### 4.2 Durante el turno

- **«Efectivo esperado»** suma el fondo inicial y los cobros en efectivo con su
  propina, y resta los reembolsos hechos desde esa caja y las salidas de efectivo.
- **Reembolsos:** solo de cobros en efectivo. Un gerente o el propietario los hace
  desde el detalle de la orden («Reembolsar», con «Motivo del reembolso») en un
  dispositivo con caja abierta; el dinero sale de esa caja. Una cuenta con saldo
  pendiente y sin ticket no se reembolsa: antes de cobrarla, anula las líneas.
- **Salidas de efectivo** (pago a un proveedor, retiro de propinas): un gerente toca
  «Registrar salida» en «Caja», escribe el importe y el motivo y, si la app lo pide
  («Confirma con tu PIN»), confirma con su PIN.
- **Mesas pagadas:** una cuenta en mesa pagada queda «Pagada · por liberar» hasta que
  alguien toca «Liberar mesa». Al pagarse recibe su ticket con folio, así que ya no
  admite más productos: si la mesa pide algo más, envíalo con «Enviar como orden
  nueva» para la misma mesa (otra cuenta con su propio ticket).
- **Ticket de una venta sin conexión:** el cliente se lleva un recibo con «Número
  provisional» (por ejemplo B-07). Cuando la venta se sincroniza, búscala en «Órdenes»
  escribiendo ese número; el detalle muestra el folio y «Reimprimir recibo» imprime el
  ticket con folio.

### 4.3 Cerrar turno

1. **Cuentas abiertas.** En «Órdenes», pestaña «Abiertas», cobra o revisa lo que siga
   abierto y toca «Liberar mesa» en las mesas pagadas. Los números de orden empiezan de
   nuevo cada día a la hora de «Cierre del día de negocio» (las 04:00 si el propietario
   no la cambió): después de esa hora, una orden que siga abierta de un día anterior
   muestra su fecha junto al número, por ejemplo «#10 · 5 oct», en «Órdenes», en
   «Cocina» y en las comandas impresas. Es otra orden que el «#10» de hoy.
2. **Sincroniza.** El indicador de conexión no debe mostrar «N por sincronizar». Si
   lo muestra, abre «Sincronización» → «Reintentar sincronización». Mientras haya
   ventas pendientes en el dispositivo, cerrar caja se niega con «Sincroniza las
   ventas pendientes de este dispositivo antes de cerrar caja.» Si tu indicador ya no
   muestra pendientes y aun así cerrar caja se niega, las ventas pendientes son de otra
   persona en este dispositivo: que esa persona entre y sincronice, o un gerente las
   revisa en «Sincronización».
3. **Cuenta el efectivo** antes de abrir la ventana de cierre y anota el conteo en
   papel (la ventana muestra el esperado; contar primero evita dejarse llevar por él).
4. **Cierra en el mismo dispositivo.** El cajero no ve «Cerrar caja»: lo hace el
   propietario o un gerente en esa tablet (el cajero toca «Bloquear pantalla», luego
   «Cambiar de usuario»; el gerente elige su nombre y escribe su PIN). En «Caja» →
   «Cerrar caja», la ventana muestra «Efectivo esperado». Escribe el conteo en «Efectivo
   contado». Si no coincide, explica la diferencia en «Explicación» (sin explicación
   la app responde «Explica la diferencia antes de cerrar.»). Toca «Guardar». La
   pantalla vuelve a «Caja cerrada» y muestra la «Diferencia».
5. **Ventas archivadas.** Si en este dispositivo un gerente archivó ventas sin
   conexión, la ventana lo avisa («Este dispositivo archivó … de ventas locales de esta
   caja. Ese efectivo puede aparecer como sobrante.»). Explícalo en «Explicación».
6. **Corte.** Al cerrar la caja, imprime el corte Z (o el comprobante de conteo si tu rol
   no ve el efectivo esperado) desde la ventana del cierre. El propietario o un gerente
   imprime el corte del día en «Finanzas → Resumen → Corte del día» y reimprime cortes Z
   en «Historial de cajas» (en «Caja») o en «Finanzas → Cortes». Guarda la hoja del
   conteo, la bitácora de dólares (sección 5) y cualquier venta en papel con el corte del
   día.
7. **Cocina.** Marca como entregados los tickets servidos («Marcar entregado»). Si
   quedan tickets de días anteriores, un gerente ve «Retirar tickets de días
   anteriores (N)».
8. **Salir.** Toca «Salir». Si aparece «Ventas sin enviar», no te vayas: sincroniza o
   avisa a un gerente. Deja las tablets cargando y encendidas.

## 5. Moneda: solo pesos mexicanos (MXN)

Esta versión cobra **solo en pesos**. No existe una forma de pago en dólares ni
conversión de moneda: los métodos de cobro son «Efectivo» y «Terminal externa», en la
moneda del restaurante.

- La moneda del restaurante está en «Configuración» → «Datos del restaurante» →
  «Moneda» y debe quedarse en **MXN**. No la cambies a USD: cambiaría la moneda de todo
  el restaurante, no agregaría una segunda forma de pago, y se bloquea en cuanto hay
  importes registrados («La moneda está bloqueada porque ya existen importes
  registrados. No se convierten importes históricos.»). Los tickets fiscales y las
  facturas que vienen en la ola 2 también son en pesos.

### 5.1 Dólares en efectivo (restaurantes de la frontera)

Procedimiento para recibir dólares en efectivo **fuera de la app**, registrando siempre
pesos. Antes del piloto, el contador del restaurante confirma qué tipo de cambio usar y
cómo conservar la bitácora.

1. **Antes de abrir**, el propietario o un gerente fija el tipo de cambio del turno
   (pesos por dólar) y la regla de redondeo del cambio. Los escribe en un letrero
   visible en la caja y en la primera línea de la bitácora en papel (fecha, tipo de
   cambio, quién lo fijó). No cambia durante el turno.
2. **Al cobrar**, el cliente entrega dólares. Calcula fuera de la app: dólares × tipo de
   cambio = pesos. En «Cobrar», elige «Efectivo» y escribe ese resultado en pesos en
   «Efectivo recibido». Green Monkey calcula el «Cambio» en pesos; entrégalo en pesos,
   con la regla de redondeo del letrero.
3. **Guarda los dólares aparte** (un sobre o compartimento solo para dólares), nunca
   mezclados con los pesos.
4. **Anota en la bitácora** cada cobro: hora, número de orden, dólares recibidos, tipo
   de cambio, pesos escritos en «Efectivo recibido», cambio entregado e iniciales de
   quien cobró. Si el cliente deja propina en dólares y la registras en «Propina»,
   conviértela igual, escríbela en pesos y anótala.
5. **No uses «Terminal externa»** para registrar dólares en efectivo. Este procedimiento
   cubre solo efectivo en dólares.
6. **Al cerrar caja** (sección 4.3): cuenta los pesos; cuenta los dólares del sobre y
   compáralos con el total de dólares de la bitácora; multiplica los dólares contados
   por el tipo de cambio del turno y súmalos a los pesos. Esa suma va en «Efectivo
   contado». En «Explicación» escribe siempre cuántos dólares hay y su equivalente,
   por ejemplo: Incluye USD 40 a 17.50 = MXN 700 según bitácora. Las diferencias por
   redondeo del cambio aparecen como centavos de diferencia.
7. Entrega el sobre de dólares y la bitácora al propietario con el corte del día.

## 6. Lo que todavía no está en esta versión

| Función | Estado | Mientras tanto | Dónde se documentará |
| --- | --- | --- | --- |
| Ticket fiscal (folio consecutivo, RFC, régimen, desglose de IVA en el recibo) | Disponible (fiscal, migración 027) | Cada venta cobrada imprime su ticket con folio; llena «Datos fiscales» antes del piloto (sección 4.1). | [Fiscal](FISCAL.md#the-printed-ticket) |
| Factura electrónica (CFDI) para el cliente y factura global del día | Construida (CFDI, migración 030), sin verificar con Facturapi; desactivada hasta configurar las llaves y el CSD | Mientras no esté activada y verificada, si un cliente pide factura usa el proceso que el restaurante ya tenga con su contador. | [CFDI](CFDI.md#onboarding-runbook) |
| Descuentos y cortesías | Pendiente (ola 2, descuentos) | No hay descuentos en la app. No cambies precios del menú para simularlos. | `docs/DISCOUNTS.md`, que agrega esa ola |
| Reportes y cortes por forma de pago | Disponible (reportes, migración 029) | «Hoy» y «Finanzas» (propietario y gerentes); corte X, corte Z y corte del día impresos desde «Caja» o «Finanzas → Cortes». | [Reports](REPORTS.md#cortes) |
| Cerrar una caja desde otro dispositivo | Disponible (reportes, migración 029) | «Finanzas → Cortes → Cerrar caja desde aquí» (gerente, con PIN) para una caja de un dispositivo desvinculado o que quedó abierta de un día anterior; si su tablet funciona, ciérrala ahí. | [Reports](REPORTS.md#cortes) |
| Acceso Pro del piloto otorgado por soporte, aviso de privacidad, contacto de soporte dentro de la app | Hecho en la rama de cuenta (031), pendiente de integrarse y de probarse en staging | Mientras no esté integrado: en Free, un solo dispositivo vende (sección 2). Ya integrado: soporte activa Pro para el piloto (hasta 90 días, renovable antes de que termine); el propietario lo ve como «Pro otorgado por soporte» con su fecha de término, y la app avisa 7, 3 y 1 días antes. | [Cuenta y aspectos legales](ACCOUNT_AND_LEGAL.md); [Operations, "Support"](OPERATIONS.md) |
| Cobro con tarjeta integrado | No incluido | «Terminal externa»: cobras en la terminal del banco y registras su referencia. | [Service](SERVICE.md#payment-dialog) |
| Impresión directa, corte de papel y apertura del cajón desde la app | No incluido | El controlador de la impresora (sección 1.2). | [Service](SERVICE.md#printing-browseros) |
| Cobro en dólares | No incluido | Sección 5.1. | Esta guía |
| Servicio de mesa sin conexión | Incluido como «Beta», apagado | Déjalo apagado durante el piloto (sección 3). | [Offline](OFFLINE_RECOVERY.md#table-service-offline-beta-off-by-default) |

## 7. A quién llamar

El propietario llena esta tabla antes del primer día del piloto y la deja impresa junto
a la caja. Los contactos de la plataforma (quién recibe las alertas y en qué horario)
están en el [runbook, "Contacts and escalation"](RUNBOOK.md#contacts-and-escalation).

| Para qué | Quién | Teléfono o canal | Horario |
| --- | --- | --- | --- |
| Green Monkey no abre, no cobra o no sincroniza | Soporte de Green Monkey: _por llenar_ | _por llenar_ | _por llenar_ |
| Autorizar un cierre, una salida, una anulación o un reembolso | Gerente de turno: _por llenar_ | _por llenar_ | _por llenar_ |
| Decisiones de dinero, dólares, tipo de cambio | Propietario: _por llenar_ | _por llenar_ | _por llenar_ |
| Internet del restaurante | Proveedor de internet: _por llenar_ | _por llenar_ | _por llenar_ |
| Impresora o cajón de dinero | Proveedor del equipo: _por llenar_ | _por llenar_ | _por llenar_ |
| Terminal bancaria | Banco o proveedor de la terminal: _por llenar_ | _por llenar_ | _por llenar_ |
| Facturas y dudas fiscales | Contador del restaurante: _por llenar_ | _por llenar_ | _por llenar_ |

**Al llamar a soporte, ten a la mano:** el nombre del restaurante, el nombre del
dispositivo (como aparece en «Dispositivos»), la hora del problema, el número de orden
si lo hay, lo que dice el indicador de conexión y una foto de la pantalla con el
mensaje. Si el mensaje rojo dice «Referencia de soporte: 3F2A9C1B» (ocho letras y
números; también aparece en «Sincronización», debajo de una venta que no se pudo
enviar), díctala letra por letra: es lo primero que soporte busca. Con la versión de cuenta (031), el botón «Ayuda» de la barra superior muestra
los canales de soporte, el ID del restaurante (con botón «Copiar») y el ID del
dispositivo que soporte te pedirá. Todo lo que soporte haga en tu cuenta queda
registrado y lo ves en «Cuenta y propietarios» › «Acciones de soporte».

**Mientras llega la ayuda:** si hay conexión pero el servidor no responde, la app pasa
sola a venta sin conexión (sección 3). Si no se puede vender en la app, vende en papel
y captura después. No borres datos del navegador, no desvincules la tablet y no
reinstales la app sin hablar antes con soporte: las ventas sin sincronizar viven en esa
tablet.
