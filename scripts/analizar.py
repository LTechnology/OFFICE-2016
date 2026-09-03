#!/usr/bin/env python3
"""Pasos 3-6: normalizar, deduplicar codeshares, diff contra baseline y salida.

Baseline: la API solo publica ~[-2, +5] días alrededor de hoy, así que los
viernes comparables pedidos (28-08, 11-09, 18-09) no están disponibles
(devuelven 0-7 vuelos). Se usa la moda de la hora programada por vuelo sobre
todos los días disponibles alrededor del 04-09 (EZE: 01..08-09 sin el 04;
AEP: 01..03-09, la fuente no publica AEP más allá del 04).

Confianza del baseline (los horarios de cabotaje varían por día de semana y
JetSMART reusa números de vuelo con horas distintas según el día):
  alta  = la moda se repite en >=3 días baseline
  media = la moda se repite en 2 días
  baja  = una sola observación, o todas las observaciones difieren
"""
import csv
import json
import os
import sys
from collections import Counter

TARGET = "04-09-2026"
BASELINES = {
    "eze": ["01-09-2026", "02-09-2026", "03-09-2026", "05-09-2026",
            "06-09-2026", "07-09-2026", "08-09-2026"],
    "aep": ["01-09-2026", "02-09-2026", "03-09-2026", "05-09-2026"],
}
RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "out")
UMBRAL_CAMBIO_MIN = 5      # delta programado vs moda baseline
UMBRAL_DEMORA_MIN = 30     # etda vs stda del mismo día
# Franjas de la medida de fuerza ATE/ANAC del 04-09 (hora local programada)
FRANJAS_PARO = [(9 * 60, 12 * 60), (18 * 60, 21 * 60)]


def hhmm_a_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def min_a_hhmm(mins):
    mins %= 1440
    return f"{mins // 60:02d}:{mins % 60:02d}"


def delta_min(a, b):
    """Diferencia a-b en minutos con wrap de medianoche, en [-720, 720)."""
    return (a - b + 720) % 1440 - 720


def cargar(alias, fecha):
    path = os.path.join(RAW, f"{alias}_{fecha}.json")
    with open(path) as fh:
        data = json.load(fh)
    if isinstance(data, dict) and "payload" in data:  # formato de capturar.js
        data = data["payload"]
    return data


def clave_vuelo(nro):
    """'AV 0088' -> 'AV88' para matchear con/sin ceros a la izquierda."""
    partes = nro.split()
    if len(partes) == 2 and partes[1].isdigit():
        return f"{partes[0]}{int(partes[1])}"
    return nro.replace(" ", "")


def num_vuelo(nro):
    partes = nro.split()
    return int(partes[1]) if len(partes) == 2 and partes[1].isdigit() else 10 ** 9


def normalizar(crudos):
    vuelos = []
    for f in crudos:
        stda = f.get("stda") or ""
        if " " not in stda:
            continue
        hora = stda.split()[1]
        etda = f.get("etda") or ""
        vuelos.append({
            "numero_vuelo": f["nro"].strip(),
            "clave": clave_vuelo(f["nro"].strip()),
            "aerolinea": (f.get("aerolinea") or "").strip(),
            "origen_iata": (f.get("IATAdestorig") or "").strip(),
            "hora_programada": hora,
            "min_prog": hhmm_a_min(hora),
            "hora_estimada": etda.split()[1] if " " in etda else "",
            "estado": (f.get("estin") or f.get("estes") or "").strip(),
            "terminal": (f.get("termsec") or "").strip(),
        })
    return vuelos


def dedup_codeshares(vuelos):
    """Agrupa por (origen, hora programada); conserva el vuelo de número más
    bajo como operador real (los códigos de marketing suelen ser 7xxx+) y
    guarda el resto en codigos_compartidos."""
    grupos = {}
    for v in vuelos:
        grupos.setdefault((v["origen_iata"], v["hora_programada"]), []).append(v)
    resultado = []
    for grupo in grupos.values():
        grupo.sort(key=lambda v: num_vuelo(v["numero_vuelo"]))
        principal = grupo[0]
        principal["codigos_compartidos"] = " ".join(
            v["numero_vuelo"] for v in grupo[1:])
        resultado.append(principal)
    return resultado


def en_franja_paro(min_prog):
    return any(a <= min_prog < b for a, b in FRANJAS_PARO)


