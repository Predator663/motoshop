"""
MotoShop Backend - Flask REST API
Single-file backend with SQLite, JWT auth, real-time SSE
"""
import os
import io
import re
import base64
import json
import time
import queue
import hashlib
import secrets
import sqlite3
import datetime
from zoneinfo import ZoneInfo
from functools import wraps
from flask import Flask, request, jsonify, g, Response, stream_with_context, send_from_directory, send_file
from flask_cors import CORS

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.enums import TA_RIGHT, TA_CENTER, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

try:
    from PIL import Image as PILImage, ImageDraw, ImageFont
except ImportError:
    PILImage = None

app = Flask(__name__)

# FIX (Render deploy): the built React app (frontend/dist, created by
# `npm run build`) is served from this same Flask process. Using a plain
# Flask app here (no static_folder/static_url_path passed in) avoids
# colliding with Flask's own auto-registered static route; serve_frontend()
# below handles all of this manually with send_from_directory.
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist')

# FIX (Render deploy): DB path is now configurable via env var so it can point
# at a Render persistent disk mount (e.g. DB_PATH=/var/data/motoshop.db) in
# production, instead of being hardcoded next to app.py.
app.config['DATABASE'] = os.environ.get(
    'DB_PATH',
    os.path.join(os.path.dirname(__file__), 'motoshop.db')
)

# FIX (Render deploy): allow extra CORS origins (e.g. a separately-hosted
# frontend) via env var, on top of the local dev defaults.
_default_origins = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']
_extra_origins = [o.strip() for o in os.environ.get('ALLOWED_ORIGINS', '').split(',') if o.strip()]
CORS(app, supports_credentials=True, origins=_default_origins + _extra_origins)

def _load_secret_key():
    env_key = os.environ.get('SECRET_KEY')
    if env_key:
        return env_key
    # FIX (cashier logged out repeatedly): this used to write .secret_key
    # next to app.py — i.e. inside the app's own SOURCE directory, not the
    # persistent disk that DATABASE/DB_PATH points at. On Render, that
    # source directory is rebuilt from scratch on every deploy (and can be
    # wiped on a plain restart too), so a BRAND NEW random key was
    # generated almost every time the server restarted. Every existing
    # login token (owner's and cashier's alike) is signed with the old
    # key, so it instantly stops verifying — everyone gets silently logged
    # out. From the cashier's side this looked exactly like "the account
    # keeps turning itself off" even though nothing about the account
    # itself had changed.
    #
    # Fix: store the key as a row in the SQLite database instead — that
    # file already lives on the persistent disk (see DATABASE config
    # above), so it now survives deploys/restarts exactly like the shop's
    # actual data does. A pre-existing .secret_key file (from before this
    # fix) is migrated in once, so upgrading doesn't itself cause one more
    # mass logout.
    db_path = app.config['DATABASE']
    os.makedirs(os.path.dirname(db_path) or '.', exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS _secret (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        row = conn.execute("SELECT v FROM _secret WHERE k='secret_key'").fetchone()
        if row:
            return row[0]
        legacy_file = os.path.join(os.path.dirname(__file__), '.secret_key')
        if os.path.exists(legacy_file):
            with open(legacy_file, 'r') as f:
                new_key = f.read().strip()
        else:
            new_key = secrets.token_hex(32)
        conn.execute("INSERT INTO _secret (k, v) VALUES ('secret_key', ?)", (new_key,))
        conn.commit()
        return new_key
    finally:
        conn.close()

app.config['SECRET_KEY'] = _load_secret_key()

# ── SSE event bus ─────────────────────────────────────────────────────────
import threading
sse_clients = []
_sse_lock = threading.Lock()

def push_event(event_type, data):
    payload = json.dumps({'type': event_type, 'data': data, 'ts': time.time()})
    dead = []
    with _sse_lock:
        for q in sse_clients:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            sse_clients.remove(q)

# ── Database ──────────────────────────────────────────────────────────────
def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(
            app.config['DATABASE'],
            detect_types=sqlite3.PARSE_DECLTYPES
        )
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def query_db(sql, args=(), one=False):
    db = get_db()
    cur = db.execute(sql, args)
    rv = cur.fetchall()
    return (rv[0] if rv else None) if one else rv

def exec_db(sql, args=()):
    db = get_db()
    cur = db.execute(sql, args)
    db.commit()
    return cur.lastrowid

def rows_to_list(rows):
    return [dict(r) for r in rows]

# ── Professional PDF report generation ──────────────────────────────────
# Shared letterhead/branding pulled straight from Settings (shop_name, logo,
# address, phone, currency) so every exported report matches the shop's own
# identity instead of a generic template.

_BRAND_NAVY  = colors.HexColor('#0f1923')
_BRAND_AMBER = colors.HexColor('#f5a524')
_BRAND_GREEN = colors.HexColor('#22c55e')
_BRAND_RED   = colors.HexColor('#ef4444')
_BRAND_GREY  = colors.HexColor('#64748b')
_ROW_ALT     = colors.HexColor('#f4f6f9')

def get_settings_dict():
    rows = query_db("SELECT key,value FROM settings")
    return {r['key']: r['value'] for r in rows}

_PROCESS_STARTED_AT = time.time()

def get_admin_flag(key, default=None):
    row = query_db("SELECT value FROM _admin_flags WHERE key=?", (key,), one=True)
    return row['value'] if row else default

def set_admin_flag(key, value):
    exec_db("INSERT INTO _admin_flags (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

def is_maintenance_mode():
    return get_admin_flag('maintenance_mode', '0') == '1'

def get_feature_flags():
    try:
        return json.loads(get_admin_flag('feature_flags', '{}') or '{}')
    except Exception:
        return {}

_DEFAULT_LEGAL_CONTENT = {
    'privacy_title': 'Sera ya Faragha',
    'privacy_body': 'Sera ya faragha bado haijawekwa na msimamizi wa mfumo.',
    'terms_title': 'Vigezo na Masharti',
    'terms_body': 'Vigezo na masharti bado havijawekwa na msimamizi wa mfumo.',
    'about_name': '',
    'about_title': '',
    'about_bio': '',
    'about_photo': '',
}

def get_legal_content():
    try:
        stored = json.loads(get_admin_flag('legal_content', '{}') or '{}')
    except Exception:
        stored = {}
    merged = dict(_DEFAULT_LEGAL_CONTENT)
    merged.update({k: v for k, v in stored.items() if k in _DEFAULT_LEGAL_CONTENT})
    return merged

def pdf_money(value, currency='Tsh'):
    try:
        value = float(value)
    except (TypeError, ValueError):
        value = 0.0
    sign = '-' if value < 0 else ''
    return f"{sign}{currency} {abs(value):,.0f}"

def pdf_qty(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    return str(int(v)) if v == int(v) else f"{v:.1f}"

def _pdf_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('ShopName', parent=styles['Heading1'], fontSize=17,
                               textColor=_BRAND_NAVY, spaceAfter=0, leading=20))
    styles.add(ParagraphStyle('ShopMeta', parent=styles['Normal'], fontSize=8.5,
                               textColor=_BRAND_GREY, leading=12))
    styles.add(ParagraphStyle('ReportTitle', parent=styles['Normal'], fontSize=13,
                               textColor=colors.white, leading=16))
    styles.add(ParagraphStyle('ReportPeriod', parent=styles['Normal'], fontSize=9,
                               textColor=colors.HexColor('#cbd5e1'), leading=12))
    styles.add(ParagraphStyle('SectionHeader', parent=styles['Normal'], fontSize=10.5,
                               textColor=colors.white, leading=13))
    styles.add(ParagraphStyle('CellR', parent=styles['Normal'], fontSize=8.5, alignment=TA_RIGHT))
    styles.add(ParagraphStyle('CellL', parent=styles['Normal'], fontSize=8.5, alignment=TA_LEFT))
    return styles

def _pdf_logo_flowable(settings, max_h=15*mm):
    logo = settings.get('logo_image')
    if not logo or 'base64,' not in logo:
        return None
    try:
        header, b64data = logo.split('base64,', 1)
        raw = base64.b64decode(b64data)
        img = Image(io.BytesIO(raw))
        ratio = img.imageWidth / img.imageHeight if img.imageHeight else 1
        img.drawHeight = max_h
        img.drawWidth = max_h * ratio
        return img
    except Exception:
        return None

def _shop_zone(settings):
    """Resolve the shop's configured timezone (Settings > timezone), falling
    back to EAT — this is a Tanzania shop app — and to UTC if the stored
    value is somehow not a valid IANA zone."""
    tz_name = (settings.get('timezone') or 'Africa/Dar_es_Salaam').strip()
    try:
        return ZoneInfo(tz_name)
    except Exception:
        try:
            return ZoneInfo('Africa/Dar_es_Salaam')
        except Exception:
            return datetime.timezone.utc


def _pdf_header_footer(settings, report_title, report_period=None):
    """Returns an onPage(canvas, doc) callback drawing letterhead + footer."""
    shop_name = settings.get('shop_name') or settings.get('header_title') or 'MotoShop'
    shop_phone = settings.get('shop_phone') or ''
    shop_address = settings.get('shop_address') or ''
    generated = datetime.datetime.now(_shop_zone(settings)).strftime('%d %b %Y, %H:%M')

    def _draw(cnv, doc):
        cnv.saveState()
        w, h = A4
        # Top letterhead band
        band_h = 24*mm
        cnv.setFillColor(_BRAND_NAVY)
        cnv.rect(0, h - band_h, w, band_h, fill=1, stroke=0)
        cnv.setFillColor(_BRAND_AMBER)
        cnv.rect(0, h - band_h - 1.2*mm, w, 1.2*mm, fill=1, stroke=0)

        x = 15*mm
        cnv.setFillColor(colors.white)
        cnv.setFont('Helvetica-Bold', 14)
        cnv.drawString(x, h - 10*mm, shop_name)
        cnv.setFont('Helvetica', 8)
        cnv.setFillColor(colors.HexColor('#cbd5e1'))
        meta_bits = [b for b in [shop_address, shop_phone] if b]
        cnv.drawString(x, h - 15*mm, '  •  '.join(meta_bits))

        cnv.setFont('Helvetica-Bold', 11)
        cnv.setFillColor(colors.white)
        cnv.drawRightString(w - 15*mm, h - 10*mm, report_title)
        if report_period:
            cnv.setFont('Helvetica', 8)
            cnv.setFillColor(colors.HexColor('#cbd5e1'))
            cnv.drawRightString(w - 15*mm, h - 15*mm, report_period)

        # Footer
        cnv.setFillColor(_BRAND_GREY)
        cnv.setFont('Helvetica', 7.5)
        cnv.drawString(15*mm, 10*mm, f"Generated {generated}  •  MotoShop")
        cnv.drawRightString(w - 15*mm, 10*mm, f"Page {doc.page}")
        cnv.setStrokeColor(colors.HexColor('#e2e8f0'))
        cnv.line(15*mm, 13*mm, w - 15*mm, 13*mm)
        cnv.restoreState()
    return _draw

def _pdf_kpi_table(pairs, styles):
    """pairs: list of (label, value_str, color) -> a single row of KPI cells,
    label stacked above value, columns evenly split across the page width."""
    n = len(pairs)
    col_w = (180*mm) / n
    lbl_style = ParagraphStyle('kpiLbl', parent=styles['Normal'], fontSize=7.5,
                                textColor=_BRAND_GREY, leading=9)
    label_row = [Paragraph(label.upper(), lbl_style) for label, _, _ in pairs]
    value_row = [Paragraph(f"<b>{value}</b>", ParagraphStyle(f'kpiVal{i}', parent=styles['Normal'],
                 fontSize=12.5, textColor=color, leading=15))
                 for i, (_, value, color) in enumerate(pairs)]
    t = Table([label_row, value_row], colWidths=[col_w]*n)
    t.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 0.5, colors.HexColor('#e2e8f0')),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#e2e8f0')),
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#f8fafc')),
        ('TOPPADDING', (0,0), (-1,0), 8),
        ('BOTTOMPADDING', (0,0), (-1,0), 2),
        ('TOPPADDING', (0,1), (-1,1), 1),
        ('BOTTOMPADDING', (0,1), (-1,1), 9),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ]))
    return t

def _pdf_section_header(text, styles):
    t = Table([[Paragraph(text.upper(), styles['SectionHeader'])]], colWidths=[180*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), _BRAND_NAVY),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
    ]))
    return t

