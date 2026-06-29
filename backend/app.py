"""
MotoShop Backend - Flask REST API
Single-file backend with SQLite, JWT auth, real-time SSE
"""
import os
import json
import time
import queue
import hashlib
import secrets
import sqlite3
import datetime
from functools import wraps
from flask import Flask, request, jsonify, g, Response, stream_with_context, send_from_directory
from flask_cors import CORS

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
    key_file = os.path.join(os.path.dirname(__file__), '.secret_key')
    if os.path.exists(key_file):
        with open(key_file, 'r') as f:
            return f.read().strip()
    new_key = secrets.token_hex(32)
    with open(key_file, 'w') as f:
        f.write(new_key)
    return new_key

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
    if role == 'owner':
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
        if payload['role'] != 'owner':
            return jsonify({'error': 'Owner access required'}), 403
        g.user_id = payload['user_id']
        g.role = payload['role']
        return f(*args, **kwargs)
    return decorated

# ── DB Init ───────────────────────────────────────────────────────────────
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
            role TEXT NOT NULL CHECK(role IN ('owner','cashier')),
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
            line_total REAL NOT NULL
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

@app.route('/api/auth/cashier-status', methods=['GET', 'PUT'])
@require_owner
def cashier_status():
    cashier_id = request.args.get('cashier_id') or (request.json or {}).get('cashier_id')
    if cashier_id:
        cashier = query_db("SELECT id,is_active FROM users WHERE id=? AND role='cashier'", (cashier_id,), one=True)
    else:
        cashier = query_db("SELECT id,is_active FROM users WHERE role='cashier' ORDER BY id LIMIT 1", one=True)
    if not cashier:
        return jsonify({'error': 'No cashier'}), 404
    if request.method == 'PUT':
        data = request.json or {}
        status = 1 if data.get('is_active') else 0
        exec_db("UPDATE users SET is_active=? WHERE id=?", (status, cashier['id']))
        return jsonify({'ok': True, 'is_active': bool(status)})
    return jsonify({'is_active': bool(cashier['is_active']), 'id': cashier['id']})

# Settings
@app.route('/api/settings', methods=['GET', 'PUT'])
@require_auth
def settings():
    if request.method == 'GET':
        rows = query_db("SELECT key,value FROM settings")
        return jsonify({r['key']: r['value'] for r in rows})
    if g.role != 'owner':
        return jsonify({'error': 'Owner only'}), 403
    data = request.json or {}
    allowed = ['shop_name','shop_phone','shop_address','receipt_footer','vat_default',
               'currency','low_stock_multiplier','language',
               'header_title','header_subtitle','header_icon','logo_image']
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
    if g.role != 'owner':
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

    if g.role != 'owner':
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

    if g.role != 'owner':
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
    cash_sales = query_db("""SELECT COALESCE(SUM(total),0) as t FROM sales
                              WHERE shift_id=? AND payment_method='cash' AND status='completed'""",
                          (shift['id'],), one=True)
    expected = shift['opening_cash'] + cash_sales['t']
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
                                 'qty': qty, 'disc_pct': disc_pct, 'line_total': line_total})

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
        db.execute("""INSERT INTO sale_items (sale_id,product_id,product_name,qty,unit_price,discount_pct,line_total)
                   VALUES (?,?,?,?,?,?,?)""",
                (sale_id, item['product_id'], item['product_name'],
                 item['qty'], item['unit_price'], item['disc_pct'], item['line_total']))
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
    # Detect items sold below buying price and include in SSE event
    below_price_items = []
    for item in processed_items:
        p_row = db.execute("SELECT buying_price, name FROM products WHERE id=?", (item['product_id'],)).fetchone()
        if p_row:
            eff_price = item['unit_price'] * (1 - item['disc_pct'] / 100)
            if eff_price < p_row['buying_price']:
                below_price_items.append({
                    'name': item['product_name'],
                    'selling_price': round(eff_price, 2),
                    'buying_price': round(p_row['buying_price'], 2),
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
        tx_count = query_db("SELECT COUNT(*) as c FROM sales WHERE DATE(created_at)=? AND status='completed'", (today,), one=True)['c']
        cogs = query_db("""SELECT COALESCE(SUM(si.qty * p.buying_price),0) as c
                           FROM sale_items si JOIN sales s ON s.id=si.sale_id
                           JOIN products p ON p.id=si.product_id
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
            'revenue': revenue, 'tx_count': tx_count, 'cogs': cogs,
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
    cogs = query_db("""SELECT COALESCE(SUM(si.qty * p.buying_price),0) as c
                       FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id
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

# FIX (Render deploy): init_db() must run whenever the module is loaded, not
# only under `python app.py`. Gunicorn imports this module directly and never
# hits the __main__ block below, so a fresh deploy would otherwise have no
# tables at all. CREATE TABLE IF NOT EXISTS makes this safe to call every time.
init_db()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True)
