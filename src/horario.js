const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function nowInTZ(tz, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: tz,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  let hh = parseInt(parts.hour, 10);
  if (hh === 24) hh = 0; // es-CL hour12:false puede dar "24" a medianoche
  return { dia: parts.weekday.toLowerCase(), hh, mm: parseInt(parts.minute, 10) };
}

// `now` opcional (default ahora) para poder testear horarios sin depender del reloj.
export function estaAbierto(menu, tz = process.env.TZ ?? 'America/Santiago', now = new Date()) {
  const { dia, hh, mm } = nowInTZ(tz, now);
  const rango = menu.horario?.[dia];
  if (!rango) return false;
  const [openH, openM] = rango.abre.split(':').map(Number);
  const [closeH, closeM] = rango.cierra.split(':').map(Number);
  const minutosAhora = hh * 60 + mm;
  const minutosAbre = openH * 60 + openM;
  const minutosCierra = closeH * 60 + closeM;
  return minutosAhora >= minutosAbre && minutosAhora < minutosCierra;
}

export function mensajeCerrado() {
  return '¡Hola! 🙂 En este momento estamos cerrados.\n\n🕐 *Horario:*\n• Lunes a sábado: 12 a 19 hs\n• Domingos: 12 a 18 hs\n\nDejanos tu mensaje y Carla y César te responden apenas abramos. ¡Gracias! 🧡';
}
