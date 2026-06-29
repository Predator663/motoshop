// src/pages/POSPage.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, getOfflineQueue, getCachedShift } from '../utils/api'
import Modal from '../components/Modal'

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return width
}

export default function POSPage() {
  const { auth, currency, toast, settings, isOnline, setPendingSyncCount, setActiveTab } = useApp()
  const T = useT()
  const windowWidth = useWindowWidth()
  const [products, setProducts] = useState([])
  const [shift, setShift] = useState(undefined) // undefined = still loading, null = no shift
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState([])
  const [cartOpen, setCartOpen] = useState(false)
  const [orderDisc, setOrderDisc] = useState(0)
  const VAT_RATE = parseFloat(settings.vat_default) || 0
  const [vatOn, setVatOn] = useState(VAT_RATE > 0)
  const [customerType, setCustomerType] = useState('walk-in')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payRef, setPayRef] = useState('')
  const [amountPaid, setAmountPaid] = useState('')
  const [isCredit, setIsCredit] = useState(false)
  const [checkoutModal, setCheckoutModal] = useState(false)
  const [receiptModal, setReceiptModal] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const searchRef = useRef(null)

  useEffect(() => {
    // FIX (offline support): re-runs when connectivity flips back on, so the
    // POS grid swaps from the cached snapshot to live stock again. While
    // offline, api.getProducts() itself falls back to the cache below.
    api.getProducts(true).then(setProducts).catch(() => {})
  }, [isOnline])

  // FIX: any transaction requires an open shift — checked locally (cache
  // first, so this works before any network round-trip) and re-checked
  // whenever connectivity flips so a closed/expired shift is caught.
  useEffect(() => {
    api.getCurrentShift().then(setShift).catch(() => setShift(getCachedShift()))
  }, [isOnline])

  useEffect(() => {
    setVatOn(parseFloat(settings.vat_default) > 0)
  }, [settings.vat_default])

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase())
  )

  const addToCart = useCallback((product) => {
    setCart(c => {
      const ex = c.find(x => x.product_id === product.id)
      if (ex) {
        if (ex.qty >= ex.stock) return c
        return c.map(x => x.product_id === product.id ? {...x, qty: x.qty + 1} : x)
      }
      return [...c, {
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        unit_price: product.selling_price,
        qty: 1,
        discount_pct: 0,
        stock: product.current_stock
      }]
    })
    if (windowWidth <= 900) setCartOpen(true)
  }, [windowWidth])

  const updateCartItem = useCallback((id, field, value) => {
    setCart(c => c.map(x => {
      if (x.product_id !== id) return x
      const updated = { ...x, [field]: value }
      if (field === 'discount_pct') {
        const max = auth?.role === 'cashier' ? 10 : 50
        updated.discount_pct = Math.min(Math.max(0, Number(value)), max)
      }
      if (field === 'qty') {
        const v = parseFloat(value)
        updated.qty = isNaN(v) ? '' : Math.max(0.001, Math.min(v, x.stock))
      }
      return updated
    }))
  }, [auth])

  const removeItem = useCallback((id) => setCart(c => c.filter(x => x.product_id !== id)), [])

  const subtotal = cart.reduce((s, x) => {
    const q = parseFloat(x.qty) || 0
    return s + q * x.unit_price * (1 - x.discount_pct / 100)
  }, 0)
  const discAmt = subtotal * orderDisc / 100
  const afterDisc = subtotal - discAmt
  const vatAmt = vatOn ? afterDisc * VAT_RATE / 100 : 0
  const total = afterDisc + vatAmt
  const change = isCredit ? 0 : Math.max(0, (parseFloat(amountPaid) || 0) - total)

  const openCheckout = () => {
    if (!shift) { toast('Lazima ufungue zamu kabla ya kuuza', 'error'); return }
    if (cart.length === 0) { toast(T('pos_empty_cart_warn'), 'warning'); return }
    setAmountPaid(total.toFixed(0))
    setCheckoutModal(true)
  }

  // Handle payment method change — credit logic
  const handlePayMethodChange = (m) => {
    setPayMethod(m)
    if (m === 'credit') {
      setIsCredit(true)
      if (customerType === 'walk-in') setCustomerType('named')
    } else {
      setIsCredit(false)
    }
  }

  async function completeSale() {
    if (!shift) { toast('Lazima ufungue zamu kabla ya kuuza', 'error'); setCheckoutModal(false); return }
    if (isCredit && customerType === 'walk-in') { toast(T('pos_credit_no_name'), 'error'); return }
    if (isCredit && !customerName.trim()) { toast(T('pos_credit_no_name'), 'error'); return }
    if (!isCredit && parseFloat(amountPaid) < total) { toast(T('pos_underpaid'), 'error'); return }
    setSubmitting(true)
    try {
      const payload = {
        items: cart.map(x => ({
          product_id: x.product_id,
          qty: parseFloat(x.qty) || 1,
          discount_pct: x.discount_pct
        })),
        discount_pct: orderDisc,
        vat_pct: vatOn ? VAT_RATE : 0,
        customer_type: customerType,
        customer_name: customerName || null,
        customer_phone: customerPhone || null,
        payment_method: payMethod,
        payment_ref: payRef || null,
        amount_paid: isCredit ? 0 : parseFloat(amountPaid) || total,
        is_credit: isCredit
      }
      const result = await api.createSale(payload)
      setReceiptModal({
        receipt_no: result.receipt_no,
        sale_date: result.created_at || new Date().toISOString(),
        // FIX (offline support): a queued sale has no server-computed
        // total/change (nothing reached the server) — use the figures
        // already computed locally for the live cart, which are the same
        // numbers the cashier and customer already saw on screen.
        total: result.offline ? total : result.total,
        change: result.offline ? change : result.change,
        offline: !!result.offline,
        vatAmt,
        subtotal,
        vatRate: VAT_RATE,
        vatOn,
        items: cart.map(x => ({ ...x })),
        payMethod,
        customerName,
        customerType,
        amountPaid: isCredit ? 0 : parseFloat(amountPaid) || total,
        isCredit,
        shopName: settings.shop_name || 'MotoShop',
        logoImage: settings.logo_image || '',
        receiptFooter: settings.receipt_footer || 'Asante kwa biashara yako!',
      })
      const defaultVatOn = parseFloat(settings.vat_default) > 0
      setCart([]); setCheckoutModal(false); setOrderDisc(0); setVatOn(defaultVatOn)
      setCustomerType('walk-in'); setCustomerName(''); setCustomerPhone(''); setPayRef('')
      setIsCredit(false); setCartOpen(false); setPayMethod('cash')
      if (result.offline) {
        toast(`📴 Imehifadhiwa nje ya mtandao — ${result.receipt_no} (itasawazishwa mtandao ukirudi)`, 'warning', 6000)
        setPendingSyncCount(getOfflineQueue().length)
      } else {
        toast(`Uuzaji umekamilika — ${result.receipt_no}`, 'success')
      }
      api.getProducts(true).then(setProducts).catch(() => {})
    } catch(err) {
      toast(err.message || T('pos_sale_failed'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const paymentMethods = ['cash','m-pesa','tigo-pesa','airtel-money','bank-transfer']
    .concat(auth?.role === 'owner' && customerType === 'named' ? ['credit'] : [])

  // FIX: no transactions without an open shift. `shift === undefined` means
  // we haven't checked yet (cache or network); show a neutral loading state
  // rather than flashing the "no shift" gate before we actually know.
  if (shift === undefined) {
    return (
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'calc(100vh - 120px)'}}>
        <span className="spinner" style={{width:36,height:36,borderWidth:4}} />
      </div>
    )
  }
  if (!shift) {
    return (
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'calc(100vh - 120px)'}}>
        <div className="card" style={{textAlign:'center',padding:'40px 32px',maxWidth:380}}>
          <div style={{fontSize:44,marginBottom:12}}>⏱️</div>
          <div className="font-head" style={{fontSize:17,fontWeight:700,marginBottom:8}}>Hauwezi kuuza bila zamu</div>
          <div style={{color:'var(--text2)',fontSize:13,marginBottom:20}}>
            Fungua zamu (shift) kwanza ili kuanza kuuza. Hii inafanya kazi bila mtandao pia.
          </div>
          <button className="btn btn-success btn-lg" onClick={() => setActiveTab('shifts')}>🟢 Fungua Zamu</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display:'grid', gridTemplateColumns: windowWidth > 900 ? '1fr 380px' : '1fr', height:'calc(100vh - 120px)', overflow:'hidden' }}>
      {/* Products panel */}
      <div style={{overflowY:'auto',padding:16}}>
        <div style={{position:'sticky',top:0,background:'var(--bg)',paddingBottom:12,zIndex:10}}>
          <div className="flex items-center gap-2" style={{marginBottom:8}}>
            <input
              ref={searchRef}
              className="input"
              placeholder={T('pos_search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{flex:1}}
            />
            {windowWidth <= 900 && (
              <button className="btn btn-primary" onClick={() => setCartOpen(true)} style={{position:'relative'}}>
                🛒
                {cart.length > 0 && (
                  <span style={{
                    position:'absolute',top:-6,right:-6,background:'var(--red)',color:'#fff',
                    borderRadius:'50%',width:18,height:18,fontSize:10,fontWeight:700,
                    display:'flex',alignItems:'center',justifyContent:'center'
                  }}>{cart.length}</span>
                )}
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <div className="empty-title">Hakuna bidhaa zilizopatikana</div>
          </div>
        ) : (
          <div className="product-grid">
            {filtered.map(p => (
              <div
                key={p.id}
                className={`product-card ${p.current_stock <= 0 ? 'out-of-stock' : ''}`}
                onClick={() => p.current_stock > 0 && addToCart(p)}
              >
                <div className="pname">{p.name}</div>
                <div className="psku">{p.sku}</div>
                <div className="pprice">{formatMoney(p.selling_price, currency)}</div>
                <div className={`pstock ${p.low_stock ? 'text-amber' : p.current_stock <= 0 ? 'text-red' : 'text-green'} text-xs`}>
                  {p.current_stock <= 0 ? T('pos_out_of_stock') : p.low_stock ? `⚠️ Akiba: ${p.current_stock}` : `✓ Akiba: ${p.current_stock}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cart */}
      <div className={`pos-cart ${cartOpen ? 'open' : ''}`} style={{display:'flex',flexDirection:'column',background:'var(--bg2)',borderLeft:'1px solid var(--border)'}}>
        <div className="cart-header">
          <span className="cart-title">{T('pos_cart')} ({cart.length})</span>
          <div className="flex gap-2">
            {cart.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setCart([])}>{T('pos_cart_clear')}</button>}
            {windowWidth <= 900 && <button className="btn btn-ghost btn-icon" onClick={() => setCartOpen(false)}>✕</button>}
          </div>
        </div>

        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="empty-state" style={{padding:40}}>
              <div className="empty-icon">🛒</div>
              <p style={{color:'var(--text3)',fontSize:13}}>{T('pos_empty_cart')}</p>
            </div>
          ) : cart.map(item => (
            <CartItem
              key={item.product_id}
              item={item}
              currency={currency}
              role={auth?.role}
              onUpdate={updateCartItem}
              onRemove={removeItem}
            />
          ))}
        </div>

        <div className="cart-footer">
          {auth?.role === 'owner' && (
            <div className="flex gap-2" style={{marginBottom:10,flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:100}}>
                <label className="input-label text-xs">Punguzo la Oda %</label>
                <input className="input input-sm" type="number" min="0" max="50" value={orderDisc}
                  onChange={e => setOrderDisc(Math.min(50,Math.max(0,Number(e.target.value))))} />
              </div>
              {VAT_RATE > 0 && (
                <div style={{display:'flex',alignItems:'flex-end',gap:6}}>
                  <label className="input-label text-xs" style={{marginBottom:0}}>VAT {VAT_RATE}%</label>
                  <button
                    className={`btn btn-sm ${vatOn ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setVatOn(v => !v)}
                  >{vatOn ? T('pos_vat_on') : T('pos_vat_off')}</button>
                </div>
              )}
            </div>
          )}
          <div className="total-line"><span>Jumla Ndogo</span><span>{formatMoney(subtotal, currency)}</span></div>
          {orderDisc > 0 && <div className="total-line" style={{color:'var(--green)'}}><span>Punguzo ({orderDisc}%)</span><span>−{formatMoney(discAmt, currency)}</span></div>}
          {vatOn && VAT_RATE > 0 && <div className="total-line"><span>VAT ({VAT_RATE}%)</span><span>{formatMoney(vatAmt, currency)}</span></div>}
          <div className="total-line grand"><span>JUMLA</span><span>{formatMoney(total, currency)}</span></div>
          <button className="btn btn-primary btn-block btn-lg" style={{marginTop:12}} onClick={openCheckout} disabled={cart.length===0}>
            {T('pos_checkout')}
          </button>
        </div>
      </div>

      {/* Checkout modal */}
      {checkoutModal && (
        <Modal title="Kamilisha Uuzaji" onClose={() => setCheckoutModal(false)} size="lg"
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setCheckoutModal(false)}>{T('cancel')}</button>
              <button className="btn btn-success btn-lg" onClick={completeSale} disabled={submitting}>
                {submitting ? <span className="spinner" /> : '✅ Thibitisha Uuzaji'}
              </button>
            </>
          }
        >
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            {/* Customer */}
            <div className="flex gap-2" style={{flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:140}}>
                <label className="input-label">Aina ya Mteja</label>
                <select className="input" value={customerType} onChange={e => {
                  setCustomerType(e.target.value)
                  if (e.target.value === 'walk-in') { setIsCredit(false); if (payMethod === 'credit') setPayMethod('cash') }
                }}>
                  <option value="walk-in">{T('pos_walk_in')}</option>
                  <option value="named">{T('pos_named')}</option>
                </select>
              </div>
              {customerType === 'named' && (
                <>
                  <div style={{flex:1,minWidth:140}}>
                    <label className="input-label">Jina la Mteja *</label>
                    <input className="input" placeholder={T('pos_customer_name_ph')} value={customerName} onChange={e => setCustomerName(e.target.value)} />
                  </div>
                  <div style={{flex:1,minWidth:140}}>
                    <label className="input-label">Nambari ya Simu</label>
                    <input className="input" placeholder="+255..." value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
                  </div>
                </>
              )}
            </div>

            {/* Payment method */}
            <div>
              <label className="input-label" style={{marginBottom:8,display:'block'}}>Njia ya Malipo</label>
              <div className="flex gap-2" style={{flexWrap:'wrap'}}>
                {paymentMethods.map(m => (
                  <button
                    key={m}
                    className={`btn btn-sm ${payMethod === m ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handlePayMethodChange(m)}
                    style={{textTransform:'capitalize'}}
                  >
                    {m === 'cash' && '💵 '}
                    {m === 'm-pesa' && '📱 '}
                    {m === 'credit' && '💳 '}
                    {m === 'bank-transfer' && '🏦 '}
                    {m === 'tigo-pesa' && '📲 '}
                    {m === 'airtel-money' && '📡 '}
                    {m === 'cash' ? 'Taslimu' : m === 'credit' ? 'Mkopo' : m.replace('-',' ')}
                  </button>
                ))}
              </div>
              {isCredit && (
                <div style={{marginTop:8,padding:'8px 12px',background:'rgba(239,68,68,.1)',borderRadius:8,border:'1px solid rgba(239,68,68,.3)',fontSize:12,color:'var(--red)'}}>
                  {T('pos_credit_warning')}
                </div>
              )}
            </div>

            {/* Reference for digital payments */}
            {payMethod !== 'cash' && payMethod !== 'credit' && (
              <div className="input-group">
                <label className="input-label">Nambari ya Malipo (Reference)</label>
                <input className="input" placeholder={T('pos_pay_ref_ph')} value={payRef} onChange={e => setPayRef(e.target.value)} />
              </div>
            )}

            {/* Amount paid — not for credit */}
            {!isCredit && (
              <div className="flex gap-3" style={{flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:140}}>
                  <label className="input-label">Kiasi Kilicholipwa</label>
                  <input className="input" type="number" min="0" value={amountPaid}
                    onChange={e => setAmountPaid(e.target.value)}
                    style={{fontSize:18,fontWeight:700,color: parseFloat(amountPaid) >= total ? 'var(--green)' : 'var(--red)'}}
                  />
                </div>
                <div style={{flex:1,minWidth:140}}>
                  <label className="input-label">Chenji</label>
                  <div className="input" style={{background:'var(--bg4)',fontWeight:700,color:change >= 0 ? 'var(--green)' : 'var(--red)',fontSize:18}}>
                    {formatMoney(change, currency)}
                  </div>
                </div>
              </div>
            )}

            {/* Summary */}
            <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'14px 16px'}}>
              <div className="total-line bold">
                <span>JUMLA YA KULIPA</span>
                <span style={{color:'var(--amber)',fontSize:22}}>{formatMoney(total, currency)}</span>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Receipt modal */}
      {receiptModal && (
        <Modal title="Uuzaji Umekamilika ✓" onClose={() => setReceiptModal(null)}>
          <Receipt data={receiptModal} currency={currency} />
          <div className="flex gap-2 mt-3">
            <button className="btn btn-primary btn-block" onClick={() => window.print()}>{T('pos_print')}</button>
            <button className="btn btn-secondary btn-block" onClick={() => setReceiptModal(null)}>Funga</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── CartItem component with beautiful animated quantity input ─────────────
function CartItem({
  item, currency, role, onUpdate, onRemove }) {
  const T = useT()
  const [focused, setFocused] = useState(false)
  const [qtyInput, setQtyInput] = useState(String(item.qty))
  const [priceFocused, setPriceFocused] = useState(false)
  const effectivePrice = item.unit_price * (1 - item.discount_pct / 100)
  const [priceInput, setPriceInput] = useState(String(Math.round(effectivePrice)))

  // Sync external qty changes into local input state
  useEffect(() => {
    if (!focused) setQtyInput(String(item.qty))
  }, [item.qty, focused])

  // FIX: keep the "actual price" box in sync whenever the discount % (or
  // the underlying listed price) changes from elsewhere — e.g. after the
  // role-based clamp in onUpdate adjusts what we asked for.
  useEffect(() => {
    if (!priceFocused) setPriceInput(String(Math.round(effectivePrice)))
  }, [item.discount_pct, item.unit_price, priceFocused])

  const handleQtyChange = (val) => {
    setQtyInput(val)
    const n = parseFloat(val)
    if (!isNaN(n) && n > 0) onUpdate(item.product_id, 'qty', n)
  }

  // FIX: entering a real shillings price here computes the equivalent
  // discount % and pushes it through the SAME onUpdate('discount_pct', ...)
  // path the % field uses — so the existing role-based cap (10% cashier /
  // 50% owner) still applies no matter which box was used to get there.
  // Typing a price above the listed price just floors back to 0% (the
  // listed price) since this field can't create a markup.
  const handlePriceChange = (val) => {
    setPriceInput(val)
    const n = parseFloat(val)
    if (isNaN(n) || n < 0 || item.unit_price <= 0) return
    const pct = Math.max(0, (1 - n / item.unit_price) * 100)
    onUpdate(item.product_id, 'discount_pct', pct)
  }

  const lineTotal = (parseFloat(item.qty) || 0) * item.unit_price * (1 - item.discount_pct / 100)

  return (
    <div className={`cart-item ${focused ? 'cart-item-focused' : ''}`}>
      <div className="flex justify-between items-center">
        <div className="cart-item-name truncate" style={{maxWidth:'65%'}}>{item.name}</div>
        <button
          className="btn btn-ghost btn-icon cart-remove-btn"
          onClick={() => onRemove(item.product_id)}
        >✕</button>
      </div>
      <div className="cart-item-sku">{item.sku}</div>

      <div className="cart-item-controls">
        {/* Quantity controls */}
        <button
          className="qty-btn"
          onClick={() => {
            if (item.qty <= 1) onRemove(item.product_id)
            else onUpdate(item.product_id, 'qty', item.qty - 1)
          }}
        >−</button>

        <div className={`qty-input-wrapper ${focused ? 'focused' : ''}`}>
          <input
            className="input qty-input"
            type="number"
            min="0.001"
            step="any"
            value={qtyInput}
            onChange={e => handleQtyChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              const n = parseFloat(qtyInput)
              if (isNaN(n) || n <= 0) {
                setQtyInput('1')
                onUpdate(item.product_id, 'qty', 1)
              } else {
                setQtyInput(String(Math.min(n, item.stock)))
              }
            }}
          />
          <span className="qty-unit">{item.unit_type || 'pc'}</span>
        </div>

        <button
          className="qty-btn"
          onClick={() => onUpdate(item.product_id, 'qty', Math.min(item.qty + 1, item.stock))}
        >+</button>

        {/* Discount */}
        <div className="disc-wrapper">
          <input
            className="input disc-input"
            type="number"
            min="0"
            max={role === 'cashier' ? 10 : 50}
            value={item.discount_pct}
            onChange={e => onUpdate(item.product_id, 'discount_pct', e.target.value)}
            title="Punguzo %"
          />
          <span className="disc-label">%</span>
        </div>

        <span className="cart-item-total">{formatMoney(lineTotal, currency)}</span>
      </div>

      {/* FIX: real-price entry — typing a shillings amount here automatically
          back-calculates the equivalent discount %, going through the same
          clamp the % field uses. Editing % still works exactly as before;
          this row just stays in sync with whichever one was used last. */}
      <div className="cart-item-controls" style={{marginTop:6}}>
        <span style={{fontSize:11,color:'var(--text3)',minWidth:60}}>Bei halisi</span>
        <div className="qty-input-wrapper">
          <input
            className="input qty-input"
            type="number"
            min="0"
            step="any"
            value={priceInput}
            onChange={e => handlePriceChange(e.target.value)}
            onFocus={() => setPriceFocused(true)}
            onBlur={() => setPriceFocused(false)}
            title="Bei halisi ya kuuza"
          />
        </div>
        <span style={{fontSize:10,color:'var(--text3)'}}>kati ya {formatMoney(item.unit_price, currency)}</span>
      </div>

      {/* Stock warning */}
      {item.qty >= item.stock && (
        <div style={{fontSize:10,color:'var(--amber)',marginTop:4}}>⚠️ Kiwango cha juu cha akiba</div>
      )}
    </div>
  )
}

function Receipt({
  data, currency }) {
  const T = useT()
  return (
    <div className="receipt" id="receipt-print">
      {data.logoImage && (
        <div style={{textAlign:'center',marginBottom:6}}>
          <img src={data.logoImage} alt="logo" style={{maxHeight:60,maxWidth:120,objectFit:'contain'}} />
        </div>
      )}
      <div className="receipt-logo">{data.shopName || 'MotoShop'}</div>
      <div style={{textAlign:'center',fontSize:10,marginBottom:4}}>{T('pos_receipt_subtitle')}</div>
      {data.offline && (
        <div style={{textAlign:'center',fontSize:10,fontWeight:700,color:'#b45309',background:'#fef3c7',borderRadius:4,padding:'3px 6px',margin:'4px 0'}}>
          📴 Nje ya mtandao — itasawazishwa
        </div>
      )}
      <div className="receipt-divider" />
      <div className="receipt-row"><span>{data.receipt_no}</span><span>{new Date(data.sale_date).toLocaleDateString()}</span></div>
      {data.customerName && <div className="receipt-row"><span>{T('pos_receipt_customer')}</span><span>{data.customerName}</span></div>}
      <div className="receipt-divider" />
      {data.items.map((item,i) => (
        <div key={i}>
          <div style={{fontSize:11,marginBottom:1}}>{item.name}</div>
          <div className="receipt-row" style={{paddingLeft:8,color:'#555'}}>
            <span>{item.qty} × {item.unit_price.toLocaleString()}{item.discount_pct>0?` (-${item.discount_pct}%)`:''}</span>
            <span>{Math.round(item.qty * item.unit_price * (1-item.discount_pct/100)).toLocaleString()}</span>
          </div>
        </div>
      ))}
      <div className="receipt-divider" />
      {data.vatOn && data.vatAmt > 0 && (
        <div className="receipt-row"><span>VAT ({data.vatRate}%)</span><span>{Math.round(data.vatAmt).toLocaleString()}</span></div>
      )}
      <div className="receipt-row receipt-total"><span>JUMLA</span><span>{currency} {Math.round(data.total).toLocaleString()}</span></div>
      {!data.isCredit && <div className="receipt-row"><span>{T('pos_receipt_paid')} ({data.payMethod === 'cash' ? 'Taslimu' : data.payMethod})</span><span>{currency} {Math.round(data.amountPaid).toLocaleString()}</span></div>}
      {data.change > 0 && <div className="receipt-row"><span>Chenji</span><span>{currency} {Math.round(data.change).toLocaleString()}</span></div>}
      {data.isCredit && <div className="receipt-row" style={{color:'#c00'}}><span>{T('pos_receipt_credit')}</span><span></span></div>}
      <div className="receipt-divider" />
      <div style={{textAlign:'center',fontSize:10,color:'#666'}}>{data.receiptFooter || 'Asante kwa biashara yako!'}</div>
    </div>
  )
}
