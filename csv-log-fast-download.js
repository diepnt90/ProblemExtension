(() => {
  const PARALLEL_DOWNLOADS = 8;
  const MIN_PARALLEL_SIZE = 2 * 1024 * 1024;
  const cancelDownloadBtn = document.getElementById('cancelDownload');
  let activeDownloadController = null;

  function isAbortError(error) {
    return error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')));
  }

  function setDownloading(active) {
    if (cancelDownloadBtn) cancelDownloadBtn.style.display = active ? 'inline-block' : 'none';
  }

  function updateDownloadProgress(received, total, mode = '8-part') {
    progress.style.display = 'block';
    if (total > 0) {
      const pct = Math.min(100, (received / total) * 100);
      progressBar.style.width = pct.toFixed(1) + '%';
      urlMsg.textContent = `Browser is downloading (${mode})... ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(total)}`;
    } else {
      progressBar.style.width = '100%';
      urlMsg.textContent = `Browser is downloading... ${formatBytes(received)}`;
    }
  }

  async function readBytesWithProgress(response, onProgress) {
    if (!response.body || !response.body.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      onProgress(bytes.byteLength);
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      onProgress(value.byteLength);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async function responseTextWithProgressCancelable(response) {
    if (!response.body || !response.body.getReader) return response.text();
    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let received = 0;
    progress.style.display = 'block';
    progressBar.style.width = '0%';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      parts.push(decoder.decode(value, { stream: true }));
      if (total > 0) {
        const pct = Math.min(100, received / total * 100);
        progressBar.style.width = pct.toFixed(1) + '%';
        urlMsg.textContent = `Browser is downloading... ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(total)}`;
      } else {
        progressBar.style.width = '100%';
        urlMsg.textContent = `Browser is downloading... ${formatBytes(received)}`;
      }
    }
    parts.push(decoder.decode());
    return parts.join('');
  }

  async function downloadSingle(url, signal) {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await responseTextWithProgressCancelable(response);
    return { text, response, parallel: false };
  }

  function parseContentRange(value) {
    const match = String(value || '').match(/^bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)$/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === '*' ? 0 : Number(match[3])
    };
  }

  async function getHeadInfo(url, signal) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal });
      if (!response.ok) return null;
      const total = Number(response.headers.get('content-length') || 0);
      return {
        total: Number.isFinite(total) && total > 0 ? total : 0,
        contentType: response.headers.get('content-type') || '',
        disposition: response.headers.get('content-disposition') || '',
        finalUrl: response.url || url,
        encoding: (response.headers.get('content-encoding') || '').toLowerCase()
      };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return null;
    }
  }

  async function fetchRange(url, start, end, rangeHeader, signal) {
    return fetch(url, {
      cache: 'no-store',
      headers: { [rangeHeader]: `bytes=${start}-${end}` },
      signal
    });
  }

  async function tryRangeProbe(url, rangeHeader, headInfo, signal) {
    let response;
    try {
      response = await fetchRange(url, 0, 0, rangeHeader, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      return null;
    }

    if (response.status !== 206) return null;

    const encoding = (response.headers.get('content-encoding') || headInfo?.encoding || '').toLowerCase();
    if (encoding && encoding !== 'identity') return null;

    const contentRange = parseContentRange(response.headers.get('content-range'));
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength !== 1) return null;

    const total = contentRange?.total || headInfo?.total || 0;
    if (!Number.isFinite(total) || total <= 1) return null;

    return {
      total,
      rangeHeader,
      contentType: response.headers.get('content-type') || headInfo?.contentType || '',
      disposition: response.headers.get('content-disposition') || headInfo?.disposition || '',
      finalUrl: response.url || headInfo?.finalUrl || url
    };
  }

  async function probeRange(url, signal) {
    const headInfo = await getHeadInfo(url, signal);
    const standard = await tryRangeProbe(url, 'Range', headInfo, signal);
    if (standard) return standard;

    if (/\.blob\.core\.windows\.net$/i.test(new URL(url).hostname)) {
      const azure = await tryRangeProbe(url, 'x-ms-range', headInfo, signal);
      if (azure) return azure;
    }

    return null;
  }

  async function downloadParallel(url, probe, signal) {
    const total = probe.total;
    const workers = Math.min(PARALLEL_DOWNLOADS, total);
    const partSize = Math.ceil(total / workers);
    let received = 0;

    updateDownloadProgress(0, total);

    const tasks = Array.from({ length: workers }, async (_, index) => {
      const start = index * partSize;
      const end = Math.min(total - 1, start + partSize - 1);
      if (start > end) return new Uint8Array(0);

      const response = await fetchRange(url, start, end, probe.rangeHeader, signal);
      if (response.status !== 206) {
        throw new Error(`Range request failed (part ${index + 1}/${workers}, HTTP ${response.status})`);
      }

      const encoding = (response.headers.get('content-encoding') || '').toLowerCase();
      if (encoding && encoding !== 'identity') {
        throw new Error(`Range part ${index + 1}/${workers} was content-encoded (${encoding})`);
      }

      const contentRange = parseContentRange(response.headers.get('content-range'));
      if (!contentRange) {
        throw new Error(`Missing Content-Range for part ${index + 1}/${workers}`);
      }
      if (contentRange.start !== start || contentRange.end !== end || (contentRange.total && contentRange.total !== total)) {
        throw new Error(`Unexpected Content-Range for part ${index + 1}/${workers}: expected bytes ${start}-${end}/${total}`);
      }

      const expectedSize = end - start + 1;
      const bytes = await readBytesWithProgress(response, delta => {
        received += delta;
        updateDownloadProgress(received, total, `${workers}-part`);
      });

      if (bytes.byteLength !== expectedSize) {
        throw new Error(`Part ${index + 1}/${workers} size mismatch (${bytes.byteLength} / ${expectedSize} bytes)`);
      }
      return bytes;
    });

    const parts = await Promise.all(tasks);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }

    if (offset !== total) {
      throw new Error(`Downloaded size mismatch (${offset} / ${total} bytes)`);
    }

    return {
      text: new TextDecoder().decode(bytes),
      response: {
        url: probe.finalUrl,
        headers: {
          get(name) {
            name = String(name).toLowerCase();
            if (name === 'content-type') return probe.contentType;
            if (name === 'content-disposition') return probe.disposition;
            if (name === 'content-length') return String(total);
            return null;
          }
        }
      },
      parallel: true,
      rangeHeader: probe.rangeHeader
    };
  }

  function downloadedTextHasJsonRecords(text) {
    let s = String(text ?? '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    s = s.trimStart();
    if (!s) return false;

    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v.some(x => x && typeof x === 'object' && !Array.isArray(x));
      if (v && typeof v === 'object') return true;
    } catch {}

    let pos = 0, checked = 0;
    while (pos < s.length && checked < 200) {
      let end = s.indexOf('\n', pos);
      if (end < 0) end = s.length;
      const line = s.slice(pos, end).replace(/\r$/, '').trim();
      pos = end + 1;
      if (!line) continue;
      checked++;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && !Array.isArray(v)) return true;
      } catch {}
    }
    return false;
  }

  function downloadDebugPrefix(text) {
    return JSON.stringify(String(text ?? '').slice(0, 160));
  }
  async function smartDownload(url, signal) {
    const probe = await probeRange(url, signal);
    if (!probe) {
      urlMsg.textContent = 'Multi-part byte range was not available. Using a single connection...';
      return downloadSingle(url, signal);
    }
    if (probe.total < MIN_PARALLEL_SIZE) return downloadSingle(url, signal);

    try {
      const result = await downloadParallel(url, probe, signal);

      // Cheap integrity check before handing a large JSON download to the parser.
      // Corrupt/mis-ranged downloads often decode to data that does not even begin
      // like JSON. In that case retry once with a normal single connection.
      const type = (result.response.headers.get('content-type') || '').toLowerCase();
      const path = (() => { try { return new URL(result.response.url || url).pathname; } catch { return ''; } })();
      const jsonExpected = /json|ndjson/.test(type) || /\.(json|jsonl|ndjson)$/i.test(path);
      if (jsonExpected) {
        const head = result.text.slice(0, 262144).replace(/^\uFEFF/, '').trimStart();
        if (head && head[0] !== '{' && head[0] !== '[') {
          throw new Error('Downloaded byte ranges do not look like JSON');
        }
      }

      return result;
    } catch (e) {
      if (isAbortError(e)) throw e;
      urlMsg.textContent = `8-part download unavailable (${e.message}). Falling back to single connection...`;
      progressBar.style.width = '0%';
      return downloadSingle(url, signal);
    }
  }

  if (cancelDownloadBtn) {
    cancelDownloadBtn.onclick = () => {
      if (!activeDownloadController) return;
      cancelDownloadBtn.disabled = true;
      urlMsg.textContent = 'Canceling download...';
      activeDownloadController.abort();
    };
  }

  loadUrlBtn.onclick = async () => {
    const raw = urlEl.value.trim();
    if (!raw) return alert('Paste a file URL first.');

    let parsed;
    try {
      parsed = new URL(raw);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http/https URLs are supported.');
    } catch (e) {
      return alert('Invalid URL: ' + e.message);
    }

    if (activeDownloadController) activeDownloadController.abort();
    activeDownloadController = new AbortController();
    const controller = activeDownloadController;

    loadUrlBtn.disabled = true;
    loadUrlBtn.textContent = 'Loading...';
    if (cancelDownloadBtn) cancelDownloadBtn.disabled = false;
    setDownloading(true);
    urlMsg.textContent = 'Checking whether the server supports 8-part download...';
    progress.style.display = 'block';
    progressBar.style.width = '0%';

    try {
      let result = await smartDownload(parsed.href, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Download canceled', 'AbortError');

      if (!downloadedTextHasJsonRecords(result.text)) {
        urlMsg.textContent = 'Downloaded content is not parseable JSON. Retrying with a single connection...';
        progressBar.style.width = '0%';
        result = await downloadSingle(parsed.href, controller.signal);
        if (controller.signal.aborted) throw new DOMException('Download canceled', 'AbortError');
      }

      const response = result.response;
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)/i);
      const dispositionName = match ? decodeURIComponent(match[1].replace(/["']/g, '')) : '';
      const source = response.url || parsed.href;
      const name = dispositionName || (new URL(source).pathname.split('/').pop() || 'download');

      const contentType = response.headers.get('content-type') || '';
      let handledAsLargeJson = false;
      if (typeof window.loadDownloadedLargeJson === 'function') {
        handledAsLargeJson = await window.loadDownloadedLargeJson(result.text, name, contentType);
      }
      if (!handledAsLargeJson) {
        if (!downloadedTextHasJsonRecords(result.text) &&
            (/json|ndjson/i.test(contentType) || /\.(json|jsonl|ndjson)$/i.test(name))) {
          throw new Error(
            `Downloaded response contains no parseable JSON records. ` +
            `Content-Type=${contentType || '(none)'}, name=${name || '(none)'}, ` +
            `size=${String(result.text ?? '').length} chars, prefix=${downloadDebugPrefix(result.text)}`
          );
        }
        loadSourceText(result.text, name, contentType);
      }
      const rangeMode = result.parallel ? ` · 8-part download (${result.rangeHeader})` : '';
      if (!handledAsLargeJson) urlMsg.textContent = `Loaded: ${name}${rangeMode}`;
      progressBar.style.width = '100%';
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) {
        urlMsg.textContent = 'Download canceled.';
        progressBar.style.width = '0%';
        progress.style.display = 'none';
      } else {
        urlMsg.textContent = 'Could not download this URL: ' + e.message;
        progress.style.display = 'none';
      }
    } finally {
      if (activeDownloadController === controller) activeDownloadController = null;
      setDownloading(false);
      if (cancelDownloadBtn) cancelDownloadBtn.disabled = false;
      loadUrlBtn.disabled = false;
      loadUrlBtn.textContent = 'Load URL';
    }
  };
})();

