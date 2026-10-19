interface SavedQuery { id: string; name: string; template: string }
interface QueryDraft extends SavedQuery { values: Map<string, string> }
const storageKey = 'bec.kql-library.v1';
const placeholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function initializeKqlLibrary(): void {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const name = get<HTMLInputElement>('kql-name'), template = get<HTMLTextAreaElement>('kql-template');
  const output = get<HTMLTextAreaElement>('kql-final'), status = get('kql-status');
  const copy = get<HTMLButtonElement>('kql-copy'), search = get<HTMLInputElement>('kql-search');
  let queries: SavedQuery[] = [], current: QueryDraft | null = null, writable = true;
  const drafts = new Map<string, QueryDraft>();
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      if (parsed.version !== 1 || !Array.isArray(parsed.queries) || parsed.queries.length > 500) throw Error('Invalid library format');
      const ids = new Set<string>();
      for (const item of parsed.queries) {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160 || typeof item.template !== 'string' || !item.template.trim() || item.template.length > 200000) throw Error('Invalid saved query');
        ids.add(item.id); queries.push({ id: item.id, name: item.name, template: item.template });
      }
    }
  } catch {
    queries = []; writable = false;
    status.textContent = 'Could not read the local query library. Existing storage has been preserved. Saving is disabled.';
  }
  const persist = (next: SavedQuery[]): boolean => {
    if (!writable) return false;
    try {
      if (next.length > 500) throw Error('Library limit reached');
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, queries: next }));
      queries = next; return true;
    } catch { status.textContent = 'Could not save the library. Local storage may be full or unavailable. Your changes remain in the editor.'; return false; }
  };
  const tokens = () => [...new Set([...template.value.matchAll(placeholderPattern)].map(match => match[1]))];
  function dirty(): boolean {
    if (!current) return false;
    const saved = queries.find(q => q.id === current!.id);
    return !saved || current.name !== saved.name || current.template !== saved.template;
  }
  function updateState(): void {
    get('kql-save-state').textContent = dirty() ? 'Unsaved changes' : 'Saved locally';
    get<HTMLButtonElement>('kql-save').disabled = !writable;
  }
  function finalQuery(): void {
    if (!current) return;
    const missing = tokens().filter(key => !current!.values.get(key));
    output.value = template.value.replace(placeholderPattern, (token, key: string) => current!.values.get(key) || token);
    copy.disabled = !template.value.trim() || missing.length > 0;
    copy.textContent = 'Copy query';
    copy.title = missing.length ? `Enter: ${missing.join(', ')}` : 'Copy final query';
  }
  function parameters(): void {
    const root = get('kql-parameters'); root.replaceChildren();
    const names = tokens();
    if (!names.length) { const p = document.createElement('p'); p.className = 'help'; p.textContent = 'No parameters.'; root.append(p); }
    for (const key of names) {
      const label = document.createElement('label'), input = document.createElement('input');
      label.textContent = key; input.dataset.parameter = key; input.autocomplete = 'off'; input.spellcheck = false;
      input.value = current!.values.get(key) ?? '';
      input.addEventListener('input', () => { current!.values.set(key, input.value); finalQuery(); });
      label.append(input); root.append(label);
    }
    finalQuery();
  }
  function list(): void {
    const root = get('kql-list'); root.replaceChildren();
    const entries = [...queries.map(q => drafts.get(q.id) ?? q), ...[...drafts.values()].filter(d => !queries.some(q => q.id === d.id))];
    for (const query of entries.filter(q => q.name.toLowerCase().includes(search.value.toLowerCase()))) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'kql-query'; button.dataset.queryId = query.id;
      button.textContent = query.name.trim() || 'Untitled query'; button.classList.toggle('active', current?.id === query.id);
      button.setAttribute('aria-pressed', String(current?.id === query.id));
      button.addEventListener('click', () => select(query)); root.append(button);
    }
    if (!root.children.length) { const p = document.createElement('p'); p.className = 'help'; p.textContent = search.value ? 'No matching queries.' : 'No saved queries.'; root.append(p); }
  }
  function select(query: SavedQuery): void {
    current = drafts.get(query.id) ?? { ...query, values: new Map() }; drafts.set(query.id, current);
    name.value = current.name; template.value = current.template;
    get('kql-delete-prompt').hidden = true; updateState(); list(); parameters();
  }
  function add(): void {
    select({ id: crypto.randomUUID(), name: '', template: '' }); search.value = ''; list(); name.focus();
  }
  for (const field of [name, template]) field.addEventListener('input', () => {
    if (!current) return;
    current.name = name.value; current.template = template.value;
    get('kql-delete-prompt').hidden = true; updateState(); list();
    if (field === template) parameters();
  });
  search.addEventListener('input', list);
  get('kql-new').addEventListener('click', add);
  get('kql-insert').addEventListener('click', () => {
    const field = get<HTMLInputElement>('kql-placeholder'), key = field.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { status.textContent = 'Use letters, numbers and underscores; start with a letter or underscore.'; field.focus(); return; }
    if (template.value.length + key.length + 2 > 200000) { status.textContent = 'Template length limit reached.'; return; }
    template.setRangeText(`{${key}}`, template.selectionStart, template.selectionEnd, 'end');
    template.dispatchEvent(new Event('input')); field.value = ''; template.focus();
  });
  get('kql-save').addEventListener('click', () => {
    if (!current) return;
    if (!name.value.trim() || !template.value.trim()) { status.textContent = 'Enter a query name and template.'; return; }
    const saved = { id: current.id, name: name.value.trim(), template: template.value };
    const index = queries.findIndex(q => q.id === saved.id), next = [...queries];
    if (index < 0) next.push(saved); else next[index] = saved;
    if (persist(next)) { current.name = saved.name; name.value = saved.name; updateState(); list(); status.textContent = 'Query saved locally.'; }
  });
  get('kql-delete').addEventListener('click', () => { get('kql-delete-prompt').hidden = false; });
  get('kql-delete-cancel').addEventListener('click', () => { get('kql-delete-prompt').hidden = true; });
  get('kql-delete-confirm').addEventListener('click', () => {
    if (!current) return;
    const id = current.id;
    if (queries.some(q => q.id === id) && !persist(queries.filter(q => q.id !== id))) return;
    drafts.delete(id); const next = queries[0] ?? drafts.values().next().value;
    if (next) select(next); else add();
    status.textContent = 'Query deleted.';
  });
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    const text = output.value;
    try { await navigator.clipboard.writeText(text); if (output.value === text) copy.textContent = 'Copied'; }
    catch { status.textContent = 'Clipboard unavailable. Select and copy the final query manually.'; output.focus(); output.select(); }
  });
  if (queries.length) select(queries[0]); else select({ id: crypto.randomUUID(), name: '', template: '' });
}
