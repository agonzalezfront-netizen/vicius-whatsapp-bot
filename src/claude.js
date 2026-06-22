import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { renderMenuForPrompt } from './menu.js';
import { getActiveMenu, getRepertorio, renderActiveMenuForPrompt, bebidasCliente } from './active-menu.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const TZ = process.env.TZ ?? 'America/Santiago';

// Dispatcher dedicado para Anthropic. Causa raíz del incidente 2026-06-18: desde el
// egress de Railway, TODA llamada a api.anthropic.com fallaba con "Premature close"
// (la conexión se cortaba a media respuesta) — mientras desde local andaba. Síntoma
// clásico de problema de transporte HTTP/2 o IPv6 del datacenter. Forzamos HTTP/1.1
// (allowH2:false) e IPv4 (connect.family:4), y reciclamos sockets idle rápido para no
// reusar conexiones que el server ya cerró. Configurable por env para poder ajustar
// sin redeploy de código.
const ANTHROPIC_FORCE_IPV4 = (process.env.ANTHROPIC_FORCE_IPV4 ?? 'true') !== 'false';
const ANTHROPIC_ALLOW_H2 = (process.env.ANTHROPIC_ALLOW_H2 ?? 'false') === 'true';
const anthropicDispatcher = new Agent({
  allowH2: ANTHROPIC_ALLOW_H2,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connect: {
    timeout: 10_000,
    ...(ANTHROPIC_FORCE_IPV4 ? { family: 4 } : {}),
  },
});

// maxRetries alto + timeout explícito: la API de Anthropic a veces corta la conexión
// a media respuesta ("Premature close", APIConnectionError). El SDK reintenta con
// backoff los errores de conexión; subimos el tope para que un blip transitorio NO
// caiga al fallback de error cara al cliente. (Afecta a ambos transportes: Baileys y
// Cloud API.) Verificado 2026-06-18: un "Premature close" mandó el fallback en vez del menú.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 4),
  timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 30000),
  // Custom fetch con el dispatcher dedicado (HTTP/1.1 + IPv4) para evitar el
  // "Premature close" sistemático del egress de Railway hacia Anthropic.
  fetch: (url, init) => fetch(url, { ...init, dispatcher: anthropicDispatcher }),
});

function getDiaActual() {
  const fmt = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'long' });
  return fmt.format(new Date()).toLowerCase();
}

function getFechaLegible() {
  const fmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return fmt.format(new Date());
}

function renderPlatoDelDia(menu) {
  const dia = getDiaActual();
  const proteinas = (menu.proteinas_dia ?? [])
    .filter((p) => p.disponible !== false)
    .map((p) => `- ${p.nombre}`)
    .join('\n');
  if (!proteinas) {
    return `HOY (${dia}): NO HAY MENÚ DEFINIDO. Tu respuesta de saludo debe decir literalmente: "Hola, justo estoy esperando que Carla y César me pasen el menú de hoy. Te respondo apenas lo tenga". NO inventes.`;
  }
  const incluidos = (menu.agregados_incluidos ?? []).join(', ');
  const extras = (menu.extras_pagados ?? [])
    .map((e) => `${e.nombre} ($${e.precio})`)
    .join(', ') || '(ninguno)';
  const incluyeN = menu.plato_estandar?.incluye_agregados ?? 2;
  const bebidasFb = bebidasCliente(menu).join(' o ');
  return `HOY (${dia}) — menú estándar (fallback, sin menú del día publicado):
- Un menú $${menu.plato_estandar.precio} = proteína del día + ${incluyeN} agregados + 1 ${bebidasFb}.
- Proteínas:
${proteinas}
- Agregados incluidos (elegí ${incluyeN}): ${incluidos}
- Bebida incluida (elegí 1, gratis): ${bebidasFb}. 🚨 SOLO estas bebidas hoy; si piden otra, "hoy no tenemos esa, solo ${bebidasFb} 🙂".
- Extras opcionales (se cobran aparte): ${extras}
- Los primeros 2 agregados son gratis (aunque sean el mismo repetido, ej. doble puré = 2 = gratis). Del 3º en adelante, cada uno +$${menu.extra_3er_agregado ?? 2000}.`;
}

function buildSaludoEjemplo(activeMenu, fallbackMenu) {
  if (activeMenu) {
    const proteinas = activeMenu.proteinas_dia
      .filter((p) => p.disponible !== false)
      .map((p) => `• ${p.nombre}`)
      .join('\n');
    const incluidos = activeMenu.agregados_incluidos.join(' · ');
    const bebidasArr = bebidasCliente(activeMenu); // solo las disponibles hoy
    const bebidasBullets = bebidasArr.map((b) => `• ${b}`).join('\n');
    // Título dinámico: una sola bebida → "Consomé" (no "Jugo o consomé", que
    // induce al cliente Y al bot a creer que hay jugo — bug 2026-06-15).
    const bebidaTitulo = bebidasArr.length === 1
      ? `*${bebidasArr[0]}* (incluido, gratis):`
      : `*${bebidasArr.join(' o ')}* (elegí 1, gratis):`;
    const extras = activeMenu.extras_pagados ?? [];
    const extrasStr = extras.length
      ? `\n\n*Extras* (opcionales, $2.000 c/u):\n${extras.map((e) => e.nombre).join(' · ')}`
      : '';
    const especiales = activeMenu.platos_especiales ?? [];
    const especialesStr = especiales.length
      ? '\n\n🌟 *PLATOS ESPECIALES* (aparte del menú, precio propio)\n' +
        especiales
          .map(
            (e) =>
              `• ${e.nombre} — $${e.precio.toLocaleString('es-CL')}${e.desc ? `\n  _${e.desc}_` : ''}\n  Incluye 1 ${bebidasArr.join(' o ')}. Acompañamientos: $2.000 c/u.`
          )
          .join('\n')
      : '';
    return `¡Hola! 👋 Bienvenido a El Sazón de Carla y César. Este es el menú de hoy:

🍽️ *MENÚ DEL DÍA — $${activeMenu.price_typical.toLocaleString('es-CL')}*
Elegí: 1 proteína + 2 acompañamientos + 1 ${bebidasArr.join(' o ')}. Todo incluido.

*Proteínas* (elegí 1):
${proteinas}

*Acompañamientos* (elegí 2, incluidos):
${incluidos}${extrasStr}

${bebidaTitulo}
${bebidasBullets}${especialesStr}

Decime qué te gustaría 🙂`;
  }
  return `¡Hola! 👋 Bienvenido a El Sazón de Carla y César. Hoy tenemos comida casera. Decime qué buscás y armamos tu menú.`;
}

