const pool = require('../config/db');
const P = require('../config/prefix');
const { parseList, listResponse } = require('../utils/listParams');
const { resolveDateRange, formatKolkataDate } = require('../utils/dateRange');
const { unserializePhp } = require('../utils/php');
const { httpError } = require('../utils/httpError');
const orderService = require('./orderService');
const { ensureInvoiceNumber } = require('./invoiceService');
const PDFDocument = require('pdfkit');
// const { htmlToPdfBuffer, toBuffer } = require('./pdfService');
const { sendMail } = require('./mailService');
const env = require('../config/env');
const fs = require('fs');
const path = require('path');

const GENERIC_CATEGORY =
  /^(uniforms?|sports?|sportswear|shirts?|pants?|trousers?|skirts?|jackets?|belts?|socks?|tracks?|track-?pants?|t-?shirts?|sweaters?|accessories|collections?|daily|winter|summer|boys?|girls?|schoolwear|corporate|general)$/i;

let logoDataUriCache = null;

const SORT = {
  id: 'o.id',
  date: 'o.date_created_gmt',
  total: 'o.total_amount',
  invoice: 'invoice_number',
};

const SHOP = {
  name: 'BrassLeaf',
  address:
    '6-3-666/B, Pillar No. #1118 Erramanzil Road, Panjagutta, Hyderabad – 500082, Opp Nims Hospital',
  gstin: '36AACFB1506E1Z5',
  footer: 'Note: Any exchanges should be done at the BrassLeaf, Punjagutta store only',
};

let shopSettingsLoaded = false;

async function loadShopSettings() {
  if (shopSettingsLoaded) return SHOP;
  try {
    const [[row]] = await pool.query(
      `SELECT option_value FROM ${P}options WHERE option_name = 'wpo_wcpdf_settings_general' LIMIT 1`
    );
    const settings = unserializePhp(row?.option_value) || {};
    if (settings.shop_name?.default) SHOP.name = settings.shop_name.default;
    if (settings.shop_address_additional?.default) SHOP.address = settings.shop_address_additional.default;
    const gst = settings.shop_address_additional?.default || '';
    const gstMatch = gst.match(/GSTIN:\s*([A-Z0-9]+)/i);
    if (gstMatch) SHOP.gstin = gstMatch[1];
    const footer = settings.footer?.default;
    if (footer) SHOP.footer = footer;
  } catch {
    /* use defaults */
  }
  shopSettingsLoaded = true;
  return SHOP;
}

