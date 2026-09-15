(() => {
  const panel = document.getElementById('tsqlPanel');
  const editor = document.getElementById('tsqlQuery');
  const runBtn = document.getElementById('runTsql');
  const clearBtn = document.getElementById('clearTsql');
  const info = document.getElementById('tsqlInfo');
  const output = document.getElementById('tsqlResult');

  if (!panel || !editor || !runBtn || !clearBtn || !info || !output) return;

  function showPanel() {
    panel.style.display = 'block';
    if (!editor.value.trim()) editor.value = 'SELECT TOP 100 *\nFROM logs';
  }

  function hidePanel() {
    panel.style.display = 'none';
    info.textContent = '';
    output.innerHTML = '';
  }

  window.showTsqlPanel = showPanel;
  window.hideTsqlPanel = hidePanel;

  const originalLoadCsvText = loadCsvText;
  loadCsvText = function (...args) {
    const r = originalLoadCsvText.apply(this, args);
    if (mode !== 'console') showPanel();
    return r;
  };

  const originalLoadHttpLog = loadHttpLog;
  loadHttpLog = function (...args) {
    const r = originalLoadHttpLog.apply(this, args);
    showPanel();
    return r;
  };

  const originalLoadConsoleLog = loadConsoleLog;
  loadConsoleLog = function (...args) {
    const r = originalLoadConsoleLog.apply(this, args);
    hidePanel();
    return r;
  };

  const originalLoadJsonText = loadJsonText;
  loadJsonText = function (...args) {
    const r = originalLoadJsonText.apply(this, args);
    if (mode === 'console') hidePanel();
    else showPanel();
    return r;
  };

  const clearMain = document.getElementById('clear');
  if (clearMain) clearMain.addEventListener('click', hidePanel);

  function splitComma(text) {
    const out = [];
    let cur = '', quote = null, depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        cur += ch;
        if (ch === quote) {
          if (text[i + 1] === quote) { cur += text[++i]; }
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
    const key = Object.keys(obj).find(k => k.toLowerCase() === stripIdentifier(name).toLowerCase());
    return key === undefined ? undefined : obj[key];
  }

  function literal(token) {
    token = token.trim();
    if (/^null$/i.test(token)) return null;
    if (/^n?'(?:[^']|'')*'$/i.test(token)) return token.replace(/^n?'/i, '').slice(0, -1).replace(/''/g, "'");
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    return stripIdentifier(token);
  }

  function sqlCompare(a, op, b) {
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
    const upper = expr.toUpperCase();
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (quote) {
        cur += ch;
        if (ch === quote) {
          if (expr[i + 1] === quote) cur += expr[++i]; else quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '(') { depth++; cur += ch; continue; }
      if (ch === ')') { depth--; cur += ch; continue; }
      const word = keyword.toUpperCase();
      if (depth === 0 && upper.slice(i, i + word.length) === word && /\s/.test(expr[i - 1] || ' ') && /\s/.test(expr[i + word.length] || ' ')) {
        parts.push(cur.trim()); cur = ''; i += word.length - 1; continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function evalCondition(obj, expr) {
    expr = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
    const orParts = splitLogical(expr, 'OR');
    if (orParts.length > 1) return orParts.some(x => evalCondition(obj, x));
    const andParts = splitLogical(expr, 'AND');
    if (andParts.length > 1) return andParts.every(x => evalCondition(obj, x));

    let m = expr.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (m) {
      const v = lookup(obj, m[1]);
      const isNull = v === null || v === undefined || v === '';
      return m[2] ? !isNull : isNull;
    }

    m = expr.match(/^(.+?)\s+(NOT\s+)?IN\s*\((.*)\)$/i);
    if (m) {
      const v = lookup(obj, m[1]);
      const list = splitComma(m[3]).map(literal);
      const ok = list.some(x => sqlCompare(v, '=', x));
      return m[2] ? !ok : ok;
    }

    m = expr.match(/^(.+?)\s+(NOT\s+LIKE|LIKE)\s+(.+)$/i);
    if (m) return sqlCompare(lookup(obj, m[1]), m[2].toUpperCase().replace(/\s+/g, ' '), literal(m[3]));

    m = expr.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
    if (m) return sqlCompare(lookup(obj, m[1]), m[2], literal(m[3]));

    throw new Error('Unsupported WHERE condition: ' + expr);
  }

  function sourceObjects() {
    return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
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

  function aggregate(group, item) {
    if (item.fn === 'COUNT') return group.length;
    const values = group.map(o => lookup(o, item.field)).filter(v => v !== '' && v !== null && v !== undefined);
    if (item.fn === 'SUM' || item.fn === 'AVG') {
      const nums = values.map(Number).filter(Number.isFinite);
      if (!nums.length) return '';
      const sum = nums.reduce((a, b) => a + b, 0);
      return item.fn === 'SUM' ? sum : sum / nums.length;
    }
    if (!values.length) return '';
    if (item.fn === 'MIN') return values.reduce((a, b) => sqlCompare(a, '<', b) ? a : b);
    if (item.fn === 'MAX') return values.reduce((a, b) => sqlCompare(a, '>', b) ? a : b);
    return '';
  }

  function execute(query) {
    query = query.trim().replace(/;\s*$/, '');
    if (!/^SELECT\b/i.test(query)) throw new Error('Only SELECT queries are allowed.');

    const m = query.match(/^SELECT\s+(TOP\s*\(?\s*(\d+)\s*\)?\s+)?(DISTINCT\s+)?([\s\S]+?)\s+FROM\s+logs\b([\s\S]*)$/i);
    if (!m) throw new Error('Expected: SELECT ... FROM logs');

    const top = m[2] ? Number(m[2]) : null;
    const distinct = !!m[3];
    const selectText = m[4].trim();
    let rest = m[5] || '';

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

    let data = sourceObjects();
    if (clauses.where) data = data.filter(o => evalCondition(o, clauses.where));

    const selectItems = splitComma(selectText).map(parseSelectItem);
    const groupFields = clauses.group ? splitComma(clauses.group).map(stripIdentifier) : [];
    const hasAgg = selectItems.some(x => x.type === 'agg');
    let result;

    if (hasAgg || groupFields.length) {
      const groups = new Map();
      if (!groupFields.length) groups.set('__all__', data);
      else for (const o of data) {
        const key = JSON.stringify(groupFields.map(f => lookup(o, f)));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }
      result = [...groups.values()].map(group => {
        const first = group[0] || {};
        const out = {};
        for (const item of selectItems) {
          if (item.type === 'field') out[item.alias] = lookup(first, item.field);
          else if (item.type === 'agg') out[item.alias] = aggregate(group, item);
          else throw new Error('SELECT * cannot be combined with GROUP BY/aggregates.');
        }
        return out;
      });
    } else {
      result = data.map(o => {
        if (selectItems.length === 1 && selectItems[0].type === 'star') return { ...o };
        const out = {};
        for (const item of selectItems) {
          if (item.type === 'star') Object.assign(out, o);
          else if (item.type === 'field') out[item.alias] = lookup(o, item.field);
        }
        return out;
      });
    }

    if (distinct) {
      const seen = new Set();
      result = result.filter(o => { const k = JSON.stringify(o); if (seen.has(k)) return false; seen.add(k); return true; });
    }

    if (clauses.order) {
      const orders = splitComma(clauses.order).map(x => {
        const mm = x.match(/^(.*?)(?:\s+(ASC|DESC))?$/i);
        return { field: stripIdentifier(mm[1]), desc: /^DESC$/i.test(mm[2] || '') };
      });
      result.sort((a, b) => {
        for (const ord of orders) {
          const av = lookup(a, ord.field), bv = lookup(b, ord.field);
          if (sqlCompare(av, '=', bv)) continue;
          const cmp = sqlCompare(av, '<', bv) ? -1 : 1;
          return ord.desc ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (top !== null) result = result.slice(0, top);
    return result;
  }

  function renderResult(result) {
    const cols = result.length ? Object.keys(result[0]) : [];
    if (!result.length) {
      output.innerHTML = '<div class="empty">Query returned 0 rows</div>';
      info.textContent = '0 rows';
      return;
    }
    let html = '<div class="table-wrap"><table><thead><tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    html += result.map(r => '<tr>' + cols.map(c => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('') + '</tr>').join('');
    html += '</tbody></table></div>';
    output.innerHTML = html;
    info.textContent = `${result.length.toLocaleString()} row${result.length === 1 ? '' : 's'}`;
  }

  runBtn.onclick = () => {
    info.textContent = '';
    output.innerHTML = '';
    try {
      const result = execute(editor.value);
      renderResult(result);
    } catch (e) {
      info.textContent = 'Query error: ' + e.message;
    }
  };

  clearBtn.onclick = () => {
    editor.value = '';
    info.textContent = '';
    output.innerHTML = '';
  };
})();
