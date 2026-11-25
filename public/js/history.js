function fmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return n.toFixed(n >= 100 ? 0 : 2);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadHistory() {
  const box = document.getElementById('historyBox');
  if (!box) return;
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!data.enabled) {
      box.textContent = 'Historia wyłączona (brak DATABASE_URL).';
      return;
    }
    if (!data.items.length) {
      box.textContent = 'Brak zapisanych testów.';
      return;
    }
    const rows = data.items.map((r) => {
      return `<tr>
        <td>${new Date(r.created_at).toLocaleString('pl-PL')}</td>
        <td>${escapeHtml(r.server_id)}</td>
        <td>${fmt(r.download_mbps)}</td>
        <td>${fmt(r.upload_mbps)}</td>
        <td>${fmt(r.ping_ms)}</td>
        <td>${fmt(r.jitter_ms)}</td>
        <td>${fmt(r.loaded_latency_ms)}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table><thead><tr>
      <th>Data</th><th>Serwer</th><th>Down</th><th>Up</th><th>Ping</th><th>Jitter</th><th>Loaded</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    box.textContent = 'Błąd ładowania historii.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
  const refreshBtn = document.getElementById('refreshHistoryBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadHistory);
});
