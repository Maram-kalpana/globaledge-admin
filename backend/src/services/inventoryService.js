const pool = require('../config/db');
const P = require('../config/prefix');
const { resolveInventoryPeriod, toKolkataParts } = require('../utils/dateRange');

const SUCCESS_STATUSES = ['wc-processing', 'wc-completed'];

const SORT_HANDLERS = {
  most_sold: (a, b) => b.units_sold - a.units_sold || a.name.localeCompare(b.name),
  least_sold: (a, b) => a.units_sold - b.units_sold || a.name.localeCompare(b.name),
  highest_sales: (a, b) => b.sales_amount - a.sales_amount || a.name.localeCompare(b.name),
  lowest_sales: (a, b) => a.sales_amount - b.sales_amount || a.name.localeCompare(b.name),
  name_asc: (a, b) => a.name.localeCompare(b.name),
};

async function getAvailableYears() {
  const today = toKolkataParts(new Date());
  const currentYear = today.year;

  const [rows] = await pool.query(
    `SELECT DISTINCT YEAR(o.date_created_gmt) AS yr
     FROM ${P}wc_orders o
     WHERE o.type = 'shop_order'
       AND o.status IN (?, ?)
     ORDER BY yr DESC`,
    SUCCESS_STATUSES
  );

  const years = rows.map((row) => Number(row.yr)).filter(Boolean);

  if (!years.includes(currentYear)) {
    years.unshift(currentYear);
    years.sort((a, b) => b - a);
  }

  return years.length ? years : [currentYear];
}

async function getProducts(search) {
  const params = [];
  let where = `
    p.post_type = 'product'
    AND p.post_status IN ('publish', 'draft', 'private', 'pending')
  `;

  if (search) {
    where += ` AND (p.post_title LIKE ? OR ml.sku LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

  const [rows] = await pool.query(
    `SELECT
       p.ID AS id,
       p.post_title AS name,
       ml.stock_quantity,
       ml.stock_status,
       ml.sku,
       att.guid AS image_url
     FROM ${P}posts p
     LEFT JOIN ${P}wc_product_meta_lookup ml ON ml.product_id = p.ID
     LEFT JOIN ${P}postmeta thumb_pm
       ON thumb_pm.post_id = p.ID AND thumb_pm.meta_key = '_thumbnail_id'
     LEFT JOIN ${P}posts att ON att.ID = thumb_pm.meta_value
     WHERE ${where}
     ORDER BY p.post_title ASC`,
    params
  );

  return rows;
}

const LINE_ITEMS_FROM = `
  FROM ${P}wc_orders o
  INNER JOIN ${P}woocommerce_order_items oi
    ON oi.order_id = o.id
   AND oi.order_item_type = 'line_item'
  LEFT JOIN ${P}woocommerce_order_itemmeta m_pid
    ON m_pid.order_item_id = oi.order_item_id
   AND m_pid.meta_key = '_product_id'
  LEFT JOIN ${P}woocommerce_order_itemmeta m_qty
    ON m_qty.order_item_id = oi.order_item_id
   AND m_qty.meta_key = '_qty'
  LEFT JOIN ${P}woocommerce_order_itemmeta m_tot
    ON m_tot.order_item_id = oi.order_item_id
   AND m_tot.meta_key = '_line_total'
  LEFT JOIN ${P}woocommerce_order_itemmeta m_var
    ON m_var.order_item_id = oi.order_item_id
   AND m_var.meta_key = '_variation_id'
  LEFT JOIN ${P}woocommerce_order_itemmeta m_size
    ON m_size.order_item_id = oi.order_item_id
   AND m_size.meta_key = 'pa_size'
  WHERE o.type = 'shop_order'
    AND o.status IN (?, ?)
    AND o.date_created_gmt >= ?
    AND o.date_created_gmt <= ?
`;

async function getSalesAggregation(start, end) {
  const params = [...SUCCESS_STATUSES, start, end];

  const [productSales] = await pool.query(
    `SELECT
       CAST(m_pid.meta_value AS UNSIGNED) AS product_id,
       SUM(CAST(m_qty.meta_value AS DECIMAL(20,4))) AS units_sold,
       ROUND(COALESCE(SUM(CAST(m_tot.meta_value AS DECIMAL(20,4))), 0), 2) AS sales_amount
     ${LINE_ITEMS_FROM}
     GROUP BY CAST(m_pid.meta_value AS UNSIGNED)`,
    params
  );

  const [[summaryRow]] = await pool.query(
    `SELECT
       COALESCE(SUM(CAST(m_qty.meta_value AS DECIMAL(20,4))), 0) AS total_units_sold,
       COUNT(DISTINCT CASE WHEN CAST(m_qty.meta_value AS DECIMAL(20,4)) > 0
             THEN CAST(m_pid.meta_value AS UNSIGNED) END) AS total_products_sold,
       ROUND(COALESCE(SUM(CAST(m_tot.meta_value AS DECIMAL(20,4))), 0), 2) AS total_sales
     ${LINE_ITEMS_FROM}`,
    params
  );

  const [[orderRow]] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS orders
     FROM ${P}wc_orders o
     WHERE o.type = 'shop_order'
       AND o.status IN (?, ?)
       AND o.date_created_gmt >= ?
       AND o.date_created_gmt <= ?`,
    params
  );

  const salesMap = new Map();
  for (const row of productSales) {
    salesMap.set(Number(row.product_id), {
      units_sold: Number(row.units_sold) || 0,
      sales_amount: Number(row.sales_amount) || 0,
    });
  }

  return {
    salesMap,
    summary: {
      total_units_sold: Number(summaryRow.total_units_sold) || 0,
      total_products_sold: Number(summaryRow.total_products_sold) || 0,
      total_sales: Number(summaryRow.total_sales) || 0,
      orders: Number(orderRow.orders) || 0,
    },
  };
}

