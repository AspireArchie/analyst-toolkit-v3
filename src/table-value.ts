/** Keep evidence values intact; only shorten the visible table preview. */
export function tableValue(container: HTMLElement, value: unknown, beforeToggle: (open: boolean) => Promise<void>, onError: (error: unknown) => void): void {
  const full = String(value ?? ''), characters = Array.from(full), limit = 60;
  const content = document.createElement('span'); content.className = 'table-value';
  const preview = characters.length > limit ? characters.slice(0, limit).join('') + '…' : full;
  content.textContent = preview; container.append(content);
  if (characters.length <= limit) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'cell-expand';
  button.textContent = 'Expand'; button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Expand full cell value');
  let expanded = false;
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    void (async () => {
      try {
        await beforeToggle(!expanded);
        expanded = !expanded; content.textContent = expanded ? full : preview;
        button.textContent = expanded ? 'Collapse' : 'Expand';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', expanded ? 'Collapse cell value' : 'Expand full cell value');
      } catch (error) { onError(error); }
      finally { button.disabled = false; }
    })();
  });
  container.append(button);
}
