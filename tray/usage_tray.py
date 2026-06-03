#!/usr/bin/env python3
"""
Agent Hub Remote Usage Tray - Windows system tray icon showing quota % from local files.
Reads ~/.claude/usage-status.json, usage-log.jsonl, ~/.codex/sessions/**
No API calls. Updates every 30 s.
"""
import sys, os, json, time, glob, re, threading, webbrowser
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    import pystray
except ImportError:
    sys.exit("Missing deps — run: pip install pystray pillow")

AGENT_HUB_URL  = "http://127.0.0.1:3334"
POLL_INTERVAL  = 30   # seconds

HOME        = Path.home()
STATUS_FILE = HOME / ".claude" / "usage-status.json"
LOG_FILE    = HOME / ".claude" / "usage-log.jsonl"
CODEX_DIR   = HOME / ".codex" / "sessions"

# ── data helpers ──────────────────────────────────────────────────────────────

def _deep_num(obj, pat):
    """Recursive key-name search for a numeric value."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if re.search(pat, k, re.I):
                if isinstance(v, (int, float)):
                    return v
            r = _deep_num(v, pat)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = _deep_num(item, pat)
            if r is not None:
                return r
    return None


def _to_ms(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value if value > 1_000_000_000_000 else value * 1000
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            try:
                n = float(value)
                return n if n > 1_000_000_000_000 else n * 1000
            except ValueError:
                return None
    return None


def _direct_rate_limit(raw, key):
    if not isinstance(raw, dict):
        return None, None
    entry = raw.get("rate_limits", {}).get(key)
    if not isinstance(entry, dict):
        return None, None
    pct = entry.get("used_percentage", entry.get("used_percent", entry.get("percent_used")))
    reset = entry.get("resets_at", entry.get("reset_at", entry.get("expires_at", entry.get("renews_at"))))
    return pct, _to_ms(reset)


def read_claude_quota():
    try:
        if not STATUS_FILE.exists():
            return {"available": False, "reason": "no status file"}
        payload = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        raw = payload.get("raw", payload) if isinstance(payload, dict) else payload
        sp_direct, sr_direct = _direct_rate_limit(raw, "five_hour")
        wp_direct, wr_direct = _direct_rate_limit(raw, "seven_day")
        sp = sp_direct if sp_direct is not None else _deep_num(raw, r"five_hour|5h|session_pct|session.*pct|pct.*session")
        wp = wp_direct if wp_direct is not None else _deep_num(raw, r"seven_day|7d|week.*pct|pct.*week|weekly")
        sr = sr_direct if sr_direct is not None else _deep_num(raw, r"session.*reset|reset.*session|five.*reset")
        wr = wr_direct if wr_direct is not None else _deep_num(raw, r"week.*reset|reset.*week|seven.*reset")
        if sp is None and wp is None:
            return {"available": False, "reason": "quota fields not yet captured (needs terminal Claude session)"}
        return {
            "available": True,
            "session_pct":    round(sp) if sp is not None else None,
            "weekly_pct":     round(wp) if wp is not None else None,
            "session_reset_ms": sr,
            "weekly_reset_ms":  wr,
        }
    except Exception as e:
        return {"available": False, "reason": str(e)}


def read_usage_log():
    try:
        if not LOG_FILE.exists():
            return None
        # 用本地日期界定「今日」，與 usage-core.js 的本地午夜邊界對齊。
        # log 的 ts_str 是 UTC ISO（…Z），所以必須解析後轉本地再比日期；
        # 直接 startswith 在午夜跨日時會把當天凌晨算去前一天。
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        five_h_ago = time.time() - 5 * 3600
        tokens = cost = turns = w5_tokens = 0
        with open(LOG_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    ts_str = e.get("logged_at") or e.get("turn_ts") or ""
                    if not ts_str:
                        continue
                    try:
                        ets_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    except ValueError:
                        continue
                    local_date = ets_dt.astimezone().strftime("%Y-%m-%d")
                    if local_date != today:
                        continue
                    t = (e.get("input_tokens", 0) + e.get("output_tokens", 0)
                         + e.get("cache_read_tokens", 0) + e.get("cache_creation_tokens", 0))
                    tokens += t
                    cost   += e.get("estimated_cost_usd", 0) or 0
                    turns  += 1
                    if ets_dt.timestamp() >= five_h_ago:
                        w5_tokens += t
                except Exception:
                    pass
        return {"tokens": tokens, "cost": cost, "turns": turns, "w5_tokens": w5_tokens}
    except Exception:
        return None


def read_codex_quota():
    try:
        files = glob.glob(str(CODEX_DIR / "**" / "*.jsonl"), recursive=True)
        if not files:
            return {"available": False}
        newest = max(files, key=os.path.getmtime)
        primary_pct = secondary_pct = None
        with open(newest, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or "rate_limit" not in line:
                    continue
                try:
                    entry = json.loads(line)
                    # Schema: entry.payload.rate_limits.primary.used_percent
                    if not isinstance(entry, dict):
                        continue
                    payload = entry.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    rl = payload.get("rate_limits")
                    if not isinstance(rl, dict):
                        continue
                    p = rl.get("primary")
                    s = rl.get("secondary")
                    if isinstance(p, dict) and p.get("used_percent") is not None:
                        primary_pct = round(p["used_percent"])
                    if isinstance(s, dict) and s.get("used_percent") is not None:
                        secondary_pct = round(s["used_percent"])
                except Exception:
                    pass
        if primary_pct is None:
            return {"available": False}
        return {
            "available":     True,
            "primary_pct":   primary_pct,
            "secondary_pct": secondary_pct,
            "source":        os.path.basename(newest),
        }
    except Exception as e:
        return {"available": False, "reason": str(e)}


def get_usage():
    return {
        "generated_at": int(time.time() * 1000),
        "claude": {"quota": read_claude_quota(), "today": read_usage_log()},
        "codex":  read_codex_quota(),
    }

# ── icon rendering ────────────────────────────────────────────────────────────

def _find_font(size):
    for p in [
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/calibri.ttf",
    ]:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def _pct_rgb(pct):
    if pct is None:  return (140, 140, 140)
    if pct >= 90:    return (255,  90,  90)
    if pct >= 70:    return (255, 200,  80)
    return (100, 230, 130)


def make_icon(label: str, pct=None) -> Image.Image:
    sz    = 64
    img   = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    draw  = ImageDraw.Draw(img)
    draw.ellipse([1, 1, sz - 1, sz - 1], fill=(22, 22, 26, 245))

    fg    = _pct_rgb(pct)
    fsize = 20 if len(label) <= 3 else 15 if len(label) <= 5 else 12
    font  = _find_font(fsize)

    try:
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = (sz - tw) // 2 - bbox[0]
        y = (sz - th) // 2 - bbox[1]
    except AttributeError:
        # Pillow < 9.2 fallback
        tw, th = draw.textsize(label, font=font)   # type: ignore[attr-defined]
        x, y = (sz - tw) // 2, (sz - th) // 2

    draw.text((x, y), label, fill=fg + (255,), font=font)
    return img

# ── tray controller ───────────────────────────────────────────────────────────

def _fmt_tok(n):
    if n is None:   return "—"
    if n >= 1_000_000: return f"{n/1e6:.2f}M"
    if n >= 1_000:     return f"{n/1e3:.1f}k"
    return str(n)


def _countdown(ms):
    if not ms:
        return ""
    d = ms - time.time() * 1000
    if d <= 0:
        return " (resetting soon)"
    h = int(d / 3_600_000)
    m = int((d % 3_600_000) / 60_000)
    return f" ({h}h{m}m)" if h > 0 else f" ({m}m)"


class UsageTray:
    def __init__(self):
        self._data       = None
        self._lock       = threading.Lock()
        self._icon       = None
        self._stop_event = threading.Event()

    # ── display logic ──────────────────────────────────────────────────────────

    def _get_display(self, data):
        """Return (label, pct) for tray icon."""
        if not data:
            return "—", None
        q     = data.get("claude", {}).get("quota", {})
        today = data.get("claude", {}).get("today")
        cx    = data.get("codex", {})

        if q.get("available") and q.get("session_pct") is not None:
            pct = q["session_pct"]
            return f"{pct}%", pct

        if cx.get("available") and cx.get("primary_pct") is not None:
            pct = cx["primary_pct"]
            return f"cx{pct}", pct

        if today and today.get("cost"):
            return f"${today['cost']:.1f}", None

        return "—", None

    def _build_menu(self, data):
        items = []

        if data:
            q     = data.get("claude", {}).get("quota", {})
            today = data.get("claude", {}).get("today")
            cx    = data.get("codex", {})

            if q.get("available"):
                sp = q.get("session_pct")
                wp = q.get("weekly_pct")
                sr = _countdown(q.get("session_reset_ms"))
                wr = _countdown(q.get("weekly_reset_ms"))
                items.append(pystray.MenuItem(
                    f"Claude 5h: {sp}%{sr}  7d: {wp}%{wr}",
                    None, enabled=False))
            else:
                reason = q.get("reason", "pending")
                items.append(pystray.MenuItem(f"Claude quota: {reason}", None, enabled=False))

            if today:
                items.append(pystray.MenuItem(
                    f"Today: {_fmt_tok(today.get('tokens'))} tok  "
                    f"${today.get('cost', 0):.2f}  {today.get('turns', 0)} turns",
                    None, enabled=False))
                items.append(pystray.MenuItem(
                    f"Near-5h: {_fmt_tok(today.get('w5_tokens'))} tok",
                    None, enabled=False))

            if cx.get("available"):
                sp2 = cx.get("secondary_pct")
                s2  = f"  sec: {sp2}%" if sp2 is not None else ""
                items.append(pystray.MenuItem(
                    f"Codex: {cx.get('primary_pct')}%{s2}",
                    None, enabled=False))

        items += [
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open agent-hub", self._open_hub),
            pystray.MenuItem("Refresh now",    self._refresh),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Exit",           self._exit),
        ]
        return pystray.Menu(*items)

    # ── callbacks ──────────────────────────────────────────────────────────────

    def _open_hub(self, *_):
        webbrowser.open(AGENT_HUB_URL)

    def _refresh(self, *_):
        self._update(force=True)

    def _exit(self, *_):
        self._stop_event.set()
        if self._icon:
            self._icon.stop()

    # ── update ────────────────────────────────────────────────────────────────

    def _update(self, force=False):
        try:
            data = get_usage()
            with self._lock:
                self._data = data
            label, pct = self._get_display(data)
            img = make_icon(label, pct)
            if self._icon:
                self._icon.icon  = img
                self._icon.menu  = self._build_menu(data)
                self._icon.title = f"AHR Usage - {label}"
        except Exception:
            pass

    def _poll(self):
        while not self._stop_event.wait(POLL_INTERVAL):
            self._update()

    # ── run ───────────────────────────────────────────────────────────────────

    def run(self):
        self._update()
        with self._lock:
            data = self._data
        label, pct = self._get_display(data)
        img = make_icon(label, pct)

        self._icon = pystray.Icon(
            "AHR Usage",
            img,
            title=f"AHR Usage - {label}",
            menu=self._build_menu(data),
        )

        t = threading.Thread(target=self._poll, daemon=True)
        t.start()
        self._icon.run()


if __name__ == "__main__":
    UsageTray().run()
