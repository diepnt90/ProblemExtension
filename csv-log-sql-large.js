(() => {
  const runBtn = document.getElementById('runTsql');
  const clearBtn = document.getElementById('clearTsql');
  const editor = document.getElementById('tsqlQuery');
  const info = document.getElementById('tsqlInfo');
  const output = document.getElementById('tsqlResult');
  if (!runBtn || !editor || !info || !output) return;

  const normalRun = runBtn.onclick;

  function api() {
    const a = window.largeLogStreamingApi;
    return a && a.isActive() ? a : null;
  }

  function splitComma(text) {
    const out = [];
    let cur = '', quote = null, depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        cur += ch;
        if (ch === quote) {
          if (text[i + 1] === quote) cur += text[++i];
          else quote = null;
        }
      } else if (ch === "'" || ch === '"') { quote = ch; cur += ch; }
      else if (ch === '(') { depth++; cur += ch; }
      else if (ch === ')') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function stripIdentifier(s) {
    s = String(s || '').trim();
    if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('`') && s.endsWith('`')) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
    return s;
  }

  function lookup(obj, name) {
    const wanted = stripIdentifier(name).toLowerCase();
    const key = Object.keys(obj).find(k => k.toLowerCase() === wanted);
    return key === undefined ? undefined : obj[key];
  }

  function literal(token) {
    token = token.trim();
    if (/^null$/i.test(token)) return null;
    if (/^n?'(?:[^']|'')*'$/i.test(token)) return token.replace(/^n?'/i, '').slice(0, -1).replace(/''/g, "'");
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    return stripIdentifier(token);
  }

  function compare(a, op, b) {
    if (op === 'LIKE' || op === 'NOT LIKE') {
      const pattern = String(b ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      const ok = new RegExp('^' + pattern + '$', 'i').test(String(a ?? ''));
      return op === 'NOT LIKE' ? !ok : ok;
    }
    const an = Number(a), bn = Number(b);
    const numeric = a !== '' && b !== '' && Number.isFinite(an) && Number.isFinite(bn);
    const x = numeric ? an : String(a ?? '').toLowerCase();
    const y = numeric ? bn : String(b ?? '').toLowerCase();
    if (op === '=' || op === '==') return x == y;
    if (op === '<>' || op === '!=') return x != y;
    if (op === '>') return x > y;
    if (op === '<') return x < y;
    if (op === '>=') return x >= y;
    if (op === '<=') return x <= y;
    return false;
  }

  function splitLogical(expr, keyword) {
    const parts = [];
    let cur = '', quote = null, depth = 0;
    const upper = expr.toUpperCase(), word = keyword.toUpperCase();
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (quote) {
        cur += ch;
        if (ch === quote) {
          if (expr[i + 1] === quote) cur += expr[++i];
          else quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '(') { depth++; cur += ch; continue; }
      if (ch === ')') { depth--; cur += ch; continue; }
      if (depth === 0 && upper.slice(i, i + word.length) === word && /\s/.test(expr[i - 1] || ' ') && /\s/.test(expr[i + word.length] || ' ')) {
        parts.push(cur.trim()); cur = ''; i += word.length - 1; continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function evalCondition(obj, expr) {
    expr = expr.trim();
    if (expr.startsWith('(') && expr.endsWith(')')) expr = expr.slice(1, -1).trim();
    const ors = splitLogical(expr, 'OR');
    if (ors.length > 1) return ors.some(x => evalCondition(obj, x));
    const ands = splitLogical(expr, 'AND');
    if (ands.length > 1) return ands.every(x => evalCondition(obj, x));

    let m = expr.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (m) {
      const v = lookup(obj, m[1]);
      const isNull = v === null || v === undefined || v === '';
      return m[2] ? !isNull : isNull;
    }
    m = expr.match(/^(.+?)\s+(NOT\s+)?IN\s*\((.*)\)$/i);
    if (m) {
      const v = lookup(obj, m[1]);
      const values = splitComma(m[3]).map(literal);
      const ok = values.some(x => compare(v, '=', x));
      return m[2] ? !ok : ok;
    }
    m = expr.match(/^(.+?)\s+(NOT\s+LIKE|LIKE)\s+(.+)$/i);
    if (m) return compare(lookup(obj, m[1]), m[2].toUpperCase().replace(/\s+/g, ' '), literal(m[3]));
    m = expr.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
    if (m) return compare(lookup(obj, m[1]), m[2], literal(m[3]));
    throw new Error('Unsupported WHERE condition: ' + expr);
  }

  function parseSelectItem(raw) {
    let text = raw.trim(), alias = '';
    const as = text.match(/^(.*)\s+AS\s+([\[\]`"\w .-]+)$/i);
    if (as) { text = as[1].trim(); alias = stripIdentifier(as[2]); }
    const agg = text.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[^)]+)\s*\)$/i);
    if (agg) {
      const fn = agg[1].toUpperCase(), field = stripIdentifier(agg[2]);
      return { type: 'agg', fn, field, alias: alias || (fn === 'COUNT' ? 'count' : `${fn.toLowerCase()}_${field}`) };
    }
    const field = stripIdentifier(text);
    return { type: field === '*' ? 'star' : 'field', field, alias: alias || field };
  }

  function parseQuery(query) {
    query = query.trim().replace(/;\s*$/, '');
    if (!/^SELECT\b/i.test(query)) throw new Error('Only SELECT queries are allowed.');
    const m = query.match(/^SELECT\s+(TOP\s*\(?\s*(\d+)\s*\)?\s+)?(DISTINCT\s+)?([\s\S]+?)\s+FROM\s+logs\b([\s\S]*)$/i);
    if (!m) throw new Error('Expected: SELECT ... FROM logs');
    const top = m[2] ? Number(m[2]) : null;
    if (top !== null && (top < 1 || top > 100000)) throw new Error('TOP must be between 1 and 100000 for large files.');
    const distinct = !!m[3];
    const selectItems = splitComma(m[4].trim()).map(parseSelectItem);
    const rest = m[5] || '';
    const clauses = { where: '', group: '', order: '' };
    const clauseRe = /\b(WHERE|GROUP\s+BY|ORDER\s+BY)\b/ig;
    const found = [];
    let cm;
    while ((cm = clauseRe.exec(rest))) found.push({ key: cm[1].toUpperCase().replace(/\s+/g, ' '), index: cm.index, end: clauseRe.lastIndex });
    for (let i = 0; i < found.length; i++) {
      const f = found[i], end = i + 1 < found.length ? found[i + 1].index : rest.length;
      const text = rest.slice(f.end, end).trim();
      if (f.key === 'WHERE') clauses.where = text;
      else if (f.key === 'GROUP BY') clauses.group = text;
      else if (f.key === 'ORDER BY') clauses.order = text;
    }
    const groupFields = clauses.group ? splitComma(clauses.group).map(stripIdentifier) : [];
    const orders = clauses.order ? splitComma(clauses.order).map(x => {
      const mm = x.match(/^(.*?)(?:\s+(ASC|DESC))?$/i);
      return { field: stripIdentifier(mm[1]), desc: /^DESC$/i.test(mm[2] || '') };
    }) : [];
    return { top, distinct, selectItems, where: clauses.where, groupFields, orders, hasAgg: selectItems.some(x => x.type === 'agg') };
  }

  function project(obj, items) {
    if (items.length === 1 && items[0].type === 'star') return { ...obj };
    const out = {};
    for (const item of items) {
      if (item.type === 'star') Object.assign(out, obj);
      else if (item.type === 'field') out[item.alias] = lookup(obj, item.field);
      else throw new Error('Aggregate used outside aggregate query.');
    }
    return out;
  }

  function rowComparator(orders) {
    return (a, b) => {
      for (const ord of orders) {
        const av = lookup(a, ord.field), bv = lookup(b, ord.field);
        if (compare(av, '=', bv)) continue;
        const c = compare(av, '<', bv) ? -1 : 1;
        return ord.desc ? -c : c;
      }
      return 0;
    };
  }

  function initAggState(items, obj) {
    const state = { first: obj, aggs: {} };
    for (const item of items) if (item.type === 'agg') state.aggs[item.alias] = { count: 0, sum: 0, value: undefined };
    return state;
  }

  function updateAggState(state, items, obj) {
    for (const item of items) {
      if (item.type !== 'agg') continue;
      const s = state.aggs[item.alias];
      if (item.fn === 'COUNT') { s.count++; continue; }
      const v = lookup(obj, item.field);
      if (v === '' || v === null || v === undefined) continue;
      if (item.fn === 'SUM' || item.fn === 'AVG') {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        s.sum += n; s.count++;
      } else if (item.fn === 'MIN') {
        if (s.value === undefined || compare(v, '<', s.value)) s.value = v;
      } else if (item.fn === 'MAX') {
        if (s.value === undefined || compare(v, '>', s.value)) s.value = v;
      }
    }
  }

  function finalizeAgg(state, items) {
    const out = {};
    for (const item of items) {
      if (item.type === 'field') out[item.alias] = lookup(state.first || {}, item.field);
      else if (item.type === 'agg') {
        const s = state.aggs[item.alias];
        if (item.fn === 'COUNT') out[item.alias] = s.count;
        else if (item.fn === 'SUM') out[item.alias] = s.count ? s.sum : '';
        else if (item.fn === 'AVG') out[item.alias] = s.count ? s.sum / s.count : '';
        else out[item.alias] = s.value ?? '';
      } else throw new Error('SELECT * cannot be combined with GROUP BY/aggregates.');
    }
    return out;
  }

  function dedupe(items) {
    const seen = new Set();
    return items.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function renderResult(result, note) {
    if (!result.length) {
      output.innerHTML = '<div class="empty">Query returned 0 rows</div>';
      info.textContent = `0 rows${note ? ' · ' + note : ''}`;
      return;
    }
    const cols = Object.keys(result[0]);
    let html = '<div class="table-wrap"><table><thead><tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    html += result.map(r => '<tr>' + cols.map(c => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('') + '</tr>').join('');
    html += '</tbody></table></div>';
    output.innerHTML = html;
    info.textContent = `${result.length.toLocaleString()} row${result.length === 1 ? '' : 's'}${note ? ' · ' + note : ''}`;
  }

  async function executeStreaming(query) {
    const stream = api();
    if (!stream) throw new Error('Large-file streaming mode is not active.');
    const q = parseQuery(query);
    const aggregateMode = q.hasAgg || q.groupFields.length > 0;
    if (!aggregateMode && q.top === null) throw new Error('Large-file SELECT queries require TOP to keep memory bounded. Example: SELECT TOP 100 * FROM logs');
    if (!aggregateMode && q.orders.length && q.distinct) throw new Error('DISTINCT + ORDER BY is not supported for raw large-file streaming queries.');

    progress.style.display = 'block';
    progressBar.style.width = '0%';
    let scanned = 0;
    const progressFn = (received, total) => {
      const pct = total ? Math.min(100, received / total * 100) : 0;
      progressBar.style.width = pct.toFixed(1) + '%';
      info.textContent = `Scanning large log… ${pct.toFixed(0)}% · ${formatBytes(received)} / ${formatBytes(total)}`;
    };

    if (aggregateMode) {
      const groups = new Map();
      await stream.scan(obj => {
        scanned++;
        if (q.where && !evalCondition(obj, q.where)) return true;
        const key = q.groupFields.length ? JSON.stringify(q.groupFields.map(f => lookup(obj, f))) : '__all__';
        let state = groups.get(key);
        if (!state) { state = initAggState(q.selectItems, obj); groups.set(key, state); }
        updateAggState(state, q.selectItems, obj);
        return true;
      }, { progress: progressFn });
      let result = [...groups.values()].map(s => finalizeAgg(s, q.selectItems));
      if (q.distinct) result = dedupe(result);
      if (q.orders.length) result.sort(rowComparator(q.orders));
      if (q.top !== null) result = result.slice(0, q.top);
      return { result, note: `streamed full file · ${scanned.toLocaleString()} records scanned` };
    }

    const result = [];
    const seen = q.distinct ? new Set() : null;
    const cmp = q.orders.length ? rowComparator(q.orders) : null;
    const top = q.top;
    await stream.scan(obj => {
      scanned++;
      if (q.where && !evalCondition(obj, q.where)) return true;
      const projected = project(obj, q.selectItems);
      if (seen) {
        const key = JSON.stringify(projected);
        if (seen.has(key)) return true;
        seen.add(key);
      }
      result.push(projected);
      if (!q.orders.length) return result.length < top;
      if (result.length >= Math.max(top * 2, top + 100)) {
        result.sort(cmp);
        result.length = top;
      }
      return true;
    }, { progress: progressFn });
    if (q.orders.length) result.sort(cmp);
    if (result.length > top) result.length = top;
    const stoppedEarly = !q.orders.length && result.length >= top;
    return { result, note: stoppedEarly ? `streamed until ${top.toLocaleString()} matches` : `streamed full file · ${scanned.toLocaleString()} records scanned` };
  }

  runBtn.onclick = async () => {
    if (!api()) return normalRun && normalRun.call(runBtn);
    info.textContent = '';
    output.innerHTML = '';
    runBtn.disabled = true;
    const oldText = runBtn.textContent;
    runBtn.textContent = 'Running...';
    try {
      const { result, note } = await executeStreaming(editor.value);
      renderResult(result, note);
      progressBar.style.width = '100%';
      setTimeout(() => { if (api()) progress.style.display = 'none'; }, 250);
    } catch (e) {
      info.textContent = 'Query error: ' + e.message;
      progress.style.display = 'none';
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = oldText;
    }
  };

  if (clearBtn) clearBtn.addEventListener('click', () => {
    const a = api();
    if (a) a.cancel();
  });
})();