def _pdf_data_table(headers, rows, col_widths, right_cols=()):
    styles = _pdf_styles()
    head_row = [Paragraph(f"<b>{h}</b>", ParagraphStyle('h', parent=styles['Normal'],
                fontSize=8, textColor=colors.white,
                alignment=TA_RIGHT if i in right_cols else TA_LEFT))
                for i, h in enumerate(headers)]
    body = [head_row]
    for r in rows:
        body.append([
            Paragraph(str(c), styles['CellR'] if i in right_cols else styles['CellL'])
            for i, c in enumerate(r)
        ])
    t = Table(body, colWidths=col_widths, repeatRows=1)
    style = [
        ('BACKGROUND', (0,0), (-1,0), _BRAND_NAVY),
        ('LINEBELOW', (0,0), (-1,0), 0.75, _BRAND_AMBER),
        ('GRID', (0,1), (-1,-1), 0.4, colors.HexColor('#e2e8f0')),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 7),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]
    for i in range(1, len(body)):
        if i % 2 == 0:
            style.append(('BACKGROUND', (0,i), (-1,i), _ROW_ALT))
    t.setStyle(TableStyle(style))
    return t

def build_pdf(report_title, report_period, story_builder):
    """report_title/period appear in the letterhead. story_builder(styles,
    settings, currency) -> list of flowables for the body."""
    settings = get_settings_dict()
    currency = settings.get('currency') or 'Tsh'
    styles = _pdf_styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                             topMargin=30*mm, bottomMargin=18*mm,
                             leftMargin=15*mm, rightMargin=15*mm,
                             title=report_title)
    logo = _pdf_logo_flowable(settings)
    story = []
    if logo:
        logo.hAlign = 'LEFT'
        story += [logo, Spacer(1, 4*mm)]
    story += story_builder(styles, settings, currency)
    on_page = _pdf_header_footer(settings, report_title, report_period)
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    buf.seek(0)
    return buf

def pdf_file_response(buf, filename):
    return send_file(buf, mimetype='application/pdf', as_attachment=True, download_name=filename)

# ── Installable PWA: manifest + icon generated live from Settings ───────
# So "install app" on desktop/phone shows the SHOP's own name and logo —
# not a generic "MotoShop" — without needing a rebuild every time a shop
# changes its branding. Both endpoints are public (no @require_owner):
# the browser fetches them itself, often before anyone is logged in.

def _brand_icon_image(size, maskable, settings):
    shop_name = settings.get('shop_name') or settings.get('header_title') or 'MotoShop'
    logo = settings.get('logo_image')
    img = None
    if logo and 'base64,' in logo and PILImage:
        try:
            _, b64data = logo.split('base64,', 1)
            raw = base64.b64decode(b64data)
            src = PILImage.open(io.BytesIO(raw)).convert('RGBA')
            pad = int(size * 0.12) if maskable else int(size * 0.04)
            target = max(1, size - pad * 2)
            src.thumbnail((target, target), PILImage.LANCZOS)
            img = PILImage.new('RGBA', (size, size), (15, 25, 35, 255))
            offset = ((size - src.width) // 2, (size - src.height) // 2)
            img.paste(src, offset, src)
        except Exception:
            img = None
    if img is None and PILImage:
        # No logo uploaded yet — fall back to a clean brand-colored tile
        # with the shop's initial, so the app is still installable with a
        # sensible icon before any branding is configured.
        img = PILImage.new('RGBA', (size, size), (245, 165, 36, 255))
        try:
            draw = ImageDraw.Draw(img)
            letter = (shop_name.strip()[:1] or 'M').upper()
            font = ImageFont.load_default(size=int(size * 0.55))
            bbox = draw.textbbox((0, 0), letter, font=font)
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), letter, fill=(15, 25, 35, 255), font=font)
        except Exception:
            pass  # plain color tile is still a perfectly valid icon
    return img

@app.route('/api/manifest-icon', methods=['GET'])
def manifest_icon():
    if not PILImage:
        return Response(status=404)
    try:
        size = max(48, min(int(request.args.get('size', 192)), 1024))
    except (TypeError, ValueError):
        size = 192
    maskable = request.args.get('maskable') == '1'
    settings = get_settings_dict()
    img = _brand_icon_image(size, maskable, settings)
    if img is None:
        return Response(status=404)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    resp = send_file(buf, mimetype='image/png')
    resp.headers['Cache-Control'] = 'public, max-age=300'
    return resp

@app.route('/api/manifest.webmanifest', methods=['GET'])
def dynamic_manifest():
    settings = get_settings_dict()
    name = (settings.get('header_title') or settings.get('shop_name') or 'MotoShop').strip() or 'MotoShop'
    short = name if len(name) <= 12 else name[:12]
    icon_small = '/api/manifest-icon?size=96'
    manifest = {
        'id': '/',
        'name': name,
        'short_name': short,
        'description': settings.get('header_subtitle') or 'Mfumo wa Usimamizi wa Duka',
        'start_url': '/',
        'scope': '/',
        'display': 'standalone',
        'display_override': ['window-controls-overlay', 'standalone', 'minimal-ui'],
        'orientation': 'any',
        'categories': ['business', 'finance', 'productivity'],
        'background_color': '#0f1923',
        'theme_color': '#0f1923',
        'icons': [
            {'src': '/api/manifest-icon?size=192', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': '/api/manifest-icon?size=512', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': '/api/manifest-icon?size=192&maskable=1', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'maskable'},
            {'src': '/api/manifest-icon?size=512&maskable=1', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
        # Long-press / right-click the installed icon for quick actions —
        # handled client-side by reading ?tab= on first load (see main.jsx).
        'shortcuts': [
            {
                'name': 'Mauzo Mapya', 'short_name': 'POS', 'url': '/?tab=pos',
                'icons': [{'src': icon_small, 'sizes': '96x96', 'type': 'image/png'}],
            },
            {
                'name': 'Dashibodi', 'short_name': 'Dashibodi', 'url': '/?tab=dashboard',
                'icons': [{'src': icon_small, 'sizes': '96x96', 'type': 'image/png'}],
            },
        ],
    }
    resp = jsonify(manifest)
    resp.headers['Content-Type'] = 'application/manifest+json'
    resp.headers['Cache-Control'] = 'no-cache'
    return resp

# ── Auth helpers ──────────────────────────────────────────────────────────
def hash_password(pw):
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + pw).encode()).hexdigest()
    return f"{salt}:{h}"

def verify_password(pw, stored):
    try:
        salt, h = stored.split(':')
        return hashlib.sha256((salt + pw).encode()).hexdigest() == h
    except Exception:
        return False

def make_token(user_id, role):
    # FIX (offline support): 8h was tied to a single shift, but a cashier
    # working offline (no power/internet) needs the session — and any sales
    # queued while offline — to still be valid whenever connectivity returns.
    # 7 days gives real headroom for multi-day outages while still expiring.
    payload = {'user_id': user_id, 'role': role, 'exp': time.time() + 7 * 24 * 3600}
    raw = json.dumps(payload)
    sig = hashlib.sha256((raw + app.config['SECRET_KEY']).encode()).hexdigest()
    import base64
    token = base64.b64encode(raw.encode()).decode() + '.' + sig
    return token

def verify_token(token):
    try:
        import base64
        parts = token.split('.', 1)
        if len(parts) != 2:
            return None
        raw = base64.b64decode(parts[0]).decode()
        sig = hashlib.sha256((raw + app.config['SECRET_KEY']).encode()).hexdigest()
        if sig != parts[1]:
            return None
        payload = json.loads(raw)
        if payload['exp'] < time.time():
            return None
        return payload
    except Exception:
        return None

def _extract_token():
    header = request.headers.get('Authorization', '').replace('Bearer ', '').strip()
    if header:
        return header
    return request.args.get('token', '')

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        payload = verify_token(_extract_token())
        if not payload:
            return jsonify({'error': 'Unauthorized'}), 401
        g.user_id = payload['user_id']
        g.role = payload['role']
        return f(*args, **kwargs)
    return decorated

def strip_cost_fields(rows, role):
    """Hide cost/value fields (thamani ya bidhaa) from anyone who isn't an owner."""
    if role in ('owner', 'superuser'):
        return rows
    hidden = ('buying_price', 'cost_per_unit', 'cost_value', 'stock_value', 'total_value')
    if isinstance(rows, list):
        for r in rows:
            for k in hidden:
                r.pop(k, None)
        return rows
    if isinstance(rows, dict):
        for k in hidden:
            rows.pop(k, None)
        return rows
    return rows

