// Casos de prueba del bot Sazón. Dos tipos:
//   - scripted: turnos fijos del cliente + rúbrica para el juez (deterministas,
//     baratos, reproducibles). Cubren los bugs B2/B3/B4 y la matriz de texto.
//   - persona:  cliente adversarial dinámico (LLM) con objetivo + rúbrica.
//     Cubren los casos que pidió Alberto (no-avanza, cambia-pedido) y otros.
//
// FUERA DE ALCANCE del harness de texto: B1/C4/C5 (imágenes/comprobantes) van
// por el path de Baileys en handlers.js, no por generarRespuesta. Prueba manual.

import { MENU_CON_PAPAMAYO } from './fixtures.mjs';

export const CASOS = [
  // ── Modelo de agregados / precios (reglas confirmadas por Alberto 2026-06-06) ─
  // Fuente de verdad = lo HABILITADO en el menú del día. ≤2 agregados gratis
  // (aunque se repitan); 3º+ a $2.000; extras exclusivos $2.000 siempre.
  {
    id: 'A-papamayo-off',
    tipo: 'scripted',
    desc: 'Papa mayo NO habilitada hoy → rechazar',
    // menú default (MENU_PRUEBA) NO incluye papa mayo
    turns: ['hola', 'un menú de pollo asado con papa mayo y arroz'],
    criterios:
      'Hoy NO está habilitada la papa mayo (no figura en los agregados del día: puré, arroz, ensalada, papas, porotos, tajadas). El bot debe rechazar la papa mayo y ofrecer la lista real. FALLA si la acepta. (El arroz sí es válido.)',
  },
  {
    id: 'A-papamayo-on',
    tipo: 'scripted',
    menu: MENU_CON_PAPAMAYO,
    desc: 'Papa mayo habilitada hoy → aceptar como agregado incluido',
    turns: ['hola', 'un menú de pollo asado con papa mayo y arroz, para retirar', 'jugo natural'],
    criterios:
      'Hoy SÍ está habilitada la papa mayo. Son 2 agregados (papa mayo + arroz) → incluidos, el menú vale $7.000. El bot debe aceptarlos y el total debe ser $7.000. FALLA si rechaza papa mayo o si cobra extra por el 2º agregado.',
  },
  {
    id: 'A-doble-gratis',
    tipo: 'scripted',
    menu: MENU_CON_PAPAMAYO,
    desc: 'Doble del mismo agregado (=2) → gratis, $7.000',
    turns: ['hola', 'un menú de pollo asado con doble papa mayo, para retirar', 'consomé'],
    criterios:
      'Doble papa mayo = 2 agregados → incluidos. El total debe ser $7.000 (NO cobrar el 2º). FALLA si cobra $2.000 por la papa mayo repetida o da un total distinto de $7.000.',
  },
  {
    id: 'A-tercero-paga',
    tipo: 'scripted',
    menu: MENU_CON_PAPAMAYO,
    desc: '3er agregado → +$2.000 ($9.000)',
    turns: ['hola', 'un menú de pollo con papa mayo, arroz y ensalada, los tres, para retirar', 'jugo natural'],
    criterios:
      'Son 3 agregados (papa mayo, arroz, ensalada). Los 2 primeros gratis, el 3º cuesta +$2.000. Total esperado $9.000. El bot debe avisar el costo del 3er agregado y el total debe ser $9.000. FALLA si da $7.000 o no cobra el 3º.',
  },
  {
    id: 'A-extra-exclusivo',
    tipo: 'scripted',
    desc: 'Extra exclusivo (papas fritas) → +$2.000 siempre',
    turns: ['hola', 'un menú de carne mechada con puré y ensalada, y agregale papas fritas, para retirar', 'jugo natural'],
    criterios:
      'Papas fritas es un extra exclusivo (figura en extras_pagados a $2.000), NO un agregado incluido. Total = $7.000 (menú con 2 agregados) + $2.000 (papas fritas) = $9.000. FALLA si no cobra las papas fritas o las trata como agregado gratis.',
  },
  {
    id: 'A-especial',
    tipo: 'scripted',
    desc: 'Especial (Pabellón) + 1 agregado → cada agregado $2.000',
    turns: ['hola', 'quiero un pabellón criollo con puré, para retirar', 'jugo natural'],
    criterios:
      'El Pabellón criollo es especial ($9.000). SÍ incluye jugo o consomé gratis (igual que el menú normal) — ofrecerlo es CORRECTO. La única diferencia del especial es que NO trae los 2 agregados gratis: cualquier agregado cuesta $2.000. El puré con el especial cuesta $2.000. Total esperado $11.000 (la bebida gratis no suma). El bot debe mostrar el total $11.000 proactivamente al cerrar. FALLA si da $9.000 (no cobró el agregado), o si NO muestra el total final. Ofrecer jugo/consomé NO es falla.',
  },

  // ── Scripted: bugs y matriz de texto ──────────────────────────────────────
  {
    id: 'C1-B2',
    tipo: 'scripted',
    desc: 'Pide agregado inexistente ("papa mayo")',
    turns: [
      'hola',
      'quiero un menú de carne mechada con papa mayo y otras papas',
    ],
    criterios:
      'El bot NO debe aceptar "papa mayo" ni "otras papas" (no están en el menú: puré, arroz, ensalada, papas, porotos, tajadas). Debe rechazar el ítem inexistente y ofrecer la lista real de agregados. FALLA si los toma como válidos o cierra el pedido con ellos.',
  },
  {
    id: 'C2',
    tipo: 'scripted',
    desc: 'Pide proteína no disponible hoy',
    turns: ['hola', 'tienen pescado frito?'],
    criterios:
      'El pescado no está en el menú de hoy (carne mechada, pollo asado). El bot debe decir que hoy no hay eso y ofrecer las proteínas reales del día. FALLA si dice que sí tiene pescado o lo agrega.',
  },
  {
    id: 'C3',
    tipo: 'scripted',
    desc: 'Pide 3 agregados en menú estándar (debe cobrar el 3ro)',
    turns: [
      'hola',
      'un menú de pollo asado con puré, arroz y ensalada, los tres',
    ],
    criterios:
      'El menú estándar incluye 2 agregados; el 3ro cuesta +$2.000. El bot debe avisar que el 3er agregado tiene costo extra y reflejarlo en el total. FALLA si da 3 agregados sin cobrar el extra.',
  },
  {
    id: 'C10-B3',
    tipo: 'scripted',
    desc: 'Delivery debe sumarse al total automáticamente',
    turns: [
      'hola',
      'quiero un menú de carne mechada con puré y ensalada',
      'jugo natural',
      'para delivery, en el centro de La Florida, calle Serrano 123',
    ],
    criterios:
      'Es delivery centro (~$1.000). El total final que muestra el bot DEBE incluir el delivery ($7.000 + $1.000 = $8.000) sin que el cliente tenga que preguntar. FALLA si muestra $7.000 como total final o no suma el delivery.',
  },
  {
    id: 'C13-B4',
    tipo: 'scripted',
    desc: 'Proactividad: resumen y total sin que se lo pidan',
    turns: [
      'hola',
      'un menú de carne mechada con arroz y ensalada, jugo natural, para retirar',
    ],
    criterios:
      'Tras tener los datos, el bot debe dar PROACTIVAMENTE un resumen del pedido con el total, sin que el cliente pregunte "cuánto es" o "cuál es mi pedido". FALLA si no muestra total/resumen y espera la pregunta.',
  },
  {
    id: 'C8',
    tipo: 'scripted',
    desc: 'Pregunta fuera de menú (vegano) → escalar a humano',
    turns: ['hola', 'tienen opciones veganas?'],
    criterios:
      'Vegano no está en el menú ni en info del local. El bot debe escalar: "Déjame consultarle a la pareja y vuelvo en un ratito" y NO inventar una respuesta. FALLA si inventa que sí/no tienen vegano.',
  },
  {
    id: 'C9',
    tipo: 'scripted',
    desc: 'Delivery foráneo (lejos) → no fija costo, lo confirma el local',
    turns: [
      'hola',
      'hacen delivery a Puente Alto?',
    ],
    criterios:
      'Puente Alto es foráneo/lejos. El bot NO debe fijar un costo exacto; debe decir que el costo lo confirma la pareja según la distancia (ronda $3.000-$4.000). FALLA si promete un costo cerrado de delivery foráneo.',
  },

  {
    id: 'A-delivery-prematuro',
    tipo: 'scripted',
    desc: 'B3 real: ¿muestra total $7.000 ANTES de saber la modalidad?',
    turns: [
      'hola',
      'un menú de carne mechada con puré y ensalada',
      'jugo natural',
      'eso es todo',
    ],
    criterios:
      'El cliente cierra el carrito SIN haber dicho aún si es delivery o retiro. El bot NO debe presentar un "Total: $7.000" como total final/cerrado antes de capturar la modalidad (porque si después es delivery, cambia a $8.000). Comportamiento esperado: preguntar primero delivery/retiro, o si muestra un monto marcarlo como "subtotal (sin delivery)". FALLA si muestra "Total: $7.000" como total del pedido sin antes preguntar la modalidad — eso es el bug B3 (total prematuro que confunde).',
  },
  {
    id: 'A-delivery-suma',
    tipo: 'scripted',
    desc: 'Delivery centro $1.000 SE SUMA al total final ($8.000)',
    turns: [
      'hola',
      'un menú de carne mechada con puré y ensalada',
      'jugo natural',
      'para delivery, calle Serrano 123, La Florida centro, es casa',
      'pago en efectivo, no necesito vuelto',
    ],
    criterios:
      'Pedido de un menú ($7.000) con delivery al centro de La Florida (+$1.000). El total FINAL que muestra el bot al cerrar DEBE ser $8.000 (menú + delivery), mostrado proactivamente. FALLA si el total final es $7.000, si omite el delivery, o si nunca muestra el total con el delivery sumado.',
  },

  // ── Persona: adversariales dinámicos ──────────────────────────────────────
  {
    id: 'P-no-avanza',
    tipo: 'persona',
    persona: 'no_avanza',
    maxTurns: 8,
    desc: 'Cliente que charla sin intención de pedir',
    criterios:
      'Ante un cliente que solo pregunta cosas sueltas sin pedir comida, el bot debe responder pero REDIRIGIR hacia el pedido, no seguir la charla indefinidamente. Idealmente, tras un par de desvíos, invita a pedir o deriva. FALLA si entra en charla infinita sin ningún intento de encauzar al pedido.',
  },
  {
    id: 'P-cambia-pedido',
    tipo: 'persona',
    persona: 'cambia_pedido',
    maxTurns: 10,
    desc: 'Cliente que cambia de pedido constantemente',
    criterios:
      'Ante un cliente que cambia de proteína/agregado/especial repetidamente, el bot debe mantener un carrito COHERENTE, reflejando siempre el último estado pedido, sin mezclar ítems viejos ni perder el hilo. El total final debe corresponder al último pedido real. FALLA si se confunde, suma ítems descartados, o pierde el estado.',
  },
  {
    id: 'P-cuela-fuera-menu',
    tipo: 'persona',
    persona: 'cuela_fuera_menu',
    maxTurns: 8,
    desc: 'Cliente que insiste en ítems fuera de menú',
    criterios:
      'El bot debe rechazar consistentemente TODO ítem que no esté en el menú de hoy, por más que el cliente insista o lo pida de otra forma. FALLA si en algún momento acepta un ítem inexistente.',
  },
  {
    id: 'P-regatea',
    tipo: 'persona',
    persona: 'regatea',
    maxTurns: 7,
    desc: 'Cliente que intenta negociar el precio',
    criterios:
      'El bot debe mantener los precios del menú sin ceder a descuentos ni regateos. Puede ser amable pero no baja el precio ni inventa promociones. FALLA si ofrece descuento o cambia el precio.',
  },
  {
    id: 'P-regatea-terco',
    tipo: 'persona',
    maxTurns: 10,
    persona: {
      desc: 'Cliente que regatea de forma terca y persistente',
      goal: 'Querés un descuento y NO te rendís. Empezás pidiendo rebaja. Cuando te dicen que no, insistís de otra forma: que sos cliente frecuente, que tenés poca plata, que en otro lado es más barato, que solo esta vez, que redondeen para abajo. Seguís insistiendo en el descuento mensaje tras mensaje aunque te digan que no. Tu meta es ver cuántas veces aguanta el bot antes de ceder, derivarte, o cortar el tema. No cierres el pedido al precio normal: tu fijación es el descuento.',
    },
    desc: 'Cliente que regatea terco y NO se rinde (mide la escalada)',
    criterios:
      'Ante un cliente que insiste en el descuento mensaje tras mensaje, el bot debe: (1) mantener SIEMPRE el precio del menú sin ceder; (2) NO ofrecerse como intermediario para "pasar la propuesta" a los dueños; (3) tras varias insistencias, derivar cordialmente a humano o cerrar el tema sin seguir alimentando el regateo. FALLA si cede, abre la puerta a un descuento, o se engancha indefinidamente repitiendo lo mismo sin escalar a derivación.',
  },
];
