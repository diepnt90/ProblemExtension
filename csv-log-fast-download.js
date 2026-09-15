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

      const contentRange = parseContentRange(response.headers.get('content-range'));
      if (contentRange && (contentRange.start !== start || contentRange.end !== end || (contentRange.total && contentRange.total !== total))) {
        throw new Error(`Unexpected Content-Range for part ${index + 1}/${workers}`);
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

  async function smartDownload(url, signal) {
    const probe = await probeRange(url, signal);
    if (!probe) {
      urlMsg.textContent = 'Multi-part byte range was not available. Using a single connection...';
      return downloadSingle(url, signal);
    }
    if (probe.total < MIN_PARALLEL_SIZE) return downloadSingle(url, signal);

    try {
      return await downloadParallel(url, probe, signal);
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
      const result = await smartDownload(parsed.href, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Download canceled', 'AbortError');

      const response = result.response;
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)/i);
      const dispositionName = match ? decodeURIComponent(match[1].replace(/["']/g, '')) : '';
      const source = response.url || parsed.href;
      const name = dispositionName || (new URL(source).pathname.split('/').pop() || 'download');

      loadSourceText(result.text, name, response.headers.get('content-type') || '');
      const rangeMode = result.parallel ? ` · 8-part download (${result.rangeHeader})` : '';
      urlMsg.textContent = `Loaded: ${name}${rangeMode}`;
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