def require_owner(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        payload = verify_token(_extract_token())
        if not payload:
            return jsonify({'error': 'Unauthorized'}), 401
        if payload['role'] not in ('owner', 'superuser'):
            return jsonify({'error': 'Owner access required'}), 403
        g.user_id = payload['user_id']
        g.role = payload['role']
        return f(*args, **kwargs)
    return decorated

def require_superuser(f):
    # The "Creator" role — sits above owner. Used exclusively for the
    # /api/admin/* control panel (raw data browser, maintenance mode,
    # backups, feature flags). Never granted through any signup path —
    # only ever provisioned via SUPERUSER_USERNAME/SUPERUSER_PASSWORD env
    # vars at startup (see _bootstrap_superuser), so it can't be created
    # or escalated to through the app itself.
    @wraps(f)
    def decorated(*args, **kwargs):
        payload = verify_token(_extract_token())
        if not payload:
            return jsonify({'error': 'Unauthorized'}), 401
        if payload['role'] != 'superuser':
            return jsonify({'error': 'Superuser access required'}), 403
        g.user_id = payload['user_id']
        g.role = payload['role']
        return f(*args, **kwargs)
    return decorated

# ── Maintenance mode ─────────────────────────────────────────────────────
# Superuser can take the whole site offline for everyone except themself.
# Kept deliberately minimal: a handful of routes must stay reachable no
# matter what, or the superuser could lock themselves out along with
# everyone else.
_MAINTENANCE_ALWAYS_ALLOWED_PREFIXES = (
    '/api/auth/login',
    '/api/admin/',
    '/api/system-status',
    '/api/legal-content',
    '/api/manifest.webmanifest',
    '/api/manifest-icon',
    '/api/setup/status',
    '/api/health',
)

@app.before_request
def _maintenance_gate():
    if request.method == 'OPTIONS':
        return None
    path = request.path
    if not path.startswith('/api/'):
        return None  # let the SPA shell itself load; it will show the maintenance screen
    if any(path.startswith(p) for p in _MAINTENANCE_ALWAYS_ALLOWED_PREFIXES):
        return None
    try:
        if not is_maintenance_mode():
            return None
    except Exception:
        return None  # DB not ready yet (e.g. very first request) — fail open
    payload = verify_token(_extract_token())
    if payload and payload.get('role') == 'superuser':
        return None
    return jsonify({'error': get_admin_flag('maintenance_message', 'Mfumo uko chini kwa muda.'),
                     'maintenance': True}), 503

@app.route('/api/system-status', methods=['GET'])
def system_status():
    # Public and unauthenticated on purpose — the login screen itself needs
    # to know whether to show "site under maintenance" before anyone has a
    # token yet.
    try:
        return jsonify({'maintenance': is_maintenance_mode(),
                         'message': get_admin_flag('maintenance_message', ''),
                         'feature_flags': get_feature_flags()})
    except Exception:
        return jsonify({'maintenance': False, 'message': '', 'feature_flags': {}})

@app.route('/api/legal-content', methods=['GET'])
def legal_content_public():
    # Public and unauthenticated — Privacy/Terms/About need to be readable
    # by anyone (including from the login screen, before anyone is signed
    # in), and are controlled exclusively by the superuser.
    try:
        return jsonify(get_legal_content())
    except Exception:
        return jsonify(_DEFAULT_LEGAL_CONTENT)


def init_db():
    db = sqlite3.connect(app.config['DATABASE'])
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner','cashier','superuser')),
            is_active INTEGER NOT NULL DEFAULT 1,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sku TEXT UNIQUE NOT NULL,
            category_id INTEGER REFERENCES categories(id),
            buying_price REAL NOT NULL DEFAULT 0,
            selling_price REAL NOT NULL DEFAULT 0,
            min_stock REAL NOT NULL DEFAULT 0,
            current_stock REAL NOT NULL DEFAULT 0,
            unit_type TEXT NOT NULL DEFAULT 'Piece',
            allow_decimal INTEGER NOT NULL DEFAULT 0,
            shelf_location TEXT,
            moto_compat TEXT,
            notes TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id),
            type TEXT NOT NULL CHECK(type IN ('receive','sale','adjustment','cancellation')),
            qty_change REAL NOT NULL,
            cost_per_unit REAL,
            reason TEXT,
            reference TEXT,
            note TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cashier_id INTEGER NOT NULL REFERENCES users(id),
            opened_at TEXT NOT NULL DEFAULT (datetime('now')),
            closed_at TEXT,
            opening_cash REAL NOT NULL DEFAULT 0,
            closing_cash_actual REAL,
            closing_cash_expected REAL,
            variance REAL,
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
        );

        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_no TEXT UNIQUE NOT NULL,
            shift_id INTEGER REFERENCES shifts(id),
            sold_by INTEGER NOT NULL REFERENCES users(id),
            customer_name TEXT,
            customer_phone TEXT,
            customer_type TEXT NOT NULL DEFAULT 'walk-in' CHECK(customer_type IN ('walk-in','named')),
            subtotal REAL NOT NULL DEFAULT 0,
            discount_pct REAL NOT NULL DEFAULT 0,
            discount_amt REAL NOT NULL DEFAULT 0,
            vat_pct REAL NOT NULL DEFAULT 0,
            vat_amt REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            payment_method TEXT NOT NULL DEFAULT 'cash',
            payment_ref TEXT,
            amount_paid REAL NOT NULL DEFAULT 0,
            change_given REAL NOT NULL DEFAULT 0,
            is_credit INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','cancelled')),
            cancelled_at TEXT,
            cancelled_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sale_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id),
            product_name TEXT NOT NULL,
            qty REAL NOT NULL,
            unit_price REAL NOT NULL,
            discount_pct REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL,
            buying_price_at_sale REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS debts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id INTEGER NOT NULL REFERENCES sales(id),
            customer_name TEXT NOT NULL,
            customer_phone TEXT,
            original_amount REAL NOT NULL,
            paid_amount REAL NOT NULL DEFAULT 0,
            remaining REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid','cancelled')),
            due_date TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS debt_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            debt_id INTEGER NOT NULL REFERENCES debts(id),
            amount REAL NOT NULL,
            payment_method TEXT NOT NULL,
            reference TEXT,
            note TEXT,
            paid_by INTEGER REFERENCES users(id),
            paid_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            amount REAL NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            expense_date TEXT NOT NULL,
            payment_method TEXT NOT NULL DEFAULT 'cash',
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER REFERENCES users(id),
            action TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)

    # Default settings
    defaults = {
        'shop_name': 'MotoShop',
        'shop_phone': '+255 000 000 000',
        'shop_address': 'Dar es Salaam, Tanzania',
        'receipt_footer': 'Asante kwa biashara yako!',
        'vat_default': '0',
        'currency': 'Tsh',
        'low_stock_multiplier': '1.5',
        'language': 'sw',
        'timezone': 'Africa/Dar_es_Salaam',
        'setup_done': '0',
        'header_title': 'MotoShop',
        'header_subtitle': 'Mfumo wa Usimamizi',
        'header_icon': '🏍️',
        'logo_image': '',
    }
    for k, v in defaults.items():
        db.execute("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", (k, v))

    # Default categories
    cats = ['Mafuta','Breki','Tairi','Betri','Vipande vya Injini','Vichujio','Waya','Transmission','Umeme','Mengineyo']
    for c in cats:
        db.execute("INSERT OR IGNORE INTO categories (name) VALUES (?)", (c,))

    db.commit()

    # ── Schema migrations (run on every startup, safe via try/except) ──
    # Migration 001: store buying price at time of sale so COGS is always
    # historically accurate even if buying_price is later edited on a product.
    migrations = [
        "ALTER TABLE sale_items ADD COLUMN buying_price_at_sale REAL NOT NULL DEFAULT 0",
        # Migration 002: optional expiry timestamp for a cashier account. NULL means
        # the account stays active indefinitely (permanent) once enabled. When set,
        # login is blocked once the current time passes this timestamp, so the
        # owner no longer needs to manually re-enable the account every day.
        "ALTER TABLE users ADD COLUMN active_until TEXT",
    ]
    for sql in migrations:
        try:
            db.execute(sql)
            db.commit()
        except Exception:
            pass  # Column already exists — safe to ignore

    # Migration 003: allow role='superuser'. SQLite can't ALTER a CHECK
    # constraint in place, so an existing 'users' table (created before this
    # feature existed) has to be rebuilt: rename it aside, create the new
    # table with the wider CHECK, copy every row across using whatever
    # columns the OLD table actually had (so this is safe regardless of
    # which of the migrations above have already run on this database),
    # then drop the old copy. Skipped entirely once already migrated.
    row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
    if row and 'superuser' not in row[0]:
        try:
            old_cols = [r[1] for r in db.execute("PRAGMA table_info(users)").fetchall()]
            col_list = ", ".join(old_cols)
            # IMPORTANT: SQLite unconditionally rewrites every OTHER table's
            # FK definitions (audit_log.user_id, sales.sold_by, shifts.
            # cashier_id, etc.) to follow a table whenever THAT table is the
            # target of RENAME TO — this is not gated by any pragma
            # (foreign_keys / legacy_alter_table do NOT prevent it, tested).
            # So we never rename 'users' itself. Instead: build the new
            # schema under a throwaway name, DROP the old 'users' (a DROP
            # triggers no such rewrite), then rename the throwaway table
            # INTO the name 'users' — at that point no other table
            # references the throwaway name, so nothing gets touched, and
            # every existing "REFERENCES users(id)" text starts resolving
            # to the new table simply because a table with that name exists
            # again.
            db.execute("PRAGMA foreign_keys=OFF")
            db.execute("""
                CREATE TABLE users_superuser_migration_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('owner','cashier','superuser')),
                    is_active INTEGER NOT NULL DEFAULT 1,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    locked_until TEXT,
                    active_until TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            db.execute(f"INSERT INTO users_superuser_migration_new ({col_list}) SELECT {col_list} FROM users")
            db.execute("DROP TABLE users")
            db.execute("ALTER TABLE users_superuser_migration_new RENAME TO users")
            db.commit()
            fk_problems = db.execute("PRAGMA foreign_key_check").fetchall()
            db.execute("PRAGMA foreign_keys=ON")
            if fk_problems:
                raise RuntimeError(f"Post-migration FK check found issues: {fk_problems}")
        except Exception:
            db.rollback()
            db.execute("PRAGMA foreign_keys=ON")

    # ── Superuser bootstrap ──────────────────────────────────────────────
    # The superuser ("Creator") account is NEVER created through any UI or
    # API — only ever provisioned from SUPERUSER_USERNAME/SUPERUSER_PASSWORD
    # environment variables, kept in sync on every startup. Forgot the
    # password? Change the env var on Render and redeploy — no DB surgery
    # needed. Leave both unset and no superuser account exists at all.
    su_user = os.environ.get('SUPERUSER_USERNAME')
    su_pass = os.environ.get('SUPERUSER_PASSWORD')
    if su_user and su_pass:
        su_user = su_user.strip().lower()
        pw_hash = hash_password(su_pass)
        existing_su = db.execute("SELECT id FROM users WHERE role='superuser' LIMIT 1").fetchone()
        if existing_su:
            db.execute("UPDATE users SET username=?, password_hash=?, is_active=1, failed_attempts=0, locked_until=NULL WHERE id=?",
                       (su_user, pw_hash, existing_su[0]))
        else:
            clash = db.execute("SELECT id FROM users WHERE LOWER(username)=?", (su_user,)).fetchone()
            if clash:
                db.execute("UPDATE users SET role='superuser', password_hash=?, is_active=1 WHERE id=?", (pw_hash, clash[0]))
            else:
                db.execute("INSERT INTO users (username, password_hash, role, is_active) VALUES (?,?,?,1)", (su_user, pw_hash, 'superuser'))
        db.commit()

    # ── System tables for the superuser control panel ───────────────────
    db.executescript("""
        CREATE TABLE IF NOT EXISTS _admin_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    db.execute("INSERT OR IGNORE INTO _admin_flags (key, value) VALUES ('maintenance_mode', '0')")
    db.execute("INSERT OR IGNORE INTO _admin_flags (key, value) VALUES ('maintenance_message', 'Mfumo uko chini kwa muda kwa ajili ya matengenezo. Tutarudi hivi karibuni.')")
    db.execute("INSERT OR IGNORE INTO _admin_flags (key, value) VALUES ('feature_flags', '{}')")
    db.commit()

    db.close()

# ── Routes ────────────────────────────────────────────────────────────────

@app.route('/api/setup/status', methods=['GET'])
def setup_status():
    db = sqlite3.connect(app.config['DATABASE'])
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT value FROM settings WHERE key='setup_done'").fetchone()
    db.close()
    return jsonify({'setup_done': row and row['value'] == '1'})

@app.route('/api/setup', methods=['POST'])
def setup():
    data = request.json or {}
    required = ['shop_name','shop_phone','shop_address','owner_password','cashier_name','cashier_password']
    for f in required:
        if not data.get(f):
            return jsonify({'error': f'Missing: {f}'}), 400

    db = get_db()
    row = db.execute("SELECT value FROM settings WHERE key='setup_done'").fetchone()
    if row and row['value'] == '1':
        return jsonify({'error': 'Already set up'}), 400

    settings_map = {
        'shop_name': data['shop_name'],
        'shop_phone': data['shop_phone'],
        'shop_address': data['shop_address'],
        'receipt_footer': data.get('receipt_footer', 'Asante kwa biashara yako!'),
        'header_title': data['shop_name'],
        'header_subtitle': 'Mfumo wa Usimamizi',
        'header_icon': '🏍️',
    }
    for k, v in settings_map.items():
        db.execute("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", (k, v))

    db.execute("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)",
               ('owner', hash_password(data['owner_password']), 'owner'))
    db.execute("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)",
               (data['cashier_name'], hash_password(data['cashier_password']), 'cashier'))
    db.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('setup_done','1')")
    db.commit()
    return jsonify({'ok': True})

# Auth
@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json or {}
    username = data.get('username', '').strip().lower()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400

    user = query_db("SELECT * FROM users WHERE LOWER(username)=?", (username,), one=True)
    if not user:
        return jsonify({'error': 'Invalid credentials'}), 401

    if not user['is_active']:
        return jsonify({'error': 'Account disabled'}), 403

    active_until = user['active_until']
    if active_until:
        expiry = datetime.datetime.fromisoformat(active_until)
        if datetime.datetime.utcnow() >= expiry:
            # Auto-expire: flip is_active off so the owner sees an accurate
            # status on the Settings page instead of a silently-expired date.
            exec_db("UPDATE users SET is_active=0, active_until=NULL WHERE id=?", (user['id'],))
            return jsonify({'error': 'Account disabled'}), 403

    locked_until = user['locked_until']
    if locked_until:
        lock_time = datetime.datetime.fromisoformat(locked_until)
        if datetime.datetime.utcnow() < lock_time:
            remaining = int((lock_time - datetime.datetime.utcnow()).total_seconds() / 60)
            return jsonify({'error': f'Account locked. Try again in {remaining} minutes'}), 403
        else:
            exec_db("UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?", (user['id'],))

    if not verify_password(password, user['password_hash']):
        attempts = user['failed_attempts'] + 1
        if attempts >= 5:
            lock_until = (datetime.datetime.utcnow() + datetime.timedelta(minutes=15)).isoformat()
            exec_db("UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?", (attempts, lock_until, user['id']))
            return jsonify({'error': 'Too many attempts. Account locked for 15 minutes'}), 403
        exec_db("UPDATE users SET failed_attempts=? WHERE id=?", (attempts, user['id']))
        return jsonify({'error': f'Invalid credentials ({5-attempts} attempts left)'}), 401

    exec_db("UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?", (user['id'],))

    if user['role'] != 'superuser' and is_maintenance_mode():
        return jsonify({'error': get_admin_flag('maintenance_message', 'Mfumo uko chini kwa muda.'),
                         'maintenance': True}), 503

    token = make_token(user['id'], user['role'])
    exec_db("INSERT INTO audit_log (user_id,action) VALUES (?,?)", (user['id'], 'login'))
    return jsonify({
        'token': token,
        'role': user['role'],
        'username': user['username'],
        'user_id': user['id']
    })

@app.route('/api/auth/change-password', methods=['POST'])
@require_auth
def change_password():
    data = request.json or {}
    if not data.get('old_password') or not data.get('new_password'):
        return jsonify({'error': 'Old and new password required'}), 400
    user = query_db("SELECT * FROM users WHERE id=?", (g.user_id,), one=True)
    if not verify_password(data['old_password'], user['password_hash']):
        return jsonify({'error': 'Incorrect current password'}), 400
    exec_db("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data['new_password']), g.user_id))
    return jsonify({'ok': True})

@app.route('/api/auth/reset-cashier-password', methods=['POST'])
@require_owner
def reset_cashier_password():
    data = request.json or {}
    new_pw = data.get('new_password', '')
    if not new_pw or len(new_pw) < 4:
        return jsonify({'error': 'Password too short'}), 400
    cashier_id = data.get('cashier_id')
    if cashier_id:
        cashier = query_db("SELECT id FROM users WHERE id=? AND role='cashier'", (cashier_id,), one=True)
    else:
        cashier = query_db("SELECT id FROM users WHERE role='cashier' ORDER BY id LIMIT 1", one=True)
    if not cashier:
        return jsonify({'error': 'No cashier found'}), 404
    exec_db("UPDATE users SET password_hash=?, failed_attempts=0, locked_until=NULL WHERE id=?",
            (hash_password(new_pw), cashier['id']))
    return jsonify({'ok': True})

def _get_cashier(cashier_id=None):
    if cashier_id:
        return query_db("SELECT id, username FROM users WHERE id=? AND role='cashier'", (cashier_id,), one=True)
    return query_db("SELECT id, username FROM users WHERE role='cashier' ORDER BY id LIMIT 1", one=True)

@app.route('/api/auth/cashier-username', methods=['PUT'])
@require_owner
def set_cashier_username():
    # Owner has full authority to rename the cashier's login — this
    # overrides whatever the cashier last set for themselves. Handy when a
    # cashier changes their own username and the owner needs it back to
    # something known, or wants a fresh one issued.
    data = request.json or {}
    new_username = (data.get('username') or '').strip().lower()
    if len(new_username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    if not new_username.replace('_','').replace('.','').isalnum():
        return jsonify({'error': 'Username can only contain letters, numbers, _ and .'}), 400
    cashier = _get_cashier(data.get('cashier_id'))
    if not cashier:
        return jsonify({'error': 'No cashier found'}), 404
    clash = query_db("SELECT id FROM users WHERE LOWER(username)=? AND id != ?", (new_username, cashier['id']), one=True)
    if clash:
        return jsonify({'error': 'Username already in use'}), 409
    exec_db("UPDATE users SET username=? WHERE id=?", (new_username, cashier['id']))
    return jsonify({'ok': True, 'username': new_username})

@app.route('/api/auth/cashier-reset-default', methods=['POST'])
@require_owner
def cashier_reset_default():
    # One-click "restore control" — regardless of what the cashier changed
    # their username/password to, this issues a brand-new known username +
    # a freshly generated password and returns them ONCE so the owner can
    # hand them to the cashier. Also clears any lockout state.
    data = request.json or {}
    cashier = _get_cashier(data.get('cashier_id'))
    if not cashier:
        return jsonify({'error': 'No cashier found'}), 404
    base = 'cashier'
    candidate = base
    n = 1
    while query_db("SELECT id FROM users WHERE LOWER(username)=? AND id != ?", (candidate, cashier['id']), one=True):
        n += 1
        candidate = f"{base}{n}"
    new_password = secrets.token_hex(3)  # short, easy to read aloud: e.g. "a1b2c3"
    exec_db("UPDATE users SET username=?, password_hash=?, failed_attempts=0, locked_until=NULL WHERE id=?",
            (candidate, hash_password(new_password), cashier['id']))
    return jsonify({'ok': True, 'username': candidate, 'password': new_password})

@app.route('/api/auth/cashier-status', methods=['GET', 'PUT'])
@require_owner
def cashier_status():
    cashier_id = request.args.get('cashier_id') or (request.get_json(silent=True) or {}).get('cashier_id')
    if cashier_id:
        cashier = query_db("SELECT id,username,is_active,active_until FROM users WHERE id=? AND role='cashier'", (cashier_id,), one=True)
    else:
        cashier = query_db("SELECT id,username,is_active,active_until FROM users WHERE role='cashier' ORDER BY id LIMIT 1", one=True)
    if not cashier:
        return jsonify({'error': 'No cashier'}), 404
    if request.method == 'PUT':
        data = request.json or {}
        status = 1 if data.get('is_active') else 0
        active_until = None
        if status:
            # days: None/0 -> permanent (active_until stays NULL).
            # days: positive int -> account auto-disables after that many days.
            days = data.get('days')
            if days:
                try:
                    days = int(days)
                except (TypeError, ValueError):
                    days = None
                if days and days > 0:
                    active_until = (datetime.datetime.utcnow() + datetime.timedelta(days=days)).isoformat()
        exec_db("UPDATE users SET is_active=?, active_until=? WHERE id=?", (status, active_until, cashier['id']))
        return jsonify({'ok': True, 'is_active': bool(status), 'active_until': active_until})
    return jsonify({'is_active': bool(cashier['is_active']), 'active_until': cashier['active_until'],
                     'id': cashier['id'], 'username': cashier['username']})

# Settings
@app.route('/api/settings', methods=['GET', 'PUT'])
@require_auth
def settings():
    if request.method == 'GET':
        rows = query_db("SELECT key,value FROM settings")
        return jsonify({r['key']: r['value'] for r in rows})
    if g.role not in ('owner', 'superuser'):
        return jsonify({'error': 'Owner only'}), 403
    data = request.json or {}
    allowed = ['shop_name','shop_phone','shop_address','receipt_footer','vat_default',
               'currency','low_stock_multiplier','language','timezone',
               'header_title','header_subtitle','header_icon','logo_image',
               'cashier_pinned_message']
    for k in allowed:
        if k in data:
            exec_db("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", (k, str(data[k])))
    push_event('settings_updated', {})
    return jsonify({'ok': True})

@app.route('/api/settings/backup', methods=['GET'])
@require_owner
def backup():
    from flask import send_file
    return send_file(app.config['DATABASE'], as_attachment=True,
                     download_name=f"motoshop_backup_{datetime.date.today()}.db")

# Categories
@app.route('/api/categories', methods=['GET', 'POST'])
@require_auth
def categories():
    if request.method == 'GET':
        rows = query_db("SELECT * FROM categories ORDER BY name")
        return jsonify(rows_to_list(rows))
    if g.role not in ('owner', 'superuser'):
        return jsonify({'error': 'Owner only'}), 403
    data = request.json or {}
    if not data.get('name'):
        return jsonify({'error': 'Name required'}), 400
    try:
        cid = exec_db("INSERT INTO categories (name) VALUES (?)", (data['name'].strip(),))
        return jsonify({'id': cid, 'name': data['name'].strip()})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Category already exists'}), 409

@app.route('/api/categories/<int:cid>', methods=['PUT', 'DELETE'])
@require_owner
def category_detail(cid):
    if request.method == 'DELETE':
        used = query_db("SELECT COUNT(*) as c FROM products WHERE category_id=?", (cid,), one=True)
        if used['c'] > 0:
            return jsonify({'error': 'Category in use'}), 409
        exec_db("DELETE FROM categories WHERE id=?", (cid,))
        return jsonify({'ok': True})
    data = request.json or {}
    exec_db("UPDATE categories SET name=? WHERE id=?", (data.get('name','').strip(), cid))
    return jsonify({'ok': True})

# Products
@app.route('/api/products', methods=['GET', 'POST'])
@require_auth
def products():
    if request.method == 'GET':
        active_only = request.args.get('active_only', '1')
        sql = """
            SELECT p.*, c.name as category_name,
                   (p.current_stock < p.min_stock * (SELECT CAST(value AS REAL) FROM settings WHERE key='low_stock_multiplier')) as low_stock
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
        """
        conditions = []
        if active_only == '1':
            conditions.append("p.is_active=1")
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY p.name"
        rows = query_db(sql)
        return jsonify(strip_cost_fields(rows_to_list(rows), g.role))

    if g.role not in ('owner', 'superuser'):
        return jsonify({'error': 'Owner only'}), 403
    data = request.json or {}
    required = ['name', 'selling_price']
    for f in required:
        if data.get(f) is None:
            return jsonify({'error': f'Missing: {f}'}), 400

    prefix = ''.join(c for c in data['name'] if c.isalpha()).upper()[:3] or 'PRD'
    existing = query_db("SELECT COUNT(*) as c FROM products WHERE sku LIKE ?", (f"{prefix}%",), one=True)
    sku = data.get('sku') or f"{prefix}-{existing['c']+1:04d}"

    pid = exec_db("""
        INSERT INTO products (name,sku,category_id,buying_price,selling_price,
            min_stock,unit_type,allow_decimal,shelf_location,moto_compat,notes,is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
    """, (
        data['name'].strip(), sku,
        data.get('category_id'), data.get('buying_price', 0),
        data['selling_price'], data.get('min_stock', 0),
        data.get('unit_type', 'Piece'), 1 if data.get('allow_decimal') else 0,
        data.get('shelf_location'), data.get('moto_compat'), data.get('notes')
    ))
    push_event('product_created', {'id': pid})
    return jsonify({'id': pid, 'sku': sku})

@app.route('/api/products/<int:pid>', methods=['GET', 'PUT', 'DELETE'])
@require_auth
def product_detail(pid):
    if request.method == 'GET':
        row = query_db("SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?", (pid,), one=True)
        if not row:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(strip_cost_fields(dict(row), g.role))

    if g.role not in ('owner', 'superuser'):
        return jsonify({'error': 'Owner only'}), 403

    if request.method == 'DELETE':
        used = query_db("SELECT COUNT(*) as c FROM sale_items WHERE product_id=?", (pid,), one=True)
        if used['c'] > 0:
            return jsonify({'error': 'Cannot delete — product has sales history. Deactivate instead.'}), 409
        exec_db("DELETE FROM products WHERE id=?", (pid,))
        push_event('product_deleted', {'id': pid})
        return jsonify({'ok': True})

    data = request.json or {}
    exec_db("""
        UPDATE products SET name=?,category_id=?,buying_price=?,selling_price=?,
            min_stock=?,unit_type=?,allow_decimal=?,shelf_location=?,moto_compat=?,
            notes=?,is_active=? WHERE id=?
    """, (
        data.get('name'), data.get('category_id'), data.get('buying_price', 0),
        data.get('selling_price', 0), data.get('min_stock', 0),
        data.get('unit_type', 'Piece'), 1 if data.get('allow_decimal') else 0,
        data.get('shelf_location'), data.get('moto_compat'), data.get('notes'),
        1 if data.get('is_active', True) else 0, pid
    ))
    push_event('product_updated', {'id': pid})
    return jsonify({'ok': True})

@app.route('/api/products/<int:pid>/receive', methods=['POST'])
@require_owner
def receive_stock(pid):
    data = request.json or {}
    qty = float(data.get('qty', 0))
    cost = float(data.get('cost_per_unit', 0))
    if qty <= 0:
        return jsonify({'error': 'Quantity must be positive'}), 400
    exec_db("UPDATE products SET current_stock=current_stock+? WHERE id=?", (qty, pid))
    exec_db("""INSERT INTO stock_movements (product_id,type,qty_change,cost_per_unit,note,created_by)
               VALUES (?,?,?,?,?,?)""", (pid, 'receive', qty, cost, data.get('note'), g.user_id))
    push_event('stock_updated', {'product_id': pid})
    return jsonify({'ok': True})

@app.route('/api/products/<int:pid>/adjust', methods=['POST'])
@require_owner
def adjust_stock(pid):
    data = request.json or {}
    change = float(data.get('qty_change', 0))
    reason = data.get('reason', 'Correction')
    if change == 0:
        return jsonify({'error': 'Change cannot be zero'}), 400
    product = query_db("SELECT current_stock FROM products WHERE id=?", (pid,), one=True)
    if not product:
        return jsonify({'error': 'Not found'}), 404
    new_stock = product['current_stock'] + change
    if new_stock < 0:
        return jsonify({'error': 'Stock cannot go below zero'}), 400
    exec_db("UPDATE products SET current_stock=? WHERE id=?", (new_stock, pid))
    exec_db("""INSERT INTO stock_movements (product_id,type,qty_change,reason,created_by)
               VALUES (?,?,?,?,?)""", (pid, 'adjustment', change, reason, g.user_id))
    push_event('stock_updated', {'product_id': pid})
    return jsonify({'ok': True, 'new_stock': new_stock})

@app.route('/api/products/<int:pid>/movements', methods=['GET'])
@require_auth
def stock_movements(pid):
    rows = query_db("""
        SELECT sm.*, u.username FROM stock_movements sm
        LEFT JOIN users u ON u.id=sm.created_by
        WHERE sm.product_id=? ORDER BY sm.created_at DESC LIMIT 100
    """, (pid,))
    return jsonify(strip_cost_fields(rows_to_list(rows), g.role))

# Real-time stock endpoint (for StockPage)
@app.route('/api/stock/realtime', methods=['GET'])
@require_auth
def stock_realtime():
    multiplier = float(query_db("SELECT value FROM settings WHERE key='low_stock_multiplier'", one=True)['value'])
    rows = query_db("""
        SELECT p.id, p.name, p.sku, p.current_stock, p.min_stock, p.buying_price, p.selling_price,
               p.unit_type, c.name as category_name,
               (p.current_stock < p.min_stock * ?) as low_stock,
               (p.current_stock * p.selling_price) as stock_value
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active=1
        ORDER BY p.current_stock ASC
    """, (multiplier,))
    data = rows_to_list(rows)
    total_value = sum(r['stock_value'] for r in data)
    low_stock_items = [r for r in data if r['low_stock']]
    out_of_stock = [r for r in data if r['current_stock'] <= 0]
    data = strip_cost_fields(data, g.role)
    summary = {
        'total_products': len(data),
        'low_stock_count': len(low_stock_items),
        'out_of_stock_count': len(out_of_stock),
    }
    if g.role == 'owner':
        summary['total_value'] = total_value
    return jsonify({
        'products': data,
        'summary': summary,
        'generated_at': datetime.datetime.utcnow().isoformat()
    })

# Shifts
@app.route('/api/shifts/current', methods=['GET'])
@require_auth
def current_shift():
    if g.role == 'cashier':
        row = query_db("""SELECT s.*,u.username as cashier_name FROM shifts s
                          JOIN users u ON u.id=s.cashier_id
                          WHERE s.cashier_id=? AND s.status='open'
                          ORDER BY s.opened_at DESC LIMIT 1""", (g.user_id,), one=True)
    else:
        row = query_db("""SELECT s.*,u.username as cashier_name FROM shifts s
                          JOIN users u ON u.id=s.cashier_id
                          WHERE s.status='open'
                          ORDER BY s.opened_at DESC LIMIT 1""", one=True)
    return jsonify(dict(row) if row else None)

@app.route('/api/shifts/open', methods=['POST'])
@require_auth
def open_shift():
    existing = query_db("SELECT id FROM shifts WHERE cashier_id=? AND status='open'", (g.user_id,), one=True)
    if existing:
        return jsonify({'error': 'Shift already open'}), 409
    data = request.json or {}
    sid = exec_db("INSERT INTO shifts (cashier_id,opening_cash) VALUES (?,?)",
                  (g.user_id, float(data.get('opening_cash', 0))))
    push_event('shift_opened', {'shift_id': sid, 'cashier_id': g.user_id})
    return jsonify({'id': sid})

@app.route('/api/shifts/close', methods=['POST'])
@require_auth
def close_shift():
    shift = query_db("SELECT * FROM shifts WHERE cashier_id=? AND status='open'", (g.user_id,), one=True)
    if not shift:
        return jsonify({'error': 'No open shift'}), 404
    data = request.json or {}
    actual = float(data.get('closing_cash', 0))
    # Expected cash = opening float + cash received - change given out
    cash_sales = query_db("""SELECT COALESCE(SUM(amount_paid),0) as received,
                                     COALESCE(SUM(change_given),0) as given_back
                              FROM sales
                              WHERE shift_id=? AND payment_method='cash' AND status='completed'""",
                          (shift['id'],), one=True)
    expected = shift['opening_cash'] + cash_sales['received'] - cash_sales['given_back']
    variance = actual - expected
    exec_db("""UPDATE shifts SET status='closed',closed_at=datetime('now'),
               closing_cash_actual=?,closing_cash_expected=?,variance=? WHERE id=?""",
            (actual, expected, variance, shift['id']))
    push_event('shift_closed', {'shift_id': shift['id']})
    return jsonify({'ok': True, 'variance': variance, 'expected': expected})

@app.route('/api/shifts', methods=['GET'])
@require_owner
def all_shifts():
    rows = query_db("""SELECT s.*,u.username as cashier_name FROM shifts s
                       JOIN users u ON u.id=s.cashier_id
                       ORDER BY s.opened_at DESC LIMIT 50""")
    return jsonify(rows_to_list(rows))

# Sales / POS
def next_receipt_no(db):
    db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('receipt_seq', '0')")
    db.execute("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'receipt_seq'")
    row = db.execute("SELECT value FROM settings WHERE key='receipt_seq'").fetchone()
    return f"RCP-{int(row['value']):05d}"

@app.route('/api/sales', methods=['GET', 'POST'])
@require_auth
def sales():
    if request.method == 'GET':
        date_from = request.args.get('from', '')
        date_to = request.args.get('to', '')
        method = request.args.get('method', '')
        customer = request.args.get('customer', '')
        limit = min(int(request.args.get('limit', 200)), 500)

        conditions = []
        args = []
        if g.role == 'cashier':
            conditions.append("s.sold_by=?")
            args.append(g.user_id)
        if date_from:
            conditions.append("DATE(s.created_at)>=?"); args.append(date_from)
        if date_to:
            conditions.append("DATE(s.created_at)<=?"); args.append(date_to)
        if method:
            conditions.append("s.payment_method=?"); args.append(method)
        if customer:
            conditions.append("s.customer_name LIKE ?"); args.append(f"%{customer}%")

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        # Return sold_by_name (cashier name) AND owner name for display
        sql = f"""SELECT s.*, u.username as sold_by_name,
                  (SELECT username FROM users WHERE role='owner' LIMIT 1) as owner_name,
                  (SELECT GROUP_CONCAT(si2.product_name, ', ') FROM sale_items si2 WHERE si2.sale_id=s.id LIMIT 3) as product_names
                  FROM sales s
                  JOIN users u ON u.id=s.sold_by {where}
                  ORDER BY s.created_at DESC LIMIT {limit}"""
        rows = query_db(sql, args)
        return jsonify(rows_to_list(rows))

    # POST — create sale
    data = request.json or {}
    items = data.get('items', [])
    if not items:
        return jsonify({'error': 'No items'}), 400

    order_disc = float(data.get('discount_pct', 0))
    if g.role == 'cashier' and order_disc > 0:
        return jsonify({'error': 'Cashiers cannot apply order discounts'}), 403

    is_credit = bool(data.get('is_credit'))
    if is_credit and g.role == 'cashier':
        return jsonify({'error': 'Cashiers cannot create credit sales'}), 403
    if is_credit and data.get('customer_type', 'walk-in') == 'walk-in':
        return jsonify({'error': 'Credit requires named customer'}), 400

    payment_method = data.get('payment_method', 'cash')
    # Credit payment method handling
    if payment_method == 'credit':
        is_credit = True
        if data.get('customer_type', 'walk-in') == 'walk-in':
            return jsonify({'error': 'Credit requires named customer'}), 400
        if not data.get('customer_name'):
            return jsonify({'error': 'Customer name required for credit'}), 400

    vat_pct = float(data.get('vat_pct', 0))
    if g.role == 'cashier':
        settings_row = query_db("SELECT value FROM settings WHERE key='vat_default'", one=True)
        vat_pct = float(settings_row['value']) if settings_row else 0

    shift = query_db("SELECT id FROM shifts WHERE cashier_id=? AND status='open'", (g.user_id,), one=True)
    # FIX: a sale must always be tied to an open shift — without one there's
    # no till to reconcile against at end of day. Reject up front rather
    # than silently recording the sale with shift_id=NULL.
    if not shift:
        return jsonify({'error': 'Lazima ufungue zamu (shift) kabla ya kuuza / You must open a shift before making a sale'}), 400

    db = get_db()

    subtotal = 0
    processed_items = []
    for item in items:
        p = db.execute(
            "SELECT * FROM products WHERE id=? AND is_active=1", (item['product_id'],)
        ).fetchone()
        if not p:
            return jsonify({'error': f"Product {item['product_id']} not found"}), 400
        qty = float(item['qty'])
        if p['current_stock'] < qty:
            return jsonify({'error': f"Insufficient stock for {p['name']}"}), 400
        unit_price = float(p['selling_price'])
        disc_pct = float(item.get('discount_pct', 0))
        if g.role == 'cashier' and disc_pct > 10:
            disc_pct = 10
        if g.role == 'owner' and disc_pct > 50:
            disc_pct = 50
        line_total = qty * unit_price * (1 - disc_pct / 100)
        subtotal += line_total
        processed_items.append({**item, 'product_name': p['name'], 'unit_price': unit_price,
                                 'qty': qty, 'disc_pct': disc_pct, 'line_total': line_total,
                                 'buying_price': float(p['buying_price'])})

    disc_amt = subtotal * order_disc / 100
    after_disc = subtotal - disc_amt
    vat_amt = after_disc * vat_pct / 100
    total = after_disc + vat_amt

    if is_credit:
        amount_paid = 0.0
        change_given = 0.0
    else:
        amount_paid = float(data.get('amount_paid', total))
        change_given = max(0.0, amount_paid - total)

    receipt_no = next_receipt_no(db)

    cur = db.execute("""
        INSERT INTO sales (receipt_no,shift_id,sold_by,customer_name,customer_phone,customer_type,
            subtotal,discount_pct,discount_amt,vat_pct,vat_amt,total,payment_method,
            payment_ref,amount_paid,change_given,is_credit)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        receipt_no, shift['id'] if shift else None, g.user_id,
        data.get('customer_name'), data.get('customer_phone'),
        data.get('customer_type', 'walk-in'),
        subtotal, order_disc, disc_amt, vat_pct, vat_amt, total,
        payment_method, data.get('payment_ref'),
        amount_paid, change_given,
        1 if is_credit else 0
    ))
    sale_id = cur.lastrowid

    for item in processed_items:
        db.execute("""INSERT INTO sale_items (sale_id,product_id,product_name,qty,unit_price,discount_pct,line_total,buying_price_at_sale)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (sale_id, item['product_id'], item['product_name'],
                 item['qty'], item['unit_price'], item['disc_pct'], item['line_total'],
                 item['buying_price']))
        db.execute("UPDATE products SET current_stock=current_stock-? WHERE id=?",
                (item['qty'], item['product_id']))
        db.execute("""INSERT INTO stock_movements (product_id,type,qty_change,reference,created_by)
                   VALUES (?,?,?,?,?)""",
                (item['product_id'], 'sale', -item['qty'], receipt_no, g.user_id))

    if is_credit:
        db.execute("""INSERT INTO debts (sale_id,customer_name,customer_phone,original_amount,remaining)
                   VALUES (?,?,?,?,?)""",
                (sale_id, data.get('customer_name'), data.get('customer_phone'), total, total))

    db.commit()
    # Detect items sold below buying price — use buying_price captured at sale time (no extra DB query)
    below_price_items = []
    for item in processed_items:
        eff_price = item['unit_price'] * (1 - item['disc_pct'] / 100)
        if eff_price < item['buying_price']:
            below_price_items.append({
                'name': item['product_name'],
                'selling_price': round(eff_price, 2),
                'buying_price': round(item['buying_price'], 2),
            })
    push_event('sale_created', {
        'sale_id': sale_id, 'total': total, 'receipt_no': receipt_no,
        'sold_by': g.user_id,
        'below_price_items': below_price_items,
    })
    sale_time = db.execute("SELECT created_at FROM sales WHERE id=?", (sale_id,)).fetchone()
    return jsonify({'sale_id': sale_id, 'receipt_no': receipt_no, 'total': total, 'change': change_given,
                    'created_at': sale_time['created_at'] if sale_time else None})

@app.route('/api/sales/<int:sid>', methods=['GET'])
@require_auth
def sale_detail(sid):
    sale = query_db("""SELECT s.*, u.username as sold_by_name,
                       (SELECT username FROM users WHERE role='owner' LIMIT 1) as owner_name
                       FROM sales s JOIN users u ON u.id=s.sold_by WHERE s.id=?""", (sid,), one=True)
    if not sale:
        return jsonify({'error': 'Not found'}), 404
    items = query_db("SELECT * FROM sale_items WHERE sale_id=?", (sid,))
    result = dict(sale)
    result['items'] = rows_to_list(items)
    return jsonify(result)

@app.route('/api/sales/<int:sid>/cancel', methods=['POST'])
@require_owner
def cancel_sale(sid):
    sale = query_db("SELECT * FROM sales WHERE id=?", (sid,), one=True)
    if not sale:
        return jsonify({'error': 'Not found'}), 404
    if sale['status'] == 'cancelled':
        return jsonify({'error': 'Already cancelled'}), 409
    items = query_db("SELECT * FROM sale_items WHERE sale_id=?", (sid,))
    db = get_db()
    try:
        for item in items:
            db.execute("UPDATE products SET current_stock=current_stock+? WHERE id=?",
                       (item['qty'], item['product_id']))
            db.execute("""INSERT INTO stock_movements (product_id,type,qty_change,reference,created_by)
                          VALUES (?,?,?,?,?)""",
                       (item['product_id'], 'cancellation', item['qty'], sale['receipt_no'], g.user_id))
        if sale['is_credit']:
            db.execute("UPDATE debts SET status='cancelled' WHERE sale_id=?", (sid,))
        db.execute("UPDATE sales SET status='cancelled',cancelled_at=datetime('now'),cancelled_by=? WHERE id=?",
                   (g.user_id, sid))
        db.commit()
    except Exception as e:
        db.rollback()
        return jsonify({'error': 'Cancellation failed: ' + str(e)}), 500
    push_event('sale_cancelled', {'sale_id': sid})
    return jsonify({'ok': True})

# Debts
@app.route('/api/debts', methods=['GET'])
@require_owner
def debts():
    status = request.args.get('status', '')
    customer = request.args.get('customer', '')
    conditions = ["d.status != 'cancelled'"]
    args = []
    if status:
        conditions.append("d.status=?"); args.append(status)
    if customer:
        conditions.append("d.customer_name LIKE ?"); args.append(f"%{customer}%")
    where = "WHERE " + " AND ".join(conditions)
    rows = query_db(f"""
        SELECT d.*, s.receipt_no,
            CAST(julianday('now') - julianday(d.created_at) AS INTEGER) as days_overdue
        FROM debts d JOIN sales s ON s.id=d.sale_id {where}
        ORDER BY d.created_at DESC
    """, args)
    return jsonify(rows_to_list(rows))

@app.route('/api/debts/<int:did>/pay', methods=['POST'])
@require_owner
def pay_debt(did):
    debt = query_db("SELECT * FROM debts WHERE id=?", (did,), one=True)
    if not debt:
        return jsonify({'error': 'Not found'}), 404
    if debt['status'] in ('paid', 'cancelled'):
        return jsonify({'error': f"Debt is {debt['status']}"}), 409
    data = request.json or {}
    amount = float(data.get('amount', 0))
    if amount <= 0:
        return jsonify({'error': 'Amount must be positive'}), 400
    if amount > debt['remaining']:
        amount = debt['remaining']
    exec_db("""INSERT INTO debt_payments (debt_id,amount,payment_method,reference,note,paid_by)
               VALUES (?,?,?,?,?,?)""",
            (did, amount, data.get('payment_method','cash'), data.get('reference'), data.get('note'), g.user_id))
    new_paid = debt['paid_amount'] + amount
    new_remaining = debt['original_amount'] - new_paid
    new_status = 'paid' if new_remaining <= 0 else 'partial'
    exec_db("UPDATE debts SET paid_amount=?,remaining=?,status=?,updated_at=datetime('now') WHERE id=?",
            (new_paid, max(0, new_remaining), new_status, did))
    push_event('debt_paid', {'debt_id': did})
    return jsonify({'ok': True, 'new_remaining': max(0, new_remaining), 'status': new_status})

# Expenses
@app.route('/api/expenses', methods=['GET', 'POST'])
@require_owner
def expenses():
    if request.method == 'GET':
        date_from = request.args.get('from', '')
        date_to = request.args.get('to', '')
        category = request.args.get('category', '')
        conditions = []
        args = []
        if date_from:
            conditions.append("expense_date>=?"); args.append(date_from)
        if date_to:
            conditions.append("expense_date<=?"); args.append(date_to)
        if category:
            conditions.append("category=?"); args.append(category)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        rows = query_db(f"SELECT * FROM expenses {where} ORDER BY expense_date DESC,created_at DESC", args)
        return jsonify(rows_to_list(rows))
    data = request.json or {}
    if not data.get('amount') or not data.get('category') or not data.get('expense_date'):
        return jsonify({'error': 'Amount, category, and date required'}), 400
    eid = exec_db("""INSERT INTO expenses (amount,category,description,expense_date,payment_method,created_by)
                    VALUES (?,?,?,?,?,?)""",
                  (float(data['amount']), data['category'], data.get('description'),
                   data['expense_date'], data.get('payment_method','cash'), g.user_id))
    push_event('expense_created', {'expense_id': eid})
    return jsonify({'id': eid})

@app.route('/api/expenses/<int:eid>', methods=['PUT', 'DELETE'])
@require_owner
def expense_detail(eid):
    exp = query_db("SELECT * FROM expenses WHERE id=?", (eid,), one=True)
    if not exp:
        return jsonify({'error': 'Not found'}), 404
    today = datetime.date.today().isoformat()
    if exp['created_at'][:10] != today:
        return jsonify({'error': "Can only edit/delete today's expenses"}), 403
    if request.method == 'DELETE':
        exec_db("DELETE FROM expenses WHERE id=?", (eid,))
        return jsonify({'ok': True})
    data = request.json or {}
    exec_db("UPDATE expenses SET amount=?,category=?,description=?,expense_date=?,payment_method=? WHERE id=?",
            (float(data.get('amount',0)), data.get('category'), data.get('description'),
             data.get('expense_date'), data.get('payment_method','cash'), eid))
    return jsonify({'ok': True})

# Dashboard / Reports
@app.route('/api/dashboard', methods=['GET'])
@require_auth
def dashboard():
    today = datetime.date.today().isoformat()
    if g.role == 'owner':
        revenue = query_db("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE DATE(created_at)=? AND status='completed'", (today,), one=True)['t']
        cash_revenue = query_db("SELECT COALESCE(SUM(amount_paid),0) as t FROM sales WHERE DATE(created_at)=? AND status='completed' AND is_credit=0", (today,), one=True)['t']
        tx_count = query_db("SELECT COUNT(*) as c FROM sales WHERE DATE(created_at)=? AND status='completed'", (today,), one=True)['c']
        credit_count = query_db("SELECT COUNT(*) as c FROM sales WHERE DATE(created_at)=? AND status='completed' AND is_credit=1", (today,), one=True)['c']
        cogs = query_db("""SELECT COALESCE(SUM(si.qty * si.buying_price_at_sale),0) as c
                           FROM sale_items si JOIN sales s ON s.id=si.sale_id
                           WHERE DATE(s.created_at)=? AND s.status='completed'""", (today,), one=True)['c']
        expenses_today = query_db("SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE expense_date=?", (today,), one=True)['t']
        gross_profit = revenue - cogs
        net_profit = gross_profit - expenses_today
        debts_total = query_db("SELECT COALESCE(SUM(remaining),0) as t FROM debts WHERE status IN ('unpaid','partial')", one=True)['t']
        multiplier = float(query_db("SELECT value FROM settings WHERE key='low_stock_multiplier'", one=True)['value'])
        low_stock_count = query_db("SELECT COUNT(*) as c FROM products WHERE is_active=1 AND current_stock < min_stock * ?", (multiplier,), one=True)['c']
        top5 = query_db("""SELECT si.product_name, SUM(si.qty) as qty, SUM(si.line_total) as revenue
                           FROM sale_items si JOIN sales s ON s.id=si.sale_id
                           WHERE DATE(s.created_at)=? AND s.status='completed'
                           GROUP BY si.product_id ORDER BY revenue DESC LIMIT 5""", (today,))
        payment_breakdown = query_db("""SELECT payment_method, COUNT(*) as count, SUM(total) as total
                                        FROM sales WHERE DATE(created_at)=? AND status='completed'
                                        GROUP BY payment_method""", (today,))
        customers_total = query_db("SELECT COUNT(*) as c FROM sales WHERE status='completed'", one=True)['c']
        return jsonify({
            'revenue': revenue, 'cash_revenue': cash_revenue,
            'tx_count': tx_count, 'credit_count': credit_count, 'cogs': cogs,
            'gross_profit': gross_profit, 'expenses_today': expenses_today, 'net_profit': net_profit,
            'debts_total': debts_total, 'low_stock_count': low_stock_count,
            'top5': rows_to_list(top5), 'payment_breakdown': rows_to_list(payment_breakdown),
            'customers_total': customers_total
        })
    else:
        shift = query_db("SELECT * FROM shifts WHERE cashier_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1", (g.user_id,), one=True)
        if shift:
            revenue = query_db("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE shift_id=? AND status='completed'", (shift['id'],), one=True)['t']
            tx_count = query_db("SELECT COUNT(*) as c FROM sales WHERE shift_id=? AND status='completed'", (shift['id'],), one=True)['c']
        else:
            revenue, tx_count = 0, 0
        multiplier = float(query_db("SELECT value FROM settings WHERE key='low_stock_multiplier'", one=True)['value'])
        low_stock_count = query_db("SELECT COUNT(*) as c FROM products WHERE is_active=1 AND current_stock < min_stock * ?", (multiplier,), one=True)['c']
        return jsonify({
            'shift_status': 'open' if shift else 'closed',
            'shift_opened': shift['opened_at'] if shift else None,
            'revenue': revenue, 'tx_count': tx_count, 'low_stock_count': low_stock_count
        })

@app.route('/api/reports/pl', methods=['GET'])
@require_owner
def report_pl():
    date_from = request.args.get('from', datetime.date.today().replace(day=1).isoformat())
    date_to = request.args.get('to', datetime.date.today().isoformat())
    revenue = query_db("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'", (date_from, date_to), one=True)['t']
    cogs = query_db("""SELECT COALESCE(SUM(si.qty * si.buying_price_at_sale),0) as c
                       FROM sale_items si JOIN sales s ON s.id=si.sale_id
                       WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'""", (date_from, date_to), one=True)['c']
    expenses_by_cat = query_db("""SELECT category, SUM(amount) as total FROM expenses
                                   WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY category""", (date_from, date_to))
    total_expenses = sum(r['total'] for r in expenses_by_cat)
    gross = revenue - cogs
    net = gross - total_expenses
    return jsonify({
        'period': {'from': date_from, 'to': date_to},
        'revenue': revenue, 'cogs': cogs, 'gross_profit': gross,
        'expenses_by_category': rows_to_list(expenses_by_cat),
        'total_expenses': total_expenses, 'net_profit': net
    })

@app.route('/api/reports/stock-valuation', methods=['GET'])
@require_owner
def report_stock():
    rows = query_db("""SELECT p.name, p.sku, p.current_stock, p.buying_price, p.selling_price,
                              c.name as category,
                              p.current_stock * p.buying_price as cost_value,
                              p.current_stock * p.selling_price as sell_value,
                              (p.current_stock * p.selling_price) - (p.current_stock * p.buying_price) as potential_profit
                       FROM products p LEFT JOIN categories c ON c.id=p.category_id
                       WHERE p.is_active=1 ORDER BY p.name""")
    data = rows_to_list(rows)
    total_cost = sum(r['cost_value'] for r in data)
    total_sell = sum(r['sell_value'] for r in data)
    return jsonify({'items': data, 'total_cost': total_cost, 'total_sell': total_sell})

@app.route('/api/reports/debt-aging', methods=['GET'])
@require_owner
def report_debt_aging():
    rows = query_db("""
        SELECT d.customer_name, d.customer_phone, d.remaining, d.created_at,
               CAST(julianday('now') - julianday(d.created_at) AS INTEGER) as days_overdue
        FROM debts d WHERE d.status IN ('unpaid','partial') ORDER BY days_overdue DESC
    """)
    buckets = {'0_30': [], '31_60': [], '61_90': [], '91_plus': []}
    for r in rows:
        d = dict(r)
        days = d['days_overdue']
        if days <= 30:
            buckets['0_30'].append(d)
        elif days <= 60:
            buckets['31_60'].append(d)
        elif days <= 90:
            buckets['61_90'].append(d)
        else:
            buckets['91_plus'].append(d)
    return jsonify(buckets)

@app.route('/api/reports/sales-statement', methods=['GET'])
@require_owner
def report_sales():
    date_from = request.args.get('from', datetime.date.today().isoformat())
    date_to = request.args.get('to', datetime.date.today().isoformat())
    rows = query_db("""SELECT s.*,u.username as sold_by_name FROM sales s
                       JOIN users u ON u.id=s.sold_by
                       WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'
                       ORDER BY s.created_at DESC""", (date_from, date_to))
    data = rows_to_list(rows)
    total = sum(r['total'] for r in data)
    by_method = {}
    for r in data:
        m = r['payment_method']
        by_method[m] = by_method.get(m, 0) + r['total']
    return jsonify({'sales': data, 'total': total, 'by_method': by_method, 'period': {'from': date_from, 'to': date_to}})

# ── PDF exports (professional letterhead, pulls Settings for branding) ──
@app.route('/api/reports/pl/pdf', methods=['GET'])
@require_owner
def report_pl_pdf():
    date_from = request.args.get('from', datetime.date.today().replace(day=1).isoformat())
    date_to = request.args.get('to', datetime.date.today().isoformat())
    revenue = query_db("SELECT COALESCE(SUM(total),0) as t FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed'", (date_from, date_to), one=True)['t']
    cogs = query_db("""SELECT COALESCE(SUM(si.qty * si.buying_price_at_sale),0) as c
                       FROM sale_items si JOIN sales s ON s.id=si.sale_id
                       WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'""", (date_from, date_to), one=True)['c']
    expenses_by_cat = rows_to_list(query_db("""SELECT category, SUM(amount) as total FROM expenses
                                   WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY category""", (date_from, date_to)))
    total_expenses = sum(r['total'] for r in expenses_by_cat)
    gross = revenue - cogs
    net = gross - total_expenses
    is_profit = net >= 0

    def build(styles, settings, currency):
        s = []
        s.append(_pdf_kpi_table([
            ('Revenue', pdf_money(revenue, currency), _BRAND_AMBER),
            ('Cost of Goods', pdf_money(cogs, currency), _BRAND_RED),
            ('Gross Profit', pdf_money(gross, currency), _BRAND_GREEN),
            ('Net ' + ('Profit' if is_profit else 'Loss'), pdf_money(abs(net), currency),
             _BRAND_GREEN if is_profit else _BRAND_RED),
        ], styles))
        s.append(Spacer(1, 6*mm))
        s.append(_pdf_section_header('Revenue & Cost of Goods', styles))
        s.append(_pdf_data_table(
            ['Line', 'Amount'],
            [['Sales Revenue', pdf_money(revenue, currency)],
             ['Less: Cost of Goods Sold', f"({pdf_money(cogs, currency)})"],
             ['Gross Profit', pdf_money(gross, currency)]],
            [130*mm, 50*mm], right_cols=(1,)))
        s.append(Spacer(1, 6*mm))
        s.append(_pdf_section_header('Expenses by Category', styles))
        exp_rows = [[e['category'] or 'Uncategorized', f"({pdf_money(e['total'], currency)})"] for e in expenses_by_cat] or [['—', '—']]
        exp_rows.append(['TOTAL EXPENSES', f"({pdf_money(total_expenses, currency)})"])
        s.append(_pdf_data_table(['Category', 'Amount'], exp_rows, [130*mm, 50*mm], right_cols=(1,)))
        s.append(Spacer(1, 8*mm))
        result_label = 'NET PROFIT' if is_profit else 'NET LOSS'
        result_color = _BRAND_GREEN if is_profit else _BRAND_RED
        t = Table([[Paragraph(f"<b>{result_label}</b>", ParagraphStyle('rl', parent=styles['Normal'], fontSize=13, textColor=colors.white)),
                     Paragraph(f"<b>{pdf_money(abs(net), currency)}</b>", ParagraphStyle('rv', parent=styles['Normal'], fontSize=15, textColor=colors.white, alignment=TA_RIGHT))]],
                   colWidths=[100*mm, 80*mm])
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),result_color),
                                ('TOPPADDING',(0,0),(-1,-1),12), ('BOTTOMPADDING',(0,0),(-1,-1),12),
                                ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12),
                                ('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
        s.append(t)
        return s

    buf = build_pdf('Profit & Loss Statement', f"{date_from}  →  {date_to}", build)
    return pdf_file_response(buf, f"pl_report_{date_from}_to_{date_to}.pdf")

@app.route('/api/reports/stock-valuation/pdf', methods=['GET'])
@require_owner
def report_stock_pdf():
    rows = rows_to_list(query_db("""SELECT p.name, p.sku, p.current_stock, p.buying_price, p.selling_price,
                              c.name as category,
                              p.current_stock * p.buying_price as cost_value,
                              p.current_stock * p.selling_price as sell_value,
                              (p.current_stock * p.selling_price) - (p.current_stock * p.buying_price) as potential_profit
                       FROM products p LEFT JOIN categories c ON c.id=p.category_id
                       WHERE p.is_active=1 ORDER BY p.name"""))
    total_cost = sum(r['cost_value'] for r in rows)
    total_sell = sum(r['sell_value'] for r in rows)

    def build(styles, settings, currency):
        s = []
        s.append(_pdf_kpi_table([
            ('Products', str(len(rows)), _BRAND_NAVY),
            ('Stock at Cost', pdf_money(total_cost, currency), _BRAND_AMBER),
            ('Stock at Sell Price', pdf_money(total_sell, currency), _BRAND_GREEN),
            ('Potential Profit', pdf_money(total_sell - total_cost, currency), _BRAND_GREEN),
        ], styles))
        s.append(Spacer(1, 6*mm))
        s.append(_pdf_section_header('Inventory Detail', styles))
        table_rows = [[r['name'], r['sku'] or '—', r['category'] or '—', pdf_qty(r['current_stock']),
                        pdf_money(r['buying_price'], currency), pdf_money(r['selling_price'], currency),
                        pdf_money(r['cost_value'], currency), pdf_money(r['sell_value'], currency)]
                       for r in rows]
        s.append(_pdf_data_table(
            ['Product', 'SKU', 'Category', 'Stock', 'Buy', 'Sell', 'Cost Value', 'Sell Value'],
            table_rows, [40*mm, 20*mm, 24*mm, 14*mm, 22*mm, 22*mm, 24*mm, 24*mm],
            right_cols=(3,4,5,6,7)))
        s.append(Spacer(1, 6*mm))
        summary = f"Cost: {pdf_money(total_cost, currency)}    •    Sell: {pdf_money(total_sell, currency)}    •    Potential Profit: {pdf_money(total_sell-total_cost, currency)}"
        t = Table([[Paragraph('<b>TOTALS</b>', ParagraphStyle('st', parent=styles['Normal'], fontSize=11, textColor=colors.white)),
                     Paragraph(f"<b>{summary}</b>", ParagraphStyle('sv', parent=styles['Normal'], fontSize=9.5, textColor=colors.white, alignment=TA_RIGHT))]],
                   colWidths=[35*mm, 145*mm])
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),_BRAND_NAVY),
                                ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),10),
                                ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12),
                                ('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
        s.append(t)
        return s

    buf = build_pdf('Stock Valuation Report', datetime.date.today().isoformat(), build)
    return pdf_file_response(buf, f"stock_valuation_{datetime.date.today().isoformat()}.pdf")

@app.route('/api/reports/debt-aging/pdf', methods=['GET'])
@require_owner
def report_debt_aging_pdf():
    rows = rows_to_list(query_db("""
        SELECT d.customer_name, d.customer_phone, d.remaining, d.created_at,
               CAST(julianday('now') - julianday(d.created_at) AS INTEGER) as days_overdue
        FROM debts d WHERE d.status IN ('unpaid','partial') ORDER BY days_overdue DESC
    """))
    buckets = {'0_30': [], '31_60': [], '61_90': [], '91_plus': []}
    for r in rows:
        days = r['days_overdue']
        key = '0_30' if days <= 30 else '31_60' if days <= 60 else '61_90' if days <= 90 else '91_plus'
        buckets[key].append(r)
    bucket_meta = [('0_30', '0 – 30 Days', _BRAND_GREEN), ('31_60', '31 – 60 Days', _BRAND_AMBER),
                   ('61_90', '61 – 90 Days', colors.HexColor('#f97316')), ('91_plus', '90+ Days', _BRAND_RED)]
    grand_total = sum(r['remaining'] for r in rows)

    def build(styles, settings, currency):
        s = []
        s.append(_pdf_kpi_table([(label, pdf_money(sum(r['remaining'] for r in buckets[key]), currency), color)
                                  for key, label, color in bucket_meta], styles))
        s.append(Spacer(1, 6*mm))
        for key, label, color in bucket_meta:
            bucket_rows = buckets[key]
            if not bucket_rows:
                continue
            bucket_total = sum(r['remaining'] for r in bucket_rows)
            s.append(_pdf_section_header(f"{label}  —  {pdf_money(bucket_total, currency)}", styles))
            s.append(_pdf_data_table(
                ['Customer', 'Phone', 'Days', 'Remaining'],
                [[r['customer_name'], r['customer_phone'] or '—', f"{r['days_overdue']}d", pdf_money(r['remaining'], currency)]
                 for r in bucket_rows],
                [70*mm, 40*mm, 20*mm, 50*mm], right_cols=(3,)))
            s.append(Spacer(1, 5*mm))
        if not rows:
            s.append(Paragraph('No outstanding debts — all customer accounts are settled.', styles['Normal']))
        else:
            s.append(Spacer(1, 3*mm))
            t = Table([[Paragraph('<b>GRAND TOTAL OUTSTANDING</b>', ParagraphStyle('gt', parent=styles['Normal'], fontSize=12, textColor=colors.white)),
                         Paragraph(f"<b>{pdf_money(grand_total, currency)}</b>", ParagraphStyle('gtv', parent=styles['Normal'], fontSize=13, textColor=colors.white, alignment=TA_RIGHT))]],
                       colWidths=[100*mm, 80*mm])
            t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),_BRAND_RED),
                                    ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),10),
                                    ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12)]))
            s.append(t)
        return s

    buf = build_pdf('Debt Aging Report', datetime.date.today().isoformat(), build)
    return pdf_file_response(buf, f"debt_aging_{datetime.date.today().isoformat()}.pdf")