function parseIdList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amount) {
  const n = Number(amount);
  if (Number.isNaN(n)) return '₹0.00';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLongDate(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return String(dt);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

async function fetchProductSku(productId) {
  if (!productId) return null;
  const [[row]] = await pool.query(
    `SELECT meta_value FROM ${P}postmeta WHERE post_id = ? AND meta_key = '_sku' LIMIT 1`,
    [productId]
  );
  return row?.meta_value || null;
}

async function resolveInstitutionName(order) {
  const company =
    order.billing?.company ||
    order.shipping?.company ||
    '';
  if (String(company).trim()) {
    return String(company).trim();
  }

  const productIds = [
    ...new Set(
      (order.line_items || [])
        .map((item) => item.product_id)
        .filter(Boolean)
    ),
  ];

  for (const productId of productIds) {
    const school = await resolveSchoolFromProduct(productId);
    if (school) return school;
  }

  return null;
}

async function walkCategoryChain(termId) {
  const chain = [];
  let current = Number(termId) || 0;

  while (current) {
    const [[row]] = await pool.query(
      `SELECT t.term_id, t.name, tt.parent
       FROM ${P}terms t
       JOIN ${P}term_taxonomy tt ON tt.term_id = t.term_id AND tt.taxonomy = 'product_cat'
       WHERE t.term_id = ?
       LIMIT 1`,
      [current]
    );
    if (!row) break;
    chain.push({ term_id: row.term_id, name: row.name, parent: Number(row.parent) || 0 });
    current = Number(row.parent) || 0;
  }

  return chain;
}

function pickSchoolName(chain) {
  if (!chain.length) return null;

  for (const node of chain) {
    if (/school|academy|college|institution|international|green/i.test(String(node.name))) {
      return node.name;
    }
  }

  const root = chain[chain.length - 1];
  if (root && !GENERIC_CATEGORY.test(String(root.name).trim())) {
    return root.name;
  }

  if (chain.length > 1) {
    const parent = chain[chain.length - 2];
    if (parent && !GENERIC_CATEGORY.test(String(parent.name).trim())) {
      return parent.name;
    }
  }

  return null;
}

async function resolveSchoolFromProduct(productId) {
  const [cats] = await pool.query(
    `SELECT t.term_id, t.name, tt.parent
     FROM ${P}term_relationships tr
     JOIN ${P}term_taxonomy tt
       ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_cat'
     JOIN ${P}terms t ON t.term_id = tt.term_id
     WHERE tr.object_id = ?`,
    [productId]
  );

  for (const cat of cats) {
    const chain = await walkCategoryChain(cat.term_id);
    const school = pickSchoolName(chain);
    if (school) return school;
  }

  return null;
}

function getLogoDataUri() {
  if (logoDataUriCache) {
    return logoDataUriCache;
  }

  const logoPath = path.join(
    __dirname,
    '../../assets/logo1.jpg'
  );

  if (!fs.existsSync(logoPath)) {
    console.error(
      'PDF logo not found:',
      logoPath
    );

    return '';
  }

  const base64 =
    fs.readFileSync(logoPath)
      .toString('base64');

  logoDataUriCache =
    `data:image/jpeg;base64,${base64}`;

  return logoDataUriCache;
}


function documentStyles() {
  return `
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    padding: 36px 44px 40px;
  }
  .page-break { page-break-after: always; break-after: page; height: 0; }
  .top-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 28px;
  margin-bottom: 42px;
}

.logo-img {
  width: 145px;
  height: 72px;
  object-fit: contain;
  object-position: left top;
  display: block;
}

.shop-block {
  text-align: left;
  font-size: 12px;
  color: #222;
  line-height: 1.55;
  width: 280px;
}
  .shop-name { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
  .title {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin: 0 0 24px;
  }
  .grid {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 40px;
    margin-bottom: 28px;
  }
  .address {
    flex: 1;
    line-height: 1.6;
    text-align: left;
    min-width: 0;
  }
  .meta {
    width: 280px;
    flex-shrink: 0;
    text-align: left;
    font-size: 12px;
    line-height: 1.65;
  }
  .meta p { margin: 0 0 5px; }
  .meta .label { font-weight: 700; }
  .institution {
    font-weight: 700;
    font-size: 13px;
    margin: 0 0 10px !important;
    letter-spacing: 0.04em;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
  }
  thead th {
    background: #000;
    color: #fff;
    font-weight: 700;
    text-align: left;
    padding: 10px 12px;
    font-size: 13px;
  }
  thead th.num { text-align: right; }
  tbody td {
    border-bottom: 1px solid #d9d9d9;
    padding: 10px 12px;
    vertical-align: top;
  }
  tbody td.num { text-align: right; white-space: nowrap; }
  .item-name { font-weight: 700; margin-bottom: 2px; }
  .item-meta { font-size: 11px; color: #444; line-height: 1.45; }
  .totals {
    margin-top: 22px;
    margin-left: auto;
    width: 320px;
    font-size: 13px;
  }
  .totals-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 0;
  }
  .total-line {
    border-top: 1px solid #111;
    border-bottom: 1px solid #111;
    margin-top: 8px;
    padding: 8px 0;
    font-weight: 700;
    font-size: 14px;
  }
  .tax-note {
    text-align: right;
    font-size: 11px;
    color: #444;
    margin-top: 8px;
  }
  .footer-wrap {
    margin-top: 40px;
    border-top: 1px solid #bbb;
    padding-top: 16px;
    text-align: center;
    font-size: 12px;
    color: #333;
  }`;
}

async function buildDocumentBody(order, type) {
  await loadShopSettings();
  const enriched = await enrichOrder(order);
  const isInvoice = type === 'invoice';
  const title = isInvoice ? 'INVOICE' : 'PACKING SLIP';
  const billing = enriched.billing;
  const shipping = enriched.shipping || billing;
  const addr = isInvoice ? billing : shipping;
  const logoUri = getLogoDataUri();

  const productRows = enriched.line_items
    .map((item) => {
      const qty = Number(item.qty) || 0;
      const total = Number(item.line_total) || 0;
      const unit = qty > 0 ? total / qty : total;
      const size = item.size ? `<div class="item-meta">size: ${esc(item.size)}</div>` : '';
      const skuLine =
        item.sku || item.hsn
          ? `<div class="item-meta">${item.sku ? `SKU: ${esc(item.sku)}` : ''}${item.sku && item.hsn ? ' | ' : ''}${item.hsn ? `HSN : ${esc(item.hsn)}` : ''}</div>`
          : '';

      if (isInvoice) {
        return `<tr>
          <td><div class="item-name">${esc(item.order_item_name)}</div>${size}${skuLine}</td>
          <td class="num">${qty}</td>
          <td class="num">${formatMoney(unit)}</td>
        </tr>`;
      }

      return `<tr>
        <td><div class="item-name">${esc(item.order_item_name)}</div>${size}${skuLine}</td>
        <td class="num">${qty}</td>
      </tr>`;
    })
    .join('');

  const taxParts = enriched.taxes
    .filter((t) => t.amount > 0)
    .map((t) => {
      const rate = t.rate ? `${t.rate}% ` : '';
      const label = String(t.label || '').replace(/^IN-\d+(?:\.\d+)?%\s*/i, '');
      return `${formatMoney(t.amount)} ${rate}${esc(label)}`;
    });

  const taxSummary = taxParts.length ? `(includes ${taxParts.join(', ')})` : '';

  const institutionBlock =
    isInvoice && enriched.institution_name
      ? `<p class="institution">${esc(String(enriched.institution_name).toUpperCase())}</p>`
      : '';

  const docBlock = isInvoice
    ? `${institutionBlock}
       <p><span class="label">Invoice Number:</span> ${esc(enriched.invoice_number)}</p>
       <p><span class="label">Invoice Date:</span> ${esc(formatLongDate(enriched.invoice_date))}</p>
       <p><span class="label">Order Number:</span> ${esc(enriched.id)}</p>
       <p><span class="label">Order Date:</span> ${esc(formatLongDate(enriched.date_created_gmt))}</p>
       <p><span class="label">Payment Method:</span> ${esc(enriched.payment_method_title || enriched.payment_method || '—')}</p>`
    : `<p><span class="label">Order Number:</span> ${esc(enriched.id)}</p>
       <p><span class="label">Order Date:</span> ${esc(formatLongDate(enriched.date_created_gmt))}</p>
       <p><span class="label">Shipping Method:</span> ${esc(enriched.shipping_label)}</p>`;

  const totals = isInvoice
    ? `<div class="totals">
         <div class="totals-row"><span>Subtotal</span><span>${formatMoney(enriched.subtotal)}</span></div>
         <div class="totals-row"><span>Shipping</span><span>${formatMoney(enriched.shipping_cost)} via ${esc(enriched.shipping_label)}</span></div>
         <div class="totals-row total-line"><span>Total</span><span>${formatMoney(enriched.total_amount)}</span></div>
         ${taxSummary ? `<div class="tax-note">${taxSummary}</div>` : ''}
       </div>`
    : '';

    const logoHtml = logoUri
  ? `
      <img
        class="logo-img"
        src="${logoUri}"
        alt="Brass Leaf"
      />
    `
  : '';
  // const logoHtml = logoUri
  //   ? `<img class="logo-img" src="${logoUri}" alt="Brass Leaf"/>`
  //   : `<div style="width:150px;height:60px;background:#243346;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">Brass Leaf</div>`;

  return `<section class="doc-section">
  <div class="top-row">
    <div>${logoHtml}</div>
    <div class="shop-block">
      <div class="shop-name">${esc(SHOP.name)}</div>
      <div>${esc(SHOP.address)}</div>
      <div>GSTIN: ${esc(SHOP.gstin)}</div>
    </div>
  </div>

  <div class="title">${title}</div>

  <div class="grid">
    <div class="address">
      ${addressLines(addr).map((l) => `<div>${esc(l)}</div>`).join('')}
    </div>
    <div class="meta">${docBlock}</div>
  </div>

  <table>
    <thead><tr>
      <th>Product</th>
      <th class="num">Quantity</th>
      ${isInvoice ? '<th class="num">Price</th>' : ''}
    </tr></thead>
    <tbody>${productRows}</tbody>
  </table>

  ${totals}

  <div class="footer-wrap">${esc(SHOP.footer)}</div>
</section>`;
}

async function buildDocumentHtml(order, type) {
  const body = await buildDocumentBody(order, type);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>${documentStyles()}</style></head><body>${body}</body></html>`;
}
async function buildCombinedDailyHtml(
  orderIds
) {
  const sections = [];

  for (
    let i = 0;
    i < orderIds.length;
    i++
  ) {
    const orderId =
      orderIds[i];

    const order =
      await orderService.getById(
        orderId
      );

    // Invoice
    sections.push(
      await buildDocumentBody(
        order,
        'invoice'
      )
    );

    // Packing slip starts new page
    sections.push(
      '<div class="page-break"></div>'
    );

    // Packing slip
    sections.push(
      await buildDocumentBody(
        order,
        'packing-slip'
      )
    );

    // Next order starts new page,
    // but don't add blank page at end
    if (
      i <
      orderIds.length - 1
    ) {
      sections.push(
        '<div class="page-break"></div>'
      );
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>

  <style>
    ${documentStyles()}
  </style>
</head>

<body>
  ${sections.join('\n')}
</body>
</html>`;
}
// async function buildCombinedDailyHtml(orderIds) {
//   const sections = [];
//   for (const orderId of orderIds) {
//     const order = await orderService.getById(orderId);
//     sections.push(await buildDocumentBody(order, 'invoice'));
//     sections.push('<div class="page-break"></div>');
//     sections.push(await buildDocumentBody(order, 'packing-slip'));
//     sections.push('<div class="page-break"></div>');
//   }

//   return `<!DOCTYPE html>
// <html><head><meta charset="utf-8"/>
// <style>${documentStyles()}</style></head><body>${sections.join('\n')}</body></html>`;
// }

function parseHsn(name, sku) {
  const fromName = String(name || '').match(/HSN\s*:\s*(\d+)/i);
  if (fromName) return fromName[1];
  return null;
}

function addressLines(addr) {
  if (!addr) return [];
  return [
    [addr.first_name, addr.last_name].filter(Boolean).join(' '),
    addr.company,
    addr.address_1,
    addr.address_2,
    [addr.city, addr.postcode].filter(Boolean).join(' '),
    addr.state,
    addr.email,
    addr.phone,
  ].filter(Boolean);
}

async function enrichOrder(order) {
  const [taxRows] = await pool.query(
    `SELECT oi.order_item_id, oi.order_item_name,
            MAX(CASE WHEN oim.meta_key = 'tax_amount' THEN oim.meta_value END) AS tax_amount,
            MAX(CASE WHEN oim.meta_key = 'label' THEN oim.meta_value END) AS label,
            MAX(CASE WHEN oim.meta_key = 'rate_percent' THEN oim.meta_value END) AS rate_percent
     FROM ${P}woocommerce_order_items oi
     LEFT JOIN ${P}woocommerce_order_itemmeta oim ON oim.order_item_id = oi.order_item_id
     WHERE oi.order_id = ? AND oi.order_item_type = 'tax'
     GROUP BY oi.order_item_id, oi.order_item_name`,
    [order.id]
  );

  const [invoiceMeta] = await pool.query(
    `SELECT meta_key, meta_value FROM ${P}wc_orders_meta
     WHERE order_id = ? AND meta_key IN (
       '_wcpdf_invoice_number', '_wcpdf_invoice_date_formatted', '_wcpdf_invoice_date'
     )`,
    [order.id]
  );
  const metaMap = {};
  for (const m of invoiceMeta) metaMap[m.meta_key] = m.meta_value;

  const lineItems = await Promise.all(
    (order.line_items || []).map(async (item) => {
      let sku = item.sku || null;
      if (!sku && item.product_id) {
        sku = await fetchProductSku(item.product_id);
      }
      return {
        ...item,
        sku,
        hsn: parseHsn(item.order_item_name, sku),
      };
    })
  );

  const shippingCost = (order.shipping_items || []).reduce(
    (sum, s) => sum + (Number(s.cost) || 0),
    0
  );
  const shippingLabel = order.shipping_items?.[0]?.order_item_name || 'Flat rate';
  const subtotal = lineItems.reduce((sum, i) => sum + (Number(i.line_total) || 0), 0);
  const taxes = taxRows.map((t) => ({
    label: t.label || t.order_item_name,
    amount: Number(t.tax_amount) || 0,
    rate: t.rate_percent,
  }));

  // Resolve invoice number, backfilling for orders reconciled before
  // invoice generation was wired into the payment flow (e.g. legacy
  // pending -> success transitions that bypassed WordPress hooks).
  const eligibleForInvoice = ['wc-processing', 'wc-completed'].includes(order.status);
  let invoiceNumber = metaMap._wcpdf_invoice_number || order.invoice_number || null;
  let invoiceDate = metaMap._wcpdf_invoice_date_formatted || order.invoice_date || null;

  if (!invoiceNumber && eligibleForInvoice) {
    try {
      const result = await ensureInvoiceNumber(order.id);
      invoiceNumber = String(result.invoiceNumber);
      invoiceDate = invoiceDate || result.invoiceDate || null;
    } catch (e) {
      console.error('Could not backfill invoice number for order', order.id, e.message);
    }
  }

  return {
    ...order,
    line_items: lineItems,
    taxes,
    subtotal,
    shipping_cost: shippingCost,
    shipping_label: shippingLabel,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate || order.date_created_gmt,
    packing_slip_number: order.id,
    customer_name: order.billing
      ? [order.billing.first_name, order.billing.last_name].filter(Boolean).join(' ')
      : null,
    institution_name: await resolveInstitutionName(order),
  };
}

function moneyText(amount) {
  const n = Number(amount || 0);

  return `Rs. ${n.toLocaleString(
    'en-IN',
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function pdfDate(value) {
  if (!value) {
    return '—';
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return String(value);
  }

  return d.toLocaleDateString(
    'en-IN',
    {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }
  );
}


function getPdfLogoPath() {
  const logoPath = path.join(
    __dirname,
    '../../assets/logo1.jpg'
  );

  if (!fs.existsSync(logoPath)) {
    console.error(
      'PDF logo not found:',
      logoPath
    );

    return null;
  }

  return logoPath;
}

function getSecondPdfLogoPath() {
  const logoPath = path.join(
    __dirname,
    '../../assets/logo.jpg'
  );

  if (!fs.existsSync(logoPath)) {
    console.error(
      'Second PDF logo not found:',
      logoPath
    );

    return null;
  }

  return logoPath;
}

function createPdfDocument() {
  return new PDFDocument({
    size: 'A4',
    margins: {
      top: 36,
      bottom: 40,
      left: 44,
      right: 44,
    },
    bufferPages: true,
  });
}

function collectPdfBuffer(doc) {
  return new Promise(
    (resolve, reject) => {
      const chunks = [];

      doc.on(
        'data',
        (chunk) => {
          chunks.push(chunk);
        }
      );

      doc.on(
        'end',
        () => {
          resolve(
            Buffer.concat(chunks)
          );
        }
      );

      doc.on(
        'error',
        reject
      );
    }
  );
}

function ensurePdfSpace(
  doc,
  requiredHeight = 100
) {
  const bottom =
    doc.page.height -
    doc.page.margins.bottom;

  if (
    doc.y + requiredHeight >
    bottom
  ) {
    doc.addPage();
  }
}

function drawPdfHeader(
  doc,
  order,
  type
) {
  const isInvoice =
    type === 'invoice';

  const logoPath =
    getPdfLogoPath();

  const secondLogoPath =
  getSecondPdfLogoPath();

  const startY =
    doc.page.margins.top;

  if (logoPath) {
    try {
      
      doc.image(
  logoPath,
  doc.page.margins.left,
  startY,
  {
    fit: [125, 60],
    align: 'left',
    valign: 'top',
  }
);
    } catch (error) {
      console.error(
        'Unable to add PDF logo:',
        error.message
      );
    }
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(
        SHOP.name,
        doc.page.margins.left,
        startY
      );
  }

  // const shopX = 310;
  const shopX = 300;
const shopWidth = 250;

doc
  .font('Helvetica-Bold')
  .fontSize(10)
  .fillColor('#111111')
  .text(
    SHOP.name,
    shopX,
    startY,
    {
      width: shopWidth,
    }
  );

doc
  .font('Helvetica')
  .fontSize(8.5)
  .text(
    SHOP.address,
    shopX,
    startY + 18,
    {
      width: shopWidth,
      lineGap: 2,
    }
  );

// GSTIN already address lo unte malli print cheyyakudadhu
if (
  SHOP.gstin &&
  !String(SHOP.address || '')
    .toUpperCase()
    .includes(
      String(SHOP.gstin).toUpperCase()
    )
) {
  doc.text(
    `GSTIN: ${SHOP.gstin}`,
    shopX,
    startY + 62,
    {
      width: shopWidth,
    }
  );
}

doc.y = startY + 110;
  // doc
  //   .font('Helvetica-Bold')
  //   .fontSize(10)
  //   .fillColor('#111111')
  //   .text(
  //     SHOP.name,
  //     shopX,
  //     startY,
  //     {
  //       width: 240,
  //     }
  //   );

  // doc
  //   .font('Helvetica')
  //   .fontSize(8.5)
  //   .text(
  //     SHOP.address,
  //     shopX,
  //     startY + 18,
  //     {
  //       width: 240,
  //       lineGap: 2,
  //     }
  //   );

  // doc.text(
  //   `GSTIN: ${SHOP.gstin}`,
  //   shopX,
  //   startY + 58,
  //   {
  //     width: 240,
  //   }
  // );

  // doc.y =
  //   startY + 105;

  // doc
  //   .font('Helvetica-Bold')
  //   .fontSize(20)
  //   .fillColor('#111111')
  //   .text(
  //     isInvoice
  //       ? 'INVOICE'
  //       : 'PACKING SLIP'
  //   );
const titleY = doc.y;

doc
  .font('Helvetica-Bold')
  .fontSize(20)
  .fillColor('#111111')
  .text(
    isInvoice
      ? 'INVOICE'
      : 'PACKING SLIP',
    44,
    titleY,
    {
      width: 250,
      align: 'left',
    }
  );

if (secondLogoPath) {
  try {
    doc.image(
      secondLogoPath,
      355,
      titleY - 5,
      {
        fit: [145, 65],
        align: 'left',
        valign: 'top',
      }
    );
  } catch (error) {
    console.error(
      'Unable to add second PDF logo:',
      error.message
    );
  }
}

doc.y = titleY + 65;

  doc.moveDown(1);
}

function drawAddressAndMeta(
  doc,
  order,
  type
) {
  const isInvoice =
    type === 'invoice';

  const billing =
    order.billing || {};

  const shipping =
    order.shipping || billing;

  const address =
    isInvoice
      ? billing
      : shipping;

  const startY = doc.y;

  /*
   * LEFT SIDE - CUSTOMER ADDRESS
   */
  const addressX = 44;
  const addressWidth = 245;

  const lines =
    addressLines(address);

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#111111');

  let addressY = startY;

  for (const line of lines) {
    doc.text(
      String(line),
      addressX,
      addressY,
      {
        width: addressWidth,
        lineGap: 2,
      }
    );

    addressY =
      doc.y + 4;
  }

  /*
   * RIGHT SIDE - ORDER / INVOICE DETAILS
   */
  const metaX = 310;
  const labelWidth = 105;
  const valueX = 420;
  const valueWidth = 130;

  let metaY = startY;

  if (
    isInvoice &&
    order.institution_name
  ) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor('#111111')
      .text(
        String(
          order.institution_name
        ).toUpperCase(),
        metaX,
        metaY,
        {
          width: 240,
        }
      );

    metaY =
      doc.y + 8;
  }

  const metaRows =
    isInvoice
      ? [
          [
            'Invoice Number',
            order.invoice_number || '—',
          ],
          [
            'Invoice Date',
            pdfDate(
              order.invoice_date
            ),
          ],
          [
            'Order Number',
            order.id || '—',
          ],
          [
            'Order Date',
            pdfDate(
              order.date_created_gmt
            ),
          ],
          [
            'Payment Method',
            order.payment_method_title ||
              order.payment_method ||
              '—',
          ],
        ]
      : [
          [
            'Order Number',
            order.id || '—',
          ],
          [
            'Order Date',
            pdfDate(
              order.date_created_gmt
            ),
          ],
          [
            'Shipping Method',
            order.shipping_label ||
              'Flat rate',
          ],
        ];

  for (
    const [label, value]
    of metaRows
  ) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9);

    const labelHeight =
      doc.heightOfString(
        `${label}:`,
        {
          width: labelWidth,
        }
      );

    doc
      .font('Helvetica')
      .fontSize(9);

    const valueHeight =
      doc.heightOfString(
        String(value ?? '—'),
        {
          width: valueWidth,
        }
      );

    const rowHeight =
      Math.max(
        labelHeight,
        valueHeight,
        13
      );

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#111111')
      .text(
        `${label}:`,
        metaX,
        metaY,
        {
          width: labelWidth,
        }
      );

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#111111')
      .text(
        String(value ?? '—'),
        valueX,
        metaY,
        {
          width: valueWidth,
          lineGap: 1,
        }
      );

    metaY +=
      rowHeight + 7;
  }

  /*
   * Product table starts only
   * after both columns finish.
   */
  doc.y =
    Math.max(
      addressY,
      metaY
    ) + 18;
}
function drawItemsHeader(
  doc,
  type
) {
  const isInvoice =
    type === 'invoice';

  ensurePdfSpace(
    doc,
    70
  );

  const y = doc.y;

  /* =====================================================
     HEADER TEXT
     - No black background
     - Black text
  ===================================================== */

  doc
    .fillColor('#111111')
    .font('Helvetica-Bold')
    .fontSize(9);

  /* PRODUCT */

  doc.text(
    'Product',
    55,
    y + 7,
    {
      width:
        isInvoice
          ? 290
          : 390,
    }
  );

  /* QUANTITY */

  doc.text(
    'Quantity',
    isInvoice
      ? 365
      : 445,
    y + 7,
    {
      width: 60,
      align: 'right',
    }
  );

  /* PRICE - INVOICE ONLY */

  if (isInvoice) {
    doc.text(
      'Price',
      455,
      y + 7,
      {
        width: 85,
        align: 'right',
      }
    );
  }

  /* =====================================================
     UNDERLINE BELOW TABLE HEADER
  ===================================================== */

  doc
    .moveTo(
      44,
      y + 25
    )
    .lineTo(
      551,
      y + 25
    )
    .lineWidth(0.8)
    .strokeColor('#111111')
    .stroke();

  /* Reset normal color */

  doc
    .fillColor('#111111');

  /* Space before first product */

  doc.y =
    y + 35;
}



function drawOrderItems(
  doc,
  order,
  type
) {
  const isInvoice =
    type === 'invoice';

  drawItemsHeader(
    doc,
    type
  );

  const items =
    order.line_items || [];

  for (const item of items) {
    ensurePdfSpace(
      doc,
      65
    );


    if (
      doc.y <
      doc.page.margins.top +
        20
    ) {
      drawItemsHeader(
        doc,
        type
      );
    }

    const qty =
      Number(item.qty) || 0;

    const total =
      Number(
        item.line_total
      ) || 0;

    const unit =
      qty > 0
        ? total / qty
        : total;

    const rowY =
      doc.y;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#111111')
      .text(
        item.order_item_name ||
          'Product',
        55,
        rowY,
        {
          width:
            isInvoice
              ? 280
              : 370,
        }
      );

    let detailY =
      doc.y + 2;

    if (item.size) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor('#444444')
        .text(
          `Size: ${item.size}`,
          55,
          detailY,
          {
            width: 280,
          }
        );

      detailY =
        doc.y + 2;
    }

    const detailParts = [];

    if (item.sku) {
      detailParts.push(
        `SKU: ${item.sku}`
      );
    }

    if (item.hsn) {
      detailParts.push(
        `HSN: ${item.hsn}`
      );
    }

    if (
      detailParts.length
    ) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor('#444444')
        .text(
          detailParts.join(
            ' | '
          ),
          55,
          detailY,
          {
            width: 280,
          }
        );
    }

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#111111')
      .text(
        String(qty),
        isInvoice
          ? 350
          : 445,
        rowY,
        {
          width: 60,
          align: 'right',
        }
      );

    // if (isInvoice) {
    //   doc.text(
    //     moneyText(unit),
    //     445,
    //     rowY,
    //     {
    //       width: 95,
    //       align: 'right',
    //     }
    //   );
    // }
    if (isInvoice) {
  doc.text(
    moneyText(unit),
    455,
    rowY,
    {
      width: 85,
      align: 'right',
    }
  );
}

    const rowBottom =
      Math.max(
        doc.y,
        detailY + 20,
        rowY + 28
      );

    doc
      .moveTo(
        44,
        rowBottom
      )
      .lineTo(
        551,
        rowBottom
      )
      .strokeColor(
        '#d9d9d9'
      )
      .stroke();

    doc
      .strokeColor(
        '#000000'
      );

    doc.y =
      rowBottom + 10;
  }
}

function drawInvoiceTotals(
  doc,
  order
) {
  ensurePdfSpace(
    doc,
    150
  );

  doc.moveDown(1);

  const x = 330;

  const valueX = 445;

  let y = doc.y;

  const row = (
    label,
    value,
    bold = false
  ) => {
    doc
      .font(
        bold
          ? 'Helvetica-Bold'
          : 'Helvetica'
      )
      .fontSize(
        bold
          ? 10.5
          : 9
      )
      .fillColor(
        '#111111'
      )
      .text(
        label,
        x,
        y,
        {
          width: 105,
        }
      );

    doc.text(
      value,
      valueX,
      y,
      {
        width: 95,
        align: 'right',
      }
    );

    y +=
      bold
        ? 24
        : 19;
  };

  row(
    'Subtotal',
    moneyText(
      order.subtotal
    )
  );

  row(
    'Shipping',
    `${moneyText(
      order.shipping_cost
    )}`
  );

  doc
    .moveTo(
      x,
      y
    )
    .lineTo(
      540,
      y
    )
    .stroke();

  y += 9;

  row(
    'Total',
    moneyText(
      order.total_amount
    ),
    true
  );

  const taxParts =
    (order.taxes || [])
      .filter(
        (tax) =>
          Number(tax.amount) >
          0
      )
      .map((tax) => {
        const rate =
          tax.rate
            ? `${tax.rate}% `
            : '';

        const label =
          String(
            tax.label || ''
          ).replace(
            /^IN-\d+(?:\.\d+)?%\s*/i,
            ''
          );

        return `${moneyText(
          tax.amount
        )} ${rate}${label}`;
      });

  if (taxParts.length) {
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#444444')
      .text(
        `(includes ${taxParts.join(
          ', '
        )})`,
        x,
        y,
        {
          width: 210,
          align: 'right',
        }
      );

    y =
      doc.y + 8;
  }

  doc.y =
    y;
}

function drawPdfFooter(
  doc
) {
  ensurePdfSpace(
    doc,
    70
  );

  doc.moveDown(2);

  const y =
    doc.y;

  doc
    .moveTo(
      44,
      y
    )
    .lineTo(
      551,
      y
    )
    .strokeColor(
      '#bbbbbb'
    )
    .stroke();

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#333333')
    .text(
      SHOP.footer,
      44,
      y + 15,
      {
        width: 507,
        align: 'center',
      }
    );

  doc
    .strokeColor(
      '#000000'
    )
    .fillColor(
      '#111111'
    );

  doc.y =
    y + 45;
}

async function addOrderToPdf(
  doc,
  rawOrder,
  type
) {
  await loadShopSettings();

  const order =
    await enrichOrder(
      rawOrder
    );

  drawPdfHeader(
    doc,
    order,
    type
  );

  drawAddressAndMeta(
    doc,
    order,
    type
  );

  drawOrderItems(
    doc,
    order,
    type
  );

  if (
    type === 'invoice'
  ) {
    drawInvoiceTotals(
      doc,
      order
    );
  }

  drawPdfFooter(
    doc
  );

  return order;
}

async function createOrderPdfBuffer(
  rawOrder,
  type
) {
  const doc =
    createPdfDocument();

  const promise =
    collectPdfBuffer(
      doc
    );

  const order =
    await addOrderToPdf(
      doc,
      rawOrder,
      type
    );

  doc.end();

  const pdf =
    await promise;

  return {
    pdf,
    order,
  };
}

async function createCombinedPdfBuffer(
  orderIds,
  type
) {
  const doc =
    createPdfDocument();

  const promise =
    collectPdfBuffer(
      doc
    );

  for (
    let i = 0;
    i < orderIds.length;
    i++
  ) {
    if (i > 0) {
      doc.addPage();
    }

    const order =
      await orderService.getById(
        orderIds[i]
      );

    await addOrderToPdf(
      doc,
      order,
      type
    );
  }

  doc.end();

  return promise;
}

function buildListQuery(req) {
  const { search } = parseList(req, SORT, 'date');

  const query = req?.query || {};

  const customerIds = parseIdList(
    query.customer_ids || query.customer_id
  );

  const orderIds = parseIdList(
    query.order_ids
  );

  // Normalize report date parameters before resolving the range.
  // Supports both snake_case and camelCase without changing
  // the existing frontend/API contract.
  const dateQuery = {
    ...query,

    range:
      query.range ||
      query.date_range ||
      'today',

    date:
      query.date ||
      query.select_date ||
      undefined,

    date_from:
      query.date_from ||
      query.dateFrom ||
      query.from ||
      undefined,

    date_to:
      query.date_to ||
      query.dateTo ||
      query.to ||
      undefined,
  };

  const range = resolveDateRange(dateQuery);

  const params = [];
  // let where = `o.type = 'shop_order'`;
  let where = `
  o.type = 'shop_order'
  AND o.status IN (
    'wc-processing',
    'wc-completed'
  )
`;

  if (customerIds.length) {
    where += ` AND o.customer_id IN (${customerIds.map(() => '?').join(',')})`;
    params.push(...customerIds);
  }
  if (orderIds.length) {
    where += ` AND o.id IN (${orderIds.map(() => '?').join(',')})`;
    params.push(...orderIds);
  }
  if (range.start && range.end) {
    where += ` AND o.date_created_gmt >= ? AND o.date_created_gmt <= ?`;
    params.push(range.start, range.end);
  }
  if (search) {
    where += ` AND (
      CAST(o.id AS CHAR) LIKE ? OR o.billing_email LIKE ?
      OR a.first_name LIKE ? OR a.last_name LIKE ?
      OR CAST(COALESCE(inv.calculated_number, invm.meta_value) AS CHAR) LIKE ?
      OR CAST(o.id AS CHAR) LIKE ?
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q, q, q);
  }

  const from = `
    FROM ${P}wc_orders o
    LEFT JOIN ${P}wc_order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
    LEFT JOIN ${P}wcpdf_invoice_number inv ON inv.order_id = o.id
    LEFT JOIN ${P}wc_orders_meta invm ON invm.order_id = o.id AND invm.meta_key = '_wcpdf_invoice_number'
    LEFT JOIN ${P}wc_orders_meta invd ON invd.order_id = o.id AND invd.meta_key = '_wcpdf_invoice_date_formatted'
    LEFT JOIN ${P}wc_customer_lookup cl ON cl.user_id = o.customer_id`;

  return { where, from, params, range, search };
}

async function list(req) {
  const { page, limit, offset, sortCol, dir } = parseList(req, SORT, 'date');
  const { where, from, params, range } = buildListQuery(req);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS total ${from} WHERE ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT
       o.id AS order_id, o.status, o.total_amount, o.currency, o.date_created_gmt,
       o.billing_email, o.customer_id, o.payment_method, o.payment_method_title,
       a.first_name, a.last_name,
       COALESCE(inv.calculated_number, CAST(invm.meta_value AS UNSIGNED)) AS invoice_number,
       COALESCE(inv.date, invd.meta_value) AS invoice_date,
       o.id AS packing_slip_number,
       o.date_created_gmt AS packing_slip_date
     ${from}
     WHERE ${where}
     ORDER BY ${sortCol} ${dir}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Backfill invoice numbers for eligible orders missing one
  // (e.g. orders reconciled to success before invoice generation
  // was wired into the payment flow).
  await Promise.all(
    rows.map(async (r) => {
      if (
        r.invoice_number == null &&
        ['wc-processing', 'wc-completed'].includes(r.status)
      ) {
        try {
          const result = await ensureInvoiceNumber(r.order_id);
          r.invoice_number = result.invoiceNumber;
          r.invoice_date = r.invoice_date || result.invoiceDate || null;
        } catch (e) {
          console.error('Could not backfill invoice number for order', r.order_id, e.message);
        }
      }
    })
  );

  const data = rows.map((r) => ({
    id: r.order_id,
    order_id: r.order_id,
    status: r.status,
    total_amount: r.total_amount,
    currency: r.currency,
    date_created_gmt: r.date_created_gmt,
    billing_email: r.billing_email,
    customer_id: r.customer_id,
    customer_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    payment_method: r.payment_method,
    payment_method_title: r.payment_method_title,
    invoice_number: r.invoice_number,
    invoice_date: r.invoice_date,
    packing_slip_number: r.packing_slip_number,
    packing_slip_date: r.packing_slip_date,
    has_invoice: true,
    has_packing_slip: true,
  }));

  return { ...listResponse(data, total, page, limit), range };
}
async function summary(req) {
  const { where, from, params, range } = buildListQuery(req);
  const [[row]] = await pool.query(
    `SELECT
       COUNT(DISTINCT o.id) AS order_count,
       ROUND(COALESCE(SUM(o.total_amount), 0), 2) AS total_sales,
       ROUND(COALESCE(SUM(CASE WHEN o.status NOT IN ('wc-refunded','wc-cancelled','wc-failed') THEN o.total_amount ELSE 0 END), 0), 2) AS total_collected,
       ROUND(COALESCE(SUM(CASE WHEN o.status = 'wc-refunded' THEN o.total_amount ELSE 0 END), 0), 2) AS refunded_amount,
       ROUND(COALESCE(SUM(o.total_amount - COALESCE(o.tax_amount, 0)), 0), 2) AS subtotal,
       ROUND(COALESCE(SUM(CASE WHEN o.status NOT IN ('wc-refunded','wc-cancelled','wc-failed') THEN o.total_amount ELSE 0 END), 0), 2) AS net_sales
     ${from}
     WHERE ${where}`,
    params
  );
  return { ...row, range };
}

async function resolveOrderIds(input = {}) {
  const orderIds =
    parseIdList(input.order_ids);

  const customerIds =
    parseIdList(input.customer_ids);

  /*
   * IMPORTANT:
   * When specific report rows are selected,
   * use those exact order IDs.
   *
   * Reports list already contains only
   * processing/completed orders.
   */
  if (orderIds.length) {
    return [...new Set(orderIds)];
  }

  const params = [];

  let where = `
    o.type = 'shop_order'
    AND o.status IN (
      'wc-processing',
      'wc-completed'
    )
  `;

  const range =
    resolveDateRange(input);

  if (customerIds.length) {
    where += `
      AND o.customer_id IN (
        ${customerIds
          .map(() => '?')
          .join(',')}
      )
    `;

    params.push(...customerIds);
  }

  if (range.start && range.end) {
    where += `
      AND o.date_created_gmt >= ?
      AND o.date_created_gmt <= ?
    `;

    params.push(
      range.start,
      range.end
    );
  }

  const from = `
    FROM ${P}wc_orders o

    LEFT JOIN ${P}wc_order_addresses a
      ON a.order_id = o.id
      AND a.address_type = 'billing'

    LEFT JOIN ${P}wcpdf_invoice_number inv
      ON inv.order_id = o.id

    LEFT JOIN ${P}wc_orders_meta invm
      ON invm.order_id = o.id
      AND invm.meta_key =
        '_wcpdf_invoice_number'

    LEFT JOIN ${P}wc_orders_meta invd
      ON invd.order_id = o.id
      AND invd.meta_key =
        '_wcpdf_invoice_date_formatted'

    LEFT JOIN ${P}wc_customer_lookup cl
      ON cl.user_id = o.customer_id
  `;

  const [rows] =
    await pool.query(
      `
        SELECT DISTINCT
          o.id

        ${from}

        WHERE ${where}

        ORDER BY
          o.date_created_gmt DESC
      `,
      params
    );

  return rows.map(
    (r) => r.id
  );
}
// async function resolveOrderIds(input = {}) {
//   const orderIds = parseIdList(input.order_ids);
//   const customerIds = parseIdList(input.customer_ids);
//   // if (orderIds.length) return [...new Set(orderIds)];

//   const params = [];
//   // let where = `o.type = 'shop_order'`;
//   let where = `
//   o.type = 'shop_order'
//   AND o.status IN (
//     'wc-processing',
//     'wc-completed'
//   )
// `;
//   const range = resolveDateRange(input);
//    if (orderIds.length) {
//     where += `
//       AND o.id IN (
//         ${orderIds
//           .map(() => '?')
//           .join(',')}
//       )
//     `;

//     params.push(...orderIds);
//   }

//   if (customerIds.length) {
//     where += ` AND o.customer_id IN (${customerIds.map(() => '?').join(',')})`;
//     params.push(...customerIds);
//   }
//   if (range.start && range.end) {
//     where += ` AND o.date_created_gmt >= ? AND o.date_created_gmt <= ?`;
//     params.push(range.start, range.end);
//   }

//   const from = `
//     FROM ${P}wc_orders o
//     LEFT JOIN ${P}wc_order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
//     LEFT JOIN ${P}wcpdf_invoice_number inv ON inv.order_id = o.id
//     LEFT JOIN ${P}wc_orders_meta invm ON invm.order_id = o.id AND invm.meta_key = '_wcpdf_invoice_number'
//     LEFT JOIN ${P}wc_orders_meta invd ON invd.order_id = o.id AND invd.meta_key = '_wcpdf_invoice_date_formatted'
//     LEFT JOIN ${P}wc_customer_lookup cl ON cl.user_id = o.customer_id`;

//   const [rows] = await pool.query(
//     `SELECT DISTINCT o.id ${from} WHERE ${where} ORDER BY o.date_created_gmt DESC`,
//     params
//   );
//   return rows.map((r) => r.id);
// }

// async function buildPdfForOrder(orderId, type) {
//   const order = await orderService.getById(orderId);
//   const html = await buildDocumentHtml(order, type);
//   const pdf = toBuffer(await htmlToPdfBuffer(html));
//   const enriched = await enrichOrder(order);
//   const num = type === 'invoice' ? enriched.invoice_number : enriched.packing_slip_number;
//   const filename = `${type === 'invoice' ? 'invoice' : 'packing-slip'}-${num}.pdf`;
//   return { pdf, filename, order: enriched };
// }
async function buildPdfForOrder(
  orderId,
  type
) {
  const rawOrder =
    await orderService.getById(
      orderId
    );

  const {
    pdf,
    order,
  } =
    await createOrderPdfBuffer(
      rawOrder,
      type
    );

  const num =
    type === 'invoice'
      ? order.invoice_number
      : order.packing_slip_number;

  const filename =
    `${
      type === 'invoice'
        ? 'invoice'
        : 'packing-slip'
    }-${num}.pdf`;

  return {
    pdf,
    filename,
    order,
  };
}

// async function buildDownload(orderIds, type) {
//   if (!orderIds.length) throw httpError(400, 'No orders found for download');

//   if (orderIds.length === 1) {
//     const { pdf, filename } = await buildPdfForOrder(orderIds[0], type);
//     return { buffer: pdf, filename, contentType: 'application/pdf' };
//   }

//   const parts = [];
//   for (const orderId of orderIds) {
//     const { pdf, filename } = await buildPdfForOrder(orderId, type);
//     parts.push({ pdf, filename });
//   }
//   return { multiple: parts, contentType: 'application/zip' };
// }
async function buildDownload(
  orderIds,
  type
) {
  if (!orderIds.length) {
    throw httpError(
      400,
      'No orders found for download'
    );
  }

  // Single order
  if (orderIds.length === 1) {
    const {
      pdf,
      filename,
    } = await buildPdfForOrder(
      orderIds[0],
      type
    );

    return {
      buffer: pdf,
      filename,
      contentType: 'application/pdf',
    };
  }

  // Multiple orders -> ONE combined PDF
  // const html =
  //   await buildCombinedDocumentHtml(
  //     orderIds,
  //     type
  //   );

  // const pdf =
  //   toBuffer(
  //     await htmlToPdfBuffer(html)
  //   );
  // Multiple orders -> ONE combined PDF
const pdf =
  await createCombinedPdfBuffer(
    orderIds,
    type
  );

  const label =
    type === 'invoice'
      ? 'invoices'
      : 'packing-slips';

  const date =
    new Date()
      .toISOString()
      .slice(0, 10);

  return {
    buffer: pdf,
    filename:
      `brassleaf-${label}-${date}.pdf`,
    contentType: 'application/pdf',
  };
}

async function buildCombinedDocumentHtml(
  orderIds,
  type
) {
  const sections = [];

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];

    const order =
      await orderService.getById(orderId);

    const body =
      await buildDocumentBody(
        order,
        type
      );

    sections.push(body);

    // Add page break only between orders.
    // No unnecessary blank final page.
    if (i < orderIds.length - 1) {
      sections.push(
        '<div class="page-break"></div>'
      );
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    ${documentStyles()}
  </style>
</head>
<body>
  ${sections.join('\n')}
</body>
</html>`;
}

async function totalsForOrderIds(orderIds) {
  if (!orderIds.length) {
    return { order_count: 0, total_sales: 0 };
  }
  const placeholders = orderIds.map(() => '?').join(',');
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS order_count, ROUND(COALESCE(SUM(total_amount), 0), 2) AS total_sales
     FROM ${P}wc_orders
     WHERE id IN (${placeholders}) AND type = 'shop_order'`,
    orderIds
  );
  return row;
}

