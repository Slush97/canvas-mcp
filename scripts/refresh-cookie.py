#!/usr/bin/env python3
"""One-command Canvas login for canvas-mcp using your Brave browser session.

Log in to Canvas in Brave, then run:  npm run refresh-cookie

It finds your Canvas session in Brave, decrypts it, and saves it to .env as
CANVAS_COOKIE (and CANVAS_BASE_URL if it isn't set yet). No access token needed.
Re-run it whenever Canvas logs you out. Nothing leaves your computer.
"""
import hashlib
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

try:
    from Crypto.Cipher import AES
except ImportError:
    sys.exit(
        "Missing a dependency. Run:  pip install -r scripts/requirements.txt\n"
        "(installs pycryptodome and secretstorage)"
    )

HOME = Path.home()
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
BRAVE_DIRS = [
    HOME / ".config/BraveSoftware/Brave-Browser",
    HOME / ".config/BraveSoftware/Brave-Browser-Beta",
]


def read_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out = {}
    for line in ENV_PATH.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip("'\"")
    return out


def safe_storage_password() -> bytes:
    try:
        import secretstorage

        conn = secretstorage.dbus_init()
        for coll in secretstorage.get_all_collections(conn):
            if coll.is_locked():
                continue
            for item in coll.get_all_items():
                if item.get_label() in ("Brave Safe Storage", "Chrome Safe Storage"):
                    return item.get_secret()
    except Exception:
        pass
    return b"peanuts"  # fallback Brave uses when no system keyring is present


def make_key(password: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1, dklen=16)


def decrypt(value: bytes, key: bytes, host: str) -> str | None:
    if not value or value[:3] not in (b"v10", b"v11"):
        return None
    dec = AES.new(key, AES.MODE_CBC, iv=b" " * 16).decrypt(value[3:])
    dec = dec[: -dec[-1]]  # strip PKCS7 padding
    if dec.startswith(hashlib.sha256(host.encode()).digest()):
        dec = dec[32:]  # Chromium >=v130 prepends the host hash
    try:
        return dec.decode()
    except UnicodeDecodeError:
        return None


def find_cookie_db() -> Path:
    dbs = [c for base in BRAVE_DIRS if base.exists() for c in base.glob("*/Cookies")]
    if not dbs:
        sys.exit("Couldn't find Brave. Is it installed and have you opened it at least once?")
    return max(dbs, key=lambda p: p.stat().st_mtime)


def open_readonly(db: Path):
    tmp = Path(tempfile.mkdtemp()) / "Cookies"
    shutil.copy2(db, tmp)
    for suffix in ("-wal", "-shm"):
        side = db.with_name(db.name + suffix)
        if side.exists():
            shutil.copy2(side, tmp.with_name(tmp.name + suffix))
    return sqlite3.connect(f"file:{tmp}?immutable=1", uri=True), tmp.parent


def detect_domain(con) -> str | None:
    rows = con.execute(
        "SELECT DISTINCT host_key FROM cookies WHERE name='canvas_session'"
    ).fetchall()
    domains = sorted({h[0].lstrip(".") for h in rows})
    if len(domains) == 1:
        return domains[0]
    if len(domains) > 1:
        print("You're logged into more than one Canvas in Brave:", ", ".join(domains))
        print("Set CANVAS_BASE_URL in .env to the one you want, then run this again.")
        sys.exit(1)
    return None


def read_cookies(con, domain: str, key: bytes) -> dict[str, str]:
    rows = con.execute(
        "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key IN (?, ?)",
        (domain, "." + domain),
    ).fetchall()
    out: dict[str, str] = {}
    for host, name, enc in rows:
        val = decrypt(enc, key, host)
        if val is not None:
            out[name] = val
    return out


def write_env(env: dict[str, str], domain: str, header: str) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    lines = [l for l in lines if not l.startswith(("CANVAS_COOKIE=", "CANVAS_BASE_URL="))]
    lines = [l for l in lines if l.startswith("#") or "=" in l]
    lines.append(f"CANVAS_BASE_URL=https://{domain}")
    lines.append(f"CANVAS_COOKIE='{header}'")
    ENV_PATH.write_text("\n".join(lines) + "\n")
    os.chmod(ENV_PATH, 0o600)


def main() -> None:
    env = read_env()
    con, tmpdir = open_readonly(find_cookie_db())
    try:
        domain = env.get("CANVAS_BASE_URL", "").split("://")[-1].strip("/") or detect_domain(con)
        if not domain:
            sys.exit(
                "You're not logged into Canvas in Brave. Open Brave, sign in to your\n"
                "school's Canvas, then run this again."
            )
        key = make_key(safe_storage_password())
        cookies = read_cookies(con, domain, key)
    finally:
        con.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    if "canvas_session" not in cookies:
        sys.exit(
            f"Found {domain} but no active session. Log in to Canvas in Brave, then\n"
            "run this again."
        )
    header = "; ".join(f"{k}={v}" for k, v in cookies.items())
    write_env(env, domain, header)
    print(f"Done. Connected to {domain} as your logged-in Brave user.")
    print("You can now use canvas-mcp. Run this again if Canvas ever logs you out.")
    if "_csrf_token" not in cookies:
        print("Note: reading will work; sending messages or submitting may not.")


if __name__ == "__main__":
    main()