@app.route('/api/reports/sales-statement/pdf', methods=['GET'])
@require_owner
def report_sales_pdf():
    date_from = request.args.get('from', datetime.date.today().isoformat())
    date_to = request.args.get('to', datetime.date.today().isoformat())
    rows = rows_to_list(query_db("""SELECT s.*,u.username as sold_by_name FROM sales s
                       JOIN users u ON u.id=s.sold_by
                       WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'
                       ORDER BY s.created_at DESC""", (date_from, date_to)))
    total = sum(r['total'] for r in rows)
    by_method = {}
    for r in rows:
        by_method[r['payment_method']] = by_method.get(r['payment_method'], 0) + r['total']

    def build(styles, settings, currency):
        s = []
        kpis = [('Total Revenue', pdf_money(total, currency), _BRAND_AMBER),
                ('Transactions', str(len(rows)), _BRAND_NAVY),
                ('Avg Sale', pdf_money(total/len(rows) if rows else 0, currency), _BRAND_GREY)]
        for m, v in by_method.items():
            kpis.append((m, pdf_money(v, currency), colors.HexColor('#3b82f6')))
        s.append(_pdf_kpi_table(kpis[:4], styles))
        if len(kpis) > 4:
            s.append(Spacer(1, 3*mm))
            s.append(_pdf_kpi_table(kpis[4:8] if len(kpis) > 4 else kpis[:4], styles))
        s.append(Spacer(1, 6*mm))
        s.append(_pdf_section_header('Sales List', styles))
        table_rows = [[r['receipt_no'], r['created_at'][:16].replace('T',' '), r['customer_name'] or 'Walk-in',
                        r['payment_method'], pdf_money(r['total'], currency)] for r in rows]
        s.append(_pdf_data_table(['Receipt', 'Date', 'Customer', 'Method', 'Total'],
                 table_rows, [30*mm, 34*mm, 46*mm, 30*mm, 40*mm], right_cols=(4,)))
        s.append(Spacer(1, 6*mm))
        t = Table([[Paragraph('<b>TOTAL REVENUE</b>', ParagraphStyle('tr', parent=styles['Normal'], fontSize=12, textColor=colors.white)),
                     Paragraph(f"<b>{pdf_money(total, currency)}</b>", ParagraphStyle('trv', parent=styles['Normal'], fontSize=14, textColor=colors.white, alignment=TA_RIGHT))]],
                   colWidths=[100*mm, 80*mm])
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),_BRAND_NAVY),
                                ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),10),
                                ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12)]))
        s.append(t)
        return s

    buf = build_pdf('Sales Statement', f"{date_from}  →  {date_to}", build)
    return pdf_file_response(buf, f"sales_statement_{date_from}_to_{date_to}.pdf")

