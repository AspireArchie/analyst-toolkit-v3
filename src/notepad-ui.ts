import type { NoteApi, NoteState, Reply } from './contracts';
declare global { interface Window { notes: NoteApi } }
export function initializeNotepad(root: HTMLElement, api: NoteApi, popped = false): void {
  // Static markup only. All note titles and bodies are assigned as text/value.
  root.innerHTML = `
    <div class="notes-toolbar"><button id="note-add">New tab</button><select id="note-open" aria-label="Open saved note"><option value="">Open saved note…</option></select><button id="note-popout">Pop out ↗</button></div>
    <p class="help notes-persistence">Memory only until you choose Save locally.</p>
    <div id="note-tabs" class="note-tabs" role="tablist" aria-label="Notes"></div>
    <section id="note-editor" class="note-editor" role="tabpanel">
      <div class="note-heading"><label>Note name<input id="note-title" maxlength="160" autocomplete="off" /></label><span id="note-save-state" class="status-badge"></span></div>
      <label class="sr-only" for="note-text">Note text</label><textarea id="note-text" spellcheck="false" placeholder="Write a note…"></textarea>
      <div class="notes-actions"><button id="note-forget">Remove local copy</button><button id="note-save" class="primary">Save locally</button></div>
    </section>
    <div id="note-confirm" class="note-confirm" hidden><span id="note-confirm-text"></span><button id="note-confirm-yes">Confirm</button><button id="note-confirm-no">Cancel</button></div>
    <p id="note-status" class="help" role="status"></p>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const title = el<HTMLInputElement>('note-title'), text = el<HTMLTextAreaElement>('note-text'), message = el('note-status');
  let state: NoteState | null = null, active = '', pending = Promise.resolve();
  const drafts = new Map<string, {title:string;text:string}>(), flushing = new Set<string>();
  let confirm: (()=>void) | null = null;
  const unwrap = <T>(reply: Reply<T>): T => { if (!reply.ok) throw Error(reply.error); return reply.data; };
  const locked = () => !state || (state.detached && !popped);
  const displayName = (name: string) => name.trim() || 'Untitled note';
  function render(): void {
    if (!state) return;
    if (!state.notes.some(n=>n.id===active)) active=state.notes[0]?.id??'';
    const tabs=el('note-tabs'); tabs.replaceChildren();
    for (const note of state.notes) {
      const draft=drafts.get(note.id), name=displayName(draft?.title??note.title);
      const item=document.createElement('div'); item.className='note-tab';
      const button=document.createElement('button'); button.className='note-tab-name';button.setAttribute('role','tab');button.dataset.noteId=note.id;
      button.id=`note-tab-${note.id}`;button.setAttribute('aria-controls','note-editor');button.setAttribute('aria-selected',String(active===note.id));
      button.textContent=name+((draft||note.status!=='saved')?' •':'');button.title=note.status==='saved'&&!draft?'Saved locally':'Unsaved';
      item.classList.toggle('active',active===note.id);
      button.addEventListener('click',()=>{active=note.id;el('note-confirm').hidden=true;render();});
      const close=document.createElement('button');close.textContent='×';close.className='note-tab-close';close.setAttribute('aria-label',`Close ${name}`);close.disabled=locked();
      close.addEventListener('click',()=>{
        const closeNote=(discard:boolean)=>perform(async()=>{const current=state!.notes.find(n=>n.id===note.id)!;accept(unwrap(await api.close(note.id,current.revision,discard)));});
        if(draft||note.status!=='saved')ask('Close this tab and discard unsaved changes? Any earlier local copy is retained.',()=>closeNote(true));else closeNote(false);
      });
      item.append(button,close);tabs.append(item);
    }
    const note=state.notes.find(n=>n.id===active),draft=drafts.get(active);
    el('note-editor').hidden=!note;
    if(note){
      el('note-editor').setAttribute('aria-labelledby',`note-tab-${note.id}`);
      if(title.value!==(draft?.title??note.title))title.value=draft?.title??note.title;
      if(text.value!==(draft?.text??note.text))text.value=draft?.text??note.text;
      const status=draft?(note.status==='unsaved'?'unsaved':'modified'):note.status;
      const badge=el('note-save-state');badge.textContent=status==='saved'?'Saved locally':status==='modified'?'Unsaved changes':'Unsaved · memory only';badge.dataset.tone=status==='saved'?'success':status==='modified'?'warning':'neutral';
    }
    title.readOnly=text.readOnly=locked();
    el<HTMLButtonElement>('note-add').disabled=locked();
    el<HTMLButtonElement>('note-save').disabled=locked()||!note||!state.storageAvailable;
    el<HTMLButtonElement>('note-forget').disabled=locked()||!note||!state.saved.some(n=>n.id===active)||!state.storageAvailable;
    const saved=el<HTMLSelectElement>('note-open'),selected=saved.value;saved.replaceChildren();
    const first=document.createElement('option');first.value='';first.textContent='Open saved note…';saved.append(first);
    for(const note of state.saved){const option=document.createElement('option');option.value=note.id;option.textContent=displayName(note.title);saved.append(option);}
    saved.value=selected;saved.disabled=locked()||!state.saved.length;
    el('note-popout').hidden=popped;el('note-popout').textContent=state.detached?'Focus pop-out ↗':'Pop out ↗';
    if(state.storageError)message.textContent=state.storageError;
    else if(locked())message.textContent='Editing in pop-out window.';
    else if(message.textContent==='Editing in pop-out window.')message.textContent='';
  }
  function accept(next: NoteState): void { state=next;render(); }
  function perform(work:()=>Promise<void>): void {
    void(async()=>{await pending;if(drafts.size)throw Error('Changes have not synced. Keep this window open and edit again to retry.');await work();})().catch(error=>{message.textContent=String(error);});
  }
  function flush(id: string): void {
    if(flushing.has(id))return;flushing.add(id);
    pending=pending.then(async()=>{
      while(drafts.has(id)){
        const draft=drafts.get(id)!,note=state!.notes.find(n=>n.id===id);
        if(!note)throw Error('Note closed before its changes were synced.');
        const next=unwrap(await api.update({id,...draft,revision:note.revision}));
        if(drafts.get(id)===draft)drafts.delete(id);
        accept(next);
      }
    }).catch(error=>{message.textContent=String(error);}).finally(()=>flushing.delete(id));
  }
  for(const input of [title,text])input.addEventListener('input',()=>{
    if(locked()||!active)return;
    drafts.set(active,{title:title.value,text:text.value});message.textContent='';render();flush(active);
  });
  function ask(question: string, action:()=>void):void{el('note-confirm-text').textContent=question;confirm=action;el('note-confirm').hidden=false;}
  el('note-confirm-yes').addEventListener('click',()=>{el('note-confirm').hidden=true;confirm?.();confirm=null;});
  el('note-confirm-no').addEventListener('click',()=>{el('note-confirm').hidden=true;confirm=null;});
  el('note-add').addEventListener('click',()=>perform(async()=>{const next=unwrap(await api.add());active=next.notes.at(-1)!.id;accept(next);message.textContent='';text.focus();}));
  el('note-save').addEventListener('click',()=>{const id=active;perform(async()=>{const note=state!.notes.find(n=>n.id===id)!;accept(unwrap(await api.save(id,note.revision)));message.textContent='Snapshot saved locally. Later edits remain unsaved until saved again.';});});
  el('note-forget').addEventListener('click',()=>{const id=active;ask('Remove the saved local copy? Current text remains open in memory.',()=>perform(async()=>{accept(unwrap(await api.forgetSaved(id)));message.textContent='Local copy removed. This note is now memory only.';}));});
  el<HTMLSelectElement>('note-open').addEventListener('change',()=>{const id=el<HTMLSelectElement>('note-open').value;if(id)perform(async()=>{accept(unwrap(await api.openSaved(id)));active=id;render();});});
  el('note-popout').addEventListener('click',()=>perform(async()=>accept(unwrap(await api.popOut(active)))));
  api.onChange(accept);
  void api.state().then(reply=>{const next=unwrap(reply);active=(popped?next.focusId:undefined)??next.notes[0]?.id??'';accept(next);}).catch(error=>{message.textContent=String(error);});
}
