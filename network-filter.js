(()=>{
  const content=document.getElementById('networkContent');
  const list=document.getElementById('networkList');
  if(!content||!list||typeof renderNetwork!=='function')return;

  const style=document.createElement('style');
  style.textContent=`
    .network-filters{display:grid;grid-template-columns:minmax(180px,1fr) 180px auto;gap:9px;padding:12px;background:#fff;border-bottom:1px solid var(--line);align-items:center}
    .network-filter-input,.network-filter-select{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--text);padding:8px 10px;font-size:12px}
    .network-filter-input:focus,.network-filter-select:focus{outline:none;border-color:var(--blue)}
    .network-filter-count{font-size:12px;color:var(--muted);white-space:nowrap}
    @media(max-width:760px){.network-filters{grid-template-columns:1fr}.network-filter-count{white-space:normal}}
  `;
  document.head.appendChild(style);

  const filters=document.createElement('div');
  filters.className='network-filters';
  filters.innerHTML=`
    <input id="networkDomainFilter" class="network-filter-input" type="text" placeholder="Filter domain...">
    <select id="networkTypeFilter" class="network-filter-select"><option value="">All types</option></select>
    <div id="networkFilterCount" class="network-filter-count"></div>
  `;
  content.insertBefore(filters,content.firstChild);

  const domainInput=document.getElementById('networkDomainFilter');
  const typeSelect=document.getElementById('networkTypeFilter');
  const countEl=document.getElementById('networkFilterCount');

  function domainOf(value){
    try{return new URL(value).hostname.toLowerCase()}catch{return ''}
  }

  function syncTypes(){
    const selected=typeSelect.value;
    const types=[...new Set((lastSubrequests||[]).map(x=>String(x.type||'').toLowerCase()).filter(Boolean))].sort();
    typeSelect.innerHTML='<option value="">All types</option>'+types.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if(types.includes(selected))typeSelect.value=selected;
  }

  function renderFilteredNetwork(){
    syncTypes();
    const domain=domainInput.value.trim().toLowerCase();
    const type=typeSelect.value.trim().toLowerCase();
    const source=lastSubrequests||[];
    const filtered=source.filter(item=>{
      const itemType=String(item.type||'').toLowerCase();
      const itemDomain=domainOf(item.url);
      return (!domain||itemDomain.includes(domain))&&(!type||itemType===type);
    });

    list.innerHTML='';
    countEl.textContent=`${filtered.length} / ${source.length} requests`;

    if(!source.length){
      list.innerHTML='<div class="network-empty">No subrequests found in the response body.</div>';
      return;
    }
    if(!filtered.length){
      list.innerHTML='<div class="network-empty">No requests match the current filters.</div>';
      return;
    }

    for(const item of filtered){
      const row=document.createElement('div');
      row.className='network-item';
      row.innerHTML=`<div class="network-type">${esc(item.type)}</div><div class="network-url" title="${esc(item.url)}">${esc(item.url)}</div><button class="btn network-send">Open in HTTPer</button>`;
      row.querySelector('button').onclick=()=>{
        urlInput.value=item.url;
        hostCustom=false;
        syncHostFromUrl();
        window.scrollTo({top:0,behavior:'smooth'});
      };
      list.appendChild(row);
    }
  }

  renderNetwork=renderFilteredNetwork;
  domainInput.addEventListener('input',renderFilteredNetwork);
  typeSelect.addEventListener('change',renderFilteredNetwork);
})();
