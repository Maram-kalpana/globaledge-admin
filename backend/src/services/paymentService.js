const pool = require('../config/db');
const P = require('../config/prefix');
const { parseList, listResponse } = require('../utils/listParams');
const { nowGmt } = require('../utils/datetime');
const { withTransaction } = require('../utils/transaction');
const { httpError } = require('../utils/httpError');
const orderService = require('./orderService');
const { ensureInvoiceNumber } = require('./invoiceService');

const SORT = {
  date: 'p.date_added',
  amount: 'o.total_amount',
  order: 'p.order_id',
  status: 'p.status',
  id: 'p.id',
};


function getDateRangeFilters(req) {
  const dateFrom =
    String(
      req?.query?.date_from || ''
    ).trim();

  const dateTo =
    String(
      req?.query?.date_to || ''
    ).trim();

  const isValidDate = (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value);

  if (
    !dateFrom ||
    !dateTo ||
    !isValidDate(dateFrom) ||
    !isValidDate(dateTo)
  ) {
    return {
      dateFrom: null,
      dateTo: null,
    };
  }

  if (dateFrom > dateTo) {
    return {
      dateFrom: null,
      dateTo: null,
    };
  }

  return {
    dateFrom,
    dateTo,
  };
}

/** Safe gateway fields from paytm_response JSON (no secrets/card data). */
function parsePaytmResponse(raw) {
  if (!raw) return { gateway: {}, raw: null };
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { gateway: {}, raw: String(raw) };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { gateway: {}, raw: parsed };
  }

  const gateway = {
    TXNID: parsed.TXNID || null,
    BANKTXNID: parsed.BANKTXNID || null,
    ORDERID: parsed.ORDERID || null,
    TXNAMOUNT: parsed.TXNAMOUNT || null,
    STATUS: parsed.STATUS || null,
    TXNTYPE: parsed.TXNTYPE || null,
    GATEWAYNAME: parsed.GATEWAYNAME || null,
    RESPCODE: parsed.RESPCODE || null,
    RESPMSG: parsed.RESPMSG || null,
    MID: parsed.MID || null,
    PAYMENTMODE: parsed.PAYMENTMODE || null,
    REFUNDAMT: parsed.REFUNDAMT || null,
    TXNDATE: parsed.TXNDATE || null,
  };

  // Expose remaining non-sensitive keys for details UI
  const extra = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (gateway[k] !== undefined) continue;
    const key = String(k).toUpperCase();
    if (
      key.includes('KEY') ||
      key.includes('SECRET') ||
      key.includes('PASSWORD') ||
      key.includes('TOKEN') ||
      key.includes('CVV') ||
      key.includes('CARD')
    ) {
      continue;
    }
    extra[k] = v;
  }

  return { gateway, raw: { ...gateway, ...extra } };
}

function shapePaymentRow(row) {
  const { gateway, raw } = parsePaytmResponse(row.paytm_response);
  const amount =
    gateway.TXNAMOUNT != null && gateway.TXNAMOUNT !== ''
      ? Number(gateway.TXNAMOUNT)
      : row.total_amount != null
        ? Number(row.total_amount)
        : null;

  return {
    id: row.id,
    payment_id: row.id,
    order_id: row.order_id,
    paytm_order_id: row.paytm_order_id,
    transaction_id: row.transaction_id || gateway.TXNID || null,
    status: row.status,
    status_label: row.status === '1' ? 'success' : 'pending_or_failed',
    date_added: row.date_added,
    date_modified: row.date_modified,
    total_amount: row.total_amount != null ? Number(row.total_amount) : null,
    amount,
    currency: row.currency || 'INR',
    billing_email: row.billing_email || null,
    order_status: row.order_status || null,
    payment_method: row.payment_method || 'paytm',
    payment_method_title: row.payment_method_title || 'Paytm',
    order_transaction_id: row.order_transaction_id || null,
    customer: {
      first_name: row.first_name || null,
      last_name: row.last_name || null,
      phone: row.phone || null,
      email: row.billing_email || null,
    },
    // Flattened gateway fields for list + details
    TXNID: gateway.TXNID,
    BANKTXNID: gateway.BANKTXNID,
    ORDERID: gateway.ORDERID,
    TXNAMOUNT: gateway.TXNAMOUNT,
    STATUS: gateway.STATUS,
    TXNTYPE: gateway.TXNTYPE,
    GATEWAYNAME: gateway.GATEWAYNAME,
    RESPCODE: gateway.RESPCODE,
    RESPMSG: gateway.RESPMSG,
    MID: gateway.MID,
    PAYMENTMODE: gateway.PAYMENTMODE,
    REFUNDAMT: gateway.REFUNDAMT,
    TXNDATE: gateway.TXNDATE,
    gateway,
    paytm_response: raw,
  };
}