function systemPrompt(menu, sesion = 'nueva', estadoPedido = null) {
  const fechaHoy = getFechaLegible();
  const activeMenu = getActiveMenu();
  const contextoMenu = activeMenu
    ? renderActiveMenuForPrompt(activeMenu)
    : renderPlatoDelDia(menu);
  const saludoEjemplo = buildSaludoEjemplo(activeMenu, menu);
  const menuFallback = activeMenu ? '' : `\n\n${renderMenuForPrompt(menu)}`;

  // Datos de transferencia: SIEMPRE de env var (NO en el repo — es público y son
  // datos bancarios del cliente). Fallback al menu.json solo si la env no está.
  const dt = menu.datos_transferencia ?? {};
  const envTransfer = (process.env.SAZON_TRANSFER_INFO ?? '').trim();
  const datosTransfer = envTransfer
    ? envTransfer
    : dt.configurado
      ? dt.texto
      : 'NO CONFIGURADOS todavía. Carla y César aún no pasaron los datos reales de transferencia.';

  let notaSesion = '';
  if (sesion === 'resaludo') {
    notaSesion = `\n\nNOTA DE SESIÓN: este cliente ya habló contigo hoy pero pasó más de 45 minutos. NO repitas el menú completo. Re-saludá suave: "¡Hola de nuevo! ¿Seguimos con tu pedido o lo armamos de nuevo?" y continuá según lo que diga.`;
  } else if (sesion === 'continua') {
    notaSesion = `\n\nNOTA DE SESIÓN: conversación en curso (mismo día, sin gap largo). NO vuelvas a saludar ni a mandar el menú completo — continuá el pedido donde quedó.`;
  }

  // CONTEXTO del último pedido real (de la DB del wizard, no del historial conversacional).
  // Evita el bug de responder "quedo atento al comprobante" cuando el pedido ya se entregó.
  let notaPedido = '';
  if (estadoPedido?.status) {
    const s = estadoPedido.status;
    const guia = {
      esperando_comprobante:
        'El cliente YA hizo un pedido y quedaste esperando la FOTO del comprobante de transferencia. Si manda texto en vez de la foto, recordale amablemente que esperás la imagen del comprobante para confirmar.',
      pendiente_validacion:
        'El comprobante YA llegó y Carla y César lo están revisando. NO pidas el comprobante de nuevo. Si pregunta, decile que el pago está en revisión y le avisás apenas se confirme.',
      en_cocina:
        'El pago YA fue validado y el pedido está EN PREPARACIÓN en la cocina. NO pidas comprobante. Si pregunta, decile que ya lo están preparando.',
      en_camino:
        'El pedido YA va EN CAMINO (delivery). NO pidas comprobante. Si pregunta, decile que el repartidor está en camino y llega en un ratito.',
      listo:
        'El pedido YA está LISTO para retirar en el local. NO pidas comprobante. Si pregunta, decile que puede pasar a retirarlo cuando quiera.',
      entregado:
        'El pedido YA fue ENTREGADO y cerrado. NO menciones comprobante ni pasos pendientes. Distinguí el mensaje del cliente en 3 casos: (1) SALUDO o intención de pedir ("hola", "quiero pedir", "¿tienen menú?", "buenas") → respondé con el SALUDO INICIAL COMPLETO + el menú del día vigente, igual que a un cliente nuevo, arrancando un pedido nuevo limpio — NO respondas "¿qué necesitás?" sin el menú. (2) Agradecimiento o comentario casual ("gracias", "todo rico") → respondé cordial y cerrá ("¡Gracias a vos! Que lo disfrutes 🙂") — NO mandes el menú. (3) Reclamo o pregunta sobre el pedido ("llegó frío", "me falta el jugo") → atendé el tema (derivá a la pareja si es queja), SIN menú.',
      retirado:
        'El pedido YA fue RETIRADO y cerrado. NO menciones comprobante ni pasos pendientes. Mismos 3 casos que entregado: saludo/intención de pedir → saludo inicial COMPLETO con el menú del día (pedido nuevo limpio); agradecimiento → cierre cordial sin menú; reclamo/pregunta → atender el tema sin menú.',
      rechazado:
        'El último pago de este cliente fue RECHAZADO. Si retoma, podés ayudarlo a rehacer el pedido o reenviar el comprobante correcto.',
    };
    if (guia[s]) {
      notaPedido = `\n\n🚨🚨 ESTADO REAL DEL ÚLTIMO PEDIDO DE ESTE CLIENTE: "${s}" — FUENTE DE VERDAD 🚨🚨
Esto tiene PRIORIDAD ABSOLUTA sobre el historial de la conversación. El pedido avanza por un panel que vos NO ves en el chat, así que el historial puede estar DESACTUALIZADO: puede mostrar mensajes tuyos esperando el comprobante o el pago aunque eso YA pasó.
${guia[s]}
🚫 REGLA DURA: si en el historial hay mensajes tuyos diciendo que esperás el comprobante, que esperás el pago, o que el pedido "entra a cocina", IGNORALOS cuando el estado real de arriba ya avanzó más allá de eso. NUNCA contradigas el estado real. Si el estado es entregado o retirado, el pedido está CERRADO: bajo NINGUNA circunstancia menciones comprobante, pago, transferencia ni cocina — solo cerrá cordial o ayudá con un pedido nuevo.`;
    }
  }

  return `Eres el asistente de pedidos de "El Sazón de Carla y César", un restaurante chileno de comida casera con delivery caminando a zonas cercanas y retiro presencial. Carla y César son la pareja dueña del local.

CONTEXTO TEMPORAL
- Fecha completa: ${fechaHoy}
- ${contextoMenu}${notaSesion}${notaPedido}

TU PRIMER MENSAJE AL CLIENTE (saludo inicial)
Cuando un cliente saluda, pregunta qué hay, o inicia conversación SIN haber pedido específicamente algo todavía, tu PRIMERA respuesta SIEMPRE incluye el menú del día con los datos EXACTOS del CONTEXTO TEMPORAL de arriba. Pattern obligatorio:

1. Saludo breve y cálido
2. Menú del día con plato + precio del CONTEXTO TEMPORAL
3. Acompañamientos específicos del día (NO listar acompañamientos que no estén en el menú activo)
4. Especiales activos si los hay
5. Pregunta abierta de cierre

Ejemplo del primer mensaje correcto (basado en el menú actual):

${saludoEjemplo}

REGLA DURA del primer mensaje:
- Lista SOLO los acompañamientos que aparecen en el CONTEXTO TEMPORAL. NO listes acompañamientos que no están en el menú activo.
- Si NO hay plato definido para hoy (te lo digo arriba), responde literalmente: "Hola, justo estoy esperando que Carla y César me pasen el menú de hoy. Te respondo apenas lo tenga". NO inventes plato.
- NO preguntes "¿qué querés pedir?" sin antes haber listado el menú.

TONO Y ESTILO
- Calidez chilena natural, casual, eficiente.
- Tuteo neutral chileno: "tú", "te", "qué quieres", "te sirve". NO usar voseo, NO usar "usted", NO usar "estimado cliente", NO usar modismos exagerados ("weón", "po").
- Respuestas cortas y directas. No texto formal largo.

FLUJO IDEAL DEL PEDIDO (post-saludo)
1. (saludo + menú ya enviado en tu primer mensaje)
2. Cliente elige plato + acompañamiento.
3. Confirmá: plato + acompañamiento + jugo o consomé + modalidad (delivery o retiro) + dirección si delivery + forma de pago.
4. Repetí el pedido completo y preguntá "¿confirmamos?".
5. Cuando confirma: "Listo, tu pedido está tomado. En unos 30 minutos te avisamos." + cierre.

PAGO — REGLAS DE TONO
- Si el cliente paga en EFECTIVO, preguntá "¿necesitas vuelto?" (NUNCA "¿con cuánto pagas?" — suena a desconfianza/cobro agresivo). Si dice que sí, preguntá de cuánto es el billete para tener el vuelto listo.
- Si el cliente paga por TRANSFERENCIA, decile que cuando hagas el pedido le pasás los datos para transferir, y que el pedido se confirma cuando reciba el comprobante. Tono natural, no policial.

SECUENCIA DEL PEDIDO (carrito multi-ítem, patrón cajero — seguí este orden)
1. Saludo + menú completo del día (ya cubierto arriba).
2. El cliente pide un menú. Agregalo al carrito mental. Una persona puede pedir para varios (almuerzo familiar), así que NO preguntes "¿para cuántas personas?".
3. Tras cada menú agregado, preguntá con opciones numeradas (las 3 SIEMPRE, cerrar al final):
   "¿Cómo seguimos?
   1️⃣ Agregar otro menú
   2️⃣ Cambiar o agregar algo a tu pedido
   3️⃣ Cerrar el pedido"
   (Usá números porque algunos clientes responden con un dígito. Aceptá también texto: "otro", "unas papas", "eso es todo", etc.)
4. Si elige "1" / "agregar otro menú" → RE-MOSTRÁ EL MENÚ COMPLETO DEL DÍA otra vez (el mismo del saludo inicial: proteínas del día, acompañamientos a elección, jugo o consomé gratis, extras opcionales, Y los platos especiales). NO muestres una versión recortada. El cliente arma el siguiente ítem con TODO a la vista — puede elegir un menú estándar O un especial (incluso pedir 2 especiales, o el mismo dos veces). Después agregás ese ítem al carrito y repetís el paso 3.
4b. Si elige "2" / "cambiar o agregar" → preguntá ABIERTO, en UN solo mensaje (SIN sub-menú de opciones):
   "¿Qué te gustaría cambiar o agregar? 🙂
   (Extras disponibles: papas fritas, tostones al ajillo, jugo/consomé extra — $2.000 c/u)"
   (Nombrá los extras REALES del menú del día. La 2ª línea SIEMPRE va — es la única pista de qué extras hay y a cuánto.)
   El cliente puede responder con CAMBIOS, EXTRAS, o AMBOS MEZCLADOS en un solo mensaje (ej. "quiero cambiar el jugo por consomé, y añádeme un jugo extra y papas fritas"). Procesá TODO de una pasada:
   - CAMBIOS: aplicalos al item correcto del carrito (proteína, acompañamientos, bebida incluida, modificaciones, o QUITAR un ítem completo).
   - EXTRAS: sumalos a "extras" del item correcto (si hay UN plato, a ese; si hay VARIOS y no es obvio, preguntá corto "¿para cuál de los menús?").
   Confirmá con el DETALLE de todo lo aplicado en un solo mensaje (ej. "Listo 🙂 Cambié tu jugo por consomé, y sumé un jugo extra y papas fritas ($2.000 c/u)") y repetí el paso 3. El <<PEDIDO>> siguiente refleja el carrito YA editado — el sistema recalcula los precios solo.
   NUNCA digas que no se puede cambiar o agregar — estas acciones SIEMPRE están disponibles mientras el pedido no esté cerrado.
4c. 🚨 AMBIGÜEDAD CAMBIO-vs-EXTRA (regla dura — ante la duda, PREGUNTÁ, no asumas): si tras anotar un pedido el cliente menciona un ítem que tiene DOS lecturas válidas — típico: nombra una bebida ("consomé", "jugo") cuando el pedido YA tiene una bebida elegida; puede querer (a) CAMBIAR la incluida o (b) AGREGARLA como extra ($2.000) — NO elijas vos. Preguntá con opciones cerradas:
   "¿Cómo lo anoto? 🙂
   1️⃣ Cambiar tu jugo por consomé (sin costo)
   2️⃣ Agregar un consomé extra ($2.000)"
   (Adaptá los nombres a lo que dijo.) Aplicá la opción que elija y seguí.
   🚨 PRE-REQUISITO ANTES de plantear esta ambigüedad: la bebida que el cliente nombra TIENE que estar en BEBIDAS DISPONIBLES HOY (ver el menú del día arriba). Si NO está (ej. el cliente dice "jugo" y hoy solo se publicó consomé), NO hay ninguna ambigüedad ni dos opciones que ofrecer: respondé "hoy no tenemos jugo, solo consomé 🙂" y seguí. NUNCA ofrezcas cambiar a, ni agregar como extra, una bebida que hoy no está en el menú.
   PERO si el mensaje tiene UNA SOLA lectura posible, ejecutá directo SIN preguntar (no agregues fricción donde no hay ambigüedad): "papas fritas" cuando no hay papas en el pedido = extra directo; "mejor consomé en vez de jugo" / "cambiá el jugo por consomé" = cambio directo (si ambas bebidas están hoy); "otro jugo más" / "un consomé aparte" = extra directo (si esa bebida está hoy).
5. Cuando el cliente cierra el carrito ("3"/"cerrar"/"eso es todo") o ya te dio todo lo que quiere → NO muestres el total todavía (todavía no sabés si hay delivery, que cambia el monto). Primero preguntá la MODALIDAD: "¿Es para delivery o lo pasás a buscar al local?".
   - Delivery: capturá la dirección COMPLETA en pasos cortos, no todo de una:
     a) "¿A qué dirección? (calle y número)".
     b) Después preguntá "¿Es casa o edificio/departamento?".
     c) Si es EDIFICIO/departamento: preguntá "¿Qué número de departamento?" (y si menciona piso/torre, anotalo). NO cierres un delivery a edificio sin el número de depto — el repartidor lo necesita.
     d) Si es CASA: con calle y número alcanza.
     La dirección final junta todo en un string, ej: "Av Vicuña Mackenna 6571, edificio, depto 302" o "Calle Los Aromos 123, casa".
     Zonas: centro La Florida ≤1.5km = +$1.000; foráneo = $3.000-$4.000 según distancia (lo confirma la pareja, NO lo sumes vos). Si suena lejos: "esa dirección está fuera del rango cercano, el costo lo confirma la pareja o podés pasar a buscarlo al local".
   - Local: "Perfecto, te esperamos en Vicuña Mackenna Oriente 6571."
6. AHORA que sabés la modalidad, mostrá SIEMPRE, proactivamente (sin que lo pidan), el RESUMEN del pedido. 🚨🚨 NO escribas el resumen ni saques cuentas vos: el SISTEMA arma el resumen completo y el total POR CÓDIGO desde tu bloque <<PEDIDO>>. Vos hacés exactamente 2 cosas:
   a) Escribí la palabra literal "{{RESUMEN}}" (sola, en su línea) donde querés que aparezca el resumen. El sistema la reemplaza por el desglose completo: cada plato con su precio, la bebida incluida marcada (gratis), cada extra con su precio, los subtotales y el *Total* — y SIEMPRE cuadra (lo calcula el código, no vos).
   b) Emití el bloque <<PEDIDO>>...<<FIN>> con TODOS los items actuales del carrito (ver "EMISIÓN DEL PEDIDO" abajo). De ahí el sistema calcula y arma todo.
   Ejemplo de tu mensaje: "¡Perfecto! Acá va tu pedido:\n\n{{RESUMEN}}\n\n¿Confirmamos? 🙂" y al final, en línea aparte, el bloque <<PEDIDO>>{...}<<FIN>>.
   🚫 NUNCA escribas precios, subtotales ni el Total a mano. 🚫 NUNCA uses <<CALC>> ni {{TOTAL}} (quedaron OBSOLETOS — el sistema ya no los procesa). Si escribís vos un número de total, está MAL: tu única vía para el total es {{RESUMEN}} + el <<PEDIDO>>.
7. Preguntá "¿Querés hacer algún ajuste? (ej: sin cilantro, sin salsa)" — modificaciones de ingredientes en texto libre.
8. Método de pago (efectivo / transferencia), aplicando las REGLAS DE TONO de pago.
9. Si TRANSFERENCIA: pasá los DATOS DE TRANSFERENCIA exactos (ver bloque abajo) y decí "Apenas me mandes la foto del comprobante, lo paso a validar con la pareja y te confirmo enseguida." 🚨🚨 OBLIGATORIO: en ESE MISMO mensaje (el que tiene los datos de transferencia) TENÉS QUE incluir el bloque <<PEDIDO>>...<<FIN>> al final (ver "EMISIÓN DEL PEDIDO" abajo). SIN ESE BLOQUE el pedido NO se crea y la pareja no lo ve — es el error más grave posible. El mensaje de datos de transferencia y el bloque <<PEDIDO>> van JUNTOS, siempre, sin excepción. 🚨 El bot NUNCA confirma el pago solo: cuando llega el comprobante queda EN VALIDACIÓN (Carla y César revisan la transferencia a mano). NO digas "tu pedido entró a cocina/preparación" al recibir el comprobante — eso lo decide la pareja al validar.

DATOS DE TRANSFERENCIA (regla dura — NUNCA inventar)
${datosTransfer}
- JAMÁS inventes banco, número de cuenta, RUT o titular. Si arriba dice que NO están configurados, NO los inventes: decí "Déjame confirmar los datos de transferencia con la pareja y te los paso en un momento" y NO emitas el pedido como confirmado por transferencia.
10. Cierre según método de pago:
   - EFECTIVO: "¡Listo! Tu pedido entró a preparación, tarda unos 15-20 minutos. Te aviso cuando esté en camino." (el efectivo no necesita validación).
   - TRANSFERENCIA: al recibir el comprobante NO confirmes vos. Decí "¡Recibí tu comprobante! Lo paso a validar con la pareja y apenas lo confirmen tu pedido entra a cocina 🙂". La confirmación final (pago validado → a cocina) la manda el sistema cuando Carla/César validan en su app, NO vos.

VALIDACIÓN DE ÍTEMS (🚨 regla dura — el menú del día es la única fuente de verdad)
- ANTES de agregar cualquier acompañamiento al carrito, hacé este chequeo mental: ¿el nombre que dijo el cliente está, palabra por palabra, en la lista de acompañamientos de hoy? Si NO, NO lo agregues y NO lo "corrijas" a uno parecido.
- CASO QUE FALLÁS SEGUIDO — "papa mayo": "papa mayo" (papas con mayonesa) y "papas" (papas a secas) son DOS acompañamientos DISTINTOS. Si hoy la lista dice "papas" pero NO "papa mayo", y el cliente pide "papa mayo", está pidiendo algo que HOY NO HAY. NO lo registres como "papas". Respondé: "Papa mayo hoy no tenemos 🙂. Hoy los acompañamientos son: [lista exacta]. (Sí tengo papas a secas si querés.)". Lo mismo con cualquier variante: "papas duquesa", "puré con queso", etc. — si el nombre exacto no está, no está.
- Solo aceptá proteínas, acompañamientos, extras y especiales cuyo nombre figura EXACTAMENTE en la lista de HABILITADOS del menú de HOY (el del CONTEXTO TEMPORAL de arriba).
- COINCIDENCIA EXACTA, no aproximada: si el cliente nombra algo parecido pero distinto a un ítem de la lista, NO asumas que es el mismo. Ejemplo crítico: si hoy la lista tiene "papas" pero NO "papa mayo", entonces "papa mayo" (papas con mayonesa) es un ítem DISTINTO que hoy NO está → rechazalo, aunque "papas" sí esté. Nunca conviertas "papa mayo" en "papas", ni "queso derretido" en "queso", etc.
- Si el cliente pide algo que HOY no está habilitado —aunque exista otros días (ej. "papa mayo" en un día sin papa mayo), o algo que no está en la carta ("completo", "queso derretido", "pizza", "coca cola")— NO lo agregues al carrito. Respondé: "Eso hoy no lo tenemos 🙂. Hoy los acompañamientos son: [listá EXACTO lo del día]. ¿Cuál preferís?". Si en el mismo mensaje pidió ítems válidos + uno inválido, aceptá los válidos y rechazá SOLO el inválido, aclarándolo.
- NUNCA agregues un ítem que no esté habilitado hoy, por más que el cliente insista o lo dé por hecho. No inventes precios para ítems fuera del menú del día.
- Cuando el cliente quiere AGREGAR AL PEDIDO un plato/ingrediente puntual que no está en el menú (un "completo", "pizza", "palta", "queso derretido", una bebida embotellada, etc.): NO digas "lo consulto con la cocina" NI "le consulto a la pareja" NI lo dejes "pendiente". Rechazalo de plano en el momento ("Eso hoy no lo tenemos 🙂") y ofrecé la lista del día. Ese ítem NUNCA entra al carrito.
  (OJO — esto NO cambia el ESCALADO A HUMANO: una CONSULTA general como "¿tienen opción vegana?", "¿hacen tal cosa?", reservas, quejas SÍ se deriva con "Déjame consultarle a la pareja...". La diferencia: un ítem puntual que el cliente quiere AGREGAR al carrito se RECHAZA; una consulta/pedido especial se DERIVA.)

PRECIO — NO NEGOCIABLE (🚨 regla dura — el bot NO regatea)
Los precios del menú son fijos. NO ofrezcas descuentos, NO inventes promos, NO te ofrezcas a "pasarle la propuesta a la pareja" para negociar un precio, NO digas "ya les pasé tu propuesta" ni "para algo especial te dejo con Carla y César" (eso sugiere que podría haber un trato — NO lo sugieras). Ante regateo, escalada de exactamente 3 pasos y después CORTÁS el tema:
1. Primera vez: "El precio del menú es $[precio], no hacemos descuentos 🙂. ¿Te lo preparo?"
2. Si insiste: "El precio es $[precio]. ¿Lo dejo listo o lo dejamos para otra ocasión?"
3. Si sigue insistiendo, CERRÁ el tema del precio de forma definitiva, SIN sugerir ningún canal de negociación (NO digas "escribíles a Carla y César para algo distinto" ni nada que sugiera que por otra vía podría haber descuento): "Los precios son fijos y no los puedo cambiar 🙂. ¿Avanzamos con tu pedido al precio del menú, o lo dejamos para otra ocasión?".
4. Si DESPUÉS del paso 3 el cliente sigue SOLO con el descuento: no vuelvas a negociar ni a repetir el precio en bucle — una sola vez "Sobre el precio ya está todo dicho 🙂. Si querés, avanzamos con tu pedido." y NO sigas respondiendo al regateo (no des "5 minutos más", no consultes, no derives a negociar).

INCLUIDO GRATIS + BEBIDA ADICIONAL (🚨 regla dura — afecta el cobro)
- 🚨 FUENTE DE VERDAD: las únicas bebidas que existen hoy son las de BEBIDAS DISPONIBLES HOY (en el menú del día de arriba). NO importa que la categoría se llame "jugo o consomé": si hoy solo figura el consomé, el jugo HOY NO EXISTE — no se ofrece, no se incluye, no se cobra como extra. Si el cliente pide una bebida que no está en la lista de hoy, respondé "hoy no tenemos [X], solo [lista de hoy] 🙂" — igual que con un acompañamiento fuera de menú.
- Cada menú (o especial) incluye 1 (UNA) bebida de las disponibles hoy, GRATIS a elección. Preguntá cuál quiere si no lo dijo.
- Esa PRIMERA bebida incluida NUNCA suma al precio. NO es un extra pagado.
- Bebida ADICIONAL = $2.000 c/u, SOLO si esa bebida está en BEBIDAS DISPONIBLES HOY. Si el cliente pide una 2ª bebida que SÍ está hoy (otra, "aparte", "extra"), solo la primera por menú es gratis; cada adicional cuesta $2.000. Aclaráselo amable: "El primero va incluido; cada uno extra son $2.000 🙂" y ponelo en "extras" del item (ej. "consomé extra") — el código lo cobra. 🚫 Si pide como extra una bebida que HOY NO está en el menú (ej. un jugo cuando hoy solo hay consomé), NO la ofrezcas ni la cobres: "hoy no tenemos jugo, solo consomé 🙂".
- WORDING (🚨 cara al cliente):
  - NUNCA uses la palabra "bebida" como etiqueta genérica al cliente — el consomé NO es una bebida (es un caldo). Nombrá cada incluido por su nombre real.
  - En el resumen: "un consomé gratis" / "un jugo gratis" (artículo + nombre + "gratis"). NUNCA "bebida gratis: consomé".
  - En el saludo/ofrecimiento: nombrá la categoría según lo REALMENTE disponible hoy. Si hay dos (jugo y consomé), "jugo o consomé (elegí 1, gratis)". Si hoy hay UNA sola, nombrala sola, ej. "Consomé (incluido, gratis)" — NO digas "jugo o consomé" si el jugo hoy no está. NUNCA "una bebida gratis".
  - 🚫 NUNCA digas "jugo natural" al cliente — decí solo "jugo". El tipo de jugo varía día a día, así que en la pregunta Y en la confirmación usá "jugo" a secas (ej. "¿jugo o consomé?", "anotado el jugo"). Aunque el dato del menú diga "Jugo natural", al cliente nombralo "jugo".
- Lo ÚNICO que se cobra aparte son los items que figuran explícitamente en "Extras opcionales" del menú (con su precio). Nada más suma al precio.

PLATOS ESPECIALES (si el menú del día los tiene) — reglas de precio (🚨 afecta el cobro)
- 🚨 DISPONIBILIDAD: TODO plato que figura en el menú del día publicado está DISPONIBLE HOY — la dueña lo activó para hoy. La descripción del plato (ej. "Solo domingos", "viene preparado") es texto INFORMATIVO del catálogo: NUNCA la uses para negar la disponibilidad ni para rechazar el pedido. Si está en el menú de hoy, se vende hoy.
- Son platos completos con PRECIO PROPIO (ej. Pabellón criollo $9.000), distintos del menú estándar de $7.000.
- NO incluyen los 2 acompañamientos gratis del menú estándar (el especial no trae acompañamientos incluidos).
- JUGO O CONSOMÉ: el especial SÍ incluye 1 jugo o consomé GRATIS a elección, igual que el menú normal. Ofrecéselo. NO suma al precio.
- ACOMPAÑAMIENTOS con un especial: son OPCIONALES, NUNCA obligatorios. El especial se puede pedir SOLO (sin ningún acompañamiento). 🚫 NO fuerces a elegir un acompañamiento, y 🚫 NO agregues un turno extra solo para ofrecerlos: la oferta va EN EL MISMO mensaje que la pregunta del jugo/consomé (UN solo turno). Ej: "¿Jugo o consomé? (gratis, elegí 1) 🙂 Y si querés, podés sumar un acompañamiento (opcional, $2.000 c/u): puré, ensalada, papas o tostones — si no, seguimos así." Si el cliente responde solo la bebida (ej. "jugo") SIN mencionar acompañamiento → eso ES la respuesta completa: AVANZÁ con el flujo SIN re-preguntar por acompañamientos. NUNCA vuelvas a ofrecerlos si ya respondió o declinó. Si pide uno o más, CADA acompañamiento con un especial cuesta $2.000 c/u (sin importar si en el menú normal es gratis: puré, papas mayo, arroz, papas fritas, lo que sea → $2.000 cada uno).
- El cliente puede pedir un especial en vez del menú, o además (en el carrito, como un ítem más).
- El código cobra: precio propio del especial + $2.000 por cada acompañamiento pedido + $0 el jugo o consomé. (Ej. Pabellón $9.000 + papas mayo → $11.000; Pabellón $9.000 sin acompañamientos → $9.000.) Vos solo poné los acompañamientos del especial en "agregados" del item.

CÁLCULO DEL TOTAL Y RESUMEN (🚨 lo hace el CÓDIGO, NO vos)
- NUNCA sumes ni escribas precios, subtotales ni el total. El SISTEMA calcula todo por código desde tu <<PEDIDO>> + la config del menú, y arma el texto del resumen donde pongas {{RESUMEN}}.
- Tu único trabajo es: (1) emitir el <<PEDIDO>> BIEN (items con su proteína, agregados, bebida incluida y extras) y (2) poner {{RESUMEN}} donde quieras que aparezca el desglose. El código garantiza que el total y las líneas SIEMPRE cuadren.
- Las reglas de precio están abajo SOLO para que entiendas el modelo (NO para que sumes a mano): menú $7.000 (incluye 2 acompañamientos + 1 bebida); 3er acompañamiento en adelante $2.000 c/u; especial = su precio propio (sus acompañamientos $2.000 c/u, opcionales); extras $2.000 c/u; jugo/consomé adicional $2.000; delivery centro $1.000. El código las aplica; vos no.
- Si el cliente discute el total, NO defiendas ni recalcules un número: revisá que el <<PEDIDO>> refleje bien lo que pidió y volvé a mostrar {{RESUMEN}} — el código recalcula solo.

REGLA DURA DEL COMPROBANTE (🚨 B1 — el bot NO confirma pagos)
- Pago por transferencia SIN comprobante recibido = pedido NO avanza. Si el cliente dice "después te transfiero": "Sin problema 🙂, apenas me mandes el comprobante lo paso a validar con la pareja."
- CON comprobante recibido = el pedido queda PENDIENTE DE VALIDACIÓN, NO confirmado. El bot NUNCA dice "tu pago está confirmado" ni "entró a cocina" por su cuenta al recibir una foto. Carla y César validan la transferencia a mano en su app; recién ahí el sistema le avisa al cliente que el pago se confirmó. Si la foto es ilegible o no parece un comprobante, igual no la rechaces vos: queda pendiente y la pareja decide.

EMISIÓN DEL PEDIDO (🚨 línea de máquina OBLIGATORIA — el cliente NO la ve, pero el sistema la NECESITA para crear el pedido)
Cuando el pedido quede ESTRUCTURALMENTE COMPLETO (resumen aceptado + modalidad elegida + método de pago elegido), DEBÉS incluir al FINAL de tu mensaje, en una línea aparte, exactamente este bloque. Es la ÚNICA forma de que el pedido se cree: si no lo emitís, el pedido se pierde. El JSON tiene que ser VÁLIDO (comillas dobles, sin comas finales, sin texto extra dentro del bloque):
<<PEDIDO>>{"items":[{"proteina":"...","agregados":["...","..."],"bebida":"...","extras":["..."],"modificaciones":"..."}],"metodo_pago":"transferencia","vuelto":null,"tipo":"delivery","direccion":"...","status":"esperando_comprobante"}<<FIN>>
- 🚫 "proteina" NUNCA puede ser null ni vacía: SIEMPRE repetí el nombre EXACTO del plato (ej. "Sopa de gallina", "Pabellón criollo", "Pollo") en CADA re-emisión del <<PEDIDO>>, aunque ya lo hayas emitido antes. NO inventes campos alternativos (nada de "tipo_plato" ni similares).
- "items" es un array — UN objeto SEPARADO por CADA menú/especial del carrito. Si el carrito tiene 3 platos, el array tiene 3 objetos. NUNCA colapses varios platos en un solo objeto ni los fusiones. Cada objeto lleva SUS PROPIOS "proteina", "agregados", "bebida", "extras" y "modificaciones" — los del cliente que pidió ESE plato, aunque dos platos sean iguales (repetí el objeto). Si una persona pide milanesa con puré y jugo, y otra pide pollo con arroz y consomé, son DOS objetos distintos con sus campos respectivos. NO mezcles los acompañamientos ni las bebidas entre items.
- 🥤 "bebida" (OBLIGATORIO por item): la bebida incluida que el cliente eligió para ESE menú — "jugo" o "consomé" (NUNCA "jugo natural", solo "jugo"). Es gratis, pero la PAREJA NECESITA verla para preparar el pedido. Si el cliente no eligió bebida, poné "bebida": null. NUNCA omitas el campo. (El jugo/consomé EXTRA, 2º en adelante, NO va acá: va en "extras" como "jugo extra".)
- 🚫 NO incluyas un campo "total" ni ningún precio en el <<PEDIDO>> — el sistema calcula el total POR CÓDIGO desde los items + la config del menú. Tu JSON solo describe QUÉ pidió el cliente.
- "extras" (array): los ítems pagos de ESE plato — extras del menú (papas fritas, tostones) y los jugos/consomés ADICIONALES (ej. "jugo extra"). El código los cobra $2.000 c/u.
- "metodo_pago" = "efectivo" o "transferencia" (o null/omitir si todavía no eligió el pago). "vuelto" = número o null. "tipo" = "delivery" o "local". "direccion" = string o null si es local.
- "status": si el pago es TRANSFERENCIA y todavía no llegó el comprobante → "esperando_comprobante". Si el pago es EFECTIVO → "confirmado".
- CUÁNDO emitirlo: emití el <<PEDIDO>> CADA VEZ que muestres el resumen (paso 6, junto con {{RESUMEN}}) Y cuando el cliente elija el método de pago — SIEMPRE con los items actuales del carrito. El sistema crea el pedido en el panel UNA sola vez (cuando ya hay "metodo_pago"); las emisiones del resumen (sin pago aún) solo sirven para que el código arme el desglose. Si en mensajes siguientes el cliente solo manda el comprobante, NO hace falta re-emitir.
- El sistema recorta este bloque; el cliente nunca lo ve. Tu mensaje visible al cliente sigue las reglas normales (para transferencia, seguís diciendo que esperás el comprobante para que entre a cocina).

INFO DEL LOCAL (preguntas frecuentes — respondé con estos datos exactos)
- Dirección del local: Vicuña Mackenna Oriente 6571, La Florida.
- ¿Estacionamiento? "No tenemos estacionamiento (somos Garita)."
- ¿Tienen delivery? "Sí, dentro de 1.5 a 2 km del centro de La Florida."
- ¿Se puede comer en el local? "Sí, te esperamos en Vicuña Mackenna Oriente 6571."
- ¿Aceptan mascotas/perros? "¡Sí! Aceptamos mascotas, podés venir con tu perrito."
- ¿Aceptan reservas? "Sí, aceptamos reservas." Si el cliente quiere CONCRETAR la reserva (fecha, hora, cantidad de personas), no inventes un proceso: confirmá que sí aceptan y decí "Para coordinar los detalles de tu reserva déjame avisarle a la pareja y te confirman en un ratito" (la dueña maneja los detalles a mano).

DELIVERY — zonas y costos (NO calcules automático, el dueño confirma)
- Centro La Florida (hasta ~1.5 km): $1.000 de delivery.
- Más lejos / foráneo: entre $3.000 y $4.000, sujeto a evaluación.
- SIEMPRE pedí la dirección de entrega. NO confirmes el costo de delivery foráneo tú mismo — decí "el costo exacto te lo confirma la pareja según la distancia, ronda los $3.000 a $4.000". El dueño valida manual.

ESCALADO A HUMANO — cuándo derivar a Carla y César
Respondé literalmente "Déjame consultarle a la pareja y vuelvo en un ratito" (y NO sigas respondiendo de ese tema) cuando:
- Te preguntan algo que NO está en el menú ni en INFO DEL LOCAL (ej: "¿hacen eventos?", "¿tienen vegano?"). NOTA: mascotas y reservas YA tienen respuesta en INFO DEL LOCAL — esas respondelas directo, no las escales (salvo concretar los detalles de una reserva).
- 🚨 DETALLE DE UN ÍTEM QUE NO TENÉS CARGADO (regla anti-invención — CRÍTICO por alergias): solo sabés de cada ítem lo que figura EXPLÍCITAMENTE en el menú del día (su nombre y, si la trae, su descripción). Si el cliente pregunta un detalle que NO está cargado —ingredientes, preparación, alérgenos/gluten/lácteos, picante, tamaño/porción, calorías, etc.— NUNCA lo inventes ni supongas, por más plausible que suene. Derivá: "Déjame consultar ese detalle con el local y te confirmo enseguida 🙂". Ej: hay "Carne mechada" en el menú pero nadie cargó con qué viene → si preguntan ingredientes/preparación, NO los inventes → derivá. Un ingrediente inventado puede ser peligroso (alergias). Mejor "lo consulto" que una respuesta falsa.
- Hay una queja, reclamo, o problema con un pedido previo.
- Piden algo fuera de lo común (pedido gigante, factura empresa, condiciones especiales).
- Detectás enojo o frustración del cliente.
NUNCA inventes una respuesta para estos casos. Mejor derivar que improvisar mal. Cuando derivás, el dueño ve la conversación en su teléfono y responde él.
🚨 MARCADOR DE MÁQUINA — REGLA INQUEBRANTABLE: si tu mensaje dice CUALQUIER cosa del tipo "déjame consultar/verificar/preguntar", "lo consulto con la pareja/el local", "te confirmo en un ratito", "vuelvo en un ratito", "déjame avisarle a la pareja" — es decir, si DERIVÁS aunque sea de palabra — TENÉS QUE agregar al FINAL, en una línea aparte, exactamente: <<ESCALAR>>. La frase de derivación y el marcador <<ESCALAR>> van SIEMPRE juntos, nunca uno sin el otro. El cliente NO ve el marcador; el sistema lo usa para avisarle a la pareja. Y cuando derivás, NO sigas avanzando el pedido en ese mismo mensaje (no agregues "mientras tanto, ¿delivery o retiro?") — derivás y esperás. SOLO emitilo cuando realmente derivás (no en un pedido normal).

REGLAS DURAS
- Si el cliente pregunta algo que NO está en el menú ni en INFO DEL LOCAL: "Déjame consultarle a la pareja y vuelvo en un ratito" — NO inventes información.
- Si el cliente pide un plato específico que NO está en el menú de hoy: "Hoy no tenemos eso, pero hoy tenemos: [LISTÁ TODAS las proteínas/opciones del día, no una sola]". Mostrale el abanico completo del día para que elija.
- 🚨 ÍTEMS NO DISPONIBLES — cobertura COMPLETA, agrupá y reemplazá por categoría: si el cliente pide UNO O VARIOS ítems que hoy no están, decíselos TODOS JUNTOS en UNA sola respuesta (NO de a uno). 🔴 REVISÁ CADA ítem que nombró el cliente y declará el que no esté — NO omitas ninguno (ni una bebida, ni un especial, ni algo que no reconozcas). Por CADA faltante, ofrecé el reemplazo de su MISMA categoría: proteína→proteínas del día; acompañamiento→acompañamientos del día; extra→extras del día; bebida→la bebida del día; plato especial→otros especiales. NUNCA ofrezcas una categoría por otra (si falta un extra, NO ofrezcas proteínas) NI ofrezcas reemplazo de una categoría que no faltó.
  • Los PLATOS ESPECIALES son APARTE de las proteínas del día (precio propio) — NUNCA los listes como "proteínas del menú".
  • 3 casos al declarar un ítem: (a) se tiene pero hoy no → "lo tenemos, pero hoy no, otros días sí"; (b) algo que el local NUNCA maneja / no reconocés (ej. patacón, capresa) → "ahora no lo tenemos, quizás más adelante" — NUNCA lo ignores ni lo dejes pasar en silencio (el cliente no debe creer que se lo vas a dar). Regla de oro: a CADA cosa que el cliente pidió, una respuesta — nunca omitas parte del pedido.
  Ej: "Hoy no tenemos carne mechada (proteína), puré (acompañamiento), consomé (bebida) ni sopa de gallina (especial), y el patacón no lo manejamos. Hoy hay → Proteínas: …; Acompañamientos: …; Bebida: …. ¿Qué preferís?".
- NUNCA prometas un horario, precio o producto que no esté en el menú activo o en INFO DEL LOCAL.
- Si el cliente pide ayuda con algo NO relacionado al pedido, redirigí amable al pedido.
- Mantené respuestas <400 caracteres salvo cuando saludás con menú o confirmás un pedido completo.${menuFallback}`;
}

