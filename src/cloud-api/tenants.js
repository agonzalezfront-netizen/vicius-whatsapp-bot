// Registro de tenants (negocios). Cada número de WhatsApp Business = un tenant,
// identificado por su `phone_number_id` (lo trae el webhook de Meta). Multi-tenant
// ready: hoy arranca con UN tenant desde env (el piloto Sazón), pero el ruteo ya es
// por phone_number_id, así que sumar negocios = agregar entradas, sin tocar el flujo.
//
// Env del tenant único (Fase A, piloto):
//   WA_PHONE_NUMBER_ID   id del número de prueba/productivo (de la app de Meta)
//   WA_TOKEN             access token (temp 24h al inicio → System User permanente)
//   WA_BUSINESS_NAME     nombre legible (opcional, para logs)
//
// A futuro (multi-negocio): WA_TENANTS = JSON [{phoneNumberId, token, name}, ...].

const _byPhoneId = new Map();

function register(t) {
  if (!t?.phoneNumberId || !t?.token) return;
  _byPhoneId.set(String(t.phoneNumberId), {
    phoneNumberId: String(t.phoneNumberId),
    token: t.token,
    name: t.name ?? 'sazon',
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