// Units and sales per variation id (when orders store _variation_id)
async function getVariationSales(start, end) {
  const [rows] = await pool.query(
    `SELECT
       CAST(m_var.meta_value AS UNSIGNED) AS variation_id,
       SUM(CAST(m_qty.meta_value AS DECIMAL(20,4))) AS units_sold,
       ROUND(COALESCE(SUM(CAST(m_tot.meta_value AS DECIMAL(20,4))), 0), 2) AS sales_amount
     ${LINE_ITEMS_FROM}
       AND CAST(m_var.meta_value AS UNSIGNED) > 0
     GROUP BY CAST(m_var.meta_value AS UNSIGNED)`,
    [...SUCCESS_STATUSES, start, end]
  );

  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.variation_id), {
      units_sold: Number(r.units_sold) || 0,
      sales_amount: Number(r.sales_amount) || 0,
    });
  }
  return map;
}

// Units and sales per (product, size) using the order item's pa_size meta
async function getSizeSales(start, end) {
  const [rows] = await pool.query(
    `SELECT
       CAST(m_pid.meta_value AS UNSIGNED) AS product_id,
       m_size.meta_value AS size,
       SUM(CAST(m_qty.meta_value AS DECIMAL(20,4))) AS units_sold,
       ROUND(COALESCE(SUM(CAST(m_tot.meta_value AS DECIMAL(20,4))), 0), 2) AS sales_amount
     ${LINE_ITEMS_FROM}
       AND m_size.meta_value IS NOT NULL
       AND m_size.meta_value <> ''
     GROUP BY CAST(m_pid.meta_value AS UNSIGNED), m_size.meta_value`,
    [...SUCCESS_STATUSES, start, end]
  );

  const map = new Map();
  for (const r of rows) {
    map.set(`${Number(r.product_id)}|${String(r.size).trim().toLowerCase()}`, {
      units_sold: Number(r.units_sold) || 0,
      sales_amount: Number(r.sales_amount) || 0,
    });
  }
  return map;
}

