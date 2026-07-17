function field(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
export function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(field).join(','));
  return lines.join('\r\n') + '\r\n';
}
