(() => {
  const LARGE_JSON_THRESHOLD = 256 * 1024 * 1024;
  const originalFileChange = fileEl.onchange;

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
        } catch {
          row.properties = props;
        }
      } else if (typeof props === 'object' && !Array.isArray(props)) {
        Object.assign(row, props);
      } else {
        row.properties = props;
      }
    }
    return row;
  }

  async function streamLargeJsonLines(file) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let carry = '';
    let received = 0;
    let lineNo = 0;
    let invalidCount = 0;
    let kind = null;
    const errors = [];
    const objects = [];
    const headerSet = new Set();
    const appRecords = [];

    progress.style.display = 'block';
    progressBar.style.width = '0%';
    urlMsg.textContent = 'Parsing large JSON log...';

    const processRecord = (record) => {
      if (!kind) {
        if (record.resultDescription !== undefined || record.containerId !== undefined) kind = 'application';
        else if (record.properties !== undefined || record.EventTime !== undefined || record.EventIpAddress !== undefined) kind = 'http';
        else kind = 'table';
      }

      if (kind === 'application') {
        appRecords.push({
          time: record.time ?? '',
          containerId: record.containerId ?? '',
          Host: record.Host ?? '',
          resultDescription: record.resultDescription ?? ''
        });
        return;
      }

      const obj = kind === 'http' ? flattenHttpRecord(record) : record;
      for (const key of Object.keys(obj)) headerSet.add(key);
      objects.push(obj);
    };

    const processLine = (raw) => {
      lineNo++;
      let line = raw;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (!line) return;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value)) processRecord(value);
        else throw new Error('Expected JSON object');
      } catch (e) {
        invalidCount++;
        if (errors.length < 100) errors.push(`Line ${lineNo}: ${e.message}`);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      carry += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        processLine(line);
      }

      const pct = file.size ? Math.min(100, received / file.size * 100) : 0;
      progressBar.style.width = pct.toFixed(1) + '%';
      urlMsg.textContent = `Parsing large JSON log... ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(file.size)}`;
      if ((lineNo & 8191) === 0) await new Promise(requestAnimationFrame);
    }

    carry += decoder.decode();
    if (carry.trim()) processLine(carry);

    if (!kind || (!appRecords.length && !objects.length)) {
      progress.style.display = 'none';
      alert(`No JSON records found.${invalidCount ? ` ${invalidCount.toLocaleString()} line(s) could not be parsed.` : ''}`);
      return;
    }

    if (kind === 'application') {
      loadConsoleLog(appRecords, errors, file.name);
      if (window.hideTsqlPanel) window.hideTsqlPanel();
    } else {
      headers = [...headerSet];
      if (kind === 'http') headers.sort();
      rows = new Array(objects.length);
      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        rows[i] = headers.map(h => normalizeJsonValue(obj[h]));
        objects[i] = null;
      }
      visibleColumns = headers.map((_, i) => i);
      const outName = kind === 'http'
        ? file.name.replace(/\.(jsonl?|ndjson)$/i, '') + '.csv'
        : file.name.replace(/\.json$/i, '.csv');
      const extra = kind === 'http'
        ? `<span>HTTP JSON converted${invalidCount ? ` · ${invalidCount} invalid line${invalidCount === 1 ? '' : 's'} skipped` : ''}</span>`
        : '';
      showData(outName, file.name, extra);
      if (window.showTsqlPanel) window.showTsqlPanel();
    }

    progressBar.style.width = '100%';
    urlMsg.textContent = `Loaded: ${file.name} · streamed parser`;
  }

  fileEl.onchange = async () => {
    const file = fileEl.files[0];
    if (!file) return;

    const jsonLike = /json|ndjson/i.test(file.type) || /\.(json|jsonl|ndjson)$/i.test(file.name);
    if (!jsonLike || file.size < LARGE_JSON_THRESHOLD) {
      return originalFileChange.call(fileEl);
    }

    try {
      const sample = await file.slice(0, 256 * 1024).text();
      if (!looksLikeJsonLines(sample, file.name)) {
        return originalFileChange.call(fileEl);
      }
      await streamLargeJsonLines(file);
    } catch (e) {
      progress.style.display = 'none';
      urlMsg.textContent = 'Could not parse this large JSON file: ' + e.message;
    }
  };
})();