async function download(req) {
  const type = req.query.type === 'packing-slip' ? 'packing-slip' : 'invoice';
  const input = {
    order_ids: req.query.order_ids,
    customer_ids: req.query.customer_ids || req.query.customer_id,
    range: req.query.range,
    date: req.query.date,
    date_from: req.query.date_from,
    date_to: req.query.date_to,
  };
  const orderIds = await resolveOrderIds(input);
  return buildDownload(orderIds, type);
}

async function sendOrderInvoiceToCustomer(
  orderId
) {
  const {
    pdf,
    filename,
    order,
  } = await buildPdfForOrder(
    orderId,
    'invoice'
  );

  const to =
    order.billing?.email ||
    order.billing_email;

  if (!to) {
    throw httpError(
      400,
      `Customer email not found for order #${orderId}`
    );
  }

  await sendMail({
    to,

    subject:
      `Your BrassLeaf Invoice #${order.invoice_number}`,

    html: `
      <div
        style="
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #243346;
        "
      >
        <p>Dear Customer,</p>

        <p>
          Thank you for your BrassLeaf order.
        </p>

        <p>
          Your invoice for
          <strong>Order #${order.id}</strong>
          is attached to this email.
        </p>

        <p>
          Regards,<br/>
          BrassLeaf
        </p>
      </div>
    `,

    text:
      `Dear Customer,\n\n` +
      `Thank you for your BrassLeaf order.\n` +
      `Please find attached your invoice for order #${order.id}.\n\n` +
      `Regards,\nBrassLeaf`,

    attachments: [
      {
        filename,
        content: pdf,
        contentType:
          'application/pdf',
      },
    ],
  });

  return {
    sent: true,
    orderId,
    email: to,
  };
}

