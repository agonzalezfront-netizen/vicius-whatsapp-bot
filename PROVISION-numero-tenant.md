# Provisión de un número WhatsApp por local (activar un tenant nuevo)

> ## ✅ EJECUTADO 2026-09-07 — A Sushi CONECTADO (verificado por conducta)
> - Número **A Sushi +56 9 7554 2324** · phone_number_id **1270562506150335** · WABA 1041108798337758 (la del Sazón).
> - **Register**: `POST graph.facebook.com/v25.0/1270562506150335/register` `{messaging_product:whatsapp, pin:836372}` → `{"success":true}`.
> - **WA_TENANTS** (Railway `vicius-whatsapp-bot`, `--skip-deploys`): `[{phoneNumberId:"1270562506150335", token:<WA_TOKEN>, name:"A Sushi", slug:"asushi"}]`.
>   **NO se tocó `WA_PHONE_NUMBER_ID`** (Sazón `1184719278057586`): `loadTenantsFromEnv` carga AMBOS (WA_TENANTS + tenant único del env). Menor riesgo.
> - **Redeploy**: `railway redeploy --service vicius-whatsapp-bot -y` (commit `982ca0d`, no retrocedió).
> - **Verificado**: `/healthz` tenants:2; A Sushi status CONNECTED (Meta Graph, VERIFIED); Sazón CONNECTED (preservado);
>   aislamiento de menú OK (`viciusstudio.cl/wizard/api/web/menu?local=asushi` → 16 secciones de A Sushi).
> - **Pendiente**: test de mensaje real (mandar WhatsApp al número → el bot responde carta de A Sushi). Rollback: Railway 1 clic.

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

---
## A SUSHI — número registrado en Meta 2026-09-07 15:27 (Cortex, vía Business Manager)
- Número: **+56 9 7554 2324** (+56975542324)
- Nombre visible: **A Sushi** · Categoría: Comida y comestibles
- **phone_number_id: 1270562506150335**
- WABA: la misma del Sazón (business_id 956631390702915, asset_id 1041108798337758)
- Estado en Meta: **Pendiente** (verificado por SMS; NO conectado a Cloud API todavía)
- FALTA (no chip-dependiente, bloqueado por acceso a la Railway del bot):
  1. register: POST /1270562506150335/register con PIN 2FA (via WA_TOKEN del bot) → CONNECTED
  2. WA_TENANTS += {phoneNumberId:"1270562506150335", token, slug:"asushi"} + redeploy del bot
  3. verificar /healthz/meta muestre el número CONNECTED

---
## ✅ CHECKLIST A→Z de alta de tenant (post-BUG 2324, 2026-09-18) — AUTORITATIVO

> Este checklist REEMPLAZA la lectura suelta de la tabla de arriba como "definición de terminado". Nace del
> BUG 2324: el número de A Sushi respondía con la **carta vieja del Sazón** (menú de junio). Causa raíz
> confirmada en vivo: un slug propio (≠ sazon) **sin menú propio publicado en el bot Y sin `modo:"app"`**
> cae a `getActiveMenu(slug)` → slot DEFAULT → el último menú publicado (el del Sazón, local cerrado). El
> sensor `qa-harness/verif_tenant_numero.py` corrido contra prod lo detectó: default = "Viernes 1"
> (2026-06-25), 85 días viejo.

### Regla de oro (la que evita el 2324)
Un tenant con número propio SIEMPRE debe tener **una** de estas dos formas de contenido — nunca ninguna:

- **(A) modo `app`** — `WA_TENANTS[i]` con `modo:"app"` + `cartaUrl` (o `copy`). El bot manda UN mensaje
  único con el link a la carta web y calla durante la ventana (reusa la guarda de derivación). Es lo que
  usa **asushi** hoy. Elegir esta si el pedido va por la carta web (`/pedir/<slug>`).
- **(B) menú propio en el bot** — publicar el menú del local por slug para que `hasOwnMenu(slug)` sea true
  y el flujo conversacional sirva SU carta. Elegir esta solo si el local opera el flujo conversacional.

Si un slug ≠ sazon no tiene ni (A) ni (B) → **cae al default** (bug 2324). El bot ya tiene una red: sin
menú propio ni modo app manda un mensaje **neutro** ("no estamos tomando pedidos por acá"), NO la carta
ajena — pero eso es el fallback de seguridad, no un alta correcta.

### Pasos (con dueño y gate)
| # | Paso | Quién | Gate de verificación |
|---|------|-------|----------------------|
| 1 | Número en Meta: agregado a la WABA verificada + verificado por SMS/llamada | **Alberto** (físico + Business Manager) | Aparece en Business Manager |
| 2 | `POST /{pnid}/register` con PIN 2FA → CONNECTED | **Vicius** | `GET /healthz/meta` muestra el número CONNECTED |
| 3 | Elegir forma de contenido: **(A) modo app** o **(B) menú propio** (regla de oro) | **Vicius** + decisión de negocio | — |
| 4 | `WA_TENANTS` en Railway: entrada `{phoneNumberId, token, name, slug}` **+ si es (A): `modo:"app"` + `cartaUrl`** | **Vicius** | — |
| 4b | `cartaUrl` sale del config del tenant, no inventado (la carta real y viva: `GET <cartaUrl>` = 200) | **Vicius** | `curl <cartaUrl>` → 200 |
| 5 | **Gate del sensor**: `verif_tenant_numero.py` con `WA_TENANTS` real + `BOT_HEALTHZ` de prod → PASS | **Vicius** | ver comando abajo — DEBE dar `TENANT-NUMERO: PASS` |
| 6 | Redeploy manual del bot en Railway (el push NO auto-deploya; memoria `whatsapp-bot-deploy-manual-railway`) | **Vicius** | deploy SUCCESS + `GET /healthz` `commit` esperado y `tenants` con el nuevo |
| 7 | **PRUEBA DE MENSAJE REAL (obligatoria, no salteable)**: mandar WhatsApp al número desde OTRO teléfono | **Alberto/Cortex** (brazo `wa_send.py`) | pegar la respuesta textual en el puente; debe ser la carta/flujo del tenant correcto, NO la del Sazón |
| 8 | Archivar (NO borrar) el menú default viejo si el sensor lo marca stale | **Vicius/Cortex** (dato de prod) | re-correr sensor con `BOT_HEALTHZ` → sin flag de default viejo |

### Gate del sensor (paso 5) — copy-paste
```bash
cd whatsapp-bot
WA_TENANTS='<el JSON real de Railway>' \
BOT_HEALTHZ=https://vicius-whatsapp-bot-production.up.railway.app \
python qa-harness/verif_tenant_numero.py     # exit 0 = PASS; 1 = FALLA (no dar de alta)
```
Chequea: (1) todo slug ≠ sazon tiene `modo:"app"` (+ cartaUrl/copy) o queda documentado que tiene menú
propio; (2) el slot default de prod no sirve un menú viejo de un local cerrado.

### 🚫 "Usable" NO es "según /healthz"
`/healthz` dice CONNECTED aunque el bot conteste con la carta equivocada (fue el caso del 2324). Un número
**no se declara usable sin el paso 7** (mensaje real + respuesta pegada al puente). El sensor y healthz son
la red barata ENTRE pruebas reales, no las reemplazan.
