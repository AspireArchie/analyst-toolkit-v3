import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { NoteDocument, NoteEdit, NoteState } from './contracts';
type SavedNote = Pick<NoteDocument, 'id' | 'title' | 'text'>;
const maxText = 1024 * 1024, maxNotes = 100, maxStorage = 16 * 1024 * 1024;
export class NotepadStore {
  private notes = new Map<string, SavedNote & { revision: number }>();
  private saved = new Map<string, SavedNote>();
  private storageError?: string;
  private counter = 0;
  constructor(private file: string) {
    try {
      if (statSync(file).size > maxStorage) throw Error('Saved notes exceed the storage limit.');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.notes) || data.notes.length > maxNotes) throw Error('Invalid saved notes.');
      for (const note of data.notes) {
        if (!note || typeof note.id !== 'string' || !note.id || note.id.length > 100 || this.saved.has(note.id) || typeof note.title !== 'string' || note.title.length > 160 || typeof note.text !== 'string' || note.text.length > maxText) throw Error('Invalid saved note.');
        const clean = { id: note.id, title: note.title, text: note.text };
        this.saved.set(clean.id, clean); this.notes.set(clean.id, { ...clean, revision: 0 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.storageError = 'Could not read saved notes. Existing storage is preserved; local saving is disabled.';
        this.saved.clear(); this.notes.clear();
      }
    }
    if (!this.notes.size) this.add();
  }
  state(): NoteState {
    return { notes: [...this.notes.values()].map(note => {
      const saved = this.saved.get(note.id);
      return { ...note, status: !saved ? 'unsaved' : saved.title === note.title && saved.text === note.text ? 'saved' : 'modified' };
    }), saved: [...this.saved.values()].map(({id,title}) => ({id,title})), detached: false, storageAvailable: !this.storageError, storageError: this.storageError };
  }
  add(): void {
    if (this.notes.size >= maxNotes) throw Error('Limit of 100 open notes reached. Close a tab first.');
    let title: string; do { title = `Note ${++this.counter}`; } while ([...this.notes.values()].some(n => n.title === title));
    const id = randomUUID(); this.notes.set(id, {id,title,text:'',revision:0});
  }
  private selected(id: unknown, revision?: unknown) {
    if (typeof id !== 'string' || !this.notes.has(id)) throw Error('Note is not open.');
    const note = this.notes.get(id)!;
    if (revision !== undefined && (!Number.isInteger(revision) || revision !== note.revision)) throw Error('This note changed in another window. Your draft has been retained.');
    return note;
  }
  update(edit: NoteEdit): void {
    if (!edit || typeof edit.title !== 'string' || edit.title.length > 160 || typeof edit.text !== 'string' || edit.text.length > maxText || !Number.isInteger(edit.revision)) throw Error('Invalid note or note exceeds 1,048,576 characters.');
    const note = this.selected(edit.id, edit.revision);
    if (note.title !== edit.title || note.text !== edit.text) this.notes.set(note.id, {...note,title:edit.title,text:edit.text,revision:note.revision+1});
  }
  private persist(next: Map<string, SavedNote>): void {
    if (this.storageError) throw Error(this.storageError);
    if (next.size > maxNotes) throw Error('Limit of 100 locally saved notes reached.');
    const text = JSON.stringify({version:1,notes:[...next.values()]});
    if (Buffer.byteLength(text,'utf8') > maxStorage) throw Error('Saved notes exceed 16 MB. Remove a local copy first.');
    mkdirSync(path.dirname(this.file),{recursive:true});
    writeFileSync(this.file+'.tmp',text,'utf8'); renameSync(this.file+'.tmp',this.file);
    this.saved = next;
  }
  save(id: string, revision: number): void {
    if (!Number.isInteger(revision)) throw Error('Invalid note revision.');
    const note = this.selected(id,revision), next = new Map(this.saved);
    next.set(id,{id:note.id,title:note.title,text:note.text}); this.persist(next);
  }
  close(id: string, revision: number, discard: boolean): void {
    if (!Number.isInteger(revision) || typeof discard !== 'boolean') throw Error('Invalid close request.');
    const note=this.selected(id,revision), saved=this.saved.get(id);
    const changed=!saved || saved.title!==note.title || saved.text!==note.text;
    if (changed && !discard && (note.text || saved || !/^Note \d+$/.test(note.title))) throw Error('Confirm closing this tab to discard its unsaved changes.');
    this.notes.delete(id);
  }
  openSaved(id: string): void {
    if (this.notes.has(id)) return;
    const note=this.saved.get(id); if (!note) throw Error('No local copy exists for this note.');
    if (this.notes.size >= maxNotes) throw Error('Limit of 100 open notes reached.');
    this.notes.set(id,{...note,revision:0});
  }
  forgetSaved(id: string): void {
    if (!this.saved.has(id)) throw Error('No local copy exists for this note.');
    const next=new Map(this.saved); next.delete(id); this.persist(next);
  }
}