async function statsSummary(req) {
  const {
    dateFrom,
    dateTo,
  } = getDateRangeFilters(req);

  const params = [];

  let dateWhere = '';

  if (dateFrom && dateTo) {
    dateWhere = `
      AND p.date_added >= ?
      AND p.date_added < DATE_ADD(?, INTERVAL 1 DAY)
    `;

    params.push(
      `${dateFrom} 00:00:00`,
      dateTo
    );
  }

  const [[summary]] =
    await pool.query(
      `
      SELECT

        COUNT(*) AS total_transactions,

        SUM(
          CASE
            WHEN
              p.status = '1'
              AND o.status IN (
                'wc-processing',
                'wc-completed'
              )
            THEN 1
            ELSE 0
          END
        ) AS successful,

        SUM(
          CASE
            WHEN NOT (
              p.status = '1'
              AND o.status IN (
                'wc-processing',
                'wc-completed'
              )
            )
            THEN 1
            ELSE 0
          END
        ) AS failed_or_pending,

        ROUND(
          COALESCE(
            SUM(
              CASE
                WHEN
                  p.status = '1'
                  AND o.status IN (
                    'wc-processing',
                    'wc-completed'
                  )
                THEN o.total_amount
                ELSE 0
              END
            ),
            0
          ),
          2
        ) AS total_collected

      FROM ${P}paytm_order_data p

      JOIN ${P}wc_orders o
        ON o.id = p.order_id

      WHERE 1 = 1

      ${dateWhere}
      `,
      params
    );

  return {
    total_transactions:
      Number(
        summary.total_transactions
      ) || 0,

    successful:
      Number(
        summary.successful
      ) || 0,

    failed_or_pending:
      Number(
        summary.failed_or_pending
      ) || 0,

    total_collected:
      Number(
        summary.total_collected
      ) || 0,
  };
}
// async function statsSummary() {
//   const [[summary]] =
//     await pool.query(
//       `
//       SELECT
//         COUNT(*) AS total_transactions,

//         COUNT(*) AS successful,

//         0 AS failed_or_pending,

//         ROUND(
//           COALESCE(
//             SUM(o.total_amount),
//             0
//           ),
//           2
//         ) AS total_collected

//       FROM ${P}paytm_order_data p

//       JOIN ${P}wc_orders o
//         ON o.id = p.order_id

//       WHERE
//         p.status = '1'
//         AND o.status IN (
//           'wc-processing',
//           'wc-completed'
//         )
//       `
//     );

//   const [byMonth] =
//     await pool.query(
//       `
//       SELECT
//         DATE_FORMAT(
//           p.date_added,
//           '%Y-%m'
//         ) AS month,

//         COUNT(*) AS transactions,

//         ROUND(
//           SUM(o.total_amount),
//           2
//         ) AS revenue

//       FROM ${P}paytm_order_data p

//       JOIN ${P}wc_orders o
//         ON o.id = p.order_id

//       WHERE
//         p.status = '1'
//         AND o.status IN (
//           'wc-processing',
//           'wc-completed'
//         )

//       GROUP BY month
//       ORDER BY month DESC
//       LIMIT 12
//       `
//     );

//   return {
//     ...summary,
//     summary,
//     byMonth,
//   };
// }