# SSE endpoint
@app.route('/api/events')
@require_auth
def sse():
    def generate():
        q = queue.Queue(maxsize=50)
        with _sse_lock:
            sse_clients.append(q)
        try:
            yield f"data: {json.dumps({'type':'connected','ts':time.time()})}\n\n"
            while True:
                try:
                    payload = q.get(timeout=30)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        except GeneratorExit:
            with _sse_lock:
                if q in sse_clients:
                    sse_clients.remove(q)
    return Response(stream_with_context(generate()),
                    content_type='text/event-stream',
                    headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

# ── Serve built frontend (Render deploy: single service for API + SPA) ────
# frontend/dist must exist (created by `npm run build`) for this to find files.
# Anything starting with /api/ is handled by the routes above; everything
# else falls through to here and returns the SPA's index.html.
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    if path.startswith('api/'):
        return jsonify({'error': 'Not found'}), 404
    if path and os.path.exists(os.path.join(FRONTEND_DIST, path)):
        return send_from_directory(FRONTEND_DIST, path)
    return send_from_directory(FRONTEND_DIST, 'index.html')

# Health
@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'time': datetime.datetime.utcnow().isoformat()})

# ── Superuser control panel ──────────────────────────────────────────────
# Everything below is @require_superuser only. This is intentionally raw
# and powerful — a Django-admin-style generic browser over every table in
# the database, plus site-level controls (maintenance mode, feature flags,
# backups). Table/column names from the client are NEVER interpolated into
# SQL without first being checked against real introspection
# (sqlite_master / PRAGMA table_info) — only values are ever parameterized
# normally. This is the one place in the app that trusts a superuser with
# everything, by design.

