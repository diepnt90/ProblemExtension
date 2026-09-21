(() => {
  const LARGE_JSON_THRESHOLD = 256 * 1024 * 1024;
  const HEADER_SCAN_LIMIT = 2000;
  const originalFileChange = fileEl.onchange;
  const originalRender = render;
  let largeFile = null;
  let largeKind = null;
  let largeBusy = false;
  let largeGeneration = 0;
  let debounceTimer = null;

  function flattenHttpRecord(record) {
    const row = {
      time: record.time ?? '',
      EventTime: record.EventTime ?? '',
      category: record.category ?? '',
      Host: record.Host ?? '',
      EventIpAddress: record.EventIpAddress ?? ''
    };
    const props = record.properties;
    if (props !== undefined && props !== null && props !== '') {
      if (typeof props === 'string') {
        try {
          const parsedProps = JSON.parse(props);
          if (parsedProps && typeof parsedProps === 'object' && !Array.isArray(parsedProps)) Object.assign(row, parsedProps);
          else row.properties = props;
        } catch { row.properties = props; }
      } else if (typeof props === 'object' && !Array.isArray(props)) Object.assign(row, props);
      else row.properties = props;
    }
    return row;
  }

  function detectKind(record) {
    if (record.resultDescription !== undefined || record.containerId !== undefined) return 'application';
    if (record.properties !== undefined || record.EventTime !== undefined || record.EventIpAddress !== undefined) return 'http';
    return 'table';
  }

  async function scanJsonLines(file, onRecord, opts = {}) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let carry = '', received = 0, lineNo = 0, invalidCount = 0;
    const generation = opts.generation ?? largeGeneration;
    while (true) {
      if (generation !== largeGeneration) { try { await reader.cancel(); } catch {} return { canceled: true, invalidCount, received }; }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      carry += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        let line = carry.slice(0, nl); carry = carry.slice(nl + 1); lineNo++;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        line = line.trim();
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (record && typeof record === 'object' && !Array.isArray(record)) {
            if (await onRecord(record, lineNo) === false) { try { await reader.cancel(); } catch {} return { stopped: true, invalidCount, received }; }
          } else invalidCount++;
        } catch { invalidCount++; }
      }
      if (opts.progress) opts.progress(received, file.size);
      if ((lineNo & 16383) === 0) await new Promise(requestAnimationFrame);
    }
    carry += decoder.decode();
    if (carry.trim()) {
      lineNo++;
      try {
        const record = JSON.parse(carry.trim());
        if (record && typeof record === 'object' && !Array.isArray(record)) await onRecord(record, lineNo);
        else invalidCount++;
      } catch { invalidCount++; }
    }
    return { invalidCount, received };
  }

  function currentFilterPredicate(obj) {
    const af = activeFilters();
    return af.every(f => compareValues(obj[f.field], f.op, f.value, f.field));
  }

  function toTabularRecord(record) {
    return largeKind === 'http' ? flattenHttpRecord(record) : record;
  }

  async function refreshLargeApplicationPreview() {
    if (!largeFile || largeKind !== 'application') return;
    const generation = ++largeGeneration;
    const limit = Math.max(1, Math.min(Number(limitEl.value) || 100, 10000));
    const af = activeFilters();
    const found = [];
    let block = [];

    const blockMatches = records => !af.length || records.some(record =>
      af.every(f => compareValues(record[f.field], f.op, f.value, f.field))
    );

    const flushBlock = () => {
      if (!block.length) return true;
      if (blockMatches(block)) {
        for (const record of block) found.push(record);
      }
      block = [];
      return found.length < limit;
    };

    largeBusy = true;
    resultInfo.innerHTML = '<span>Scanning large application log…</span>';
    progress.style.display = 'block';
    progressBar.style.width = '0%';

    try {
      await scanJsonLines(largeFile, record => {
        const normalized = {
          time: record.time ?? '',
          containerId: record.containerId ?? '',
          Host: record.Host ?? '',
          resultDescription: record.resultDescription ?? ''
        };

        if (isApplicationLogEntryStart(normalized) && block.length) {
          if (!flushBlock()) return false;
        }
        block.push(normalized);
        return true;
      }, {
        generation,
        progress(received, total) {
          const pct = total ? Math.min(100, received / total * 100) : 0;
          progressBar.style.width = pct.toFixed(1) + '%';
          urlMsg.textContent = `Scanning large application log… ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(total)}`;
        }
      });

      if (generation !== largeGeneration) return;
      flushBlock();
      consoleRecords = found;
      originalRender();
      resultInfo.innerHTML = `<span>${found.length.toLocaleString()} matching records (including continuation lines)</span><span>Large-file streaming mode · stops after ${limit.toLocaleString()} records</span>`;
      urlMsg.textContent = `Loaded: ${largeFile.name} · application-log streaming`;
      progress.style.display = 'none';
    } finally {
      if (generation === largeGeneration) largeBusy = false;
    }
  }

  async function refreshLargePreview() {
    if (!largeFile) return;
    if (largeKind === 'application') return refreshLargeApplicationPreview();
    const generation = ++largeGeneration;
    const limit = Math.max(1, Math.min(Number(limitEl.value) || 100, 10000));
    const found = [];
    largeBusy = true;
    resultInfo.innerHTML = '<span>Scanning large file…</span>';
    progress.style.display = 'block';
    progressBar.style.width = '0%';
    try {
      await scanJsonLines(largeFile, record => {
        const obj = toTabularRecord(record);
        if (!currentFilterPredicate(obj)) return true;
        found.push(headers.map(h => normalizeJsonValue(obj[h])));
        return found.length < limit;
      }, {
        generation,
        progress(received, total) {
          const pct = total ? Math.min(100, received / total * 100) : 0;
          progressBar.style.width = pct.toFixed(1) + '%';
          urlMsg.textContent = `Scanning large log… ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(total)}`;
        }
      });
      if (generation !== largeGeneration) return;
      rows = found;
      originalRender();
      resultInfo.innerHTML = `<span>${found.length.toLocaleString()} row${found.length === 1 ? '' : 's'} shown</span><span>Large-file streaming mode · stops after ${limit.toLocaleString()} matches</span>`;
      urlMsg.textContent = `Loaded: ${largeFile.name} · lazy streaming`;
      progress.style.display = 'none';
    } finally {
      if (generation === largeGeneration) largeBusy = false;
    }
  }

  function scheduleLargeRefresh() {
    if (!largeFile) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshLargePreview, 180);
  }

  async function initLargeJson(file) {
    largeFile = file;
    largeKind = null;
    rows = [];
    headers = [];
    visibleColumns = [];
    const headerSet = new Set();
    const previewObjects = [];
    let seen = 0;

    progress.style.display = 'block';
    progressBar.style.width = '0%';
    urlMsg.textContent = 'Reading large JSON log header/preview…';

    await scanJsonLines(file, record => {
      if (!largeKind) largeKind = detectKind(record);
      if (largeKind === 'application') return false;
      const obj = toTabularRecord(record);
      for (const k of Object.keys(obj)) headerSet.add(k);
      if (previewObjects.length < Math.max(100, Number(limitEl.value) || 100)) previewObjects.push(obj);
      seen++;
      return seen < HEADER_SCAN_LIMIT;
    }, {
      generation: ++largeGeneration,
      progress(received, total) {
        const pct = total ? Math.min(100, received / total * 100) : 0;
        progressBar.style.width = pct.toFixed(1) + '%';
      }
    });

    if (!largeKind) throw new Error('No JSON records found.');
    if (largeKind === 'application') {
      mode = 'console';
      consoleRecords = [];
      headers = [];
      rows = [];
      visibleColumns = [];
      filters = [];
      filtersEl.innerHTML = '';
      sourceFileName = file.name || 'data.json';
      rowsControl.style.display = 'flex';
      showAllBtn.style.display = 'inline-block';
      setupFilterUi('Application log filters','Filter application logs by time, containerId, Host or resultDescription. A match on either the parent entry or a continuation/stack-trace line returns the complete block. Multiple filters are combined with AND.');
      exportCsvBtn.style.display = 'none';
      columnPicker.style.display = 'none';
      filterPanel.style.display = 'block';
      resultPanel.style.display = 'block';
      statsEl.innerHTML = `<span class="badge">${esc(file.name)}</span><span>Large application log · streaming mode</span>`;
      addFilter();
      progress.style.display = 'none';
      urlMsg.textContent = `Loaded: ${file.name} · application-log streaming`;
      await refreshLargeApplicationPreview();
      return;
    }

    headers = [...headerSet];
    if (largeKind === 'http') headers.sort();
    visibleColumns = headers.map((_, i) => i);
    rows = previewObjects.map(obj => headers.map(h => normalizeJsonValue(obj[h])));
    const outName = largeKind === 'http' ? file.name.replace(/\.(jsonl?|ndjson)$/i, '') + '.csv' : file.name.replace(/\.json$/i, '.csv');
    showData(outName, file.name, '<span>Large-file lazy streaming mode</span>');
    if (window.showTsqlPanel) window.showTsqlPanel();
    resultInfo.innerHTML = `<span>${rows.length.toLocaleString()} preview rows</span><span>Only matching rows are materialized in memory</span>`;
    progress.style.display = 'none';
    urlMsg.textContent = `Loaded: ${file.name} · lazy streaming`;
  }

  window.largeLogStreamingApi = {
    isActive() { return !!largeFile && largeKind !== 'application'; },
    getKind() { return largeKind; },
    getFileName() { return largeFile?.name || ''; },
    getFileSize() { return largeFile?.size || 0; },
    cancel() { largeGeneration++; },
    async scan(onObject, opts = {}) {
      if (!largeFile || largeKind === 'application') throw new Error('No active large tabular log.');
      const generation = ++largeGeneration;
      return scanJsonLines(largeFile, record => onObject(toTabularRecord(record)), {
        generation,
        progress: opts.progress
      });
    }
  };

  render = function () {
    if (!largeFile) return originalRender();
    scheduleLargeRefresh();
  };

  fileEl.onchange = async () => {
    const file = fileEl.files[0];
    if (!file) return;
    largeFile = null; largeKind = null; largeGeneration++;
    const jsonLike = /json|ndjson/i.test(file.type) || /\.(json|jsonl|ndjson)$/i.test(file.name);
    if (!jsonLike || file.size < LARGE_JSON_THRESHOLD) return originalFileChange.call(fileEl);
    try {
      const sample = await file.slice(0, 256 * 1024).text();
      if (!looksLikeJsonLines(sample, file.name)) return originalFileChange.call(fileEl);
      await initLargeJson(file);
    } catch (e) {
      progress.style.display = 'none';
      urlMsg.textContent = 'Could not parse this large JSON file: ' + e.message;
    }
  };

  window.loadDownloadedLargeJson = async function(text, name, type = '') {
    const jsonLike = /json|ndjson/i.test(type) || /\.(json|jsonl|ndjson)$/i.test(name || '');
    if (!jsonLike) return false;

    const blob = new Blob([text], { type: type || 'application/x-ndjson' });
    if (blob.size < LARGE_JSON_THRESHOLD) return false;

    const file = new File([blob], name || 'download.json', { type: type || 'application/x-ndjson' });
    const sample = await file.slice(0, 256 * 1024).text();
    if (!looksLikeJsonLines(sample, file.name)) return false;

    await initLargeJson(file);
    return true;
  };

  limitEl.addEventListener('input', scheduleLargeRefresh);
  document.getElementById('clear')?.addEventListener('click', () => {
    largeGeneration++;
    largeFile = null;
    largeKind = null;
    clearTimeout(debounceTimer);
  });
})();
