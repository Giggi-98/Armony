"""
Armony - stato persistente: SQLite con il modulo standard, niente ORM.

Le migrazioni sono un elenco numerato: ognuna gira una volta sola, in ordine,
e il numero raggiunto sta in PRAGMA user_version. Non modificare una migrazione
già rilasciata: aggiungine una nuova in fondo.
"""
import os
import sqlite3
import threading

PATH = os.environ.get("DB_PATH", "/data/armony.db")

MIGRATIONS = [
    # 1: accesso per utente e coda dei download che sopravvive ai riavvii
    """
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, admin INTEGER NOT NULL,
                           device TEXT, created REAL NOT NULL, seen REAL NOT NULL);
    CREATE INDEX sessions_user ON sessions(user);
    CREATE TABLE perms (user TEXT PRIMARY KEY, upload INTEGER NOT NULL DEFAULT 1,
                        download INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, created REAL NOT NULL);
    """,
    # 2: storico d'ascolto e preferenze per utente, uguali su tutti i dispositivi
    """
    CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, hid TEXT NOT NULL,
                          ts REAL NOT NULL, data TEXT NOT NULL, UNIQUE (user, hid));
    CREATE TABLE prefs (user TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL);
    """,
    # 3: permesso di eliminare brani dal server, spento per gli utenti (gli amministratori possono sempre)
    """
    ALTER TABLE perms ADD COLUMN del INTEGER NOT NULL DEFAULT 0;
    """,
    # 4: registrazione degli amici (modalità) e codici d'invito monouso
    """
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE invites (code TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL, by TEXT,
                          used_by TEXT, used_at REAL, revoked INTEGER NOT NULL DEFAULT 0);
    """,
    # 5: federazione. Nodi collegati (chiave fissata, stato), inviti fra server (solo l'hash del segreto),
    # il mio catalogo con le versioni per riga (i vicini chiedono le differenze), la cache dei cataloghi
    # dei vicini per la ricerca, le impronte sha256 dei miei file
    """
    CREATE TABLE fed_nodes (id TEXT PRIMARY KEY, pub TEXT NOT NULL, name TEXT NOT NULL, owner TEXT, url TEXT NOT NULL,
                            state TEXT NOT NULL, created REAL NOT NULL, seen REAL, app TEXT, proto INTEGER,
                            ver INTEGER NOT NULL DEFAULT 0, songs INTEGER NOT NULL DEFAULT 0, albums INTEGER NOT NULL DEFAULT 0,
                            transitive INTEGER NOT NULL DEFAULT 0, error TEXT, synced REAL);
    CREATE TABLE fed_invites (hash TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL, used_by TEXT);
    CREATE TABLE fed_mine (id TEXT PRIMARY KEY, ver INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0, cover TEXT, data TEXT NOT NULL);
    CREATE INDEX fed_mine_ver ON fed_mine(ver);
    CREATE TABLE fed_catalog (node TEXT NOT NULL, id TEXT NOT NULL, q TEXT NOT NULL, qa TEXT NOT NULL, alb TEXT NOT NULL,
                              data TEXT NOT NULL, PRIMARY KEY (node, id));
    CREATE INDEX fed_catalog_alb ON fed_catalog(node, alb);
    CREATE TABLE fed_hash (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, sha TEXT NOT NULL);
    """,
    # 6: Jam Radio. La stazione vive sul server: elenco dei brani con le durate e l'istante d'inizio, da cui
    # chiunque calcola cosa è in onda; paused = secondi trascorsi quando è stata fermata (NULL = in onda)
    """
    CREATE TABLE radio (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL,
                        created REAL NOT NULL, start REAL NOT NULL, seed INTEGER NOT NULL, paused REAL, tracks TEXT NOT NULL);
    """,
    # 7: dispositivi (dispositivi.py). Ogni dispositivo ha la sua chiave pubblica ECDSA P-256 (pub; NULL = client
    # senza chiave) e uno stato: attesa, fidato, revocato. cid = l'identificativo che il client si dà da solo
    # (S.device), salt = il sale Subsonic che usa: serve a rifiutare le credenziali di un dispositivo revocato.
    # Le sessioni si legano al dispositivo (dev) e quelle con chiave scadono (exp). Abbinamenti monouso (solo
    # l'hash del codice) e registro degli eventi. Le sessioni già aperte diventano dispositivi fidati senza chiave,
    # e si concede un periodo di transizione di 14 giorni ai client vecchi, solo se c'era già qualcuno
    """
    CREATE TABLE devices (id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
                          pub TEXT, cid TEXT NOT NULL DEFAULT '', salt TEXT, admin INTEGER NOT NULL DEFAULT 0,
                          state TEXT NOT NULL, created REAL NOT NULL, approved REAL, by TEXT, seen REAL, ip TEXT,
                          net TEXT, gen INTEGER NOT NULL DEFAULT 0, rekey INTEGER NOT NULL DEFAULT 0, revoked REAL);
    CREATE INDEX devices_user ON devices(user);
    CREATE UNIQUE INDEX devices_pub ON devices(pub) WHERE pub IS NOT NULL;
    ALTER TABLE sessions ADD COLUMN dev TEXT;
    ALTER TABLE sessions ADD COLUMN exp REAL;
    CREATE INDEX sessions_dev ON sessions(dev);
    CREATE TABLE pairings (hash TEXT PRIMARY KEY, user TEXT NOT NULL, by_dev TEXT NOT NULL, t TEXT NOT NULL, s TEXT NOT NULL,
                           created REAL NOT NULL, expires REAL NOT NULL, used_by TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL, user TEXT, dev TEXT,
                         ip TEXT, net TEXT, detail TEXT);
    CREATE INDEX events_ts ON events(ts);
    INSERT INTO devices (id, user, name, kind, cid, admin, state, created, approved, by, seen)
      SELECT lower(hex(randomblob(12))), user, 'Dispositivo già collegato', '', coalesce(device, ''), max(admin), 'fidato',
             min(created), min(created), 'prima dei dispositivi', max(seen)
      FROM sessions GROUP BY user, coalesce(device, '');
    UPDATE sessions SET dev = (SELECT d.id FROM devices d WHERE d.user = sessions.user AND d.cid = coalesce(sessions.device, ''));
    INSERT INTO settings (key, value) SELECT 'legacy_grace', CAST(strftime('%s', 'now') + 14 * 86400 AS TEXT)
      WHERE EXISTS (SELECT 1 FROM sessions);
    """,
    # 8: registro degli eventi (diagnosi.py): errori e ambiguità di server e client, i ripetuti sommati in una riga
    # (n, last). Importazioni ricordate dal server (pid = playlist di Navidrome): l'elenco del CSV nell'ordine
    # originale, per completare e riordinare la playlist ogni volta che un brano entra in libreria. Verso di ogni
    # collegamento fra server (federazione.py): entrambi, offro (solo do), ricevo (solo prendo)
    """
    CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, last REAL NOT NULL, n INTEGER NOT NULL,
                      level TEXT NOT NULL, area TEXT NOT NULL, msg TEXT NOT NULL, detail TEXT, user TEXT, dev TEXT,
                      src TEXT NOT NULL, sig TEXT NOT NULL);
    CREATE INDEX log_last ON log(last);
    CREATE TABLE imports (pid TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL,
                          created REAL NOT NULL, updated REAL NOT NULL, state TEXT);
    ALTER TABLE fed_nodes ADD COLUMN dir TEXT NOT NULL DEFAULT 'entrambi';
    """,
    # 9: abbonamenti a playlist pubbliche dei server collegati (federazione.py). pid = la playlist locale dell'utente,
    # che la riconciliazione delle importazioni (imports) tiene uguale a quella remota man mano che i brani si copiano
    """
    CREATE TABLE fed_subs (pid TEXT PRIMARY KEY, node TEXT NOT NULL, rid TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
                           created REAL NOT NULL, last REAL, error TEXT);
    """,
    # 10: permessi in più per utente (utenti.py): JSON con playlist, vedipl, condividi, radio, rete, stats. Le colonne
    # upload, download e del restano dove sono. welcome = codice di benvenuto creato dall'amministratore per un account
    # nuovo: chi lo usa sceglie la sua password (niente credenziali nel codice)
    """
    ALTER TABLE perms ADD COLUMN more TEXT;
    ALTER TABLE pairings ADD COLUMN welcome INTEGER NOT NULL DEFAULT 0;
    """,
]

_local = threading.local()


def conn():
    # una connessione per thread: waitress serve le richieste su più thread
    c = getattr(_local, "c", None)
    if c is None:
        c = _local.c = sqlite3.connect(PATH, timeout=10, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
    return c


def migrate():
    os.makedirs(os.path.dirname(PATH) or ".", exist_ok=True)
    c = conn()
    v = c.execute("PRAGMA user_version").fetchone()[0]
    for n, sql in enumerate(MIGRATIONS[v:], start=v + 1):
        c.executescript(f"BEGIN; {sql}; PRAGMA user_version = {n}; COMMIT;")


def one(sql, *args):
    return conn().execute(sql, args).fetchone()


def all_(sql, *args):
    return conn().execute(sql, args).fetchall()


def run(sql, *args):
    conn().execute(sql, args)
