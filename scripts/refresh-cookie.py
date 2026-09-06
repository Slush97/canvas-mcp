#!/usr/bin/env python3
"""One-command Canvas login for canvas-mcp using your browser session.

Log in to Canvas in your browser, then run:  npm run refresh-cookie

It finds your Canvas session in any supported browser, reads it, and saves it to
.env as CANVAS_COOKIE (plus CANVAS_BASE_URL if unset). No access token needed.
Re-run whenever Canvas logs you out. Nothing leaves your computer.

Supported: Brave, Chrome, Chromium, Edge, Vivaldi, Firefox, LibreWolf, Zen —
on Linux and macOS. Set CANVAS_BROWSER (e.g. "firefox") to force one browser.
"""
import contextlib
import hashlib
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path.home()
MAC = sys.platform == "darwin"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


# (label, kind, base dir, chromium safe-storage service name)
def browsers() -> list[tuple[str, str, Path, str | None]]:
    if MAC:
        app = HOME / "Library/Application Support"
        entries = [
            ("Brave", "chromium", app / "BraveSoftware/Brave-Browser", "Brave Safe Storage"),
            ("Chrome", "chromium", app / "Google/Chrome", "Chrome Safe Storage"),
            ("Chromium", "chromium", app / "Chromium", "Chromium Safe Storage"),
            ("Edge", "chromium", app / "Microsoft Edge", "Microsoft Edge Safe Storage"),
            ("Vivaldi", "chromium", app / "Vivaldi", "Vivaldi Safe Storage"),
            ("Firefox", "firefox", app / "Firefox/Profiles", None),
            ("LibreWolf", "firefox", app / "librewolf/Profiles", None),
            ("Zen", "firefox", app / "zen/Profiles", None),
        ]
    else:
        cfg = HOME / ".config"
        var = HOME / ".var/app"
        entries = [
            ("Brave", "chromium", cfg / "BraveSoftware/Brave-Browser", "Brave Safe Storage"),
            ("Brave", "chromium", cfg / "BraveSoftware/Brave-Browser-Beta", "Brave Safe Storage"),
            ("Chrome", "chromium", cfg / "google-chrome", "Chrome Safe Storage"),
            ("Chromium", "chromium", cfg / "chromium", "Chromium Safe Storage"),
            ("Edge", "chromium", cfg / "microsoft-edge", "Microsoft Edge Safe Storage"),
            ("Vivaldi", "chromium", cfg / "vivaldi", "Vivaldi Safe Storage"),
            ("Brave", "chromium", var / "com.brave.Browser/config/BraveSoftware/Brave-Browser",
             "Brave Safe Storage"),
            ("Chrome", "chromium", var / "com.google.Chrome/config/google-chrome",
             "Chrome Safe Storage"),
            ("Firefox", "firefox", HOME / ".mozilla/firefox", None),
            ("Firefox", "firefox", HOME / "snap/firefox/common/.mozilla/firefox", None),
            ("Firefox", "firefox", var / "org.mozilla.firefox/.mozilla/firefox", None),
            ("LibreWolf", "firefox", HOME / ".librewolf", None),
            ("Zen", "firefox", HOME / ".zen", None),
        ]
    return entries


def cookie_stores() -> list[tuple[str, str, Path, str | None]]:
    """All existing cookie DBs, newest first."""
    out = []
    for label, kind, base, service in browsers():
        if not base.exists():
            continue
        if kind == "chromium":
            paths = list(base.glob("*/Cookies")) + list(base.glob("*/Network/Cookies"))
        else:
            paths = list(base.glob("*/cookies.sqlite")) + list(base.glob("*.default*/cookies.sqlite"))
        for p in paths:
            out.append((label, kind, p, service))
    out.sort(key=lambda t: t[2].stat().st_mtime, reverse=True)
    return out


@contextlib.contextmanager
def opened(path: Path):
    tmpdir = Path(tempfile.mkdtemp())
    tmp = tmpdir / path.name
    shutil.copy2(path, tmp)
    for suffix in ("-wal", "-shm"):
        side = path.with_name(path.name + suffix)
        if side.exists():
            shutil.copy2(side, tmp.with_name(tmp.name + suffix))
    con = sqlite3.connect(f"file:{tmp}?immutable=1", uri=True)
    try:
        yield con
    finally:
        con.close()
        shutil.rmtree(tmpdir, ignore_errors=True)


def chromium_password(service: str) -> bytes | None:
    if MAC:
        try:
            r = subprocess.run(
                ["security", "find-generic-password", "-w", "-s", service],
                capture_output=True, text=True, check=True,
            )
            return r.stdout.rstrip("\n").encode()
        except (subprocess.CalledProcessError, FileNotFoundError):
            return None
    try:
        import secretstorage

        conn = secretstorage.dbus_init()
        items = [
            it for coll in secretstorage.get_all_collections(conn) if not coll.is_locked()
            for it in coll.get_all_items()
        ]
        for it in items:
            if it.get_label() == service:
                return it.get_secret()
        for it in items:
            if it.get_label().endswith("Safe Storage"):
                return it.get_secret()
    except Exception:
        pass
    return b"peanuts"  # Brave/Chrome fallback when no keyring is present