_ADMIN_HIDDEN_TABLES = {'_secret', '_admin_flags', 'sqlite_sequence'}

def _admin_valid_tables():
    rows = query_db("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    return sorted(r['name'] for r in rows if r['name'] not in _ADMIN_HIDDEN_TABLES)

def _admin_table_columns(table):
    rows = query_db(f"PRAGMA table_info({table})")
    return rows_to_list(rows)  # each: cid, name, type, notnull, dflt_value, pk

@app.route('/api/admin/tables', methods=['GET'])
@require_superuser
def admin_list_tables():
    tables = _admin_valid_tables()
    out = []
    for t in tables:
        try:
            count = query_db(f"SELECT COUNT(*) as c FROM {t}", one=True)['c']
        except Exception:
            count = None
        out.append({'name': t, 'row_count': count})
    return jsonify(out)

@app.route('/api/admin/tables/<table>', methods=['GET', 'POST'])
@require_superuser
def admin_table_rows(table):
    if table not in _admin_valid_tables():
        return jsonify({'error': 'Unknown table'}), 404
    cols = _admin_table_columns(table)
    col_names = [c['name'] for c in cols]

    if request.method == 'POST':
        data = request.json or {}
        fields = [k for k in data.keys() if k in col_names]
        if not fields:
            return jsonify({'error': 'No valid fields supplied'}), 400
        if table == 'users' and 'password' in data:
            # Special case: never accept a raw password_hash from the
            # client — only ever a plaintext "password" field, hashed here.
            fields = [f for f in fields if f != 'password_hash']
            placeholders = ", ".join(["?"] * (len(fields) + 1))
            col_sql = ", ".join(fields + ['password_hash'])
            values = [data[f] for f in fields] + [hash_password(data['password'])]
        else:
            col_sql = ", ".join(fields)
            placeholders = ", ".join(["?"] * len(fields))
            values = [data[f] for f in fields]
        try:
            new_id = exec_db(f"INSERT INTO {table} ({col_sql}) VALUES ({placeholders})", values)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
        return jsonify({'ok': True, 'id': new_id})

    # GET: paginated listing with optional simple text search
    try:
        page = max(1, int(request.args.get('page', 1)))
        limit = max(1, min(200, int(request.args.get('limit', 50))))
    except (TypeError, ValueError):
        page, limit = 1, 50
    q = (request.args.get('q') or '').strip()
    where, params = '', []
    if q:
        text_cols = [c['name'] for c in cols if 'CHAR' in (c['type'] or '').upper() or 'TEXT' in (c['type'] or '').upper()]
        if text_cols:
            where = "WHERE " + " OR ".join(f"{c} LIKE ?" for c in text_cols)
            params = [f"%{q}%"] * len(text_cols)
    total = query_db(f"SELECT COUNT(*) as c FROM {table} {where}", params, one=True)['c']
    rows = query_db(f"SELECT * FROM {table} {where} ORDER BY rowid DESC LIMIT ? OFFSET ?",
                     params + [limit, (page - 1) * limit])
    data = rows_to_list(rows)
    if table == 'users':
        for r in data:
            r.pop('password_hash', None)
    return jsonify({'rows': data, 'total': total, 'page': page, 'limit': limit, 'columns': cols})

@app.route('/api/admin/tables/<table>/<int:row_id>', methods=['GET', 'PUT', 'DELETE'])
@require_superuser
def admin_table_row(table, row_id):
    if table not in _admin_valid_tables():
        return jsonify({'error': 'Unknown table'}), 404
    cols = _admin_table_columns(table)
    col_names = [c['name'] for c in cols]
    pk = next((c['name'] for c in cols if c['pk']), 'id')

    if request.method == 'GET':
        row = query_db(f"SELECT * FROM {table} WHERE {pk}=?", (row_id,), one=True)
        if not row:
            return jsonify({'error': 'Not found'}), 404
        d = dict(row)
        if table == 'users':
            d.pop('password_hash', None)
        return jsonify(d)

    if request.method == 'DELETE':
        if table == 'users' and row_id == g.user_id:
            return jsonify({'error': "Can't delete your own superuser account"}), 400
        try:
            exec_db(f"DELETE FROM {table} WHERE {pk}=?", (row_id,))
        except Exception as e:
            return jsonify({'error': f'Delete blocked — other records still reference this row ({e})'}), 409
        return jsonify({'ok': True})

    # PUT
    data = request.json or {}
    fields = [k for k in data.keys() if k in col_names and k != pk]
    if table == 'users':
        fields = [f for f in fields if f != 'password_hash']
        if 'password' in data and data['password']:
            exec_db(f"UPDATE users SET password_hash=? WHERE {pk}=?", (hash_password(data['password']), row_id))
        fields = [f for f in fields if f != 'password']
    if not fields:
        return jsonify({'ok': True})  # nothing else to update
    set_sql = ", ".join(f"{f}=?" for f in fields)
    values = [data[f] for f in fields] + [row_id]
    try:
        exec_db(f"UPDATE {table} SET {set_sql} WHERE {pk}=?", values)
    except Exception as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'ok': True})

