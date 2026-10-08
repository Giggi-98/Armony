#!/usr/bin/env python3
"""
Armony: sistema i metadati dei brani già in libreria usando le esportazioni di Exportify.

Per ogni file audio cerca la riga del CSV corrispondente (titolo, artista, durata), completa i dati
con Deezer come fanno le importazioni (server/metadati.py), riscrive i tag (titolo, artisti, album,
artista dell'album, data, traccia, disco, generi, ISRC, etichetta, copertina) e sposta il file in
<cartella>/<artista dell'album>/<album>/<NN - titolo>, con cover.jpg accanto.

Per default è una PROVA A SECCO: elenca cosa cambierebbe e non tocca niente.
  docker compose run --rm --no-deps -v ./deploy:/deploy:ro -v ./spotify_playlists:/csv:ro \\
      --entrypoint python armony /deploy/riallinea-spotify.py /csv /music
Con --applica modifica i file e scrive /music/.armony-riallinea-<data>.jsonl: per ogni file il percorso
vecchio, quello nuovo e i tag di prima, per poterli rimettere a posto (--annulla <registro>).

Attenzione: Navidrome riconosce un brano anche da album, traccia e titolo. Dopo la correzione i brani
sistemati sono per lui brani nuovi: le playlist che li contenevano vanno reimportate (Armony aggiunge
solo i brani mancanti alle playlist con lo stesso nome).
"""
import argparse
import csv
import glob
import json
import os
import sys
import time

sys.path.insert(0, "/app")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import mutagen  # noqa: E402
import metadati as M  # noqa: E402

AUDIO = (".mp3", ".m4a", ".flac", ".opus", ".ogg", ".oga", ".wav", ".aiff", ".aif", ".wma", ".wv", ".ape")
VUOTI = {"", "na", "n a", "unknown", "sconosciuto", "artista sconosciuto"}


def carica_csv(cartella):
    righe, visti = [], set()
    for f in sorted(glob.glob(os.path.join(cartella, "*.csv"))):
        for r in csv.DictReader(open(f, encoding="utf-8-sig")):
            m = M.da_exportify(r)
            k = m["isrc"] or M.norm(" ".join(m["artists"][:1]) + " " + m["title"])
            if m["title"] and k not in visti:
                visti.add(k)
                righe.append(m)
    return righe


def leggi(path):
    f = mutagen.File(path, easy=True)
    if f is None:
        return None
    t = lambda k: (f.get(k) or [""])[0] if f.tags else ""
    base = os.path.splitext(os.path.basename(path))[0]
    nome_t = base.split(" - ", 1)[1] if " - " in base else base
    return {"title": t("title"), "artist": t("artist"), "album": t("album"), "isrc": t("isrc").upper() if "isrc" in (f.tags or {}) else "",
            "duration": round(f.info.length) if getattr(f, "info", None) else None, "nome": nome_t,
            "cartella": os.path.basename(os.path.dirname(path)),
            "tags": {k: list(v) for k, v in (f.tags or {}).items()} if f.tags else {}}