async function emailCustomerInvoices(req) {
  const input = {
    order_ids:
      req.body?.order_ids,

    customer_ids:
      req.body?.customer_ids,

    range:
      req.body?.range,

    date:
      req.body?.date,

    date_from:
      req.body?.date_from,

    date_to:
      req.body?.date_to,
  };

  const orderIds =
    await resolveOrderIds(input);

  if (!orderIds.length) {
    throw httpError(
      400,
      'No orders found to email'
    );
  }

  let sent = 0;

  for (const orderId of orderIds) {
    try {
      await sendOrderInvoiceToCustomer(
        orderId
      );

      sent += 1;
    } catch (error) {
      console.error(
        `Invoice email failed for order #${orderId}:`,
        error.message
      );
    }
  }

  if (!sent) {
    throw httpError(
      400,
      'No customer emails found for selected orders'
    );
  }

  return {
    sent,
    orderIds,
  };
}
// async function emailCustomerInvoices(req) {
//   const input = {
//     order_ids: req.body?.order_ids,
//     customer_ids: req.body?.customer_ids,
//     range: req.body?.range,
//     date: req.body?.date,
//     date_from: req.body?.date_from,
//     date_to: req.body?.date_to,
//   };
//   const orderIds = await resolveOrderIds(input);
//   if (!orderIds.length) throw httpError(400, 'No orders found to email');

//   let sent = 0;
//   for (const orderId of orderIds) {
//     const { pdf, filename, order } = await buildPdfForOrder(orderId, 'invoice');
//     const to = order.billing?.email || order.billing_email;
//     if (!to) continue;
//     await sendMail({
//       to,
//       subject: `Your BrassLeaf Invoice #${order.invoice_number}`,
//       text: `Dear customer,\n\nPlease find attached your invoice for order #${order.id}.\n\nThank you,\nBrassLeaf`,
//       attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
//     });
//     sent += 1;
//   }
//   if (!sent) throw httpError(400, 'No customer emails found for selected orders');
//   return { sent, orderIds };
// }

// async function emailDailyAdmin(type, preset = 'yesterday') {
//   const orderIds = await resolveOrderIds({ range: preset });
//   if (!orderIds.length) return { sent: false, reason: 'no_orders', count: 0 };

//   const attachments = [];
//   for (const orderId of orderIds) {
//     const { pdf, filename } = await buildPdfForOrder(orderId, type);
//     attachments.push({ filename, content: pdf, contentType: 'application/pdf' });
//   }

//   const adminEmail = env.adminEmail;
//   if (!adminEmail) throw httpError(500, 'ADMIN_EMAIL is not configured in backend .env');

//   const range = resolveDateRange({ range: preset });
//   const dayLabel = range.label || preset;
//   const isInvoice = type === 'invoice';
//   await sendMail({
//     to: adminEmail,
//     subject: `BrassLeaf Daily ${isInvoice ? 'Invoices' : 'Packing Slips'} — ${dayLabel}`,
//     text: `Attached are ${attachments.length} ${isInvoice ? 'invoice' : 'packing slip'} PDF(s) for ${dayLabel}.`,
//     attachments,
//   });

//   return { sent: true, count: attachments.length, type, dayLabel };
// }

async function sendDailyAdminReports(
  scheduleInput = null
) {
  const reportScheduleService =
    require('./reportScheduleService');

  const schedule =
    scheduleInput ||
    (await reportScheduleService.getSchedule());

  const rangeKey =
    schedule.report_day === 'today'
      ? 'today'
      : 'yesterday';

  // Get all orders for selected day
  const orderIds =
    await resolveOrderIds({
      range: rangeKey,
    });

  if (!orderIds.length) {
    return {
      sent: false,
      reason: 'no_orders',
      count: 0,
      range: rangeKey,
    };
  }

  const adminEmail =
    schedule.admin_email ||
    env.adminEmail;

  if (!adminEmail) {
    throw httpError(
      500,
      'Admin email is not configured for daily reports'
    );
  }

  const range =
    resolveDateRange({
      range: rangeKey,
    });

  const dayLabel =
    range.label ||
    (
      rangeKey === 'today'
        ? 'Today'
        : 'Yesterday'
    );

  const totals =
    await totalsForOrderIds(orderIds);

  /*
   * =====================================
   * PDF 1 - ALL INVOICES
   * =====================================
   */
    const invoicesPdf =
  await createCombinedPdfBuffer(
    orderIds,
    'invoice'
  );
  // const invoicesHtml =
  //   await buildCombinedDocumentHtml(
  //     orderIds,
  //     'invoice'
  //   );

  // const invoicesPdf =
  //   toBuffer(
  //     await htmlToPdfBuffer(
  //       invoicesHtml
  //     )
  //   );

  /*
   * =====================================
   * PDF 2 - ALL PACKING SLIPS
   * =====================================
   */
    const packingSlipsPdf =
  await createCombinedPdfBuffer(
    orderIds,
    'packing-slip'
  );
  // const packingSlipsHtml =
  //   await buildCombinedDocumentHtml(
  //     orderIds,
  //     'packing-slip'
  //   );

  // const packingSlipsPdf =
  //   toBuffer(
  //     await htmlToPdfBuffer(
  //       packingSlipsHtml
  //     )
  //   );

  /*
   * Safe filename
   */
  const safeLabel =
    String(dayLabel)
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();

  const invoiceFilename =
    `brassleaf-invoices-${
      safeLabel || rangeKey
    }.pdf`;

  const packingSlipFilename =
    `brassleaf-packing-slips-${
      safeLabel || rangeKey
    }.pdf`;

  /*
   * ONE EMAIL
   * TWO PDF ATTACHMENTS
   */
  await sendMail({
    to: adminEmail,

    subject:
      `BrassLeaf - Daily Reports - ${dayLabel}`,

    html: `
      <div
        style="
          font-family:Arial,sans-serif;
          color:#243346;
          line-height:1.6;
        "
      >
        <p>Hello Admin,</p>

        <p>
          Please find attached the BrassLeaf
          daily reports for
          <strong>${esc(dayLabel)}</strong>.
        </p>

        <p>
          <strong>Total Orders:</strong>
          ${totals.order_count}
          <br/>

          <strong>Total Sales:</strong>
          ${formatMoney(
            totals.total_sales
          )}
        </p>

        <p>
          This email contains two PDF
          attachments:
        </p>

        <p>
          1. All invoices for the selected day
          <br/>
          2. All packing slips for the selected day
        </p>

        <p>
          Regards,
          <br/>
          BrassLeaf Admin
        </p>
      </div>
    `,

    text:
      `Hello Admin,\n\n` +

      `Please find attached the BrassLeaf daily reports for ${dayLabel}.\n\n` +

      `Total Orders: ${totals.order_count}\n` +

      `Total Sales: ${formatMoney(
        totals.total_sales
      )}\n\n` +

      `Attachments:\n` +
      `1. All invoices\n` +
      `2. All packing slips\n\n` +

      `Regards,\nBrassLeaf Admin`,

    attachments: [
      {
        filename:
          invoiceFilename,

        content:
          invoicesPdf,

        contentType:
          'application/pdf',
      },

      {
        filename:
          packingSlipFilename,

        content:
          packingSlipsPdf,

        contentType:
          'application/pdf',
      },
    ],
  });

  return {
    sent: true,

    count:
      orderIds.length,

    total_sales:
      totals.total_sales,

    dayLabel,

    range:
      rangeKey,

    orderIds,

    attachments: [
      invoiceFilename,
      packingSlipFilename,
    ],
  };
}

module.exports = {
  list,
  summary,
  download,
  buildDownload,
  buildDocumentHtml,
  buildPdfForOrder,

   sendOrderInvoiceToCustomer,
  emailCustomerInvoices,
  // emailDailyAdmin,
  sendDailyAdminReports,
  resolveOrderIds,
};




// const pool = require('../config/db');
// const P = require('../config/prefix');
// const { parseList, listResponse } = require('../utils/listParams');
// const { resolveDateRange, formatKolkataDate } = require('../utils/dateRange');
// const { unserializePhp } = require('../utils/php');
// const { httpError } = require('../utils/httpError');
// const orderService = require('./orderService');
// const PDFDocument = require('pdfkit');
// // const { htmlToPdfBuffer, toBuffer } = require('./pdfService');
// const { sendMail } = require('./mailService');
// const env = require('../config/env');
// const fs = require('fs');
// const path = require('path');

// const GENERIC_CATEGORY =
//   /^(uniforms?|sports?|sportswear|shirts?|pants?|trousers?|skirts?|jackets?|belts?|socks?|tracks?|track-?pants?|t-?shirts?|sweaters?|accessories|collections?|daily|winter|summer|boys?|girls?|schoolwear|corporate|general)$/i;

// let logoDataUriCache = null;

// const SORT = {
//   id: 'o.id',
//   date: 'o.date_created_gmt',
//   total: 'o.total_amount',
//   invoice: 'invoice_number',
// };

// const SHOP = {
//   name: 'BrassLeaf',
//   address:
//     '6-3-666/B, Pillar No. #1118 Erramanzil Road, Panjagutta, Hyderabad – 500082, Opp Nims Hospital',
//   gstin: '36AACFB1506E1Z5',
//   footer: 'Note: Any exchanges should be done at the BrassLeaf, Punjagutta store only',
// };

// let shopSettingsLoaded = false;

// async function loadShopSettings() {
//   if (shopSettingsLoaded) return SHOP;
//   try {
//     const [[row]] = await pool.query(
//       `SELECT option_value FROM ${P}options WHERE option_name = 'wpo_wcpdf_settings_general' LIMIT 1`
//     );
//     const settings = unserializePhp(row?.option_value) || {};
//     if (settings.shop_name?.default) SHOP.name = settings.shop_name.default;
//     if (settings.shop_address_additional?.default) SHOP.address = settings.shop_address_additional.default;
//     const gst = settings.shop_address_additional?.default || '';
//     const gstMatch = gst.match(/GSTIN:\s*([A-Z0-9]+)/i);
//     if (gstMatch) SHOP.gstin = gstMatch[1];
//     const footer = settings.footer?.default;
//     if (footer) SHOP.footer = footer;
//   } catch {
//     /* use defaults */
//   }
//   shopSettingsLoaded = true;
//   return SHOP;
// }

// function parseIdList(value) {
//   if (!value) return [];
//   const raw = Array.isArray(value) ? value : String(value).split(',');
//   return raw
//     .map((v) => parseInt(String(v).trim(), 10))
//     .filter((n) => !Number.isNaN(n) && n > 0);
// }

// function esc(value) {
//   return String(value ?? '')
//     .replace(/&/g, '&amp;')
//     .replace(/</g, '&lt;')
//     .replace(/>/g, '&gt;')
//     .replace(/"/g, '&quot;');
// }

// function formatMoney(amount) {
//   const n = Number(amount);
//   if (Number.isNaN(n)) return '₹0.00';
//   return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// }

// function formatLongDate(dt) {
//   if (!dt) return '—';
//   const d = new Date(dt);
//   if (Number.isNaN(d.getTime())) return String(dt);
//   return d.toLocaleDateString('en-IN', {
//     day: 'numeric',
//     month: 'long',
//     year: 'numeric',
//     timeZone: 'Asia/Kolkata',
//   });
// }

// async function fetchProductSku(productId) {
//   if (!productId) return null;
//   const [[row]] = await pool.query(
//     `SELECT meta_value FROM ${P}postmeta WHERE post_id = ? AND meta_key = '_sku' LIMIT 1`,
//     [productId]
//   );
//   return row?.meta_value || null;
// }

// async function resolveInstitutionName(order) {
//   const company =
//     order.billing?.company ||
//     order.shipping?.company ||
//     '';
//   if (String(company).trim()) {
//     return String(company).trim();
//   }

//   const productIds = [
//     ...new Set(
//       (order.line_items || [])
//         .map((item) => item.product_id)
//         .filter(Boolean)
//     ),
//   ];

//   for (const productId of productIds) {
//     const school = await resolveSchoolFromProduct(productId);
//     if (school) return school;
//   }

//   return null;
// }

// async function walkCategoryChain(termId) {
//   const chain = [];
//   let current = Number(termId) || 0;

//   while (current) {
//     const [[row]] = await pool.query(
//       `SELECT t.term_id, t.name, tt.parent
//        FROM ${P}terms t
//        JOIN ${P}term_taxonomy tt ON tt.term_id = t.term_id AND tt.taxonomy = 'product_cat'
//        WHERE t.term_id = ?
//        LIMIT 1`,
//       [current]
//     );
//     if (!row) break;
//     chain.push({ term_id: row.term_id, name: row.name, parent: Number(row.parent) || 0 });
//     current = Number(row.parent) || 0;
//   }