// ── Guard determinista anti-oferta de bebida no disponible (fix jugo, opción 2) ──
// El prompt es probabilístico: ~1/3 de las veces el LLM ofrece igual una bebida que
// HOY no está en el menú (ej. "jugo" cuando solo hay consomé). Esta capa de CÓDIGO
// garantiza al 100% que el cliente nunca vea esa oferta: detecta la violación y
// regenera con corrección; si persiste, usa un fallback seguro. (Cortex/Alberto 2026-06-20.)
const _UNIVERSO_BEBIDAS = ['jugo', 'consome'];

function _norm(s) {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Red de seguridad determinista: derivación verbal sin marcador <<ESCALAR>> ──
// El bot a veces deriva EN EL TEXTO ("déjame consultarle a la pareja", "vuelvo en un
// ratito") pero NO emite <<ESCALAR>> → la conversación no se marca requiere_humano y la
// pareja no se entera (bug real 2026-06-22: consulta de pago con tarjeta). Esta capa de
// CÓDIGO detecta esas frases sobre el texto YA normalizado (sin tildes) y, si aparecen,
// se marca requiere_humano igual. "Mejor marcar de más que de menos" (Alberto).
// OJO: el caller la aplica SOLO cuando NO hubo emisión de <<PEDIDO>>, para no escalar el
// flujo de transferencia ("lo paso a validar con la pareja y te confirmo" va con pedido).
const _FRASES_DERIVACION = [
  /dejame\s+(consultar|consultarle|verificar|averiguar|chequear|preguntar|avisar|avisarle)/,
  /(consult|pregunt|averigu|verific|chequ|avis)\w*\s+(con\s+|a\s+)?(la\s+pareja|el\s+local|los\s+duen|la\s+duen)/,
  /\b(lo|eso|ese\s+detalle|esa\s+consulta)\s+(lo\s+)?consult/,
  /vuelvo\s+en\s+un\s+ratito/,
  /te\s+confirmo\s+(en\s+un\s+ratito|mas\s+tarde|apenas|cuando|luego)/,
];
export function derivacionVerbal(texto) {
  const t = _norm(texto);
  return _FRASES_DERIVACION.some((re) => re.test(t));
}

// Devuelve la bebida NO disponible que la respuesta ofrece/menciona sin declinar, o null.
export function bebidaNoDisponibleOfrecida(texto, menu) {
  const t = _norm(texto);
  // Nombres de bebida publicados hoy, normalizados (ej. ['jugo natural', 'consome']).
  const dispNorm = bebidasCliente(getActiveMenu() ?? menu ?? {}).map(_norm);
  // Una keyword del universo está disponible si ALGÚN nombre publicado la contiene
  // (ej. "Jugo natural" cubre la keyword "jugo"). Evita recortar un jugo válido.
  const disponible = (kw) => dispNorm.some((d) => d.includes(kw));
  for (const b of _UNIVERSO_BEBIDAS) {
    if (disponible(b)) continue;           // está disponible hoy → ok
    if (!t.includes(b)) continue;          // no se menciona → ok
    // Se menciona una bebida NO disponible. Solo es OK si la respuesta NIEGA esa
    // bebida específica, con la negación PEGADA a la bebida. Gaps anchos o un "sin"
    // suelto fallan: p.ej. "...por jugo (sin costo) ... agregar un jugo" hace que
    // "sin" matchee el 2º jugo y dé un falso "declina". Si dudás → tratá como oferta.
    const declina = new RegExp(
      `(no (tenemos|hay|queda|contamos con|disponemos de)|ya no (hay|tenemos|queda)|hoy no (hay|tenemos)|sin)\\s+(m[áa]s\\s+)?${b}` +
      `|${b}\\s+(no (lo )?(tenemos|hay|queda)|se acab|est[áa] agotad|no est[áa] disponible)`,
    ).test(t);
    if (!declina) return b;                // mención no-declinatoria → violación
  }
  return null;
}

// ── Generalización del guard a TODO el menú (Alberto/Cortex 2026-06-20) ──
// El caso "bebida en texto" (arriba) cubre un universo CERRADO {jugo, consomé}.
// Para el resto del menú no hay universo cerrado de "lo no disponible" en texto
// libre (haría falta un catálogo maestro del repertorio, hoy PENDIENTE de Alberto).
// Pero el <<PEDIDO>> que el bot emite es ESTRUCTURADO → podemos validarlo al 100%
// contra el menú del día: ningún ítem que se CONFIRME/COBRE puede estar fuera del
// menú. Cubre platos, bebidas y extras (lo que genera daño real: cobrar/preparar
// algo inexistente). Los acompañamientos incluidos se omiten a propósito: son
// gratis, de bajo riesgo y con alta varianza de fraseo (evita falsos positivos
// que rechacen un pedido válido — el otro error que el piloto no puede tener).

function _parsePedido(texto) {
  const m = (texto ?? '').match(/<<PEDIDO>>([\s\S]*?)<<FIN>>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

// Lo disponible HOY por categoría, normalizado. Proteínas del día (menú $X) y platos
// especiales (precio aparte) van SEPARADOS — no son la misma categoría cara al cliente.
function _disponiblesMenu(menu) {
  const am = getActiveMenu() ?? menu ?? {};
  return {
    platos: (am.proteinas_dia ?? []).filter((p) => p?.disponible !== false).map((p) => _norm(p?.nombre)).filter(Boolean),
    especiales: (am.platos_especiales ?? []).map((e) => _norm(e?.nombre)).filter(Boolean),
    extras: (am.extras_pagados ?? []).map((e) => _norm(e?.nombre)).filter(Boolean),
    bebidas: bebidasCliente(am).map(_norm).filter(Boolean),
    agregados: (am.agregados_incluidos ?? []).map(_norm).filter(Boolean),
  };
}

// inclusión bidireccional: el ítem matchea si comparte el nombre con algo de la lista.
function _matchLista(itemNorm, lista) {
  return !!itemNorm && lista.some((x) => x && (itemNorm.includes(x) || x.includes(itemNorm)));
}

// Devuelve TODAS las violaciones del <<PEDIDO>> (cada ítem fuera del menú del día),
// con su categoría. Permite agrupar los faltantes en una sola respuesta.
export function violacionesPedido(pedido, menu) {
  const out = [];
  if (!pedido || !Array.isArray(pedido.items)) return out;
  const d = _disponiblesMenu(menu);
  for (const it of pedido.items) {
    if (it?.proteina) {
      const p = _norm(it.proteina);
      // la "proteina" del pedido puede ser una proteína del día o un plato especial.
      if (p && !_matchLista(p, [...d.platos, ...d.especiales])) {
        const cat = _matchLista(p, (getRepertorio()?.especiales ?? []).map((e) => _norm(e?.nombre))) ? 'especial' : 'plato';
        out.push({ categoria: cat, item: it.proteina });
      }
    }
    if (it?.bebida) {
      const b = _norm(it.bebida);
      if (b && !_matchLista(b, d.bebidas)) out.push({ categoria: 'bebida', item: it.bebida });
    }
    for (const ag of it?.agregados ?? []) {
      const a = _norm(ag);
      if (a && !_matchLista(a, d.agregados)) out.push({ categoria: 'acompañamiento', item: ag });
    }
    for (const ex of it?.extras ?? []) {
      const e = _norm(ex);
      if (!e) continue;
      // "jugo extra" / "consomé extra": válido SOLO si esa bebida está hoy.
      const kw = e.includes('jugo') ? 'jugo' : e.includes('consome') ? 'consome' : null;
      if (kw) {
        if (!d.bebidas.some((x) => x.includes(kw))) out.push({ categoria: 'bebida', item: ex });
      } else if (!_matchLista(e, d.extras)) {
        out.push({ categoria: 'extra', item: ex });
      }
    }
  }
  return out;
}

// Back-compat: el PRIMER ítem del pedido fuera del menú, o null.
export function pedidoItemNoDisponible(pedido, menu) {
  return violacionesPedido(pedido, menu)[0] ?? null;
}

function _esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ¿"nombre" está en el repertorio (lo ofrece el local ALGÚN día)? Distingue
// "hoy no pero existe" de "no existe" (anti-alucinación). Null si no hay repertorio.
export function enRepertorio(nombre, menu) {
  const rep = getRepertorio();
  if (!rep) return null;
  const n = _norm(nombre);
  if (!n) return false;
  const todos = [
    ...(rep.proteinas ?? []),
    ...(rep.agregados ?? []),
    ...(rep.extras ?? []).map((e) => e?.nombre),
    ...(rep.bebidas ?? []),
    ...(rep.especiales ?? []).map((e) => e?.nombre),
  ].map(_norm).filter(Boolean);
  return _matchLista(n, todos);
}

// ¿el texto `t` (ya normalizado) DECLINA el ítem `n` (ya normalizado)?
// 1) Negación PEGADA al ítem (caso simple, robusto contra "sin" suelto que cruza).
// 2) Frases de REEMPLAZO ("en vez de X", "en lugar de X", "cambiar X").
// 3) Declive en LISTA: "no tenemos A, B, X ni Y" — hay un marcador de negación antes
//    del ítem y NINGÚN marcador de OFERTA entre medio (maneja varios faltantes juntos).
function _declinado(t, n) {
  const e = _esc(n);
  if (new RegExp(
    `(no (tenemos|hay|queda|contamos con|disponemos de)|ya no (hay|tenemos|queda)|hoy no (hay|tenemos)|sin|en vez de|en lugar de|cambi\\w*( el| la| tu| los| las)?)\\s+(m[áa]s\\s+)?${e}` +
    `|${e}\\s+(no (lo )?(tenemos|hay|queda)|se acab|est[áa] agotad|no est[áa] disponible|es (para |de )?otros? d[íi]as|reci[eé]n|vuelve)`,
  ).test(t)) return true;
  // Declive en lista: negación dentro de los ~90 chars previos al ítem, sin oferta entre medio.
  const idx = t.indexOf(n);
  if (idx > 0) {
    const before = t.slice(Math.max(0, idx - 90), idx);
    const negPos = Math.max(
      before.lastIndexOf('no tenemos'), before.lastIndexOf('no hay'),
      before.lastIndexOf('hoy no'), before.lastIndexOf('ya no'),
    );
    if (negPos >= 0) {
      const entre = before.slice(negPos);
      // marcadores de OFERTA que cortan el segmento de declive
      if (!/(s[íi] tenemos|hoy (s[íi] )?tenemos|hoy hay|hoy te|te ofrezco|te recomiendo|tenemos hoy|disponibles?:|ofrec|elig[íe]|qu[ée] prefer)/.test(entre)) {
        return true;
      }
    }
  }
  return false;
}

// TODAS las violaciones detectables en el TEXTO (lo que el cliente VE), con categoría:
// bebidas no disponibles (universo cerrado jugo/consomé) + ítems del repertorio (plato/
// acompañamiento/extra) ofrecidos como disponibles hoy sin declinarlos. El repertorio
// hace que el texto libre sea universo CERRADO. Solo cubre repertorio si está cargado.
export function violacionesTexto(texto, menu) {
  const out = [];
  const t = _norm(texto);
  const am = getActiveMenu() ?? menu ?? {};
  // 1) bebidas (jugo/consomé)
  const dispBeb = bebidasCliente(am).map(_norm);
  for (const b of _UNIVERSO_BEBIDAS) {
    if (dispBeb.some((x) => x.includes(b))) continue;
    if (!t.includes(b)) continue;
    if (_declinado(t, b)) continue;
    out.push({ categoria: 'bebida', item: b });
  }
  // 2) ítems del repertorio (con su categoría)
  const rep = getRepertorio();
  if (rep) {
    const d = _disponiblesMenu(menu);
    const activos = [...d.platos, ...d.especiales, ...d.extras, ...d.agregados];
    const candidatos = [
      ...(rep.proteinas ?? []).map((n) => ({ n, cat: 'plato' })),
      ...(rep.agregados ?? []).map((n) => ({ n, cat: 'acompañamiento' })),
      ...(rep.extras ?? []).map((e) => ({ n: e?.nombre, cat: 'extra' })),
      ...(rep.especiales ?? []).map((e) => ({ n: e?.nombre, cat: 'especial' })),
    ].filter((x) => x.n);
    for (const { n: nombre, cat } of candidatos) {
      const n = _norm(nombre);
      if (!n || n.length < 4) continue;        // nombres muy cortos → ambiguos
      if (_matchLista(n, activos)) continue;   // activo hoy → ok
      if (!t.includes(n)) continue;            // no se menciona → ok
      if (_declinado(t, n)) continue;          // lo declina → ok
      out.push({ categoria: cat, item: nombre });
    }
  }
  return out;
}

// Back-compat: el PRIMER ítem del repertorio (no bebida) ofrecido en texto, o null.
export function itemRepertorioOfrecidoEnTexto(texto, menu) {
  if (!getRepertorio()) return null;
  const v = violacionesTexto(texto, menu).find((x) => x.categoria !== 'bebida');
  return v ? { categoria: 'ítem', item: v.item } : null;
}

// Ítems del MENSAJE DEL CLIENTE (universo cerrado: bebidas + repertorio) que HOY no están.
// Sirve para detectar OMISIONES: ítems que el cliente pidió y el bot no menciona ni declina
// (el guard normal solo mira la respuesta del bot; una omisión no deja rastro ahí).
function _itemsClienteNoDisponibles(userMessage, menu) {
  const out = [];
  const u = _norm(userMessage);
  if (!u) return out;
  const am = getActiveMenu() ?? menu ?? {};
  const dispBeb = bebidasCliente(am).map(_norm);
  for (const b of _UNIVERSO_BEBIDAS) {
    if (dispBeb.some((x) => x.includes(b))) continue;
    if (u.includes(b)) out.push({ categoria: 'bebida', item: b });
  }
  const rep = getRepertorio();
  if (rep) {
    const d = _disponiblesMenu(menu);
    const activos = [...d.platos, ...d.especiales, ...d.extras, ...d.agregados];
    const cands = [
      ...(rep.proteinas ?? []).map((n) => ({ n, cat: 'plato' })),
      ...(rep.agregados ?? []).map((n) => ({ n, cat: 'acompañamiento' })),
      ...(rep.extras ?? []).map((e) => ({ n: e?.nombre, cat: 'extra' })),
      ...(rep.especiales ?? []).map((e) => ({ n: e?.nombre, cat: 'especial' })),
    ].filter((x) => x.n);
    for (const { n: nombre, cat } of cands) {
      const n = _norm(nombre);
      if (!n || n.length < 4) continue;
      if (_matchLista(n, activos)) continue;
      if (u.includes(n)) out.push({ categoria: cat, item: nombre });
    }
  }
  return out;
}

// TODAS las violaciones (texto + pedido + OMISIONES del pedido del cliente), dedup.
// `userMessage` (opcional) habilita la detección de omisiones: ítems del cliente no
// disponibles hoy que el bot no menciona → el bot DEBE declararlos (cobertura completa).
export function menuViolations(texto, menu, userMessage = '') {
  const all = [...violacionesTexto(texto, menu), ...violacionesPedido(_parsePedido(texto), menu)];
  if (userMessage) {
    const tNorm = _norm(texto);
    for (const v of _itemsClienteNoDisponibles(userMessage, menu)) {
      if (tNorm.includes(_norm(v.item))) continue; // el bot ya lo nombró (ofrecido→ya está arriba; declinado→ok)
      all.push(v); // omisión: el cliente lo pidió, hoy no está, y el bot no lo mencionó
    }
  }
  const seen = new Set();
  const out = [];
  for (const v of all) {
    const k = `${v.categoria}|${_norm(v.item)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// Back-compat (tests): la PRIMERA violación con su `tipo` clásico, o null.
export function menuViolation(texto, menu) {
  const tx = violacionesTexto(texto, menu);
  const beb = tx.find((x) => x.categoria === 'bebida');
  if (beb) return { tipo: 'bebida_texto', item: beb.item };
  if (tx.length) return { tipo: 'item_texto', item: tx[0].item, categoria: tx[0].categoria };
  const p = violacionesPedido(_parsePedido(texto), menu)[0];
  if (p) return { tipo: 'pedido', item: p.item, categoria: p.categoria };
  return null;
}

// Opciones del día por categoría (para sugerir reemplazo de la MISMA categoría).
// Proteínas del día (menú) y platos especiales (precio aparte) SEPARADOS.
function _opcionesHoy(menu) {
  const am = getActiveMenu() ?? menu ?? {};
  return {
    plato: (am.proteinas_dia ?? []).filter((p) => p?.disponible !== false).map((p) => p?.nombre).filter(Boolean).join(', ') || '—',
    especial: (am.platos_especiales ?? []).map((e) => `${e?.nombre} ($${e?.precio})`).filter(Boolean).join(', ') || 'ninguno hoy',
    acompañamiento: (am.agregados_incluidos ?? []).join(', ') || '—',
    extra: (am.extras_pagados ?? []).map((e) => e?.nombre).filter(Boolean).join(', ') || 'ninguno hoy',
    bebida: bebidasCliente(am).join(' o ') || '—',
  };
}

const _CAT_LABEL = {
  plato: 'Proteínas del día',
  especial: 'Platos especiales (precio aparte)',
  acompañamiento: 'Acompañamientos',
  extra: 'Extras',
  bebida: 'Bebida',
};

// Corrección AGRUPADA: lista TODOS los faltantes juntos + el reemplazo de la MISMA
// categoría de cada uno, en una sola respuesta (no de a uno). (Mejoras UX Alberto 2026-06-20.)
function _correccionMenuMulti(violations, menu) {
  const op = _opcionesHoy(menu);
  const byCat = {};
  for (const v of violations) (byCat[v.categoria] ??= []).push(v.item);
  const faltantes = Object.entries(byCat)
    .map(([cat, items]) => `${[...new Set(items)].join(', ')} (${_CAT_LABEL[cat] ?? cat})`)
    .join('; ');
  // Solo mostramos las opciones de las categorías afectadas (reemplazo same-category).
  const opciones = Object.keys(byCat)
    .map((cat) => `${_CAT_LABEL[cat] ?? cat}: ${op[cat] ?? '—'}`)
    .join(' · ');
  return `🚨 CORRECCIÓN OBLIGATORIA: de lo que pidió el cliente, estos ítems HOY NO están y tu respuesta debe declararlos TODOS (no omitas ninguno, aunque no lo hayas mencionado): ${faltantes}. En UNA sola respuesta (NO de a uno por turno): decile que hoy no hay esos, y ofrecé el reemplazo de la MISMA categoría de cada uno → ${opciones}. 🚫 NO ofrezcas una categoría por otra (si falta un extra, ofrecé EXTRAS, no proteínas; los platos especiales son APARTE de las proteínas del día). 🚫 NO ofrezcas reemplazo de una categoría que NO faltó. NO agregues los faltantes al <<PEDIDO>>. Devolvé SOLO el mensaje corregido.`;
}

// Fallback determinista (último recurso): mensaje agrupado seguro, sin pedido fantasma.
function _fallbackMulti(violations, menu) {
  const op = _opcionesHoy(menu);
  const byCat = {};
  for (const v of violations) (byCat[v.categoria] ??= []).push(v.item);
  const faltantes = Object.entries(byCat)
    .map(([cat, items]) => `${[...new Set(items)].join(', ')}`)
    .join(', ');
  const opciones = Object.keys(byCat)
    .map((cat) => `${_CAT_LABEL[cat] ?? cat}: ${op[cat] ?? '—'}`)
    .join(' · ');
  return `Mirá, de tu pedido hoy no tenemos: ${faltantes} 🙂. Hoy tenemos → ${opciones}. ¿Qué preferís?`;
}

async function _callLLM(payload) {
  let res, lastErr;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      res = await client.messages.create(payload);
      return res;
    } catch (err) {
      lastErr = err;
      const transient = /premature close|ECONNRESET|ETIMEDOUT|fetch failed|terminated|socket hang up|529|overloaded|503/i.test(
        `${err?.message ?? ''} ${err?.cause?.message ?? ''}`,
      );
      if (intento >= 3 || !transient) throw err;
      await new Promise((r) => setTimeout(r, 400 * intento));
    }
  }
  throw lastErr ?? new Error('generarRespuesta: sin respuesta del LLM');
}

function _textoDe(res) {
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

export async function generarRespuesta({ menu, history, userMessage, sesion = 'nueva', estadoPedido = null }) {
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];
  // Prompt caching: el system prompt es grande y dentro de una conversación es idéntico
  // turno a turno → cache_control lo lee del caché a ~10% del costo. Retry transient
  // (Premature close) dentro de _callLLM (ver fix HTTP/1.1+IPv4 + reintentos).
  const sysText = systemPrompt(menu, sesion, estadoPedido);
  const system = [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }];

  let res = await _callLLM({ model: MODEL, max_tokens: 800, system, messages });
  let texto = _textoDe(res);

  // Guard determinista (todo el menú): si ofrece/confirma algo fuera del menú del día
  // —bebida/ítem en texto o ítem en el <<PEDIDO>>— regenerar con UNA corrección que
  // agrupa TODOS los faltantes + reemplazo de la misma categoría (no goteo de a uno).
  let usageTotal = res.usage;
  const vs0 = menuViolations(texto, menu, userMessage); // faltantes que el cliente pidió originalmente
  for (let intento = 1; intento <= 2; intento++) {
    const vs = menuViolations(texto, menu, userMessage);
    if (!vs.length) break;
    res = await _callLLM({
      model: MODEL, max_tokens: 800,
      system: [...system, { type: 'text', text: _correccionMenuMulti(vs, menu) }],
      messages,
    });
    texto = _textoDe(res);
  }

  // Garantía de COBERTURA (Cortex/Alberto 2026-06-20, prioridad máxima): el bot NUNCA
  // debe dejar SIN DECLARAR un ítem que el cliente pidió y hoy no está. Esto va más allá
  // de "no ofrecer un faltante": exige que CADA faltante requerido esté NOMBRADO en la
  // respuesta final. Si el LLM dejó alguno fuera (silencio) o todavía hay una violación
  // residual, caemos al fallback agrupado y determinista (que los nombra todos).
  const requeridos = _itemsClienteNoDisponibles(userMessage, menu); // universo cerrado del pedido del cliente
  const vsFinal = menuViolations(texto, menu, userMessage);
  const tNorm = _norm(texto);
  const sinDeclarar = requeridos.filter((v) => !tNorm.includes(_norm(v.item)));
  if (vsFinal.length || sinDeclarar.length) {
    // Unión: faltantes originales (vs0) + requeridos del cliente + residuales → lista TODO.
    const seen = new Set();
    const union = [];
    for (const v of [...vs0, ...requeridos, ...vsFinal]) {
      const k = `${v.categoria}|${_norm(v.item)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      union.push(v);
    }
    texto = texto.replace(/<<PEDIDO>>[\s\S]*?<<FIN>>/g, '').trim();
    texto = _fallbackMulti(union, menu);
  }

  return { texto, usage: usageTotal };
}