async function list(req) {
  const { page, limit, offset, sortCol, dir, search } = parseList(req, SORT, 'date');
  const status = req.query.status; // '0' | '1' | undefined
  const params = [];
  const {
    dateFrom,
    dateTo,
  } = getDateRangeFilters(req);

  /*
   * Admin Payments page:
   * show ALL Paytm payments (successful, pending, failed) by default.
   * Optional ?status=0|1 lets the UI filter down to one bucket later.
   */
  let where = `1 = 1`;

  if (status === '0' || status === '1') {
    where += ` AND p.status = ?`;
    params.push(status);
  }

  if (dateFrom && dateTo) {
    where += `
      AND p.date_added >= ?
      AND p.date_added < DATE_ADD(?, INTERVAL 1 DAY)
    `;
    params.push(`${dateFrom} 00:00:00`, dateTo);
  }

  if (search) {
    where += ` AND (
      p.paytm_order_id LIKE ? OR p.transaction_id LIKE ? OR o.billing_email LIKE ?
      OR CAST(p.order_id AS CHAR) LIKE ? OR a.first_name LIKE ? OR a.last_name LIKE ?
      OR p.paytm_response LIKE ?
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q, q, q, q);
  }

  const from = `
    FROM ${P}paytm_order_data p
    JOIN ${P}wc_orders o ON o.id = p.order_id
    LEFT JOIN ${P}wc_order_addresses a
      ON a.order_id = p.order_id AND a.address_type = 'billing'`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${from} WHERE ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT
       p.id, p.order_id, p.paytm_order_id, p.transaction_id, p.status,
       p.paytm_response, p.date_added, p.date_modified,
       o.total_amount, o.currency, o.billing_email, o.status AS order_status,
       o.payment_method, o.payment_method_title, o.transaction_id AS order_transaction_id,
       a.first_name, a.last_name, a.phone
     ${from}
     WHERE ${where}
     ORDER BY ${sortCol} ${dir}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return listResponse(rows.map(shapePaymentRow), total, page, limit);
}

async function getById(id) {
  // Accept payment id OR order id
  const [[row]] = await pool.query(
    `SELECT
       p.id, p.order_id, p.paytm_order_id, p.transaction_id, p.status,
       p.paytm_response, p.date_added, p.date_modified,
       o.total_amount, o.currency, o.billing_email, o.status AS order_status,
       o.payment_method, o.payment_method_title, o.transaction_id AS order_transaction_id,
       o.customer_id, o.tax_amount, o.date_created_gmt,
       a.first_name, a.last_name, a.phone, a.address_1, a.address_2,
       a.city, a.state, a.postcode, a.country, a.email AS billing_addr_email
     FROM ${P}paytm_order_data p
     JOIN ${P}wc_orders o ON o.id = p.order_id
     LEFT JOIN ${P}wc_order_addresses a
       ON a.order_id = p.order_id AND a.address_type = 'billing'
     WHERE p.id = ? OR p.order_id = ?
     ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [id, id, id]
  );
  if (!row) throw httpError(404, 'Payment not found');

  const shaped = shapePaymentRow(row);

  let orderDetail = null;
  try {
    orderDetail = await orderService.getById(row.order_id);
  } catch {
    orderDetail = null;
  }

  let customer = null;
  if (row.customer_id) {
    const [[cl]] = await pool.query(
      `SELECT customer_id, user_id, username, first_name, last_name, email,
              country, state, city, postcode, date_registered, date_last_active
       FROM ${P}wc_customer_lookup WHERE user_id = ? LIMIT 1`,
      [row.customer_id]
    );
    customer = cl || null;
  }

  return {
    ...shaped,
    billing_address: {
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      email: row.billing_addr_email || row.billing_email,
      address_1: row.address_1,
      address_2: row.address_2,
      city: row.city,
      state: row.state,
      postcode: row.postcode,
      country: row.country,
    },
    order: orderDetail,
    customer_record: customer,
  };
}

/** @deprecated prefer getById — kept for route compatibility */
async function getByOrderId(orderId) {
  return getById(orderId);
}