//   return chain;
// }

// function pickSchoolName(chain) {
//   if (!chain.length) return null;

//   for (const node of chain) {
//     if (/school|academy|college|institution|international|green/i.test(String(node.name))) {
//       return node.name;
//     }
//   }

//   const root = chain[chain.length - 1];
//   if (root && !GENERIC_CATEGORY.test(String(root.name).trim())) {
//     return root.name;
//   }

//   if (chain.length > 1) {
//     const parent = chain[chain.length - 2];
//     if (parent && !GENERIC_CATEGORY.test(String(parent.name).trim())) {
//       return parent.name;
//     }
//   }

//   return null;
// }

// async function resolveSchoolFromProduct(productId) {
//   const [cats] = await pool.query(
//     `SELECT t.term_id, t.name, tt.parent
//      FROM ${P}term_relationships tr
//      JOIN ${P}term_taxonomy tt
//        ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'product_cat'
//      JOIN ${P}terms t ON t.term_id = tt.term_id
//      WHERE tr.object_id = ?`,
//     [productId]
//   );

//   for (const cat of cats) {
//     const chain = await walkCategoryChain(cat.term_id);
//     const school = pickSchoolName(chain);
//     if (school) return school;
//   }

//   return null;
// }

// function getLogoDataUri() {
//   if (logoDataUriCache) {
//     return logoDataUriCache;
//   }

//   const logoPath = path.join(
//     __dirname,
//     '../../assets/logo.jpg'
//   );

//   if (!fs.existsSync(logoPath)) {
//     console.error(
//       'PDF logo not found:',
//       logoPath
//     );

//     return '';
//   }

//   const base64 =
//     fs.readFileSync(logoPath)
//       .toString('base64');

//   logoDataUriCache =
//     `data:image/jpeg;base64,${base64}`;

//   return logoDataUriCache;
// }


// function documentStyles() {
//   return `
//   * { box-sizing: border-box; }
//   body {
//     font-family: Arial, Helvetica, sans-serif;
//     color: #111;
//     font-size: 13px;
//     line-height: 1.5;
//     margin: 0;
//     padding: 36px 44px 40px;
//   }
//   .page-break { page-break-after: always; break-after: page; height: 0; }
//   .top-row {
//   display: flex;
//   justify-content: space-between;
//   align-items: flex-start;
//   gap: 28px;
//   margin-bottom: 42px;
// }

// .logo-img {
//   width: 145px;
//   height: 72px;
//   object-fit: contain;
//   object-position: left top;
//   display: block;
// }

// .shop-block {
//   text-align: left;
//   font-size: 12px;
//   color: #222;
//   line-height: 1.55;
//   width: 280px;
// }
//   .shop-name { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
//   .title {
//     font-size: 24px;
//     font-weight: 700;
//     letter-spacing: 0.02em;
//     margin: 0 0 24px;
//   }
//   .grid {
//     display: flex;
//     justify-content: space-between;
//     align-items: flex-start;
//     gap: 40px;
//     margin-bottom: 28px;
//   }
//   .address {
//     flex: 1;
//     line-height: 1.6;
//     text-align: left;
//     min-width: 0;
//   }
//   .meta {
//     width: 280px;
//     flex-shrink: 0;
//     text-align: left;
//     font-size: 12px;
//     line-height: 1.65;
//   }
//   .meta p { margin: 0 0 5px; }
//   .meta .label { font-weight: 700; }
//   .institution {
//     font-weight: 700;
//     font-size: 13px;
//     margin: 0 0 10px !important;
//     letter-spacing: 0.04em;
//   }
//   table {
//     width: 100%;
//     border-collapse: collapse;
//     margin-top: 12px;
//   }
//   thead th {
//     background: #000;
//     color: #fff;
//     font-weight: 700;
//     text-align: left;
//     padding: 10px 12px;
//     font-size: 13px;
//   }
//   thead th.num { text-align: right; }
//   tbody td {
//     border-bottom: 1px solid #d9d9d9;
//     padding: 10px 12px;
//     vertical-align: top;
//   }
//   tbody td.num { text-align: right; white-space: nowrap; }
//   .item-name { font-weight: 700; margin-bottom: 2px; }
//   .item-meta { font-size: 11px; color: #444; line-height: 1.45; }
//   .totals {
//     margin-top: 22px;
//     margin-left: auto;
//     width: 320px;
//     font-size: 13px;
//   }
//   .totals-row {
//     display: flex;
//     justify-content: space-between;
//     gap: 16px;
//     padding: 4px 0;
//   }
//   .total-line {
//     border-top: 1px solid #111;
//     border-bottom: 1px solid #111;
//     margin-top: 8px;
//     padding: 8px 0;
//     font-weight: 700;
//     font-size: 14px;
//   }
//   .tax-note {
//     text-align: right;
//     font-size: 11px;
//     color: #444;
//     margin-top: 8px;
//   }
//   .footer-wrap {
//     margin-top: 40px;
//     border-top: 1px solid #bbb;
//     padding-top: 16px;
//     text-align: center;
//     font-size: 12px;
//     color: #333;
//   }`;
// }

// async function buildDocumentBody(order, type) {
//   await loadShopSettings();
//   const enriched = await enrichOrder(order);
//   const isInvoice = type === 'invoice';
//   const title = isInvoice ? 'INVOICE' : 'PACKING SLIP';
//   const billing = enriched.billing;
//   const shipping = enriched.shipping || billing;
//   const addr = isInvoice ? billing : shipping;
//   const logoUri = getLogoDataUri();

//   const productRows = enriched.line_items
//     .map((item) => {
//       const qty = Number(item.qty) || 0;
//       const total = Number(item.line_total) || 0;
//       const unit = qty > 0 ? total / qty : total;
//       const size = item.size ? `<div class="item-meta">size: ${esc(item.size)}</div>` : '';
//       const skuLine =
//         item.sku || item.hsn
//           ? `<div class="item-meta">${item.sku ? `SKU: ${esc(item.sku)}` : ''}${item.sku && item.hsn ? ' | ' : ''}${item.hsn ? `HSN : ${esc(item.hsn)}` : ''}</div>`
//           : '';

//       if (isInvoice) {
//         return `<tr>
//           <td><div class="item-name">${esc(item.order_item_name)}</div>${size}${skuLine}</td>
//           <td class="num">${qty}</td>
//           <td class="num">${formatMoney(unit)}</td>
//         </tr>`;
//       }

//       return `<tr>
//         <td><div class="item-name">${esc(item.order_item_name)}</div>${size}${skuLine}</td>
//         <td class="num">${qty}</td>
//       </tr>`;
//     })
//     .join('');

//   const taxParts = enriched.taxes
//     .filter((t) => t.amount > 0)
//     .map((t) => {
//       const rate = t.rate ? `${t.rate}% ` : '';
//       const label = String(t.label || '').replace(/^IN-\d+(?:\.\d+)?%\s*/i, '');
//       return `${formatMoney(t.amount)} ${rate}${esc(label)}`;
//     });

//   const taxSummary = taxParts.length ? `(includes ${taxParts.join(', ')})` : '';

//   const institutionBlock =
//     isInvoice && enriched.institution_name
//       ? `<p class="institution">${esc(String(enriched.institution_name).toUpperCase())}</p>`
//       : '';

//   const docBlock = isInvoice
//     ? `${institutionBlock}
//        <p><span class="label">Invoice Number:</span> ${esc(enriched.invoice_number)}</p>
//        <p><span class="label">Invoice Date:</span> ${esc(formatLongDate(enriched.invoice_date))}</p>
//        <p><span class="label">Order Number:</span> ${esc(enriched.id)}</p>
//        <p><span class="label">Order Date:</span> ${esc(formatLongDate(enriched.date_created_gmt))}</p>
//        <p><span class="label">Payment Method:</span> ${esc(enriched.payment_method_title || enriched.payment_method || '—')}</p>`
//     : `<p><span class="label">Order Number:</span> ${esc(enriched.id)}</p>
//        <p><span class="label">Order Date:</span> ${esc(formatLongDate(enriched.date_created_gmt))}</p>
//        <p><span class="label">Shipping Method:</span> ${esc(enriched.shipping_label)}</p>`;

//   const totals = isInvoice
//     ? `<div class="totals">
//          <div class="totals-row"><span>Subtotal</span><span>${formatMoney(enriched.subtotal)}</span></div>
//          <div class="totals-row"><span>Shipping</span><span>${formatMoney(enriched.shipping_cost)} via ${esc(enriched.shipping_label)}</span></div>
//          <div class="totals-row total-line"><span>Total</span><span>${formatMoney(enriched.total_amount)}</span></div>
//          ${taxSummary ? `<div class="tax-note">${taxSummary}</div>` : ''}
//        </div>`
//     : '';

//     const logoHtml = logoUri
//   ? `
//       <img
//         class="logo-img"
//         src="${logoUri}"
//         alt="Brass Leaf"
//       />
//     `
//   : '';
//   // const logoHtml = logoUri
//   //   ? `<img class="logo-img" src="${logoUri}" alt="Brass Leaf"/>`
//   //   : `<div style="width:150px;height:60px;background:#243346;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">Brass Leaf</div>`;

//   return `<section class="doc-section">
//   <div class="top-row">
//     <div>${logoHtml}</div>
//     <div class="shop-block">
//       <div class="shop-name">${esc(SHOP.name)}</div>
//       <div>${esc(SHOP.address)}</div>
//       <div>GSTIN: ${esc(SHOP.gstin)}</div>
//     </div>
//   </div>

//   <div class="title">${title}</div>

//   <div class="grid">
//     <div class="address">
//       ${addressLines(addr).map((l) => `<div>${esc(l)}</div>`).join('')}
//     </div>
//     <div class="meta">${docBlock}</div>
//   </div>

//   <table>
//     <thead><tr>
//       <th>Product</th>
//       <th class="num">Quantity</th>
//       ${isInvoice ? '<th class="num">Price</th>' : ''}
//     </tr></thead>
//     <tbody>${productRows}</tbody>
//   </table>

//   ${totals}

//   <div class="footer-wrap">${esc(SHOP.footer)}</div>
// </section>`;
// }

// async function buildDocumentHtml(order, type) {
//   const body = await buildDocumentBody(order, type);
//   return `<!DOCTYPE html>
// <html><head><meta charset="utf-8"/>
// <style>${documentStyles()}</style></head><body>${body}</body></html>`;
// }
// async function buildCombinedDailyHtml(
//   orderIds
// ) {
//   const sections = [];

//   for (
//     let i = 0;
//     i < orderIds.length;
//     i++
//   ) {
//     const orderId =
//       orderIds[i];

//     const order =
//       await orderService.getById(
//         orderId
//       );

//     // Invoice
//     sections.push(
//       await buildDocumentBody(
//         order,
//         'invoice'
//       )
//     );

//     // Packing slip starts new page
//     sections.push(
//       '<div class="page-break"></div>'
//     );

//     // Packing slip
//     sections.push(
//       await buildDocumentBody(
//         order,
//         'packing-slip'
//       )
//     );

//     // Next order starts new page,
//     // but don't add blank page at end
//     if (
//       i <
//       orderIds.length - 1
//     ) {
//       sections.push(
//         '<div class="page-break"></div>'
//       );
//     }
//   }

//   return `<!DOCTYPE html>
// <html>
// <head>
//   <meta charset="utf-8"/>

//   <style>
//     ${documentStyles()}
//   </style>
// </head>

// <body>
//   ${sections.join('\n')}
// </body>
// </html>`;
// }
// // async function buildCombinedDailyHtml(orderIds) {
// //   const sections = [];
// //   for (const orderId of orderIds) {
// //     const order = await orderService.getById(orderId);
// //     sections.push(await buildDocumentBody(order, 'invoice'));
// //     sections.push('<div class="page-break"></div>');
// //     sections.push(await buildDocumentBody(order, 'packing-slip'));
// //     sections.push('<div class="page-break"></div>');
// //   }

// //   return `<!DOCTYPE html>
// // <html><head><meta charset="utf-8"/>
// // <style>${documentStyles()}</style></head><body>${sections.join('\n')}</body></html>`;
// // }

// function parseHsn(name, sku) {
//   const fromName = String(name || '').match(/HSN\s*:\s*(\d+)/i);
//   if (fromName) return fromName[1];
//   return null;
// }

// function addressLines(addr) {
//   if (!addr) return [];
//   return [
//     [addr.first_name, addr.last_name].filter(Boolean).join(' '),
//     addr.company,
//     addr.address_1,
//     addr.address_2,
//     [addr.city, addr.postcode].filter(Boolean).join(' '),
//     addr.state,
//     addr.email,
//     addr.phone,
//   ].filter(Boolean);
// }

// async function enrichOrder(order) {
//   const [taxRows] = await pool.query(
//     `SELECT oi.order_item_id, oi.order_item_name,
//             MAX(CASE WHEN oim.meta_key = 'tax_amount' THEN oim.meta_value END) AS tax_amount,
//             MAX(CASE WHEN oim.meta_key = 'label' THEN oim.meta_value END) AS label,
//             MAX(CASE WHEN oim.meta_key = 'rate_percent' THEN oim.meta_value END) AS rate_percent
//      FROM ${P}woocommerce_order_items oi
//      LEFT JOIN ${P}woocommerce_order_itemmeta oim ON oim.order_item_id = oi.order_item_id
//      WHERE oi.order_id = ? AND oi.order_item_type = 'tax'
//      GROUP BY oi.order_item_id, oi.order_item_name`,
//     [order.id]
//   );

//   const [invoiceMeta] = await pool.query(
//     `SELECT meta_key, meta_value FROM ${P}wc_orders_meta
//      WHERE order_id = ? AND meta_key IN (
//        '_wcpdf_invoice_number', '_wcpdf_invoice_date_formatted', '_wcpdf_invoice_date'
//      )`,
//     [order.id]
//   );
//   const metaMap = {};
//   for (const m of invoiceMeta) metaMap[m.meta_key] = m.meta_value;

//   const lineItems = await Promise.all(
//     (order.line_items || []).map(async (item) => {
//       let sku = item.sku || null;
//       if (!sku && item.product_id) {
//         sku = await fetchProductSku(item.product_id);
//       }
//       return {
//         ...item,
//         sku,
//         hsn: parseHsn(item.order_item_name, sku),
//       };
//     })
//   );

//   const shippingCost = (order.shipping_items || []).reduce(
//     (sum, s) => sum + (Number(s.cost) || 0),
//     0
//   );
//   const shippingLabel = order.shipping_items?.[0]?.order_item_name || 'Flat rate';
//   const subtotal = lineItems.reduce((sum, i) => sum + (Number(i.line_total) || 0), 0);
//   const taxes = taxRows.map((t) => ({
//     label: t.label || t.order_item_name,
//     amount: Number(t.tax_amount) || 0,
//     rate: t.rate_percent,
//   }));

//   return {
//     ...order,
//     line_items: lineItems,
//     taxes,
//     subtotal,
//     shipping_cost: shippingCost,
//     shipping_label: shippingLabel,
//     invoice_number:
//   metaMap._wcpdf_invoice_number ||
//   order.invoice_number ||
//   null,
//     // invoice_number: metaMap._wcpdf_invoice_number || order.invoice_number || order.id,
//     invoice_date: metaMap._wcpdf_invoice_date_formatted || order.invoice_date || order.date_created_gmt,
//     packing_slip_number: order.id,
//     customer_name: order.billing
//       ? [order.billing.first_name, order.billing.last_name].filter(Boolean).join(' ')
//       : null,
//     institution_name: await resolveInstitutionName(order),
//   };
// }

