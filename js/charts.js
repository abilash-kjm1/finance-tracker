// ============================================================
// Chart.js setup — category doughnut + monthly trend bar.
// Reads MD3 CSS variables so charts follow the light/dark theme.
// ============================================================

let categoryChart = null;
let trendChart = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// MD3-flavored categorical palette (works on light + dark surfaces).
const CATEGORY_COLORS = {
  Groceries: "#4c8df6",
  Dining: "#f5a623",
  Transport: "#9c62d9",
  Bills: "#e5657a",
  Shopping: "#26a5a8",
  Entertainment: "#f06292",
  Health: "#66b06a",
  Other: "#8d97a5",
};

function baseOptions() {
  const onSurfaceVariant = cssVar("--md-on-surface-variant");
  Chart.defaults.font.family = '"Google Sans", Roboto, sans-serif';
  Chart.defaults.color = onSurfaceVariant;
  return onSurfaceVariant;
}

function tooltipStyle() {
  return {
    backgroundColor: cssVar("--md-inverse-surface"),
    titleColor: cssVar("--md-inverse-on-surface"),
    bodyColor: cssVar("--md-inverse-on-surface"),
    cornerRadius: 10,
    padding: 12,
    boxPadding: 4,
    displayColors: true,
    usePointStyle: true,
  };
}

export function renderCategoryChart(canvas, byCategory, fmtMoney) {
  baseOptions();
  const labels = Object.keys(byCategory);
  const data = labels.map((l) => byCategory[l] / 100);
  const colors = labels.map((l) => CATEGORY_COLORS[l] || CATEGORY_COLORS.Other);

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: cssVar("--md-surface-container-low"),
        borderWidth: 3,
        borderRadius: 6,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      animation: { animateRotate: true, duration: 700, easing: "easeOutQuart" },
      plugins: {
        legend: {
          position: "bottom",
          labels: { usePointStyle: true, pointStyle: "circle", padding: 14, font: { size: 12 } },
        },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            label: (ctx) => {
              const total = data.reduce((a, b) => a + b, 0);
              const pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
              return ` ${fmtMoney(Math.round(ctx.parsed * 100))} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

export function renderTrendChart(canvas, months, fmtMoney) {
  baseOptions();
  const labels = months.map((m) => m.label);
  const spent = months.map((m) => m.spentCents / 100);
  const primary = cssVar("--md-primary");
  const gridColor = cssVar("--md-outline-variant");

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Spent",
        data: spent,
        backgroundColor: primary,
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 44,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: "easeOutQuart" },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 12 } } },
        y: {
          beginAtZero: true,
          grid: { color: gridColor + "55" },
          border: { display: false },
          ticks: {
            font: { size: 11 },
            callback: (v) => "$" + (v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : v),
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle(),
          callbacks: { label: (ctx) => " " + fmtMoney(Math.round(ctx.parsed.y * 100)) },
        },
      },
    },
  });
}

// Re-render with current CSS vars after a theme change.
export function refreshTheme() {
  for (const chart of [categoryChart, trendChart]) {
    if (!chart) continue;
    chart.options.plugins.tooltip = { ...chart.options.plugins.tooltip, ...tooltipStyle() };
  }
  if (categoryChart) {
    categoryChart.data.datasets[0].borderColor = cssVar("--md-surface-container-low");
    categoryChart.update("none");
  }
  if (trendChart) {
    trendChart.data.datasets[0].backgroundColor = cssVar("--md-primary");
    trendChart.options.scales.y.grid.color = cssVar("--md-outline-variant") + "55";
    trendChart.update("none");
  }
  baseOptions();
}
