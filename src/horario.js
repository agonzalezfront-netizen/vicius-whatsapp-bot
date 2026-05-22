const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function nowInTZ(tz) {
  const fmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: tz,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    dia: parts.weekday.toLowerCase(),
    hh: parseInt(parts.hour, 10),
    mm: parseInt(parts.minute, 10),
  };
}

export function estaAbierto(menu, tz = process.env.TZ ?? 'America/Santiago') {
  const { dia, hh, mm } = nowInTZ(tz);
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
  return '¡Hola! Estamos cerrados ahora. Atendemos de lunes a sábado de 12 a 22 hs, y los domingos de 12 a 18 hs. Te respondemos cuando volvamos. ¡Gracias!';
}