// function moneyText(amount) {
//   const n = Number(amount || 0);

//   return `Rs. ${n.toLocaleString(
//     'en-IN',
//     {
//       minimumFractionDigits: 2,
//       maximumFractionDigits: 2,
//     }
//   )}`;
// }

// function pdfDate(value) {
//   if (!value) {
//     return '—';
//   }

//   const d = new Date(value);

//   if (Number.isNaN(d.getTime())) {
//     return String(value);
//   }

//   return d.toLocaleDateString(
//     'en-IN',
//     {
//       day: 'numeric',
//       month: 'long',
//       year: 'numeric',
//       timeZone: 'Asia/Kolkata',
//     }
//   );
// }

// // function getPdfLogoPath() {
// //   const logoPath = path.join(
// //     __dirname,
// //     '../../../frontend/public/logo.jpg'
// //   );

// //   return fs.existsSync(logoPath)
// //     ? logoPath
// //     : null;
// // }
// function getPdfLogoPath() {
//   const logoPath = path.join(
//     __dirname,
//     '../../assets/logo.jpg'
//   );

//   if (!fs.existsSync(logoPath)) {
//     console.error(
//       'PDF logo not found:',
//       logoPath
//     );

//     return null;
//   }

//   return logoPath;
// }

// function createPdfDocument() {
//   return new PDFDocument({
//     size: 'A4',
//     margins: {
//       top: 36,
//       bottom: 40,
//       left: 44,
//       right: 44,
//     },
//     bufferPages: true,
//   });
// }

// function collectPdfBuffer(doc) {
//   return new Promise(
//     (resolve, reject) => {
//       const chunks = [];

//       doc.on(
//         'data',
//         (chunk) => {
//           chunks.push(chunk);
//         }
//       );

//       doc.on(
//         'end',
//         () => {
//           resolve(
//             Buffer.concat(chunks)
//           );
//         }
//       );

//       doc.on(
//         'error',
//         reject
//       );
//     }
//   );
// }

// function ensurePdfSpace(
//   doc,
//   requiredHeight = 100
// ) {
//   const bottom =
//     doc.page.height -
//     doc.page.margins.bottom;

//   if (
//     doc.y + requiredHeight >
//     bottom
//   ) {
//     doc.addPage();
//   }
// }

// function drawPdfHeader(
//   doc,
//   order,
//   type
// ) {
//   const isInvoice =
//     type === 'invoice';

//   const logoPath =
//     getPdfLogoPath();

//   const startY =
//     doc.page.margins.top;

//   if (logoPath) {
//     try {
//       // doc.image(
//       //   logoPath,
//       //   doc.page.margins.left,
//       //   startY,
//       //   {
//       //     fit: [145, 72],
//       //     align: 'left',
//       //   }
//       // );
//       doc.image(
//   logoPath,
//   doc.page.margins.left,
//   startY,
//   {
//     fit: [125, 60],
//     align: 'left',
//     valign: 'top',
//   }
// );
//     } catch (error) {
//       console.error(
//         'Unable to add PDF logo:',
//         error.message
//       );
//     }
//   } else {
//     doc
//       .font('Helvetica-Bold')
//       .fontSize(16)
//       .text(
//         SHOP.name,
//         doc.page.margins.left,
//         startY
//       );
//   }

//   // const shopX = 310;
//   const shopX = 300;
// const shopWidth = 250;

// doc
//   .font('Helvetica-Bold')
//   .fontSize(10)
//   .fillColor('#111111')
//   .text(
//     SHOP.name,
//     shopX,
//     startY,
//     {
//       width: shopWidth,
//     }
//   );

// doc
//   .font('Helvetica')
//   .fontSize(8.5)
//   .text(
//     SHOP.address,
//     shopX,
//     startY + 18,
//     {
//       width: shopWidth,
//       lineGap: 2,
//     }
//   );

// // GSTIN already address lo unte malli print cheyyakudadhu
// if (
//   SHOP.gstin &&
//   !String(SHOP.address || '')
//     .toUpperCase()
//     .includes(
//       String(SHOP.gstin).toUpperCase()
//     )
// ) {
//   doc.text(
//     `GSTIN: ${SHOP.gstin}`,
//     shopX,
//     startY + 62,
//     {
//       width: shopWidth,
//     }
//   );
// }

// doc.y = startY + 110;
//   // doc
//   //   .font('Helvetica-Bold')
//   //   .fontSize(10)
//   //   .fillColor('#111111')
//   //   .text(
//   //     SHOP.name,
//   //     shopX,
//   //     startY,
//   //     {
//   //       width: 240,
//   //     }
//   //   );

//   // doc
//   //   .font('Helvetica')
//   //   .fontSize(8.5)
//   //   .text(
//   //     SHOP.address,
//   //     shopX,
//   //     startY + 18,
//   //     {
//   //       width: 240,
//   //       lineGap: 2,
//   //     }
//   //   );

//   // doc.text(
//   //   `GSTIN: ${SHOP.gstin}`,
//   //   shopX,
//   //   startY + 58,
//   //   {
//   //     width: 240,
//   //   }
//   // );

//   // doc.y =
//   //   startY + 105;

//   // doc
//   //   .font('Helvetica-Bold')
//   //   .fontSize(20)
//   //   .fillColor('#111111')
//   //   .text(
//   //     isInvoice
//   //       ? 'INVOICE'
//   //       : 'PACKING SLIP'
//   //   );
//   doc
//   .font('Helvetica-Bold')
//   .fontSize(20)
//   .fillColor('#111111')
//   .text(
//     isInvoice
//       ? 'INVOICE'
//       : 'PACKING SLIP',
//     44,
//     doc.y,
//     {
//       width: 250,
//       align: 'left',
//     }
//   );

//   doc.moveDown(1);
// }

// function drawAddressAndMeta(
//   doc,
//   order,
//   type
// ) {
//   const isInvoice =
//     type === 'invoice';

//   const billing =
//     order.billing || {};

//   const shipping =
//     order.shipping || billing;

//   const address =
//     isInvoice
//       ? billing
//       : shipping;

//   const startY = doc.y;

//   /*
//    * LEFT SIDE - CUSTOMER ADDRESS
//    */
//   const addressX = 44;
//   const addressWidth = 245;

//   const lines =
//     addressLines(address);

//   doc
//     .font('Helvetica')
//     .fontSize(9.5)
//     .fillColor('#111111');

//   let addressY = startY;

//   for (const line of lines) {
//     doc.text(
//       String(line),
//       addressX,
//       addressY,
//       {
//         width: addressWidth,
//         lineGap: 2,
//       }
//     );

//     addressY =
//       doc.y + 4;
//   }

//   /*
//    * RIGHT SIDE - ORDER / INVOICE DETAILS
//    */
//   const metaX = 310;
//   const labelWidth = 105;
//   const valueX = 420;
//   const valueWidth = 130;

//   let metaY = startY;

//   if (
//     isInvoice &&
//     order.institution_name
//   ) {
//     doc
//       .font('Helvetica-Bold')
//       .fontSize(9.5)
//       .fillColor('#111111')
//       .text(
//         String(
//           order.institution_name
//         ).toUpperCase(),
//         metaX,
//         metaY,
//         {
//           width: 240,
//         }
//       );

//     metaY =
//       doc.y + 8;
//   }

//   const metaRows =
//     isInvoice
//       ? [
//           [
//             'Invoice Number',
//             order.invoice_number || '—',
//           ],
//           [
//             'Invoice Date',
//             pdfDate(
//               order.invoice_date
//             ),
//           ],
//           [
//             'Order Number',
//             order.id || '—',
//           ],
//           [
//             'Order Date',
//             pdfDate(
//               order.date_created_gmt
//             ),
//           ],
//           [
//             'Payment Method',
//             order.payment_method_title ||
//               order.payment_method ||
//               '—',
//           ],
//         ]
//       : [
//           [
//             'Order Number',
//             order.id || '—',
//           ],
//           [
//             'Order Date',
//             pdfDate(
//               order.date_created_gmt
//             ),
//           ],
//           [
//             'Shipping Method',
//             order.shipping_label ||
//               'Flat rate',
//           ],
//         ];

//   for (
//     const [label, value]
//     of metaRows
//   ) {
//     doc
//       .font('Helvetica-Bold')
//       .fontSize(9);

//     const labelHeight =
//       doc.heightOfString(
//         `${label}:`,
//         {
//           width: labelWidth,
//         }
//       );

//     doc
//       .font('Helvetica')
//       .fontSize(9);

//     const valueHeight =
//       doc.heightOfString(
//         String(value ?? '—'),
//         {
//           width: valueWidth,
//         }
//       );

//     const rowHeight =
//       Math.max(
//         labelHeight,
//         valueHeight,
//         13
//       );

//     doc
//       .font('Helvetica-Bold')
//       .fontSize(9)
//       .fillColor('#111111')
//       .text(
//         `${label}:`,
//         metaX,
//         metaY,
//         {
//           width: labelWidth,
//         }
//       );

//     doc
//       .font('Helvetica')
//       .fontSize(9)
//       .fillColor('#111111')
//       .text(
//         String(value ?? '—'),
//         valueX,
//         metaY,
//         {
//           width: valueWidth,
//           lineGap: 1,
//         }
//       );

//     metaY +=
//       rowHeight + 7;
//   }

//   /*
//    * Product table starts only
//    * after both columns finish.
//    */
//   doc.y =
//     Math.max(
//       addressY,
//       metaY
//     ) + 18;
// }
// function drawItemsHeader(
//   doc,
//   type
// ) {
//   const isInvoice =
//     type === 'invoice';

//   ensurePdfSpace(
//     doc,
//     70
//   );

//   const y = doc.y;

//   /* =====================================================
//      HEADER TEXT
//      - No black background
//      - Black text
//   ===================================================== */

//   doc
//     .fillColor('#111111')
//     .font('Helvetica-Bold')
//     .fontSize(9);

//   /* PRODUCT */

//   doc.text(
//     'Product',
//     55,
//     y + 7,
//     {
//       width:
//         isInvoice
//           ? 290
//           : 390,
//     }
//   );

//   /* QUANTITY */

//   doc.text(
//     'Quantity',
//     isInvoice
//       ? 365
//       : 445,
//     y + 7,
//     {
//       width: 60,
//       align: 'right',
//     }
//   );

//   /* PRICE - INVOICE ONLY */

//   if (isInvoice) {
//     doc.text(
//       'Price',
//       455,
//       y + 7,
//       {
//         width: 85,
//         align: 'right',
//       }
//     );
//   }

//   /* =====================================================
//      UNDERLINE BELOW TABLE HEADER
//   ===================================================== */

//   doc
//     .moveTo(
//       44,
//       y + 25
//     )
//     .lineTo(
//       551,
//       y + 25
//     )
//     .lineWidth(0.8)
//     .strokeColor('#111111')
//     .stroke();

//   /* Reset normal color */

//   doc
//     .fillColor('#111111');

//   /* Space before first product */

//   doc.y =
//     y + 35;
// }



// function drawOrderItems(
//   doc,
//   order,
//   type
// ) {
//   const isInvoice =
//     type === 'invoice';

//   drawItemsHeader(
//     doc,
//     type
//   );

//   const items =
//     order.line_items || [];

//   for (const item of items) {
//     ensurePdfSpace(
//       doc,
//       65
//     );


//     if (
//       doc.y <
//       doc.page.margins.top +
//         20
//     ) {
//       drawItemsHeader(
//         doc,
//         type
//       );
//     }

//     const qty =
//       Number(item.qty) || 0;

//     const total =
//       Number(
//         item.line_total
//       ) || 0;

//     const unit =
//       qty > 0
//         ? total / qty
//         : total;

//     const rowY =
//       doc.y;

//     doc
//       .font('Helvetica-Bold')
//       .fontSize(9)
//       .fillColor('#111111')
//       .text(
//         item.order_item_name ||
//           'Product',
//         55,
//         rowY,
//         {
//           width:
//             isInvoice
//               ? 280
//               : 370,
//         }
//       );

//     let detailY =
//       doc.y + 2;

//     if (item.size) {
//       doc
//         .font('Helvetica-Bold')
//         .fontSize(8)
//         .fillColor('#444444')
//         .text(
//           `Size: ${item.size}`,
//           55,
//           detailY,
//           {
//             width: 280,
//           }
//         );

//       detailY =
//         doc.y + 2;
//     }

//     const detailParts = [];

//     if (item.sku) {
//       detailParts.push(
//         `SKU: ${item.sku}`
//       );
//     }

//     if (item.hsn) {
//       detailParts.push(
//         `HSN: ${item.hsn}`
//       );
//     }

//     if (
//       detailParts.length
//     ) {
//       doc
//         .font('Helvetica-Bold')
//         .fontSize(8)
//         .fillColor('#444444')
//         .text(
//           detailParts.join(
//             ' | '
//           ),
//           55,
//           detailY,
//           {
//             width: 280,
//           }
//         );
//     }

//     doc
//       .font('Helvetica')
//       .fontSize(9)
//       .fillColor('#111111')
//       .text(
//         String(qty),
//         isInvoice
//           ? 350
//           : 445,
//         rowY,
//         {
//           width: 60,
//           align: 'right',
//         }
//       );

//     // if (isInvoice) {
//     //   doc.text(
//     //     moneyText(unit),
//     //     445,
//     //     rowY,
//     //     {
//     //       width: 95,
//     //       align: 'right',
//     //     }
//     //   );
//     // }
//     if (isInvoice) {
//   doc.text(
//     moneyText(unit),
//     455,
//     rowY,
//     {
//       width: 85,
//       align: 'right',
//     }
//   );
// }

//     const rowBottom =
//       Math.max(
//         doc.y,
//         detailY + 20,
//         rowY + 28
//       );

//     doc
//       .moveTo(
//         44,
//         rowBottom
//       )
//       .lineTo(
//         551,
//         rowBottom
//       )
//       .strokeColor(
//         '#d9d9d9'
//       )
//       .stroke();

//     doc
//       .strokeColor(
//         '#000000'
//       );

//     doc.y =
//       rowBottom + 10;
//   }
// }

// function drawInvoiceTotals(
//   doc,
//   order
// ) {
//   ensurePdfSpace(
//     doc,
//     150
//   );

//   doc.moveDown(1);

//   const x = 330;

//   const valueX = 445;

//   let y = doc.y;

//   const row = (
//     label,
//     value,
//     bold = false
//   ) => {
//     doc
//       .font(
//         bold
//           ? 'Helvetica-Bold'
//           : 'Helvetica'
//       )
//       .fontSize(
//         bold
//           ? 10.5
//           : 9
//       )
//       .fillColor(
//         '#111111'
//       )
//       .text(
//         label,
//         x,
//         y,
//         {
//           width: 105,
//         }
//       );

//     doc.text(
//       value,
//       valueX,
//       y,
//       {
//         width: 95,
//         align: 'right',
//       }
//     );

//     y +=
//       bold
//         ? 24
//         : 19;
//   };

