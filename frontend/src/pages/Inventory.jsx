import DownloadIcon from '@mui/icons-material/Download';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  Grid,
  Chip,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  IndianRupee,
  Package,
  ShoppingCart,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getInventory } from '../api/inventory';
import EmptyState from '../components/EmptyState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import PageHeader from '../components/PageHeader';
import { useSnackbar } from '../context/SnackbarContext';
import useDebounce from '../hooks/useDebounce';
import { downloadInventoryExcel } from '../utils/inventoryExcelExport';
import { formatCurrency, formatNumber } from '../utils/format';

const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'date', label: 'Date' },
  { value: 'range', label: 'Date Range' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const SORT_OPTIONS = [
  { value: 'most_sold', label: 'Most Sold' },
  { value: 'least_sold', label: 'Least Sold' },
  { value: 'highest_sales', label: 'Highest Sales' },
  { value: 'lowest_sales', label: 'Lowest Sales' },
  { value: 'name_asc', label: 'Product Name A-Z' },
];

const MONTH_OPTIONS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

function todayIsoDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function StatCard({ label, value, icon: Icon }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {label}
            </Typography>
            <Typography variant="h5" fontWeight={700}>
              {value}
            </Typography>
          </Box>
          {Icon && (
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 2,
                bgcolor: 'rgba(15,118,110,0.1)',
                color: 'primary.main',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon size={18} />
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function ProductCard({ product }) {
  const sizes = product.sizes || [];
  const soldSizes = sizes.filter((s) => Number(s.units_sold) > 0);

  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar
              variant="rounded"
              src={product.image_url || undefined}
              alt={product.name}
              sx={{ width: 56, height: 56 }}
            >
              {(product.name || '?').charAt(0)}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={600} noWrap title={product.name}>
                {product.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                SKU: {product.sku || '—'}
              </Typography>
            </Box>
          </Stack>

          <Stack direction="row" spacing={2} alignItems="flex-end">
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Units Sold
              </Typography>
              <Typography variant="h6" fontWeight={700}>
                {formatNumber(product.units_sold)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Sales
              </Typography>
              <Typography variant="h6" fontWeight={700}>
                {formatCurrency(product.sales_amount)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Available
              </Typography>
              <Typography variant="h6" fontWeight={700}>
                {product.available_qty == null ? '—' : formatNumber(product.available_qty)}
              </Typography>
            </Box>
          </Stack>

          {product.sold_out && (
            <Chip size="small" color="error" label="Sold out" sx={{ alignSelf: 'flex-start' }} />
          )}

          {sizes.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                Sizes sold in this period
              </Typography>
              {soldSizes.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No sizes sold
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {soldSizes.map((s) => (
                    <Chip
                      key={s.variation_id}
                      size="small"
                      variant={s.sold_out ? 'filled' : 'outlined'}
                      color={s.sold_out ? 'error' : 'default'}
                      label={
                        `${s.size}: ${s.units_sold} sold` +
                        (s.sold_out
                          ? ' · Sold out'
                          : s.available_qty != null
                            ? ` · ${s.available_qty} left`
                            : '')
                      }
                    />
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
export default function Inventory() {
  const now = new Date();
  const { showToast } = useSnackbar();
  const [period, setPeriod] = useState('today');
  const [selectedDate, setSelectedDate] = useState(todayIsoDate());

  const [dateFrom, setDateFrom] = useState(todayIsoDate());
const [dateTo, setDateTo] = useState(todayIsoDate());

  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [yearFilter, setYearFilter] = useState(now.getFullYear());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('most_sold');
  const [availableYears, setAvailableYears] = useState([now.getFullYear()]);
  const [state, setState] = useState({
    loading: true,
    error: null,
    summary: null,
    products: [],
    filter: null,
  });
  const [downloading, setDownloading] = useState(false);

  const debouncedSearch = useDebounce(search, 350);

const filterParams = useMemo(() => {
  const params = {
    period,
    sort,
    search: debouncedSearch || undefined,
  };

  if (period === 'date') {
    params.date = selectedDate;
  } else if (period === 'range') {
    params.date_from = dateFrom;
    params.date_to = dateTo;
  } else if (period === 'month') {
    params.year = selectedYear;
    params.month = selectedMonth;
  } else if (period === 'year') {
    params.year = yearFilter;
  }

  return params;
}, [
  period,
  sort,
  debouncedSearch,
  selectedDate,
  dateFrom,
  dateTo,
  selectedYear,
  selectedMonth,
  yearFilter,
]);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));

    getInventory(filterParams)
      .then((res) => {
        const data = res.data;
        setState({
          loading: false,
          error: null,
          summary: data.summary,
          products: data.products || [],
          filter: data.filter,
        });
        if (Array.isArray(data.available_years) && data.available_years.length) {
          setAvailableYears(data.available_years);
        }
      })
      .catch((e) => {
        setState((s) => ({
          ...s,
          loading: false,
          error: e.message,
          summary: null,
          products: [],
        }));
      });
  }, [filterParams]);

  useEffect(() => {
    load();
  }, [load]);

  const handlePeriodChange = (nextPeriod) => {
    setPeriod(nextPeriod);

    if (nextPeriod === 'month') {
      const current = new Date();
      setSelectedYear(current.getFullYear());
      setSelectedMonth(current.getMonth() + 1);
    }

    if (nextPeriod === 'year') {
      setYearFilter(new Date().getFullYear());
    }
  };

  const handleDownloadExcel = async () => {
    if (!state.summary || state.loading) return;

    setDownloading(true);
    try {
     await downloadInventoryExcel({
        filter: state.filter,
        summary: state.summary,
        products: state.products,
        period,
        selectedDate,
        dateFrom,
        dateTo,
        selectedYear,
        selectedMonth,
        yearFilter,
      });
      showToast('Inventory sheet downloaded', 'success');
    } catch (e) {
      showToast(e.message || 'Unable to download inventory sheet', 'error');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Box>
      <PageHeader
        title="Inventory"
        subtitle="Product-wise sales for the selected period"
        actions={
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            disabled={downloading || state.loading || Boolean(state.error) || !state.summary}
            onClick={handleDownloadExcel}
          >
            {downloading ? 'Downloading…' : 'Download Sheet'}
          </Button>
        }
      />

      <Stack spacing={2} sx={{ mb: 3 }}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {PERIOD_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="small"
              variant={period === opt.value ? 'contained' : 'outlined'}
              onClick={() => handlePeriodChange(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </Stack>

        {period === 'date' && (
          <TextField
            type="date"
            size="small"
            label="Select Date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ maxWidth: 220 }}
          />
        )}

        {period === 'range' && (
  <Stack
    direction={{ xs: 'column', sm: 'row' }}
    spacing={1.5}
  >
    <TextField
      type="date"
      size="small"
      label="From Date"
      value={dateFrom}
      onChange={(e) => {
        const value = e.target.value;
        setDateFrom(value);

        if (dateTo && value > dateTo) {
          setDateTo(value);
        }
      }}
      InputLabelProps={{ shrink: true }}
      sx={{ maxWidth: 220 }}
    />

    <TextField
      type="date"
      size="small"
      label="To Date"
      value={dateTo}
      inputProps={{
        min: dateFrom || undefined,
      }}
      onChange={(e) => setDateTo(e.target.value)}
      InputLabelProps={{ shrink: true }}
      sx={{ maxWidth: 220 }}
    />
  </Stack>
)}

        {period === 'month' && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>Year</InputLabel>
              <Select
                label="Year"
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
              >
                {availableYears.map((year) => (
                  <MenuItem key={year} value={year}>
                    {year}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Month</InputLabel>
              <Select
                label="Month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(Number(e.target.value))}
              >
                {MONTH_OPTIONS.map((month) => (
                  <MenuItem key={month.value} value={month.value}>
                    {month.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        )}

        {period === 'year' && (
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Year</InputLabel>
            <Select
              label="Year"
              value={yearFilter}
              onChange={(e) => setYearFilter(Number(e.target.value))}
            >
              {availableYears.map((year) => (
                <MenuItem key={year} value={year}>
                  {year}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {state.filter?.label && (
          <Typography variant="body2" color="text.secondary">
            Showing: {state.filter.label}
          </Typography>
        )}
      </Stack>

      {state.loading && !state.summary ? (
        <LoadingSkeleton variant="cards" />
      ) : state.error ? (
        <EmptyState title="Unable to load inventory" description={state.error} />
      ) : (
        <>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <StatCard
                label="Total Units Sold"
                value={formatNumber(state.summary?.total_units_sold)}
                icon={TrendingUp}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <StatCard
                label="Products Sold"
                value={formatNumber(state.summary?.total_products_sold)}
                icon={Package}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <StatCard
                label="Total Sales"
                value={formatCurrency(state.summary?.total_sales)}
                icon={IndianRupee}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <StatCard
                label="Orders"
                value={formatNumber(state.summary?.orders)}
                icon={ShoppingCart}
              />
            </Grid>
          </Grid>

          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            sx={{ mb: 2 }}
          >
            <TextField
              size="small"
              placeholder="Search by product name or SKU…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ flex: 1 }}
            />
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>Sort</InputLabel>
              <Select label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORT_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {state.loading ? (
            <LoadingSkeleton variant="cards" />
          ) : state.products.length === 0 ? (
            <EmptyState
              title="No products available"
              description={
                debouncedSearch
                  ? 'No products match your search for this period.'
                  : 'There are no products in the catalog yet.'
              }
            />
          ) : (
            <Grid container spacing={2}>
              {state.products.map((product) => (
                <Grid key={product.id} size={{ xs: 12, sm: 6, lg: 4, xl: 3 }}>
                  <ProductCard product={product} />
                </Grid>
              ))}
            </Grid>
          )}
        </>
      )}
    </Box>
  );
}