@app.route('/api/admin/system', methods=['GET', 'PUT'])
@require_superuser
def admin_system():
    if request.method == 'PUT':
        data = request.json or {}
        if 'maintenance_mode' in data:
            set_admin_flag('maintenance_mode', '1' if data['maintenance_mode'] else '0')
        if 'maintenance_message' in data:
            set_admin_flag('maintenance_message', str(data['maintenance_message'])[:2000])
        if 'feature_flags' in data and isinstance(data['feature_flags'], dict):
            set_admin_flag('feature_flags', json.dumps(data['feature_flags']))
        return jsonify({'ok': True})

    db_path = app.config['DATABASE']
    try:
        db_size = os.path.getsize(db_path)
    except OSError:
        db_size = None
    counts = {}
    for t in ('users', 'products', 'sales', 'debts', 'expenses'):
        try:
            counts[t] = query_db(f"SELECT COUNT(*) as c FROM {t}", one=True)['c']
        except Exception:
            counts[t] = None
    return jsonify({
        'maintenance_mode': is_maintenance_mode(),
        'maintenance_message': get_admin_flag('maintenance_message', ''),
        'feature_flags': get_feature_flags(),
        'system_info': {
            'db_size_bytes': db_size,
            'db_path': db_path,
            'uptime_seconds': round(time.time() - _PROCESS_STARTED_AT),
            'counts': counts,
            'secret_key_source': 'env' if os.environ.get('SECRET_KEY') else 'database',
        },
    })

