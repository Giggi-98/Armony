"""
Armony - volume uniforme per i brani già in libreria: misura il volume percepito (EBU R128) e scrive i tag ReplayGain
nei file che non li hanno (i download nuovi li ricevono da soli, scelta.finale).

Si lancia dentro il container, una volta:
  docker compose run --rm --no-deps -v ./deploy:/deploy:ro --entrypoint python armony /deploy/normalizza.py /music
Prova a secco (elenca e basta): aggiungi --prova. Circa un secondo a brano; si può interrompere e riprendere, i file già
fatti si saltano. Cambiano solo i tag, non l'audio. Navidrome li legge alla scansione dopo.
"""
import os
import sys
import time

sys.path.insert(0, "/app")
import metadati  # noqa: E402

AUDIO = (".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg", ".opus")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    prova = "--prova" in sys.argv
    root = args[0] if args else "/music"
    files = [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if f.lower().endswith(AUDIO) and not f.startswith(".")]
    fatti = saltati = errori = 0
    t0 = time.time()
    for n, p in enumerate(sorted(files), 1):
        try:
            if prova:
                f = metadati.mutagen.File(p)
                ha = f is not None and f.tags is not None and any(k in f.tags for k in ("----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN", "TXXX:REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_GAIN", "replaygain_track_gain"))
                saltati += ha
                fatti += not ha
            elif metadati.scrivi_replaygain(p):
                fatti += 1
            else:
                saltati += 1
        except Exception as e:  # noqa: BLE001 — un file rotto non ferma gli altri
            errori += 1
            print(f"  errore: {p}: {e}", flush=True)
        if n % 50 == 0:
            print(f"{n}/{len(files)} · {'da fare' if prova else 'scritti'} {fatti}, già a posto {saltati}, errori {errori} · {int(time.time() - t0)} s", flush=True)
    print(f"Finito: {len(files)} file, {'da fare' if prova else 'scritti'} {fatti}, già a posto {saltati}, errori {errori}.")


if __name__ == "__main__":
    main()
