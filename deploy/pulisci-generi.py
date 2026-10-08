#!/usr/bin/env python3
"""
Armony: toglie dai file scaricati da YouTube il "genere" che in realtà è la categoria del video
("People & Blogs", "Gaming", "Music"…), che i download scrivevano prima della correzione in
server/app.py (meta_genre).

Tocca solo i file che hanno anche un indirizzo YouTube nei tag (yt-dlp lo scrive sempre in
purl/commento): un genere vero come "Comedy" o "Classics" su un CD rippato resta dov'è.
Per default è una prova a secco: elenca cosa cambierebbe. Con --applica modifica i file.

Dal server, con la cartella musica montata come nel container:
  docker compose run --rm --no-deps -v ./deploy:/deploy:ro --entrypoint python armony \\
      /deploy/pulisci-generi.py /music            (prova a secco)
      /deploy/pulisci-generi.py /music --applica  (modifica)
Navidrome vede i generi nuovi alla scansione successiva.
"""
import argparse
import os
import sys

import mutagen

# categorie dei video di YouTube (quelle che yt-dlp scrive come genere)
CATEGORIE = {
    "Film & Animation", "Autos & Vehicles", "Music", "Pets & Animals", "Sports", "Short Movies",
    "Travel & Events", "Gaming", "Videoblogging", "People & Blogs", "Comedy", "Entertainment",
    "News & Politics", "Howto & Style", "Education", "Science & Technology", "Nonprofits & Activism",
    "Movies", "Anime/Animation", "Action/Adventure", "Classics", "Documentary", "Drama", "Family",
    "Foreign", "Horror", "Sci-Fi/Fantasy", "Thriller", "Shorts", "Shows", "Trailers",
}
AUDIO = (".mp3", ".m4a", ".mp4", ".aac", ".opus", ".ogg", ".oga", ".flac", ".wma")


def da_youtube(path):
    tags = getattr(mutagen.File(path), "tags", None) or {}
    testo = " ".join(str(v) for v in (tags.values() if hasattr(tags, "values") else tags))
    return "youtube.com/" in testo or "youtu.be/" in testo


def esamina(path):
    """Restituisce i generi da togliere, o None se il file va lasciato com'è."""
    f = mutagen.File(path, easy=True)
    generi = list((f.tags or {}).get("genre", [])) if f else []
    if not generi or not all(g.strip() in CATEGORIE for g in generi) or not da_youtube(path):
        return None
    return generi


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cartella", help="cartella musicale da esaminare (es. /music)")
    ap.add_argument("--applica", action="store_true", help="modifica davvero i file (senza: prova a secco)")
    a = ap.parse_args()
    trovati, errori = 0, 0
    for root, _, files in os.walk(a.cartella):
        for nome in sorted(files):
            if not nome.lower().endswith(AUDIO):
                continue
            path = os.path.join(root, nome)
            try:
                generi = esamina(path)
                if generi is None:
                    continue
                trovati += 1
                print(f"{'tolgo' if a.applica else 'toglierei'} {', '.join(generi)!r}: {os.path.relpath(path, a.cartella)}")
                if a.applica:
                    f = mutagen.File(path, easy=True)
                    del f.tags["genre"]
                    f.save()
            except Exception as e:  # noqa: BLE001
                errori += 1
                print(f"errore su {path}: {e}", file=sys.stderr)
    verbo = "modificati" if a.applica else "da modificare (prova a secco: aggiungi --applica)"
    print(f"\n{trovati} file {verbo}" + (f", {errori} errori" if errori else ""))


if __name__ == "__main__":
    main()