@app.route('/api/admin/legal-content', methods=['GET', 'PUT'])
@require_superuser
def admin_legal_content():
    if request.method == 'PUT':
        data = request.json or {}
        current = get_legal_content()
        for key in _DEFAULT_LEGAL_CONTENT:
            if key in data:
                val = data[key]
                if key == 'about_photo' and val and len(val) > 8_000_000:
                    return jsonify({'error': 'Picha ni kubwa mno (max ~6MB)'}), 400
                current[key] = val
        set_admin_flag('legal_content', json.dumps(current))
        return jsonify({'ok': True})
    return jsonify(get_legal_content())

# ── Backups ───────────────────────────────────────────────────────────────
def _backups_dir():
    d = os.path.join(os.path.dirname(app.config['DATABASE']) or '.', 'backups')
    os.makedirs(d, exist_ok=True)
    return d

_BACKUP_NAME_RE = re.compile(r'^[A-Za-z0-9_\-]+\.db$')

@app.route('/api/admin/backups', methods=['GET', 'POST'])
@require_superuser
def admin_backups():
    if request.method == 'POST':
        # Uses SQLite's own backup API rather than a raw file copy, so a
        # backup taken while the shop is actively selling still comes out
        # as a consistent, non-corrupt snapshot.
        ts = datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
        fname = f"backup-{ts}.db"
        dest_path = os.path.join(_backups_dir(), fname)
        src = sqlite3.connect(app.config['DATABASE'])
        dst = sqlite3.connect(dest_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        return jsonify({'ok': True, 'filename': fname})

    files = []
    for fname in os.listdir(_backups_dir()):
        if not _BACKUP_NAME_RE.match(fname):
            continue
        fpath = os.path.join(_backups_dir(), fname)
        files.append({'filename': fname, 'size_bytes': os.path.getsize(fpath),
                      'created_at': datetime.datetime.utcfromtimestamp(os.path.getmtime(fpath)).isoformat()})
    files.sort(key=lambda f: f['created_at'], reverse=True)
    return jsonify(files)

@app.route('/api/admin/backups/upload', methods=['POST'])
@require_superuser
def admin_upload_backup():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'Hakuna faili lililotumwa'}), 400

    data = f.read()
    if len(data) > 200 * 1024 * 1024:  # 200MB safety cap
        return jsonify({'error': 'Faili ni kubwa mno (max 200MB)'}), 400
    # SQLite files always start with this 16-byte magic header — cheap way
    # to reject non-database uploads before they ever touch disk.
    if not data.startswith(b'SQLite format 3\x00'):
        return jsonify({'error': 'Faili hili si SQLite database halali (.db)'}), 400

    ts = datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    fname = f"backup-uploaded-{ts}.db"
    dest_path = os.path.join(_backups_dir(), fname)
    with open(dest_path, 'wb') as out:
        out.write(data)

    # Belt-and-suspenders: header matched, but confirm SQLite can actually
    # open and query it before it ever appears as a restorable option.
    try:
        chk = sqlite3.connect(dest_path)
        chk.execute('SELECT name FROM sqlite_master LIMIT 1')
        chk.close()
    except Exception:
        os.remove(dest_path)
        return jsonify({'error': 'Faili limeharibika au si database sahihi'}), 400

    return jsonify({'ok': True, 'filename': fname})

@app.route('/api/admin/backups/<filename>', methods=['GET', 'DELETE'])
@require_superuser
def admin_backup_file(filename):
    if not _BACKUP_NAME_RE.match(filename):
        return jsonify({'error': 'Invalid filename'}), 400
    fpath = os.path.join(_backups_dir(), filename)
    if not os.path.exists(fpath):
        return jsonify({'error': 'Not found'}), 404
    if request.method == 'DELETE':
        os.remove(fpath)
        return jsonify({'ok': True})
    return send_file(fpath, as_attachment=True, download_name=filename)

@app.route('/api/admin/backups/<filename>/restore', methods=['POST'])
@require_superuser
def admin_restore_backup(filename):
    if not _BACKUP_NAME_RE.match(filename):
        return jsonify({'error': 'Invalid filename'}), 400
    fpath = os.path.join(_backups_dir(), filename)
    if not os.path.exists(fpath):
        return jsonify({'error': 'Not found'}), 404

    # Safety net: snapshot the CURRENT live database before overwriting it,
    # so a restore that turns out to be a mistake can itself be undone by
    # restoring this snapshot from the same backups list.
    ts = datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    safety_fname = f"backup-pre-restore-{ts}.db"
    safety_path = os.path.join(_backups_dir(), safety_fname)
    live = sqlite3.connect(app.config['DATABASE'])
    safety = sqlite3.connect(safety_path)
    try:
        live.backup(safety)
    finally:
        safety.close()
        live.close()

    # Use SQLite's own backup API (not a raw file copy) to stream the
    # chosen backup's pages into the live database file, same mechanism
    # already used for taking backups — safe even with the live db in use.
    chosen = sqlite3.connect(fpath)
    live = sqlite3.connect(app.config['DATABASE'])
    try:
        chosen.backup(live)
    finally:
        live.close()
        chosen.close()

    return jsonify({'ok': True, 'safety_backup': safety_fname})

# FIX (Render deploy): init_db() must run whenever the module is loaded, not
# only under `python app.py`. Gunicorn imports this module directly and never
# hits the __main__ block below, so a fresh deploy would otherwise have no
# tables at all. CREATE TABLE IF NOT EXISTS makes this safe to call every time.
init_db()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)