async function reconcile(orderId, body = {}) {
  const payment = await getById(orderId);
  const status = body.status != null ? String(body.status) : null;
  if (status !== '0' && status !== '1') {
    throw httpError(400, "status must be '0' or '1'");
  }

  const targetOrderId = payment.order_id;

  await withTransaction(pool, async (conn) => {
    await conn.query(
      `UPDATE ${P}paytm_order_data SET status = ?, date_modified = NOW() WHERE order_id = ?`,
      [status, targetOrderId]
    );

    if (status === '1' && body.sync_order !== false) {
      const gmt = nowGmt();
      await conn.query(
        `UPDATE ${P}wc_order_operational_data
         SET date_paid_gmt = COALESCE(date_paid_gmt, ?)
         WHERE order_id = ?`,
        [gmt, targetOrderId]
      );
      if (payment.transaction_id) {
        await conn.query(
          `UPDATE ${P}wc_orders SET transaction_id = COALESCE(NULLIF(transaction_id,''), ?), date_updated_gmt = ?
           WHERE id = ?`,
          [payment.transaction_id, gmt, targetOrderId]
        );
      }
      const nextStatus = orderService.normalizeStatus(body.order_status || 'processing');
      if (nextStatus) {
        await conn.query(
          `UPDATE ${P}wc_orders SET status = ?, date_updated_gmt = ? WHERE id = ?`,
          [nextStatus, gmt, targetOrderId]
        );
        await conn.query(
          `UPDATE ${P}posts SET post_status = ? WHERE ID = ? AND post_type = 'shop_order_placehold'`,
          [nextStatus, targetOrderId]
        );
        await conn.query(
          `UPDATE ${P}wc_order_stats SET status = ? WHERE order_id = ?`,
          [nextStatus, targetOrderId]
        );

        // Order just moved into a paid/fulfillable state — make sure an invoice number exists,
        // same as WordPress/PDF Invoices plugin would generate on this status transition.
        if (['processing', 'completed'].includes(nextStatus)) {
          await ensureInvoiceNumber(targetOrderId, conn);
        }
      }
    }
  });

  return getById(targetOrderId);
}
module.exports = { list, getById, getByOrderId, statsSummary, reconcile, parsePaytmResponse };


// const pool = require('../config/db');
// const P = require('../config/prefix');
// const { parseList, listResponse } = require('../utils/listParams');
// const { nowGmt } = require('../utils/datetime');
// const { withTransaction } = require('../utils/transaction');
// const { httpError } = require('../utils/httpError');
// const orderService = require('./orderService');

// const SORT = {
//   date: 'p.date_added',
//   amount: 'o.total_amount',
//   order: 'p.order_id',
//   status: 'p.status',
//   id: 'p.id',
// };

// /** Safe gateway fields from paytm_response JSON (no secrets/card data). */
// function parsePaytmResponse(raw) {
//   if (!raw) return { gateway: {}, raw: null };
//   let parsed = raw;
//   if (typeof raw === 'string') {
//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       return { gateway: {}, raw: String(raw) };
//     }
//   }
//   if (!parsed || typeof parsed !== 'object') {
//     return { gateway: {}, raw: parsed };
//   }

//   const gateway = {
//     TXNID: parsed.TXNID || null,
//     BANKTXNID: parsed.BANKTXNID || null,
//     ORDERID: parsed.ORDERID || null,
//     TXNAMOUNT: parsed.TXNAMOUNT || null,
//     STATUS: parsed.STATUS || null,
//     TXNTYPE: parsed.TXNTYPE || null,
//     GATEWAYNAME: parsed.GATEWAYNAME || null,
//     RESPCODE: parsed.RESPCODE || null,
//     RESPMSG: parsed.RESPMSG || null,
//     MID: parsed.MID || null,
//     PAYMENTMODE: parsed.PAYMENTMODE || null,
//     REFUNDAMT: parsed.REFUNDAMT || null,
//     TXNDATE: parsed.TXNDATE || null,
//   };