(() => {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'sqlPanel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="panel-title">Custom T-SQL (CSV only)</div>
    <div class="meta" style="margin-top:-8px">Table name: <strong>logs</strong>. Supported: SELECT, TOP, DISTINCT, WHERE, AND/OR, LIKE, IN, GROUP BY, ORDER BY, COUNT, SUM, AVG, MIN, MAX.</div>
    <textarea id="sqlQuery" class="input" spellcheck="false" style="width:100%;min-height:130px;margin-top:14px;font-family:'IBM Plex Mono',monospace;resize:vertical" placeholder="SELECT TOP 100 *\nFROM logs\nWHERE statusCode >= 400\nORDER BY time DESC"></textarea>
    <div class="actions"><button id="runSql" class="btn btn-primary">Run query</button><button id="clearSql" class="btn">Clear query</button></div>
    <div id="sqlMessage" class="meta"></div>
    <div id="sqlResult"></div>`;
  const resultPanelNode = document.getElementById('resultPanel');
  resultPanelNode.parentNode.insertBefore(panel, resultPanelNode);

  const q = document.getElementById('sqlQuery');
  const msg = document.getElementById('sqlMessage');
  const out = document.getElementById('sqlResult');

  const originalLoadCsvText = window.loadCsvText;
  const originalLoadJsonText = window.loadJsonText;
  const originalClear = document.getElementById('clear').onclick;

  function showSqlForCsv() {
    panel.style.display = 'block';
    out.innerHTML = '';
    msg.textContent = '';
  }

  function hideSql() {
    panel.style.display = 'none';
    out.innerHTML = '';
    msg.textContent = '';
  }

  window.loadCsvText = function(text, name) {
    const result = originalLoadCsvText(text, name);
    showSqlForCsv();
    return result;
  };

  window.loadJsonText = function(text, name) {
    hideSql();
    return originalLoadJsonText(text, name);
  };

  document.getElementById('clear').onclick = () => {
    hideSql();
    q.value = '';
    return originalClear && originalClear();
  };

  function rowObjects() {
    return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  }

  function splitComma(text) {
    const result = [];
    let cur = '', quote = null, depth = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        cur += c;
        if (c === quote && text[i + 1] === quote) { cur += text[++i]; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; cur += c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { result.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) result.push(cur.trim());
    return result;
  }

  function unquoteIdentifier(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).replace(/]]/g, ']');
    return s;
  }

  function parseLiteral(s) {
    s = s.trim();
    if (/^null$/i.test(s)) return null;
    if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  function valueFor(row, field) {
    field = unquoteIdentifier(field);
    const key = Object.keys(row).find(k => k.toLowerCase() === field.toLowerCase());
    if (key === undefined) throw new Error(`Unknown column: ${field}`);
    return row[key];
  }

  function comparable(v) {
    const n = Number(v);
    return String(v).trim() !== '' && Number.isFinite(n) ? n : String(v ?? '').toLowerCase();
  }

  function like(value, pattern) {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp('^' + escaped + '$', 'i').test(String(value ?? ''));
  }

  function splitLogical(expr, keyword) {
    const upper = expr.toUpperCase();
    let quote = null, depth = 0;
    for (let i = 0; i <= expr.length - keyword.length; i++) {
      const c = expr[i];
      if (quote) {
        if (c === quote) {
          if (expr[i + 1] === quote) { i++; continue; }
          quote = null;
        }
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')') { depth--; continue; }
      if (depth === 0 && upper.slice(i, i + keyword.length) === keyword && /\s/.test(expr[i - 1] || ' ') && /\s/.test(expr[i + keyword.length] || ' ')) {
        return [expr.slice(0, i).trim(), expr.slice(i + keyword.length).trim()];
      }
    }
    return null;
  }

  function evalWhere(expr, row) {
    expr = expr.trim();
    if (expr.startsWith('(') && expr.endsWith(')')) return evalWhere(expr.slice(1, -1), row);
    const or = splitLogical(expr, 'OR');
    if (or) return evalWhere(or[0], row) || evalWhere(or[1], row);
    const and = splitLogical(expr, 'AND');
    if (and) return evalWhere(and[0], row) && evalWhere(and[1], row);

    let m = expr.match(/^(.+?)\s+NOT\s+LIKE\s+(.+)$/i);
    if (m) return !like(valueFor(row, m[1]), parseLiteral(m[2]));
    m = expr.match(/^(.+?)\s+LIKE\s+(.+)$/i);
    if (m) return like(valueFor(row, m[1]), parseLiteral(m[2]));
    m = expr.match(/^(.+?)\s+NOT\s+IN\s*\((.*)\)$/i);
    if (m) return !splitComma(m[2]).map(parseLiteral).some(v => comparable(v) === comparable(valueFor(row, m[1])));
    m = expr.match(/^(.+?)\s+IN\s*\((.*)\)$/i);
    if (m) return splitComma(m[2]).map(parseLiteral).some(v => comparable(v) === comparable(valueFor(row, m[1])));
    m = expr.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (m) {
      const v = valueFor(row, m[1]);
      const isNull = v === null || v === undefined || v === '';
      return m[2] ? !isNull : isNull;
    }
    m = expr.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
    if (!m) throw new Error(`Unsupported WHERE expression: ${expr}`);
    const a = comparable(valueFor(row, m[1]));
    const b = comparable(parseLiteral(m[3]));
    switch (m[2]) {
      case '=': return a === b;
      case '!=':
      case '<>': return a !== b;
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
  }

  function clause(sql, name, stops) {
    const stop = stops.length ? `(?=\\s+(?:${stops.join('|')})\\b|$)` : '$';
    const re = new RegExp(`\\b${name}\\b\\s+([\\s\\S]*?)${stop}`, 'i');
    const m = sql.match(re);
    return m ? m[1].trim() : '';
  }

  function parseSelectItem(item) {
    let alias = '';
    let expr = item.trim();
    let m = expr.match(/^(.*?)(?:\s+AS\s+|\s+)(\[[^\]]+\]|[A-Za-z_][\w$]*)$/i);
    if (m && /\)|\]$|^[A-Za-z_[]/.test(m[1].trim())) { expr = m[1].trim(); alias = unquoteIdentifier(m[2]); }
    const agg = expr.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|.+?)\s*\)$/i);
    if (agg) return { type:'agg', fn:agg[1].toUpperCase(), field:agg[2].trim(), alias: alias || `${agg[1].toLowerCase()}_${agg[2] === '*' ? 'all' : unquoteIdentifier(agg[2])}` };
    return { type:'field', field:expr, alias:alias || unquoteIdentifier(expr) };
  }

  function aggregate(fn, field, group) {
    if (fn === 'COUNT') return group.length;
    const vals = group.map(r => valueFor(r, field));
    if (fn === 'SUM' || fn === 'AVG') {
      const nums = vals.map(Number).filter(Number.isFinite);
      if (!nums.length) return '';
      const sum = nums.reduce((a,b)=>a+b,0);
      return fn === 'SUM' ? sum : sum / nums.length;
    }
    if (!vals.length) return '';
    return fn === 'MIN' ? vals.reduce((a,b)=>comparable(a)<=comparable(b)?a:b) : vals.reduce((a,b)=>comparable(a)>=comparable(b)?a:b);
  }

  function executeSql(sql) {
    sql = sql.trim().replace(/;\s*$/, '');
    const head = sql.match(/^SELECT\s+(DISTINCT\s+)?(?:TOP\s+(\d+)\s+)?([\s\S]+?)\s+FROM\s+([\[\]A-Za-z_][\[\]\w$]*)\b/i);
    if (!head) throw new Error('Query must start with SELECT ... FROM logs');
    const distinct = !!head[1];
    const top = head[2] ? Number(head[2]) : null;
    const selectText = head[3].trim();
    const table = unquoteIdentifier(head[4]);
    if (table.toLowerCase() !== 'logs') throw new Error('Only FROM logs is supported.');

    const whereText = clause(sql, 'WHERE', ['GROUP\\s+BY','ORDER\\s+BY']);
    const groupText = clause(sql, 'GROUP\\s+BY', ['ORDER\\s+BY']);
    const orderText = clause(sql, 'ORDER\\s+BY', []);
    let data = rowObjects();
    if (whereText) data = data.filter(r => evalWhere(whereText, r));

    const items = selectText === '*' ? headers.map(h => ({type:'field',field:h,alias:h})) : splitComma(selectText).map(parseSelectItem);
    const hasAgg = items.some(i => i.type === 'agg');
    let resultRows = [];

    if (groupText || hasAgg) {
      const groupFields = groupText ? splitComma(groupText).map(unquoteIdentifier) : [];
      const groups = new Map();
      for (const row of data) {
        const key = JSON.stringify(groupFields.map(f => valueFor(row, f)));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      if (!groupFields.length && !groups.size) groups.set('[]', []);
      for (const group of groups.values()) {
        const first = group[0] || {};
        const outRow = {};
        for (const item of items) {
          outRow[item.alias] = item.type === 'agg' ? aggregate(item.fn, item.field, group) : valueFor(first, item.field);
        }
        resultRows.push(outRow);
      }
    } else {
      resultRows = data.map(row => Object.fromEntries(items.map(i => [i.alias, valueFor(row, i.field)])));
    }

    if (distinct) {
      const seen = new Set();
      resultRows = resultRows.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
    }

    if (orderText) {
      const orders = splitComma(orderText).map(x => { const m=x.match(/^(.*?)(?:\s+(ASC|DESC))?$/i); return {field:unquoteIdentifier(m[1].trim()),desc:(m[2]||'ASC').toUpperCase()==='DESC'}; });
      resultRows.sort((a,b) => {
        for (const o of orders) {
          const ak = Object.keys(a).find(k=>k.toLowerCase()===o.field.toLowerCase());
          if (ak === undefined) throw new Error(`Unknown ORDER BY column: ${o.field}`);
          const c = comparable(a[ak]) < comparable(b[ak]) ? -1 : comparable(a[ak]) > comparable(b[ak]) ? 1 : 0;
          if (c) return o.desc ? -c : c;
        }
        return 0;
      });
    }

    if (top !== null) resultRows = resultRows.slice(0, top);
    return { columns: items.map(i => i.alias), rows: resultRows };
  }

  function renderSqlResult(result) {
    const cols = result.columns;
    let html = '<div class="table-wrap"><table><thead><tr>' + cols.map(c=>`<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    html += result.rows.length ? result.rows.map(r=>'<tr>'+cols.map(c=>`<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('')+'</tr>').join('') : `<tr><td class="empty" colspan="${Math.max(1,cols.length)}">No rows</td></tr>`;
    html += '</tbody></table></div>';
    out.innerHTML = html;
    msg.textContent = `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? '' : 's'} returned`;
  }

  document.getElementById('runSql').onclick = () => {
    try {
      if (!q.value.trim()) throw new Error('Enter a query first.');
      const result = executeSql(q.value);
      renderSqlResult(result);
    } catch (e) {
      out.innerHTML = '';
      msg.textContent = 'Query error: ' + e.message;
    }
  };

  document.getElementById('clearSql').onclick = () => {
    q.value = '';
    out.innerHTML = '';
    msg.textContent = '';
  };
})();