def migliore(info, per_titolo, per_isrc, per_artista):
    if info["isrc"] and info["isrc"] in per_isrc:
        return per_isrc[info["isrc"]], 99
    # file senza titolo ("Artista - NA"): l'artista dalla cartella, il brano dalla durata,
    # e solo se fra i brani di quell'artista uno solo ha la stessa durata (±2 s)
    if M.norm(info["title"]) in VUOTI and M.norm(info["nome"]) in VUOTI and info["duration"]:
        artista = M.norm(info["artist"]) if M.norm(info["artist"]) not in VUOTI else M.norm(info["cartella"])
        cand = [r for r in per_artista.get(artista, []) if r["duration"] and abs(r["duration"] - info["duration"]) <= 2]
        return (cand[0], 6) if len(cand) == 1 else (None, 0)
    titoli = {M.norm(info["title"]), M.norm(info["nome"])} - {""} - VUOTI
    cand = [r for t in titoli for r in per_titolo.get(t, [])]
    artista = M.norm(info["artist"]) if M.norm(info["artist"]) not in VUOTI else M.norm(info["cartella"])
    best, bs = None, -9
    for r in cand:
        sc = 3
        arts = [M.norm(a) for a in r["artists"]]
        if artista and artista not in VUOTI:
            sc += 2 if any(a and (a in artista or artista in a) for a in arts) else -2
        if info["duration"] and r["duration"]:
            dd = abs(info["duration"] - r["duration"])
            sc += 2 if dd <= 3 else .5 if dd <= 8 else -3
        if sc > bs:
            best, bs = r, sc
    return (best, bs) if bs >= 5 else (None, bs)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("csv")
    ap.add_argument("music")
    ap.add_argument("--applica", action="store_true")
    ap.add_argument("--annulla", metavar="REGISTRO")
    a = ap.parse_args()
    if a.annulla:
        return annulla(a.annulla)

    righe = carica_csv(a.csv)
    per_titolo, per_artista, per_isrc = {}, {}, {r["isrc"]: r for r in righe if r["isrc"]}
    for r in righe:
        per_titolo.setdefault(M.norm(r["title"]), []).append(r)
        for art in r["artists"]:
            per_artista.setdefault(M.norm(art), []).append(r)
    files = [os.path.join(d, f) for d, _, fs in os.walk(a.music) for f in fs
             if f.lower().endswith(AUDIO) and "/." not in d + "/"]
    print(f"{len(righe)} brani nei CSV, {len(files)} file audio in {a.music}")

    piano, senza = [], []
    for p in sorted(files):
        info = leggi(p)
        if not info:
            continue
        r, sc = migliore(info, per_titolo, per_isrc, per_artista)
        (piano.append((p, info, r)) if r else senza.append((p, info)))
    print(f"riconosciuti: {len(piano)} · senza corrispondenza nei CSV: {len(senza)}\n")

    registro = os.path.join(a.music, ".armony-riallinea-%s.jsonl" % time.strftime("%Y%m%d-%H%M%S")) if a.applica else None
    ok = err = 0
    for i, (p, info, r) in enumerate(piano, 1):
        m = M.arricchisci(r)
        top = os.path.relpath(p, a.music).split(os.sep)[0]
        base = os.path.join(a.music, top) if top != os.path.basename(p) else a.music
        dest = M.destinazione(base, m, p.rsplit(".", 1)[-1].lower())
        prima = f"{info['artist'] or '?'} - {info['title'] or info['nome']}"
        dopo = f"{', '.join(m['artists'])} - {m['title']} | {m['album']}" + (f" #{m['track']}" if m.get("track") else "") + (f" ({m['date'][:4]})" if m.get("date") else "")
        print(f"[{i}/{len(piano)}] {os.path.relpath(p, a.music)}\n    {prima}\n  → {dopo}\n  → {os.path.relpath(dest, a.music)}")
        if not a.applica:
            continue
        try:
            M.tagga(p, m, pulisci=bool(m.get("cover")))
            nuovo = M.sistema(p, base, m)
            with open(registro, "a") as fh:
                fh.write(json.dumps({"prima": p, "dopo": nuovo, "tags": info["tags"]}, ensure_ascii=False) + "\n")
            ok += 1
        except Exception as e:  # noqa: BLE001
            err += 1
            print(f"    ERRORE: {e}")
    if a.applica:
        pulisci_vuote(a.music)
        print(f"\nfatto: {ok} file sistemati, {err} errori. Registro per annullare: {registro}")
    else:
        print("\nprova a secco: niente è stato modificato. Aggiungi --applica per farlo davvero.")
    if senza:
        print(f"\nsenza corrispondenza ({len(senza)}), restano come sono:")
        for p, info in senza[:40]:
            print("   ", os.path.relpath(p, a.music))


def pulisci_vuote(root):
    for d, ds, fs in sorted(os.walk(root), key=lambda x: -len(x[0])):
        if d == root:
            continue
        rest = [f for f in os.listdir(d) if f.lower() not in M.COVER_NAMES]
        if not rest:
            for f in os.listdir(d):
                os.remove(os.path.join(d, f))
            os.rmdir(d)


def annulla(registro):
    n = 0
    for line in reversed(open(registro).read().splitlines()):
        x = json.loads(line)
        if not os.path.exists(x["dopo"]):
            continue
        os.makedirs(os.path.dirname(x["prima"]), exist_ok=True)
        os.replace(x["dopo"], x["prima"])
        f = mutagen.File(x["prima"], easy=True)
        if f is not None:
            if f.tags is not None:
                f.delete()
                f = mutagen.File(x["prima"], easy=True)
                f.add_tags()
            for k, v in x["tags"].items():
                try:
                    f[k] = v
                except (KeyError, ValueError):
                    pass
            f.save()
        n += 1
    print(f"annullati {n} file (le copertine incorporate tolte non tornano; tutto il resto sì)")


if __name__ == "__main__":
    main()
