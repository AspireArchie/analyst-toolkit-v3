import { transformData, type DataOperation, type DataEncoding } from './data-transforms.mjs';

export function initializeDataTools(): void {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = el<HTMLTextAreaElement>('data-input'), output = el<HTMLTextAreaElement>('data-output');
  const operation = el<HTMLSelectElement>('data-operation'), encoding = el<HTMLSelectElement>('data-encoding'), indentation = el<HTMLSelectElement>('data-indent');
  const copy = el<HTMLButtonElement>('data-copy'), useOutput = el<HTMLButtonElement>('data-use-output'), status = el('data-status');
  let timer: ReturnType<typeof setTimeout> | undefined;
  function convert(): void {
    clearTimeout(timer); copy.textContent = 'Copy output';
    el('data-encoding-field').hidden = !operation.value.startsWith('base64-');
    el('data-indent-field').hidden = operation.value !== 'json';
    try {
      output.value = input.value ? transformData(operation.value as DataOperation, input.value, encoding.value as DataEncoding, indentation.value) : '';
      copy.disabled = useOutput.disabled = !output.value;
      status.textContent = input.value ? `${input.value.length.toLocaleString()} → ${output.value.length.toLocaleString()} characters` : '';
      status.dataset.tone = 'neutral';
    } catch (error) {
      output.value = ''; copy.disabled = useOutput.disabled = true;
      status.textContent = error instanceof Error ? error.message : String(error); status.dataset.tone = 'failure';
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer); output.value = ''; copy.disabled = useOutput.disabled = true; copy.textContent = 'Copy output';
    status.textContent = input.value ? 'Processing…' : ''; status.dataset.tone = 'neutral'; timer = setTimeout(convert, 150);
  });
  for (const field of [operation, encoding, indentation]) field.addEventListener('change', convert);
  el('data-clear').addEventListener('click', () => { input.value = ''; convert(); input.focus(); });
  useOutput.addEventListener('click', () => { input.value = output.value; convert(); input.focus(); });
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    const text = output.value;
    try { await navigator.clipboard.writeText(text); if (output.value === text) copy.textContent = 'Copied'; }
    catch { status.textContent = 'Clipboard unavailable. Select and copy the output manually.'; output.focus(); output.select(); }
  });
  convert();
}
