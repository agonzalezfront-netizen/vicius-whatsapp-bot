// Registro de tenants (negocios). Cada número de WhatsApp Business = un tenant,
// identificado por su `phone_number_id` (lo trae el webhook de Meta). Multi-tenant
// ready: hoy arranca con UN tenant desde env (el piloto Sazón), pero el ruteo ya es
// por phone_number_id, así que sumar negocios = agregar entradas, sin tocar el flujo.
//
// Env del tenant único (Fase A, piloto):
//   WA_PHONE_NUMBER_ID   id del número de prueba/productivo (de la app de Meta)
//   WA_TOKEN             access token (temp 24h al inicio → System User permanente)
//   WA_BUSINESS_NAME     nombre legible (opcional, para logs)
//   WA_TENANT_SLUG       slug del LOCAL (multitenant F1.5) — default 'sazon' (el primer local, ver
//                        plan 2026-08-05: "sazon es el primer local"). Determina qué menú (por
//                        local_slug) sirve el bot para este número.
//
// A futuro (multi-negocio): WA_TENANTS = JSON [{phoneNumberId, token, name, slug}, ...]. `slug`
// mapea el phone_number_id de CADA tenant a su local en el wizard (locales.phone_number_id) → el
// ciclo por turno resuelve slug=getTenant(phoneNumberId).slug y pide getActiveMenu(slug).

const _byPhoneId = new Map();

function register(t) {
  if (!t?.phoneNumberId || !t?.token) return;
  _byPhoneId.set(String(t.phoneNumberId), {
    phoneNumberId: String(t.phoneNumberId),
    token: t.token,
    name: t.name ?? 'sazon',
    // slug ausente/null → el bot cae al menú default (back-compat, mandato F1.5 #3: un tenant sin
    // slug sigue funcionando como hoy, no rompe al Sazón mientras no se le asigne uno explícito).
    slug: t.slug ?? null,
  });
}

export function loadTenantsFromEnv() {
  _byPhoneId.clear();
  // Multi-tenant explícito (JSON) tiene precedencia.
  if (process.env.WA_TENANTS) {
    try {
      const arr = JSON.parse(process.env.WA_TENANTS);
      if (Array.isArray(arr)) arr.forEach(register);
    } catch {
      // si el JSON está mal, caemos al tenant único
    }
  }
  // Tenant único (piloto).
  if (process.env.WA_PHONE_NUMBER_ID && process.env.WA_TOKEN) {
    register({
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
      token: process.env.WA_TOKEN,
      name: process.env.WA_BUSINESS_NAME ?? 'sazon',
      // Default 'sazon' (primer local, plan F1). Inofensivo hasta que el wizard publique menú por
      // slug (F1.2/F1.3): mientras `menuBySlug` no tenga 'sazon', getActiveMenu('sazon') cae igual
      // al default — cero cambio de comportamiento hoy.
      slug: process.env.WA_TENANT_SLUG ?? 'sazon',
    });
  }
  return _byPhoneId.size;
}

export function getTenant(phoneNumberId) {
  return _byPhoneId.get(String(phoneNumberId)) ?? null;
}

export function tenantCount() {
  return _byPhoneId.size;
}
