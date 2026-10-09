# Guía de operación del piloto

Para el propietario y los gerentes de turno de un restaurante piloto, y para quien
instala el equipo. Revisión del 9 de octubre de 2026 para el piloto de Juanberto's, que
pasa de pos-lite (su sistema anterior) a Green Monkey. Escrita sobre `integration/v1`, la
versión que está en producción (migraciones 001 a 036).

**Estado.** Green Monkey está en producción desde el 9 de octubre de 2026 en
`https://app.greenmonkey.online`; esa es la dirección que se abre en cada equipo. Ningún
restaurante está dado de alta todavía: el alta del propietario se abre cuando se publiquen
los datos legales ([entrega de lanzamiento](LAUNCH_HANDOFF.md)). Nada de esta guía se ha
probado todavía con la impresora real, tablets reales ni una caída real de internet; esas
pruebas son condición para el piloto
([recuperación sin conexión, "Verification"](OFFLINE_RECOVERY.md#verification)). La lista
del cambio desde pos-lite está en
[la entrega de lanzamiento](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos).

**Lo que llega antes del piloto (ola 4).** Está en construcción y **no está en
producción**: cobro con terminales Clip y Mercado Pago Point integradas, terminales con
nombre, cobro pagado por plataforma (Uber Eats, Rappi, DiDi) con precios por plataforma,
lealtad y kiosco. Esta guía no da ningún paso que dependa de ella; se actualizará cuando
llegue a producción.

**Convención.** El texto entre comillas angulares (« ») es exactamente lo que dice la
pantalla de Green Monkey; dentro de él, N, HH:mm y … marcan un número, una hora o un
importe que cambia. Los enlaces a otros documentos (en inglés) son para quien instala o da
soporte; esta guía no repite su contenido.

## 1. Impresión y equipo

### 1.1 Cómo imprime Green Monkey hoy

- **Solo a través del diálogo de impresión del navegador.** No hay conexión directa
  con la impresora (USB, red o Bluetooth) ni comandos propios de impresora térmica.
  Green Monkey no corta el papel ni abre el cajón de dinero: eso lo hace, o no, la cola de
  impresión del sistema operativo. En Juanberto's, la cola `ghia-web` corta al final de
  cada página y no abre el cajón (sección 1.2).
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
  sin tamaño de página: **el largo lo define el tamaño de papel elegido en el diálogo o
  en la cola de impresión** (sección 1.2, paso 6). Cuando un envío lleva comandas de dos
  estaciones, cada una es una sección con salto de página; con `ghia-web`, cada sección
  sale con su propio corte. Más detalle:
  [Service, "Printing (browser/OS)"](SERVICE.md#printing-browseros).

### 1.2 Configurar la impresora del piloto: GHIA GTP801 (USB, Mac de la caja)

Lista para quien instala, en la Mac de la caja de Juanberto's, donde está conectada por USB
la impresora térmica GHIA GTP801 de 80 mm. Es la única impresora del piloto.

**No uses el controlador del fabricante.** El controlador Gainscha para macOS no sirve con
esta impresora: manda raster de Star, que la GTP801 no entiende, y lo impreso sale como
basura o no sale. pos-lite (el sistema anterior de Juanberto's) lo resolvió en esta tienda
con su propio filtro de CUPS y la cola `ghia-web`, instalados por su script
`print-bridge/install-ghia-web.sh`. Chrome ya imprime en la GTP801 a través de esa cola.
Green Monkey usa la misma cola (LD-71). Lo que hace `ghia-web`, según ese script:

- convierte cada página que manda Chrome en una imagen ESC/POS de 80 mm (576 puntos a
  203 ppp) con el filtro `/Library/Printers/POSLite/rastertoescpos`, que usa el Python del
  sistema;
- recorta el papel en blanco al final de cada página, así que un tamaño de página largo no
  gasta papel;
- al final de **cada página** avanza el papel y hace un corte parcial;
- no manda la orden de abrir el cajón de dinero;
- ofrece estos tamaños de papel: `72mm x 100mm`, `72mm x 150mm`, `72mm x 200mm (recibo)`
  (el predeterminado de la cola), `72mm x 300mm` y `72mm x 400mm (recibo largo)`.

**Qué equipo imprime.** Solo la Mac de la caja. Un iPad, sea la pantalla de cocina u otro,
no puede imprimir en esta impresora: el iPad solo imprime con AirPrint, y la GTP801 está
conectada por USB a la Mac y no es una impresora AirPrint. La comanda se imprime en el
dispositivo que envía la orden (sección 1.1), así que las órdenes enviadas desde la Mac
salen en papel y las de otro dispositivo llegan solo a la pantalla de cocina. En un iPad no
actives «Imprimir comanda al enviar a cocina» ni «Imprimir tickets nuevos automáticamente en
esta pantalla»: abrirían un diálogo sin impresora.

1. **No desinstales las piezas de impresión de pos-lite en la Mac**, ni el día del cambio ni
   después: la cola `ghia-web` y su filtro en `/Library/Printers/POSLite/`, la cola
   `termica` y el puente de impresión de pos-lite. pos-lite sigue funcionando, solo para
   consultas, después del cambio
   ([entrega de lanzamiento, lista de cambio](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos)).
2. **Revisa la cola `ghia-web`.** En Terminal, `lpstat -p ghia-web` debe mostrar la
   impresora habilitada. Si no existe (por ejemplo, después de reinstalar macOS), con la
   impresora conectada y encendida corre `sudo bash install-ghia-web.sh` desde la carpeta
   `print-bridge` de pos-lite. El script busca la impresora USB, crea o reemplaza la cola
   `ghia-web` e imprime una prueba (`PRUEBA GHIA-WEB`). Si la prueba no sale en unos
   10 segundos, revisa `sudo tail -20 /var/log/cups/error_log`.
3. **Desde Chrome, imprime solo en `ghia-web`.** `termica` es la cola sin filtro que usa el
   puente de pos-lite: lo que Chrome le mande sale como basura. Una cola del controlador
   Gainscha, o una cola genérica para esta misma impresora, también imprime basura. Si la
   impresora empieza a sacar basura, haz lo que hizo pos-lite: cancela los trabajos
   atascados con `cancel -a` y borra las colas que sobren. Nunca borres `ghia-web` ni
   `termica`.
4. **`ghia-web` como impresora predeterminada del sistema.**
   - En Ajustes del Sistema, en Impresoras y escáneres, elige `ghia-web` como impresora
     predeterminada. No elijas la opción de usar la última impresora.
   - Con CUPS, `sudo lpadmin -d ghia-web` fija la predeterminada del sistema, y
     `lpoptions -d ghia-web` la del usuario de la Mac, que manda sobre la del sistema.
   - En Terminal, `lpstat -d` debe nombrar `ghia-web`.
   - Por defecto, Chrome propone la última impresora usada. La política administrada
     `PrintPreviewUseSystemDefaultPrinter` (documentación de políticas de Chrome Enterprise)
     hace que proponga la del sistema. En los dos casos, revisa el destino en cada diálogo.
5. **Ancho en Green Monkey:** en la Mac, «Ancho de papel» en «80 mm» («Vender» → «Impresión»
   y la pantalla del recibo). Decide con el propietario si la Mac imprime la comanda de cada
   envío («Imprimir comanda al enviar a cocina», apagado de fábrica).
6. **El diálogo de impresión de Chrome.** Cada recibo, cuenta y comanda abre el diálogo de
   impresión del navegador. En el piloto no se imprime sin diálogo (LD-71; sección 1.3).
   En el diálogo:
   - destino: `ghia-web`;
   - tamaño del papel: `72mm x 400mm (recibo largo)`. El filtro recorta el papel en blanco,
     así que no se gasta papel de más y los tickets largos salen en una sola pieza (paso 7).
     Revisa en cada prueba que el diálogo conserve este tamaño. Si vuelve a
     `72mm x 200mm (recibo)`, elígelo de nuevo. Opcional:
     `sudo lpadmin -p ghia-web -o PageSize=X72MMY400MM` cambia el tamaño predeterminado de
     la cola; comprueba en la prueba del paso 10 si Chrome lo propone;
   - márgenes: ninguno;
   - escala: 100 %. No uses la opción de ajustar a la página: encoge el texto;
   - encabezados y pies de página: desactivados, para que no salgan la fecha ni la
     dirección de la página.

   **Nombres del diálogo sin verificar.** Los nombres de estas opciones en el diálogo de
   Chrome no se han comprobado en la Mac de la tienda; confírmalos en la prueba del
   paso 10. Lo único fijo es lo que pide Green Monkey: `@page { margin: 0 }`, ningún tamaño
   de página y un contenido de 72 mm de ancho con papel de 80 mm (sección 1.1).
7. **Cortes: qué revisar.** `ghia-web` corta después de cada página que manda Chrome.
   - **Comanda con cocina y barra:** Green Monkey pone un salto de página entre las
     secciones, así que cada estación sale cortada por separado. Lo mismo pasa con
     «Imprimir recibos (N)» de «Cobrar juntas»: un corte por recibo.
   - **Documento más largo que la página: sale cortado a la mitad.** Lo que no cabe en el
     tamaño de papel elegido sigue en otra página, y la cola corta entre las dos. Con el
     predeterminado de la cola, `72mm x 200mm (recibo)`, pueden salir en dos piezas un
     recibo largo, la cuenta de una mesa grande o un corte.
   - **Cómo revisarlo:** en la prueba del paso 10, imprime el documento más largo que pueda
     darse en el restaurante: la cuenta de una mesa grande, con muchas líneas, opciones y
     notas, su recibo y un corte Z. Cada uno debe salir en una sola pieza. Si alguno sale
     cortado, revisa que el tamaño del papel sea `72mm x 400mm (recibo largo)` y vuelve a
     imprimir. Si aun así un documento mide más de 400 mm, sale en dos piezas: el personal
     las entrega juntas (las dos partes de la comanda a cocina, las dos del recibo al
     cliente).
   - Revisa también que no sobre papel en blanco al final, que el texto no se corte en el
     borde derecho y que se lea nítido.
8. **Cajón de dinero.** `ghia-web` no abre el cajón: si está conectado a la impresora, no
   se abre al imprimir. Antes del piloto, decide con el propietario quién guarda la llave
   del cajón y cómo se abre para dar cambio.
9. **Sonido en la pantalla de cocina.** El sonido de «Cocina» viene apagado de fábrica en
   cada dispositivo. En el dispositivo de cocina, toca «Activar sonido»: el botón cambia a
   «Sonido activado». Envía una orden de prueba y comprueba que se oye. El dispositivo
   recuerda que el sonido está activado, pero después de cada recarga el navegador lo
   bloquea hasta que alguien toca la pantalla. Entonces la pantalla avisa «Toca «Activar
   sonido» para escuchar los tickets nuevos.», y hay que tocar «Activar sonido» otra vez.
   Como el iPad de cocina no imprime, el sonido es su único aviso de los tickets nuevos.
10. **Prueba completa.** Hazla en la Mac de la caja con `ghia-web` y «Ancho de papel» en
    «80 mm». Es condición para empezar el piloto
    ([entrega de lanzamiento, lista de cambio](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos)).
    Con cada documento, revisa que salió papel (el navegador nunca lo confirma).

    | Documento | Cómo producirlo | Qué revisar en el papel |
    | --- | --- | --- |
    | Recibo | Cobra una venta → «Imprimir recibo» | Productos, pagos y cambio; una sola pieza con su corte |
    | Cuenta | Detalle de la orden → «Imprimir cuenta» | «Cuenta · no es comprobante de pago» |
    | Comanda con cocina y barra | Envía una orden con un producto de cocina y uno de barra desde la Mac, con «Imprimir comanda al enviar a cocina» (actívalo para la prueba si el propietario lo deja apagado) | Dos secciones, cada una cortada por separado |
    | Reimpresión | Detalle de la orden → «Reimprimir recibo» | «REIMPRESIÓN» |
    | Comanda sin conexión | «Sincronización» → «Trabajar sin conexión»; guarda una venta cobrada → «Imprimir comanda»; después, «Volver a conectarme» | «COMANDA · SIN CONEXIÓN» y el número provisional; al volver la conexión, el indicador ya no muestra «N por sincronizar» |
    | Documento largo | La cuenta de una mesa grande, su recibo y un corte Z (paso 7) | Cada uno en una sola pieza |

    Las ventas de prueba son ventas reales en producción: reciben folio de ticket fiscal,
    cuentan en la caja y aparecen en los reportes. Hazlas antes de la fecha del cambio, en
    efectivo y por importes pequeños, y anota sus folios para el contador. Si algo falla, el
    piloto no empieza hasta corregirlo.

**Otra impresora.** Esta sección es solo para la GTP801 de Juanberto's. Con otra impresora
térmica se revisa lo mismo con el controlador que esa impresora entienda: ancho del papel,
sin márgenes, escala al 100 %, cortes y la prueba del paso 10. Nada de eso se ha probado
con otra impresora.

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

**Pasos de impresión del piloto, en cada equipo que imprime** (en Juanberto's, solo la Mac
de la caja; sección 1.2):

1. Configura la impresora térmica en el sistema operativo (en Juanberto's, la cola
   `ghia-web`: sección 1.2, pasos 1 a 6) y déjala como impresora predeterminada del
   sistema (sección 1.2, paso 4).
2. En Chrome administrado, activa la política `PrintPreviewUseSystemDefaultPrinter`
   para que el diálogo proponga esa impresora (sección 1.2, paso 4).
3. Cada impresión abre el diálogo del navegador: revisa que el destino sea la térmica
   (`ghia-web`) y confirma con «Imprimir». Cuenta con este paso en cada recibo, cuenta y
   comanda.
4. Haz la prueba completa de la sección 1.2, paso 10, y revisa que salió papel (el
   navegador nunca lo confirma).
5. En el piloto de Juanberto's no se prueba ni se usa la impresión sin diálogo (LD-71): la
   Mac de la caja abre el diálogo en cada documento. En otro piloto con Windows, si el
   propietario quiere probar la opción de inicio `--kiosk-printing`, hazlo solo como prueba
   en ese equipo, con los pasos 1 a 4 ya hechos, y anota el resultado: no está confirmada en
   documentación oficial (tabla siguiente) ni probada por nosotros, así que el piloto no
   depende de ella.

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
imprime sin diálogo. Si la cocina no tiene impresora o el iPad no puede imprimir (en
Juanberto's, el iPad de cocina no puede: sección 1.2), la pantalla de cocina con su sonido
activado y la lista «Comandas (N)» de la caja son la alternativa.

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
  varias cajas, el acceso Pro lo otorga soporte el día en que el propietario se da de
  alta (hasta 90 días, renovable; sección 6). Hasta que soporte lo otorgue, solo el
  dispositivo seleccionado abre caja y vende.
- **Bloqueo:** las sesiones con PIN se bloquean solas a los 3 minutos sin uso (cocina
  nunca, de fábrica). Se cambia por dispositivo en «Dispositivos» → «Editar» →
  «Bloqueo automático». Al alejarte de la caja, toca «Bloquear pantalla».
- **Cocina:** desactiva el apagado automático de pantalla en el sistema de la tablet. El
  sonido viene apagado de fábrica en cada dispositivo: actívalo en el de cocina con
  «Activar sonido» y vuelve a tocarlo después de cada recarga (el navegador bloquea el
  sonido hasta que alguien toca la pantalla; sección 1.2, paso 9).
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

1. Enciende el módem, la impresora (con papel), la Mac de la caja y las tablets.
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
   «Cocina» o «Barra») y toca «Activar sonido»; el botón debe decir «Sonido activado».
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
- **Reembolsos:** de cobros en «Efectivo» y con «Terminal externa», desde el detalle de
  la orden («Reembolsar», con «Motivo del reembolso»); siempre los autoriza un gerente o
  el propietario con su PIN, y necesitan conexión. La parte en efectivo sale de la caja
  abierta de ese dispositivo. La parte de terminal se reembolsa primero en la terminal;
  después escribe su referencia y marca «Confirmo que la terminal aprobó el reembolso de
  …». Una cuenta con saldo pendiente y sin ticket no se reembolsa: antes de cobrarla,
  anula las líneas ([detalle](DISCOUNTS.md)).
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
| Factura electrónica (CFDI) para el cliente y factura global del día | Construida (CFDI, migraciones 030 y 036). En producción la plataforma ya tiene su llave de Facturapi en modo prueba; el restaurante la activa en modo prueba con su CSD. El modo real, solo después de que el contador lo apruebe | Mientras no esté en modo real, si un cliente pide factura usa el proceso que el restaurante ya tenga con su contador. Quién emite la factura global y desde qué fecha está en la [lista de cambio](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos). | [CFDI](CFDI.md#onboarding-runbook) |
| Descuentos y cortesías | Disponible (descuentos, migración 028) | Con motivo. De fábrica, cajeros y meseros tienen límite 0 % / $0, así que cada descuento pide el PIN de un gerente; el propietario fija los límites en «Configuración» → «Descuentos y corte de caja» antes del primer día. No cambies precios del menú para simular descuentos. | [Discounts](DISCOUNTS.md) |
| Reportes y cortes por forma de pago | Disponible (reportes, migración 029) | «Hoy» y «Finanzas» (propietario y gerentes); corte X, corte Z y corte del día impresos desde «Caja» o «Finanzas → Cortes». | [Reports](REPORTS.md#cortes) |
| Cerrar una caja desde otro dispositivo | Disponible (reportes, migración 029) | «Finanzas → Cortes → Cerrar caja desde aquí» (gerente, con PIN) para una caja de un dispositivo desvinculado o que quedó abierta de un día anterior; si su tablet funciona, ciérrala ahí. | [Reports](REPORTS.md#cortes) |
| Acceso Pro del piloto otorgado por soporte, aviso de privacidad, contacto de soporte dentro de la app | Disponible (cuenta, migración 031). La cuenta de operador de soporte ya existe en producción; los datos legales y de soporte aún no se publican | Soporte activa Pro para el piloto el día del alta (hasta 90 días, renovable antes de que termine); el propietario lo ve como «Pro otorgado por soporte» con su fecha de término, y la app avisa 7, 3 y 1 días antes. Antes de eso, en Free, un solo dispositivo vende (sección 2). | [Cuenta y aspectos legales](ACCOUNT_AND_LEGAL.md); [Operations, "Support"](OPERATIONS.md) |
| Cobro con tarjeta integrado (Clip, Mercado Pago Point) | Llega antes del piloto (ola 4, fase 2 de pagos); no está en producción | «Terminal externa»: cobras en la terminal (banco, o Clip / MP en modo independiente), eliges la terminal por su nombre y registras su referencia (sección 8). Para cobrar a mano en Mercado Pago Point, la terminal debe estar en modo independiente ([lista de cambio](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos)). | [Payments](PAYMENTS.md) |
| Pedidos de plataformas (Uber Eats, Rappi, DiDi): cobro pagado por plataforma y precios por plataforma | Disponible (pagos, migración 037) | «Plataforma» al cobrar; no cuenta como efectivo ni tarjeta (sección 8). Las plataformas vienen apagadas: el propietario las enciende y captura sus precios antes del piloto. El contador decide su tratamiento fiscal. | [Payments](PAYMENTS.md) |
| Lealtad (sellos, miembros, recompensas) | Llega antes del piloto (ola 4), con la importación de los miembros de pos-lite; no está en producción | El programa de sellos sigue en pos-lite ([lista de cambio](LAUNCH_HANDOFF.md#4-cutover-checklist-for-juanbertos)). | Esta guía, cuando llegue |
| Kiosco con cobro con tarjeta, fotos y sugerencias | Llega antes del piloto (ola 4); no está en producción | No uses el kiosco de pos-lite junto con Green Monkey: serían dos sistemas de órdenes y dos colas de cocina. | [Public ordering](PUBLIC_ORDERING.md) |
| Impresión directa, corte de papel y apertura del cajón desde la app | No incluido | La cola `ghia-web` corta al final de cada página; el cajón no se abre al imprimir (sección 1.2). | [Service](SERVICE.md#printing-browseros) |
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

## 8. Terminales y plataformas

**Configurar (propietario o gerente, una vez).** En «Configuración → Pagos con tarjeta y
plataformas»:

1. Agrega cada terminal por su nombre («BBVA», «Clip Mostrador», «MP Caja») con su
   comisión con IVA (por ejemplo 3.6 % + IVA se escribe 4.18). Una terminal Clip o
   Mercado Pago se registra por ahora como manual: cobras en ella en modo independiente.
2. En cada tablet de caja, elige su «Terminal predeterminada de este dispositivo». Sin
   predeterminada y con varias terminales, el cobro con tarjeta pide «Elige la terminal».
3. Las plataformas vienen **desactivadas**: activa solo las que usa el restaurante (para
   Juanberto's: Uber Eats, Rappi y DiDi Food) y escribe su comisión estimada. Deja «Otra»
   desactivada salvo que de verdad recibas pedidos de otra plataforma: cada cobro con «Otra»
   aparece en «Finanzas → Excepciones» para revisarlo.
4. Si los precios en la plataforma son distintos a los del mostrador, escríbelos en
   «Precios por plataforma». Vacío: se usa el precio del mostrador. Los extras y
   modificadores siempre usan el precio del mostrador: deja los extras de la plataforma al
   mismo precio que en el mostrador o cobra la diferencia como una línea de precio abierto
   (si no, el ticket y la factura declaran menos de lo que cobró la plataforma). Cuando una
   plataforma tiene precios propios, solo acepta pedidos registrados con «Precios: esa
   plataforma».
5. Con tu contador, revisa «Forma de pago SAT para pedidos pagados por plataforma» en
   la configuración de facturación (31 Intermediario pagos, recomendado).

**Cobrar con tarjeta.** «Cobrar» → «Terminal externa» → elige la terminal → cobra en la
terminal → escribe la referencia de aprobación → marca la confirmación → «Confirmar
cobro». El recibo dice «Tarjeta · {terminal}».

**Pedido de plataforma.** Al recibir el pedido en la tablet de la plataforma:

1. En «Vender», con «Para llevar» o «A domicilio» (nunca mesa ni «Comer aquí»), si hay
   precios por plataforma, elige «Precios: Uber Eats» (o la que corresponda) **antes de
   enviar**. La orden muestra «Pedido con precios de …». Si la enviaste con precios de
   mostrador y la plataforma tiene precios propios, la plataforma no podrá cobrarla: pide a
   un gerente cancelarla y regístrala otra vez con sus precios.
2. Escribe en «Nombre» el código del pedido (por ejemplo «DiDi 4F2A») y envíalo.
3. «Cobrar» → «Plataforma» → la plataforma → número de pedido (obligatorio para Uber Eats,
   Rappi y DiDi; se llena solo con el código del nombre, revísalo) → marca «La plataforma
   ya cobró este pedido» → «Confirmar cobro». Cubre todo el saldo, sin propina. No entra al
   efectivo esperado ni a la tarjeta del corte.

**Cerrar caja.** El corte muestra la tarjeta por terminal y «Pagado por plataformas»
aparte («Total plataformas»; cada nombre de «Otra» en su propia línea). Si usas terminales
con nombre, escribe el «Total del lote» de **cada** terminal que cobró (o de ninguna): el
cierre no acepta solo algunas. Las diferencias aparecen en «Finanzas → Excepciones».

**Revisar (gerente, cada día).** En «Finanzas → Excepciones», «Pago por plataforma a revisar»
lista los cobros con «Otra», los de una orden sin la lista de precios de esa plataforma y los
registrados sin conexión fuera de las reglas, con quién los cobró y en qué caja. Compáralos
con el pago de la plataforma: un pago en efectivo registrado como plataforma aparece aquí.

## 9. Club de lealtad

El club de Juanberto's pasa de POS Lite a Green Monkey el día de cambio
([Loyalty](LOYALTY.md); los pasos de la migración en [Migration](MIGRATION.md)).

- **Antes de activarlo.** El propietario publica el aviso de privacidad del
  restaurante (Configuración › Privacidad y datos) y confirma que menciona el
  club. En Configuración › Club de lealtad, primero guarda la configuración
  (con «Aplicar a la configuración» los sellos por tarjeta de POS Lite), luego
  imprime las listas para la bitácora, importa los socios de POS Lite y solo
  activa el club cuando la pantalla dice «Verificado: los totales coinciden con
  POS Lite.».
- **Después del cambio.** Cuando Juanberto's deja de usar POS Lite, borra (o
  anonimiza) los socios del restaurante en POS Lite (`loyalty_customers`) y
  anótalo en la bitácora del cambio. Mientras siga ahí, borrar a un socio
  importado también se hace en POS Lite.
- **En caja.** Al agregar el primer producto se abre «Cliente del club».
  Escribe el teléfono y toca Usar. Si no existe, lee al cliente el texto en
  pantalla, muéstrale el aviso (QR) y marca «Le informé al cliente el aviso de
  privacidad y aceptó unirse al club.». La casilla de promociones va sin marcar
  salvo que el cliente lo pida. «Sin club» sigue la venta sin cliente.
- **Premios.** «Canjear premio» junto a Descuento: elige el producto; el
  premio cubre un producto hasta el tope que fijó el propietario. No pide PIN.
- **Sin conexión.** El club no funciona sin conexión: la venta sigue igual y
  el cliente se agrega después desde Detalle de orden (hasta 7 días después
  del pago). Cuando vuelva la conexión, reimprime el ticket desde Detalle de
  orden: trae el QR para que el cliente sume sus sellos.
- **Primeras semanas.** Deja junto a la caja el letrero «Nuestro club se mudó
  de sistema; consulta el aviso de privacidad» con el QR del aviso. Si un socio
  dice que tenía un premio pendiente en POS Lite, búscalo en Clientes con el
  filtro «Premio de POS Lite por confirmar» (la fecha está en Movimientos ›
  Saldo importado) y, si procede, el gerente lo da con Ajustar › Saldo de POS
  Lite. Los rechazados del archivo están en las listas impresas para la
  bitácora.
- **Datos personales.** Si un cliente pide sus datos o que se borren,
  Clientes › Imprimir datos del cliente o Eliminar datos del cliente (gerente).
  Clientes sigue disponible aunque el club esté desactivado o el plan sea
  Gratis, mientras haya socios con datos.