//   // Expose remaining non-sensitive keys for details UI
//   const extra = {};
//   for (const [k, v] of Object.entries(parsed)) {
//     if (gateway[k] !== undefined) continue;
//     const key = String(k).toUpperCase();
//     if (
//       key.includes('KEY') ||
//       key.includes('SECRET') ||
//       key.includes('PASSWORD') ||
//       key.includes('TOKEN') ||
//       key.includes('CVV') ||
//       key.includes('CARD')
//     ) {
//       continue;
//     }
//     extra[k] = v;
//   }

//   return { gateway, raw: { ...gateway, ...extra } };
// }

// function shapePaymentRow(row) {
//   const { gateway, raw } = parsePaytmResponse(row.paytm_response);
//   const amount =
//     gateway.TXNAMOUNT != null && gateway.TXNAMOUNT !== ''
//       ? Number(gateway.TXNAMOUNT)
//       : row.total_amount != null
//         ? Number(row.total_amount)
//         : null;

//   return {
//     id: row.id,
//     payment_id: row.id,
//     order_id: row.order_id,
//     paytm_order_id: row.paytm_order_id,
//     transaction_id: row.transaction_id || gateway.TXNID || null,
//     status: row.status,
//     status_label: row.status === '1' ? 'success' : 'pending_or_failed',
//     date_added: row.date_added,
//     date_modified: row.date_modified,
//     total_amount: row.total_amount != null ? Number(row.total_amount) : null,
//     amount,
//     currency: row.currency || 'INR',
//     billing_email: row.billing_email || null,
//     order_status: row.order_status || null,
//     payment_method: row.payment_method || 'paytm',
//     payment_method_title: row.payment_method_title || 'Paytm',
//     order_transaction_id: row.order_transaction_id || null,
//     customer: {
//       first_name: row.first_name || null,
//       last_name: row.last_name || null,
//       phone: row.phone || null,
//       email: row.billing_email || null,
//     },
//     // Flattened gateway fields for list + details
//     TXNID: gateway.TXNID,
//     BANKTXNID: gateway.BANKTXNID,
//     ORDERID: gateway.ORDERID,
//     TXNAMOUNT: gateway.TXNAMOUNT,
//     STATUS: gateway.STATUS,
//     TXNTYPE: gateway.TXNTYPE,
//     GATEWAYNAME: gateway.GATEWAYNAME,
//     RESPCODE: gateway.RESPCODE,
//     RESPMSG: gateway.RESPMSG,
//     MID: gateway.MID,
//     PAYMENTMODE: gateway.PAYMENTMODE,
//     REFUNDAMT: gateway.REFUNDAMT,
//     TXNDATE: gateway.TXNDATE,
//     gateway,
//     paytm_response: raw,
//   };
// }

// // async function statsSummary() {
// //   const [[summary]] = await pool.query(
// //     `SELECT
// //        COUNT(*) AS total_transactions,
// //        SUM(CASE WHEN p.status = '1' THEN 1 ELSE 0 END) AS successful,
// //        SUM(CASE WHEN p.status = '0' THEN 1 ELSE 0 END) AS failed_or_pending,
// //        ROUND(SUM(CASE WHEN p.status = '1' THEN o.total_amount ELSE 0 END), 2) AS total_collected
// //      FROM ${P}paytm_order_data p
// //      JOIN ${P}wc_orders o ON o.id = p.order_id`
// //   );

// //   const [byMonth] = await pool.query(
// //     `SELECT
// //        DATE_FORMAT(p.date_added, '%Y-%m') AS month,
// //        COUNT(*) AS transactions,
// //        ROUND(SUM(o.total_amount), 2) AS revenue
// //      FROM ${P}paytm_order_data p
// //      JOIN ${P}wc_orders o ON o.id = p.order_id
// //      WHERE p.status = '1'
// //      GROUP BY month
// //      ORDER BY month DESC
// //      LIMIT 12`
// //   );

