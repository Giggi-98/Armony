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