// All sizes of the given products with current stock and period sales
async function getSizesByProduct(productIds, variationSales, sizeSales) {
  const result = new Map();
  if (!productIds.length) return result;
  

  const [rows] = await pool.query(
    `SELECT
       v.ID AS variation_id,
       v.post_parent AS product_id,
       pm_size.meta_value AS size_slug,
       COALESCE(t.name, pm_size.meta_value) AS size,
       COALESCE(
         ml.stock_quantity,
         CAST(NULLIF(pm_stock.meta_value, '') AS DECIMAL(20,4))
       ) AS stock_quantity,
       COALESCE(ml.stock_status, pm_status.meta_value) AS stock_status
     FROM ${P}posts v
     LEFT JOIN ${P}postmeta pm_size
       ON pm_size.post_id = v.ID AND pm_size.meta_key = 'attribute_pa_size'
     LEFT JOIN ${P}terms t ON t.slug = pm_size.meta_value
     LEFT JOIN ${P}wc_product_meta_lookup ml ON ml.product_id = v.ID
     LEFT JOIN ${P}postmeta pm_stock
       ON pm_stock.post_id = v.ID AND pm_stock.meta_key = '_stock'
     LEFT JOIN ${P}postmeta pm_status
       ON pm_status.post_id = v.ID AND pm_status.meta_key = '_stock_status'
     WHERE v.post_type = 'product_variation'
       AND v.post_status IN ('publish', 'private')
       AND v.post_parent IN (?)
     ORDER BY v.post_parent, v.menu_order, v.ID`,
    [productIds]
  );

  for (const r of rows) {
    const pid = Number(r.product_id);
    const slug = String(r.size_slug || '').trim().toLowerCase();
    const label = String(r.size || '').trim().toLowerCase();

    const sold =
      sizeSales.get(`${pid}|${slug}`) ||
      sizeSales.get(`${pid}|${label}`) ||
      variationSales.get(Number(r.variation_id)) || {
        units_sold: 0,
        sales_amount: 0,
      };

    const qty = r.stock_quantity == null ? null : Number(r.stock_quantity);
    const soldOut = r.stock_status === 'outofstock' || (qty != null && qty <= 0);

    if (!result.has(pid)) result.set(pid, []);
    result.get(pid).push({
      variation_id: Number(r.variation_id),
      size: r.size || '—',
      units_sold: sold.units_sold,
      sales_amount: sold.sales_amount,
      available_qty: qty,
      sold_out: soldOut,
    });
  }
  return result;
}

function buildFilterMeta(range) {
  const filter = { period: range.period, label: range.label };

  if (range.date) filter.date = range.date;

  if (range.date_from) filter.date_from = range.date_from;
  if (range.date_to) filter.date_to = range.date_to;

  if (range.year != null) filter.year = range.year;
  if (range.month != null) filter.month = range.month;

  return filter;
}

async function getInventory(req) {
  const range = resolveInventoryPeriod(req.query);
  const search = (req.query.search || '').trim();
  const sort = SORT_HANDLERS[req.query.sort] ? req.query.sort : 'most_sold';

  const availableYears = await getAvailableYears();

  if (!range.start || !range.end) {
    return {
      filter: buildFilterMeta(range),
      summary: {
        total_units_sold: 0,
        total_products_sold: 0,
        total_sales: 0,
        orders: 0,
      },
      products: [],
      available_years: availableYears,
    };
  }

  const [products, { salesMap, summary }, variationSales, sizeSales] = await Promise.all([
    getProducts(search),
    getSalesAggregation(range.start, range.end),
    getVariationSales(range.start, range.end),
    getSizeSales(range.start, range.end),
  ]);

  const sizesMap = await getSizesByProduct(
    products.map((p) => Number(p.id)),
    variationSales,
    sizeSales
  );

  const merged = products.map((product) => {
    const sales = salesMap.get(Number(product.id)) || { units_sold: 0, sales_amount: 0 };
    const sizes = sizesMap.get(Number(product.id)) || [];

    // Only trust stock when at least one size actually has a stock quantity
    const hasStock = sizes.some((s) => s.available_qty != null);

    const availableQty = sizes.length
      ? hasStock
        ? sizes.reduce((sum, s) => sum + (s.available_qty || 0), 0)
        : null
      : product.stock_quantity == null
        ? null
        : Number(product.stock_quantity);

    return {
      id: product.id,
      name: product.name,
      sku: product.sku || '',
      image_url: product.image_url || null,
      units_sold: sales.units_sold,
      sales_amount: sales.sales_amount,
      available_qty: availableQty,
      sold_out: sizes.length
        ? hasStock && sizes.every((s) => s.sold_out)
        : product.stock_status === 'outofstock' ||
          (availableQty != null && availableQty <= 0),
      sizes,
    };
  });

  merged.sort(SORT_HANDLERS[sort]);

  return {
    filter: buildFilterMeta(range),
    summary,
    products: merged,
    available_years: availableYears,
  };
}

module.exports = { getInventory };