def chromium_key(service: str) -> bytes | None:
    pw = chromium_password(service)
    if pw is None:
        return None
    return hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003 if MAC else 1, dklen=16)


def chromium_decrypt(value: bytes, key: bytes, host: str) -> str | None:
    if not value or value[:3] not in (b"v10", b"v11"):
        return None
    try:
        from Crypto.Cipher import AES
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install -r scripts/requirements.txt")
    dec = AES.new(key, AES.MODE_CBC, iv=b" " * 16).decrypt(value[3:])
    dec = dec[: -dec[-1]]  # strip PKCS7 padding
    if dec.startswith(hashlib.sha256(host.encode()).digest()):
        dec = dec[32:]  # Chromium >=v130 prepends the host hash
    try:
        return dec.decode()
    except UnicodeDecodeError:
        return None


def detect_domains(con, kind: str) -> set[str]:
    if kind == "chromium":
        rows = con.execute("SELECT DISTINCT host_key FROM cookies WHERE name='canvas_session'")
    else:
        rows = con.execute("SELECT DISTINCT host FROM moz_cookies WHERE name='canvas_session'")
    return {r[0].lstrip(".") for r in rows}


def read_cookies(con, kind: str, domain: str, service: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if kind == "chromium":
        key = chromium_key(service)
        if key is None:
            return out
        rows = con.execute(
            "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key IN (?, ?)",
            (domain, "." + domain),
        )
        for host, name, enc in rows:
            val = chromium_decrypt(enc, key, host)
            if val is not None:
                out[name] = val
    else:
        rows = con.execute(
            "SELECT name, value FROM moz_cookies WHERE host IN (?, ?)",
            (domain, "." + domain),
        )
        for name, value in rows:
            out[name] = value
    return out


def read_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out = {}
    for line in ENV_PATH.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip("'\"")
    return out


def write_env(domain: str, header: str) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    lines = [l for l in lines if not l.startswith(("CANVAS_COOKIE=", "CANVAS_BASE_URL="))]
    lines = [l for l in lines if l.startswith("#") or "=" in l]
    lines.append(f"CANVAS_BASE_URL=https://{domain}")
    lines.append(f"CANVAS_COOKIE='{header}'")
    ENV_PATH.write_text("\n".join(lines) + "\n")
    os.chmod(ENV_PATH, 0o600)


def main() -> None:
    env = read_env()
    target = env.get("CANVAS_BASE_URL", "").split("://")[-1].strip("/") or None
    force = os.environ.get("CANVAS_BROWSER", "").lower()

    stores = cookie_stores()
    if not stores:
        sys.exit("No supported browser found. Install one and open it once, or use an access token.")
    if force:
        stores = [s for s in stores if force in s[0].lower()]
        if not stores:
            sys.exit(f"No browser matching CANVAS_BROWSER={force!r} was found.")

    seen_domains: set[str] = set()
    decrypt_failed: list[str] = []
    for label, kind, path, service in stores:
        with opened(path) as con:
            try:
                domains = detect_domains(con, kind)
            except sqlite3.OperationalError:
                continue
            seen_domains |= domains
            if target:
                if target not in domains:
                    continue
                domain = target
            elif len(domains) == 1:
                domain = next(iter(domains))
            elif len(domains) > 1:
                print(f"You're logged into several Canvas sites in {label}: {', '.join(sorted(domains))}")
                print("Set CANVAS_BASE_URL in .env to the one you want, then run this again.")
                sys.exit(1)
            else:
                continue

            cookies = read_cookies(con, kind, domain, service)
        if "canvas_session" not in cookies:
            decrypt_failed.append(label)
            continue

        header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        write_env(domain, header)
        print(f"Done. Connected to {domain} using your {label} session.")
        print("You can now use canvas-mcp. Run this again if Canvas ever logs you out.")
        if "_csrf_token" not in cookies:
            print("Note: reading will work; sending messages or submitting may not.")
        return

    if seen_domains and decrypt_failed:
        sys.exit(
            f"Found a Canvas session in {', '.join(decrypt_failed)} but couldn't read it"
            + (" (macOS may have denied Keychain access — approve the prompt and retry)." if MAC
               else " (keyring locked?).")
        )
    sys.exit(
        "You're not logged into Canvas in any browser. Open your browser, sign in to\n"
        "your school's Canvas, then run this again."
    )


if __name__ == "__main__":
    main()