// //   return {
// //     ...summary,
// //     summary,
// //     byMonth,
// //   };
// // }
// async function statsSummary() {
//   const [[summary]] =
//     await pool.query(
//       `
//       SELECT
//         COUNT(*) AS total_transactions,

//         COUNT(*) AS successful,

//         0 AS failed_or_pending,

//         ROUND(
//           COALESCE(
//             SUM(o.total_amount),
//             0
//           ),
//           2
//         ) AS total_collected

//       FROM ${P}paytm_order_data p

//       JOIN ${P}wc_orders o
//         ON o.id = p.order_id

//       WHERE
//         p.status = '1'
//         AND o.status IN (
//           'wc-processing',
//           'wc-completed'
//         )
//       `
//     );

//   const [byMonth] =
//     await pool.query(
//       `
//       SELECT
//         DATE_FORMAT(
//           p.date_added,
//           '%Y-%m'
//         ) AS month,

//         COUNT(*) AS transactions,

//         ROUND(
//           SUM(o.total_amount),
//           2
//         ) AS revenue

//       FROM ${P}paytm_order_data p

//       JOIN ${P}wc_orders o
//         ON o.id = p.order_id

//       WHERE
//         p.status = '1'
//         AND o.status IN (
//           'wc-processing',
//           'wc-completed'
//         )

//       GROUP BY month
//       ORDER BY month DESC
//       LIMIT 12
//       `
//     );

//   return {
//     ...summary,
//     summary,
//     byMonth,
//   };
// }

// async function list(req) {
//   const { page, limit, offset, sortCol, dir, search } = parseList(req, SORT, 'date');
//   const status = req.query.status;
//   // const params = [];
//   // let where = '1=1';

//   // if (status === '0' || status === '1') {
//   //   where += ` AND p.status = ?`;
//   //   params.push(status);
//   // }
//   const params = [];

// /*
//  * Admin Payments page:
//  * show only successful Paytm payments.
//  *
//  * p.status:
//  * 0 = pending/failed
//  * 1 = success
//  */
// let where = `
//   p.status = '1'
//   AND o.status IN (
//     'wc-processing',
//     'wc-completed'
//   )
// `;
//   if (search) {
//     where += ` AND (
//       p.paytm_order_id LIKE ? OR p.transaction_id LIKE ? OR o.billing_email LIKE ?
//       OR CAST(p.order_id AS CHAR) LIKE ? OR a.first_name LIKE ? OR a.last_name LIKE ?
//       OR p.paytm_response LIKE ?
//     )`;
//     const q = `%${search}%`;
//     params.push(q, q, q, q, q, q, q);
//   }

//   const from = `
//     FROM ${P}paytm_order_data p
//     JOIN ${P}wc_orders o ON o.id = p.order_id
//     LEFT JOIN ${P}wc_order_addresses a
//       ON a.order_id = p.order_id AND a.address_type = 'billing'`;

//   const [[{ total }]] = await pool.query(
//     `SELECT COUNT(*) AS total ${from} WHERE ${where}`,
//     params
//   );

//   const [rows] = await pool.query(
//     `SELECT
//        p.id, p.order_id, p.paytm_order_id, p.transaction_id, p.status,
//        p.paytm_response, p.date_added, p.date_modified,
//        o.total_amount, o.currency, o.billing_email, o.status AS order_status,
//        o.payment_method, o.payment_method_title, o.transaction_id AS order_transaction_id,
//        a.first_name, a.last_name, a.phone
//      ${from}
//      WHERE ${where}
//      ORDER BY ${sortCol} ${dir}
//      LIMIT ? OFFSET ?`,
//     [...params, limit, offset]
//   );

//   return listResponse(rows.map(shapePaymentRow), total, page, limit);
// }