//   row(
//     'Subtotal',
//     moneyText(
//       order.subtotal
//     )
//   );

//   row(
//     'Shipping',
//     `${moneyText(
//       order.shipping_cost
//     )}`
//   );

//   doc
//     .moveTo(
//       x,
//       y
//     )
//     .lineTo(
//       540,
//       y
//     )
//     .stroke();

//   y += 9;

//   row(
//     'Total',
//     moneyText(
//       order.total_amount
//     ),
//     true
//   );

//   const taxParts =
//     (order.taxes || [])
//       .filter(
//         (tax) =>
//           Number(tax.amount) >
//           0
//       )
//       .map((tax) => {
//         const rate =
//           tax.rate
//             ? `${tax.rate}% `
//             : '';

//         const label =
//           String(
//             tax.label || ''
//           ).replace(
//             /^IN-\d+(?:\.\d+)?%\s*/i,
//             ''
//           );

//         return `${moneyText(
//           tax.amount
//         )} ${rate}${label}`;
//       });

//   if (taxParts.length) {
//     doc
//       .font('Helvetica')
//       .fontSize(7.5)
//       .fillColor('#444444')
//       .text(
//         `(includes ${taxParts.join(
//           ', '
//         )})`,
//         x,
//         y,
//         {
//           width: 210,
//           align: 'right',
//         }
//       );

//     y =
//       doc.y + 8;
//   }

//   doc.y =
//     y;
// }

// function drawPdfFooter(
//   doc
// ) {
//   ensurePdfSpace(
//     doc,
//     70
//   );

//   doc.moveDown(2);

//   const y =
//     doc.y;

//   doc
//     .moveTo(
//       44,
//       y
//     )
//     .lineTo(
//       551,
//       y
//     )
//     .strokeColor(
//       '#bbbbbb'
//     )
//     .stroke();

//   doc
//     .font('Helvetica')
//     .fontSize(8.5)
//     .fillColor('#333333')
//     .text(
//       SHOP.footer,
//       44,
//       y + 15,
//       {
//         width: 507,
//         align: 'center',
//       }
//     );

//   doc
//     .strokeColor(
//       '#000000'
//     )
//     .fillColor(
//       '#111111'
//     );

//   doc.y =
//     y + 45;
// }

// async function addOrderToPdf(
//   doc,
//   rawOrder,
//   type
// ) {
//   await loadShopSettings();

//   const order =
//     await enrichOrder(
//       rawOrder
//     );

//   drawPdfHeader(
//     doc,
//     order,
//     type
//   );

//   drawAddressAndMeta(
//     doc,
//     order,
//     type
//   );

//   drawOrderItems(
//     doc,
//     order,
//     type
//   );

//   if (
//     type === 'invoice'
//   ) {
//     drawInvoiceTotals(
//       doc,
//       order
//     );
//   }

//   drawPdfFooter(
//     doc
//   );

//   return order;
// }

// async function createOrderPdfBuffer(
//   rawOrder,
//   type
// ) {
//   const doc =
//     createPdfDocument();

//   const promise =
//     collectPdfBuffer(
//       doc
//     );

//   const order =
//     await addOrderToPdf(
//       doc,
//       rawOrder,
//       type
//     );

//   doc.end();

//   const pdf =
//     await promise;

//   return {
//     pdf,
//     order,
//   };
// }

// async function createCombinedPdfBuffer(
//   orderIds,
//   type
// ) {
//   const doc =
//     createPdfDocument();

//   const promise =
//     collectPdfBuffer(
//       doc
//     );

//   for (
//     let i = 0;
//     i < orderIds.length;
//     i++
//   ) {
//     if (i > 0) {
//       doc.addPage();
//     }

//     const order =
//       await orderService.getById(
//         orderIds[i]
//       );

//     await addOrderToPdf(
//       doc,
//       order,
//       type
//     );
//   }

//   doc.end();

//   return promise;
// }

// function buildListQuery(req) {
//   const { search } = parseList(req, SORT, 'date');
//   const customerIds = parseIdList(req.query.customer_ids || req.query.customer_id);
//   const orderIds = parseIdList(req.query.order_ids);
//   const range = resolveDateRange(req.query);
//   const params = [];
//   // let where = `o.type = 'shop_order'`;
//   let where = `
//   o.type = 'shop_order'
//   AND o.status IN (
//     'wc-processing',
//     'wc-completed'
//   )
// `;

//   if (customerIds.length) {
//     where += ` AND o.customer_id IN (${customerIds.map(() => '?').join(',')})`;
//     params.push(...customerIds);
//   }
//   if (orderIds.length) {
//     where += ` AND o.id IN (${orderIds.map(() => '?').join(',')})`;
//     params.push(...orderIds);
//   }
//   if (range.start && range.end) {
//     where += ` AND o.date_created_gmt >= ? AND o.date_created_gmt <= ?`;
//     params.push(range.start, range.end);
//   }
//   if (search) {
//     where += ` AND (
//       CAST(o.id AS CHAR) LIKE ? OR o.billing_email LIKE ?
//       OR a.first_name LIKE ? OR a.last_name LIKE ?
//       OR CAST(COALESCE(inv.calculated_number, invm.meta_value) AS CHAR) LIKE ?
//       OR CAST(o.id AS CHAR) LIKE ?
//     )`;
//     const q = `%${search}%`;
//     params.push(q, q, q, q, q, q);
//   }

//   const from = `
//     FROM ${P}wc_orders o
//     LEFT JOIN ${P}wc_order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
//     LEFT JOIN ${P}wcpdf_invoice_number inv ON inv.order_id = o.id
//     LEFT JOIN ${P}wc_orders_meta invm ON invm.order_id = o.id AND invm.meta_key = '_wcpdf_invoice_number'
//     LEFT JOIN ${P}wc_orders_meta invd ON invd.order_id = o.id AND invd.meta_key = '_wcpdf_invoice_date_formatted'
//     LEFT JOIN ${P}wc_customer_lookup cl ON cl.user_id = o.customer_id`;

//   return { where, from, params, range, search };
// }

// async function list(req) {
//   const { page, limit, offset, sortCol, dir } = parseList(req, SORT, 'date');
//   const { where, from, params, range } = buildListQuery(req);

//   const [[{ total }]] = await pool.query(
//     `SELECT COUNT(DISTINCT o.id) AS total ${from} WHERE ${where}`,
//     params
//   );

//   const [rows] = await pool.query(
//     `SELECT
//        o.id AS order_id, o.status, o.total_amount, o.currency, o.date_created_gmt,
//        o.billing_email, o.customer_id, o.payment_method, o.payment_method_title,
//        a.first_name, a.last_name,
//        COALESCE(inv.calculated_number, CAST(invm.meta_value AS UNSIGNED)) AS invoice_number,
//        COALESCE(inv.date, invd.meta_value) AS invoice_date,
//        o.id AS packing_slip_number,
//        o.date_created_gmt AS packing_slip_date
//      ${from}
//      WHERE ${where}
//      ORDER BY ${sortCol} ${dir}
//      LIMIT ? OFFSET ?`,
//     [...params, limit, offset]
//   );

//   const data = rows.map((r) => ({
//     id: r.order_id,
//     order_id: r.order_id,
//     status: r.status,
//     total_amount: r.total_amount,
//     currency: r.currency,
//     date_created_gmt: r.date_created_gmt,
//     billing_email: r.billing_email,
//     customer_id: r.customer_id,
//     customer_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
//     payment_method: r.payment_method,
//     payment_method_title: r.payment_method_title,
//     invoice_number: r.invoice_number,
//     invoice_date: r.invoice_date,
//     packing_slip_number: r.packing_slip_number,
//     packing_slip_date: r.packing_slip_date,
//     has_invoice: true,
//     has_packing_slip: true,
//   }));

//   return { ...listResponse(data, total, page, limit), range };
// }

// async function summary(req) {
//   const { where, from, params, range } = buildListQuery(req);
//   const [[row]] = await pool.query(
//     `SELECT
//        COUNT(DISTINCT o.id) AS order_count,
//        ROUND(COALESCE(SUM(o.total_amount), 0), 2) AS total_sales,
//        ROUND(COALESCE(SUM(CASE WHEN o.status NOT IN ('wc-refunded','wc-cancelled','wc-failed') THEN o.total_amount ELSE 0 END), 0), 2) AS total_collected,
//        ROUND(COALESCE(SUM(CASE WHEN o.status = 'wc-refunded' THEN o.total_amount ELSE 0 END), 0), 2) AS refunded_amount,
//        ROUND(COALESCE(SUM(o.total_amount - COALESCE(o.tax_amount, 0)), 0), 2) AS subtotal,
//        ROUND(COALESCE(SUM(CASE WHEN o.status NOT IN ('wc-refunded','wc-cancelled','wc-failed') THEN o.total_amount ELSE 0 END), 0), 2) AS net_sales
//      ${from}
//      WHERE ${where}`,
//     params
//   );
//   return { ...row, range };
// }

// async function resolveOrderIds(input = {}) {
//   const orderIds =
//     parseIdList(input.order_ids);

//   const customerIds =
//     parseIdList(input.customer_ids);

//   /*
//    * IMPORTANT:
//    * When specific report rows are selected,
//    * use those exact order IDs.
//    *
//    * Reports list already contains only
//    * processing/completed orders.
//    */
//   if (orderIds.length) {
//     return [...new Set(orderIds)];
//   }

//   const params = [];

//   let where = `
//     o.type = 'shop_order'
//     AND o.status IN (
//       'wc-processing',
//       'wc-completed'
//     )
//   `;

//   const range =
//     resolveDateRange(input);

//   if (customerIds.length) {
//     where += `
//       AND o.customer_id IN (
//         ${customerIds
//           .map(() => '?')
//           .join(',')}
//       )
//     `;

//     params.push(...customerIds);
//   }

//   if (range.start && range.end) {
//     where += `
//       AND o.date_created_gmt >= ?
//       AND o.date_created_gmt <= ?
//     `;

//     params.push(
//       range.start,
//       range.end
//     );
//   }

//   const from = `
//     FROM ${P}wc_orders o

//     LEFT JOIN ${P}wc_order_addresses a
//       ON a.order_id = o.id
//       AND a.address_type = 'billing'

//     LEFT JOIN ${P}wcpdf_invoice_number inv
//       ON inv.order_id = o.id

//     LEFT JOIN ${P}wc_orders_meta invm
//       ON invm.order_id = o.id
//       AND invm.meta_key =
//         '_wcpdf_invoice_number'

//     LEFT JOIN ${P}wc_orders_meta invd
//       ON invd.order_id = o.id
//       AND invd.meta_key =
//         '_wcpdf_invoice_date_formatted'

//     LEFT JOIN ${P}wc_customer_lookup cl
//       ON cl.user_id = o.customer_id
//   `;

//   const [rows] =
//     await pool.query(
//       `
//         SELECT DISTINCT
//           o.id

//         ${from}

//         WHERE ${where}

//         ORDER BY
//           o.date_created_gmt DESC
//       `,
//       params
//     );

//   return rows.map(
//     (r) => r.id
//   );
// }
// // async function resolveOrderIds(input = {}) {
// //   const orderIds = parseIdList(input.order_ids);
// //   const customerIds = parseIdList(input.customer_ids);
// //   // if (orderIds.length) return [...new Set(orderIds)];

// //   const params = [];
// //   // let where = `o.type = 'shop_order'`;
// //   let where = `
// //   o.type = 'shop_order'
// //   AND o.status IN (
// //     'wc-processing',
// //     'wc-completed'
// //   )
// // `;
// //   const range = resolveDateRange(input);
// //    if (orderIds.length) {
// //     where += `
// //       AND o.id IN (
// //         ${orderIds
// //           .map(() => '?')
// //           .join(',')}
// //       )
// //     `;

// //     params.push(...orderIds);
// //   }

// //   if (customerIds.length) {
// //     where += ` AND o.customer_id IN (${customerIds.map(() => '?').join(',')})`;
// //     params.push(...customerIds);
// //   }
// //   if (range.start && range.end) {
// //     where += ` AND o.date_created_gmt >= ? AND o.date_created_gmt <= ?`;
// //     params.push(range.start, range.end);
// //   }

// //   const from = `
// //     FROM ${P}wc_orders o
// //     LEFT JOIN ${P}wc_order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
// //     LEFT JOIN ${P}wcpdf_invoice_number inv ON inv.order_id = o.id
// //     LEFT JOIN ${P}wc_orders_meta invm ON invm.order_id = o.id AND invm.meta_key = '_wcpdf_invoice_number'
// //     LEFT JOIN ${P}wc_orders_meta invd ON invd.order_id = o.id AND invd.meta_key = '_wcpdf_invoice_date_formatted'
// //     LEFT JOIN ${P}wc_customer_lookup cl ON cl.user_id = o.customer_id`;

// //   const [rows] = await pool.query(
// //     `SELECT DISTINCT o.id ${from} WHERE ${where} ORDER BY o.date_created_gmt DESC`,
// //     params
// //   );
// //   return rows.map((r) => r.id);
// // }

// // async function buildPdfForOrder(orderId, type) {
// //   const order = await orderService.getById(orderId);
// //   const html = await buildDocumentHtml(order, type);
// //   const pdf = toBuffer(await htmlToPdfBuffer(html));
// //   const enriched = await enrichOrder(order);
// //   const num = type === 'invoice' ? enriched.invoice_number : enriched.packing_slip_number;
// //   const filename = `${type === 'invoice' ? 'invoice' : 'packing-slip'}-${num}.pdf`;
// //   return { pdf, filename, order: enriched };
// // }
// async function buildPdfForOrder(
//   orderId,
//   type
// ) {
//   const rawOrder =
//     await orderService.getById(
//       orderId
//     );

//   const {
//     pdf,
//     order,
//   } =
//     await createOrderPdfBuffer(
//       rawOrder,
//       type
//     );

//   const num =
//     type === 'invoice'
//       ? order.invoice_number
//       : order.packing_slip_number;

//   const filename =
//     `${
//       type === 'invoice'
//         ? 'invoice'
//         : 'packing-slip'
//     }-${num}.pdf`;

//   return {
//     pdf,
//     filename,
//     order,
//   };
// }

// // async function buildDownload(orderIds, type) {
// //   if (!orderIds.length) throw httpError(400, 'No orders found for download');

// //   if (orderIds.length === 1) {
// //     const { pdf, filename } = await buildPdfForOrder(orderIds[0], type);
// //     return { buffer: pdf, filename, contentType: 'application/pdf' };
// //   }

// //   const parts = [];
// //   for (const orderId of orderIds) {
// //     const { pdf, filename } = await buildPdfForOrder(orderId, type);
// //     parts.push({ pdf, filename });
// //   }
// //   return { multiple: parts, contentType: 'application/zip' };
// // }
// async function buildDownload(
//   orderIds,
//   type
// ) {
//   if (!orderIds.length) {
//     throw httpError(
//       400,
//       'No orders found for download'
//     );
//   }

//   // Single order
//   if (orderIds.length === 1) {
//     const {
//       pdf,
//       filename,
//     } = await buildPdfForOrder(
//       orderIds[0],
//       type
//     );

//     return {
//       buffer: pdf,
//       filename,
//       contentType: 'application/pdf',
//     };
//   }

