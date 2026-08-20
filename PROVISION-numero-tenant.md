# Provisión de un número WhatsApp por local (activar un tenant nuevo)

> Estado: 2026-08-20 · Autor: Vicius · Contexto: activar A Sushi si firma (reunión 21-08).
> Este documento responde el encargo #2 del backlog ultracode: **qué se necesita para dar de alta
> un número WhatsApp nuevo apuntando a un tenant, cuánto tarda, y qué pasos son de Alberto vs Vicius.**

## TL;DR para la promesa de mañana

- **El motor del bot ya es multi-tenant** (rutea por `phone_number_id` → tenant → slug; ver
  `src/cloud-api/tenants.js`). Sumar A Sushi = **una entrada de config + registrar su número**, sin tocar
  el flujo. No hay trabajo de ingeniería pendiente en el camino crítico.
- **No hay bloqueo externo de días** SI usamos la WABA ya verificada del Sazón: la *Business Verification*
  (lo que tarda días/semanas en Meta) **ya está hecha**. Agregar un número a un negocio verificado solo
  pide **verificar el número** (código por SMS o llamada) → minutos.
- **⚠️ Decisión de negocio que define la promesa** (hay que aclararla con Mauricio ANTES de prometer):
  **en Chile no existe "coexistence"**. El número que se conecte al bot (Cloud API) **deja de funcionar
  como WhatsApp normal / WhatsApp Business App** en ese teléfono. Hay dos caminos con trade-offs distintos
  (abajo). Prometer "su WhatsApp de siempre, y además usted sigue respondiendo a mano cuando quiera" **no
  es posible** con este stack.

## Los dos caminos (elegir con el cliente)

### Camino A — número nuevo dedicado al bot (recomendado para arrancar)
Un chip/número nuevo, exclusivo del bot. **El cliente no pierde nada** de su WhatsApp actual.
- **Contra**: los clientes de A Sushi deben conocer el número nuevo (se pone en la carta, redes, Google).
- **A favor**: cero riesgo, reversible, se puede probar en paralelo sin tocar su operación actual.
- **SLA**: **mismo día** (horas). Es el que permite la promesa más segura para mañana.

### Camino B — migrar el número actual de A Sushi al bot
Se usa el número que sus clientes ya conocen.
- **Contra (grande)**: ese número **se desconecta del WhatsApp/WhatsApp Business App** — Mauricio ya no
  puede abrir la app y chatear con ese número; todo pasa por el bot/panel. Es irreversible en la práctica
  (para volver hay que des-registrarlo de Cloud API y re-vincularlo a la app, con fricción).
- **Requisito**: el número no puede estar activo en otra cuenta de WhatsApp Business API; si hoy usa la
  WhatsApp Business App, hay que desvincularlo primero.
- **SLA**: **mismo día** también (la verificación es igual de rápida), pero **requiere ventana coordinada**
  con A Sushi porque hay corte del WhatsApp manual de ese número.

**Recomendación Vicius**: arrancar por **A** (número dedicado). Si A Sushi valida el bot y quiere su
número de siempre, migramos a **B** en una ventana acordada. Prometer sobre A es lo honesto para mañana.

## Procedimiento técnico (Camino A, número nuevo)

Pasos verificados en el cutover del Sazón (2026-06-19). Referencias: memorias
`whatsapp-cloud-api-activar-numero-register-waba` y `whatsapp_webhook_override_por_waba_staging`.

| # | Paso | Quién | Tiempo | Notas |
|---|------|-------|--------|-------|
| 1 | Conseguir el número/chip nuevo (recibe SMS o llamada) | **Alberto** (físico) | según compra del chip | Puede ser un chip prepago; debe poder recibir el código de verificación de Meta |
| 2 | Agregar el número a la WABA en Meta Business Manager + verificarlo (código SMS/llamada) | **Alberto** (acceso al Business Manager + al teléfono) | ~10-20 min | La *Business Verification* NO se repite: la WABA ya está verificada |
| 3 | Definir el PIN de 2FA del número (6 dígitos) | **Alberto** (lo elige) / Vicius lo carga | 1 min | Va a `WA_REGISTER_PIN` |
| 4 | `POST /{phone_number_id}/register` con el PIN → estado `CONNECTED` | **Vicius** | segundos | Sin esto, otros teléfonos ven "el número no está en WhatsApp". Endpoint helper: `POST /admin/register?key=<WA_VERIFY_TOKEN>` |
| 5 | Suscribir la WABA a la app (`subscribed_apps`) | **Vicius** (automático al bootear con el token) | segundos | El bot auto-suscribe; si es WABA nueva, confirmar con `GET /{waba-id}/subscribed_apps` |
| 6 | Poblar `WA_TENANTS` en Railway con `{phoneNumberId, token, slug:"asushi"}` | **Vicius** | 2 min | Bloqueador #4. Sin esto el bot no conoce el nuevo número |
| 7 | Publicar el menú de A Sushi por slug en el wizard (`local_slug=asushi`) | **Vicius** | ya existe la carta del demo | El bot pide `getActiveMenu("asushi")` |
| 8 | Redeploy manual del bot en Railway + verificar `GET /healthz/meta` = `CONNECTED` | **Vicius** | ~3-5 min | Deploy manual (ver memoria `whatsapp-bot-deploy-manual-railway`) |

**SLA total Camino A**: **el mismo día**, típicamente **1-3 horas** de trabajo efectivo una vez que Alberto
tiene el chip y acceso al Business Manager. El único factor que puede estirarlo es conseguir el chip físico
(paso 1) — eso es de Alberto y conviene tenerlo listo ANTES de la firma.

## Qué falta técnicamente (fuera del camino crítico)

- **Bloqueador #4** (poblar `WA_TENANTS`): trivial, espera el número real (paso 6).
- **Bloqueador #1** (Menu Manager multi-tenant: publicar/editar el menú de A Sushi desde el panel por
  slug): **post-firma**. Para el arranque, el menú de A Sushi ya existe como config del tenant (el mismo
  del demo `:5100`); editarlo desde la UI del panel es una mejora, no un bloqueo de activación.
- **#5** (LLM por slug): no urgente — prod corre en modo botones (`MODE_BUTTONS`), no LLM.
- **#2 y #3** (estado de flujo por `(jid, local_slug)` + pedido con `local_slug`): **ya commiteados**
  (`3d120b2`, `1c55812`), con tests en `qa-harness/test-multitenant-menu.mjs`.

## Riesgo a vigilar (no bloquea mañana, sí el volumen)

Un número nuevo arranca en un **tier de mensajería bajo** (límite de conversaciones *iniciadas por el
negocio* por día: 250 → 1K → …, sube con calidad/uso). Para A Sushi esto **casi no aplica**: el bot
responde a clientes que escriben primero (ventana de 24h, no cuenta contra el tier de iniciadas). Solo
importaría si A Sushi quisiera hacer campañas salientes masivas — ahí sí hay rampa. Lo dejo señalado para
no prometer envío masivo el día 1.