// async function getById(id) {
//   // Accept payment id OR order id
//   const [[row]] = await pool.query(
//     `SELECT
//        p.id, p.order_id, p.paytm_order_id, p.transaction_id, p.status,
//        p.paytm_response, p.date_added, p.date_modified,
//        o.total_amount, o.currency, o.billing_email, o.status AS order_status,
//        o.payment_method, o.payment_method_title, o.transaction_id AS order_transaction_id,
//        o.customer_id, o.tax_amount, o.date_created_gmt,
//        a.first_name, a.last_name, a.phone, a.address_1, a.address_2,
//        a.city, a.state, a.postcode, a.country, a.email AS billing_addr_email
//      FROM ${P}paytm_order_data p
//      JOIN ${P}wc_orders o ON o.id = p.order_id
//      LEFT JOIN ${P}wc_order_addresses a
//        ON a.order_id = p.order_id AND a.address_type = 'billing'
//      WHERE p.id = ? OR p.order_id = ?
//      ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END
//      LIMIT 1`,
//     [id, id, id]
//   );
//   if (!row) throw httpError(404, 'Payment not found');

//   const shaped = shapePaymentRow(row);

//   let orderDetail = null;
//   try {
//     orderDetail = await orderService.getById(row.order_id);
//   } catch {
//     orderDetail = null;
//   }

//   let customer = null;
//   if (row.customer_id) {
//     const [[cl]] = await pool.query(
//       `SELECT customer_id, user_id, username, first_name, last_name, email,
//               country, state, city, postcode, date_registered, date_last_active
//        FROM ${P}wc_customer_lookup WHERE user_id = ? LIMIT 1`,
//       [row.customer_id]
//     );
//     customer = cl || null;
//   }

//   return {
//     ...shaped,
//     billing_address: {
//       first_name: row.first_name,
//       last_name: row.last_name,
//       phone: row.phone,
//       email: row.billing_addr_email || row.billing_email,
//       address_1: row.address_1,
//       address_2: row.address_2,
//       city: row.city,
//       state: row.state,
//       postcode: row.postcode,
//       country: row.country,
//     },
//     order: orderDetail,
//     customer_record: customer,
//   };
// }

// /** @deprecated prefer getById — kept for route compatibility */
// async function getByOrderId(orderId) {
//   return getById(orderId);
// }

// async function reconcile(orderId, body = {}) {
//   const payment = await getById(orderId);
//   const status = body.status != null ? String(body.status) : null;
//   if (status !== '0' && status !== '1') {
//     throw httpError(400, "status must be '0' or '1'");
//   }

//   const targetOrderId = payment.order_id;

//   await withTransaction(pool, async (conn) => {
//     await conn.query(
//       `UPDATE ${P}paytm_order_data SET status = ?, date_modified = NOW() WHERE order_id = ?`,
//       [status, targetOrderId]
//     );

//     if (status === '1' && body.sync_order !== false) {
//       const gmt = nowGmt();
//       await conn.query(
//         `UPDATE ${P}wc_order_operational_data
//          SET date_paid_gmt = COALESCE(date_paid_gmt, ?)
//          WHERE order_id = ?`,
//         [gmt, targetOrderId]
//       );
//       if (payment.transaction_id) {
//         await conn.query(
//           `UPDATE ${P}wc_orders SET transaction_id = COALESCE(NULLIF(transaction_id,''), ?), date_updated_gmt = ?
//            WHERE id = ?`,
//           [payment.transaction_id, gmt, targetOrderId]
//         );
//       }
//       const nextStatus = orderService.normalizeStatus(body.order_status || 'processing');
//       if (nextStatus) {
//         await conn.query(
//           `UPDATE ${P}wc_orders SET status = ?, date_updated_gmt = ? WHERE id = ?`,
//           [nextStatus, gmt, targetOrderId]
//         );
//         await conn.query(
//           `UPDATE ${P}posts SET post_status = ? WHERE ID = ? AND post_type = 'shop_order_placehold'`,
//           [nextStatus, targetOrderId]
//         );
//         await conn.query(
//           `UPDATE ${P}wc_order_stats SET status = ? WHERE order_id = ?`,
//           [nextStatus, targetOrderId]
//         );
//       }
//     }
//   });

//   return getById(targetOrderId);
// }

// module.exports = { list, getById, getByOrderId, statsSummary, reconcile, parsePaytmResponse };
