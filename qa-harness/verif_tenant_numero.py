# -*- coding: utf-8 -*-
"""Sensor de contingencia (BUG 2324, 18-09) — cada número atiende al tenant correcto, ninguno cae al default viejo.

Nace del bug: el número de A Sushi respondía con la carta vieja del Sazón porque su tenant no tenía menú propio ni
`modo:"app"` → `getActiveMenu(slug)` caía al slot default (menú del Sazón, local cerrado).

Chequeos (deterministas, sin enviar WhatsApp — la prueba REAL de mensaje es aparte y obligatoria en el alta):
  1. WA_TENANTS (env): todo tenant con `slug` ≠ 'sazon' debe tener `modo:"app"` (y `cartaUrl`), o el bot lo
     mandaría al flujo conversacional/menú default. Sin eso → FALLA (es exactamente el bug del 2324).
  2. /healthz de prod (best-effort): el `active_menu` del slot DEFAULT no debe ser viejo (local cerrado). Si su
     `published_at` supera STALE_DAYS → FALLA (ningún número debe caer a la carta de un local cerrado).

Uso:
  WA_TENANTS='[...]' python qa-harness/verif_tenant_numero.py            # solo el chequeo 1 (CI/fixture)
  BOT_HEALTHZ=https://vicius-whatsapp-bot-production.up.railway.app python qa-harness/verif_tenant_numero.py
La prueba de mensaje REAL (mandar WhatsApp y leer la respuesta) NO la reemplaza este sensor: es la red barata entre
pruebas reales (clase feedback_verificado_camino_feliz_no_es_demo_ready).
"""
import datetime as _dt
import json
import os
import sys
import urllib.request

STALE_DAYS = int(os.environ.get("VERIF_STALE_DAYS", "45"))
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ViciusBot/1.0"   # UA de navegador (WAF Imunify360)


def _chequeo_wa_tenants(fails):
    raw = os.environ.get("WA_TENANTS")
    if not raw:
        print("  ..  WA_TENANTS no seteado en el entorno -> salto el chequeo de mapeo (correr con el env real)")
        return
    try:
        arr = json.loads(raw)
        assert isinstance(arr, list)
    except (ValueError, AssertionError):
        fails.append("WA_TENANTS no es un JSON de lista válido")
        return
    for t in arr:
        slug = (t or {}).get("slug")
        if not slug or slug == "sazon":
            continue   # sazon usa el slot default (histórico); los demás deben ser explícitos
        modo = (t or {}).get("modo")
        if modo != "app":
            fails.append(f"tenant slug={slug!r} sin modo:'app' -> caeria al menu default (bug 2324). "
                         f"Agrega modo:'app' + cartaUrl en WA_TENANTS, o publica su menu propio en el bot.")
        elif not ((t or {}).get("cartaUrl") or (t or {}).get("carta_url") or (t or {}).get("copy")):
            fails.append(f"tenant slug={slug!r} modo:'app' pero SIN cartaUrl ni copy -> el mensaje unico no "
                         f"tendria link a la carta.")
    print(f"  ok  WA_TENANTS: {len(arr)} tenant(s) revisado(s)")


def _chequeo_healthz(fails):
    url = os.environ.get("BOT_HEALTHZ")
    if not url:
        print("  ..  BOT_HEALTHZ no seteado -> salto el chequeo del menu default (pasa la URL del bot)")
        return
    try:
        req = urllib.request.Request(url.rstrip("/") + "/healthz", headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:   # noqa: BLE001 — red no disponible no es una falla del invariante
        print(f"  ..  /healthz no alcanzable ({type(e).__name__}) -> salto (red)")
        return
    am = data.get("active_menu")
    if not am:
        print("  ok  slot default sin menú (nadie cae a una carta ajena)")
        return
    pub = am.get("published_at")
    try:
        d = _dt.datetime.fromisoformat(str(pub).replace("Z", "+00:00"))
        edad = (_dt.datetime.now(_dt.timezone.utc) - d).days
    except (ValueError, TypeError):
        print(f"  ..  active_menu.published_at ilegible ({pub!r}) -> salto")
        return
    if edad > STALE_DAYS:
        fails.append(f"el slot DEFAULT sirve un menu de hace {edad} dias ({am.get('day_label')!r}, {pub}) - "
                     f"posible carta de un local cerrado. Archiva el menu viejo (ningun numero debe caer ahi).")
    else:
        print(f"  ok  slot default: menu de hace {edad} dias (< {STALE_DAYS})")


def run():
    print("VERIF-TENANT-NUMERO - cada numero atiende a su tenant, ninguno cae al default viejo")
    fails = []
    _chequeo_wa_tenants(fails)
    _chequeo_healthz(fails)
    if fails:
        print("\nTENANT-NUMERO: FAIL")
        for f in fails:
            print("  -", f)
        return 1
    print("\nTENANT-NUMERO: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(run())