//   // Multiple orders -> ONE combined PDF
//   // const html =
//   //   await buildCombinedDocumentHtml(
//   //     orderIds,
//   //     type
//   //   );

//   // const pdf =
//   //   toBuffer(
//   //     await htmlToPdfBuffer(html)
//   //   );
//   // Multiple orders -> ONE combined PDF
// const pdf =
//   await createCombinedPdfBuffer(
//     orderIds,
//     type
//   );

//   const label =
//     type === 'invoice'
//       ? 'invoices'
//       : 'packing-slips';

//   const date =
//     new Date()
//       .toISOString()
//       .slice(0, 10);

//   return {
//     buffer: pdf,
//     filename:
//       `brassleaf-${label}-${date}.pdf`,
//     contentType: 'application/pdf',
//   };
// }

// async function buildCombinedDocumentHtml(
//   orderIds,
//   type
// ) {
//   const sections = [];

//   for (let i = 0; i < orderIds.length; i++) {
//     const orderId = orderIds[i];

//     const order =
//       await orderService.getById(orderId);

//     const body =
//       await buildDocumentBody(
//         order,
//         type
//       );

//     sections.push(body);

//     // Add page break only between orders.
//     // No unnecessary blank final page.
//     if (i < orderIds.length - 1) {
//       sections.push(
//         '<div class="page-break"></div>'
//       );
//     }
//   }

//   return `<!DOCTYPE html>
// <html>
// <head>
//   <meta charset="utf-8"/>
//   <style>
//     ${documentStyles()}
//   </style>
// </head>
// <body>
//   ${sections.join('\n')}
// </body>
// </html>`;
// }

// async function totalsForOrderIds(orderIds) {
//   if (!orderIds.length) {
//     return { order_count: 0, total_sales: 0 };
//   }
//   const placeholders = orderIds.map(() => '?').join(',');
//   const [[row]] = await pool.query(
//     `SELECT COUNT(*) AS order_count, ROUND(COALESCE(SUM(total_amount), 0), 2) AS total_sales
//      FROM ${P}wc_orders
//      WHERE id IN (${placeholders}) AND type = 'shop_order'`,
//     orderIds
//   );
//   return row;
// }

// async function download(req) {
//   const type = req.query.type === 'packing-slip' ? 'packing-slip' : 'invoice';
//   const input = {
//     order_ids: req.query.order_ids,
//     customer_ids: req.query.customer_ids || req.query.customer_id,
//     range: req.query.range,
//     date: req.query.date,
//     date_from: req.query.date_from,
//     date_to: req.query.date_to,
//   };
//   const orderIds = await resolveOrderIds(input);
//   return buildDownload(orderIds, type);
// }

// async function sendOrderInvoiceToCustomer(
//   orderId
// ) {
//   const {
//     pdf,
//     filename,
//     order,
//   } = await buildPdfForOrder(
//     orderId,
//     'invoice'
//   );

//   const to =
//     order.billing?.email ||
//     order.billing_email;

//   if (!to) {
//     throw httpError(
//       400,
//       `Customer email not found for order #${orderId}`
//     );
//   }

//   await sendMail({
//     to,

//     subject:
//       `Your BrassLeaf Invoice #${order.invoice_number}`,

//     html: `
//       <div
//         style="
//           font-family: Arial, sans-serif;
//           line-height: 1.6;
//           color: #243346;
//         "
//       >
//         <p>Dear Customer,</p>

//         <p>
//           Thank you for your BrassLeaf order.
//         </p>

//         <p>
//           Your invoice for
//           <strong>Order #${order.id}</strong>
//           is attached to this email.
//         </p>

//         <p>
//           Regards,<br/>
//           BrassLeaf
//         </p>
//       </div>
//     `,

//     text:
//       `Dear Customer,\n\n` +
//       `Thank you for your BrassLeaf order.\n` +
//       `Please find attached your invoice for order #${order.id}.\n\n` +
//       `Regards,\nBrassLeaf`,

//     attachments: [
//       {
//         filename,
//         content: pdf,
//         contentType:
//           'application/pdf',
//       },
//     ],
//   });

//   return {
//     sent: true,
//     orderId,
//     email: to,
//   };
// }

// async function emailCustomerInvoices(req) {
//   const input = {
//     order_ids:
//       req.body?.order_ids,

//     customer_ids:
//       req.body?.customer_ids,

//     range:
//       req.body?.range,

//     date:
//       req.body?.date,

//     date_from:
//       req.body?.date_from,

//     date_to:
//       req.body?.date_to,
//   };

//   const orderIds =
//     await resolveOrderIds(input);

//   if (!orderIds.length) {
//     throw httpError(
//       400,
//       'No orders found to email'
//     );
//   }

//   let sent = 0;

//   for (const orderId of orderIds) {
//     try {
//       await sendOrderInvoiceToCustomer(
//         orderId
//       );

//       sent += 1;
//     } catch (error) {
//       console.error(
//         `Invoice email failed for order #${orderId}:`,
//         error.message
//       );
//     }
//   }

//   if (!sent) {
//     throw httpError(
//       400,
//       'No customer emails found for selected orders'
//     );
//   }

//   return {
//     sent,
//     orderIds,
//   };
// }
// // async function emailCustomerInvoices(req) {
// //   const input = {
// //     order_ids: req.body?.order_ids,
// //     customer_ids: req.body?.customer_ids,
// //     range: req.body?.range,
// //     date: req.body?.date,
// //     date_from: req.body?.date_from,
// //     date_to: req.body?.date_to,
// //   };
// //   const orderIds = await resolveOrderIds(input);
// //   if (!orderIds.length) throw httpError(400, 'No orders found to email');

// //   let sent = 0;
// //   for (const orderId of orderIds) {
// //     const { pdf, filename, order } = await buildPdfForOrder(orderId, 'invoice');
// //     const to = order.billing?.email || order.billing_email;
// //     if (!to) continue;
// //     await sendMail({
// //       to,
// //       subject: `Your BrassLeaf Invoice #${order.invoice_number}`,
// //       text: `Dear customer,\n\nPlease find attached your invoice for order #${order.id}.\n\nThank you,\nBrassLeaf`,
// //       attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
// //     });
// //     sent += 1;
// //   }
// //   if (!sent) throw httpError(400, 'No customer emails found for selected orders');
// //   return { sent, orderIds };
// // }

// // async function emailDailyAdmin(type, preset = 'yesterday') {
// //   const orderIds = await resolveOrderIds({ range: preset });
// //   if (!orderIds.length) return { sent: false, reason: 'no_orders', count: 0 };

// //   const attachments = [];
// //   for (const orderId of orderIds) {
// //     const { pdf, filename } = await buildPdfForOrder(orderId, type);
// //     attachments.push({ filename, content: pdf, contentType: 'application/pdf' });
// //   }

// //   const adminEmail = env.adminEmail;
// //   if (!adminEmail) throw httpError(500, 'ADMIN_EMAIL is not configured in backend .env');

// //   const range = resolveDateRange({ range: preset });
// //   const dayLabel = range.label || preset;
// //   const isInvoice = type === 'invoice';
// //   await sendMail({
// //     to: adminEmail,
// //     subject: `BrassLeaf Daily ${isInvoice ? 'Invoices' : 'Packing Slips'} — ${dayLabel}`,
// //     text: `Attached are ${attachments.length} ${isInvoice ? 'invoice' : 'packing slip'} PDF(s) for ${dayLabel}.`,
// //     attachments,
// //   });

// //   return { sent: true, count: attachments.length, type, dayLabel };
// // }

// async function sendDailyAdminReports(
//   scheduleInput = null
// ) {
//   const reportScheduleService =
//     require('./reportScheduleService');

//   const schedule =
//     scheduleInput ||
//     (await reportScheduleService.getSchedule());

//   const rangeKey =
//     schedule.report_day === 'today'
//       ? 'today'
//       : 'yesterday';

//   // Get all orders for selected day
//   const orderIds =
//     await resolveOrderIds({
//       range: rangeKey,
//     });

//   if (!orderIds.length) {
//     return {
//       sent: false,
//       reason: 'no_orders',
//       count: 0,
//       range: rangeKey,
//     };
//   }

//   const adminEmail =
//     schedule.admin_email ||
//     env.adminEmail;

//   if (!adminEmail) {
//     throw httpError(
//       500,
//       'Admin email is not configured for daily reports'
//     );
//   }

//   const range =
//     resolveDateRange({
//       range: rangeKey,
//     });

//   const dayLabel =
//     range.label ||
//     (
//       rangeKey === 'today'
//         ? 'Today'
//         : 'Yesterday'
//     );

//   const totals =
//     await totalsForOrderIds(orderIds);

//   /*
//    * =====================================
//    * PDF 1 - ALL INVOICES
//    * =====================================
//    */
//     const invoicesPdf =
//   await createCombinedPdfBuffer(
//     orderIds,
//     'invoice'
//   );
//   // const invoicesHtml =
//   //   await buildCombinedDocumentHtml(
//   //     orderIds,
//   //     'invoice'
//   //   );

//   // const invoicesPdf =
//   //   toBuffer(
//   //     await htmlToPdfBuffer(
//   //       invoicesHtml
//   //     )
//   //   );

//   /*
//    * =====================================
//    * PDF 2 - ALL PACKING SLIPS
//    * =====================================
//    */
//     const packingSlipsPdf =
//   await createCombinedPdfBuffer(
//     orderIds,
//     'packing-slip'
//   );
//   // const packingSlipsHtml =
//   //   await buildCombinedDocumentHtml(
//   //     orderIds,
//   //     'packing-slip'
//   //   );

//   // const packingSlipsPdf =
//   //   toBuffer(
//   //     await htmlToPdfBuffer(
//   //       packingSlipsHtml
//   //     )
//   //   );

//   /*
//    * Safe filename
//    */
//   const safeLabel =
//     String(dayLabel)
//       .replace(/[^\w\s-]/g, '')
//       .trim()
//       .replace(/\s+/g, '-')
//       .toLowerCase();

//   const invoiceFilename =
//     `brassleaf-invoices-${
//       safeLabel || rangeKey
//     }.pdf`;

//   const packingSlipFilename =
//     `brassleaf-packing-slips-${
//       safeLabel || rangeKey
//     }.pdf`;

//   /*
//    * ONE EMAIL
//    * TWO PDF ATTACHMENTS
//    */
//   await sendMail({
//     to: adminEmail,

//     subject:
//       `BrassLeaf - Daily Reports - ${dayLabel}`,

//     html: `
//       <div
//         style="
//           font-family:Arial,sans-serif;
//           color:#243346;
//           line-height:1.6;
//         "
//       >
//         <p>Hello Admin,</p>

//         <p>
//           Please find attached the BrassLeaf
//           daily reports for
//           <strong>${esc(dayLabel)}</strong>.
//         </p>

//         <p>
//           <strong>Total Orders:</strong>
//           ${totals.order_count}
//           <br/>

//           <strong>Total Sales:</strong>
//           ${formatMoney(
//             totals.total_sales
//           )}
//         </p>

//         <p>
//           This email contains two PDF
//           attachments:
//         </p>

//         <p>
//           1. All invoices for the selected day
//           <br/>
//           2. All packing slips for the selected day
//         </p>

//         <p>
//           Regards,
//           <br/>
//           BrassLeaf Admin
//         </p>
//       </div>
//     `,

//     text:
//       `Hello Admin,\n\n` +

//       `Please find attached the BrassLeaf daily reports for ${dayLabel}.\n\n` +

//       `Total Orders: ${totals.order_count}\n` +

//       `Total Sales: ${formatMoney(
//         totals.total_sales
//       )}\n\n` +

//       `Attachments:\n` +
//       `1. All invoices\n` +
//       `2. All packing slips\n\n` +

//       `Regards,\nBrassLeaf Admin`,

//     attachments: [
//       {
//         filename:
//           invoiceFilename,

//         content:
//           invoicesPdf,

//         contentType:
//           'application/pdf',
//       },

//       {
//         filename:
//           packingSlipFilename,

//         content:
//           packingSlipsPdf,

//         contentType:
//           'application/pdf',
//       },
//     ],
//   });

//   return {
//     sent: true,

//     count:
//       orderIds.length,

//     total_sales:
//       totals.total_sales,

//     dayLabel,

//     range:
//       rangeKey,

//     orderIds,

//     attachments: [
//       invoiceFilename,
//       packingSlipFilename,
//     ],
//   };
// }






// // async function sendDailyAdminReports(scheduleInput = null) {
// //   const reportScheduleService = require('./reportScheduleService');
// //   const schedule = scheduleInput || (await reportScheduleService.getSchedule());

// //   const rangeKey = schedule.report_day === 'today' ? 'today' : 'yesterday';
// //   const orderIds = await resolveOrderIds({ range: rangeKey });

// //   if (!orderIds.length) {
// //     return { sent: false, reason: 'no_orders', count: 0, range: rangeKey };
// //   }

// //   const adminEmail = schedule.admin_email || env.adminEmail;
// //   if (!adminEmail) {
// //     throw httpError(500, 'Admin email is not configured for daily reports');
// //   }

// //   const range = resolveDateRange({ range: rangeKey });
// //   const dayLabel = range.label || (rangeKey === 'today' ? 'Today' : 'Yesterday');
// //   const totals = await totalsForOrderIds(orderIds);
// //   const html = await buildCombinedDailyHtml(orderIds);
// //   const pdf = toBuffer(await htmlToPdfBuffer(html));
// //   const safeLabel = dayLabel.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
// //   const filename = `brassleaf-daily-orders-${safeLabel || rangeKey}.pdf`;

// //   await sendMail({
// //     to: adminEmail,
// //     subject: `BrassLeaf - Daily Orders - ${dayLabel}`,
// //     html: `
// //       <div style="font-family:Arial,sans-serif;color:#243346;line-height:1.6;">
// //         <p>Hello Admin,</p>
// //         <p>Please find attached the BrassLeaf daily orders document for <strong>${esc(dayLabel)}</strong>.</p>
// //         <p><strong>Total Orders:</strong> ${totals.order_count}<br/>
// //         <strong>Total Sales:</strong> ${formatMoney(totals.total_sales)}</p>
// //         <p>The attached PDF contains the invoice and packing slip for each order.</p>
// //         <p>Regards,<br/>BrassLeaf Admin</p>
// //       </div>
// //     `,
// //     text:
// //       `Hello Admin,\n\nPlease find attached the BrassLeaf daily orders document for ${dayLabel}.\n\n` +
// //       `Total Orders: ${totals.order_count}\nTotal Sales: ${formatMoney(totals.total_sales)}\n\n` +
// //       `The attached PDF contains the invoice and packing slip for each order.\n\nRegards,\nBrassLeaf Admin`,
// //     attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
// //   });

// //   return {
// //     sent: true,
// //     count: orderIds.length,
// //     total_sales: totals.total_sales,
// //     dayLabel,
// //     range: rangeKey,
// //     orderIds,
// //     filename,
// //   };
// // }

// module.exports = {
//   list,
//   summary,
//   download,
//   buildDownload,
//   buildDocumentHtml,
//   buildPdfForOrder,

//    sendOrderInvoiceToCustomer,
//   emailCustomerInvoices,
//   // emailDailyAdmin,
//   sendDailyAdminReports,
//   resolveOrderIds,
// };




















