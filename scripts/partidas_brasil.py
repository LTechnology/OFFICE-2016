#!/usr/bin/env python3
"""Partidas de EZE/AEP con destino Brasil, jueves 03 y viernes 04-09.

Lee data/raw/{alias}_partidas_{fecha}.json (descargadas de la API
all-flights con movtp=D) y escribe out/partidas_brasil_03-04sep.csv.
"""
import csv
import json
import os
from collections import Counter

BRASIL = {"GRU", "CGH", "VCP", "GIG", "SDU", "BSB", "CNF", "SSA", "REC", "FOR",
          "POA", "CWB", "FLN", "NAT", "MCZ", "BEL", "MAO", "IGU", "VIX", "GYN",
          "CGB", "CGR", "SLZ", "THE", "JPA", "AJU", "PVH", "LDB", "JOI", "NVT",
          "UDI", "RAO", "BPS", "IOS", "JDO"}
RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "out")


def franja(h):
    m = int(h[:2]) * 60 + int(h[3:])
    return "SI" if (540 <= m < 720 or 1080 <= m < 1260) else "NO"


def main():
    rows = []
    for alias, arpt in (("eze", "EZE"), ("aep", "AEP")):
        for fecha, dia in (("03-09-2026", "jueves"), ("04-09-2026", "viernes")):
            for f in json.load(open(os.path.join(RAW, f"{alias}_partidas_{fecha}.json"))):
                if (f.get("IATAdestorig") or "") in BRASIL and " " in (f.get("stda") or ""):
                    h = f["stda"].split()[1]
                    etda = f.get("etda") or ""
                    rows.append({
                        "fecha": fecha, "dia": dia, "aeropuerto": arpt, "hora": h,
                        "vuelo": f["nro"], "aerolinea": f["aerolinea"],
                        "destino_iata": f["IATAdestorig"], "destino": f["destorig"],
                        "estado": (f.get("estin") or "").strip(),
                        "hora_estimada": etda.split()[1] if " " in etda else "",
                        "en_franja_paro_viernes": franja(h) if fecha == "04-09-2026" else "",
                    })
    rows.sort(key=lambda r: (r["fecha"], r["hora"]))
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "partidas_brasil_03-04sep.csv")
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(len(rows), "partidas a Brasil ->", os.path.relpath(path))
    print(Counter(r["dia"] for r in rows))
    print("estados:", Counter(r["estado"] for r in rows))
    afectados = [r for r in rows if r["estado"].lower() not in ("", "on time")
                 or r["hora_estimada"]]
    for r in afectados:
        print("  ", r["dia"], r["aeropuerto"], r["hora"], r["vuelo"],
              r["destino_iata"], r["estado"], r["hora_estimada"])


if __name__ == "__main__":
    main()