def moda_y_confianza(horas):
    (moda, freq), = Counter(horas).most_common(1)
    conf = "alta" if freq >= 3 else ("media" if freq == 2 else "baja")
    return moda, conf


def fila(arpt, v, clasif, moda=None, conf="", demora=None, nota="",
         hora_04sep=None, min_04sep=None, n_baselines=0):
    d = delta_min(min_04sep, moda) if (moda is not None and min_04sep is not None) else ""
    ref = min_04sep if min_04sep is not None else moda
    return {
        "aeropuerto": arpt,
        "vuelo": v["numero_vuelo"],
        "aerolinea": v["aerolinea"],
        "origen": v["origen_iata"],
        "hora_04sep": hora_04sep or "",
        "hora_baseline": min_a_hhmm(moda) if moda is not None else "",
        "delta_min": d,
        "clasificacion": clasif,
        "confianza": conf,
        "en_franja_paro": "SI" if (ref is not None and en_franja_paro(ref)) else "NO",
        "hora_estimada_04sep": v.get("hora_estimada", ""),
        "demora_est_min": demora if demora is not None else "",
        "codigos_compartidos": v.get("codigos_compartidos", ""),
        "n_baselines": n_baselines,
        "nota": nota,
    }


def main():
    datos = {}
    for alias in ("eze", "aep"):
        objetivo = dedup_codeshares(normalizar(cargar(alias, TARGET)))
        base_horas, base_info, dias = {}, {}, 0
        for fecha in BASELINES[alias]:
            crudos = cargar(alias, fecha)
            if not crudos:
                continue
            dias += 1
            for v in dedup_codeshares(normalizar(crudos)):
                base_horas.setdefault(v["clave"], []).append(v["min_prog"])
                base_info[v["clave"]] = v
        datos[alias] = {
            "objetivo": {v["clave"]: v for v in objetivo},
            "base_horas": base_horas, "base_info": base_info, "dias": dias,
        }

    # Cambios de aeropuerto: habitual en X (mayoría del baseline), ausente en
    # X el 04-09 pero programado en el otro aeropuerto ese día.
    swaps = {}  # clave -> (alias_origen, alias_destino)
    for alias, otro in (("eze", "aep"), ("aep", "eze")):
        d = datos[alias]
        mayoria = max(2, d["dias"] // 2 + 1)
        for clave, horas in d["base_horas"].items():
            if (len(horas) >= mayoria and clave not in d["objetivo"]
                    and clave in datos[otro]["objetivo"]):
                swaps[clave] = (alias, otro)

    filas = []
    for alias in ("eze", "aep"):
        arpt = alias.upper()
        d = datos[alias]
        mayoria = max(2, d["dias"] // 2 + 1)

        for clave, v in d["objetivo"].items():
            if clave in swaps and swaps[clave][1] == alias:
                continue  # se reporta una sola vez, como CAMBIO_AEROPUERTO
            horas = d["base_horas"].get(clave)
            moda, conf = moda_y_confianza(horas) if horas else (None, "")
            cancelado = "cancel" in v["estado"].lower()
            demora = (delta_min(hhmm_a_min(v["hora_estimada"]), v["min_prog"])
                      if v["hora_estimada"] else None)

            if cancelado:
                clasif, conf = "CANCELADO", "alta"
            elif demora is not None and demora >= UMBRAL_DEMORA_MIN:
                clasif = "DEMORADO"
            elif moda is None:
                clasif, conf = "NUEVO", ""
            elif abs(delta_min(v["min_prog"], moda)) >= UMBRAL_CAMBIO_MIN:
                clasif = "CAMBIO_HORARIO"
            else:
                clasif = "SIN_CAMBIO"

            filas.append(fila(arpt, v, clasif, moda=moda, conf=conf,
                              demora=demora, hora_04sep=v["hora_programada"],
                              min_04sep=v["min_prog"],
                              n_baselines=len(horas) if horas else 0))

        # AUSENTE: presente en la mayoría de los días baseline pero no el 04-09
        for clave, horas in d["base_horas"].items():
            if clave in d["objetivo"] or len(horas) < mayoria:
                continue
            moda, conf = moda_y_confianza(horas)
            v = d["base_info"][clave]
            if clave in swaps and swaps[clave][0] == alias:
                otro = swaps[clave][1]
                v04 = datos[otro]["objetivo"][clave]
                filas.append(fila(
                    f"{arpt}->{otro.upper()}", v04, "CAMBIO_AEROPUERTO",
                    moda=moda, conf=conf, hora_04sep=v04["hora_programada"],
                    min_04sep=v04["min_prog"], n_baselines=len(horas),
                    nota=f"habitual en {arpt} {min_a_hhmm(moda)}; el 04-09 "
                         f"opera en {otro.upper()} {v04['hora_programada']}"))
            else:
                filas.append(fila(arpt, v, "AUSENTE", moda=moda, conf=conf,
                                  n_baselines=len(horas)))

    orden = {"CANCELADO": 0, "AUSENTE": 1, "CAMBIO_AEROPUERTO": 2,
             "DEMORADO": 3, "CAMBIO_HORARIO": 4, "NUEVO": 5, "SIN_CAMBIO": 6}
    conf_orden = {"alta": 0, "media": 1, "baja": 2, "": 3}
    filas.sort(key=lambda r: (orden[r["clasificacion"]],
                              conf_orden[r["confianza"]],
                              -abs(r["delta_min"] or r["demora_est_min"] or 0),
                              r["aeropuerto"],
                              r["hora_04sep"] or r["hora_baseline"]))

    os.makedirs(OUT, exist_ok=True)
    csv_path = os.path.join(OUT, "cambios_04sep.csv")
    reportables = [r for r in filas if r["clasificacion"] != "SIN_CAMBIO"]
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(reportables)

    # ---- resumen markdown por consola ----
    dias_eze, dias_aep = datos["eze"]["dias"], datos["aep"]["dias"]
    print("# Arribos EZE/AEP — viernes 04-09-2026 vs programación habitual\n")
    print(f"Baseline: moda de la hora programada por vuelo sobre los días que "
          f"publica la fuente (EZE: {dias_eze} días, AEP: {dias_aep} días, "
          f"entre el 01 y el 08-09 sin contar el 04). Los viernes comparables "
          f"28-08 / 11-09 / 18-09 no "
          f"están disponibles en la API (ventana ~[-2,+5] días), así que un "
          f"delta con confianza baja puede ser variación normal por día de "
          f"semana y no un cambio puntual.\n")
    tot = Counter(r["clasificacion"] for r in filas)
    print("Totales:", ", ".join(f"{k}: {v}" for k, v in
                                sorted(tot.items(), key=lambda x: orden[x[0]])), "\n")

    def tabla(rs, cols):
        print("| " + " | ".join(cols) + " |")
        print("|" + "|".join("---" for _ in cols) + "|")
        for r in rs:
            print("| " + " | ".join(str(r[c]) for c in cols) + " |")
        print()

    for clasif, titulo in [
        ("CANCELADO", "Cancelados (estado de la fuente)"),
        ("AUSENTE", "Ausentes el 04-09 (vuelan la mayoría de los días baseline — posible cancelación)"),
        ("CAMBIO_AEROPUERTO", "Cambian de aeropuerto el 04-09"),
        ("DEMORADO", f"Demorados (estimada >= {UMBRAL_DEMORA_MIN} min sobre programada)"),
        ("CAMBIO_HORARIO", f"Cambio de horario (|delta| >= {UMBRAL_CAMBIO_MIN} min vs moda baseline)"),
        ("NUEVO", "Nuevos (no aparecen en ningún día baseline)"),
    ]:
        rs = [r for r in filas if r["clasificacion"] == clasif]
        if not rs:
            continue
        print(f"## {titulo} — {len(rs)}\n")
        cols = ["aeropuerto", "vuelo", "aerolinea", "origen", "hora_04sep",
                "hora_baseline", "delta_min", "confianza", "en_franja_paro",
                "n_baselines"]
        if clasif == "DEMORADO":
            cols.insert(6, "hora_estimada_04sep")
            cols.insert(7, "demora_est_min")
        if clasif == "CAMBIO_AEROPUERTO":
            cols.append("nota")
        tabla(rs, cols)

    en_paro = [r for r in reportables if r["en_franja_paro"] == "SI"]
    print(f"Vuelos afectados dentro de las franjas de paro ATE/ANAC "
          f"(9-12 / 18-21): {len(en_paro)} de {len(reportables)} reportados.")
    print(f"\nCSV: {os.path.relpath(csv_path)} ({len(reportables)} filas)")


if __name__ == "__main__":
    main()
