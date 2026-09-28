import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DownloadIcon from '@mui/icons-material/Download';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { getCustomers } from '../api/customers';
import {
  downloadReports,
  getReportSchedule,
  getReportSummary,
  getReports,
  saveReportSchedule,
} from '../api/reports';
import DataTable from '../components/DataTable';
import PageHeader from '../components/PageHeader';
import { useSnackbar } from '../context/SnackbarContext';
import useDebounce from '../hooks/useDebounce';
import { formatCurrency, formatDate, fullName } from '../utils/format';
import * as XLSX from 'xlsx';

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'select_date', label: 'Select date' },
  { value: 'last_7_days', label: 'Last 7 Days' },
  { value: 'last_30_days', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
  { value: 'custom', label: 'Custom Date Range' },
];

const REPORT_DAY_OPTIONS = [
  { value: 'previous', label: 'Previous day' },
  { value: 'today', label: 'Current day' },
];

function StatCard({ label, value }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" fontWeight={700}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function Reports() {
  const { showToast } = useSnackbar();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(20);
  const [range, setRange] = useState('today');
  const [selectDate, setSelectDate] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [state, setState] = useState({ rows: [], total: 0, loading: true, error: null });
  const [summary, setSummary] = useState(null);
  const [rangeLabel, setRangeLabel] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedCustomers, setSelectedCustomers] = useState([]);
  const [selectedOrders, setSelectedOrders] = useState(new Set());
  const [downloading, setDownloading] = useState('');

  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [smtpStatus, setSmtpStatus] = useState(null);
  const [scheduleForm, setScheduleForm] = useState({
    admin_email: '',
    send_time: '08:00',
    report_day: 'previous',
    timezone: 'Asia/Kolkata',
  });
  const requestIdRef = useRef(0);

  useEffect(() => {
    getCustomers({ limit: 500, sort: 'name', dir: 'asc' })
      .then((r) => setCustomers(r.data.data || []))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    getReportSchedule()
      .then(({ data }) => {
        setScheduleForm({
          admin_email: data.schedule?.admin_email || '',
          send_time: data.schedule?.send_time || '08:00',
          report_day: data.schedule?.report_day || 'previous',
          timezone: data.schedule?.timezone || 'Asia/Kolkata',
        });
        setSmtpStatus(data.smtp || null);
      })
      .catch(() => setSmtpStatus(null))
      .finally(() => setScheduleLoading(false));
  }, []);

  const customerIds = useMemo(
    () => selectedCustomers.map((c) => c.user_id ?? c.customer_id ?? c.id).filter(Boolean),
    [selectedCustomers]
  );

  const filterParams = useMemo(
    () => ({
      range,
      date: range === 'select_date' ? selectDate : undefined,
      date_from: range === 'custom' ? dateFrom : undefined,
      date_to: range === 'custom' ? dateTo : undefined,
      customer_ids: customerIds.length ? customerIds.join(',') : undefined,
      search: debouncedSearch || undefined,
    }),
    [range, selectDate, dateFrom, dateTo, customerIds.join(','), debouncedSearch]
  );

  const load = useCallback(async () => {
  // Do not request an incomplete custom range.
  if (range === 'custom' && (!dateFrom || !dateTo)) {
    setState((s) => ({
      ...s,
      rows: [],
      total: 0,
      loading: false,
      error: null,
    }));

    setSummary(null);
    setRangeLabel('Custom date range');
    return;
  }

  // Do not request an incomplete single-date range.
  if (range === 'select_date' && !selectDate) {
    setState((s) => ({
      ...s,
      rows: [],
      total: 0,
      loading: false,
      error: null,
    }));

    setSummary(null);
    setRangeLabel('Select date');
    return;
  }

  // Every load gets a unique ID.
  // Older responses are ignored if a newer request has started.
  const requestId = ++requestIdRef.current;

  setState((s) => ({
    ...s,
    loading: true,
    error: null,
  }));

  try {
    const [listRes, summaryRes] = await Promise.all([
      getReports({
        page: page + 1,
        limit,
        ...filterParams,
      }),

      getReportSummary(filterParams),
    ]);

    // Ignore stale/old API responses.
    if (requestId !== requestIdRef.current) {
      return;
    }

    setState({
      rows: listRes.data.data || [],
      total: listRes.data.total || 0,
      loading: false,
      error: null,
    });

    setSummary(summaryRes.data);

    setRangeLabel(
      listRes.data.range?.label ||
      summaryRes.data.range?.label ||
      ''
    );
  } catch (e) {
    // Ignore errors from stale requests too.
    if (requestId !== requestIdRef.current) {
      return;
    }

    setState((s) => ({
      ...s,
      loading: false,
      error: e.message,
      rows: [],
      total: 0,
    }));

    setSummary(null);
  }
}, [
  page,
  limit,
  filterParams,
  range,
  selectDate,
  dateFrom,
  dateTo,
]);

  useEffect(() => {
    setPage(0);
  }, [filterParams]);

  useEffect(() => {
    load();
  }, [load]);

  const downloadOpts = () => ({
    customerIds,
    orderIds: [...selectedOrders],
    range,
    date: range === 'select_date' ? selectDate : undefined,
    dateFrom: range === 'custom' ? dateFrom : undefined,
    dateTo: range === 'custom' ? dateTo : undefined,
  });

  const runDownload = async (type) => {
    setDownloading(type);
    try {
      await downloadReports({ type, ...downloadOpts() });
      const orderIds = [...selectedOrders];
      const countLabel =
        orderIds.length > 0
          ? `${orderIds.length} selected order(s) in one file`
          : range === 'today'
            ? "today's orders"
            : 'matching orders';
      showToast(
        `${type === 'invoice' ? 'Invoices' : 'Packing slips'} downloaded (${countLabel})`,
        'success'
      );
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setDownloading('');
    }
  };
  const runExportExcel = async () => {
    setDownloading('excel');
    try {
      // Fetch all rows matching the current filters
      const { data } = await getReports({ page: 1, limit: 10000, ...filterParams });
      let rows = data.data || [];
  
      // If specific orders are ticked, export only those
      if (selectedOrders.size > 0) {
        rows = rows.filter((r) => selectedOrders.has(r.order_id));
      }
  
      if (!rows.length) {
        showToast('No orders to export', 'error');
        return;
      }
  
      const sheetData = rows.map((r) => ({
        'Order #': r.order_id,
        Customer: r.customer_name || '—',
        Email: r.billing_email || '—',
        'Invoice #': r.invoice_number ?? '—',
        'Packing Slip #': r.packing_slip_number ?? '—',
        Total: r.total_amount,
        'Order Date': formatDate(r.date_created_gmt),
      }));
  
      const worksheet = XLSX.utils.json_to_sheet(sheetData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Reports');
  
      const filename = `brassleaf-reports-${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(workbook, filename);
  
      const label =
        selectedOrders.size > 0
          ? `${rows.length} selected order(s)`
          : `${rows.length} order(s)`;
      showToast(`Excel sheet downloaded (${label})`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setDownloading('');
    }
  };

  const handleSaveSchedule = async () => {
    setScheduleSaving(true);
    try {
      const { data } = await saveReportSchedule(scheduleForm);
      setScheduleForm({
        admin_email: data.schedule?.admin_email || scheduleForm.admin_email,
        send_time: data.schedule?.send_time || scheduleForm.send_time,
        report_day: data.schedule?.report_day || scheduleForm.report_day,
        timezone: data.schedule?.timezone || 'Asia/Kolkata',
      });
      setSmtpStatus(data.smtp || null);
      showToast('Daily email schedule saved', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setScheduleSaving(false);
    }
  };

  const toggleOrder = (orderId) => {
    setSelectedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedOrders.size === state.rows.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(state.rows.map((r) => r.order_id)));
    }
  };

  const columns = [
    {
      id: 'select',
      label: (
        <Checkbox
          size="small"
          checked={state.rows.length > 0 && selectedOrders.size === state.rows.length}
          indeterminate={selectedOrders.size > 0 && selectedOrders.size < state.rows.length}
          onChange={toggleAll}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      width: 48,
      render: (r) => (
        <Checkbox
          size="small"
          checked={selectedOrders.has(r.order_id)}
          onChange={() => toggleOrder(r.order_id)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      id: 'order_id',
      label: 'Order',
      width: 90,
      render: (r) => `#${r.order_id}`,
    },
    {
      id: 'customer',
      label: 'Customer',
      render: (r) => (
        <Box>
          <Typography variant="body2" fontWeight={600}>
            {r.customer_name || '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {r.billing_email || '—'}
          </Typography>
        </Box>
      ),
    },
    {
      id: 'invoice',
      label: 'Invoice #',
      render: (r) => (r.invoice_number != null ? `#${r.invoice_number}` : '—'),
    },
    {
      id: 'packing_slip',
      label: 'Packing slip #',
      render: (r) => (r.packing_slip_number != null ? `#${r.packing_slip_number}` : '—'),
    },
    {
      id: 'total',
      label: 'Total',
      align: 'right',
      render: (r) => formatCurrency(r.total_amount),
    },
    {
      id: 'date',
      label: 'Order date',
      render: (r) => formatDate(r.date_created_gmt),
    },
    {
      id: 'actions',
      label: 'Download',
      render: (r) => (
        <Stack direction="row" spacing={0.5} onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            variant="outlined"
            disabled={Boolean(downloading)}
            onClick={() =>
              downloadReports({ type: 'invoice', orderIds: [r.order_id] })
                .then(() => showToast(`Invoice #${r.invoice_number || r.order_id} downloaded`, 'success'))
                .catch((e) => showToast(e.message, 'error'))
            }
          >
            Invoice
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={Boolean(downloading)}
            onClick={() =>
              downloadReports({ type: 'packing-slip', orderIds: [r.order_id] })
                .then(() => showToast(`Packing slip #${r.order_id} downloaded`, 'success'))
                .catch((e) => showToast(e.message, 'error'))
            }
          >
            Slip
          </Button>
        </Stack>
      ),
    },
  ];

  return (
    <Box>
      <PageHeader
        title="Reports"
        subtitle={`Live WooCommerce data${rangeLabel ? ` for ${rangeLabel}` : ''}`}
        actions={
          <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
            {selectedOrders.size > 0 && (
              <Chip
                size="small"
                color="primary"
                label={`${selectedOrders.size} order${selectedOrders.size === 1 ? '' : 's'} selected`}
              />
            )}
            <Button
              variant="contained"
              startIcon={<DownloadIcon />}
              disabled={Boolean(downloading)}
              onClick={() => runDownload('invoice')}
            >
              {downloading === 'invoice' ? 'Downloading…' : 'Download invoices'}
            </Button>
            <Button
              variant="outlined"
              startIcon={<DownloadIcon />}
              disabled={Boolean(downloading)}
              onClick={() => runDownload('packing-slip')}
            >
              {downloading === 'packing-slip' ? 'Downloading…' : 'Download packing slips'}
            </Button>
            <Button
  variant="outlined"
  startIcon={<DownloadIcon />}
  disabled={Boolean(downloading)}
  onClick={runExportExcel}
>
  {downloading === 'excel' ? 'Downloading…' : 'Download Excel'}
</Button>
          </Stack>
        }
      />

      <Stack spacing={2} sx={{ mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField
            select
            size="small"
            label="Range"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            sx={{ minWidth: 200 }}
          >
            {RANGE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="body2" color="text.secondary">
            Asia/Kolkata
          </Typography>
        </Stack>

        {range === 'select_date' && (
          <TextField
            size="small"
            type="date"
            label="Select date"
            value={selectDate}
            onChange={(e) => setSelectDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ maxWidth: 220 }}
          />
        )}

        {range === 'custom' && (
          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              type="date"
              label="From"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              size="small"
              type="date"
              label="To"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        )}

        {/* <Autocomplete
          multiple
          options={customers}
          value={selectedCustomers}
          onChange={(_, value) => setSelectedCustomers(value)}
          getOptionLabel={(c) =>
            `${fullName(c.first_name, c.last_name) !== '—' ? fullName(c.first_name, c.last_name) : c.username || 'Customer'} (${c.email || 'no email'})`
          }
          isOptionEqualToValue={(a, b) =>
            (a.customer_id ?? a.id) === (b.customer_id ?? b.id)
          }
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip
                {...getTagProps({ index })}
                key={option.customer_id ?? option.id}
                label={fullName(option.first_name, option.last_name)}
                size="small"
              />
            ))
          }
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              label="Filter by customers"
              placeholder="Select customers"
            />
          )}
          sx={{ maxWidth: 640 }}
        /> */}

        {/* <TextField
          size="small"
          placeholder="Search order, email, or document number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 280, maxWidth: 420 }}
        /> */}
      </Stack>

      {summary && (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
            <StatCard label="Total Sales" value={formatCurrency(summary.total_sales)} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
            <StatCard label="Total Collected" value={formatCurrency(summary.total_collected)} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
            <StatCard label="Refunded Amount" value={formatCurrency(summary.refunded_amount)} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
            <StatCard label="Subtotal" value={formatCurrency(summary.subtotal)} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
            <StatCard label="Net Sales" value={formatCurrency(summary.net_sales)} />
          </Grid>
        </Grid>
      )}

      <DataTable
        columns={columns}
        rows={state.rows}
        loading={state.loading}
        error={state.error}
        page={page}
        rowsPerPage={limit}
        total={state.total}
        onPageChange={setPage}
        onRowsPerPageChange={(n) => {
          setLimit(n);
          setPage(0);
        }}
        emptyTitle="No documents found"
        emptyDescription="Try changing the date range, customer filter, or search."
      />

      <Card variant="outlined" sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" fontWeight={700} gutterBottom>
            Automatic daily email
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 900 }}>
            The backend sends a combined invoice and packing slip PDF at the time below (Asia/Kolkata).
            Days with zero valid orders are skipped. Recipient defaults to the WordPress admin email.
          </Typography>

          {!scheduleLoading && smtpStatus && (
            <Alert
              severity={smtpStatus.ok ? 'success' : 'warning'}
              icon={smtpStatus.ok ? <CheckCircleOutlineIcon /> : <ErrorOutlineIcon />}
              sx={{ mb: 2 }}
            >
              {smtpStatus.ok
                ? `SMTP connection verified (${smtpStatus.user_masked}).`
                : smtpStatus.error || 'SMTP is not configured correctly.'}
            </Alert>
          )}

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                fullWidth
                size="small"
                label="Admin email"
                type="email"
                value={scheduleForm.admin_email}
                onChange={(e) =>
                  setScheduleForm((f) => ({ ...f, admin_email: e.target.value }))
                }
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                size="small"
                label="Send time"
                type="time"
                value={scheduleForm.send_time}
                onChange={(e) =>
                  setScheduleForm((f) => ({ ...f, send_time: e.target.value }))
                }
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                select
                size="small"
                label="Report day"
                value={scheduleForm.report_day}
                onChange={(e) =>
                  setScheduleForm((f) => ({ ...f, report_day: e.target.value }))
                }
              >
                {REPORT_DAY_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                size="small"
                label="Timezone"
                value={scheduleForm.timezone}
                InputProps={{ readOnly: true }}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <Stack direction="row" justifyContent="flex-end">
                <Button
                  variant="contained"
                  disabled={scheduleSaving || scheduleLoading}
                  onClick={handleSaveSchedule}
                >
                  {scheduleSaving ? 'Saving…' : 'Save schedule'}
                </Button>
              </Stack>
            </Grid>
          </Grid>
        </CardContent>
      </Card>
    </Box>
  );
}
