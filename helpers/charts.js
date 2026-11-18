// Chart blocks for live pages (rendered by views/partials/charts.xian). No chart library: plain HTML bars, so they also work offline.
//   barsBlock     horizontal bars (a ranking)
//   columnsBlock  vertical columns (a time series); a column with estimate: true is drawn as an "Estimate" (lighter, dashed outline)
export const barsBlock = (title, rows, { unit = "", width = "full", note = null, format = null } = {}) => {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  return {
    type: "bars", title, width, note,
    rows: rows.map((r) => ({ label: r.label, display: r.display ?? (format ? format(r.value) : `${r.value}${unit}`), size: Math.round(((Number(r.value) || 0) / max) * 100) })),
  };
};

export const columnsBlock = (title, points, { format = (v) => String(v), width = "full", note = null, legend = null, phoneKeep = null } = {}) => {
  const max = Math.max(1, ...points.map((p) => Math.max(Number(p.value) || 0, Number(p.upper) || 0)));
  return {
    type: "columns", title, width, note, legend,
    phoneNote: points.length > 14, bars: points.map((p, i) => ({ older: phoneKeep ? !phoneKeep(i) : i < points.length - 14, label: p.label, display: format(Number(p.value) || 0), size: Math.max(2, Math.round(((Number(p.value) || 0) / max) * 100)), estimate: Boolean(p.estimate), tip: p.tip || `${p.label}: ${format(Number(p.value) || 0)}${p.estimate ? " (Estimate)" : ""}` })),
  };
};

export const peso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortPeso = (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v)));
