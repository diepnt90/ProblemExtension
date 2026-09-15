(() => {
  const PARALLEL_DOWNLOADS = 8;
  const MIN_PARALLEL_SIZE = 2 * 1024 * 1024;

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

  async function downloadSingle(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await responseTextWithProgress(response);
    return { text, response, parallel: false };
  }

  async function probeRange(url) {
    const controller = new AbortController();
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal
      });

      if (response.status !== 206) {
        controller.abort();
        return null;
      }

      const contentRange = response.headers.get('content-range') || '';
      const match = contentRange.match(/^bytes\s+0-0\/(\d+)$/i);
      const encoding = (response.headers.get('content-encoding') || '').toLowerCase();
      if (!match || (encoding && encoding !== 'identity')) {
        controller.abort();
        return null;
      }

      const total = Number(match[1]);
      if (!Number.isFinite(total) || total <= 1) {
        controller.abort();
        return null;
      }

      await response.arrayBuffer();
      return {
        total,
        contentType: response.headers.get('content-type') || '',
        disposition: response.headers.get('content-disposition') || '',
        finalUrl: response.url || url
      };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      return null;
    }
  }

  async function downloadParallel(url, probe) {
    const total = probe.total;
    const workers = Math.min(PARALLEL_DOWNLOADS, total);
    const partSize = Math.ceil(total / workers);
    let received = 0;

    updateDownloadProgress(0, total);

    const tasks = Array.from({ length: workers }, async (_, index) => {
      const start = index * partSize;
      const end = Math.min(total - 1, start + partSize - 1);
      if (start > end) return new Uint8Array(0);

      const response = await fetch(url, {
        cache: 'no-store',
        headers: { Range: `bytes=${start}-${end}` }
      });

      if (response.status !== 206) {
        throw new Error(`Server stopped supporting HTTP Range (part ${index + 1}/${workers}, HTTP ${response.status})`);
      }

      const contentRange = response.headers.get('content-range') || '';
      const expected = `bytes ${start}-${end}/${total}`.toLowerCase();
      if (contentRange.toLowerCase() !== expected) {
        throw new Error(`Unexpected Content-Range for part ${index + 1}/${workers}`);
      }

      return readBytesWithProgress(response, delta => {
        received += delta;
        updateDownloadProgress(received, total, `${workers}-part`);
      });
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
      parallel: true
    };
  }

  async function smartDownload(url) {
    const probe = await probeRange(url);
    if (!probe || probe.total < MIN_PARALLEL_SIZE) return downloadSingle(url);

    try {
      return await downloadParallel(url, probe);
    } catch (e) {
      urlMsg.textContent = `8-part download unavailable (${e.message}). Falling back to single connection...`;
      progressBar.style.width = '0%';
      return downloadSingle(url);
    }
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

    loadUrlBtn.disabled = true;
    loadUrlBtn.textContent = 'Loading...';
    urlMsg.textContent = 'Checking whether the server supports 8-part download...';
    progress.style.display = 'block';
    progressBar.style.width = '0%';

    try {
      const result = await smartDownload(parsed.href);
      const response = result.response;
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)/i);
      const dispositionName = match ? decodeURIComponent(match[1].replace(/["']/g, '')) : '';
      const source = response.url || parsed.href;
      const name = dispositionName || (new URL(source).pathname.split('/').pop() || 'download');

      loadSourceText(result.text, name, response.headers.get('content-type') || '');
      urlMsg.textContent = `Loaded: ${name}${result.parallel ? ' · 8-part download' : ''}`;
      progressBar.style.width = '100%';
    } catch (e) {
      urlMsg.textContent = 'Could not download this URL: ' + e.message;
      progress.style.display = 'none';
    } finally {
      loadUrlBtn.disabled = false;
      loadUrlBtn.textContent = 'Load URL';
    }
  };
})();
